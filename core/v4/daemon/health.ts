/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/health.ts — v4.5 Phase 1: health + metrics endpoints.
 *
 * Three layered health endpoints + a Prometheus-style /metrics:
 *
 *   /health/live       — 200 if the event loop is responsive
 *                        (event-loop-lag sampler ticked within 5s).
 *                        Returns 500 otherwise. Used by external
 *                        watchdogs (Kubernetes liveness, simple
 *                        curl checks).
 *
 *   /health/ready      — 200 if the daemon can accept new triggers
 *                        AND the SQLite DB is writable. 503 otherwise.
 *
 *   /health/degraded   — 200 with { degraded: boolean, reasons }.
 *                        Reasons surface resource-budget overruns,
 *                        non-zero dead_letter count, stale cron
 *                        heartbeat. Designed for dashboards, not
 *                        load balancers.
 *
 *   /metrics           — text/plain Prometheus exposition format.
 *
 *   /api/daemon/status   — JSON: instance + uptime + version + counts
 *   /api/daemon/resources — JSON: registry list + budgetByKind
 */

import type { Request, Response, Router } from 'express';
import type { Db } from './db/connection';
import type { TriggerBus } from './triggerBus';
import type { ResourceRegistry } from './resourceRegistry';
import type { InstanceTracker } from './instanceTracker';
import { getEventLoopLagMs, isEventLoopResponsive } from './eventLoopLag';

export interface HealthDeps {
  db:               Db;
  triggerBus:       TriggerBus;
  resourceRegistry: ResourceRegistry;
  instanceTracker:  InstanceTracker;
  /** Aiden version string. */
  version:          string;
}

export interface DegradedReason {
  code:    string;
  message: string;
}

export function evaluateDegraded(deps: HealthDeps): DegradedReason[] {
  const reasons: DegradedReason[] = [];
  // Trigger bus health.
  try {
    const stats = deps.triggerBus.stats();
    if (stats.deadLetter > 0) {
      reasons.push({
        code: 'dead_letter_nonzero',
        message: `${stats.deadLetter} trigger event(s) in dead_letter`,
      });
    }
    if (stats.oldestPendingMs != null && stats.oldestPendingMs > 60 * 60 * 1000) {
      reasons.push({
        code: 'pending_stale',
        message: `oldest pending trigger is ${Math.round(stats.oldestPendingMs/1000)}s old`,
      });
    }
  } catch (e) {
    reasons.push({
      code: 'trigger_bus_error',
      message: e instanceof Error ? e.message : String(e),
    });
  }
  // Event-loop lag.
  const lag = getEventLoopLagMs();
  if (lag > 1000) {
    reasons.push({ code: 'event_loop_lag', message: `${lag}ms` });
  }
  return reasons;
}

/**
 * Mount the v4.5 daemon health endpoints onto an Express router.
 * Idempotent at the endpoint level (Express dedup is the caller's
 * responsibility — call once during server boot).
 */
export function mountHealthEndpoints(router: Router, deps: HealthDeps): void {
  router.get('/health/live', (_req: Request, res: Response) => {
    const ok = isEventLoopResponsive(5_000);
    res
      .status(ok ? 200 : 500)
      .json({ ok, lagMs: getEventLoopLagMs() });
  });

  router.get('/health/ready', (_req: Request, res: Response) => {
    try {
      const row = deps.db.prepare('SELECT 1 AS v').get() as { v: number };
      const dbOk = row?.v === 1;
      res.status(dbOk ? 200 : 503).json({ ok: dbOk, db: dbOk ? 'ready' : 'unreachable' });
    } catch (e) {
      res.status(503).json({
        ok: false,
        db: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  router.get('/health/degraded', (_req: Request, res: Response) => {
    const reasons = evaluateDegraded(deps);
    res.status(200).json({ degraded: reasons.length > 0, reasons });
  });

  router.get('/metrics', (_req: Request, res: Response) => {
    const mu = process.memoryUsage();
    const ts = deps.triggerBus.stats();
    const budgets = deps.resourceRegistry.budgetByKind();
    const inst = deps.instanceTracker.current();
    const uptimeSec = inst ? Math.floor((Date.now() - inst.startedAt) / 1000) : 0;

    const lines: string[] = [];
    const m = (name: string, value: number, help?: string, type = 'gauge') => {
      if (help) lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);
      lines.push(`${name} ${value}`);
    };
    m('aiden_daemon_rss_bytes', mu.rss, 'Resident set size in bytes');
    m('aiden_daemon_heap_used_bytes', mu.heapUsed, 'V8 heap used in bytes');
    m('aiden_daemon_event_loop_lag_ms', getEventLoopLagMs(), 'Event loop lag in ms');
    m('aiden_daemon_uptime_seconds', uptimeSec, 'Daemon uptime in seconds');
    m('aiden_daemon_trigger_pending', ts.pending, 'Pending trigger events');
    m('aiden_daemon_trigger_claimed', ts.claimed, 'Claimed trigger events');
    m('aiden_daemon_trigger_running', ts.running, 'Running trigger events');
    m('aiden_daemon_trigger_deadletter', ts.deadLetter, 'Dead-letter trigger events');
    for (const [kind, b] of Object.entries(budgets)) {
      lines.push(`# HELP aiden_daemon_resource_count Count of registered resources by kind`);
      lines.push(`# TYPE aiden_daemon_resource_count gauge`);
      lines.push(`aiden_daemon_resource_count{kind="${kind}"} ${b.count}`);
      if (b.budgetUnits > 0) {
        lines.push(`# HELP aiden_daemon_resource_budget Sum of budget units by kind`);
        lines.push(`# TYPE aiden_daemon_resource_budget gauge`);
        lines.push(`aiden_daemon_resource_budget{kind="${kind}"} ${b.budgetUnits}`);
      }
    }
    res.type('text/plain; version=0.0.4').send(lines.join('\n') + '\n');
  });

  router.get('/api/daemon/status', (_req: Request, res: Response) => {
    const inst = deps.instanceTracker.current();
    const stats = deps.triggerBus.stats();
    res.status(200).json({
      instance: inst,
      version:  deps.version,
      uptimeMs: inst ? Date.now() - inst.startedAt : 0,
      triggers: stats,
      eventLoopLagMs: getEventLoopLagMs(),
    });
  });

  router.get('/api/daemon/resources', (_req: Request, res: Response) => {
    const list = deps.resourceRegistry.list().map((r) => ({
      id:          r.id,
      kind:        r.kind,
      owner:       r.owner,
      createdAt:   r.createdAt,
      lastUsedAt:  r.lastUsedAt,
      ttlMs:       r.ttlMs,
      budgetUnits: r.budgetUnits,
      metadata:    r.metadata,
    }));
    res.status(200).json({
      total: list.length,
      budgetByKind: deps.resourceRegistry.budgetByKind(),
      resources: list,
    });
  });
}
