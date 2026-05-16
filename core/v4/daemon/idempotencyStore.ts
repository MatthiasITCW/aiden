/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/idempotencyStore.ts — v4.5 Phase 1: L1/L2 cache.
 *
 * Two-tier cache for "exactly once" semantics on webhook deliveries
 * (Phase 3) and authenticated API runs (Phase 1+).
 *
 *   L1 — in-memory `Map<scopeKey, IdempotencyEntry>` for hot path.
 *   L2 — SQLite `idempotency_keys` for durability across restarts.
 *
 * Workflow:
 *   - getOrSet(scope, key, fingerprint, compute):
 *       1. Look up L1; if hit and unexpired → return cached.
 *       2. Look up L2; if hit and unexpired → reseed L1 → return cached.
 *       3. Miss: invoke compute(), persist to L2 + L1, return.
 *   - Daemon boot calls `reseed()` once to load unexpired L2 rows
 *     into L1 (warm-start the in-memory cache).
 *   - A background sweep deletes L2 rows whose `expires_at < now`.
 */

import type { Db } from './db/connection';
import type {
  IdempotencyScope,
  IdempotencyEntry,
} from './types';
import type { IdempotencyKeyRowSql } from './db/schema/v1.spec';

export const DEFAULT_TTL_MS = 60 * 60 * 1000;       // 1 hour
export const SWEEP_INTERVAL_MS = 5 * 60 * 1000;     // 5 minutes
export const MAX_L1_ENTRIES = 4096;

export interface CachedResponse {
  responseJson: string;
  statusCode:   number;
}

export interface IdempotencyStore {
  /**
   * Get or compute. If a cached response exists for (scope, key)
   * AND its fingerprint matches the supplied one (or no fingerprint
   * was stored), returns the cached response. Otherwise invokes
   * `compute()`, stores the result, and returns it.
   */
  getOrSet(
    scope:       IdempotencyScope,
    key:         string,
    fingerprint: string | null,
    compute:     () => CachedResponse | Promise<CachedResponse>,
    ttlMs?:      number,
  ): Promise<CachedResponse>;

  /** Direct read — null when missing or expired. */
  get(scope: IdempotencyScope, key: string): CachedResponse | null;

  /** Force-set a value (test/recovery use). */
  set(
    scope:        IdempotencyScope,
    key:          string,
    fingerprint:  string | null,
    response:     CachedResponse,
    ttlMs?:       number,
  ): void;

  /** Delete expired L2 rows. Returns count. */
  sweepExpired(now?: number): { deleted: number };

  /** Reseed L1 from L2 (call on daemon boot). */
  reseed(): { loaded: number };

  /** Diagnostic. */
  stats(): { l1: number; l2: number };

  /** Stop the background sweep timer + clear L1 (test/shutdown). */
  close(): void;
}

function scopeKey(scope: IdempotencyScope, key: string): string {
  return `${scope}::${key}`;
}

export interface CreateIdempotencyStoreOptions {
  db: Db;
  /** Override default TTL (default 1h). */
  defaultTtlMs?: number;
  /** Override background sweep interval (default 5min); 0 = disabled. */
  sweepIntervalMs?: number;
}

export function createIdempotencyStore(
  opts: CreateIdempotencyStoreOptions,
): IdempotencyStore {
  const db = opts.db;
  const defaultTtl = opts.defaultTtlMs ?? DEFAULT_TTL_MS;
  const sweepInterval = opts.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
  const l1: Map<string, IdempotencyEntry> = new Map();

  // ── L1 eviction (FIFO past cap) ──
  function l1Insert(entry: IdempotencyEntry): void {
    const k = scopeKey(entry.scope, entry.key);
    l1.set(k, entry);
    if (l1.size > MAX_L1_ENTRIES) {
      const first = l1.keys().next().value;
      if (first !== undefined) l1.delete(first);
    }
  }

  function readFromL2(scope: IdempotencyScope, key: string, now: number): IdempotencyEntry | null {
    const row = db
      .prepare(
        `SELECT * FROM idempotency_keys WHERE scope = ? AND key = ?`,
      )
      .get(scope, key) as IdempotencyKeyRowSql | undefined;
    if (!row) return null;
    if (row.expires_at <= now) return null;
    return {
      scope:        row.scope as IdempotencyScope,
      key:          row.key,
      fingerprint:  row.fingerprint,
      responseJson: row.response_json,
      statusCode:   row.status_code,
      createdAt:    row.created_at,
      expiresAt:    row.expires_at,
    };
  }

  function writeToL2(entry: IdempotencyEntry): void {
    db.prepare(
      `INSERT OR REPLACE INTO idempotency_keys
         (scope, key, fingerprint, response_json, status_code, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.scope,
      entry.key,
      entry.fingerprint,
      entry.responseJson,
      entry.statusCode,
      entry.createdAt,
      entry.expiresAt,
    );
  }

  // Initial reseed from L2 (cheap — bounded by `MAX_L1_ENTRIES`).
  function reseedFromL2(): { loaded: number } {
    const now = Date.now();
    const rows = db
      .prepare(
        `SELECT * FROM idempotency_keys
          WHERE expires_at > ?
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .all(now, MAX_L1_ENTRIES) as IdempotencyKeyRowSql[];
    let loaded = 0;
    for (const row of rows) {
      l1Insert({
        scope:        row.scope as IdempotencyScope,
        key:          row.key,
        fingerprint:  row.fingerprint,
        responseJson: row.response_json,
        statusCode:   row.status_code,
        createdAt:    row.created_at,
        expiresAt:    row.expires_at,
      });
      loaded += 1;
    }
    return { loaded };
  }

  function sweep(now?: number): { deleted: number } {
    const cutoff = now ?? Date.now();
    const r = db
      .prepare(`DELETE FROM idempotency_keys WHERE expires_at < ?`)
      .run(cutoff);
    // Also evict expired L1 entries.
    for (const [k, v] of l1) {
      if (v.expiresAt < cutoff) l1.delete(k);
    }
    return { deleted: r.changes };
  }

  // Background sweep timer.
  let sweepTimer: NodeJS.Timeout | null = null;
  if (sweepInterval > 0) {
    sweepTimer = setInterval(() => {
      try { sweep(); } catch { /* never let sweep crash */ }
    }, sweepInterval);
    if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
  }

  return {
    async getOrSet(scope, key, fingerprint, compute, ttlMs) {
      const now = Date.now();
      const sk = scopeKey(scope, key);
      let entry = l1.get(sk);
      if (!entry || entry.expiresAt <= now) {
        const fromL2 = readFromL2(scope, key, now);
        if (fromL2) {
          l1Insert(fromL2);
          entry = fromL2;
        }
      }
      if (entry) {
        if (fingerprint != null && entry.fingerprint != null && entry.fingerprint !== fingerprint) {
          // Fingerprint mismatch — treat as a new request. Compute fresh.
        } else {
          return { responseJson: entry.responseJson, statusCode: entry.statusCode };
        }
      }
      const computed = await compute();
      const ttl = ttlMs ?? defaultTtl;
      const newEntry: IdempotencyEntry = {
        scope,
        key,
        fingerprint,
        responseJson: computed.responseJson,
        statusCode:   computed.statusCode,
        createdAt:    now,
        expiresAt:    now + ttl,
      };
      writeToL2(newEntry);
      l1Insert(newEntry);
      return computed;
    },
    get(scope, key) {
      const now = Date.now();
      const sk = scopeKey(scope, key);
      let entry = l1.get(sk);
      if (!entry || entry.expiresAt <= now) {
        const fromL2 = readFromL2(scope, key, now);
        if (!fromL2) return null;
        l1Insert(fromL2);
        entry = fromL2;
      }
      return { responseJson: entry.responseJson, statusCode: entry.statusCode };
    },
    set(scope, key, fingerprint, response, ttlMs) {
      const now = Date.now();
      const ttl = ttlMs ?? defaultTtl;
      const entry: IdempotencyEntry = {
        scope,
        key,
        fingerprint,
        responseJson: response.responseJson,
        statusCode:   response.statusCode,
        createdAt:    now,
        expiresAt:    now + ttl,
      };
      writeToL2(entry);
      l1Insert(entry);
    },
    sweepExpired(now) {
      return sweep(now);
    },
    reseed() {
      return reseedFromL2();
    },
    stats() {
      const row = db
        .prepare(`SELECT COUNT(*) AS c FROM idempotency_keys`)
        .get() as { c: number };
      return { l1: l1.size, l2: row.c };
    },
    close() {
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      l1.clear();
    },
  };
}
