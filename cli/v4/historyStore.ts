/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/historyStore.ts — Tier-3.1.1 (v4.1-tier3.1.1)
 *
 * Persistent input history for the chat REPL. Each user prompt is
 * appended to `<aidenHome>/.aiden_history`, one entry per line,
 * multiline-encoded so a prompt with embedded newlines round-trips
 * faithfully:
 *   - `\n` inside a prompt is encoded as `\\n` on disk
 *   - `\\` inside a prompt is encoded as `\\\\` on disk
 *
 * The store filters out:
 *   - blank entries
 *   - duplicates of the most recent entry
 *   - very-short entries (<3 chars after trim) — too noisy to suggest
 *   - paste-labelled entries (`[paste #N: …]`) — privacy. The user's
 *     real prompt was the label-substituted text; storing the label
 *     would leak nothing but storing the expanded text would leak the
 *     entire pasted block into a plain-text history file.
 *
 * On startup, `loadRecent()` returns the last `limit` entries (newest
 * first) for the autosuggest history fallback.
 *
 * Atomic write: each `append` writes a temp sibling then renames over
 * the live file (Windows rename is atomic on the same volume), so a
 * crash mid-write can never corrupt the history.
 */

import {
  promises as fsp,
  existsSync,
  mkdirSync,
} from 'node:fs';
import path from 'node:path';

import { resolveAidenPaths } from '../../core/v4/paths';

const HISTORY_FILENAME = '.aiden_history';
const PASTE_LABEL_RE   = /\[paste #\d+:[^\]]*\]/;

let writeLatch: Promise<void> = Promise.resolve();

function historyPath(): string {
  return path.join(resolveAidenPaths().root, HISTORY_FILENAME);
}

/** Encode a prompt for one-line storage on disk. */
function encode(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

/** Reverse of `encode`. */
function decode(s: string): string {
  // Walk the string so `\\\\n` decodes to `\\n` (literal backslash + n)
  // rather than the placeholder for newline.
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      const next = s[i + 1];
      if (next === 'n') {
        out += '\n';
        i += 1;
      } else if (next === '\\') {
        out += '\\';
        i += 1;
      } else {
        out += c;
      }
    } else {
      out += c;
    }
  }
  return out;
}

/**
 * Append `entry` to the history file. Filters per the rules above.
 * Best-effort — disk failures are swallowed so a crashed history
 * write never breaks the agent loop.
 */
/**
 * Tier-3-essentials: cap the live file at this many entries. When an
 * append would push the count above, we rotate the oldest out before
 * writing the new line. 5000 = ~250 KB at typical prompt sizes,
 * trivial to keep on disk and load on every prompt.
 */
export const HISTORY_MAX_ENTRIES = 5000;

export async function appendHistory(entry: string): Promise<void> {
  const trimmed = entry.trim();
  if (trimmed.length < 3) return;
  if (PASTE_LABEL_RE.test(trimmed)) return;

  await (writeLatch = writeLatch.then(async () => {
    try {
      const p = historyPath();
      const dir = path.dirname(p);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      // Read current contents once — we use them for both dup-suppress
      // and rotation.
      let priorLines: string[] = [];
      try {
        const cur = await fsp.readFile(p, 'utf8');
        priorLines = cur.split('\n').filter((l) => l.length > 0);
      } catch { /* file may not exist yet */ }

      // Skip if equal to the last entry on disk (cheap dup-suppress).
      const lastDecoded = priorLines.length > 0 ? decode(priorLines[priorLines.length - 1]) : '';
      if (lastDecoded === entry) return;

      // Rotation: cap at HISTORY_MAX_ENTRIES. The new line will push
      // total to len+1; if that exceeds the cap, drop the oldest
      // (len+1 - cap) entries from the front so we land EXACTLY at
      // the cap.
      const wantTotal = priorLines.length + 1;
      if (wantTotal > HISTORY_MAX_ENTRIES) {
        const dropFront = wantTotal - HISTORY_MAX_ENTRIES;
        priorLines = priorLines.slice(dropFront);
      }

      const tmp = `${p}.tmp`;
      const nextContent = priorLines.join('\n')
        + (priorLines.length > 0 ? '\n' : '')
        + `${encode(entry)}\n`;
      await fsp.writeFile(tmp, nextContent, 'utf8');
      await fsp.rename(tmp, p);
    } catch {
      // History write failure must not bubble up.
    }
  }));
}

/**
 * Return the last `limit` entries (newest first). Decoded — caller
 * sees the original prompt verbatim including any embedded newlines.
 *
 * Tier-3-essentials: default raised 100 → 500 so the autosuggest
 * history-mode reaches further back. The on-disk cap is independently
 * controlled by `HISTORY_MAX_ENTRIES`.
 */
export async function loadRecent(limit = 500): Promise<string[]> {
  try {
    const p = historyPath();
    const raw = await fsp.readFile(p, 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    const decoded = lines.map(decode);
    const sliced = decoded.slice(Math.max(0, decoded.length - limit));
    return sliced.reverse();
  } catch {
    return [];
  }
}

/** Test/reset hook: drop in-process state. Disk untouched. */
export function _resetForTests(): void {
  writeLatch = Promise.resolve();
}
