/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/pasteCompression.ts — Tier-3.1 (v4.1-tier3.1)
 *
 * When a user pastes a large block (>5 lines OR >500 chars), the
 * REPL replaces the visible echo with a compact label
 *   `[paste #<id>: <N> lines, <KB>]`
 * and stores the original at `<aidenRoot>/pastes/paste_<id>.txt`.
 * The agent receives the original text as input — only the visible
 * echo is compressed, so the LLM still sees full content.
 *
 * The id counter is persisted in `<aidenRoot>/pastes/manifest.json`
 * so it increments across sessions. Concurrent writes from the same
 * process are serialised through an in-process latch; cross-process
 * concurrency is best-effort (the manifest is read+rewritten atomic-
 * ally enough for a single-user CLI).
 *
 * `expandPaste(id)` reads the original back from disk, used by the
 * `/show <id>` slash command.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { resolveAidenPaths } from '../../core/v4/paths';

/** Heuristic threshold — copy-paste a code block of >5 lines or >500
 *  chars and we compress; smaller pastes echo verbatim. */
export const PASTE_COMPRESS_LINES = 5;
export const PASTE_COMPRESS_CHARS = 500;

export interface CompressResult {
  compressed: boolean;
  /** Visible label injected into the REPL display (only when compressed). */
  label?:    string;
  /** Stable id used by `/show <id>` to retrieve the original. */
  id?:       string;
  /** The original text — agent receives this regardless of compression. */
  original?: string;
}

/** Per-process write latch so concurrent compresses don't race the
 *  manifest. Cross-process safety is non-goal for the single-user CLI. */
let writeLatch: Promise<void> = Promise.resolve();

function pastesDir(): string {
  const paths = resolveAidenPaths();
  return path.join(paths.root, 'pastes');
}

function manifestPath(): string {
  return path.join(pastesDir(), 'manifest.json');
}

async function readNextId(): Promise<number> {
  try {
    const raw = await fsp.readFile(manifestPath(), 'utf8');
    const j = JSON.parse(raw) as { nextId?: number };
    if (typeof j.nextId === 'number' && j.nextId >= 1) return j.nextId;
  } catch {
    // missing or malformed — start at 1
  }
  return 1;
}

async function writeNextId(next: number): Promise<void> {
  const dir = pastesDir();
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    manifestPath(),
    JSON.stringify({ nextId: next }, null, 2),
    'utf8',
  );
}

function formatBytes(text: string): string {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}

/**
 * Decide whether `text` should be compressed and (if so) persist the
 * original. Always returns the original text for the agent path; only
 * the echo path consults `compressed`/`label`.
 */
export async function compressPaste(text: string): Promise<CompressResult> {
  const lineCount = (text.match(/\n/g)?.length ?? 0) + 1;
  const big = lineCount > PASTE_COMPRESS_LINES || text.length > PASTE_COMPRESS_CHARS;
  if (!big) {
    return { compressed: false, original: text };
  }

  // Atomic ID allocation under in-process latch.
  let id = '';
  let label = '';
  await (writeLatch = writeLatch.then(async () => {
    const next = await readNextId();
    id = String(next);
    const dir = pastesDir();
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `paste_${id}.txt`), text, 'utf8');
    await writeNextId(next + 1);
    label = `[paste #${id}: ${lineCount} lines, ${formatBytes(text)}]`;
  }));

  return { compressed: true, id, label, original: text };
}

/**
 * Read back a previously stored paste by id. Returns `null` if the
 * id is unknown or the file vanished.
 */
export async function expandPaste(id: string): Promise<string | null> {
  // Defence-in-depth: only allow numeric ids — keeps the path-join
  // from straying outside the pastes directory if someone ever
  // wires an untrusted argument here.
  if (!/^\d+$/.test(id)) return null;
  try {
    const file = path.join(pastesDir(), `paste_${id}.txt`);
    return await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Test/reset hook: drop the in-process latch so a fresh test run
 * starts with a clean serialiser. Disk state untouched.
 */
export function _resetLatchForTests(): void {
  writeLatch = Promise.resolve();
}
