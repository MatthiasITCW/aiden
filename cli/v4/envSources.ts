/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/envSources.ts — Phase 16c.2
 *
 * Tracks where each `process.env` entry came from so `/providers` can
 * tell users whether a key is from their shell, Windows User-level env,
 * or the aiden-managed `.env` at `paths.envFile`.
 *
 * Lives in its own module to break a circular import:
 *   `commands/providers.ts` → `aidenCLI.ts` (had this) → `commands/`
 *
 * Source tags:
 *   - 'preset'    — already in process.env when aiden booted
 *                   (Windows User env, parent shell, prior dotenv layer)
 *   - 'aiden-env' — populated by `loadAidenEnvFile()` from `paths.envFile`
 *   - 'unset'     — not in process.env
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export type EnvSource = 'preset' | 'aiden-env';

const ENV_SOURCE_TAG = Symbol.for('aiden.envSource');

function getMap(): Map<string, EnvSource> {
  let m: Map<string, EnvSource> | undefined = (globalThis as any)[ENV_SOURCE_TAG];
  if (!m) {
    m = new Map<string, EnvSource>();
    (globalThis as any)[ENV_SOURCE_TAG] = m;
  }
  return m;
}

/**
 * Load aiden's managed `.env` file into `process.env`. Fill-only — keys
 * already set in process.env (the user's shell, Windows User env, etc.)
 * are NOT overwritten, and they're tagged 'preset' for diagnostics.
 *
 * Silent on parse errors and missing files; the resolver surfaces missing
 * keys later with a clearer error than dotenv would.
 */
export function loadAidenEnvFile(envFile: string): void {
  const sources = getMap();
  // Tag everything currently in process.env as 'preset' BEFORE we touch
  // the file, so we don't misattribute pre-existing keys.
  for (const k of Object.keys(process.env)) {
    if (!sources.has(k)) sources.set(k, 'preset');
  }
  let body: string;
  try {
    body = fs.readFileSync(envFile, 'utf8');
  } catch {
    return;
  }
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let value = m[2];
    if (
      value.length >= 2 &&
      ((value[0] === '"' && value.endsWith('"')) ||
        (value[0] === "'" && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
      sources.set(key, 'aiden-env');
    }
  }
}

/** Read the source of a given env var (for `/providers` diagnostics). */
export function getEnvSource(key: string): EnvSource | 'unset' {
  if (process.env[key] === undefined) return 'unset';
  return getMap().get(key) ?? 'preset';
}

/** Test-only: clear the source map. */
export function __resetEnvSources(): void {
  getMap().clear();
}

// ── Phase v4.1-mcp.2 — Multi-source env loader for `aiden mcp serve` ──
//
// When Claude Desktop / Cursor / Claude Code spawn `aiden mcp serve`
// over stdio, they pass an EMPTY env block by default. Without an
// explicit `env: {...}` per-server entry in the client config, the
// spawned aiden has no GROQ_API_KEY, GEMINI_API_KEY, etc. Provider-
// using tools (subagent_fanout, web_search, fetch_url, …) then fail
// with "no providers configured".
//
// Fix: at MCP serve startup, eagerly load .env files from a small
// list of well-known locations into process.env. Same fill-only
// semantics as `loadAidenEnvFile` (preset > file). Caller passes
// `paths.envFile` (covers `~/.aiden/.env` and Windows-equivalent).
// We additionally probe the install directory so a project-local
// `.env` in the Aiden checkout works out of the box.
//
// NEVER log the values — only the source path and the set of keys
// (names) detected.

/** Walk up from `from` looking for an Aiden install root — a directory
 *  containing a `package.json` whose `name` is `aiden-runtime`. Returns
 *  null when no candidate is found within `maxDepth` levels. */
export function resolveAidenInstallDir(
  from: string = __dirname,
  maxDepth: number = 8,
): string | null {
  let dir = path.resolve(from);
  for (let i = 0; i < maxDepth; i += 1) {
    const pkg = path.join(dir, 'package.json');
    try {
      const text = fs.readFileSync(pkg, 'utf8');
      const parsed = JSON.parse(text) as { name?: string };
      if (parsed.name === 'aiden-runtime') return dir;
    } catch { /* not present or unparseable, walk up */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export interface McpEnvLoadReport {
  /** Files we attempted to read, in priority order. Each entry's
   *  `loaded` is true when the file existed and at least one key
   *  was applied. */
  attempts: Array<{ path: string; exists: boolean; appliedKeys: string[] }>;
  /** Final tally of keys we set during this call (filled only). */
  appliedTotal: number;
}

/** Load `.env` files for `aiden mcp serve`. Order:
 *
 *   1. `<aiden_install_dir>/.env`  — project-local, dev convenience
 *   2. `aidenHomeEnv`               — per-user, `paths.envFile`
 *
 *   3. process.env — already loaded; takes precedence over both
 *                    via fill-only semantics.
 *
 *  Caller logs the report via the mcp-stdio logger (stderr-safe).
 *  Values are NEVER returned — only counts + key names. */
export function loadMcpEnvSources(opts: {
  aidenHomeEnv: string;
  installDir?: string | null;
}): McpEnvLoadReport {
  const attempts: McpEnvLoadReport['attempts'] = [];
  const installDir = opts.installDir ?? resolveAidenInstallDir();
  const candidates: string[] = [];
  if (installDir) candidates.push(path.join(installDir, '.env'));
  candidates.push(opts.aidenHomeEnv);

  let appliedTotal = 0;
  for (const file of candidates) {
    const before = new Set(Object.keys(process.env));
    let exists = false;
    try {
      fs.accessSync(file, fs.constants.R_OK);
      exists = true;
    } catch { /* missing — record and skip */ }
    if (exists) loadAidenEnvFile(file);
    const appliedKeys: string[] = [];
    for (const k of Object.keys(process.env)) {
      if (!before.has(k)) appliedKeys.push(k);
    }
    appliedTotal += appliedKeys.length;
    attempts.push({ path: file, exists, appliedKeys });
  }
  return { attempts, appliedTotal };
}

/** The provider-key surface aiden cares about for `mcp status` output.
 *  Listed explicitly so we never accidentally enumerate / log a
 *  newly-added secret.  */
export const KNOWN_PROVIDER_KEYS = [
  'GROQ_API_KEY',
  'GEMINI_API_KEY',
  'TOGETHER_API_KEY',
  'OPENROUTER_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'CEREBRAS_API_KEY',
  'NVIDIA_API_KEY',
  'COHERE_API_KEY',
] as const;

export interface ProviderKeyPresence {
  key: string;
  present: boolean;
  source: EnvSource | 'unset';
}

/** Snapshot of provider-key presence + source. Values NEVER returned;
 *  only the source tag (`preset`/`aiden-env`/`unset`). */
export function describeProviderKeys(
  keys: readonly string[] = KNOWN_PROVIDER_KEYS,
): ProviderKeyPresence[] {
  return keys.map((key) => ({
    key,
    present: typeof process.env[key] === 'string' && process.env[key]!.length > 0,
    source:  getEnvSource(key),
  }));
}
