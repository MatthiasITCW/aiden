/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/box.ts — rounded-corner box drawing helpers (Phase 22).
 *
 * Shared between the REPL boot card (chatSession.ts), the
 * setup-complete summary (setupWizard.ts), the /doctor health box
 * (doctor.ts), and the approval prompt box (callbacks.ts). Per the
 * Aiden uses the rounded set (╭╮╰╯) for box framing — rounded
 * reads softer at launch-card scale than square corners.
 *
 * Width counts the inner cell only (between the verticals). Content
 * is padded to width-1 so a single leading space gives the box a
 * visual gutter.
 *
 * ANSI awareness (Phase 22 Group C smoke-fix): Group C's per-row
 * coloured content (orange ✓ icons, soft-cyan labels) inflated
 * `string.length` from ~50 visible chars to ~120 bytes per row, so
 * the prior byte-based padding under-filled and the closing `│`
 * drifted inside the visible box top/bottom borders. The helpers
 * below measure / truncate against the visible (post-strip)
 * length, so coloured content frames identically to plain content.
 */

const TL = '╭';
const TR = '╮';
const BL = '╰';
const BR = '╯';
const H = '─';
const V = '│';

/**
 * Strip ANSI CSI escape sequences and return the visible length in
 * Unicode code units (`String.length`). Sufficient for all colour
 * codes we emit (`\x1b[38;2;r;g;bm`, `\x1b[39m`, `\x1b[0m`, etc.).
 *
 * Doesn't try to handle East Asian wide chars / emoji-with-VS16 — we
 * use only single-cell glyphs in box content (✓ ⚠ ✗ ⏵ ▶ ⊕). If the
 * skill expands in v4.1 to cover wide chars, swap to `string-width`.
 */
const ANSI_REGEX = /\x1b\[[0-9;]*[A-Za-z]/g;
export function visibleLength(s: string): number {
  return s.replace(ANSI_REGEX, '').length;
}

/**
 * Truncate `s` to `maxVisible` visible columns, preserving any ANSI
 * sequences encountered along the way. When the input contained ANSI
 * codes, an SGR reset is appended so the closing `│` doesn't inherit
 * the truncated content's colour. Plain-text input is unchanged
 * beyond the truncation, so callers building plain rows still see
 * exactly `maxVisible` characters back.
 */
export function truncateVisible(s: string, maxVisible: number): string {
  if (visibleLength(s) <= maxVisible) return s;
  let out = '';
  let visible = 0;
  let i = 0;
  let sawAnsi = false;
  while (i < s.length && visible < maxVisible) {
    const ch = s.charCodeAt(i);
    if (ch === 0x1b && s[i + 1] === '[') {
      const m = s.slice(i).match(/^\x1b\[[0-9;]*[A-Za-z]/);
      if (m) {
        out += m[0];
        i += m[0].length;
        sawAnsi = true;
        continue;
      }
    }
    out += s[i];
    visible += 1;
    i += 1;
  }
  return sawAnsi ? out + '\x1b[0m' : out;
}

export function boxTop(width: number): string {
  return TL + H.repeat(width) + TR;
}

export function boxBottom(width: number): string {
  return BL + H.repeat(width) + BR;
}

export function boxLine(content: string, width: number): string {
  const inner = ' ' + content;
  const visible = visibleLength(inner);
  if (visible >= width) {
    return V + truncateVisible(inner, width) + V;
  }
  return V + inner + ' '.repeat(width - visible) + V;
}

/**
 * Render a titled box header — top border with the title injected just
 * after the left corner, e.g. `╭─ Setup Complete ─────╮`. Used for the
 * setup-complete summary and the /doctor + approval boxes.
 */
export function boxTopTitled(title: string, width: number): string {
  // Two leading dashes, space, title, space, then fill remaining dashes.
  const lhs = `${TL}${H}${H} ${title} `;
  const visibleLhs = 2 + 1 + visibleLength(title) + 1; // dashes + space + title + space
  const remaining = Math.max(0, width - visibleLhs);
  return `${lhs}${H.repeat(remaining)}${TR}`;
}
