/**
 * Copyright (c) 2026 Shiva Deore (Taracod). Licensed under AGPL-3.0.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/replyRenderer.ts — Phase v4.1-reply-formatting
 *
 * Configures marked-terminal with skin-aware renderers so Aiden's
 * agent replies render as structured markdown instead of raw walls
 * of text. Headers, lists, code blocks, blockquotes, inline emphasis,
 * and links all get terminal-friendly painting.
 *
 * The renderer is an instance — `getReplyRenderer().render(text)`
 * returns the painted string. Used by:
 *   - `display.markdown(text)` (non-streaming agent reply)
 *   - `display.streamComplete()` (post-stream re-render, optional)
 *   - the citation footer composer
 *
 * Stable-prefix split for streaming lives in `streamingPrefix.ts`
 * (pure function over the buffered text); this module is only the
 * static renderer.
 *
 * NO_COLOR honour: the skin engine already returns plain text when
 * `NO_COLOR` is set, so every paint call gracefully degrades.
 */

import { marked } from 'marked';
import { getSkinEngine } from './skinEngine';
import { highlightCode, isSupportedLang } from './syntaxHighlight';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const TerminalRenderer = require('marked-terminal').default ?? require('marked-terminal');

type Painter = (text: string) => string;

function paint(kind: 'brand' | 'heading' | 'muted' | 'agent' | 'tool' | 'success' | 'warn' | 'error' | 'accent'): Painter {
  return (text: string) => getSkinEngine().applyColors(text, kind);
}

/**
 * Render a fenced code block: top divider with language label, body
 * with optional syntax highlighting, bottom divider.
 *
 *     ── typescript ─────────────
 *       const x = 1;
 *     ──────────────────────────
 *
 * Used by the prototype-override path below — marked-terminal's
 * internal `Renderer.prototype.code` ignores user `opts.code` and
 * runs its own highlighter, so we override the prototype method
 * directly. The token-object signature is what marked v15 calls
 * the renderer with; the older positional path is kept for
 * compatibility.
 */
function renderCodeBlock(code: string, lang: string | undefined): string {
  const sk = getSkinEngine();
  const width = Math.min(process.stdout.columns ?? 80, 100) - 4;
  const langLabel = (lang ?? '').trim();
  const top = langLabel
    ? `── ${langLabel} ${'─'.repeat(Math.max(0, width - langLabel.length - 4))}`
    : '─'.repeat(width);
  const bot = '─'.repeat(width);
  const body = isSupportedLang(langLabel)
    ? highlightCode(code, langLabel)
    : code;
  const indented = body.split('\n').map((ln) => `  ${ln}`).join('\n');
  return [
    sk.applyColors(top, 'muted'),
    indented,
    sk.applyColors(bot, 'muted'),
    '',
  ].join('\n') + '\n';
}

/**
 * Render a block quote with a `┃` left rail in muted colour.
 * Multi-line quotes get the rail on every line.
 */
function renderBlockquote(quote: string): string {
  const rail = paint('muted')('┃ ');
  return quote
    .split('\n')
    .map((ln) => (ln.length === 0 ? rail.trimEnd() : `${rail}${ln}`))
    .join('\n') + '\n';
}

/**
 * Marked-terminal heading callback gets the rendered heading text +
 * level. We paint h1 in brand-bold, h2 in brand, h3+ in heading.
 */
function renderHeading(text: string, level: number, _raw: string): string {
  if (level <= 1) return paint('brand')(text.toUpperCase()) + '\n\n';
  if (level === 2) return paint('brand')(text) + '\n\n';
  return paint('heading')(text) + '\n\n';
}

/**
 * List items get a `▸ ` glyph in muted; numbered lists keep their
 * numeric prefix (marked-terminal already prepends `N.` for ordered
 * lists, so we just paint the body).
 */
function renderListItem(text: string): string {
  // marked-terminal feeds us the rendered child text. Strip its
  // default tab prefix so our two-space indent stays consistent.
  const body = text.replace(/^\s+/, '');
  return `  ${paint('muted')('▸')} ${body}\n`;
}

/**
 * Singleton — caching is fine since options bind to the active skin
 * via paint callbacks (which read getSkinEngine() each call).
 */
let cachedRenderer: { render: (text: string) => string } | null = null;

export function getReplyRenderer(): { render: (text: string) => string } {
  if (cachedRenderer) return cachedRenderer;

  // marked-terminal's `opts.<X>` callbacks are invoked with ALREADY-
  // assembled strings, not raw token data — they're meant for ANSI
  // wrapping, not structural override. So `opts.code` for example is
  // never actually called for fenced blocks: marked-terminal's
  // prototype.code runs its own internal highlighter and skips opts.
  // To emit our structured code blocks (top divider + lang label +
  // syntax highlight + bottom divider) we override the prototype
  // method directly below.
  const opts = {
    blockquote:   renderBlockquote,
    heading:      renderHeading,
    firstHeading: (text: string, _level: number, _raw: string) => paint('brand')(text.toUpperCase()) + '\n\n',
    hr:           () => paint('muted')('─'.repeat(Math.min(process.stdout.columns ?? 80, 100) - 4)) + '\n',
    listitem:     renderListItem,
    paragraph:    (text: string) => `${text}\n\n`,
    strong:       paint('brand'),
    em:           paint('muted'),
    codespan:     (text: string) => paint('accent')(`\`${text}\``),
    del:          paint('muted'),
    // marked-terminal calls opts.link with the ASSEMBLED visual
    // (already OSC8-wrapped when the host terminal supports it),
    // so we just paint it.
    link:         (assembled: string) => paint('accent')(assembled),
    href:         paint('accent'),
    text:         (text: string) => text,
    width:        Math.min(process.stdout.columns ?? 80, 100),
    showSectionPrefix: false,
    reflowText:   false,
    tab:          2,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const renderer = new TerminalRenderer(opts) as any;
  // Override the prototype `code` method on this instance so we get
  // structured code blocks (divider + lang label + syntax highlight
  // + divider) instead of marked-terminal's plain yellow-highlighted
  // output. Token-object signature handles marked v15.
  renderer.code = function (code: unknown, lang?: string, _escaped?: boolean): string {
    let text: string;
    let langOut: string | undefined;
    if (typeof code === 'object' && code !== null) {
      // marked v15 passes a token object: { text, lang, escaped }.
      const tok = code as { text?: string; lang?: string };
      text    = tok.text ?? '';
      langOut = tok.lang;
    } else {
      text    = String(code ?? '');
      langOut = lang;
    }
    return renderCodeBlock(text, langOut);
  };

  // Override `link` to ALWAYS emit OSC8 hyperlinks (marked-terminal's
  // default uses `supports-hyperlinks` which returns false on piped
  // stdout — but Aiden's REPL targets modern terminals that support
  // OSC8 universally). Visible label gets accent paint; href is the
  // OSC8 target. Token-object signature handles marked v15.
  renderer.link = function (href: unknown, _title?: string, text?: string): string {
    let url:   string;
    let label: string;
    if (typeof href === 'object' && href !== null) {
      const tok = href as { href?: string; tokens?: unknown[] };
      url   = tok.href ?? '';
      label = (this as { parser?: { parseInline?: (t: unknown[]) => string } })
        .parser?.parseInline?.(tok.tokens ?? []) ?? '';
    } else {
      url   = String(href ?? '');
      label = String(text ?? url);
    }
    if (!label) label = url;
    const painted = paint('accent')(label);
    return `\x1b]8;;${url}\x1b\\${painted}\x1b]8;;\x1b\\`;
  };

  cachedRenderer = {
    render(text: string): string {
      try {
        // Bind the renderer globally before each parse — marked v15
        // applies the renderer at parse time, so re-setting before
        // each call is safe and ensures our custom options win even
        // if other code transiently swaps the renderer.
        marked.setOptions({ renderer: renderer as never });
        const out = marked.parse(text);
        return typeof out === 'string' ? out : String(out);
      } catch {
        return text;
      }
    },
  };
  return cachedRenderer;
}

/** Test reset — drops the cached renderer so a skin change picks up. */
export function _resetForTests(): void {
  cachedRenderer = null;
}
