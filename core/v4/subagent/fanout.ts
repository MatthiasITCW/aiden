/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/subagent/fanout.ts — Phase v4.1-subagent
 *
 * Parallel-agent orchestrator. Spawn N children against the same
 * problem (or a partition), enforce per-child timeouts and an outer
 * wall-clock cap, then merge results via the chosen strategy.
 *
 * Design constraints (locked from recon):
 *
 *   - In-process `Promise.all` over N children. No child processes,
 *     no MCP-spawn (Aiden's MCP server is for external clients).
 *   - Per-child AbortSignal derived from a parent signal + timeout.
 *     Aborts cascade — parent abort kills every child mid-flight via
 *     the provider's own HTTP AbortController.
 *   - Each child gets:
 *       * own session ID (UUID) — sessions never collide
 *       * own provider rotation slot
 *       * own cloned FallbackAdapter when applicable (mutable rate-
 *         limit state isolated per child)
 *       * fresh max_iterations (no v3-style budget halving)
 *   - Shared (read-only) across children:
 *       * tool registry, skill loader, paths, memoryManager
 *
 * Hot blockers from the recon are addressed by the caller:
 *   - browser bridge: caller wraps browser tool dispatch in
 *     `withPwLock` (see core/playwrightBridge.ts)
 *   - approval engine: caller passes a ToolContext with
 *     `approvalEngine` undefined (no prompts in subagents)
 *   - destructive tool exposure: caller filters the schemas array
 *     based on `AIDEN_SUBAGENT_ALLOW_DESTRUCTIVE`
 *
 * The orchestrator itself is INTENTIONALLY decoupled from
 * AidenAgent — it takes a `runChild` callback that knows how to run
 * one subagent. The tool wrapper at tools/v4/subagent/subagentFanout
 * supplies the production callback (which constructs an AidenAgent);
 * tests inject a stub that returns canned strings without any
 * provider plumbing. This is what made the offline smoke tractable.
 */

import { randomUUID } from 'node:crypto';

import type { Logger } from '../logger/logger';
import { noopLogger } from '../logger/factory';
import {
  resolveBudget,
  validateN,
  type SubagentBudget,
} from './budget';
import {
  rotateProviders,
  type ProviderOption,
} from './providerRotation';
import {
  mergeResults,
  type MergeStrategy,
  type SubagentResult,
  type MergeOptions,
} from './merger';
import { AIDEN_SUBAGENT_BUILD, type FanoutDiagnostics } from './diagnostics';

// ── Public types ─────────────────────────────────────────────────────────

/** One unit of work for partition mode. */
export interface PartitionTask {
  goal: string;
  context?: string;
  /** Optional role tag for diagnostics + prompt context. */
  role?: string;
}

export type FanoutMode = 'partition' | 'ensemble';

/** Per-child runner — supplied by the caller. Production wraps an
 *  AidenAgent; tests inject a stub. The runner MUST honour `signal`
 *  and resolve with the final assistant text. Errors thrown become
 *  `error` on the result. */
export interface RunChildArgs {
  index: number;
  /** For ensemble mode this is the same query for every child;
   *  for partition mode it's the per-task `goal + context`. */
  prompt: string;
  /** Tag for diagnostics / role-coloured prompts. */
  role?: string;
  provider: ProviderOption;
  signal: AbortSignal;
  /** Per-child iteration cap. */
  maxIterations: number;
  /** Per-child Logger scope. */
  logger: Logger;
}

export type RunChildFn = (args: RunChildArgs) => Promise<string>;

export interface FanoutOptions {
  mode: FanoutMode;
  /** Same query for every child (ensemble mode). Required when
   *  `mode === 'ensemble'`. */
  query?: string;
  /** Per-child task list (partition mode). Required when
   *  `mode === 'partition'`; length must equal `n`. */
  tasks?: PartitionTask[];
  /** Number of children to spawn. Validated against MAX_FANOUT_N. */
  n: number;
  merge: MergeStrategy;
  /** Available provider options for rotation. */
  providers: ProviderOption[];
  /** Per-child runner. */
  runChild: RunChildFn;
  /** Aggregator adapter — supplied by the caller. Same shape as the
   *  parent's adapter. Used only when `merge !== 'all'`. */
  aggregatorAdapter: MergeOptions['aggregatorAdapter'];
  aggregatorModel:   MergeOptions['aggregatorModel'];
  /** Override per-child timeout. */
  timeoutMs?: number;
  /** Parent abort — cascades to all children. */
  parentAbort?: AbortSignal;
  logger?: Logger;
  /** Wall clock for tests. Defaults to Date.now. */
  now?: () => number;
}

export interface FanoutResult {
  results: SubagentResult[];
  merged:  string | null;
  diagnostics: FanoutDiagnostics;
}

// ── Orchestrator ─────────────────────────────────────────────────────────

export async function runFanout(opts: FanoutOptions): Promise<FanoutResult> {
  const logger = (opts.logger ?? noopLogger()).child('subagent');
  const now    = opts.now ?? Date.now;

  // ── Pre-flight validation ─────────────────────────────────────
  validateN(opts.n);
  if (opts.mode === 'ensemble' && !opts.query) {
    throw new Error('subagent_fanout: ensemble mode requires a `query`');
  }
  if (opts.mode === 'partition') {
    if (!opts.tasks || opts.tasks.length === 0) {
      throw new Error('subagent_fanout: partition mode requires `tasks[]`');
    }
    if (opts.tasks.length !== opts.n) {
      throw new Error(
        `subagent_fanout: partition tasks.length (${opts.tasks.length}) ` +
        `must equal n (${opts.n})`,
      );
    }
  }
  if (opts.providers.length === 0) {
    throw new Error('subagent_fanout: no providers available — cannot fan out');
  }

  const budget: SubagentBudget = resolveBudget({ timeoutMs: opts.timeoutMs });
  const rotation = rotateProviders(opts.n, opts.providers);

  if (rotation.singleProviderWarning) {
    logger.warn('subagent_fanout: single-provider fanout — diversity ≈ temperature variation', {
      providers: opts.providers.length,
      n:         opts.n,
    });
  }

  logger.info('subagent_fanout: launching', {
    build:               AIDEN_SUBAGENT_BUILD,
    mode:                opts.mode,
    n:                   opts.n,
    merge:               opts.merge,
    perSubagentTimeoutMs: budget.perSubagentTimeoutMs,
    wallClockCapMs:      budget.wallClockCapMs,
  });

  // ── Spawn ─────────────────────────────────────────────────────
  const startedAt = now();
  const wallController = new AbortController();
  const wallTimer = setTimeout(() => wallController.abort(),
    budget.wallClockCapMs);
  // Forward parent abort to the wall controller so it cascades.
  const parentAbortHandler = () => wallController.abort();
  if (opts.parentAbort) {
    if (opts.parentAbort.aborted) wallController.abort();
    else opts.parentAbort.addEventListener('abort', parentAbortHandler, { once: true });
  }

  const children: Array<Promise<SubagentResult>> = [];
  for (let i = 0; i < opts.n; i += 1) {
    const provider = rotation.assignments[i]!;
    const prompt = opts.mode === 'ensemble'
      ? opts.query!
      : buildPartitionPrompt(opts.tasks![i]!);
    const role = opts.mode === 'partition' ? opts.tasks![i]!.role : undefined;
    children.push(spawnOne({
      index:       i,
      prompt,
      role,
      provider,
      maxIterations: budget.maxIterations,
      perTimeoutMs:  budget.perSubagentTimeoutMs,
      wallSignal:    wallController.signal,
      runChild:      opts.runChild,
      logger:        logger.child(`#${i}:${provider.providerId}`),
      now,
    }));
  }

  const results = await Promise.all(children);
  clearTimeout(wallTimer);
  if (opts.parentAbort) {
    opts.parentAbort.removeEventListener('abort', parentAbortHandler);
  }

  const totalMs = now() - startedAt;

  // ── Merge ─────────────────────────────────────────────────────
  const merge = await mergeResults(results, {
    strategy:          opts.merge,
    aggregatorAdapter: opts.aggregatorAdapter,
    aggregatorModel:   opts.aggregatorModel,
    userQuery:         opts.mode === 'ensemble'
      ? opts.query!
      : opts.tasks!.map((t, i) => `(${i + 1}) ${t.goal}`).join('\n'),
    logger,
    signal: wallController.signal,
  });

  // ── Diagnostics ───────────────────────────────────────────────
  const diagnostics: FanoutDiagnostics = {
    build:                 AIDEN_SUBAGENT_BUILD,
    launched:              opts.n,
    succeeded:             results.filter((r) => !r.error && r.output.length > 0).length,
    failed:                results.filter((r) => !!r.error || r.output.length === 0).length,
    totalMs,
    perSubagentMs:         results.map((r) => r.elapsedMs),
    providerDistribution:  results.map((r) => r.providerId),
    singleProviderWarning: rotation.singleProviderWarning,
    aggregator:            merge.aggregator,
  };

  logger.info('subagent_fanout: complete', {
    succeeded: diagnostics.succeeded,
    failed:    diagnostics.failed,
    totalMs,
    aggregator: merge.aggregator || '(none)',
  });

  return { results, merged: merge.merged, diagnostics };
}

// ── Internals ────────────────────────────────────────────────────────────

interface SpawnOneArgs {
  index:           number;
  prompt:          string;
  role?:           string;
  provider:        ProviderOption;
  maxIterations:   number;
  perTimeoutMs:    number;
  wallSignal:      AbortSignal;
  runChild:        RunChildFn;
  logger:          Logger;
  now:             () => number;
}

async function spawnOne(args: SpawnOneArgs): Promise<SubagentResult> {
  const startedAt = args.now();
  // Per-child controller, aborted on wall-cap OR per-child timeout.
  const childController = new AbortController();
  const timer = setTimeout(() => childController.abort(),
    args.perTimeoutMs);
  const wallHandler = () => childController.abort();
  if (args.wallSignal.aborted) childController.abort();
  else args.wallSignal.addEventListener('abort', wallHandler, { once: true });

  const id = randomUUID();
  args.logger.info('child: spawned', {
    id,
    provider: `${args.provider.providerId}:${args.provider.modelId}`,
    role:     args.role,
    timeoutMs: args.perTimeoutMs,
  });

  let output = '';
  let error:  string | undefined;
  try {
    output = await args.runChild({
      index:         args.index,
      prompt:        args.prompt,
      role:          args.role,
      provider:      args.provider,
      signal:        childController.signal,
      maxIterations: args.maxIterations,
      logger:        args.logger,
    });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    if (childController.signal.aborted) {
      error = `aborted (timeout=${args.perTimeoutMs}ms or parent abort): ${error}`;
    }
    args.logger.warn('child: errored', { error });
  } finally {
    clearTimeout(timer);
    args.wallSignal.removeEventListener('abort', wallHandler);
  }

  const elapsedMs = args.now() - startedAt;
  args.logger.info('child: done', { elapsedMs, ok: !error && output.length > 0 });

  return {
    index:      args.index,
    providerId: args.provider.providerId,
    modelId:    args.provider.modelId,
    output:     error ? '' : output,
    error,
    elapsedMs,
  };
}

function buildPartitionPrompt(task: PartitionTask): string {
  const role = task.role ? `Role: ${task.role}\n` : '';
  const context = task.context ? `\nContext:\n${task.context}\n` : '';
  return `${role}Goal: ${task.goal}${context}`;
}
