/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/distillationIndex.ts — Phase v4.1.2-memory-C.
 *
 * Pure ranking + filtering over an in-memory list of
 * `SessionDistillation` records. The tool handler
 * (`tools/v4/sessions/recallSession.ts`) reads JSON files off disk
 * and passes them in here; this module has no I/O.
 *
 * Ranking rules (per slice's Q3):
 *   - No query → recency-only: sort by `ended_at` desc, take top N.
 *   - Query present → score by total keyword-substring matches across:
 *       keywords[], bullets[], decisions[], open_items[],
 *       tools_used[].name
 *     Recency breaks ties.
 *   - `days` window filters out anything with
 *     `now - ended_at > days * 86_400_000` BEFORE scoring.
 *
 * No hybrid weighting, no LLM call, no embeddings — those are Phase E
 * concerns. Today's ranking stays debuggable: the user can read why a
 * result ranked where it did from `relevance` + the match field
 * listed in each candidate.
 *
 * Index strategy: scan-all. Expected file count is <1000 per user;
 * the tool handler reads every file from disk per query (sub-100ms at
 * that scale). When real usage shows query latency >500ms, migrate
 * directly to SQLite FTS5 — skip a JSON-index intermediate step.
 */

import type { SessionDistillation } from './sessionDistiller';

// ── Tool-facing types ─────────────────────────────────────────────────────

export interface RecallQuery {
  /** Optional keyword filter. Case-insensitive substring match. */
  query?:        string;
  /** Maximum matches to return. Clamped to [1, 25]. Default 5. */
  limit?:        number;
  /** Optional recency window — drop distillations older than this. */
  days?:         number;
  /**
   * When true, output rows carry `tools_used`, `keywords`, and the
   * `partial` flag. Default false to keep response compact (the
   * agent calls this routinely; tokens add up).
   */
  include_full?: boolean;
}

export interface RecallMatch {
  session_id:    string;
  started_at:    string;
  ended_at:      string;
  exit_path:     string;
  /** Why this row ranked: 'recency' when no query, 'keyword' on hit. */
  relevance:     'recency' | 'keyword';
  bullets:       string[];
  decisions:     string[];
  open_items:    string[];
  files_touched: string[];
  /** Present only when input.include_full === true. */
  tools_used?:   Array<{ name: string; count: number }>;
  keywords?:     string[];
  /** Bubbles from degraded distillations (Phase A+B partial flag). */
  partial?:      true;
}

export interface RecallResult {
  /** Top-N ranked matches (after limit). */
  matches:     RecallMatch[];
  /** Number of distillations that matched BEFORE limit truncation. */
  total_found: number;
  /** Number of distillation files inspected — diagnostic for the agent. */
  scanned:     number;
}

// ── Constants ─────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 5;
const MAX_LIMIT     = 25;
const ONE_DAY_MS    = 24 * 60 * 60 * 1000;

// ── Pure ranking ──────────────────────────────────────────────────────────

/**
 * Rank + filter distillations against a query. Pure: no I/O, no
 * side effects, no clock-reads other than `nowMs` for the recency
 * window (injectable for deterministic tests).
 *
 * @param dists  Every distillation read from disk. Scan-all per slice's
 *               index strategy — caller owns the I/O.
 * @param query  User-supplied recall query.
 * @param nowMs  Reference time for the days window. Defaults to
 *               `Date.now()`; tests inject a fixed value.
 */
export function rankDistillations(
  dists: ReadonlyArray<SessionDistillation>,
  query: RecallQuery = {},
  nowMs: number = Date.now(),
): RecallResult {
  const scanned = dists.length;
  const limit   = clampLimit(query.limit);
  const keyword = (query.query ?? '').trim().toLowerCase();

  // 1. Days window filter.
  let pool: SessionDistillation[];
  if (typeof query.days === 'number' && query.days > 0) {
    const cutoff = nowMs - query.days * ONE_DAY_MS;
    pool = dists.filter((d) => {
      const t = Date.parse(d.ended_at);
      return Number.isFinite(t) && t >= cutoff;
    });
  } else {
    pool = [...dists];
  }

  // 2. Score + filter.
  let scored: Array<{ d: SessionDistillation; score: number; ended: number }>;
  let relevance: 'recency' | 'keyword';
  if (keyword.length === 0) {
    // Recency-only: every survivor passes; score by inverse end-time
    // so the sort below is identical to "newest first".
    scored = pool.map((d) => ({
      d,
      score: 0,
      ended: safeEndedMs(d),
    }));
    relevance = 'recency';
  } else {
    scored = [];
    for (const d of pool) {
      const score = scoreMatch(d, keyword);
      if (score > 0) scored.push({ d, score, ended: safeEndedMs(d) });
    }
    relevance = 'keyword';
  }

  // 3. Sort. Keyword path: score desc, recency tiebreak. Recency
  // path: ended desc.
  scored.sort((a, b) => {
    if (keyword.length > 0 && a.score !== b.score) return b.score - a.score;
    return b.ended - a.ended;
  });

  const total_found = scored.length;
  const matches     = scored
    .slice(0, limit)
    .map(({ d }) => toRecallMatch(d, relevance, query.include_full === true));

  return { matches, total_found, scanned };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function clampLimit(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(raw)));
}

function safeEndedMs(d: SessionDistillation): number {
  const t = Date.parse(d.ended_at);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Compute the keyword-match score for one distillation. Counts every
 * field-string that contains the keyword as a substring (case-fold).
 * Each hit = 1 point — simple and debuggable. Multi-occurrence inside
 * one string still counts as 1 hit (we score field presence, not
 * frequency).
 *
 * Fields scanned (per slice's explicit list):
 *   - keywords[]
 *   - bullets[]
 *   - decisions[]
 *   - open_items[]
 *   - tools_used[].name
 */
export function scoreMatch(d: SessionDistillation, keyword: string): number {
  let score = 0;
  for (const k of d.keywords)    if (k.toLowerCase().includes(keyword))    score += 1;
  for (const b of d.bullets)     if (b.toLowerCase().includes(keyword))    score += 1;
  for (const dc of d.decisions)  if (dc.toLowerCase().includes(keyword))   score += 1;
  for (const o of d.open_items)  if (o.toLowerCase().includes(keyword))    score += 1;
  for (const t of d.tools_used)  if (t.name.toLowerCase().includes(keyword)) score += 1;
  return score;
}

function toRecallMatch(
  d:           SessionDistillation,
  relevance:   'recency' | 'keyword',
  includeFull: boolean,
): RecallMatch {
  const out: RecallMatch = {
    session_id:    d.session_id,
    started_at:    d.started_at,
    ended_at:      d.ended_at,
    exit_path:     d.exit_path,
    relevance,
    bullets:       d.bullets,
    decisions:     d.decisions,
    open_items:    d.open_items,
    files_touched: d.files_touched,
  };
  if (includeFull) {
    out.tools_used = d.tools_used;
    out.keywords   = d.keywords;
  }
  if (d.partial) out.partial = true;
  return out;
}
