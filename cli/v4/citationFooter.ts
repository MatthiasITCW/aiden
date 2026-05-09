/**
 * Copyright (c) 2026 Shiva Deore (Taracod). Licensed under AGPL-3.0.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/citationFooter.ts — Phase v4.1-reply-formatting
 *
 * Optional post-reply "Sources" footer. Detects URLs in recent
 * tool-call results (fetch_url, web_fetch, web_search, open_url,
 * fetch_page) and renders a numbered list at the end of an agent
 * turn. Default OFF — gated on `AIDEN_CITATIONS=1`.
 *
 *     ──────
 *     Sources
 *       [1] forbes.com/sites/craigsmith/...
 *       [2] safe.ai/newsletter
 */

import { getSkinEngine } from './skinEngine';

interface ToolTraceLike {
  name:    string;
  args?:   unknown;
  result?: unknown;
}

const SOURCE_TOOL_RE = /^(fetch_url|fetch_page|web_search|web_fetch|open_url|browser_get_url|browser_extract|deep_research)$/i;
const URL_RE = /\bhttps?:\/\/[^\s<>"'\\)\]]+/g;
const MAX_DISPLAY_LEN = 80;

/** Strip `https?://` and trailing slashes for compact display. */
function shortenUrl(url: string): string {
  let s = url.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (s.length > MAX_DISPLAY_LEN) s = s.slice(0, MAX_DISPLAY_LEN - 1) + '…';
  return s;
}

/**
 * Walk a trace, emit deduplicated URLs in first-seen order. Only
 * traces whose tool name matches `SOURCE_TOOL_RE` contribute. Both
 * args and result are scanned — args catch the `url:` arg, result
 * catches URLs returned in extracted text.
 */
export function extractSources(trace: ToolTraceLike[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of trace) {
    if (!SOURCE_TOOL_RE.test(entry.name)) continue;
    const blob = JSON.stringify({ args: entry.args ?? null, result: entry.result ?? null });
    const matches = blob.match(URL_RE);
    if (!matches) continue;
    for (const url of matches) {
      // Strip trailing punctuation that the regex sometimes catches.
      const clean = url.replace(/[.,;:!?]+$/, '');
      if (!seen.has(clean)) {
        seen.add(clean);
        out.push(clean);
      }
    }
  }
  return out;
}

/**
 * Build the rendered footer string. Returns an empty string when
 * there are no sources to surface (caller can skip the line entirely).
 *
 * The OSC8 wrapper makes URLs clickable in modern terminals; the
 * visible label is the shortened form for compact display.
 */
export function buildCitationFooter(sources: string[]): string {
  if (sources.length === 0) return '';
  const sk = getSkinEngine();
  const m = (s: string): string => sk.applyColors(s, 'muted');
  const lab = (s: string): string => sk.applyColors(s, 'brand');
  const val = (s: string): string => sk.applyColors(s, 'accent');

  const rule = m('──────');
  const header = lab('Sources');
  const lines = sources.map((url, i) => {
    const idx = m(`[${i + 1}]`);
    const display = shortenUrl(url);
    // OSC8 hyperlink — the visible text is `display`, the link target
    // is the full URL.
    const linked = `\x1b]8;;${url}\x1b\\${val(display)}\x1b]8;;\x1b\\`;
    return `  ${idx} ${linked}`;
  });
  return [rule, header, ...lines, ''].join('\n') + '\n';
}

/**
 * Convenience: extract + build in one go. Returns '' when the env
 * gate is off or no sources surface.
 */
export function renderCitationFooter(trace: ToolTraceLike[]): string {
  if (process.env.AIDEN_CITATIONS !== '1') return '';
  const sources = extractSources(trace);
  return buildCitationFooter(sources);
}
