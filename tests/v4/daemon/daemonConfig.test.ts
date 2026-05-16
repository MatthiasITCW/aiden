/**
 * v4.5 Phase 1 — daemonConfig env-var parsing tests.
 */
import { describe, it, expect } from 'vitest';
import { readDaemonConfig } from '../../../core/v4/daemon/daemonConfig';

function envWith(over: Record<string, string>): NodeJS.ProcessEnv {
  return { ...over } as NodeJS.ProcessEnv;
}

describe('readDaemonConfig — gating (Phase 1 strict opt-in)', () => {
  it('AIDEN_DAEMON unset: enabled=false', () => {
    expect(readDaemonConfig(envWith({})).enabled).toBe(false);
  });

  it('AIDEN_DAEMON=1: enabled=true', () => {
    expect(readDaemonConfig(envWith({ AIDEN_DAEMON: '1' })).enabled).toBe(true);
  });

  it('AIDEN_DAEMON=0: enabled=false', () => {
    expect(readDaemonConfig(envWith({ AIDEN_DAEMON: '0' })).enabled).toBe(false);
  });

  it('AIDEN_DAEMON=true: enabled=false (Phase 1 strict)', () => {
    expect(readDaemonConfig(envWith({ AIDEN_DAEMON: 'true' })).enabled).toBe(false);
  });
});

describe('readDaemonConfig — sub-flags', () => {
  it('port defaults to 4200', () => {
    expect(readDaemonConfig(envWith({})).port).toBe(4200);
  });

  it('AIDEN_DAEMON_PORT overrides', () => {
    expect(readDaemonConfig(envWith({ AIDEN_DAEMON_PORT: '5000' })).port).toBe(5000);
  });

  it('AIDEN_PORT used when AIDEN_DAEMON_PORT unset', () => {
    expect(readDaemonConfig(envWith({ AIDEN_PORT: '4100' })).port).toBe(4100);
  });

  it('AIDEN_DAEMON_AUTO_RESTART defaults to true', () => {
    expect(readDaemonConfig(envWith({})).autoRestart).toBe(true);
  });

  it('AIDEN_DAEMON_AUTO_RESTART=0 disables supervisor', () => {
    expect(readDaemonConfig(envWith({ AIDEN_DAEMON_AUTO_RESTART: '0' })).autoRestart).toBe(false);
  });

  it('drainTimeoutMs default 30000', () => {
    expect(readDaemonConfig(envWith({})).drainTimeoutMs).toBe(30_000);
  });

  it('AIDEN_DAEMON_DRAIN_TIMEOUT_MS pass-through', () => {
    expect(readDaemonConfig(envWith({ AIDEN_DAEMON_DRAIN_TIMEOUT_MS: '60000' })).drainTimeoutMs).toBe(60_000);
  });

  it('AIDEN_DAEMON_DRAIN_TIMEOUT_MS junk falls back', () => {
    expect(readDaemonConfig(envWith({ AIDEN_DAEMON_DRAIN_TIMEOUT_MS: 'oops' })).drainTimeoutMs).toBe(30_000);
  });

  it('restartFailureThreshold default 3', () => {
    expect(readDaemonConfig(envWith({})).restartFailureThreshold).toBe(3);
  });

  it('AIDEN_DAEMON_RESTART_FAILURE_THRESHOLD pass-through', () => {
    expect(readDaemonConfig(envWith({ AIDEN_DAEMON_RESTART_FAILURE_THRESHOLD: '5' })).restartFailureThreshold).toBe(5);
  });
});
