/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/runtimeLock.ts — v4.5 Phase 1: race-safe daemon
 * runtime lock.
 *
 * Replaces the plain `fs.writeFileSync(PID_FILE, pid)` in
 * `core/backgroundService.ts:21` which has a TOCTOU race window
 * (two daemons racing to write the PID file both succeed, then
 * step on each other's adapters).
 *
 * Mechanism: `fs.openSync(lockPath, 'wx')` — the `wx` flag opens
 * with O_CREAT | O_EXCL, throwing EEXIST atomically if the file
 * already exists. We write the instance metadata into the locked
 * file and rely on `atexit`-style cleanup + signal handlers to
 * release.
 *
 * Stale-lock recovery: when EEXIST fires, we read the existing
 * file, parse out the PID, and probe it with `process.kill(pid, 0)`.
 * If the owner is dead, we unlink the stale file and retry once.
 * If alive, we throw `DaemonAlreadyRunningError` carrying the PID
 * so the caller can surface a clear error.
 *
 * Cross-platform: Node's `wx` flag works identically on Windows
 * (where the underlying call is CreateFile with FILE_FLAG_OPEN_NO_RECALL
 * + CREATE_NEW). No fcntl/msvcrt fallbacks needed.
 */

import fs from 'node:fs';
import path from 'node:path';

export class DaemonAlreadyRunningError extends Error {
  public readonly pid: number;
  public readonly lockPath: string;
  constructor(pid: number, lockPath: string) {
    super(
      `Daemon already running (pid ${pid}). Lock file: ${lockPath}. ` +
      `Use \`aiden daemon stop\` to stop the running instance, or set ` +
      `AIDEN_DAEMON=0 to skip daemon mode.`,
    );
    this.name = 'DaemonAlreadyRunningError';
    this.pid = pid;
    this.lockPath = lockPath;
  }
}

export interface RuntimeLock {
  release(): void;
  /** Path to the lock file (for diagnostics). */
  readonly lockPath: string;
}

interface LockFileContents {
  instanceId: string;
  pid:        number;
  startedAt:  number;
}

function readLockFile(lockPath: string): LockFileContents | null {
  try {
    const raw = fs.readFileSync(lockPath, 'utf-8').trim();
    if (!raw) return null;
    // Format: 3 lines (instance_id, pid, started_at_ms).
    const lines = raw.split(/\r?\n/);
    if (lines.length < 2) return null;
    const pid = Number.parseInt(lines[1], 10);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return {
      instanceId: lines[0],
      pid,
      startedAt: Number.parseInt(lines[2] ?? '0', 10) || 0,
    };
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process → dead. EPERM = exists but not ours → treat as alive.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    return false;
  }
}

function writeLockFile(
  fd: number,
  contents: LockFileContents,
): void {
  const body = `${contents.instanceId}\n${contents.pid}\n${contents.startedAt}\n`;
  fs.writeSync(fd, body, 0, 'utf-8');
  fs.fsyncSync(fd);
  fs.closeSync(fd);
}

export interface AcquireRuntimeLockOptions {
  lockPath:   string;
  instanceId: string;
  pid?:       number;          // default process.pid
  startedAt?: number;          // default Date.now()
  /** Optional logger for the recovery branches. */
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

/**
 * Atomically acquire the daemon's runtime lock at `lockPath`.
 * Throws `DaemonAlreadyRunningError` when another live daemon
 * already holds it. Recovers automatically from stale locks left
 * by crashed daemons.
 */
export function acquireRuntimeLock(opts: AcquireRuntimeLockOptions): RuntimeLock {
  const lockPath  = opts.lockPath;
  const pid       = opts.pid       ?? process.pid;
  const startedAt = opts.startedAt ?? Date.now();
  const contents: LockFileContents = {
    instanceId: opts.instanceId,
    pid,
    startedAt,
  };

  // Ensure parent dir exists.
  try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); }
  catch { /* will surface on open */ }

  type AttemptResult =
    | { ok: true;  fd: number }
    | { ok: false; reason: 'eexist' | 'other'; err: Error };

  const attempt = (): AttemptResult => {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      return { ok: true, fd };
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'EEXIST') return { ok: false, reason: 'eexist', err };
      return { ok: false, reason: 'other', err };
    }
  };

  let r: AttemptResult = attempt();
  if (r.ok === false && r.reason === 'eexist') {
    // Stale-lock recovery — read existing contents, probe the PID.
    const existing = readLockFile(lockPath);
    if (existing && isPidAlive(existing.pid)) {
      throw new DaemonAlreadyRunningError(existing.pid, lockPath);
    }
    opts.log?.('warn', `Daemon: removing stale runtime lock (pid ${existing?.pid ?? '?'} dead)`);
    try { fs.unlinkSync(lockPath); } catch { /* race-safe: ignore */ }
    r = attempt();
  }
  if (r.ok === false) {
    throw new Error(`Failed to acquire daemon runtime lock at ${lockPath}: ${r.err.message}`);
  }

  writeLockFile(r.fd, contents);

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try { fs.unlinkSync(lockPath); } catch { /* best-effort */ }
  };
  // Defense-in-depth: also clean up on process exit even if the
  // caller forgets. Drain handler calls release() explicitly.
  const onExit = (): void => { release(); };
  process.once('exit', onExit);

  return {
    release: (): void => {
      release();
      try { process.removeListener('exit', onExit); } catch { /* noop */ }
    },
    lockPath,
  };
}
