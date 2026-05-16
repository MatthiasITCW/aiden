/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/signals.ts — v4.5 Phase 1: signal handler installation.
 *
 * Installs SIGUSR1 → graceful restart (exit code 75) and
 * SIGTERM/SIGINT → graceful shutdown (exit code 0). All three
 * routes go through the same `performDrain` so cleanup ordering
 * stays uniform.
 *
 * SIGUSR1 is unavailable on Windows; the install is a no-op
 * there. The CLI's `aiden daemon restart` falls back to stop+start
 * sequentially on Windows.
 */

import { performDrain } from './drain';
import { DAEMON_RESTART_EXIT_CODE } from './restartCode';
import type { DrainContext } from './types';

let _installed = false;

export interface InstallSignalHandlersOptions {
  /** Resolver that produces a fresh DrainContext per signal. */
  getDrainContext: () => DrainContext;
  /** Whether to install SIGUSR1 (defaults to non-Windows). */
  installRestartSignal?: boolean;
}

export function installDaemonSignalHandlers(opts: InstallSignalHandlersOptions): void {
  if (_installed) return;
  _installed = true;

  const supportsSIGUSR1 = opts.installRestartSignal ?? (process.platform !== 'win32');

  process.once('SIGTERM', () => {
    void performDrain({ ...opts.getDrainContext(), reason: 'sigterm', exitCode: 0 });
  });
  process.once('SIGINT', () => {
    void performDrain({ ...opts.getDrainContext(), reason: 'sigint',  exitCode: 0 });
  });
  if (supportsSIGUSR1) {
    process.once('SIGUSR1', () => {
      void performDrain({
        ...opts.getDrainContext(),
        reason:   'sigusr1_restart',
        exitCode: DAEMON_RESTART_EXIT_CODE,
      });
    });
  }
}

/** Test helper: rearm the installer guard. */
export function _resetDaemonSignalHandlersForTests(): void {
  _installed = false;
}
