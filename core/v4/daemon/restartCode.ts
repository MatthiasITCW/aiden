/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/restartCode.ts — v4.5 Phase 1: graceful-restart exit code.
 *
 * Single source of truth. THREE consumers must use the same value:
 *   1. The in-process drain handler (`drain.ts`) — passes this to
 *      `process.exit()` when the daemon is reloading via SIGUSR1.
 *   2. The systemd unit (`templates/systemd.service.template`) —
 *      `RestartForceExitStatus=75` triggers an immediate respawn
 *      regardless of `Restart=` mode.
 *   3. The launchd plist (`templates/launchd.plist.template`) —
 *      uses `KeepAlive.SuccessfulExit=false` which is launchd's
 *      analog (any non-zero exit triggers respawn; exit 0 does not).
 *
 * Value 75 == sysexits.h `EX_TEMPFAIL` — semantically "service
 * unavailable, retry later", matching what a service supervisor
 * should do.
 */

/**
 * Exit code used by `aiden daemon restart` and the SIGUSR1 handler
 * to signal "respawn me, graceful restart" to systemd / launchd /
 * the internal supervisor.
 */
export const DAEMON_RESTART_EXIT_CODE = 75;
