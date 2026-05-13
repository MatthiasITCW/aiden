import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';

// Strip ANSI escape sequences so assertions stay terminal-agnostic.
function stripAnsi(s: string): string {
  return s.replace(
    // eslint-disable-next-line no-control-regex
    /\x1b\[[0-9;]*[A-Za-z]/g,
    '',
  );
}

describe('SkinEngine', () => {
  let engine: SkinEngine;

  beforeEach(() => {
    engine = new SkinEngine({ forceMono: false });
  });

  it('exposes the bundled default skin', () => {
    expect(engine.getActive().name).toBe('default');
    expect(engine.listSkins()).toEqual(
      expect.arrayContaining(['default', 'light', 'monochrome']),
    );
  });

  it('applyColors wraps text with ANSI for the default skin', () => {
    const out = engine.applyColors('hi', 'brand');
    expect(out).not.toBe('hi'); // ANSI codes added
    expect(stripAnsi(out)).toBe('hi');
  });

  it('switching to monochrome strips colour', () => {
    engine.setActive('monochrome');
    expect(engine.applyColors('hi', 'brand')).toBe('hi');
  });

  it('switching skins changes colour bytes', () => {
    const a = engine.applyColors('x', 'brand');
    engine.setActive('light');
    const b = engine.applyColors('x', 'brand');
    expect(a).not.toEqual(b);
  });

  it('forceMono disables colour entirely', () => {
    const mono = new SkinEngine({ forceMono: true });
    expect(mono.applyColors('hi', 'brand')).toBe('hi');
  });

  it('unknown skin name keeps the active skin and reports via onError', () => {
    const errors: string[] = [];
    const e = new SkinEngine({ onError: (m) => errors.push(m) });
    e.setActive('does-not-exist');
    expect(e.getActive().name).toBe('default');
    expect(errors[0]).toMatch(/unknown skin/i);
  });

  it('loadSkin reads custom yaml from skinsDir', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-skin-'));
    await fs.writeFile(
      path.join(tmp, 'neon.yaml'),
      'description: neon\ncolors:\n  brand: [255, 0, 255]\n',
    );
    const e = new SkinEngine({ skinsDir: tmp });
    const s = await e.loadSkin('neon');
    expect(s.name).toBe('neon');
    expect(s.colors.brand).toEqual([255, 0, 255]);
  });

  it('loadSkin missing file falls back to default + onError', async () => {
    const errors: string[] = [];
    const e = new SkinEngine({
      skinsDir: path.join(os.tmpdir(), 'aiden-no-such-dir'),
      onError: (m) => errors.push(m),
    });
    const s = await e.loadSkin('ghost');
    expect(s.name).toBe('default');
    expect(errors[0]).toMatch(/failed to load/i);
  });
});

describe('Display', () => {
  let display: Display;
  let skin: SkinEngine;

  beforeEach(() => {
    skin = new SkinEngine({ forceMono: true }); // deterministic output
    display = new Display({ skin });
  });

  it('banner emits the AIDEN ASCII block (Phase 23.6 v3 visual style port)', () => {
    // Banner is ASCII art only — no inline version, no tagline, no
    // /help hint, no tip.  Those moved to chatSession.renderStartupCard.
    const b = stripAnsi(display.banner('4.2.1'));
    // ASCII block uses heavy box-drawing chars; assert the top edge.
    expect(b).toMatch(/█████╗/);
  });

  it('banner does not include /help, tagline, or tip line', () => {
    const b = stripAnsi(display.banner('4.2.1'));
    expect(b).not.toMatch(/✦ Tip:/);
    expect(b).not.toMatch(/\/help/);
    expect(b).not.toMatch(/local-first agent/);
    // Version no longer rendered in the banner — chatSession boot card
    // owns it now.
    expect(b).not.toMatch(/v4\.2\.1/);
  });

  it('banner ignores a tip option (Phase 23.5: tip moved to boot card)', () => {
    const b = stripAnsi(
      display.banner('4.2.1', { tip: 'Type /help to see what I can do.' }),
    );
    expect(b).not.toMatch(/✦ Tip:/);
  });

  it('userTurn formats with a "you" marker', () => {
    const out = stripAnsi(display.userTurn('hello'));
    expect(out).toMatch(/you/);
    expect(out).toContain('hello');
  });

  it('agentTurn renders markdown by default', () => {
    const out = stripAnsi(display.agentTurn('# Title\n- item'));
    expect(out).toMatch(/Aiden/);
    // marked-terminal upper-cases headers and renders bullets
    expect(out).toMatch(/Title/i);
  });

  it('agentTurn with markdown:false leaves text alone', () => {
    const out = stripAnsi(display.agentTurn('raw text', { markdown: false }));
    expect(out).toContain('raw text');
  });

  it('toolPreview formats name and args', () => {
    const out = stripAnsi(display.toolPreview('read_file', { path: '/tmp/x' }));
    expect(out).toContain('read_file');
    expect(out).toContain('/tmp/x');
  });

  it('toolPreview truncates very long args', () => {
    const big = { blob: 'x'.repeat(2000) };
    const out = stripAnsi(display.toolPreview('huge', big));
    expect(out.length).toBeLessThan(260);
    expect(out).toContain('...');
  });

  it('error includes suggestion when provided', () => {
    const out = stripAnsi(display.error('missing api key', 'run aiden setup'));
    expect(out).toContain('missing api key');
    expect(out).toContain('run aiden setup');
  });

  it('error without suggestion omits the hint line', () => {
    const out = stripAnsi(display.error('boom'));
    expect(out).toContain('boom');
    expect(out).not.toMatch(/hint/);
  });

  it('startSpinner returns a handle that stops cleanly without errors', () => {
    // stdout in vitest is not a TTY, so spinner is a no-op apart from one write
    const h = display.startSpinner('thinking…');
    expect(typeof h.stop).toBe('function');
    expect(typeof h.setText).toBe('function');
    h.setText('still thinking');
    h.stop('done');
    h.stop(); // double stop is a no-op
  });

  it('markdown() handles plain text without throwing', () => {
    const out = display.markdown('plain text');
    expect(typeof out).toBe('string');
    expect(stripAnsi(out)).toContain('plain text');
  });
});

describe('Display Phase 14b helpers', () => {
  function captureDisplay() {
    const chunks: string[] = [];
    const out = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString());
        cb();
      },
    }) as unknown as NodeJS.WriteStream;
    const skin = new SkinEngine({ forceMono: true });
    const d = new Display({ skin, stdout: out });
    return { d, chunks };
  }

  it('info writes a single line with trailing newline', () => {
    const { d, chunks } = captureDisplay();
    d.info('hello');
    const joined = chunks.join('');
    expect(joined).toMatch(/hello\n$/);
  });

  it('success writes a checkmark prefix', () => {
    const { d, chunks } = captureDisplay();
    d.success('done');
    expect(chunks.join('')).toContain('done');
    expect(chunks.join('')).toMatch(/✓/);
  });

  it('warn writes a bang prefix', () => {
    const { d, chunks } = captureDisplay();
    d.warn('careful');
    expect(chunks.join('')).toContain('careful');
    expect(chunks.join('')).toMatch(/^!/);
  });

  it('dim writes the muted line with a newline', () => {
    const { d, chunks } = captureDisplay();
    d.dim('quiet');
    expect(chunks.join('')).toBe('quiet\n');
  });

  it('line draws a horizontal rule of the requested width', () => {
    const { d, chunks } = captureDisplay();
    d.line(10);
    const joined = chunks.join('');
    // mono skin uses '─' for default-style and '-' for monochrome glyphs.
    expect(joined.length).toBe(11); // 10 chars + newline
    expect(joined).toMatch(/─{10}\n|-{10}\n/);
  });
});

// ── v4.1.3-repl-polish tool trail tests ────────────────────────────────
//
// New trail format: ┊ {icon} {verb:12} {detail:40}
//
// Key semantic changes from Phase 23.5:
//   ok()  → SILENT on success (no output at all on non-TTY; erase on TTY)
//   fail()  → row persists in error (red / plain on mono)
//   degraded() → row persists in degraded yellow / plain on mono
//   blocked() → row persists in warn
//   retry()  → row printed / updated with N/M counter
//   ok(ms, retries>0) → row in warn with "after N retry/retries"
//
// All tests force AIDEN_UI_ICONS=0 so emoji don't sneak into assertions.
describe('Display v4.1.3-repl-polish toolRow', () => {
  function captureDisplay(opts: { tty: boolean }) {
    const chunks: string[] = [];
    const out = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString());
        cb();
      },
    }) as unknown as NodeJS.WriteStream;
    (out as unknown as { isTTY: boolean }).isTTY = opts.tty;
    const skin = new SkinEngine({ forceMono: true });
    const d = new Display({ skin, stdout: out });
    return { d, chunks };
  }

  beforeEach(() => {
    // Disable icons for deterministic assertions (no emoji width surprises).
    process.env.AIDEN_UI_ICONS = '0';
  });
  afterEach(() => {
    delete process.env.AIDEN_UI_ICONS;
  });

  // ── Success is SILENT ───────────────────────────────────────────────

  it('non-TTY ok: nothing printed (success is silent)', () => {
    const { d, chunks } = captureDisplay({ tty: false });
    const row = d.toolRow('web_search', { query: 'bollywood top hindi songs' });
    expect(chunks.join('')).toBe(''); // nothing before completion
    row.ok(220);
    expect(chunks.join('')).toBe(''); // still nothing — success is silent
  });

  it('TTY ok: running row printed, then erased silently', () => {
    const { d, chunks } = captureDisplay({ tty: true });
    // web_search is in the fetch category → verb "fetching". Picked
    // here rather than youtube_search (which is mapped to media =
    // "launching") so the assertion tracks the most common case.
    const row = d.toolRow('web_search', { query: 'Sahiba Jasleen Royal' });
    const first = chunks.join('');
    // Running row uses new trail format
    expect(first).toContain('┊');
    expect(stripAnsi(first)).toContain('fetching');
    chunks.length = 0;
    row.ok(180);
    const second = chunks.join('');
    // Only the erase escape — no final row printed.
    expect(second).toMatch(/\x1b\[1A\x1b\[2K\r/);
    // After stripping ANSI sequences, only the carriage return from the
    // erase sequence remains — no visible glyphs / text.
    expect(stripAnsi(second).replace(/\r/g, '')).toBe('');
  });

  // ── Fail row ────────────────────────────────────────────────────────

  it('non-TTY fail: trail row with "fail Ns" suffix', () => {
    const { d, chunks } = captureDisplay({ tty: false });
    d.toolRow('open_url', { url: 'https://example.com/x' }).fail(1500);
    const flat = stripAnsi(chunks.join(''));
    expect(flat).toMatch(/┊/);
    expect(flat).toMatch(/fetching/);
    expect(flat).toMatch(/fail 1\.5s/);
  });

  // ── Degraded row ─────────────────────────────────────────────────────

  it('non-TTY degraded: trail row with "partial Nms" suffix', () => {
    const { d, chunks } = captureDisplay({ tty: false });
    d.toolRow('recall_session', { session_id: 'abc' }).degraded(320, 'cached');
    const flat = stripAnsi(chunks.join(''));
    expect(flat).toMatch(/┊/);
    expect(flat).toMatch(/partial 320ms/);
    expect(flat).toContain('cached');
  });

  // ── Blocked row ──────────────────────────────────────────────────────

  it('blocked: trail row with "blocked" suffix', () => {
    const { d, chunks } = captureDisplay({ tty: false });
    d.toolRow('open_url', { url: 'https://www.youtube.com/watch?v=abc' }).blocked();
    const flat = stripAnsi(chunks.join(''));
    expect(flat).toMatch(/blocked/);
    expect(flat).toMatch(/┊/);
  });

  // ── Retry row ───────────────────────────────────────────────────────

  it('retry: trail row with N/M counter', () => {
    const { d, chunks } = captureDisplay({ tty: false });
    d.toolRow('web_search', { query: 'foo' }).retry(1, 2);
    const flat = stripAnsi(chunks.join(''));
    expect(flat).toMatch(/retry 1\/2 …/);
  });

  // ── ok-after-retries ────────────────────────────────────────────────

  it('ok with retries>0: trail row in warn with "after N retry"', () => {
    const { d, chunks } = captureDisplay({ tty: false });
    d.toolRow('web_search', { query: 'foo' }).ok(4200, 1);
    const flat = stripAnsi(chunks.join(''));
    expect(flat).toMatch(/ok 4\.2s after 1 retry/);
    expect(flat).toMatch(/┊/);
  });

  // ── Truncation ──────────────────────────────────────────────────────

  it('detail field truncates long args with "…" at 40 chars', () => {
    const { d, chunks } = captureDisplay({ tty: false });
    const longUrl = 'https://www.youtube.com/watch?v=' + 'X'.repeat(80) + '&list=PL';
    // Use fail() so the row is printed (success is silent)
    d.toolRow('open_url', { url: longUrl }).fail(90);
    const flat = stripAnsi(chunks.join(''));
    expect(flat).toMatch(/…/);
    // Extract the detail field (between verb+spaces and the suffix)
    // Detail is capped at 40 chars including the ellipsis
    const detailMatch = flat.match(/fetching\s+(\S+)/);
    expect(detailMatch?.[1]?.length ?? 0).toBeLessThanOrEqual(40);
  });

  // ── Verb padding ────────────────────────────────────────────────────

  it('verb column is padded to 12 chars so detail fields align', () => {
    const { d, chunks } = captureDisplay({ tty: false });
    // 'foo' → fallback verb 'calling' (7 chars), padded to 12
    d.toolRow('foo', { query: 'q' }).fail(10);
    const flat = stripAnsi(chunks.join(''));
    // "calling" padded to 12 => 5 trailing spaces before the detail
    expect(flat).toMatch(/calling {5}/);
  });
});
