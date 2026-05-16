/**
 * v4.5 Phase 1 — runtimeLock tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  acquireRuntimeLock,
  DaemonAlreadyRunningError,
} from '../../../core/v4/daemon/runtimeLock';

let tmpDir: string;
let lockPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-lock-'));
  lockPath = path.join(tmpDir, 'runtime.lock');
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('acquireRuntimeLock', () => {
  it('creates the lock file with instance + pid contents', () => {
    const lock = acquireRuntimeLock({ lockPath, instanceId: 'inst-1' });
    expect(fs.existsSync(lockPath)).toBe(true);
    const body = fs.readFileSync(lockPath, 'utf-8');
    expect(body).toMatch(/^inst-1\n/);
    expect(body).toMatch(new RegExp(`\\n${process.pid}\\n`));
    lock.release();
  });

  it('release removes the file (idempotent)', () => {
    const lock = acquireRuntimeLock({ lockPath, instanceId: 'i1' });
    lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
    // Second release is a no-op.
    expect(() => lock.release()).not.toThrow();
  });

  it('second acquire on live lock throws DaemonAlreadyRunningError', () => {
    const a = acquireRuntimeLock({ lockPath, instanceId: 'A', pid: process.pid });
    expect(() => acquireRuntimeLock({ lockPath, instanceId: 'B' }))
      .toThrow(DaemonAlreadyRunningError);
    a.release();
  });

  it('stale lock (dead PID) is auto-cleaned and re-acquired', () => {
    // Write a stale lock file claiming a non-existent PID.
    // PID 999999 is virtually certain to not exist on a test host.
    fs.writeFileSync(lockPath, `stale\n999999\n${Date.now()}\n`);
    const lock = acquireRuntimeLock({ lockPath, instanceId: 'new' });
    const body = fs.readFileSync(lockPath, 'utf-8');
    expect(body).toMatch(/^new\n/);
    lock.release();
  });

  it('lockPath is surfaced for diagnostics', () => {
    const lock = acquireRuntimeLock({ lockPath, instanceId: 'x' });
    expect(lock.lockPath).toBe(lockPath);
    lock.release();
  });
});
