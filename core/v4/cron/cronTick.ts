/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/cron/cronTick.ts — Phase v4.1-cron
 *
 * 60-second heartbeat. The hybrid tick architecture:
 *
 *   - Per-job `setTimeout` arms each job for its specific next-
 *     fire time (existing legacy behaviour preserved). Sub-second
 *     precision, no extra latency.
 *
 *   - This heartbeat re-reads `cron_jobs.json` every 60s under
 *     lock. If another process (or the user editing the file)
 *     added / removed / paused jobs, this picks up the change
 *     and re-arms timers accordingly.
 *
 *   - When the lock is held by another process, the tick skips
 *     silently with a logged "skipped: lock held" line and a
 *     diagnostics increment.
 *
 *   - Fast-forward / catch-up after sleep: when the heartbeat
 *     wakes after a long pause (laptop slept past nextRun for
 *     multiple jobs), graceWindow.evaluateRecurring decides
 *     whether to fire-now or skip-and-fast-forward per job.
 *
 * The heartbeat is a singleton — calling `startHeartbeat()`
 * twice is a no-op. `stopHeartbeat()` clears the timer; the
 * caller is responsible for calling it on graceful shutdown
 * (CLI signal handler, REPL exit, etc.).
 */

import {
  type CronPaths,
  acquireCronLock,
  readCronState,
} from './cronState';
import {
  resolveTickMs,
  noteHeartbeat,
  noteSkippedTick,
} from './diagnostics';

// Module-level singleton — one heartbeat per process.
let _heartbeatTimer: NodeJS.Timeout | null = null;
let _heartbeatActive = false;

export interface HeartbeatOptions {
  paths: CronPaths;
  /** Fire when a tick lands (under lock). Receives the freshly-
   *  read state. The caller mutates timers, schedules fires, etc. */
  onTick: (jobs: import('./cronState').CronJobV2[]) => Promise<void> | void;
  /** Override interval — defaults to env / 60s. */
  intervalMs?: number;
  /** Override clock for tests. */
  now?: () => number;
}

/** Start the 60s heartbeat. Idempotent — second call no-ops. */
export function startHeartbeat(opts: HeartbeatOptions): void {
  if (_heartbeatTimer) return;
  const intervalMs = opts.intervalMs ?? resolveTickMs();

  const tick = async (): Promise<void> => {
    const lock = await acquireCronLock(opts.paths, { failFast: true });
    if (!lock) {
      noteSkippedTick();
      return;
    }
    try {
      noteHeartbeat(true);
      const state = await readCronState(opts.paths.stateFile);
      await opts.onTick(state.jobs);
    } catch {
      // Heartbeat must never throw out — caller's onTick is
      // best-effort. Errors land in the in-process logger via
      // the caller's own logging.
    } finally {
      await lock.release();
    }
  };

  _heartbeatActive = true;
  // Fire once immediately (the tick is the catch-up boundary).
  void tick();
  _heartbeatTimer = setInterval(() => { void tick(); }, intervalMs);
  // Don't keep the event loop alive just for the heartbeat.
  if (typeof _heartbeatTimer.unref === 'function') {
    _heartbeatTimer.unref();
  }
}

/** Stop the heartbeat. Idempotent. */
export function stopHeartbeat(): void {
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
  }
  _heartbeatActive = false;
  noteHeartbeat(false);
}

export function isHeartbeatActive(): boolean {
  return _heartbeatActive;
}
