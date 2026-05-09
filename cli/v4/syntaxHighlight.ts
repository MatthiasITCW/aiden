/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/syntaxHighlight.ts — Phase v4.1-reply-formatting
 *
 * Lightweight regex-based syntax highlighter for fenced code blocks.
 * No external dependency. Languages with first-class support:
 *   - typescript / javascript / ts / js
 *   - python / py
 *   - shell / bash / sh / zsh
 *   - json
 *   - yaml / yml
 *
 * Unknown languages fall through with no highlighting (returns the
 * input verbatim) so the renderer never breaks on exotic fences.
 *
 * Tokenization is order-sensitive: comments/strings first (so a
 * keyword inside a string isn't recoloured), then numbers, then
 * keywords. The regex passes are conservative — they paint by
 * token shape, not by full grammar — but they handle the common
 * 90% case well enough for terminal display.
 */

import { getSkinEngine } from './skinEngine';

type Lang =
  | 'typescript' | 'javascript'
  | 'python'
  | 'shell'
  | 'json'
  | 'yaml'
  | 'unknown';

function normalizeLang(raw: string | undefined): Lang {
  const s = (raw ?? '').toLowerCase().trim();
  if (s === 'ts' || s === 'tsx' || s === 'typescript') return 'typescript';
  if (s === 'js' || s === 'jsx' || s === 'javascript') return 'javascript';
  if (s === 'py' || s === 'python') return 'python';
  if (s === 'sh' || s === 'bash' || s === 'zsh' || s === 'shell') return 'shell';
  if (s === 'json') return 'json';
  if (s === 'yaml' || s === 'yml') return 'yaml';
  return 'unknown';
}

const TS_KEYWORDS = new Set([
  'const','let','var','function','return','if','else','for','while','do',
  'break','continue','switch','case','default','async','await','class',
  'extends','implements','new','this','super','import','export','from',
  'as','typeof','instanceof','interface','type','enum','public','private',
  'protected','readonly','static','void','never','any','unknown','true',
  'false','null','undefined','throw','try','catch','finally','yield',
  'in','of',
]);

const PY_KEYWORDS = new Set([
  'def','return','if','elif','else','for','while','break','continue',
  'import','from','as','class','pass','raise','try','except','finally',
  'with','lambda','yield','global','nonlocal','True','False','None',
  'and','or','not','is','in','async','await','assert','del',
]);

const SH_KEYWORDS = new Set([
  'if','then','else','elif','fi','for','do','done','while','until','case',
  'esac','function','return','export','local','readonly','in','select',
]);

/** ANSI-paint a token with the active skin's colour kind. */
function paint(text: string, kind: 'heading' | 'brand' | 'muted' | 'success' | 'warn' | 'tool' | 'agent' | 'user' | 'accent' | 'error'): string {
  return getSkinEngine().applyColors(text, kind);
}

/**
 * Walk `code` building an output string. Identifies regions by a
 * simple state machine: STRING → COMMENT → NUMBER → IDENT (which
 * may be a keyword). Anything else is emitted verbatim.
 *
 * Returns the painted string. Pure — no side effects.
 */
function highlightTsJs(code: string, kw: ReadonlySet<string>): string {
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    // Single-line comment
    if (c === '/' && code[i + 1] === '/') {
      const end = code.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      out += paint(code.slice(i, stop), 'muted');
      i = stop;
      continue;
    }
    // Block comment
    if (c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i);
      const stop = end === -1 ? n : end + 2;
      out += paint(code.slice(i, stop), 'muted');
      i = stop;
      continue;
    }
    // Strings (', ", `)
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < n && code[j] !== quote) {
        if (code[j] === '\\' && j + 1 < n) { j += 2; continue; }
        j += 1;
      }
      const stop = j < n ? j + 1 : n;
      out += paint(code.slice(i, stop), 'success');
      i = stop;
      continue;
    }
    // Numbers
    if (/[0-9]/.test(c) && (i === 0 || !/[a-zA-Z_$]/.test(code[i - 1] ?? ''))) {
      let j = i;
      while (j < n && /[0-9.eExX_a-fA-F]/.test(code[j] ?? '')) j += 1;
      out += paint(code.slice(i, j), 'accent');
      i = j;
      continue;
    }
    // Identifiers / keywords
    if (/[a-zA-Z_$]/.test(c)) {
      let j = i;
      while (j < n && /[a-zA-Z0-9_$]/.test(code[j] ?? '')) j += 1;
      const word = code.slice(i, j);
      out += kw.has(word) ? paint(word, 'brand') : word;
      i = j;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function highlightPython(code: string): string {
  // Python: # comments, '/" strings, numbers, keywords. Same engine
  // as TS/JS but with a `#` comment and Python keyword set.
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    if (c === '#') {
      const end = code.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      out += paint(code.slice(i, stop), 'muted');
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      // Triple-quote support
      const triple = code[i + 1] === quote && code[i + 2] === quote;
      let j = triple ? i + 3 : i + 1;
      const closer = triple ? quote.repeat(3) : quote;
      while (j < n) {
        if (code.startsWith(closer, j)) { j += closer.length; break; }
        if (code[j] === '\\' && j + 1 < n) { j += 2; continue; }
        j += 1;
      }
      out += paint(code.slice(i, j), 'success');
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) && (i === 0 || !/[a-zA-Z_]/.test(code[i - 1] ?? ''))) {
      let j = i;
      while (j < n && /[0-9._jJ]/.test(code[j] ?? '')) j += 1;
      out += paint(code.slice(i, j), 'accent');
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < n && /[a-zA-Z0-9_]/.test(code[j] ?? '')) j += 1;
      const word = code.slice(i, j);
      out += PY_KEYWORDS.has(word) ? paint(word, 'brand') : word;
      i = j;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function highlightShell(code: string): string {
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    if (c === '#' && (i === 0 || code[i - 1] === '\n' || code[i - 1] === ' ')) {
      const end = code.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      out += paint(code.slice(i, stop), 'muted');
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      while (j < n && code[j] !== quote) {
        if (code[j] === '\\' && j + 1 < n) { j += 2; continue; }
        j += 1;
      }
      const stop = j < n ? j + 1 : n;
      out += paint(code.slice(i, stop), 'success');
      i = stop;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < n && /[a-zA-Z0-9_]/.test(code[j] ?? '')) j += 1;
      const word = code.slice(i, j);
      out += SH_KEYWORDS.has(word) ? paint(word, 'brand') : word;
      i = j;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function highlightJson(code: string): string {
  // JSON has only strings, numbers, true/false/null, and structure.
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && code[j] !== '"') {
        if (code[j] === '\\' && j + 1 < n) { j += 2; continue; }
        j += 1;
      }
      const stop = j < n ? j + 1 : n;
      // Treat key (followed by ':') vs value distinct.
      // Skip whitespace after to peek at the next non-space char.
      let k = stop;
      while (k < n && /\s/.test(code[k] ?? '')) k += 1;
      const isKey = code[k] === ':';
      out += paint(code.slice(i, stop), isKey ? 'heading' : 'success');
      i = stop;
      continue;
    }
    if (/[0-9-]/.test(c) && /[0-9]/.test(code[i + 1] ?? c)) {
      let j = i;
      while (j < n && /[0-9.eE+-]/.test(code[j] ?? '')) j += 1;
      out += paint(code.slice(i, j), 'accent');
      i = j;
      continue;
    }
    if (/[a-zA-Z]/.test(c)) {
      let j = i;
      while (j < n && /[a-zA-Z]/.test(code[j] ?? '')) j += 1;
      const word = code.slice(i, j);
      if (word === 'true' || word === 'false' || word === 'null') {
        out += paint(word, 'brand');
      } else {
        out += word;
      }
      i = j;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function highlightYaml(code: string): string {
  // Simple per-line: comments to '#', `key:` keys, strings.
  return code
    .split('\n')
    .map((line) => {
      const trimStart = line.match(/^\s*/)?.[0] ?? '';
      const rest = line.slice(trimStart.length);
      if (rest.startsWith('#')) return trimStart + paint(rest, 'muted');
      // key:
      const m = /^([A-Za-z_][\w-]*)(\s*):(\s*)(.*)$/.exec(rest);
      if (m) {
        const [, key, padBeforeColon, padAfter, value] = m;
        const valOut =
          /^['"]/.test(value)
            ? paint(value, 'success')
            : /^-?\d/.test(value)
              ? paint(value, 'accent')
              : value === 'true' || value === 'false' || value === 'null'
                ? paint(value, 'brand')
                : value;
        return `${trimStart}${paint(key, 'heading')}${padBeforeColon}:${padAfter}${valOut}`;
      }
      // Bullet lists
      if (rest.startsWith('- ')) {
        return trimStart + paint('-', 'muted') + ' ' + rest.slice(2);
      }
      return line;
    })
    .join('\n');
}

/**
 * Highlight `code` according to `lang`. Returns the painted string.
 * If `lang` is unknown or empty, returns the input verbatim.
 */
export function highlightCode(code: string, lang: string | undefined): string {
  const norm = normalizeLang(lang);
  switch (norm) {
    case 'typescript':
    case 'javascript':
      return highlightTsJs(code, TS_KEYWORDS);
    case 'python': return highlightPython(code);
    case 'shell':  return highlightShell(code);
    case 'json':   return highlightJson(code);
    case 'yaml':   return highlightYaml(code);
    case 'unknown':
    default:       return code;
  }
}

/** Tiny helper for tests. */
export function isSupportedLang(lang: string | undefined): boolean {
  return normalizeLang(lang) !== 'unknown';
}
