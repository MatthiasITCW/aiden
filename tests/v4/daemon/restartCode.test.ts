/**
 * v4.5 Phase 1 — DAEMON_RESTART_EXIT_CODE sentinel.
 */
import { describe, it, expect } from 'vitest';
import { DAEMON_RESTART_EXIT_CODE } from '../../../core/v4/daemon/restartCode';

describe('DAEMON_RESTART_EXIT_CODE', () => {
  it('is sysexits EX_TEMPFAIL (75)', () => {
    expect(DAEMON_RESTART_EXIT_CODE).toBe(75);
  });

  it('is a number type literal — drives systemd RestartForceExitStatus + launchd KeepAlive.SuccessfulExit semantics', () => {
    expect(typeof DAEMON_RESTART_EXIT_CODE).toBe('number');
  });
});
