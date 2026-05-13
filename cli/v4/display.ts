/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/display.ts — Aiden v4.0.0 (Phase 14a)
 *
 * Aiden's CLI display layer.
 *
 * Responsibilities:
 *   - render the welcome banner
 *   - render markdown to ANSI for the terminal (marked + marked-terminal)
 *   - format user/agent/tool/error turns with skin-aware colour
 *   - drive a lightweight spinner that works on Windows ConPTY
 *
 */

import { marked } from 'marked';
// marked-terminal exports a CommonJS factory.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const TerminalRenderer: new (opts?: unknown) => unknown = require('marked-terminal').default ?? require('marked-terminal');

import { SkinEngine, getSkinEngine, type ColorKind } from './skinEngine';
import { visibleLength, truncateVisible } from './box';
import {
  iconForTool as trailIconForTool,
  padVerb,
  truncDetail,
  TRAIL_PIPE,
  TRAIL_VERB_PAD,
  TRAIL_DETAIL_CAP,
} from './display/toolTrail';
// Phase v4.1-reply-formatting: skin-aware markdown renderer that
// replaces marked-terminal's defaults with structured headers, lists,
// code blocks, blockquotes, and links.
import { getReplyRenderer } from './replyRenderer';
// Optional "Sources" footer when AIDEN_CITATIONS=1 (default off).
import { renderCitationFooter } from './citationFooter';
import { buildToolPreview } from './toolPreview';

export interface SpinnerHandle {
  stop(finalText?: string): void;
  setText(text: string): void;
}

/**
 * Phase 26.2.4 — a labelled section for the boot card's two-column
 * Environment/Capabilities block. `key` is rendered in muted, `value`
 * in default text. Title is rendered in brand orange.
 */
export interface ColumnSection {
  title: string;
  rows: Array<{ key: string; value: string }>;
}

/**
 * v4.1.3-repl-polish — category emoji icons for the tool-row trail.
 * Icons are ON by default (AIDEN_UI_ICONS !== '0'). Set
 * `AIDEN_UI_ICONS=0` to disable them (CI / dumb terminals).
 *
 * Kept as a flat Record for backward-compat with smoke tests that
 * import it directly. The canonical lookup now lives in
 * `./display/toolTrail` (supports verb too); this map is derived
 * from it for legacy reference.
 *
 * Matching order: exact lowercased name, then substring, then 'default'.
 */
export const TOOL_ICONS: Readonly<Record<string, string>> = {
  // Observe / read
  file_read: '👁', read_file: '👁', file_list: '👁', list_directory: '👁',
  observe: '👁', read: '👁', list: '👁',
  // Write / edit
  file_write: '✏', write_file: '✏', edit_file: '✏',
  write: '✏', edit: '✏', create: '✏',
  // Execute / run
  bash: '⚡', powershell: '⚡', execute_code: '⚡', skill_view: '⚡',
  execute: '⚡', run: '⚡',
  // Web / browse
  web_search: '🌐', web_fetch: '🌐', fetch_url: '🌐', open_url: '🌐',
  navigate: '🌐', browser: '🌐', fetch: '🌐', search: '🌐',
  // Memory / recall
  recall_session: '🧠', session_search: '🧠', memory: '🧠', recall: '🧠',
  // Think
  session_summary: '🧠', analyze: '🧠', think: '🧠',
  // Skills / catalog
  skills_list: '📋', skill: '📋',
  // Screen / capture
  screenshot: '🖥', computer: '🖥',
  // Media / launch
  now_playing: '▶', app_launch: '▶', media: '▶',
  // Deploy / build
  deploy: '📦', build: '📦', push: '📦',
  // Message / send
  send: '💬', message: '💬', notify: '💬',
  // Verify / test
  verify: '🛡', test: '🛡', doctor: '🛡', health: '🛡',
  // Default fallback
  default: '·',
};

/**
 * Return the category emoji for `toolName`, or '·' when nothing matches.
 * Delegates to the canonical toolTrail lookup (returns icon only).
 * Exported for backward-compat with existing smoke / unit tests.
 */
export function iconForTool(toolName: string): string {
  return trailIconForTool(toolName).icon;
}

/**
 * Phase 26.2.6 — pool of fun spinner phrases that the chat REPL
 * picks from per-turn. Replaces the static "Initializing agent…"
 * text with a touch of personality. Single-pick-per-turn (not a
 * mid-spin rotation) — keeps the line stable while the model thinks.
 */
export const SPINNER_PHRASES: readonly string[] = [
  'Thinking',
  'Pondering',
  'Brewing',
  'Cogitating',
  'Reasoning',
  'Computing',
  'Reflecting',
  'Considering',
  'Processing',
  'Brain yakka',
  'Untangling',
  'Synthesizing',
  'Working',
  'Crunching',
  'Plotting',
  'Hatching plans',
  'Caffeinating',
  'Thinking hard',
  'Smelting',
  'Conjuring',
];

/**
 * Phase v4.1-1 — boot card "channels" pill helpers. The CLI process
 * doesn't actually run channel adapters (those live in the API server)
 * so we report what we *can* honestly know from the environment: how
 * many of the nine channel adapters have their credentials present.
 *
 * `summarizeConfiguredChannels` returns a render-ready label like
 * `"3 configured (incl. telegram)"` for the Environment column.
 */
const CHANNEL_ENV_VARS: ReadonlyArray<{ id: string; vars: readonly string[] }> = [
  { id: 'telegram', vars: ['TELEGRAM_BOT_TOKEN'] },
  { id: 'discord',  vars: ['DISCORD_BOT_TOKEN'] },
  { id: 'slack',    vars: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'] },
  { id: 'whatsapp', vars: ['WHATSAPP_BUSINESS_API_KEY'] },
  { id: 'twilio',   vars: ['TWILIO_AUTH_TOKEN'] },
  { id: 'imessage', vars: ['BLUEBUBBLES_PASSWORD'] },
  { id: 'email',    vars: ['EMAIL_IMAP_PASSWORD', 'EMAIL_SMTP_PASSWORD'] },
];

export interface ChannelConfiguredCount {
  /** Total number of channels with at least one credential env var set. */
  total: number;
  /** Provider ids that count toward `total` (helpful for tests). */
  ids: string[];
  /** True when `TELEGRAM_BOT_TOKEN` is present — drives the boot pill suffix. */
  telegram: boolean;
}

export function detectConfiguredChannels(
  env: NodeJS.ProcessEnv = process.env,
): ChannelConfiguredCount {
  const ids: string[] = [];
  for (const c of CHANNEL_ENV_VARS) {
    if (c.vars.some((v) => typeof env[v] === 'string' && env[v]!.trim() !== '')) {
      ids.push(c.id);
    }
  }
  return { total: ids.length, ids, telegram: ids.includes('telegram') };
}

export function summarizeConfiguredChannels(
  detection: ChannelConfiguredCount = detectConfiguredChannels(),
): string {
  if (detection.total === 0) return '0 configured';
  const suffix = detection.telegram ? ' (incl. telegram)' : '';
  return `${detection.total} configured${suffix}`;
}

/**
 * Phase v4.1-1.1 — boot-card "channels" pill that distinguishes
 * "configured but offline" from "active". The CLI now hosts a
 * `ChannelManager` directly (not just env-var counting), so we can
 * report real liveness:
 *
 *   ● 0 configured (run /channel telegram add to enable)
 *   ● 1 active: telegram (@bot)
 *   ● 1 configured: telegram (offline — run /channel telegram status)
 *   ● 2 active: telegram (@bot), discord
 *
 * The label always renders — empty state is a teaching surface, not
 * something to hide. When no manager is supplied we fall back to the
 * env-only summary so non-CLI callers still get a sensible string.
 */
export interface ChannelStateProbe {
  /** Per-adapter liveness — pass adapters whose isHealthy() can be queried. */
  adapters: ReadonlyArray<{
    id:          string;
    healthy:     boolean;
    /** Optional friendly handle (e.g. Telegram bot @username). */
    botHandle?:  string | null;
    /**
     * Phase v4.1-1.2 — coarse state for adapters that distinguish
     * `conflict` (another aiden instance is polling) from a generic
     * unhealthy. Only the Telegram adapter currently emits this; other
     * adapters will adopt it as Phase 2 lands.
     */
    state?:      'inactive' | 'connecting' | 'active' | 'degraded' | 'conflict';
  }>;
}

export function summarizeChannelState(
  probe: ChannelStateProbe | null,
  envFallback: ChannelConfiguredCount = detectConfiguredChannels(),
): string {
  // No live probe (e.g. test harness with no manager) → env-only count.
  if (!probe) {
    if (envFallback.total === 0) {
      return '0 configured (run /channel telegram add to enable)';
    }
    return `${envFallback.total} configured${envFallback.telegram ? ' (incl. telegram)' : ''}`;
  }

  // Phase v4.1-1.2 — conflict takes priority over the generic active /
  // offline split. If any adapter is in the conflict state, surface
  // that explicitly so the user has an unambiguous remediation hint.
  const conflicted = probe.adapters.filter((a) => a.state === 'conflict');
  if (conflicted.length > 0) {
    const names = conflicted.map((a) => a.id).join(', ');
    return `${conflicted.length} degraded: ${names} (conflict — /channel telegram takeover)`;
  }

  const active   = probe.adapters.filter((a) => a.healthy);
  const inactive = probe.adapters.filter((a) => !a.healthy);

  if (active.length === 0) {
    if (envFallback.total === 0) {
      return '0 configured (run /channel telegram add to enable)';
    }
    // Token in env but adapter not healthy — frame it as offline so
    // the user knows /channel telegram status is the next step.
    const offlineNames = inactive
      .filter((a) => envFallback.ids.includes(a.id))
      .map((a) => a.id)
      .join(', ');
    return offlineNames
      ? `${envFallback.total} configured: ${offlineNames} (offline — /channel telegram status)`
      : `${envFallback.total} configured`;
  }

  const parts = active.map((a) => (a.botHandle ? `${a.id} (@${a.botHandle})` : a.id));
  return `${active.length} active: ${parts.join(', ')}`;
}

export interface AgentTurnOptions {
  /** Render markdown via `markdown()` before printing. Default: true. */
  markdown?: boolean;
  /** Optional reasoning preface (rendered muted). */
  reasoning?: string;
}

const AIDEN_BANNER = String.raw`
█████╗  ██╗██████╗ ███████╗███╗   ██╗
██╔══██╗██║██╔══██╗██╔════╝████╗  ██║
███████║██║██║  ██║█████╗  ██╔██╗ ██║
██╔══██║██║██║  ██║██╔══╝  ██║╚██╗██║
██║  ██║██║██████╔╝███████╗██║ ╚████║
╚═╝  ╚═╝╚═╝╚═════╝ ╚══════╝╚═╝  ╚═══╝
`;

export class Display {
  private skin: SkinEngine;
  private out: NodeJS.WriteStream;
  private err: NodeJS.WriteStream;

  constructor(opts: { skin?: SkinEngine; stdout?: NodeJS.WriteStream; stderr?: NodeJS.WriteStream } = {}) {
    this.skin = opts.skin ?? getSkinEngine();
    this.out = opts.stdout ?? process.stdout;
    this.err = opts.stderr ?? process.stderr;
    try {
      marked.setOptions({ renderer: new TerminalRenderer() as never });
    } catch {
      // marked-terminal optional — markdown() falls back to raw text below
    }
  }

  /**
   * v4.1.3-repl-polish — public colour gate so callers (e.g. session-end
   * card renderer) can colour text without importing SkinEngine directly.
   * Delegates to the active skin's applyColors(). Monochrome mode is
   * respected the same way as internal calls.
   */
  applyColors(text: string, kind: ColorKind): string {
    return this.skin.applyColors(text, kind);
  }

  /**
   * Build the welcome banner string (does not write).
   *
   * Phase 23.6 (v3 visual style port): banner is the AIDEN block ASCII
   * art only, in brand orange, indented two columns to match the rest
   * of the boot card.  Status / session / version / ready lines are
   * emitted by chatSession.renderStartupCard so the banner stays a
   * typographic anchor, not a catalog.  `opts.tip` is accepted for
   * backward compat but ignored.
   */
  banner(_version = '4.0.0', _opts: { tip?: string } = {}): string {
    const sk = this.skin;
    const lines = AIDEN_BANNER.split('\n').map((l) =>
      l ? `  ${sk.applyColors(l, 'brand')}` : '',
    );
    return `${lines.join('\n')}\n`;
  }

  /** Print the banner. `opts.tip` accepted for backward compat; unused. */
  printBanner(version?: string, opts: { tip?: string } = {}): void {
    this.out.write(this.banner(version, opts));
  }

  // ── Phase 23.6 — v3 visual primitives ──────────────────────────────────
  // Pure renderers (return strings, don't write) so chatSession can
  // compose the boot card and turn rhythm without owning ANSI escapes.

  /** Terminal column count clamped to 100 — matches v3 width discipline. */
  cols(): number {
    return Math.min(this.out.columns ?? 80, 100);
  }

  /**
   * Thin horizontal rule (`──…──`) in muted colour, full visible width
   * minus the 2-column indent the boot card / turn render uses.  Returns
   * the line WITHOUT a trailing newline; caller adds one + the leading
   * 2-space indent.
   */
  rule(width?: number): string {
    const w = Math.max(8, (width ?? this.cols()) - 2);
    return this.skin.applyColors('─'.repeat(w), 'muted');
  }

  /** Render `▲` (brand-orange filled triangle) — Aiden's identity motif. */
  triangle(): string {
    return this.skin.applyColors('▲', 'brand');
  }

  /** Render `●` filled dot in success green (active state). */
  dotOn(): string {
    return this.skin.applyColors('●', 'success');
  }

  /** Render `○` hollow dot in muted (inactive state). */
  dotOff(): string {
    return this.skin.applyColors('○', 'muted');
  }

  /** Wrap text in success colour. */
  success_(text: string): string {
    return this.skin.applyColors(text, 'success');
  }

  /** Wrap text in warn colour. */
  warn_(text: string): string {
    return this.skin.applyColors(text, 'warn');
  }

  /** Wrap text in error colour. */
  error_(text: string): string {
    return this.skin.applyColors(text, 'error');
  }

  /**
   * Phase 26.2.8 — HH:MM:SS muted timestamp prefix used when
   * `AIDEN_UI_TIMESTAMPS=1`. Returns the wrapped 8-char string
   * (`12:41:02`) in muted; the caller owns the trailing spacer.
   * `d` is injectable so tests can pin the time.
   */
  timestampPrefix(d: Date = new Date()): string {
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return this.skin.applyColors(`${hh}:${mm}:${ss}`, 'muted');
  }

  /**
   * Phase 26.2.3 — single-line assistant header in the
   * `┃ Aiden` style. `┃` (U+2503 heavy vertical) and `Aiden` are
   * both brand-orange. The thin rule that previously sat under the
   * label is gone — the per-turn separator (printed BEFORE the user
   * prompt by chatSession) carries that visual weight now.
   *
   * Phase 26.2.8 — when `AIDEN_UI_TIMESTAMPS=1`, prepends a muted
   * `HH:MM:SS  ` prefix in front of the indented `┃ Aiden`. The
   * existing 2-space indent is replaced by the 10-char timestamp
   * gutter so the bar and label shift right to align with the
   * gutter. Default OFF preserves the exact current shape.
   *
   * Returns one indented line with a trailing newline.
   */
  agentHeader(): string {
    const bar = this.skin.applyColors('┃', 'brand');
    const head = this.skin.applyColors('Aiden', 'brand');
    if (process.env.AIDEN_UI_TIMESTAMPS === '1') {
      return `${this.timestampPrefix()}  ${bar} ${head}\n`;
    }
    return `  ${bar} ${head}\n`;
  }

  /**
   * Phase 26.2.3 — turn boundary marker. Writes a thin muted rule
   * followed by a blank line. Called by `chatSession` BEFORE each
   * user-input read except the first (boot card already emits a
   * rule + blank). Single canonical separator for the conversation
   * surface.
   */
  printTurnSeparator(): void {
    this.out.write(`  ${this.rule()}\n\n`);
  }

  /**
   * Render the v3-style boot status line:
   *
   *   ● <provider> <model>  ·  ● 56/72 skills  ·  43 tools  ·  ○ 0 mem
   *
   * Dots colour-graded: green ● when count > 0, muted ○ when 0.  Provider
   * dot also tracks "active" — green when provider is reachable, error
   * red otherwise (caller passes `providerOk`).
   */
  bootStatusLine(args: {
    provider: string;
    model: string;
    providerOk?: boolean;
    skillsLoaded: number;
    skillsTotal?: number;
    tools: number;
    memCount?: number;
  }): string {
    const sk = this.skin;
    const sep = sk.applyColors(' · ', 'muted');
    const provDot = args.providerOk === false
      ? sk.applyColors('●', 'error')
      : this.dotOn();
    const skillsDot = args.skillsLoaded > 0 ? this.dotOn() : this.dotOff();
    const memCount = args.memCount ?? 0;
    const memDot = memCount > 0 ? this.dotOn() : this.dotOff();
    const provModel =
      `${provDot} ${sk.applyColors(args.provider, 'brand')} ` +
      `${sk.applyColors(args.model, 'muted')}`;
    const skillCount =
      typeof args.skillsTotal === 'number' && args.skillsTotal !== args.skillsLoaded
        ? `${args.skillsLoaded}/${args.skillsTotal}`
        : `${args.skillsLoaded}`;
    const skillsSeg = `${skillsDot} ${sk.applyColors(`${skillCount} skills`, 'muted')}`;
    const toolsSeg = sk.applyColors(`${args.tools} tools`, 'muted');
    const memSeg = `${memDot} ${sk.applyColors(`${memCount} mem`, 'muted')}`;
    return `  ${provModel}${sep}${skillsSeg}${sep}${toolsSeg}${sep}${memSeg}`;
  }

  // ── Phase 26.2.4 — neofetch-style sectioned boot card helpers ─────
  // Four pure renderers used by chatSession.renderStartupCard. Each
  // returns a string with no trailing newline so the caller controls
  // vertical rhythm. None of them branch on detection — chatSession
  // is responsible for collecting the data; Display just paints it.

  /**
   * Status pills row — one line, four pills separated by 4 spaces.
   * Format: `● core online    ● mode auto    ● model X    ● memory active`.
   * Dot is success-green when on, muted when off. Label is muted, value
   * is rendered in `agent` (off-white) for legibility without competing
   * with the banner orange.
   */
  statusPillsRow(args: {
    coreOnline: boolean;
    mode: string;
    model: string;
    memoryActive: boolean;
    /**
     * Phase 30.2 (v4.0.2) — when explicitly false, the model pill renders
     * "not configured" instead of the supplied model id, and its dot fades
     * to muted. Defaults to true (no behavioural change for callers that
     * don't pass it). Used by the post-wizard / fallback paths so a
     * stale model name from config.yaml cannot mislead a fresh user.
     */
    providerOk?: boolean;
    /**
     * Phase v4.1.2-version-display — when present, append a fifth pill
     * `● v<version>` so users see the running version at boot without
     * invoking `aiden --version`. No label (the `v` prefix carries it).
     * Omitted → no version pill rendered, status row stays four-wide
     * for callers that don't thread version yet.
     */
    version?: string;
  }): string {
    const sk = this.skin;
    const dot = (on: boolean): string => sk.applyColors('●', on ? 'success' : 'muted');
    const lab = (s: string): string => sk.applyColors(s, 'muted');
    const val = (s: string): string => sk.applyColors(s, 'agent');
    const pill = (on: boolean, label: string, value: string): string =>
      `${dot(on)} ${lab(label)} ${val(value)}`;
    const providerOk = args.providerOk !== false;
    const modelValue = providerOk ? args.model : 'not configured';
    const pills = [
      pill(args.coreOnline, 'core', args.coreOnline ? 'online' : 'starting'),
      pill(true, 'mode', args.mode),
      pill(providerOk, 'model', modelValue),
      pill(args.memoryActive, 'memory', args.memoryActive ? 'active' : 'off'),
    ];
    if (args.version) {
      // Version pill: dot + value, no label (the `v` prefix is the label).
      // Always-on dot — informational, not a health indicator.
      pills.push(`${dot(true)} ${val(`v${args.version}`)}`);
    }
    return '  ' + pills.join('    ');
  }

  /**
   * Two-column block (Environment + Capabilities). Side-by-side when
   * `cols() >= 80`, stacked vertically below that. Title in brand,
   * keys in muted (padded to 11 visible chars), values in `agent`.
   */
  twoColumnBlock(
    left: ColumnSection,
    right: ColumnSection,
    opts: { sideBySideThreshold?: number } = {},
  ): string {
    const sk = this.skin;
    const cols = this.cols();
    // Tier-3.1b: callers can raise the side-by-side threshold (boot
    // card prefers stacked at 70-119 cols, side-by-side only at ≥120).
    // Default 80 preserves prior behaviour for any other caller.
    const stacked = cols < (opts.sideBySideThreshold ?? 80);
    const indent = '  ';
    const KEY_PAD = 11;

    const renderRows = (sec: ColumnSection): string[] => {
      const rows = [sk.applyColors(sec.title, 'brand')];
      for (const r of sec.rows) {
        const k = sk.applyColors(r.key.padEnd(KEY_PAD), 'muted');
        const v = sk.applyColors(r.value, 'agent');
        rows.push(`${k}${v}`);
      }
      return rows;
    };

    if (stacked) {
      const out: string[] = [];
      for (const ln of renderRows(left)) out.push(`${indent}${ln}`);
      out.push('');
      for (const ln of renderRows(right)) out.push(`${indent}${ln}`);
      return out.join('\n');
    }

    // Side-by-side. Each column capped at 40 visible chars; separator
    // is 4 spaces. At cols=80 the right column has 32 chars to work
    // with, which fits all hardcoded capability values.
    const colW = Math.min(40, Math.floor((cols - indent.length - 4) / 2));
    const sep = '    ';
    const leftRows = renderRows(left);
    const rightRows = renderRows(right);
    const maxRows = Math.max(leftRows.length, rightRows.length);
    const out: string[] = [];
    for (let i = 0; i < maxRows; i += 1) {
      const l = leftRows[i] ?? '';
      const r = rightRows[i] ?? '';
      const lVis = visibleLength(l);
      const lPadded = lVis < colW ? l + ' '.repeat(colW - lVis) : l;
      out.push(`${indent}${lPadded}${sep}${r}`);
    }
    return out.join('\n');
  }

  /**
   * Phase 26.2.5 — parchment-shaped credits footer. Replaces the
   * earlier scroll ASCII whose diagonals wouldn't align reliably in
   * a monospace cell. Layout:
   *
   *       ___________________________________________________________
   *      |                                                           |
   *      |   ♥  Built solo                                           |
   *      |   GitHub:  github.com/taracodlabs/aiden                   |
   *      |   Web:     aiden.taracod.com                              |
   *      |   Contact: contact@taracod.com                            |
   *      |___________________________________________________________|
   *
   * Top underscore lid floats one column past the left wall (the lid
   * sits *between* the pipes, not over them) — gives the parchment a
   * lifted-corner feel without using corner glyphs. Bottom is sealed.
   *
   * Width-responsive:
   *   cols >= 80 → full parchment (interior 63 chars)
   *   cols <  80 → plain 4-line text fallback (no border)
   *
   * Colours: borders in muted, ♥ in brand, field labels in brand,
   * field values in `agent` (off-white). Each colour span is its own
   * SGR open/close — no nesting — so the closing reset doesn't bleed
   * across lines.
   */
  scrollFooter(): string {
    const sk = this.skin;
    const m = (s: string): string => sk.applyColors(s, 'muted');
    const lab = (s: string): string => sk.applyColors(s, 'brand');
    const val = (s: string): string => sk.applyColors(s, 'agent');
    const heart = sk.applyColors('♥', 'brand');

    if (this.cols() < 80) {
      // Tier-3.1b: single-line credits at narrow widths so the boot
      // card stays compact. The 4-line plain fallback shipped earlier
      // wastes vertical space when terminals already squeeze content.
      return `  ${heart} ${m('built solo · github.com/taracodlabs/aiden · aiden.taracod.com')}`;
    }

    // Parchment.
    const INTERIOR = 63;
    const wallIndent = '     ';     // 5 spaces — column where the | sits
    const lidIndent = '      ';     // 6 spaces — lid floats one past the wall
    const pipe = m('|');
    const lid = m('_'.repeat(INTERIOR));

    const padInner = (text: string): string => {
      const v = visibleLength(text);
      if (v >= INTERIOR) return truncateVisible(text, INTERIOR);
      return text + ' '.repeat(INTERIOR - v);
    };

    return [
      lidIndent + lid,
      wallIndent + pipe + ' '.repeat(INTERIOR) + pipe,
      wallIndent + pipe + padInner(`   ${heart}  ${val('Built solo')}`) + pipe,
      wallIndent + pipe + padInner(`   ${lab('GitHub:')}  ${val('github.com/taracodlabs/aiden')}`) + pipe,
      wallIndent + pipe + padInner(`   ${lab('Web:')}     ${val('aiden.taracod.com')}`) + pipe,
      wallIndent + pipe + padInner(`   ${lab('Contact:')} ${val('contact@taracod.com')}`) + pipe,
      wallIndent + pipe + lid + pipe,
    ].join('\n');
  }

  /**
   * Bottom prompt hint that replaces the prior `ready ▸  /help` +
   * `✦ Tip:` lines. `▲` in brand, body in muted.
   */
  bottomPromptHint(): string {
    const sk = this.skin;
    const tri = sk.applyColors('▲', 'brand');
    const text = sk.applyColors(
      'Type your message · /help for commands · /skills to add more',
      'muted',
    );
    return `  ${tri} ${text}`;
  }

  /**
   * v3-style "ready" line:
   *
   *   ready ▸  /help for commands
   *
   * "ready" + ▸ in brand orange; trailing hint in muted.
   */
  readyLine(hint = '/help for commands'): string {
    const sk = this.skin;
    const ready = sk.applyColors('ready', 'brand');
    const arrow = sk.applyColors('▸', 'brand');
    return `  ${ready} ${arrow}  ${sk.applyColors(hint, 'muted')}`;
  }

  /**
   * v3-style post-turn status footer:
   *
   *   ▲ groq · llama-3.3-70b  │  ▓▓▓░░░░░░░ 12.4K/128K  │  2s
   *
   * Width-bounded (10-cell context bar), always one line.  Provider
   * appears in muted, model bold, ctx bar colour-graded by % full,
   * elapsed in muted.  Returns string sans trailing newline.
   */
  statusFooter(args: {
    provider: string;
    model: string;
    ctxUsed: number;
    ctxMax: number;
    elapsedMs: number;
  }): string {
    const sk = this.skin;
    const SEP = sk.applyColors(' │ ', 'muted');
    const tri = this.triangle();
    const provModel =
      `${tri} ${sk.applyColors(args.provider, 'muted')}` +
      `${sk.applyColors(' · ', 'muted')}` +
      sk.applyColors(args.model, 'agent');

    const pct = args.ctxMax > 0
      ? Math.min(100, Math.round((args.ctxUsed / args.ctxMax) * 100))
      : 0;
    const barW = 10;
    const filled = Math.round((pct / 100) * barW);
    const ctxKind: 'success' | 'warn' | 'error' =
      pct < 60 ? 'success' : pct < 85 ? 'warn' : 'error';
    const bar =
      sk.applyColors('▓'.repeat(filled), ctxKind) +
      sk.applyColors('░'.repeat(barW - filled), 'muted');
    const ctxLabel = `${formatCompactTokens(args.ctxUsed)}/${formatCompactTokens(args.ctxMax)}`;
    const ctxSeg = `${bar} ${sk.applyColors(ctxLabel, ctxKind)}`;

    const elapsed = sk.applyColors(formatElapsedShort(args.elapsedMs), 'muted');

    return `  ${provModel}${SEP}${ctxSeg}${SEP}${elapsed}`;
  }

  /**
   * Tier-3.1 (v4.1-tier3.1): pre-prompt status line.
   *
   * Single-line summary written ABOVE the input prompt on every
   * fresh turn. Format (full, ≥76 cols):
   *
   *   <provider>:<model> · ctx <N>/<M>k · MCP <state> · cron <state>
   *
   * Width-tier degrade:
   *   <52 cols  → only `<provider>:<model> · ctx N/Mk`
   *   <76 cols  → drop voice indicator
   *   ≥76 cols  → full
   *
   * MCP serve mode: this helper is a pure builder; callers MUST
   * gate the actual write on `isMcpServeMode()` from
   * `cli/v4/uiBuild.ts`. The function itself never writes.
   */
  renderStatusLine(args: {
    provider:    string;
    model:       string;
    ctxUsed?:    number;
    ctxMax?:     number;
    mcpState?:   'active' | 'configured' | 'broken' | 'off';
    cronState?:  'active' | 'configured' | 'broken' | 'off';
    voiceRecording?: boolean;
    cols?:       number;
  }): string {
    const sk = this.skin;
    const cols = args.cols ?? this.cols();
    const SEP = sk.applyColors(' · ', 'muted');

    const colourForState = (s?: string): 'success' | 'muted' | 'error' => {
      if (s === 'active') return 'success';
      if (s === 'broken') return 'error';
      return 'muted';
    };
    const glyphForState = (s?: string): string => {
      if (s === 'active') return '✓';      // ✓
      if (s === 'broken') return '✗';      // ✗
      return '-';
    };

    const provModel =
      sk.applyColors(args.provider, 'muted') +
      sk.applyColors(':', 'muted') +
      sk.applyColors(args.model, 'agent');

    const ctxSeg = (() => {
      if (args.ctxMax == null || args.ctxUsed == null) return '';
      const usedK = Math.round(args.ctxUsed / 1000);
      const maxK  = Math.max(1, Math.round(args.ctxMax / 1000));
      return sk.applyColors(`ctx ${usedK}/${maxK}k`, 'muted');
    })();

    const mcpSeg = args.mcpState
      ? sk.applyColors(`MCP ${glyphForState(args.mcpState)}`, colourForState(args.mcpState))
      : '';
    const cronSeg = args.cronState
      ? sk.applyColors(`cron ${glyphForState(args.cronState)}`, colourForState(args.cronState))
      : '';
    const voiceSeg = args.voiceRecording
      ? sk.applyColors('[REC]', 'error')
      : '';

    // Compose with width-tier degrade.
    const segs: string[] = [provModel];
    if (ctxSeg)   segs.push(ctxSeg);
    if (cols >= 52) {
      if (mcpSeg)  segs.push(mcpSeg);
      if (cronSeg) segs.push(cronSeg);
    }
    if (cols >= 76 && voiceSeg) segs.push(voiceSeg);

    return '  ' + segs.join(SEP);
  }

  /**
   * Optional provider-switch indicator line — emitted only when this
   * turn ran on a different provider than the previous one.  Format
   * matches v3:
   *
   *   groq ──→ openrouter
   */
  providerSwitchLine(prev: string, next: string): string {
    return `  ${this.skin.applyColors(`${prev} ──→ ${next}`, 'muted')}`;
  }

  /**
   * Inquirer prompt prefix — "▲ " in brand orange (Phase 26.2.6 lock:
   * reverted from the brief Phase 26.2.3 `●` swap to keep the prompt
   * glyph aligned with the bottom hint's `▲ Type your message …` and
   * with Aiden's brand mark from v3). Inquirer prepends its own
   * padding, so we only ship the bare 2-char prefix.
   *
   * Phase 26.2.8 — when `AIDEN_UI_TIMESTAMPS=1`, prepends a muted
   * `HH:MM:SS  ` so the user's input line reads
   * `12:41:02  ▲ <input>`. Default OFF preserves `▲ <input>`.
   */
  promptPrefix(): string {
    const tri = this.skin.applyColors('▲', 'brand');
    if (process.env.AIDEN_UI_TIMESTAMPS === '1') {
      return `${this.timestampPrefix()}  ${tri} `;
    }
    return `${tri} `;
  }

  /**
   * Phase 26.2.6 — pick a random phrase from `SPINNER_PHRASES`,
   * append `…`, and wrap in brand orange. `rand` is injectable so
   * tests can pin the selection (and the chat REPL passes the
   * default Math.random for live use).
   */
  thinkingPhrase(rand: () => number = Math.random): string {
    const idx = Math.floor(rand() * SPINNER_PHRASES.length);
    const phrase = SPINNER_PHRASES[Math.max(0, Math.min(SPINNER_PHRASES.length - 1, idx))];
    return this.skin.applyColors(`${phrase}…`, 'brand');
  }

  /**
   * Start a spinner. The implementation is a tiny custom one (no `ora`
   * dependency) so it survives non-TTY pipes and Windows ConPTY without
   * extra config. When stdout is not a TTY the spinner becomes a no-op
   * apart from emitting `text\n` once.
   */
  startSpinner(text: string): SpinnerHandle {
    const skin = this.skin;
    const frames = skin.getActive().glyphs?.spinner ?? ['|', '/', '-', '\\'];
    const isTty = !!this.out.isTTY;
    let current = text;
    let stopped = false;
    let frame = 0;
    let timer: NodeJS.Timeout | null = null;

    const render = (): void => {
      if (!isTty || stopped) return;
      // Phase 23.5: spinner glyph in soft cyan (muted), not brand orange.
      // Quiet color, not loud.
      const glyph = skin.applyColors(frames[frame % frames.length], 'muted');
      this.out.write(`\r${glyph} ${current}   `);
      frame += 1;
    };

    if (isTty) {
      render();
      timer = setInterval(render, 90);
    } else {
      this.out.write(`${text}\n`);
    }

    return {
      setText(next: string): void {
        current = next;
      },
      stop: (finalText?: string): void => {
        if (stopped) return;
        stopped = true;
        if (timer) clearInterval(timer);
        if (isTty) {
          // clear the spinner line and write the final text on its own line
          this.out.write('\r\x1b[K');
        }
        if (finalText) this.out.write(`${finalText}\n`);
      },
    };
  }

  // ── Phase 23.5 — tool event row ───────────────────────────────────────
  // One line per tool call: a "·" gutter, the keyword `tool`, the
  // tool name (soft cyan, padded), a brief truncated arg preview, and
  // a single right-side bracket cluster carrying state. Bracket
  // mutates in place: [running] → [ok 220ms] / [fail 1.4s] / [retry
  // 1/2 …] / product-specific terminals. No multi-line spew, no raw
  // JSON deltas.
  //
  // On non-TTY stdout (pipes, CI logs) the row is deferred until
  // completion so each line in the log carries the final state — no
  // ANSI cursor games on a dumb sink.

  toolRow(name: string, args: unknown): ToolRowHandle {
    const sk = this.skin;

    // ── Build the fixed left portion (icon + verb + detail) ────────────
    // v4.1.3-repl-polish: icons default ON; set AIDEN_UI_ICONS=0 to
    // disable (CI / dumb terminals / narrow SSH sessions).
    // Read at call-time so env changes take effect without restart.
    const useIcons = process.env.AIDEN_UI_ICONS !== '0';
    const { icon, verb } = trailIconForTool(name);
    const glyph = useIcons ? icon : sk.applyColors('·', 'muted');

    // Detail field: reuse previewToolArgs for scalar-field extraction.
    const detail = truncDetail(previewToolArgs(args));

    // Running row — muted pipe, raw icon, tool-colored verb, muted detail.
    const runningRow = (): string =>
      `${sk.applyColors(TRAIL_PIPE, 'muted')} ${glyph} ` +
      `${sk.applyColors(padVerb(verb), 'tool')} ` +
      `${sk.applyColors(detail, 'muted')}\n`;

    // Outcome row — entire line colored by outcome kind.
    const outcomeRow = (suffix: string, kind: ColorKindForBracket): string => {
      const content =
        `${TRAIL_PIPE} ${glyph} ${padVerb(verb)} ${detail}` +
        (suffix ? `  ${suffix}` : '');
      return `${sk.applyColors(content, kind)}\n`;
    };

    // Capture stream reference so closures don't need `this`.
    const out = this.out;
    const isTty = !!out.isTTY;
    let printed = false;

    // Erase the last printed line (TTY only).
    const eraseLast = (): void => {
      if (isTty && printed) out.write('\x1b[1A\x1b[2K\r');
    };

    const writeFinal = (suffix: string, kind: ColorKindForBracket): void => {
      eraseLast();
      out.write(outcomeRow(suffix, kind));
      printed = true;
    };

    if (isTty) {
      out.write(runningRow());
      printed = true;
      // v4.1.3-repl-polish bug1: signal the stream re-render path
      // that an unaccounted-for write landed mid-stream so it skips
      // the cursor-up + erase-to-EOS rerender (which would otherwise
      // nuke this row on streamComplete).
      this.streamInterrupted = true;
    }
    // Non-TTY: hold off until completion (log lines carry final state).

    return {
      ok(durationMs: number, retries = 0) {
        if (retries > 0) {
          // Showed retries — surface the eventual success in warn so the
          // user knows it took multiple attempts.
          writeFinal(
            `ok ${formatToolDuration(durationMs)} after ${retries} ${retries === 1 ? 'retry' : 'retries'}`,
            'warn',
          );
        } else {
          // Clean success — SILENT. Erase on TTY; emit nothing on non-TTY.
          eraseLast();
        }
      },
      fail(durationMs: number, retries = 0) {
        const suffix =
          retries > 0
            ? `fail ${formatToolDuration(durationMs)} after ${retries} ${retries === 1 ? 'retry' : 'retries'}`
            : `fail ${formatToolDuration(durationMs)}`;
        writeFinal(suffix, 'error');
      },
      degraded(durationMs: number, reason?: string) {
        const suffix = reason
          ? `partial ${formatToolDuration(durationMs)} — ${reason}`
          : `partial ${formatToolDuration(durationMs)}`;
        writeFinal(suffix, 'degraded');
      },
      retry(n: number, m: number) {
        // Update the running row with retry count.
        eraseLast();
        const content =
          `${TRAIL_PIPE} ${glyph} ${padVerb(verb)} ${detail}  retry ${n}/${m} …`;
        out.write(sk.applyColors(content, 'warn') + '\n');
        printed = true;
      },
      blocked() {
        writeFinal('blocked', 'warn');
      },
      emptyRetry() {
        writeFinal('empty retry', 'warn');
      },
      emptyFail() {
        writeFinal('empty fail', 'error');
      },
    };
  }

  /**
   * Pretty-print a tool call before it executes. Phase v4.1.2 first
   * consults the `TOOL_PRIMARY_ARG` map in `toolPreview.ts` to render
   * just the meaningful argument (e.g. `terminal: npm test`); falls
   * back to the legacy full-JSON stringification (200-char hard cap)
   * for tools that aren't in the map.
   */
  toolPreview(name: string, args: unknown): string {
    const sk = this.skin;
    const arrow = sk.getActive().glyphs?.arrow ?? '>';

    // Phase v4.1.2: per-tool primary-arg preview.
    const preview = buildToolPreview(name, args);
    if (preview !== null) {
      if (preview === '') {
        return `${sk.applyColors(arrow, 'tool')} ${sk.applyColors(name, 'tool')}`;
      }
      return `${sk.applyColors(arrow, 'tool')} ${sk.applyColors(name, 'tool')} ${sk.applyColors(preview, 'muted')}`;
    }

    // Unknown tool — original behaviour (full JSON, 200-char cap).
    let serialized: string;
    try {
      serialized = JSON.stringify(args);
    } catch {
      serialized = String(args);
    }
    if (serialized.length > 200) serialized = `${serialized.slice(0, 197)}...`;
    return `${sk.applyColors(arrow, 'tool')} ${sk.applyColors(name, 'tool')} ${sk.applyColors(serialized, 'muted')}`;
  }

  /**
   * Render markdown to ANSI via the v4.1-reply-formatting renderer
   * (skin-aware headers / lists / code / quotes / links). Falls back
   * to the marked-terminal default config if the structured renderer
   * is unavailable, then raw text as a last resort.
   */
  markdown(text: string): string {
    try {
      return getReplyRenderer().render(text);
    } catch {
      try {
        const out = marked.parse(text);
        return typeof out === 'string' ? out : String(out);
      } catch {
        return text;
      }
    }
  }

  /** Format a user turn (e.g. echoed back from history). */
  userTurn(text: string): string {
    const sk = this.skin;
    const arrow = sk.getActive().glyphs?.arrow ?? '>';
    return `${sk.applyColors(`${arrow} you`, 'user')}\n${text}\n`;
  }

  /**
   * Format an agent turn in the Phase 23.6 v3-style:
   *
   *     Aiden                       (bold orange label)
   *     ─────────────────────…      (muted thin rule)
   *     <body>                       (rendered markdown / plain text)
   *
   * Body is indented 2 columns to match the boot card and footer.
   * Trailing newline included so the caller can stack a status footer
   * directly underneath.
   */
  agentTurn(text: string, opts: AgentTurnOptions = {}): string {
    const sk = this.skin;
    const useMd = opts.markdown !== false;
    const rawBody = useMd ? this.markdown(text).trimEnd() : text;
    const indented = rawBody
      .split('\n')
      .map((ln) => (ln ? `  ${ln}` : ''))
      .join('\n');
    const reasoning = opts.reasoning
      ? `  ${sk.applyColors(opts.reasoning.trim(), 'muted')}\n`
      : '';
    return `${this.agentHeader()}${reasoning}${indented}\n`;
  }

  /**
   * Format a recoverable error with optional remediation suggestion.
   * Output goes through the caller (returned as string), not stderr.
   */
  error(message: string, suggestion?: string): string {
    const sk = this.skin;
    const head = sk.applyColors('error:', 'error');
    const body = `${head} ${message}`;
    if (!suggestion) return `${body}\n`;
    return `${body}\n${sk.applyColors('hint:', 'warn')} ${suggestion}\n`;
  }

  /** Direct write helpers used by callers that already formatted text. */
  write(text: string): void {
    this.out.write(text);
  }
  writeError(text: string): void {
    this.err.write(text);
  }

  // ── Phase 14b helpers ─────────────────────────────────────────────────
  // Thin wrappers that print colour-prefixed lines via `write()`. These
  // exist so the slash-command handlers and CLI callbacks don't have to
  // hand-roll ANSI strings every time they want to emit a status line.
  // They always emit a trailing newline.

  /** Informational line, e.g. "Switching model…". */
  info(text: string): void {
    this.out.write(`${this.skin.applyColors('›', 'accent')} ${text}\n`);
  }

  /** Success line, e.g. "Switched to anthropic:claude-opus-4-7". */
  success(text: string): void {
    this.out.write(`${this.skin.applyColors('✓', 'success')} ${text}\n`);
  }

  /** Warning line, e.g. "Verbose mode requires restart." */
  warn(text: string): void {
    this.out.write(`${this.skin.applyColors('!', 'warn')} ${text}\n`);
  }

  /** Muted ("dim") line for low-priority diagnostics. */
  dim(text: string): void {
    this.out.write(`${this.skin.applyColors(text, 'muted')}\n`);
  }

  /**
   * Wrap `text` with the active skin's brand colour (orange #FF6B35 in
   * the default skin). Used by boxed framing for major UX moments —
   * setup-complete, /doctor results, critical errors. Returns a string
   * so callers can compose lines; does not write.
   */
  brand(text: string): string {
    return this.skin.applyColors(text, 'brand');
  }

  /**
   * Wrap `text` with the active skin's muted colour (soft cyan #6FB3D2
   * in the default skin) and return the string. Companion to `brand` —
   * use when composing partially-coloured lines like the status bar
   * where some segments are coloured separately. `dim()` writes a full
   * line; `muted()` returns a fragment.
   */
  muted(text: string): string {
    return this.skin.applyColors(text, 'muted');
  }

  /**
   * Wrap `text` with a semantic colour and return the string. Used by
   * the status bar's right-most state segment (ready/generating/exec/
   * approve/retry) where each state has a distinct colour.
   */
  paint(text: string, kind: 'brand' | 'success' | 'warn' | 'error' | 'muted'): string {
    return this.skin.applyColors(text, kind);
  }

  /**
   * Phase 26.2.1 — render a tight pill: `‹label VALUE›` (with leading
   * space-separated label) or `‹VALUE›` when label is empty. The
   * `‹›` glyphs (U+2039 / U+203A) sit in `muted`; the label sits in
   * `muted`; the value sits in `kind` (default `brand`). Pure — returns
   * a string with no trailing newline so callers can compose multiple
   * pills on a single line.
   *
   * Used by the boot card (single `‹v4.0.0›` pill) and Phase 26.2.2's
   * status-bar pill row.
   */
  pill(label: string, value: string, kind: 'brand' | 'success' | 'warn' | 'error' | 'muted' = 'brand'): string {
    const open = this.skin.applyColors('‹', 'muted');
    const close = this.skin.applyColors('›', 'muted');
    const lbl = label ? `${this.skin.applyColors(label, 'muted')} ` : '';
    const val = this.skin.applyColors(value, kind);
    return `${open}${lbl}${val}${close}`;
  }

  /** Horizontal rule for grouping CLI output. */
  line(width = 60): void {
    const ch = this.skin.getActive().glyphs?.bullet === '*' ? '-' : '─';
    this.out.write(`${this.skin.applyColors(ch.repeat(width), 'muted')}\n`);
  }

  /** Convenience: format an error and write it directly to stdout. */
  printError(message: string, suggestion?: string): void {
    this.out.write(this.error(message, suggestion));
  }

  // ── Phase 16c: streaming surface ─────────────────────────────────────
  // Tracks whether a streaming "Aiden" header has been written for the
  // current turn. `streamPartial` writes the header on the first call,
  // then appends every subsequent delta directly. `streamComplete`
  // closes the line so the next non-stream `agentTurn`/`info` call
  // starts on its own line.

  private streamHeaderShown = false;
  private streamLastEndedNewline = false;
  // Phase v4.1-reply-formatting: track the running buffered stream
  // so streamComplete can re-render it as structured markdown
  // (headers / lists / code blocks / blockquotes) once the full
  // body is known. During streaming the raw text remains visible
  // — the post-stream pass clears it via cursor-up + erase-line and
  // reprints the formatted output.
  private streamBuffer = '';
  private streamLineCount = 0;
  /**
   * v4.1.3-repl-polish bug1: tracks whether any non-streamPartial write
   * happened during a stream cycle (a `toolRow` running/outcome row, a
   * `streamToolIndicator` line, etc). When set, `streamComplete` skips
   * the cursor-up + erase-to-end-of-screen re-render path — the erase
   * walks back `streamLineCount` rows, but the cursor has descended
   * further than that because the interruption writes weren't counted.
   * Erasing then would nuke the tool rows along with the streamed body.
   * Reset on each new stream cycle (in `streamPartial`'s first-call
   * init block) and after `streamComplete` consumes it.
   */
  private streamInterrupted = false;

  /**
   * Append a streamed text fragment. Writes a styled "Aiden" header on
   * the first call of a turn, then writes raw text directly via the
   * underlying `write` so token boundaries remain visible. Markdown
   * rendering is deferred — applying `marked` per-token would render
   * partial code fences as broken HTML; pattern of
   * showing raw streamed text and reformatting on completion only when
   * the full body is in hand.
   */
  streamPartial(text: string): void {
    if (!text) return;
    if (!this.streamHeaderShown) {
      // Phase 26.2.3 — share the single-line `┃ Aiden` header with
      // non-streaming agentTurn so streamed and non-streamed responses
      // open identically.
      this.out.write(this.agentHeader());
      this.streamHeaderShown = true;
      this.streamBuffer = '';
      this.streamLineCount = 0;
      // v4.1.3-repl-polish bug1: fresh stream cycle — clear any
      // interrupt flag left over from the prior cycle (the consume
      // path in streamComplete also resets it, but a stream that
      // never reaches completion shouldn't leave the flag stuck).
      this.streamInterrupted = false;
    }
    this.out.write(text);
    this.streamLastEndedNewline = text.endsWith('\n');
    // Phase v4.1-reply-formatting: track buffer + line count for the
    // post-stream re-render. We count newlines in the OUTGOING bytes
    // so the eraser later knows how many rows to clear.
    this.streamBuffer += text;
    for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') this.streamLineCount += 1;
  }

  /**
   * Mark the end of a streaming turn. Adds a trailing newline if the
   * stream didn't end with one so the next CLI line doesn't visually
   * butt up against the model's last token. Resets the per-turn state
   * so the next `streamPartial` re-emits the header.
   */
  streamComplete(): void {
    if (!this.streamHeaderShown) return;
    if (!this.streamLastEndedNewline) this.out.write('\n');

    // Phase v4.1-reply-formatting: re-render the buffered stream as
    // structured markdown — but ONLY when stdout is a TTY and the
    // buffer actually contains markdown structure worth rendering.
    // Plain prose with no headers / lists / fences gets left alone
    // (no flicker, identical output). Otherwise we erase the raw
    // streamed body via cursor-up + erase-line and reprint via the
    // skin-aware renderer.
    const buffered = this.streamBuffer;
    const lines = this.streamLineCount;
    // v4.1.3-repl-polish bug1: capture + drain the interrupt flag in
    // lockstep with the other per-cycle stream state. Anything writing
    // directly to stdout during the cycle (toolRow's running/outcome
    // rows, streamToolIndicator) sets it; we use it below to decide
    // whether the cursor-walk-up + erase rerender is safe.
    const interrupted = this.streamInterrupted;
    this.streamBuffer = '';
    this.streamLineCount = 0;
    this.streamHeaderShown = false;
    this.streamLastEndedNewline = false;
    this.streamInterrupted = false;

    if (!this.out.isTTY) return;
    if (process.env.AIDEN_NO_REFORMAT === '1') return;
    // v4.1.3-repl-polish bug1: skip the rerender entirely when a tool
    // row / indicator wrote mid-stream — the cursor has descended past
    // what `lines` tracks, so `\x1b[<lines>F\x1b[J` would erase the
    // tool rows along with the streamed body. Leaving the raw streamed
    // text in place is the honest fallback (markdown formatting is a
    // polish, not a correctness invariant).
    if (interrupted) return;
    // Cheap heuristic: only re-render when there's structure that
    // benefits from formatting. Avoids flicker on short prose replies.
    const hasStructure =
      /^#{1,6}\s/m.test(buffered) ||
      /^\s*[-*+]\s/m.test(buffered) ||
      /^\s*\d+\.\s/m.test(buffered) ||
      /^>\s/m.test(buffered) ||
      /```/.test(buffered);
    if (!hasStructure) return;

    try {
      // Erase the raw streamed body in place. We wrote `lines + 1`
      // rows (header + body) — the header (`┃ Aiden`) stays, so we
      // walk back `lines` rows and clear each.
      // `\x1b[<n>F` = cursor-up-and-to-column-0 N times.
      // `\x1b[J`    = erase from cursor to end of screen.
      if (lines > 0) {
        this.out.write(`\x1b[${lines}F\x1b[J`);
      }
      const formatted = this.markdown(buffered).trimEnd();
      const indented = formatted
        .split('\n')
        .map((ln) => (ln ? `  ${ln}` : ''))
        .join('\n');
      this.out.write(indented + '\n');
    } catch {
      // If anything goes wrong with the re-render, leave the raw
      // streamed text in place — graceful degradation beats flicker
      // + corrupted output.
    }
  }

  /**
   * Phase v4.1-reply-formatting: render the optional "Sources"
   * footer when AIDEN_CITATIONS=1 and the trace has fetch-class
   * tool calls. Pure write; safe to call after a turn completes
   * regardless of streaming/non-streaming. No-op when the env gate
   * is off or no sources surface.
   */
  printCitationFooter(trace: Array<{ name: string; args?: unknown; result?: unknown }>): void {
    const footer = renderCitationFooter(trace);
    if (!footer) return;
    if (!this.out.isTTY) return;
    this.out.write(footer);
  }

  /**
   * Inline tool indicator. Printed between deltas when a tool call
   * surfaces during streaming so the user sees activity instead of a
   * stalled cursor. Always lands on its own line — adds a leading
   * newline if the prior delta ran past column N without one.
   */
  streamToolIndicator(name: string): void {
    const sk = this.skin;
    const arrow = sk.getActive().glyphs?.arrow ?? '>';
    const prefix = this.streamLastEndedNewline ? '' : '\n';
    this.out.write(`${prefix}${sk.applyColors(`${arrow} ${name}…`, 'tool')}\n`);
    this.streamLastEndedNewline = true;
    // v4.1.3-repl-polish bug1: an untracked row landed mid-stream —
    // tell streamComplete to skip the cursor-up + erase-to-EOS rerender
    // (it would otherwise erase this indicator + every tool outcome row
    // that printed between deltas).
    this.streamInterrupted = true;
  }
}

// ── Phase v4.1-voice-cli — voice indicator helper ─────────────────────

/** Voice mode UI states surfaced to the indicator. */
export type VoiceIndicatorState =
  | 'idle'
  | 'listening'
  | 'recording'
  | 'transcribing'
  | 'speaking';

/**
 * Render a voice-mode status line. Pure builder — caller writes the
 * result via Display.streamPartial / direct stdout. Includes a
 * RMS-driven block bar when state is `recording`. The bar uses 8
 * unicode block-fill levels (▏ to █) over a 0..1500 RMS range,
 * which covers the practical loud-speech ceiling without saturating
 * for any reasonable mic preamp.
 *
 * Tier-3.1 (v4.1-tier3.1): replaced 🎤 / 🔊 emoji with text-state
 * badges `[REC]` (recording, error/red) and `[PLAY]` (speaking,
 * success/green). Idle/listening/transcribing get the neutral
 * `[VOX]` badge in muted colour. Same 4-char inner width keeps
 * subsequent column alignment intact.
 *
 * Examples:
 *   voiceIndicator('idle')                  → '[VOX] idle (Space to talk)'
 *   voiceIndicator('listening')             → '[VOX] listening...'
 *   voiceIndicator('recording', 800)        → '[REC] ▌▌▌▌▌▌  recording (Space to stop, Esc to cancel)'
 *   voiceIndicator('transcribing')          → '[VOX] transcribing...'
 *   voiceIndicator('speaking')              → '[PLAY] speaking...'
 */
export function voiceIndicator(
  state: VoiceIndicatorState,
  rms: number = 0,
): string {
  const skin = getSkinEngine();
  const recBadge  = skin.applyColors('[REC]',  'error');
  const playBadge = skin.applyColors('[PLAY]', 'success');
  const voxBadge  = skin.applyColors('[VOX]',  'muted');
  switch (state) {
    case 'idle':
      return `${voxBadge} idle (Space to talk)`;
    case 'listening':
      return `${voxBadge} listening...`;
    case 'recording': {
      const bar = renderRmsBar(rms);
      return `${recBadge} ${bar}  recording (Space to stop, Esc to cancel)`;
    }
    case 'transcribing':
      return `${voxBadge} transcribing...`;
    case 'speaking':
      return `${playBadge} speaking...`;
    default:
      return `${voxBadge} ${state}`;
  }
}

const BAR_WIDTH = 12;
const BAR_FULL_RMS = 1500;

/** RMS-driven horizontal block bar. 0..BAR_FULL_RMS → 0..BAR_WIDTH chars. */
function renderRmsBar(rms: number): string {
  const safe = Math.max(0, Math.min(rms, BAR_FULL_RMS));
  const filled = Math.round((safe / BAR_FULL_RMS) * BAR_WIDTH);
  return '▌'.repeat(filled) + ' '.repeat(BAR_WIDTH - filled);
}

// ── Phase 23.5 / v4.1.3-repl-polish — tool row helpers ────────────────
//
// v4.1.3 changes the row format from:
//   "  {glyph} tool {name:16} {args}  [{state}]"
// to the compact trail format:
//   "┊ {icon} {verb:12} {detail:40}"
//
// Outcome semantics:
//   ok()        → SILENT — running row is erased; nothing persists.
//   fail()      → row persists in error (red).
//   degraded()  → row persists in degraded (yellow). NEW in v4.1.3.
//   blocked()   → row persists in warn.
//   retry()     → running row is updated with retry counter.
//   emptyFail() → treated as fail (error colour).
//   emptyRetry()→ treated as retry.

/**
 * Kept for reference / smoke-test backward compat. New code should use
 * TRAIL_VERB_PAD / TRAIL_DETAIL_CAP from toolTrail.ts instead.
 * @deprecated
 */
export const TOOL_ROW_NAME_PAD = TRAIL_VERB_PAD;
/** @deprecated Use TRAIL_DETAIL_CAP. */
export const TOOL_ROW_ARG_CAP = TRAIL_DETAIL_CAP;

type ColorKindForBracket = 'success' | 'warn' | 'error' | 'degraded';

/**
 * Handle returned by `Display.toolRow()`. Mutates the row in place once
 * the tool resolves. Each method writes exactly once; subsequent calls
 * would double-print.
 */
export interface ToolRowHandle {
  ok(durationMs: number, retries?: number): void;
  fail(durationMs: number, retries?: number): void;
  /**
   * v4.1.3-repl-polish — tool completed but with a degraded / best-effort
   * result (e.g. recall_session returned cached data, app_launch fell back
   * to CLI). Row persists in degraded yellow.
   */
  degraded(durationMs: number, reason?: string): void;
  retry(n: number, m: number): void;
  blocked(): void;
  emptyRetry(): void;
  emptyFail(): void;
}

/**
 * Build a compact, single-line preview of the tool's arguments. Picks
 * the most informative scalar fields when the args are an object, then
 * truncates with an ellipsis at TOOL_ROW_ARG_CAP. Pure — no side
 * effects, deterministic for a given input.
 */
export function previewToolArgs(args: unknown): string {
  if (args == null) return '';
  if (typeof args === 'string') return truncToolArg(args);
  if (typeof args !== 'object') return truncToolArg(String(args));
  const obj = args as Record<string, unknown>;
  // Prefer obvious "first" fields the user can recognise without
  // reading JSON. Fall back to the full JSON otherwise.
  const preferKeys = [
    'query', 'q', 'url', 'path', 'file', 'name', 'command', 'cmd',
    'message', 'text', 'content', 'prompt',
  ];
  for (const k of preferKeys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim().length > 0) {
      return truncToolArg(k === 'url' || k === 'path' || k === 'file'
        ? v
        : `"${v}"`);
    }
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(obj);
  } catch {
    serialized = String(obj);
  }
  return truncToolArg(serialized);
}

function truncToolArg(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length <= TOOL_ROW_ARG_CAP) return flat;
  return flat.slice(0, TOOL_ROW_ARG_CAP - 1) + '…';
}

/**
 * Render a tool-call duration in the bracket cluster. Sub-second
 * durations show ms; ≥1s shows one decimal place of seconds. Pure.
 */
export function formatToolDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 10) return `${sec.toFixed(1)}s`;
  return `${Math.round(sec)}s`;
}

// ── Phase 23.6 — token / elapsed formatters for the status footer ──────

/** "12345" → "12.3K"; "1234567" → "1.2M". Used by statusFooter. */
export function formatCompactTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** "850" → "850ms"; "2300" → "2.3s"; "75000" → "1m 15s". */
export function formatElapsedShort(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1).replace(/\.0$/, '')}s`;
  const mins = Math.floor(sec / 60);
  const remSec = Math.round(sec - mins * 60);
  return remSec > 0 ? `${mins}m ${remSec}s` : `${mins}m`;
}

let _global: Display | null = null;
export function getDisplay(): Display {
  if (!_global) _global = new Display();
  return _global;
}
export function resetDisplayForTests(): void {
  _global = null;
}
