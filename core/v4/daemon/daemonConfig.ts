/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/daemonConfig.ts — v4.5 Phase 1: daemon configuration.
 *
 * Env-driven config (same pattern as v4.4 sandboxConfig). Strict
 * `=== '1'` opt-in for AIDEN_DAEMON in Phases 1-5; Phase 6 will
 * flip to `!== '0'` (default-on).
 *
 * Sub-flags:
 *   AIDEN_DAEMON_PORT             — daemon API port (default reuses AIDEN_PORT)
 *   AIDEN_DAEMON_AUTO_RESTART     — '0' disables the internal supervisor
 *                                   (use when running under systemd/launchd)
 *   AIDEN_DAEMON_DRAIN_TIMEOUT_MS — drain timeout for in-flight runs (default 30000)
 *   AIDEN_DAEMON_RESTART_FAILURE_THRESHOLD — per-session stuck-loop threshold (default 3)
 */

import path from 'node:path';
import os from 'node:os';

export interface DaemonConfig {
  /** Master enable flag. */
  enabled: boolean;
  /** Daemon API port. */
  port: number;
  /** Internal supervisor enabled. */
  autoRestart: boolean;
  /** Drain timeout (ms) for in-flight runs on shutdown. */
  drainTimeoutMs: number;
  /** Per-session consecutive-crash threshold before auto-suspend. */
  restartFailureThreshold: number;
}

const DEFAULT_PORT                  = 4200;
const DEFAULT_DRAIN_TIMEOUT_MS      = 30_000;
const DEFAULT_RESTART_FAILURE_LIMIT = 3;

function parseIntSafe(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function readDaemonConfig(
  env: NodeJS.ProcessEnv = process.env,
): DaemonConfig {
  // Phase 1-5 strict opt-in. Phase 6 will flip to `!== '0'`.
  const enabled = env.AIDEN_DAEMON === '1';
  const port = parseIntSafe(
    env.AIDEN_DAEMON_PORT ?? env.AIDEN_PORT,
    DEFAULT_PORT,
  );
  const autoRestart = env.AIDEN_DAEMON_AUTO_RESTART !== '0';  // default true
  const drainTimeoutMs = parseIntSafe(
    env.AIDEN_DAEMON_DRAIN_TIMEOUT_MS,
    DEFAULT_DRAIN_TIMEOUT_MS,
  );
  const restartFailureThreshold = parseIntSafe(
    env.AIDEN_DAEMON_RESTART_FAILURE_THRESHOLD,
    DEFAULT_RESTART_FAILURE_LIMIT,
  );
  return { enabled, port, autoRestart, drainTimeoutMs, restartFailureThreshold };
}

let _singleton: DaemonConfig | null = null;
export function getDaemonConfig(): DaemonConfig {
  if (!_singleton) _singleton = readDaemonConfig();
  return _singleton;
}
export function _resetDaemonConfigForTests(): void {
  _singleton = null;
}

/**
 * Resolve the daemon's on-disk root directory:
 *   <aidenHome>/daemon/
 * Caller passes the resolved Aiden root (from `core/v4/paths.ts`);
 * we don't import paths.ts here to keep the dependency graph clean.
 */
export function daemonDir(aidenRoot: string): string {
  return path.join(aidenRoot, 'daemon');
}

export function daemonDbPath(aidenRoot: string): string {
  return path.join(daemonDir(aidenRoot), 'daemon.db');
}

export function daemonRuntimeLockPath(aidenRoot: string): string {
  return path.join(daemonDir(aidenRoot), 'runtime.lock');
}

export function daemonCleanShutdownMarkerPath(aidenRoot: string): string {
  return path.join(daemonDir(aidenRoot), '.clean_shutdown');
}

/** Hostname for instance records — short, never empty. */
export function getHostname(): string {
  try {
    const h = os.hostname();
    return h && h.length > 0 ? h : 'unknown';
  } catch {
    return 'unknown';
  }
}
