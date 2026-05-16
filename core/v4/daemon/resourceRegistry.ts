/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/resourceRegistry.ts — v4.5 Phase 1: unified resource ledger.
 *
 * Single registry for every long-lived resource the daemon owns:
 *   - Playwright browser contexts (v4.3)
 *   - Docker session containers (v4.4)
 *   - HTTP keepalive agents
 *   - chokidar file watchers (Phase 2)
 *   - Subprocesses spawned by tools
 *   - IMAP connections (Phase 4)
 *   - SQLite handles
 *   - Webhook subrouters (Phase 3)
 *
 * Each resource carries:
 *   - kind (typed enum)
 *   - owner (sessionId | instanceId | 'global')
 *   - lifecycle timestamps
 *   - optional ttlMs for soft-reaping idle resources
 *   - optional budgetUnits for budget-based eviction
 *   - close(): an idempotent disposer
 *
 * The shutdown drain (`drain.ts` step 4) calls `reapAll()` to close
 * everything with a per-item timeout. A periodic 60s sweep calls
 * `sweep()` to close TTL-exceeded resources during normal operation.
 *
 * Diagnostic surface: `GET /api/daemon/resources` returns `list()` +
 * `budgetByKind()` as JSON.
 */

import { randomUUID } from 'node:crypto';
import type { Resource, ResourceKind } from './types';

export interface ResourceRegistry {
  register(r: Omit<Resource, 'id' | 'createdAt' | 'lastUsedAt'> & { id?: string }): string;
  touch(id: string): void;
  release(id: string): Promise<void>;
  list(filter?: { kind?: ResourceKind; owner?: string }): Resource[];
  sweep(now?: number): Promise<{ reaped: number }>;
  reapAll(perItemTimeoutMs?: number): Promise<{ reaped: number; failed: number }>;
  budgetByKind(): Record<string, { count: number; budgetUnits: number }>;
}

const _resources: Map<string, Resource> = new Map();

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`resource close timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function safeClose(r: Resource, perItemTimeoutMs: number): Promise<boolean> {
  try {
    const result = r.close();
    if (result && typeof (result as Promise<void>).then === 'function') {
      await withTimeout(result as Promise<void>, perItemTimeoutMs);
    }
    return true;
  } catch {
    return false;
  }
}

export function createResourceRegistry(): ResourceRegistry {
  return {
    register(r): string {
      const id = r.id ?? randomUUID();
      const now = Date.now();
      _resources.set(id, {
        id,
        kind:        r.kind,
        owner:       r.owner,
        createdAt:   now,
        lastUsedAt:  now,
        ttlMs:       r.ttlMs,
        budgetUnits: r.budgetUnits,
        metadata:    r.metadata,
        close:       r.close,
      });
      return id;
    },
    touch(id: string): void {
      const r = _resources.get(id);
      if (r) r.lastUsedAt = Date.now();
    },
    async release(id: string): Promise<void> {
      const r = _resources.get(id);
      if (!r) return;
      _resources.delete(id);
      await safeClose(r, 5_000);
    },
    list(filter): Resource[] {
      const out: Resource[] = [];
      for (const r of _resources.values()) {
        if (filter?.kind && r.kind !== filter.kind) continue;
        if (filter?.owner && r.owner !== filter.owner) continue;
        out.push(r);
      }
      return out;
    },
    async sweep(now): Promise<{ reaped: number }> {
      const cutoff = now ?? Date.now();
      const candidates: Resource[] = [];
      for (const r of _resources.values()) {
        if (r.ttlMs && cutoff - r.lastUsedAt > r.ttlMs) candidates.push(r);
      }
      // Pull them out of the registry first so concurrent touches
      // don't extend their lifetime mid-close.
      for (const c of candidates) _resources.delete(c.id);
      const settled = await Promise.allSettled(candidates.map((c) => safeClose(c, 3_000)));
      return { reaped: settled.filter((s) => s.status === 'fulfilled' && s.value === true).length };
    },
    async reapAll(perItemTimeoutMs = 3_000): Promise<{ reaped: number; failed: number }> {
      const all = [..._resources.values()];
      _resources.clear();
      const settled = await Promise.allSettled(all.map((r) => safeClose(r, perItemTimeoutMs)));
      let reaped = 0;
      let failed = 0;
      for (const s of settled) {
        if (s.status === 'fulfilled' && s.value === true) reaped++;
        else failed++;
      }
      return { reaped, failed };
    },
    budgetByKind(): Record<string, { count: number; budgetUnits: number }> {
      const out: Record<string, { count: number; budgetUnits: number }> = {};
      for (const r of _resources.values()) {
        const slot = out[r.kind] ?? (out[r.kind] = { count: 0, budgetUnits: 0 });
        slot.count += 1;
        slot.budgetUnits += r.budgetUnits ?? 0;
      }
      return out;
    },
  };
}

// ── Process-scope singleton ────────────────────────────────────────────────

let _singleton: ResourceRegistry | null = null;
export function getResourceRegistry(): ResourceRegistry {
  if (!_singleton) _singleton = createResourceRegistry();
  return _singleton;
}
export function _resetResourceRegistryForTests(): void {
  _singleton = null;
  _resources.clear();
}
