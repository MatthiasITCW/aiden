import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  buildRuntimeManifest,
  renderRuntimeSlot,
} from '../../core/v4/capabilities';
import { PromptBuilder } from '../../core/v4/promptBuilder';
import { resolveAidenPaths, ensureAidenDirsExist } from '../../core/v4/paths';
import { VERSION } from '../../core/version';

/**
 * Phase v4.1.2-followup — Aiden self-awareness via runtime-injected
 * version + capabilities manifest in the system prompt.
 *
 * Contract:
 *   - Manifest is pure; same inputs → same output.
 *   - Version is read from core/version.ts (auto-synced with package.json).
 *   - renderRuntimeSlot emits a `## Runtime` h2 + `Key: value` lines.
 *   - Provider/Model lines are omitted when undefined; everything else
 *     is unconditional so the slot is always present.
 *   - PromptBuilder always emits the slot, positioned after USER.md and
 *     before tool-conditional guidance.
 */

async function makeTempRoot(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-cap-'));
}

describe('buildRuntimeManifest', () => {
  it('reads VERSION from core/version.ts', () => {
    const m = buildRuntimeManifest({ toolCount: 1, skillCount: 1 });
    expect(m.version).toBe(VERSION);
  });

  it('passes through tool count + skill count verbatim', () => {
    const m = buildRuntimeManifest({ toolCount: 42, skillCount: 72 });
    expect(m.toolCount).toBe(42);
    expect(m.skillCount).toBe(72);
  });

  it('threads optional provider + model fields', () => {
    const m = buildRuntimeManifest({
      toolCount:  1,
      skillCount: 1,
      providerId: 'chatgpt-plus',
      modelId:    'gpt-5.3-codex',
    });
    expect(m.providerId).toBe('chatgpt-plus');
    expect(m.modelId).toBe('gpt-5.3-codex');
  });

  it('ships a non-empty frozen channels list', () => {
    const m = buildRuntimeManifest({ toolCount: 0, skillCount: 0 });
    expect(m.channels.length).toBeGreaterThan(0);
    expect(m.channels).toContain('cli');
    expect(m.channels).toContain('telegram');
    expect(m.channels).toContain('mcp');
  });
});

describe('renderRuntimeSlot', () => {
  it('emits the ## Runtime header + simple key:value lines', () => {
    const out = renderRuntimeSlot({
      version:    '4.1.1',
      toolCount:  45,
      skillCount: 72,
      channels:   ['cli', 'telegram'],
      providerId: 'chatgpt-plus',
      modelId:    'gpt-5.3-codex',
    });
    expect(out).toContain('## Runtime');
    expect(out).toContain('Version: 4.1.1');
    expect(out).toContain('Tools loaded: 45');
    expect(out).toContain('Skills bundled: 72');
    expect(out).toContain('Active channels: cli, telegram');
    expect(out).toContain('Provider: chatgpt-plus');
    expect(out).toContain('Model: gpt-5.3-codex');
  });

  it('omits the Provider line when providerId is undefined', () => {
    const out = renderRuntimeSlot({
      version:    '4.1.1',
      toolCount:  0,
      skillCount: 0,
      channels:   ['cli'],
    });
    expect(out).not.toContain('Provider:');
    expect(out).not.toContain('Model:');
    // Rest still present — the slot is always emitted, never suppressed.
    expect(out).toContain('## Runtime');
    expect(out).toContain('Version: 4.1.1');
  });
});

describe('PromptBuilder runtime slot integration', () => {
  it('always emits the ## Runtime slot, including when toolCount/skillCount are unset', async () => {
    const root = await makeTempRoot();
    const paths = resolveAidenPaths({ rootOverride: root });
    await ensureAidenDirsExist(paths);
    const prompt = await (new PromptBuilder()).build({ paths });
    expect(prompt).toContain('## Runtime');
    expect(prompt).toContain(`Version: ${VERSION}`);
    expect(prompt).toContain('Tools loaded: 0');
    expect(prompt).toContain('Skills bundled: 0');
  });

  it('reflects the real tool / skill counts passed in via options', async () => {
    const root = await makeTempRoot();
    const paths = resolveAidenPaths({ rootOverride: root });
    await ensureAidenDirsExist(paths);
    const prompt = await (new PromptBuilder()).build({
      paths,
      toolCount:  45,
      skillsList: Array.from({ length: 72 }).map((_, i) => ({
        name: `s${i}`,
        description: `d${i}`,
      })),
      providerId: 'groq',
      modelId:    'llama-3.3-70b-versatile',
    });
    expect(prompt).toContain('Tools loaded: 45');
    expect(prompt).toContain('Skills bundled: 72');
    expect(prompt).toContain('Provider: groq');
    expect(prompt).toContain('Model: llama-3.3-70b-versatile');
  });

  it('positions the Runtime slot AFTER USER.md and BEFORE tool-conditional guidance', async () => {
    const root = await makeTempRoot();
    const paths = resolveAidenPaths({ rootOverride: root });
    await ensureAidenDirsExist(paths);
    const prompt = await (new PromptBuilder()).build({
      paths,
      memorySnapshot:  { memoryMd: '', userMd: 'I like terseness.' },
      toolsetsLoaded:  new Set(['memory']),
      toolCount:       3,
    });
    const userIdx    = prompt.indexOf('I like terseness');
    const runtimeIdx = prompt.indexOf('## Runtime');
    const memIdx     = prompt.indexOf('## Persistent memory');
    expect(userIdx).toBeGreaterThan(-1);
    expect(runtimeIdx).toBeGreaterThan(userIdx);
    expect(memIdx).toBeGreaterThan(runtimeIdx);
  });

  it('does NOT mention "v4.0" / "planned for v4.1" anywhere in the prompt (regression guard)', async () => {
    const root = await makeTempRoot();
    const paths = resolveAidenPaths({ rootOverride: root });
    await ensureAidenDirsExist(paths);
    // Force the DEFAULT_SOUL_MD path (no SOUL.md on disk).
    const prompt = await (new PromptBuilder()).build({ paths });
    expect(prompt).not.toMatch(/v4\.0\.0/);
    expect(prompt).not.toContain('planned for v4.1');
    expect(prompt).not.toMatch(/messaging gateway yet/);
  });
});
