/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/themeDetect.ts — Phase v4.1-tier3-essentials
 *
 * Multi-signal auto theme detection. The skin engine consults this
 * once at boot when the configured skin is `auto`; otherwise the
 * explicitly-named skin wins.
 *
 * Priority order (first non-undefined hit wins):
 *
 *   1. AIDEN_THEME=light|dark         — explicit override
 *   2. AIDEN_THEME=auto / unset goes through 2..5
 *   3. NO_COLOR set                   — forced monochrome
 *   4. COLORFGBG="<fg>;<bg>"          — slot 7 or 15 = light, others = dark
 *   5. TERM_PROGRAM allow-list        — Apple_Terminal default to light
 *   6. Fallback: dark
 *
 * Returns 'light' / 'dark' / 'mono'. The skin engine maps:
 *   'mono'  → monochrome skin (no colour)
 *   'light' → light skin
 *   'dark'  → default skin
 */

export type DetectedTheme = 'light' | 'dark' | 'mono';

const LIGHT_DEFAULT_TERM_PROGRAMS: ReadonlySet<string> = new Set([
  // Apple Terminal default profile is on a light background.
  'Apple_Terminal',
]);

/**
 * Run the multi-signal detection. Pure function — env can be
 * overridden for tests.
 */
export function detectTheme(env: NodeJS.ProcessEnv = process.env): DetectedTheme {
  const explicit = (env.AIDEN_THEME ?? '').trim().toLowerCase();
  if (explicit === 'light') return 'light';
  if (explicit === 'dark')  return 'dark';
  if (explicit === 'mono' || explicit === 'monochrome') return 'mono';

  // NO_COLOR (https://no-color.org) — monochrome is its own theme,
  // independent of light/dark, so it wins over the auto path.
  if (env.NO_COLOR != null && env.NO_COLOR !== '') return 'mono';

  // COLORFGBG = "<fg>;<bg>" where slot 7 (light grey) or 15 (white)
  // signals a light terminal background. Other slots = dark.
  const colorfgbg = (env.COLORFGBG ?? '').trim();
  if (colorfgbg) {
    const parts = colorfgbg.split(';');
    const lastField = parts[parts.length - 1] ?? '';
    if (/^\d+$/.test(lastField)) {
      const bg = Number(lastField);
      if (bg === 7 || bg === 15) return 'light';
      if (bg >= 0 && bg < 16)    return 'dark';
    }
  }

  // TERM_PROGRAM allow-list.
  const termProgram = (env.TERM_PROGRAM ?? '').trim();
  if (LIGHT_DEFAULT_TERM_PROGRAMS.has(termProgram)) return 'light';

  // Fallback.
  return 'dark';
}

/** Surfaced for skinEngine integration: maps DetectedTheme → skin name. */
export function detectedToSkinName(theme: DetectedTheme): string {
  switch (theme) {
    case 'light': return 'light';
    case 'mono':  return 'monochrome';
    case 'dark':
    default:      return 'default';
  }
}
