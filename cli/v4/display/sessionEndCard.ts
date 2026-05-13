/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/display/sessionEndCard.ts — Aiden v4.1.3-repl-polish
 *
 * Renders a compact session-end summary card from a SessionDistillation.
 *
 * Returned as an array of plain lines (WITHOUT trailing '\n'). The caller
 * writes them with a newline appended, e.g.:
 *
 *   for (const line of renderSessionEndCard(dist, colorize)) {
 *     display.write(line + '\n');
 *   }
 *
 * Design rules (from spec):
 *   - Skip entirely when user_turns === 0 (silent/internal sessions).
 *   - Label column is colon-aligned to column LABEL_COL (14).
 *   - Session ID rendered in 'session' color (soft cyan).
 *   - Bullets / decisions / open_items shown only when non-empty.
 *   - Takes a `colorize` callback instead of a SkinEngine directly, so
 *     the function is fully unit-testable without a Display stack.
 */

import type { SessionDistillation } from '../../../core/v4/sessionDistiller';
import type { ColorKind } from '../skinEngine';

/** Width of the "Label:" prefix, colon included, padded to this column. */
const LABEL_COL = 14;

/** Horizontal rule width (chars). */
const HR_WIDTH = 48;

type Colorize = (text: string, kind: ColorKind) => string;

// ── Internal helpers ──────────────────────────────────────────────────────────

function labelRow(label: string, value: string): string {
  return `${`${label}:`.padEnd(LABEL_COL)}${value}`;
}

/**
 * Format a wall-clock duration from two ISO timestamps.
 * Returns '—' when the delta is ≤0 or non-finite (e.g. partial distillation).
 */
function fmtDuration(startIso: string, endIso: string): string {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const sec = ms / 1000;
  if (sec < 60) return `${Math.round(sec)}s`;
  const mins = Math.floor(sec / 60);
  const remSec = Math.round(sec - mins * 60);
  return remSec > 0 ? `${mins}m ${remSec}s` : `${mins}m`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Render a session-end card from `dist`.
 *
 * @param dist              Completed SessionDistillation (may be partial).
 * @param colorize          Skin-aware colorizer — `(text, kind) => coloredText`.
 * @param distillationPath  Absolute path the distillation JSON was written to,
 *                          if any. Rendered as a `Distillation:` row so the
 *                          user has something concrete to inspect / pass to
 *                          recall_session. Omitted from the card when null /
 *                          undefined (e.g. write failed earlier).
 * @returns                 Array of lines (no trailing newlines). Empty when
 *                          `user_turns === 0`.
 */
export function renderSessionEndCard(
  dist: SessionDistillation,
  colorize: Colorize,
  distillationPath?: string | null,
): string[] {
  if (dist.user_turns === 0) return [];

  const lines: string[] = [];
  const hr = colorize('─'.repeat(HR_WIDTH), 'muted');
  const bullet = colorize('•', 'muted');

  // ── Header block ───────────────────────────────────────────────────────
  lines.push(hr);
  lines.push(labelRow('Session', colorize(dist.session_id, 'session')));
  lines.push(labelRow('Duration', fmtDuration(dist.started_at, dist.ended_at)));
  lines.push(labelRow('Turns', String(dist.user_turns)));
  lines.push(labelRow('Exit', dist.exit_path));

  if (dist.files_touched.length > 0) {
    // Show at most 6 files; truncate list with '…' if longer.
    const shown = dist.files_touched.slice(0, 6);
    const suffix = dist.files_touched.length > 6
      ? ` … +${dist.files_touched.length - 6} more`
      : '';
    lines.push(labelRow('Files', shown.join(', ') + suffix));
  } else {
    lines.push(labelRow('Files', colorize('(none)', 'muted')));
  }

  if (dist.tools_used.length > 0) {
    const top = [...dist.tools_used]
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map(t => `${t.name}(${t.count})`)
      .join(', ');
    lines.push(labelRow('Tools', top));
  }

  if (distillationPath) {
    lines.push(labelRow('Distillation', colorize(distillationPath, 'muted')));
  }

  lines.push(hr);

  // ── Semantic sections (LLM-generated, may be empty on partial) ─────────
  if (dist.bullets.length > 0) {
    lines.push('');
    lines.push(colorize('What happened:', 'heading'));
    for (const b of dist.bullets) {
      lines.push(`  ${bullet} ${b}`);
    }
  }

  if (dist.decisions.length > 0) {
    lines.push('');
    lines.push(colorize('Decisions:', 'heading'));
    for (const d of dist.decisions) {
      lines.push(`  ${bullet} ${d}`);
    }
  }

  if (dist.open_items.length > 0) {
    lines.push('');
    lines.push(colorize('Open items:', 'heading'));
    for (const o of dist.open_items) {
      lines.push(`  ${bullet} ${o}`);
    }
  }

  // Blank line so "Goodbye." has breathing room.
  lines.push('');

  return lines;
}
