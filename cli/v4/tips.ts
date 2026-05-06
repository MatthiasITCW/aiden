/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/tips.ts — Aiden v4.0.0 (Phase 22)
 *
 * Rotating tip pool surfaced once per REPL boot. Hermes-pattern port —
 * see docs/sprint/_internal/hermes-ux-patterns.md §1.
 *
 * Each entry is a single short sentence covering one feature. The pool is
 * intentionally small at v4 launch (~10) so every line points at something
 * users genuinely benefit from learning — no filler.
 */

const SOUL_PATH_HINT =
  process.platform === 'win32'
    ? '%LOCALAPPDATA%\\aiden\\SOUL.md'
    : '~/.aiden/SOUL.md';

export const TIPS: readonly string[] = [
  'Type /help to see what I can do.',
  'Press Ctrl+C to cancel anything.',
  "Run 'aiden doctor' to diagnose issues.",
  '/yolo skips approvals (use carefully).',
  '/personality concise for shorter responses.',
  `Edit ${SOUL_PATH_HINT} to customize my identity.`,
  '/streaming on shows tokens as they generate.',
  'Skills (try /skills) are pre-built workflows for common tasks.',
  "'aiden setup model' to switch between providers.",
  "Memory persists across sessions — try 'remember that...'",
] as const;

/**
 * Return a uniformly random tip. `rand` is injectable so tests can pin
 * the selection.
 */
export function getRandomTip(rand: () => number = Math.random): string {
  if (TIPS.length === 0) return '';
  const idx = Math.floor(rand() * TIPS.length);
  return TIPS[Math.max(0, Math.min(TIPS.length - 1, idx))];
}
