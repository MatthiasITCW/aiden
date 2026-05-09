/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/cron/graceWindow.ts — Phase v4.1-cron
 *
 * Adaptive grace window for fast-forward / catch-up after sleep.
 *
 * Hard-won lesson (port from prior multi-agent systems): a fixed
 * global grace cap is wrong for cron. Daily jobs that ran at 9am
 * yesterday and the laptop slept past 9am today should still fire
 * within a reasonable window (up to ~2h late). But sub-hourly jobs
 * (every 5 minutes) should NOT fire 30 missed instances after a
 * long sleep — that's a thundering-herd disaster.
 *
 * Solution: scale the grace window to the schedule period. Half
 * the period, capped at 2h, floored at 2 minutes. Then SKIP, don't
 * REPLAY: when a job is overdue beyond its grace, fast-forward
 * `nextRunAt` to the next future occurrence and skip this firing
 * entirely. "One missed run lost; no thundering-herd risk."
 *
 *   grace = max(120s, min(period/2, 7200s))
 *
 * This module is a pure function — no I/O, no state. Caller
 * threads the snapshot and decides what to do based on the
 * verdict.
 */

/** Constants — exposed for tests. */
export const GRACE_FLOOR_MS = 120 * 1000;          // 2 minutes
export const GRACE_CEIL_MS  = 2 * 60 * 60 * 1000;  // 2 hours
/** One-shot jobs get a fixed 2-minute grace window — they cannot
 *  fast-forward (no recurring schedule), so a delivery that hits
 *  the second after a one-shot's `runAt` should still fire. */
export const ONESHOT_GRACE_MS = 120 * 1000;

export type FireVerdict =
  /** On-time or within grace — fire now. */
  | { kind: 'fire' }
  /** Too far overdue — skip this firing, advance nextRun to next future. */
  | { kind: 'skip-fast-forward' }
  /** Future — not yet due. */
  | { kind: 'wait' };

/** Compute the grace window for a recurring schedule. `periodMs` is
 *  the interval between fires (e.g. interval=300_000 for every 5
 *  minutes, or the croner-computed gap between successive cron
 *  fires). */
export function computeGraceMs(periodMs: number): number {
  if (!Number.isFinite(periodMs) || periodMs <= 0) return GRACE_FLOOR_MS;
  const half = Math.floor(periodMs / 2);
  const clamped = Math.max(GRACE_FLOOR_MS, Math.min(half, GRACE_CEIL_MS));
  return clamped;
}

/** Determine whether a recurring job should fire, skip-and-advance,
 *  or wait. Pure — no clock injection issue: caller passes `now`. */
export function evaluateRecurring(args: {
  /** Job's currently-stored next-run time (ms epoch). */
  nextRunAtMs: number;
  /** Schedule period in ms (intervalMs OR croner gap). */
  periodMs: number;
  /** Wall clock — caller passes Date.now() or a test stub. */
  nowMs: number;
}): FireVerdict {
  const { nextRunAtMs, periodMs, nowMs } = args;
  if (nowMs < nextRunAtMs) return { kind: 'wait' };

  const overdueMs = nowMs - nextRunAtMs;
  const grace = computeGraceMs(periodMs);
  if (overdueMs <= grace) return { kind: 'fire' };
  return { kind: 'skip-fast-forward' };
}

/** One-shot variant — different grace window, no fast-forward. */
export function evaluateOneShot(args: {
  runAtMs: number;
  nowMs: number;
}): FireVerdict {
  const { runAtMs, nowMs } = args;
  if (nowMs < runAtMs) return { kind: 'wait' };
  // One-shot: fire if within ONESHOT_GRACE_MS, else "skip" — the
  // caller flips `enabled=false` on this job rather than advancing
  // because there's no next occurrence.
  const overdueMs = nowMs - runAtMs;
  if (overdueMs <= ONESHOT_GRACE_MS) return { kind: 'fire' };
  return { kind: 'skip-fast-forward' };
}
