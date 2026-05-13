/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * Phase v4.1.2-memory-C — pure ranking + filtering coverage.
 *
 * Tests `rankDistillations`'s decision tree in isolation: no I/O, no
 * tool-handler context, just the SessionDistillation[] → RecallResult
 * mapping. The tool-side test
 * (`tests/v4/tools/recallSession.test.ts`) exercises the disk read +
 * format glue.
 */
import { describe, it, expect } from 'vitest';
import {
  rankDistillations,
  scoreMatch,
  type RecallQuery,
} from '../../../core/v4/distillationIndex';
import {
  SESSION_DISTILLATION_SCHEMA_VERSION,
  type SessionDistillation,
} from '../../../core/v4/sessionDistiller';

/** Build a distillation with sensible defaults; tests override what they care about. */
function d(opts: Partial<SessionDistillation> & { session_id: string }): SessionDistillation {
  return {
    schema_version: SESSION_DISTILLATION_SCHEMA_VERSION,
    session_id:     opts.session_id,
    started_at:     opts.started_at ?? '2026-05-12T00:00:00Z',
    ended_at:       opts.ended_at   ?? '2026-05-12T01:00:00Z',
    exit_path:      opts.exit_path  ?? 'quit',
    user_turns:     opts.user_turns ?? 5,
    bullets:        opts.bullets    ?? [],
    decisions:      opts.decisions  ?? [],
    open_items:     opts.open_items ?? [],
    keywords:       opts.keywords   ?? [],
    files_touched:  opts.files_touched ?? [],
    tools_used:     opts.tools_used    ?? [],
    ...(opts.partial ? { partial: true as const } : {}),
  };
}

// Fixed reference time for deterministic days-window tests.
const NOW = Date.parse('2026-05-13T00:00:00Z');
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

describe('rankDistillations — no query (recency-only)', () => {
  it('returns top N by ended_at desc', () => {
    const dists = [
      d({ session_id: 'old',    ended_at: day(10) }),
      d({ session_id: 'recent', ended_at: day(1)  }),
      d({ session_id: 'mid',    ended_at: day(5)  }),
    ];
    const r = rankDistillations(dists, {}, NOW);
    expect(r.matches.map((m) => m.session_id)).toEqual(['recent', 'mid', 'old']);
    expect(r.matches.every((m) => m.relevance === 'recency')).toBe(true);
    expect(r.total_found).toBe(3);
    expect(r.scanned).toBe(3);
  });

  it('respects the limit (default 5, max 25)', () => {
    const dists = Array.from({ length: 30 }, (_, i) =>
      d({ session_id: `s-${i}`, ended_at: day(i) }),
    );
    expect(rankDistillations(dists, {},                 NOW).matches.length).toBe(5);  // default
    expect(rankDistillations(dists, { limit: 1 },       NOW).matches.length).toBe(1);
    expect(rankDistillations(dists, { limit: 999 },     NOW).matches.length).toBe(25); // clamped
    expect(rankDistillations(dists, { limit: -3 },      NOW).matches.length).toBe(1);  // clamped to floor
    expect(rankDistillations(dists, { limit: NaN },     NOW).matches.length).toBe(5);  // ignored
  });

  it('empty input returns empty matches', () => {
    expect(rankDistillations([], {}, NOW)).toEqual({
      matches: [], total_found: 0, scanned: 0,
    });
  });
});

describe('rankDistillations — keyword path', () => {
  it('scores by case-insensitive substring match across the listed fields', () => {
    const dists = [
      // Single hit in bullets.
      d({ session_id: 'b-only',     bullets:    ['Worked on Aiden eval harness'] }),
      // Two hits: bullets + decisions.
      d({ session_id: 'b-plus-d',   bullets:    ['Aiden eval pass rate'],
                                    decisions:  ['Aiden default model = chatgpt-plus'] }),
      // No hit.
      d({ session_id: 'no-hit',     bullets:    ['Reviewed PRs, no provider work'] }),
      // Hit in keywords[] (not in bullets).
      d({ session_id: 'kw',         keywords:   ['aiden'] }),
      // Hit in open_items[].
      d({ session_id: 'oi',         open_items: ['Wire Aiden DeepSeek defaults'] }),
      // Hit in tools_used[].name.
      d({ session_id: 'tool',       tools_used: [{ name: 'aiden_special_tool', count: 1 }] }),
    ];
    const r = rankDistillations(dists, { query: 'aiden' }, NOW);
    const ids = r.matches.map((m) => m.session_id);
    // b-plus-d has 2 hits → top. Others tie at 1 hit.
    expect(ids[0]).toBe('b-plus-d');
    // 'no-hit' must not appear at all.
    expect(ids).not.toContain('no-hit');
    expect(r.total_found).toBe(5);
    expect(r.matches.every((m) => m.relevance === 'keyword')).toBe(true);
  });

  it('ties broken by recency (newer first)', () => {
    const dists = [
      d({ session_id: 'older', bullets: ['has aiden'], ended_at: day(7) }),
      d({ session_id: 'newer', bullets: ['has aiden'], ended_at: day(1) }),
    ];
    const r = rankDistillations(dists, { query: 'aiden' }, NOW);
    expect(r.matches.map((m) => m.session_id)).toEqual(['newer', 'older']);
  });

  it('multi-field hit counts once per field-string, not per occurrence', () => {
    // The string "Aiden Aiden Aiden" still scores 1 (we count fields,
    // not occurrences) — keeps scoring debuggable.
    const dist = d({ session_id: 'x', bullets: ['Aiden Aiden Aiden'] });
    expect(scoreMatch(dist, 'aiden')).toBe(1);
  });

  it('query empty string treated as no-query (recency path)', () => {
    const dists = [d({ session_id: 'r', ended_at: day(1) })];
    const r = rankDistillations(dists, { query: '   ' }, NOW);
    expect(r.matches[0]?.relevance).toBe('recency');
  });
});

describe('rankDistillations — days window', () => {
  it('drops distillations older than the window', () => {
    const dists = [
      d({ session_id: 'older-than-window', ended_at: day(10) }),
      d({ session_id: 'in-window',          ended_at: day(3)  }),
      d({ session_id: 'edge',               ended_at: day(7)  }), // exactly at cutoff
    ];
    const r = rankDistillations(dists, { days: 7 }, NOW);
    // edge: cutoff = NOW - 7 days; ended = NOW - 7 days → ts === cutoff → included.
    const ids = r.matches.map((m) => m.session_id);
    expect(ids).toContain('in-window');
    expect(ids).toContain('edge');
    expect(ids).not.toContain('older-than-window');
  });

  it('days=0 / negative / non-finite is treated as no window', () => {
    const dists = [d({ session_id: 'old', ended_at: day(365) })];
    expect(rankDistillations(dists, { days: 0   }, NOW).matches.length).toBe(1);
    expect(rankDistillations(dists, { days: -5  }, NOW).matches.length).toBe(1);
    expect(rankDistillations(dists, { days: NaN }, NOW).matches.length).toBe(1);
  });

  it('days window combines with keyword query (filter then score)', () => {
    const dists = [
      // Has keyword but outside window.
      d({ session_id: 'old-hit', bullets: ['aiden'], ended_at: day(30) }),
      // In window but no keyword.
      d({ session_id: 'fresh-miss', bullets: ['groq'], ended_at: day(2) }),
      // In window AND has keyword.
      d({ session_id: 'fresh-hit', bullets: ['aiden'], ended_at: day(1) }),
    ];
    const r = rankDistillations(dists, { query: 'aiden', days: 7 }, NOW);
    expect(r.matches.map((m) => m.session_id)).toEqual(['fresh-hit']);
    expect(r.total_found).toBe(1);
    expect(r.scanned).toBe(3); // all files were inspected; filter narrowed
  });
});

describe('rankDistillations — output shape', () => {
  it('omits tools_used and keywords by default (include_full: false)', () => {
    const dists = [d({
      session_id: 's', tools_used: [{ name: 't', count: 1 }], keywords: ['k'],
    })];
    const m = rankDistillations(dists, {}, NOW).matches[0];
    expect(m.tools_used).toBeUndefined();
    expect(m.keywords).toBeUndefined();
  });

  it('includes tools_used + keywords when include_full=true', () => {
    const dists = [d({
      session_id: 's', tools_used: [{ name: 't', count: 1 }], keywords: ['k'],
    })];
    const m = rankDistillations(dists, { include_full: true }, NOW).matches[0];
    expect(m.tools_used).toEqual([{ name: 't', count: 1 }]);
    expect(m.keywords).toEqual(['k']);
  });

  it('bubbles partial flag from degraded distillations', () => {
    const dists = [d({ session_id: 's', partial: true })];
    expect(rankDistillations(dists, {}, NOW).matches[0].partial).toBe(true);
  });

  it('omits partial flag for full distillations', () => {
    const dists = [d({ session_id: 's' })];
    expect(rankDistillations(dists, {}, NOW).matches[0].partial).toBeUndefined();
  });

  it('total_found vs scanned: report both honestly', () => {
    const dists = [
      d({ session_id: 'hit',  bullets: ['aiden'] }),
      d({ session_id: 'miss', bullets: ['groq']  }),
    ];
    const r: { matches: { session_id: string }[]; total_found: number; scanned: number } =
      rankDistillations(dists, { query: 'aiden' }, NOW);
    expect(r.matches.length).toBe(1);
    expect(r.total_found).toBe(1);
    expect(r.scanned).toBe(2);
  });
});

describe('scoreMatch — direct contract', () => {
  it('hits 5 fields = score 5', () => {
    const dist = d({
      session_id: 's',
      keywords:    ['aiden-runtime'],
      bullets:     ['Aiden core fix'],
      decisions:   ['Promote Aiden to v4.1.2'],
      open_items:  ['Backport Aiden tests'],
      tools_used:  [{ name: 'aiden_helper', count: 1 }],
    });
    expect(scoreMatch(dist, 'aiden')).toBe(5);
  });
  it('no hits = score 0', () => {
    expect(scoreMatch(d({ session_id: 's', bullets: ['unrelated'] }), 'aiden')).toBe(0);
  });
});

// Compile-time type assertion — RecallQuery shape stays as documented.
const _q: RecallQuery = { query: 'x', limit: 5, days: 7, include_full: false };
void _q;
