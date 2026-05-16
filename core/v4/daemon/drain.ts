/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/drain.ts — v4.5 Phase 1: 5-step ordered shutdown drain.
 *
 * The shutdown sequence is order-sensitive. Getting it wrong wastes
 * the drain budget on the wrong thing OR loses attribution on
 * subprocess cleanup. Sequence:
 *
 *   Step 0: markShuttingDown(reason)         — record intent in DB
 *   Step 1: notifySessions()                 — let sessions emit "shutting
 *                                              down" while adapters are up
 *   Step 2: drain active runs (timeout)
 *           - on timeout: mark each still-active run with
 *             resume_pending + interrupt + wait 5s for cooperation
 *   Step 3: kill tool subprocesses           — BEFORE adapter teardown,
 *                                              so they don't get reaped
 *                                              by the cgroup and lose
 *                                              attribution
 *   Step 4: close resources                  — parallel: browser, docker,
 *                                              cron, idempotency, sqlite
 *                                              (resourceRegistry.reapAll)
 *   Step 5: mark daemon_instances shutdown   — final DB write
 *           release runtime lock
 *           touch .clean_shutdown marker
 *           process.exit(exitCode)
 */

import type { DrainContext, ShutdownReason } from './types';

const POST_INTERRUPT_GRACE_MS = 5_000;

/** True once a drain has started — used by signal handlers to de-bounce. */
let _draining = false;

export function isDraining(): boolean { return _draining; }
export function _resetDrainStateForTests(): void { _draining = false; }

export interface PerformDrainOptions extends DrainContext {
  /** When set to false, drain returns instead of calling process.exit. Tests pass false. */
  callProcessExit?: boolean;
}

export async function performDrain(opts: PerformDrainOptions): Promise<{
  durationMs:      number;
  drainTimedOut:   boolean;
  resumePendingIds: number[];
  reapedResources: { reaped: number; failed: number } | null;
}> {
  if (_draining) {
    // Idempotent — a second signal during drain is a no-op.
    return { durationMs: 0, drainTimedOut: false, resumePendingIds: [], reapedResources: null };
  }
  _draining = true;
  const startedAt = Date.now();

  // ── Step 0: mark shutting down ────────────────────────────────────────
  try { opts.markShutdown?.(opts.reason, opts.exitCode ?? 0); } catch { /* noop */ }
  // (Note: markShutdown is called twice — once here to set
  // shutdown_reason early so observers see the daemon is exiting,
  // again in Step 5 with the final exit_code.)

  // ── Step 1: notify sessions ───────────────────────────────────────────
  try { await Promise.resolve(opts.notifySessions?.()); } catch { /* never block on notify */ }

  // ── Step 2: drain active runs with timeout ────────────────────────────
  const activeIds = await Promise.resolve(opts.activeRuns?.() ?? []);
  const resumePendingIds: number[] = [];
  let drainTimedOut = false;
  if (activeIds.length > 0 && opts.drainTimeoutMs > 0) {
    // Implementation note: the daemon's run-completion path is
    // event-driven, but Phase 1 doesn't yet have a "wait for runs
    // to finish" primitive (Phase 5 will, when runs are wired to
    // the agent loop). Phase 1's behaviour: simply wait
    // drainTimeoutMs, then check if any runs are still active and
    // mark them resume_pending. This is correct for Phase 1's
    // shape (no triggers wired = no active daemon-runs to drain).
    await sleep(opts.drainTimeoutMs);
    const stillActive = await Promise.resolve(opts.activeRuns?.() ?? []);
    if (stillActive.length > 0) {
      drainTimedOut = true;
      for (const runId of stillActive) {
        try { await Promise.resolve(opts.markResumePending?.(runId, 'drain_timeout')); }
        catch { /* best-effort */ }
        try { await Promise.resolve(opts.interruptRun?.(runId, 'shutdown')); }
        catch { /* best-effort */ }
        resumePendingIds.push(runId);
      }
      await sleep(opts.postInterruptGraceMs ?? POST_INTERRUPT_GRACE_MS);
    }
  }

  // ── Step 3: kill tool subprocesses BEFORE adapter teardown ────────────
  try { await Promise.resolve(opts.killToolSubprocesses?.('post-interrupt')); }
  catch { /* best-effort */ }

  // ── Step 4: close resources (parallel) ────────────────────────────────
  let reapedResources: { reaped: number; failed: number } | null = null;
  try {
    const tasks: Array<Promise<unknown>> = [];
    if (opts.closeBrowser)      tasks.push(Promise.resolve(opts.closeBrowser()).catch(() => undefined));
    if (opts.closeCron)         tasks.push(Promise.resolve(opts.closeCron()).catch(() => undefined));
    if (opts.closeDocker)       tasks.push(Promise.resolve(opts.closeDocker()).catch(() => undefined));
    if (opts.closeIdempotency)  tasks.push(Promise.resolve(opts.closeIdempotency()).catch(() => undefined));
    if (opts.closeResources)    tasks.push(
      Promise.resolve(opts.closeResources())
        .then((r) => {
          if (r && typeof r === 'object' && 'reaped' in r && 'failed' in r) {
            reapedResources = r as { reaped: number; failed: number };
          }
        })
        .catch(() => undefined),
    );
    if (tasks.length > 0) await Promise.all(tasks);
  } catch { /* never block shutdown on resource close */ }

  // ── Step 5: final markers + exit ──────────────────────────────────────
  try { opts.markShutdown?.(opts.reason, opts.exitCode ?? 0); } catch { /* noop */ }
  try { opts.touchCleanShutdown?.(); }                          catch { /* noop */ }
  try { opts.removePid?.(); }                                   catch { /* noop */ }

  const durationMs = Date.now() - startedAt;
  if (opts.callProcessExit !== false) {
    // Default — exit the process. Tests pass `callProcessExit: false`.
    process.exit(opts.exitCode ?? 0);
  }
  return { durationMs, drainTimedOut, resumePendingIds, reapedResources };
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

/** Convenience for callers that want a shutdown reason from a signal name. */
export function signalToReason(signal: 'SIGINT' | 'SIGTERM' | 'SIGUSR1'): ShutdownReason {
  switch (signal) {
    case 'SIGINT':  return 'sigint';
    case 'SIGTERM': return 'sigterm';
    case 'SIGUSR1': return 'sigusr1_restart';
  }
}
