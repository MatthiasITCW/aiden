/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/skillMining/skillMiner.ts — Phase v4.1-skill-mining
 *
 * Orchestrator for the skill-mining post-turn observation. Sits next
 * to `moat/skillTeacher.ts:observeTurn` in the agent loop hook
 * (`core/v4/aidenAgent.ts:440-468`); the two are complementary.
 * SkillTeacher proposes inline (immediate accept/reject); SkillMiner
 * stages a candidate for `/skills review` so the user can audit
 * before any disk-mutation lands in the live skills directory.
 *
 * Programmatic gates (in order — first failure short-circuits):
 *   1. trace length < 3                        → skip
 *   2. any tool errored                        → skip
 *   3. finishReason !== 'stop'                 → skip
 *   4. session candidate count >= SESSION_SKILL_LIMIT → skip
 *   5. user opt-out phrase in conversation     → skip (reuse OPT_OUT_RE)
 *   6. fingerprint matches pending candidate   → skip (dedup)
 *   7. fingerprint matches rejected list       → skip (dedup)
 *
 * Pass-through pipeline:
 *   - compute confidence score from programmatic features
 *   - draft skeleton via proposalBuilder
 *   - refine via extractorPrompt (best-effort; falls back to
 *     skeleton)
 *   - validate via parseSkillContent round-trip
 *   - append to candidateStore
 *   - return ObservationResult so chatSession can notify
 *
 * MCP serve mode: caller (aidenAgent) MUST gate on
 * !isMcpServeMode() before invoking observeTurn — the mining
 * subsystem itself doesn't write to stdout but a candidate
 * notification would, and serve mode owns stdout for JSON-RPC.
 */

import { randomUUID } from 'node:crypto';

import type { Message } from '../../../providers/v4/types';
import type { AuxiliaryClient } from '../auxiliaryClient';
import { parseSkillContent } from '../skillSpec';
import { CandidateStore, type MinedCandidate } from './candidateStore';
import { traceFingerprint, type FingerprintEntry } from './traceFingerprint';
import { draft as buildSkeleton, type ProposalContext, type ProposalTraceEntry } from './proposalBuilder';
import { refine } from './extractorPrompt';

/** Per-session candidate cap — port from v3's `SESSION_SKILL_LIMIT`. */
export const SESSION_SKILL_LIMIT = 2;

/** Minimum trace length to consider mining at all. */
const MIN_TRACE_LENGTH = 3;

/**
 * Opt-out phrases that suppress mining for the current turn. Match
 * the SkillTeacher pattern at `moat/skillTeacher.ts:110` so a user
 * who silences SkillTeacher also silences mining.
 */
const OPT_OUT_RE =
  /\b(stop|don['']?t|no|never)\s+(suggest|propose|create|save|learn|remember)\w*\b/i;

export type SkillMinerFinishReason = 'stop' | 'abort' | 'error' | 'cap' | string;

export interface SkillMinerObservation {
  trace:           ProposalTraceEntry[];
  sessionId:       string;
  /** Index of the turn within the session (0-based). */
  sourceTurnIdx:   number;
  finishReason:    SkillMinerFinishReason;
  /** Conversation history up through this turn. Used for opt-out scan + first-user-prompt. */
  history:         readonly Message[];
}

export interface SkillMinerOutcome {
  /** Reason the miner short-circuited, or 'queued' if a candidate landed. */
  status:
    | 'queued'
    | 'short-trace'
    | 'tool-error'
    | 'abort'
    | 'session-cap'
    | 'opt-out'
    | 'dedup-pending'
    | 'dedup-rejected'
    | 'invalid-skill'
    | 'guard-mcp';
  /** Populated when status === 'queued'. */
  candidate?: MinedCandidate;
  /** Confidence score 0..1 (always populated for diagnostics). */
  confidence?: number;
}

export interface SkillMinerOptions {
  store?:           CandidateStore;
  auxiliaryClient?: AuxiliaryClient;
  /** Per-session cap override; defaults to SESSION_SKILL_LIMIT. */
  sessionCap?:      number;
  /** Skip the LLM refinement pass entirely (skeleton-only). */
  skeletonOnly?:    boolean;
}

/**
 * Compute a 0..1 confidence score from programmatic trace features.
 * Used to sort `/skills review` so the most promising candidates
 * surface first.
 *
 * Components:
 *   - lengthScore : trace length sweet spot is 5..15 (peaks at 10)
 *   - errorRate   : already gated to 0 (no errors in trace) but the
 *                   feature is computed for forward-compat with
 *                   future "soft" mining that admits some errors
 *   - distinctSet : more distinct tools = more reusable workflow
 *   - distinctTools: simple toolset diversity
 */
export function computeConfidence(trace: ProposalTraceEntry[]): number {
  if (trace.length === 0) return 0;
  // Length score — peaks at 10, falls off at extremes.
  const len = trace.length;
  const lengthScore =
    len < 3 ? 0 :
    len <= 10 ? len / 10 :
    len <= 15 ? 1 - (len - 10) * 0.04 :
    Math.max(0.4, 1 - (len - 10) * 0.05);

  // Error rate (0 = best, 1 = worst).
  const errors = trace.filter((e) => e.error != null).length;
  const errorRate = errors / trace.length;

  // Distinct tool diversity.
  const distinctTools = new Set(trace.map((e) => e.name)).size;
  const diversityScore = Math.min(1, distinctTools / 4);

  // Distinct toolsets diversity (some traces tag entries).
  const distinctSets = new Set(
    trace.map((e) => e.toolset ?? '').filter(Boolean),
  ).size;
  const setBonus = Math.min(0.2, distinctSets * 0.1);

  // Weighted average — length and diversity dominate, error penalty
  // proportional to rate.
  const raw = 0.55 * lengthScore + 0.35 * diversityScore + setBonus - errorRate;
  return Math.max(0, Math.min(1, Number(raw.toFixed(3))));
}

/** Single-trace orchestrator. Stateless except for the per-session counter. */
export class SkillMiner {
  private readonly store: CandidateStore;
  private readonly auxiliaryClient?: AuxiliaryClient;
  private readonly sessionCap: number;
  private readonly skeletonOnly: boolean;
  private readonly perSessionCount = new Map<string, number>();

  constructor(opts: SkillMinerOptions = {}) {
    this.store           = opts.store           ?? new CandidateStore();
    this.auxiliaryClient = opts.auxiliaryClient;
    this.sessionCap      = opts.sessionCap      ?? SESSION_SKILL_LIMIT;
    this.skeletonOnly    = opts.skeletonOnly    ?? false;
  }

  /** Test/reset hook. */
  _resetForTests(): void {
    this.perSessionCount.clear();
  }

  /** Returns the count of pending candidates already attributed to a session. */
  countForSession(sessionId: string): number {
    return this.perSessionCount.get(sessionId) ?? 0;
  }

  async observeTurn(obs: SkillMinerObservation): Promise<SkillMinerOutcome> {
    // Gate 1 — short trace.
    if (!obs.trace || obs.trace.length < MIN_TRACE_LENGTH) {
      return { status: 'short-trace' };
    }
    // Gate 2 — any tool errored.
    if (obs.trace.some((e) => e.error != null)) {
      return { status: 'tool-error' };
    }
    // Gate 3 — turn was aborted.
    if (obs.finishReason !== 'stop') {
      return { status: 'abort' };
    }
    // Gate 4 — session cap.
    if (this.countForSession(obs.sessionId) >= this.sessionCap) {
      return { status: 'session-cap' };
    }
    // Gate 5 — user opt-out anywhere in this turn's conversation.
    for (const msg of obs.history) {
      if (msg.role === 'user' && typeof msg.content === 'string' && OPT_OUT_RE.test(msg.content)) {
        return { status: 'opt-out' };
      }
    }

    // Fingerprint + dedup.
    const fpEntries: FingerprintEntry[] = obs.trace.map((e) => ({ name: e.name, args: e.args }));
    const fingerprint = traceFingerprint(fpEntries);
    const pending = await this.store.list();
    if (pending.some((c) => c.fingerprint === fingerprint)) {
      return { status: 'dedup-pending' };
    }
    const rejected = await this.store.loadRejected();
    if (rejected.has(fingerprint)) {
      return { status: 'dedup-rejected' };
    }

    // Compute confidence + first user prompt for skeleton seeding.
    const confidence = computeConfidence(obs.trace);
    const firstUserPrompt = (() => {
      for (const m of obs.history) {
        if (m.role === 'user' && typeof m.content === 'string' && m.content.trim().length > 0) {
          return m.content.trim();
        }
      }
      return '';
    })();

    const ctx: ProposalContext = {
      firstUserPrompt,
      sourceSessionId:    obs.sessionId,
      sourceTurnIdx:      obs.sourceTurnIdx,
      traceFingerprint:   fingerprint,
      candidateConfidence: confidence,
    };

    let skill = buildSkeleton(obs.trace, ctx);
    if (!this.skeletonOnly) {
      skill = await refine(skill, { client: this.auxiliaryClient });
    }

    // Final validation — must round-trip through parseSkillContent
    // (the canonical loader parser). If it doesn't, drop the
    // candidate rather than poison the queue.
    try {
      parseSkillContent(skill);
    } catch {
      return { status: 'invalid-skill', confidence };
    }

    const candidate: MinedCandidate = {
      id:                  randomUUID(),
      fingerprint,
      sourceSessionId:     obs.sessionId,
      sourceTurnIdx:       obs.sourceTurnIdx,
      createdAt:           new Date().toISOString(),
      candidateConfidence: confidence,
      skillContent:        skill,
    };
    await this.store.append(candidate);
    this.perSessionCount.set(obs.sessionId, this.countForSession(obs.sessionId) + 1);
    return { status: 'queued', candidate, confidence };
  }
}
