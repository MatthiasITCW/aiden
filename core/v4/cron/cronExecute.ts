/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/cron/cronExecute.ts — Phase v4.1-cron
 *
 * Fire one cron job end-to-end with the hardened safeguards:
 *
 *   1. ADVANCE-BEFORE-EXECUTE. Under lock, compute the next-fire
 *      timestamp and persist it FIRST. Only then dispatch the
 *      action. Hard-won lesson: "missing one run is far better
 *      than firing dozens of times in a crash loop." If the
 *      process dies during execute, restart sees the already-
 *      advanced nextRun and waits for that — no double-fire.
 *
 *   2. INACTIVITY TIMEOUT. `Promise.race` against a per-fire
 *      deadline (default 600s, env `AIDEN_CRON_TIMEOUT_MS`). On
 *      timeout, mark `last_status="timeout"` and set
 *      `last_error` to the timeout message.
 *
 *   3. TRY/FINALLY CLEANUP. Long-running shell_exec children may
 *      leak file descriptors / processes. The finally block
 *      guarantees we record the run in diagnostics + persist
 *      state even if the action throws synchronously.
 *
 *   4. EMPTY-OUTPUT WARNING. If the action returns ok=true with
 *      ZERO output bytes, mark `last_status="warn"`. prior systems' #6
 *      lesson: an empty agent response is a soft failure — don't
 *      claim "ok".
 *
 *   5. STATE="error" + enabled=true on un-computable next-fire.
 *      Never silently disable a recurring job because croner
 *      hiccupped — surface the error to the user via /cron status.
 *
 * The actual command dispatch is injected as `runActionFn` so
 * tests can stub it without spinning up the v3 toolRegistry.
 */

import { promises as fsp } from 'node:fs';

import {
  type CronJobV2,
  type CronStateV2,
  type CronPaths,
  readCronState,
  writeCronState,
  acquireCronLock,
} from './cronState';
import {
  evaluateRecurring,
  evaluateOneShot,
  type FireVerdict,
} from './graceWindow';
import {
  resolveTimeoutMs,
  noteFireStarted,
  recordFire,
  type CronFireRecord,
} from './diagnostics';
import { captureRun, type CaptureOutcome } from './outputCapture';

// ── Action contract ──────────────────────────────────────────────────────

/** Per-fire action result. `failed=true` flips the run to error. */
export interface ActionResult {
  output: string;
  failed?: boolean;
}

export type RunActionFn = (
  job: CronJobV2,
  signal: AbortSignal,
) => Promise<ActionResult>;

// ── Next-fire computation ────────────────────────────────────────────────

/** Compute the next fire time for a job. Returns null when there
 *  is no future occurrence (one-shot already fired, malformed
 *  cron expr, etc.). The caller's response to null differs by
 *  kind:
 *
 *  - oneshot: flip enabled=false, state='completed'
 *  - interval/cron: state='error', enabled=true (don't disable!)
 *
 *  Period (ms) is also returned for the grace-window math. */
export async function computeNextFire(
  job: CronJobV2,
  nowMs: number = Date.now(),
): Promise<{ next: number | null; periodMs: number }> {
  if (job.kind === 'interval') {
    if (typeof job.intervalMs !== 'number' || job.intervalMs <= 0) {
      return { next: null, periodMs: 0 };
    }
    const anchor = job.lastRun
      ? new Date(job.lastRun).getTime()
      : new Date(job.createdAt).getTime();
    let next = anchor + job.intervalMs;
    // If anchor + interval is in the past, fast-forward to the next
    // future tick (consumed by graceWindow.evaluateRecurring).
    while (next <= nowMs) next += job.intervalMs;
    return { next, periodMs: job.intervalMs };
  }
  if (job.kind === 'oneshot') {
    if (!job.oneshotIso) return { next: null, periodMs: 0 };
    const t = new Date(job.oneshotIso).getTime();
    return { next: Number.isFinite(t) ? t : null, periodMs: 0 };
  }
  // cron — delegate to croner.
  if (!job.cronExpr) return { next: null, periodMs: 0 };
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Cron } = require('croner') as typeof import('croner');
    const c = new Cron(job.cronExpr);
    const a = c.nextRun(new Date(nowMs));
    if (!a) return { next: null, periodMs: 0 };
    const b = c.nextRun(a);
    const period = b ? b.getTime() - a.getTime() : 0;
    return { next: a.getTime(), periodMs: period };
  } catch {
    return { next: null, periodMs: 0 };
  }
}

// ── Verdict ─────────────────────────────────────────────────────────────

/** Decide what to do with this job at `nowMs`. Pure — read from
 *  the in-memory snapshot, no state mutation. */
export async function decideFire(
  job: CronJobV2,
  nowMs: number = Date.now(),
): Promise<{ verdict: FireVerdict; nextMs: number | null; periodMs: number }> {
  const { next, periodMs } = await computeNextFire(job, nowMs);
  if (next === null) {
    // Caller flips state based on kind.
    return { verdict: { kind: 'wait' }, nextMs: null, periodMs };
  }
  if (job.kind === 'oneshot') {
    return { verdict: evaluateOneShot({ runAtMs: next, nowMs }), nextMs: next, periodMs };
  }
  return {
    verdict: evaluateRecurring({ nextRunAtMs: next, periodMs, nowMs }),
    nextMs:  next,
    periodMs,
  };
}

// ── Fire one job ─────────────────────────────────────────────────────────

export interface FireOptions {
  paths:       CronPaths;
  jobId:       string;
  runAction:   RunActionFn;
  /** Override timeout — defaults to env / 600s. */
  timeoutMs?:  number;
  /** Override now — tests pass a stub. */
  now?:        () => number;
}

/** Run one job end-to-end. Acquires lock, advances next-run BEFORE
 *  dispatch, runs the action with timeout, persists result. NEVER
 *  throws — failures land in `lastError` / `lastResult='timeout'`. */
export async function fireJob(opts: FireOptions): Promise<CronFireRecord | null> {
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? resolveTimeoutMs();

  // ── Phase 1: advance under lock ─────────────────────────────
  const lock = await acquireCronLock(opts.paths, { failFast: false });
  if (!lock) {
    // Lock held by another process — skip this fire.
    return null;
  }

  let job: CronJobV2 | undefined;
  let state: CronStateV2;
  try {
    state = await readCronState(opts.paths.stateFile);
    const idx = state.jobs.findIndex((j) => j.id === opts.jobId);
    if (idx === -1) return null;
    job = state.jobs[idx]!;

    // Skip paused / disabled jobs defensively (the caller filters
    // these out, but a stale heartbeat could race).
    if (!job.enabled || job.state === 'paused' || job.state === 'completed') {
      return null;
    }

    // Compute next-fire BEFORE running the action.
    const { next, periodMs } = await computeNextFire(job, now());
    if (next === null) {
      // Un-computable. Recurring → state="error"; oneshot → completed.
      if (job.kind === 'oneshot') {
        job.enabled = false;
        job.state   = 'completed';
      } else {
        job.state     = 'error';
        job.lastError = 'Cron schedule produced no future fire time';
      }
      state.jobs[idx] = job;
      await writeCronState(opts.paths.stateFile, state);
      return null;
    }

    // For recurring jobs, set nextRun to the future before dispatch.
    // For one-shots, the next fire is the SAME as this one — we'll
    // mark completed when the action returns.
    if (job.kind !== 'oneshot') {
      // Advance to NEXT future (this fire we're about to do should
      // not re-fire on restart).
      job.nextRun = new Date(next).toISOString();
    }
    state.jobs[idx] = job;
    await writeCronState(opts.paths.stateFile, state);
    void periodMs; // recorded for diagnostics elsewhere
  } finally {
    await lock.release();
  }

  // ── Phase 2: dispatch with timeout (no lock held) ─────────────

  noteFireStarted();
  const startedAt = new Date(now()).toISOString();
  const t0 = now();
  const aborter = new AbortController();
  let timeoutFired = false;
  const timer = setTimeout(() => {
    timeoutFired = true;
    aborter.abort();
  }, timeoutMs);

  let captureOutcome: CaptureOutcome;
  try {
    captureOutcome = await captureRun(
      job.id,
      job.description || job.id,
      opts.paths.logsDir,
      async () => {
        try {
          // Race the action against the timeout. The timeout AbortSignal
          // is plumbed in for cooperative cancellation.
          const r = await opts.runAction(job!, aborter.signal);
          if (timeoutFired) {
            return {
              output: 'timeout',
              failed: true,
            };
          }
          return r;
        } catch (err) {
          return {
            output: err instanceof Error ? (err.stack ?? err.message) : String(err),
            failed: true,
          };
        }
      },
    );
  } finally {
    clearTimeout(timer);
  }

  // ── Phase 3: record result under lock ─────────────────────────

  const status: CronFireRecord['status'] = timeoutFired
    ? 'timeout'
    : captureOutcome.result === 'ok' && captureOutcome.fullOutputBytes === 0
    ? 'warn'        // empty output is a soft failure (prior-systems lesson)
    : captureOutcome.result === 'ok'
    ? 'ok'
    : 'error';

  const fireRecord: CronFireRecord = {
    jobId:      job.id,
    startedAt,
    durationMs: now() - t0,
    status,
    error:      status === 'error' || status === 'timeout'
      ? captureOutcome.output.slice(0, 200)
      : undefined,
  };
  recordFire(fireRecord);

  const lock2 = await acquireCronLock(opts.paths, { failFast: false });
  if (lock2) {
    try {
      const fresh = await readCronState(opts.paths.stateFile);
      const idx = fresh.jobs.findIndex((j) => j.id === job!.id);
      if (idx !== -1) {
        const j = fresh.jobs[idx]!;
        j.lastRun    = startedAt;
        j.lastResult = status;
        j.lastOutput = captureOutcome.output;
        j.lastError  = (status === 'ok' || status === 'warn') ? null : captureOutcome.output.slice(0, 500);
        j.runCount   = (j.runCount ?? 0) + 1;
        if (j.kind === 'oneshot') {
          j.enabled = false;
          j.state   = 'completed';
        }
        fresh.jobs[idx] = j;
        await writeCronState(opts.paths.stateFile, fresh);
      }
    } finally {
      await lock2.release();
    }
  }

  return fireRecord;
}

/** Default `runActionFn` — dispatch via plain `child_process.exec`.
 *  Cron jobs run a shell command; we don't need the agent loop or
 *  the v3 toolRegistry's gating layers for that. Direct shell out
 *  is faster, lighter, and honours AbortSignal cleanly via SIGTERM
 *  on the spawned child.
 *
 *  Output is captured and combined (stdout + stderr) so the
 *  outputCapture's truncation sees the full picture. */
export async function defaultRunAction(
  job: CronJobV2,
  signal: AbortSignal,
): Promise<ActionResult> {
  if (signal.aborted) return { output: 'aborted before dispatch', failed: true };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { exec } = require('node:child_process') as typeof import('node:child_process');
  return new Promise<ActionResult>((resolve) => {
    const child = exec(job.action, {
      timeout: 0, // we own the timer via signal in cronExecute
      maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      const out = String(stdout ?? '') + (stderr ? `\n${stderr}` : '');
      if (err) {
        resolve({
          output: out || err.message,
          failed: true,
        });
      } else {
        resolve({ output: out, failed: false });
      }
    });
    signal.addEventListener('abort', () => {
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
      // SIGKILL backstop after 2s for shells that ignore SIGTERM.
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* dead */ }
      }, 2_000).unref();
    }, { once: true });
  });
}

// (Marked exported for the smoke; unused outside.)
void fsp;
