/**
 * Copyright (c) 2026 Shiva Deore (Taracod). Licensed under AGPL-3.0.
 *
 * cli/v4/uiBuild.ts — Aiden v4.1 Tier-3 UI build fingerprint.
 *
 * A single source-of-truth string the smokes can `require()` from
 * the built artifact. Bumped by hand at the start of each tier-3
 * sub-phase so smoke harnesses can pin against the expected build.
 */
export const AIDEN_UI_BUILD = 'v4.1-tier3-essentials';

/**
 * Phase v4.1-skill-mining: build fingerprint for the auto-extract
 * subsystem. Bumped per skill-mining sub-phase so smokes can pin
 * against the expected build.
 */
export const AIDEN_SKILL_MINING_BUILD = 'v4.1-skill-mining';

/**
 * Phase v4.1-reply-formatting: build fingerprint for the structured
 * markdown rendering / citation footer / streaming stable-prefix
 * subsystem. Render-layer only — no agent prompts or behavior change.
 */
export const AIDEN_REPLY_FORMAT_BUILD = 'v4.1-reply-formatting';

/**
 * Phase v4.1-cross-platform: build fingerprint for the Linux / macOS
 * compatibility pass — path helpers, audio backend detection, skill
 * loader case-insensitive lookup, doctor checks per OS, CI matrix.
 */
export const AIDEN_CROSS_PLATFORM_BUILD = 'v4.1-cross-platform';

/**
 * Phase v4.1-preship-cleanup: build fingerprint for the day-one
 * polish batch — vitest baseline goes from 37 fails to 0, telegram
 * 409 path gains a local-machine polling lock to prevent same-box
 * rivals from racing.
 */
export const AIDEN_PRESHIP_BUILD = 'v4.1-preship-cleanup';

/** Predicate: is the citation footer enabled? Default off. */
export function citationsEnabled(): boolean {
  return process.env.AIDEN_CITATIONS === '1';
}

/**
 * Predicate: are we running in MCP serve mode? When true, the
 * stdout channel belongs to JSON-RPC and any UI write would corrupt
 * the wire. Tier-3 UI helpers consult this before printing.
 *
 * The MCP server CLI (cli/v4/commands/mcp.ts) sets
 * `process.env.AIDEN_MCP_SERVE = '1'` early in its boot path; that
 * env-var check is intentionally cheap and safe to read often.
 */
export function isMcpServeMode(): boolean {
  return process.env.AIDEN_MCP_SERVE === '1';
}

/**
 * Predicate: is the legacy/no-UI flag in effect? Disables tier-3
 * polish (autosuggest ghost text, inline status line, etc.) and
 * falls back to pre-tier3.1 rendering. Set by `aiden --no-ui`.
 */
export function isNoUiMode(): boolean {
  return process.env.AIDEN_NO_UI === '1';
}

/**
 * Predicate: should slash-command icons render? Default OFF; opt-in
 * via `AIDEN_UI_ICONS=1`. Lets users with emoji-friendly terminals
 * recover the previous icon column.
 */
export function uiIconsEnabled(): boolean {
  return process.env.AIDEN_UI_ICONS === '1';
}
