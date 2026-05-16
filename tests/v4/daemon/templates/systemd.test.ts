/**
 * v4.5 Phase 1 — systemd unit generator tests.
 */
import { describe, it, expect } from 'vitest';
import { generateSystemdUnit } from '../../../../core/v4/daemon/supervisor';
import { DAEMON_RESTART_EXIT_CODE } from '../../../../core/v4/daemon/restartCode';

describe('generateSystemdUnit', () => {
  it('contains the graceful-restart exit code', () => {
    const unit = generateSystemdUnit({
      nodeBin:        '/usr/bin/node',
      bundlePath:     '/home/user/aiden/dist-bundle/index.js',
      workingDir:     '/home/user',
      port:           4200,
      drainTimeoutMs: 30_000,
    });
    expect(unit).toContain(`RestartForceExitStatus=${DAEMON_RESTART_EXIT_CODE}`);
  });

  it('TimeoutStopSec = max(60, drainSec) + 30', () => {
    expect(generateSystemdUnit({
      nodeBin: 'node', bundlePath: 'b', workingDir: '/w', port: 1,
      drainTimeoutMs: 30_000,            // 30s → max(60, 30) = 60 → 90
    })).toContain('TimeoutStopSec=90');
    expect(generateSystemdUnit({
      nodeBin: 'node', bundlePath: 'b', workingDir: '/w', port: 1,
      drainTimeoutMs: 90_000,            // 90s → max(60, 90) = 90 → 120
    })).toContain('TimeoutStopSec=120');
    expect(generateSystemdUnit({
      nodeBin: 'node', bundlePath: 'b', workingDir: '/w', port: 1,
      drainTimeoutMs: 5_000,             // 5s → max(60, 5) = 60 → 90
    })).toContain('TimeoutStopSec=90');
  });

  it('sets ExecReload to send SIGUSR1', () => {
    const unit = generateSystemdUnit({
      nodeBin: 'node', bundlePath: 'b', workingDir: '/w', port: 1, drainTimeoutMs: 30_000,
    });
    expect(unit).toContain('ExecReload=/bin/kill -USR1 $MAINPID');
  });

  it('disables internal supervisor by setting AIDEN_DAEMON_AUTO_RESTART=0', () => {
    const unit = generateSystemdUnit({
      nodeBin: 'node', bundlePath: 'b', workingDir: '/w', port: 1, drainTimeoutMs: 30_000,
    });
    expect(unit).toContain('AIDEN_DAEMON_AUTO_RESTART=0');
  });

  it('renders ExecStart from node bin + bundle path', () => {
    const unit = generateSystemdUnit({
      nodeBin: '/usr/local/bin/node', bundlePath: '/opt/aiden/dist-bundle/index.js',
      workingDir: '/home/u', port: 4200, drainTimeoutMs: 30_000,
    });
    expect(unit).toContain('ExecStart=/usr/local/bin/node /opt/aiden/dist-bundle/index.js');
  });
});
