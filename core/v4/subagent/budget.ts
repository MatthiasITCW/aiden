/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/subagent/budget.ts — Phase v4.1-subagent
 *
 * Per-subagent timeouts and iteration caps. Two budgets layered:
 *
 *   - `perSubagentTimeoutMs` — hard wall-clock cap on a single
 *     subagent. Fired via AbortController; AidenAgent's provider
 *     adapter receives the abort and the in-flight HTTP call is
 *     cancelled (the v3 lesson — flag-only cancellation leaks
 *     tokens, AbortController plumbed through is the v4 fix).
 *
 *   - `wallClockCapMs` — outer cap on the whole fanout. Defaults
 *     to 5× the per-subagent timeout because parallel subagents
 *     should finish faster than 5× one-at-a-time, but variance
 *     (provider rate limits, retry backoff) can extend the tail.
 *
 *   - `maxIterations` — fresh per subagent. v3 starved nested
 *     spawns by dividing a global budget; v4 hands each subagent a
 *     full fresh budget and relies on the wall-clock cap for the
 *     outer bound.
 *
 * Read at fanout start. Each subagent gets its own AbortSignal
 * derived from the timeout; abort propagates from parent down via
 * `parentAbort.aborted`.
 */

/** Default per-subagent timeout (ms). Override via env
 *  `AIDEN_SUBAGENT_TIMEOUT_MS` or `timeoutMs` argument on the tool. */
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 90_000;

/** Default per-subagent iteration cap. Fresh per subagent. */
export const DEFAULT_SUBAGENT_MAX_ITERATIONS = 20;

/** Wall-clock cap multiplier — outer cap = `perSubagentTimeoutMs * MULT`. */
export const WALL_CLOCK_CAP_MULT = 5;

/** Max N — hard refuse beyond. */
export const MAX_FANOUT_N = 5;

/** Default N when the caller doesn't specify. */
export const DEFAULT_FANOUT_N = 3;

export interface SubagentBudget {
  perSubagentTimeoutMs: number;
  wallClockCapMs:       number;
  maxIterations:        number;
}

export interface ResolveBudgetOptions {
  /** Override from the tool call. Wins over env. */
  timeoutMs?: number;
  /** Process env (injected for tests; defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
}

/** Resolve the live budget. Tool-call argument > env > module default. */
export function resolveBudget(opts: ResolveBudgetOptions = {}): SubagentBudget {
  const env = opts.env ?? process.env;
  const envTimeoutRaw = env.AIDEN_SUBAGENT_TIMEOUT_MS;
  const envTimeout =
    envTimeoutRaw && /^\d+$/.test(envTimeoutRaw)
      ? Number.parseInt(envTimeoutRaw, 10)
      : null;

  const perSubagentTimeoutMs =
    opts.timeoutMs ?? envTimeout ?? DEFAULT_SUBAGENT_TIMEOUT_MS;

  return {
    perSubagentTimeoutMs,
    wallClockCapMs: perSubagentTimeoutMs * WALL_CLOCK_CAP_MULT,
    maxIterations:  DEFAULT_SUBAGENT_MAX_ITERATIONS,
  };
}

/** Validate the requested N — throws with a clear message when out of
 *  bounds. Caller surfaces the error as a tool-result error string. */
export function validateN(n: number): number {
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`subagent_fanout: n must be an integer, got ${n}`);
  }
  if (n < 1) {
    throw new Error(`subagent_fanout: n must be >= 1, got ${n}`);
  }
  if (n > MAX_FANOUT_N) {
    throw new Error(
      `subagent_fanout: n=${n} exceeds hard cap ${MAX_FANOUT_N}. ` +
      `Higher concurrency hits provider RPM limits and increases tail latency variance.`,
    );
  }
  return n;
}
