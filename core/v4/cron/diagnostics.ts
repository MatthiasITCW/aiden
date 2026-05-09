/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/cron/diagnostics.ts — Phase v4.1-cron
 *
 * Build fingerprint + diagnostics envelope for `/cron status`,
 * `aiden cron status`, and the heartbeat tracker. Bump on every
 * shipped phase. Format: `v4.1-cron[+suffix]`.
 */

/** Build fingerprint — bump per phase. */
export const AIDEN_CRON_BUILD = 'v4.1-cron';

/** Schema version — bumped when on-disk format changes. v1 = bare
 *  array, v2 = enveloped `{ jobs: [...], updatedAt, schemaVersion }`. */
export const CRON_SCHEMA_VERSION = 2;

/** Default 60s heartbeat — env override `AIDEN_CRON_TICK_MS`. */
export const DEFAULT_TICK_MS = 60_000;

/** Default per-fire timeout — env override `AIDEN_CRON_TIMEOUT_MS`.
 *  Long-running shell_exec (web research, deep file ops) legitimately
 *  takes minutes; 600s gives ample headroom. */
export const DEFAULT_TIMEOUT_MS = 600_000;

/** Recent-fires retention — diagnostics surface the last N. */
export const RECENT_FIRES_KEEP = 5;

/** A single cron-fire record kept in the diagnostics ring buffer. */
export interface CronFireRecord {
  jobId:    string;
  startedAt: string;        // ISO timestamp
  durationMs: number;
  status:   'ok' | 'warn' | 'error' | 'timeout';
  exitCode?: number;
  error?:   string;
}

/** Diagnostics surfaced to /cron status + aiden cron status. */
export interface CronDiagnostics {
  build: string;
  schemaVersion: number;
  tickMs: number;
  timeoutMs: number;
  /** True when the heartbeat loop is armed in this process. */
  heartbeatActive: boolean;
  /** Last heartbeat tick wall-clock (ISO) — null before first tick. */
  lastHeartbeatAt: string | null;
  /** Skipped-tick count since boot (lock held by another process). */
  skippedTicks: number;
  /** Total fires this process started. */
  firesStarted: number;
  /** Recent fires ring buffer (most recent first, capped at RECENT_FIRES_KEEP). */
  recentFires: CronFireRecord[];
  /** Lock state — best-effort snapshot. */
  lock: {
    path:   string;
    held:   boolean;
  };
}

/** In-process diagnostics ring buffer. Module singleton — survives
 *  across calls but resets on process boot. */
const _state = {
  heartbeatActive: false,
  lastHeartbeatAt: null as string | null,
  skippedTicks:    0,
  firesStarted:    0,
  recentFires:     [] as CronFireRecord[],
};

export function noteHeartbeat(active: boolean, at: Date = new Date()): void {
  _state.heartbeatActive = active;
  _state.lastHeartbeatAt = at.toISOString();
}

export function noteSkippedTick(): void {
  _state.skippedTicks += 1;
}

export function noteFireStarted(): void {
  _state.firesStarted += 1;
}

export function recordFire(rec: CronFireRecord): void {
  _state.recentFires.unshift(rec);
  if (_state.recentFires.length > RECENT_FIRES_KEEP) {
    _state.recentFires.length = RECENT_FIRES_KEEP;
  }
}

export function getDiagnosticsSnapshot(opts: {
  lockPath: string;
  lockHeld: boolean;
  schemaVersion: number;
}): CronDiagnostics {
  return {
    build:           AIDEN_CRON_BUILD,
    schemaVersion:   opts.schemaVersion,
    tickMs:          resolveTickMs(),
    timeoutMs:       resolveTimeoutMs(),
    heartbeatActive: _state.heartbeatActive,
    lastHeartbeatAt: _state.lastHeartbeatAt,
    skippedTicks:    _state.skippedTicks,
    firesStarted:    _state.firesStarted,
    recentFires:     [..._state.recentFires],
    lock:            { path: opts.lockPath, held: opts.lockHeld },
  };
}

/** Resolve tick interval — env override > default. */
export function resolveTickMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AIDEN_CRON_TICK_MS;
  if (raw && /^\d+$/.test(raw)) {
    const n = Number.parseInt(raw, 10);
    if (n >= 1000 && n <= 3_600_000) return n;
  }
  return DEFAULT_TICK_MS;
}

/** Resolve per-fire timeout — env override > default. */
export function resolveTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AIDEN_CRON_TIMEOUT_MS;
  if (raw && /^\d+$/.test(raw)) {
    const n = Number.parseInt(raw, 10);
    if (n >= 1_000 && n <= 24 * 3_600_000) return n;
  }
  return DEFAULT_TIMEOUT_MS;
}

/** Test-only: reset diagnostics state. */
export function __resetDiagnosticsForTests(): void {
  _state.heartbeatActive = false;
  _state.lastHeartbeatAt = null;
  _state.skippedTicks = 0;
  _state.firesStarted = 0;
  _state.recentFires = [];
}
