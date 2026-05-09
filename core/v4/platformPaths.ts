/**
 * Copyright (c) 2026 Shiva Deore (Taracod). Licensed under AGPL-3.0.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/platformPaths.ts — Phase v4.1-cross-platform
 *
 * Cross-platform helpers for path normalisation, home expansion,
 * shell selection, and writability checks. Centralising these so
 * every other module can import a single canonical surface — and
 * so the path audit has one place to scan for OS-specific bugs.
 *
 * Most of the work delegates to Node's built-in `path` module; the
 * value-add is the small bit of glue (`expandHome`, `platformShell`,
 * `isWritable`) that's easy to get wrong if redone ad-hoc.
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

/** Idiomatic platform-aware path normalisation. */
export function normalizePath(p: string): string {
  if (typeof p !== 'string' || p.length === 0) return p;
  return path.normalize(p);
}

/** Re-export `path.join` under a stable name so callers don't have to import path directly. */
export function joinPaths(...parts: string[]): string {
  return path.join(...parts);
}

/**
 * Expand `~/` and `~` to the current user's home directory. Pass
 * paths through unchanged if they don't start with the tilde token.
 *
 *   expandHome('~/foo')  → `${os.homedir()}/foo`
 *   expandHome('~')      → `${os.homedir()}`
 *   expandHome('/abs/p') → '/abs/p'
 *   expandHome('./rel')  → './rel'
 */
export function expandHome(p: string): string {
  if (typeof p !== 'string' || p.length === 0) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * Return the conventional shell name for the current platform.
 * Used by tools that spawn a child shell to make the right choice
 * without each caller re-checking process.platform.
 */
export type PlatformShell = 'powershell' | 'bash' | 'sh';

export function platformShell(): PlatformShell {
  if (process.platform === 'win32') return 'powershell';
  // POSIX: prefer bash when present, otherwise sh. We don't probe at
  // runtime — bash is ubiquitous on macOS/Linux and `sh` is the
  // POSIX-mandated fallback. Callers that need certainty can call
  // `which bash` themselves.
  return 'bash';
}

/**
 * Cross-platform writability check. Returns true if the path exists
 * AND the current process can write to it, false otherwise. Catches
 * EACCES/EPERM/ENOENT silently — never throws.
 */
export function isWritable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cross-platform readability check — paired with isWritable for
 * doctor's filesystem audit.
 */
export function isReadable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Single-source-of-truth platform classifier. */
export type SupportedPlatform = 'win32' | 'darwin' | 'linux' | 'other';

export function classifyPlatform(): SupportedPlatform {
  switch (process.platform) {
    case 'win32':  return 'win32';
    case 'darwin': return 'darwin';
    case 'linux':  return 'linux';
    default:       return 'other';
  }
}
