/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/eventLoopLag.ts — v4.5 Phase 1: event-loop responsiveness.
 *
 * A ticking timer measures how long it takes the event loop to fire
 * a 100ms `setInterval`. Lag = `(actual - expected)`. A healthy
 * loop reports lag ≤ a few ms; a saturated loop blows out into
 * hundreds of ms.
 *
 * Consumed by:
 *   - /health/live — endpoint returns 500 when lag > 5s for > 5s
 *   - /metrics — `aiden_daemon_event_loop_lag_ms` gauge
 */

const SAMPLE_INTERVAL_MS = 100;

let _timer: NodeJS.Timeout | null = null;
let _lastTickAt: number = 0;
let _lastLagMs: number  = 0;

function tick(): void {
  const now = Date.now();
  if (_lastTickAt !== 0) {
    _lastLagMs = Math.max(0, now - _lastTickAt - SAMPLE_INTERVAL_MS);
  }
  _lastTickAt = now;
}

/** Start the sampler. Idempotent. */
export function startEventLoopLagSampler(): void {
  if (_timer) return;
  _lastTickAt = Date.now();
  _lastLagMs  = 0;
  _timer = setInterval(tick, SAMPLE_INTERVAL_MS);
  if (typeof _timer.unref === 'function') _timer.unref();
}

/** Stop the sampler. Idempotent. */
export function stopEventLoopLagSampler(): void {
  if (!_timer) return;
  clearInterval(_timer);
  _timer = null;
  _lastTickAt = 0;
  _lastLagMs  = 0;
}

/** Most-recent sampled lag in ms. Zero when sampler hasn't run yet. */
export function getEventLoopLagMs(): number {
  return _lastLagMs;
}

/** Wall-clock time of the last successful tick (0 when never). */
export function getLastTickAt(): number {
  return _lastTickAt;
}

/**
 * Liveness verdict: true when the event loop has ticked within the
 * tolerance window. The `tolerance` defaults to 5s, matching the
 * /health/live endpoint's threshold.
 */
export function isEventLoopResponsive(toleranceMs = 5_000): boolean {
  if (_lastTickAt === 0) return false;
  return Date.now() - _lastTickAt <= toleranceMs;
}
