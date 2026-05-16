/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/instanceTracker.ts — v4.5 Phase 1: daemon_instances writer.
 *
 * Writes the current process's identity into the `daemon_instances`
 * table, updates `last_heartbeat` every 5s, and marks `shutdown_at`
 * + `shutdown_reason` + `exit_code` on graceful exit.
 *
 * Crash detection — a row whose `shutdown_at IS NULL` and whose
 * `last_heartbeat` is older than 30s on the NEXT daemon's boot is a
 * crash candidate. `cleanShutdown.ts` evaluates this on boot.
 */

import { randomUUID } from 'node:crypto';
import type { Db } from './db/connection';
import type { ShutdownReason, DaemonInstanceRow } from './types';
import type { DaemonInstanceRowSql } from './db/schema/v1.spec';
import { getHostname } from './daemonConfig';

const HEARTBEAT_INTERVAL_MS = 5_000;

export interface InstanceTracker {
  readonly instanceId: string;
  /** Begin heartbeat updates. Idempotent. */
  start(): void;
  /** Stop heartbeat. Idempotent. */
  stop(): void;
  /** Mark this instance as shutting down — sets the row's reason. */
  markShuttingDown(reason: ShutdownReason): void;
  /** Final state — sets shutdown_at, shutdown_reason, exit_code. */
  markShutdown(reason: ShutdownReason, exitCode: number): void;
  /** Read the current instance row (diagnostic). */
  current(): DaemonInstanceRow | null;
}

function rowToTs(r: DaemonInstanceRowSql): DaemonInstanceRow {
  return {
    instanceId:     r.instance_id,
    pid:            r.pid,
    hostname:       r.hostname,
    startedAt:      r.started_at,
    lastHeartbeat:  r.last_heartbeat,
    shutdownAt:     r.shutdown_at,
    shutdownReason: r.shutdown_reason as ShutdownReason | null,
    exitCode:       r.exit_code,
    version:        r.version,
  };
}

export interface CreateInstanceTrackerOptions {
  db:         Db;
  instanceId?: string;
  pid?:        number;
  version:     string;
  /** Heartbeat interval override (tests use a smaller value). */
  heartbeatIntervalMs?: number;
}

export function createInstanceTracker(opts: CreateInstanceTrackerOptions): InstanceTracker {
  const instanceId = opts.instanceId ?? randomUUID();
  const pid        = opts.pid        ?? process.pid;
  const hostname   = getHostname();
  const startedAt  = Date.now();
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;

  opts.db
    .prepare(
      `INSERT INTO daemon_instances
        (instance_id, pid, hostname, started_at, last_heartbeat, version)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(instanceId, pid, hostname, startedAt, startedAt, opts.version);

  let timer: NodeJS.Timeout | null = null;

  const beat = (): void => {
    try {
      opts.db
        .prepare(
          'UPDATE daemon_instances SET last_heartbeat = ? WHERE instance_id = ?',
        )
        .run(Date.now(), instanceId);
    } catch { /* never crash the daemon on a heartbeat write failure */ }
  };

  return {
    instanceId,
    start(): void {
      if (timer) return;
      timer = setInterval(beat, heartbeatIntervalMs);
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop(): void {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    markShuttingDown(reason: ShutdownReason): void {
      try {
        opts.db
          .prepare(
            'UPDATE daemon_instances SET shutdown_reason = ? WHERE instance_id = ?',
          )
          .run(reason, instanceId);
      } catch { /* best-effort */ }
    },
    markShutdown(reason: ShutdownReason, exitCode: number): void {
      try {
        opts.db
          .prepare(
            `UPDATE daemon_instances
                SET shutdown_at     = ?,
                    shutdown_reason = ?,
                    exit_code       = ?
              WHERE instance_id = ?`,
          )
          .run(Date.now(), reason, exitCode, instanceId);
      } catch { /* best-effort */ }
    },
    current(): DaemonInstanceRow | null {
      const r = opts.db
        .prepare('SELECT * FROM daemon_instances WHERE instance_id = ?')
        .get(instanceId) as DaemonInstanceRowSql | undefined;
      return r ? rowToTs(r) : null;
    },
  };
}
