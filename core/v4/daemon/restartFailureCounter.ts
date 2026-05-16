/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/restartFailureCounter.ts — v4.5 Phase 1.
 *
 * Per-session stuck-loop guard. Each time a daemon crashes mid-turn
 * for a given session, `incrementForSession(sessionId)` bumps the
 * counter. When the counter reaches the configured threshold (default
 * 3, configurable via AIDEN_DAEMON_RESTART_FAILURE_THRESHOLD), the
 * session is auto-suspended: future restarts will refuse to resume it
 * until the user explicitly sends a new message (which calls
 * `resetForSession`).
 *
 * Counter resets to 0 when a turn completes successfully or when the
 * user sends a new message.
 */

import type { Db } from './db/connection';

export const DEFAULT_STUCK_LOOP_THRESHOLD = 3;

export interface RestartFailureCounter {
  /** Increment + return new state. */
  incrementForSession(sessionId: string): { newCount: number; autoSuspended: boolean };
  /** Reset on successful turn or new user message. */
  resetForSession(sessionId: string): void;
  /** True when session was previously suspended and not yet reset. */
  isAutoSuspended(sessionId: string): boolean;
  /** Diagnostic — list every active suspension. */
  listSuspended(): Array<{ sessionId: string; count: number; lastFailure: number }>;
}

export interface CreateRestartFailureCounterOptions {
  db:        Db;
  threshold?: number;
}

export function createRestartFailureCounter(
  opts: CreateRestartFailureCounterOptions,
): RestartFailureCounter {
  const threshold = opts.threshold ?? DEFAULT_STUCK_LOOP_THRESHOLD;
  const db = opts.db;

  return {
    incrementForSession(sessionId: string) {
      const now = Date.now();
      const tx = db.transaction((): { newCount: number; autoSuspended: boolean } => {
        const row = db
          .prepare(
            'SELECT count, auto_suspended FROM restart_failure_counts WHERE session_id = ?',
          )
          .get(sessionId) as { count: number; auto_suspended: number } | undefined;
        const newCount = (row?.count ?? 0) + 1;
        const autoSuspended = newCount >= threshold;
        if (row) {
          db.prepare(
            `UPDATE restart_failure_counts
                SET count          = ?,
                    last_failure   = ?,
                    auto_suspended = ?
              WHERE session_id = ?`,
          ).run(newCount, now, autoSuspended ? 1 : 0, sessionId);
        } else {
          db.prepare(
            `INSERT INTO restart_failure_counts
               (session_id, count, last_failure, auto_suspended)
             VALUES (?, ?, ?, ?)`,
          ).run(sessionId, newCount, now, autoSuspended ? 1 : 0);
        }
        return { newCount, autoSuspended };
      });
      return tx();
    },
    resetForSession(sessionId: string): void {
      db.prepare(
        'DELETE FROM restart_failure_counts WHERE session_id = ?',
      ).run(sessionId);
    },
    isAutoSuspended(sessionId: string): boolean {
      const row = db
        .prepare(
          'SELECT auto_suspended FROM restart_failure_counts WHERE session_id = ?',
        )
        .get(sessionId) as { auto_suspended: number } | undefined;
      return row?.auto_suspended === 1;
    },
    listSuspended() {
      const rows = db
        .prepare(
          `SELECT session_id, count, last_failure
             FROM restart_failure_counts
            WHERE auto_suspended = 1
            ORDER BY last_failure DESC`,
        )
        .all() as Array<{ session_id: string; count: number; last_failure: number }>;
      return rows.map((r) => ({
        sessionId:   r.session_id,
        count:       r.count,
        lastFailure: r.last_failure,
      }));
    },
  };
}
