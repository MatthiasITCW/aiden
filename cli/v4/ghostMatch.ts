/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/ghostMatch.ts — Tier-3.1.1 (v4.1-tier3.1.1)
 *
 * Compute the best ghost-text match for what the user has typed so far.
 * The aidenPrompt component calls `findGhost(typed, ctx)` on every
 * keystroke and renders the returned suggestion (in dim) past the
 * cursor.
 *
 * Two modes:
 *
 *   1. Slash mode (typed starts with `/`): match against registered
 *      slash command names + aliases. Longest start-with match wins
 *      (so `/p` favours `/plugins` over `/personality`/`/providers`
 *      only if no shorter unique match exists; ties broken by
 *      alphabetical order so the result is deterministic).
 *
 *   2. Free-text mode: match against recent user prompts (most recent
 *      first). Returns the first prompt that starts with `typed` and
 *      is strictly longer.
 *
 * Returns the SUFFIX to append after the typed text, or `null` if no
 * match exists. Empty/whitespace-only typed text → null. Typed text
 * containing a paste-compression label (`[paste #N: …]`) → null
 * (don't suggest over a compressed paste).
 */

const PASTE_LABEL_RE = /\[paste #\d+:[^\]]*\]/;

export interface GhostContext {
  /** Active slash command names (no leading slash). */
  slashNames: string[];
  /** Active slash command aliases (no leading slash). */
  slashAliases: string[];
  /** Recent user prompts, newest first. */
  history: string[];
}

/**
 * Return the suffix to append (everything past `typed`) or null.
 *
 * Examples:
 *   findGhost('/cr',  { slashNames: ['cron','clear'], … }) → 'on'
 *   findGhost('/x',   { slashNames: ['cron'], … })          → null
 *   findGhost('how ', { history: ['how do I quit'], … })    → 'do I quit'
 */
export function findGhost(typed: string, ctx: GhostContext): string | null {
  if (!typed || typed.trim().length === 0) return null;
  if (PASTE_LABEL_RE.test(typed)) return null;

  if (typed.startsWith('/')) {
    const stem = typed.slice(1);
    if (stem.length === 0) return null;
    const all = [...ctx.slashNames, ...ctx.slashAliases];
    // Longest start-with match wins. Ties broken alphabetically.
    const candidates = all
      .filter((n) => n.startsWith(stem) && n.length > stem.length)
      .sort();
    if (candidates.length === 0) return null;
    // Prefer the SHORTEST candidate that uniquely starts with stem
    // (more likely the user-intended completion). Fall back to the
    // alphabetically-first if all share the same length.
    const shortest = candidates.reduce((best, c) =>
      c.length < best.length ? c : best,
    );
    return shortest.slice(stem.length);
  }

  // Free-text — history fallback. Prefer the most-recent strict
  // start-with match.
  for (const past of ctx.history) {
    if (past.startsWith(typed) && past.length > typed.length) {
      return past.slice(typed.length);
    }
  }
  return null;
}
