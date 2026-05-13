/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * Phase v4.1.2-memory-C — `recall_session` tool integration tests.
 *
 * Exercises the disk-read + format glue around the pure ranking
 * module. Fixtures: real distillation JSON files in a temp dir.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { recallSessionTool } from '../../../tools/v4/sessions/recallSession';
import { writeDistillation } from '../../../core/v4/distillationStore';
import {
  SESSION_DISTILLATION_SCHEMA_VERSION,
  type SessionDistillation,
} from '../../../core/v4/sessionDistiller';
import type { AidenPaths } from '../../../core/v4/paths';

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

let tmpRoot: string;
let ctx: { cwd: string; paths: AidenPaths };

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-recall-'));
  ctx = {
    cwd:   tmpRoot,
    paths: { root: tmpRoot } as AidenPaths,
  };
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function seed(dists: SessionDistillation[]): Promise<void> {
  const dir = path.join(tmpRoot, 'distillations');
  for (const dist of dists) await writeDistillation(dir, dist);
}

describe('recallSessionTool — happy paths', () => {
  it('empty distillations directory → success with 0 matches', async () => {
    await fs.mkdir(path.join(tmpRoot, 'distillations'), { recursive: true });
    const out = await recallSessionTool.execute({}, ctx) as {
      success: boolean; matches: unknown[]; total_found: number; scanned: number;
    };
    expect(out.success).toBe(true);
    expect(out.matches).toEqual([]);
    expect(out.total_found).toBe(0);
    expect(out.scanned).toBe(0);
  });

  it('no distillations directory at all → success: true (first-run case)', async () => {
    const out = await recallSessionTool.execute({}, ctx) as {
      success: boolean; matches: unknown[]; scanned: number;
    };
    expect(out.success).toBe(true);
    expect(out.matches).toEqual([]);
    expect(out.scanned).toBe(0);
  });

  it('returns top-N by recency when no query', async () => {
    await seed([
      d({ session_id: 'oldest',  ended_at: '2026-05-01T00:00:00Z' }),
      d({ session_id: 'newest',  ended_at: '2026-05-12T00:00:00Z' }),
      d({ session_id: 'middle',  ended_at: '2026-05-06T00:00:00Z' }),
    ]);
    const out = await recallSessionTool.execute({}, ctx) as {
      matches: Array<{ session_id: string; relevance: string }>;
    };
    expect(out.matches.map((m) => m.session_id)).toEqual(['newest', 'middle', 'oldest']);
    expect(out.matches.every((m) => m.relevance === 'recency')).toBe(true);
  });

  it('keyword query filters and ranks by match count', async () => {
    await seed([
      d({ session_id: 'two-hits', bullets: ['aiden eval'], decisions: ['use aiden default'] }),
      d({ session_id: 'one-hit',  bullets: ['aiden boot'] }),
      d({ session_id: 'no-hit',   bullets: ['unrelated'] }),
    ]);
    const out = await recallSessionTool.execute({ query: 'aiden' }, ctx) as {
      matches: Array<{ session_id: string }>;
      total_found: number;
      scanned: number;
    };
    expect(out.matches[0].session_id).toBe('two-hits');
    expect(out.matches.map((m) => m.session_id)).not.toContain('no-hit');
    expect(out.total_found).toBe(2);
    expect(out.scanned).toBe(3);
  });

  it('keyword match across tools_used[].name', async () => {
    await seed([
      d({ session_id: 'used-shell', tools_used: [{ name: 'shell_exec', count: 4 }] }),
      d({ session_id: 'no-shell',   tools_used: [{ name: 'file_read',  count: 2 }] }),
    ]);
    const out = await recallSessionTool.execute({ query: 'shell_exec' }, ctx) as {
      matches: Array<{ session_id: string }>;
    };
    expect(out.matches.map((m) => m.session_id)).toEqual(['used-shell']);
  });

  it('include_full=true surfaces tools_used and keywords', async () => {
    await seed([d({
      session_id: 's',
      tools_used: [{ name: 't', count: 1 }],
      keywords:   ['kw'],
    })]);
    const compact = await recallSessionTool.execute({}, ctx) as {
      matches: Array<{ tools_used?: unknown; keywords?: unknown }>;
    };
    expect(compact.matches[0].tools_used).toBeUndefined();
    expect(compact.matches[0].keywords).toBeUndefined();

    const full = await recallSessionTool.execute({ include_full: true }, ctx) as {
      matches: Array<{ tools_used: unknown; keywords: unknown }>;
    };
    expect(full.matches[0].tools_used).toEqual([{ name: 't', count: 1 }]);
    expect(full.matches[0].keywords).toEqual(['kw']);
  });

  it('partial flag bubbles from degraded distillations', async () => {
    await seed([d({ session_id: 's', partial: true, bullets: [] })]);
    const out = await recallSessionTool.execute({}, ctx) as {
      matches: Array<{ partial?: true }>;
    };
    expect(out.matches[0].partial).toBe(true);
  });

  it('limit clamped to [1, 25]', async () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      d({ session_id: `s-${i.toString().padStart(2, '0')}`, ended_at: `2026-05-${(i + 1).toString().padStart(2, '0')}T00:00:00Z` }),
    );
    await seed(many);
    const out = await recallSessionTool.execute({ limit: 999 }, ctx) as {
      matches: unknown[];
      total_found: number;
    };
    expect(out.matches.length).toBe(25);
    expect(out.total_found).toBe(40);
  });

  it('days window filters before scoring', async () => {
    const now = Date.now();
    const day = (n: number) => new Date(now - n * 86_400_000).toISOString();
    await seed([
      d({ session_id: 'in-window',  bullets: ['aiden'], ended_at: day(2)  }),
      d({ session_id: 'out-window', bullets: ['aiden'], ended_at: day(30) }),
    ]);
    const out = await recallSessionTool.execute({ query: 'aiden', days: 7 }, ctx) as {
      matches: Array<{ session_id: string }>;
    };
    expect(out.matches.map((m) => m.session_id)).toEqual(['in-window']);
  });
});

describe('recallSessionTool — robustness', () => {
  it('malformed JSON file in dir is skipped silently; rest still rank', async () => {
    const dir = path.join(tmpRoot, 'distillations');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'bad.json'),  'not-json{{',           'utf-8');
    await writeDistillation(dir, d({ session_id: 'good', bullets: ['x'] }));
    const out = await recallSessionTool.execute({}, ctx) as {
      success: boolean; matches: Array<{ session_id: string }>; scanned: number;
    };
    expect(out.success).toBe(true);
    expect(out.matches.map((m) => m.session_id)).toEqual(['good']);
    // scanned reflects every basename listDistillationIds saw — including
    // the malformed file (it ended in .json). The agent infers
    // "scanned > rendered-matches but no keyword filter" → some files
    // were corrupt; cue to suggest aiden doctor.
    expect(out.scanned).toBe(2);
  });

  it('missing paths.root → success: false with helpful error', async () => {
    const badCtx = { cwd: tmpRoot, paths: {} as AidenPaths };
    const out = await recallSessionTool.execute({}, badCtx) as {
      success: boolean; error: string;
    };
    expect(out.success).toBe(false);
    expect(out.error).toContain('aiden paths');
  });

  it('schema sanity: name is recall_session, toolset=sessions, mutates=false', () => {
    expect(recallSessionTool.schema.name).toBe('recall_session');
    expect(recallSessionTool.toolset).toBe('sessions');
    expect(recallSessionTool.mutates).toBe(false);
    expect(recallSessionTool.category).toBe('read');
    expect(recallSessionTool.schema.description).toContain('session_search');
  });
});
