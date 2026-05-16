/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/supervisor.ts — v4.5 Phase 1: internal supervisor +
 * OS service template generators.
 *
 * Two-tier supervision strategy:
 *
 *   1. **OS service is the primary supervisor** wherever available.
 *      systemd (Linux), launchd (macOS), and third-party tools on
 *      Windows do this better than any in-process supervisor — they
 *      survive logout, integrate with reboots, and surface in OS
 *      tooling. `aiden daemon install` writes the appropriate unit
 *      via the template generators in this module.
 *
 *   2. **Internal supervisor is the fallback** for environments
 *      that lack an OS service manager OR where the user prefers to
 *      keep things simple. Parent process spawns the daemon child,
 *      watches for exits, and respawns with exponential backoff.
 *      Graceful-restart exit code (75) triggers immediate respawn
 *      without backoff.
 */

import { spawn, ChildProcess } from 'node:child_process';
import { DAEMON_RESTART_EXIT_CODE } from './restartCode';

// ── Internal supervisor ────────────────────────────────────────────────────

export interface SupervisorOptions {
  childCmd:           string[];
  cwd?:               string;
  env?:               Record<string, string>;
  backoff?: {
    initialMs?:       number;
    maxMs?:           number;
    multiplier?:      number;
    maxConsecutiveFailures?: number;
  };
  gracefulExitCodes?: number[];
  onChildExit?:       (code: number | null, signal: string | null) => void;
  onRespawn?:         (attempt: number, delayMs: number) => void;
  onGiveUp?:          (reason: string) => void;
  /** Drain timeout to forward to child on parent SIGTERM/SIGINT. */
  drainTimeoutMs?:    number;
}

export interface SupervisorHandle {
  stop(): Promise<void>;
  childPid(): number | null;
}

export function startSupervisor(opts: SupervisorOptions): SupervisorHandle {
  const initialMs   = opts.backoff?.initialMs   ?? 1000;
  const maxMs       = opts.backoff?.maxMs       ?? 60_000;
  const multiplier  = opts.backoff?.multiplier  ?? 2;
  const maxFailures = opts.backoff?.maxConsecutiveFailures ?? 5;
  const graceful    = new Set(opts.gracefulExitCodes ?? [DAEMON_RESTART_EXIT_CODE]);
  const drainGrace  = opts.drainTimeoutMs ?? 30_000;

  let child: ChildProcess | null = null;
  let consecutiveFailures = 0;
  let respawnTimer: NodeJS.Timeout | null = null;
  let stopping = false;
  let stopResolve: (() => void) | null = null;
  const stopPromise = new Promise<void>((res) => { stopResolve = res; });

  const respawn = (delayMs: number): void => {
    if (stopping) return;
    if (respawnTimer) return;
    opts.onRespawn?.(consecutiveFailures, delayMs);
    respawnTimer = setTimeout(() => {
      respawnTimer = null;
      launch();
    }, delayMs);
    if (typeof respawnTimer.unref === 'function') respawnTimer.unref();
  };

  const launch = (): void => {
    if (stopping) return;
    const cmd  = opts.childCmd[0];
    const args = opts.childCmd.slice(1);
    child = spawn(cmd, args, {
      cwd:    opts.cwd,
      env:    { ...process.env, ...(opts.env ?? {}) },
      stdio:  'inherit',
    });
    child.on('exit', (code, signal) => {
      opts.onChildExit?.(code, signal);
      const wasGraceful = code != null && graceful.has(code);
      if (stopping) {
        // We requested the stop; resolve the promise.
        stopResolve?.();
        return;
      }
      if (wasGraceful) {
        // Graceful restart — respawn immediately, no backoff.
        consecutiveFailures = 0;
        respawn(0);
        return;
      }
      consecutiveFailures += 1;
      if (consecutiveFailures >= maxFailures) {
        opts.onGiveUp?.(
          `Child exited ${consecutiveFailures} consecutive times (last: ` +
          `code=${code} signal=${signal}). Giving up.`,
        );
        stopping = true;
        stopResolve?.();
        return;
      }
      const delay = Math.min(maxMs, initialMs * Math.pow(multiplier, consecutiveFailures - 1));
      respawn(delay);
    });
    child.on('error', () => {
      // 'error' fires before 'exit' in spawn-failure cases. Let
      // 'exit' handle the backoff; just keep the supervisor alive.
    });
  };

  launch();

  return {
    async stop(): Promise<void> {
      if (stopping) return stopPromise;
      stopping = true;
      if (respawnTimer) {
        clearTimeout(respawnTimer);
        respawnTimer = null;
      }
      if (!child) {
        stopResolve?.();
        return stopPromise;
      }
      try { child.kill('SIGTERM'); } catch { /* noop */ }
      // Hard cap so a stuck child doesn't hang the supervisor.
      const killer = setTimeout(() => {
        try { child?.kill('SIGKILL'); } catch { /* noop */ }
      }, drainGrace + 5_000);
      if (typeof killer.unref === 'function') killer.unref();
      return stopPromise;
    },
    childPid(): number | null {
      return child?.pid ?? null;
    },
  };
}

// ── OS service template generators ─────────────────────────────────────────

export interface ServiceTemplateContext {
  /** Path to `node` (or equivalent runtime). */
  nodeBin:        string;
  /** Path to the Aiden bundle entry. */
  bundlePath:     string;
  /** Working directory the service starts in. */
  workingDir:     string;
  /** Daemon API port. */
  port:           number;
  /** Drain timeout in ms (used to size TimeoutStopSec / KillTimeout). */
  drainTimeoutMs: number;
  /** Extra environment variables. */
  env?:           Record<string, string>;
  /** Stdout/stderr destinations (launchd only). */
  stdoutPath?:    string;
  stderrPath?:    string;
  /** Captured user PATH for launchd. */
  userPath?:      string;
}

/**
 * Render a systemd user-unit suitable for
 * `~/.config/systemd/user/aiden.service`.
 *
 * Key invariants:
 *   - `RestartForceExitStatus=75` triggers an immediate respawn on
 *     the daemon's graceful-restart exit code.
 *   - `TimeoutStopSec = max(60, ceil(drainTimeoutMs/1000)) + 30` so
 *     post-interrupt cleanup has headroom beyond the drain. Without
 *     this, the cgroup SIGKILLs in-flight tool subprocesses and
 *     attribution is lost.
 *   - `ExecReload=/bin/kill -USR1 $MAINPID` lets `aiden daemon
 *     restart` (or `systemctl --user reload aiden`) trigger a
 *     drain-aware graceful restart.
 */
export function generateSystemdUnit(ctx: ServiceTemplateContext): string {
  const drainSec = Math.max(60, Math.ceil(ctx.drainTimeoutMs / 1000));
  const stopSec  = drainSec + 30;
  const envLines = Object.entries({
    AIDEN_DAEMON: '1',
    AIDEN_PORT:   String(ctx.port),
    AIDEN_DAEMON_AUTO_RESTART: '0',  // OS-service primary; disable internal supervisor
    ...(ctx.env ?? {}),
  }).map(([k, v]) => `Environment="${k}=${v}"`).join('\n');
  return `[Unit]
Description=Aiden local-first AI agent (daemon mode)
After=network.target

[Service]
Type=simple
ExecStart=${ctx.nodeBin} ${ctx.bundlePath}
WorkingDirectory=${ctx.workingDir}
${envLines}
Restart=always
RestartSec=60
RestartMaxDelaySec=300
RestartSteps=5
RestartForceExitStatus=${DAEMON_RESTART_EXIT_CODE}
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=${stopSec}
ExecReload=/bin/kill -USR1 $MAINPID

[Install]
WantedBy=default.target
`;
}

/**
 * Render a launchd plist for
 * `~/Library/LaunchAgents/com.aiden.daemon.plist`.
 *
 * `KeepAlive.SuccessfulExit=false` is the launchd analog of
 * systemd's `RestartForceExitStatus=75`: respawn on ANY non-zero
 * exit; do not respawn on exit 0. The graceful-restart path
 * always exits with 75, which is non-zero, so the daemon respawns
 * automatically.
 *
 * `userPath` should be the captured login-shell PATH so Homebrew /
 * nvm / cargo / etc. are reachable.
 */
export function generateLaunchdPlist(ctx: ServiceTemplateContext): string {
  const envEntries: Array<[string, string]> = Object.entries({
    AIDEN_DAEMON: '1',
    AIDEN_PORT:   String(ctx.port),
    AIDEN_DAEMON_AUTO_RESTART: '0',
    ...(ctx.userPath ? { PATH: ctx.userPath } : {}),
    ...(ctx.env ?? {}),
  });
  const envXml = envEntries
    .map(([k, v]) => `    <key>${escapeXml(k)}</key>\n    <string>${escapeXml(v)}</string>`)
    .join('\n');
  const stdoutXml = ctx.stdoutPath
    ? `  <key>StandardOutPath</key>\n  <string>${escapeXml(ctx.stdoutPath)}</string>\n`
    : '';
  const stderrXml = ctx.stderrPath
    ? `  <key>StandardErrorPath</key>\n  <string>${escapeXml(ctx.stderrPath)}</string>\n`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.aiden.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(ctx.nodeBin)}</string>
    <string>${escapeXml(ctx.bundlePath)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>WorkingDirectory</key>
  <string>${escapeXml(ctx.workingDir)}</string>
${stdoutXml}${stderrXml}</dict>
</plist>
`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ── Windows guidance (docs-only) ───────────────────────────────────────────

/**
 * Phase 1 deliberately does NOT auto-generate Scheduled Task /
 * Windows Service entries. NSSM/SCM variance + admin requirements
 * make an automatic installer too risky for the v4.5 ship. The CLI
 * `aiden daemon install` on Windows prints this guidance and exits
 * with code 0 without writing anything.
 */
export function windowsServiceGuidance(): string {
  return [
    'Aiden v4.5 does not auto-install a Windows service in Phase 1.',
    '',
    'Recommended approaches:',
    '  - Foreground:     aiden daemon start',
    '                    (the internal supervisor keeps the daemon running',
    '                    until you close the terminal)',
    '  - Background:     Use a third-party supervisor like `pm2` or `nssm`.',
    '                    Example with pm2:',
    '                      npm install -g pm2',
    '                      pm2 start aiden -- daemon start',
    '                      pm2 save && pm2 startup',
    '',
    'See docs/v4.5/daemon-windows.md for details.',
  ].join('\n');
}
