/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/resizeGuard.ts — Phase v4.1-tier3-essentials
 *
 * Hard-clear the terminal on `process.stdout` resize so dropdown
 * re-renders, prompt frames, and dirty escape state from before the
 * resize don't ghost into the new viewport.
 *
 * The clear is a single `\x1b[2J\x1b[H` (erase display + cursor home);
 * every mainstream emulator honours it. A virtualised transcript could
 * do this more surgically via React state, but we don't have one yet,
 * so the brute-force clear is the right minimum for v4.1.
 *
 * Skipped in non-TTY (`process.stdout.isTTY` falsy) and in MCP serve
 * mode (`isMcpServeMode()` true). 100ms debounce so a continuous
 * resize drag doesn't issue dozens of clears.
 *
 * `installResizeGuard()` returns a teardown function. Idempotent.
 */

import { isMcpServeMode } from './uiBuild';

/** Single ANSI sequence: `ED 2` (erase display) + `CUP` (cursor home). */
const HARD_CLEAR = '\x1b[2J\x1b[H';

const DEFAULT_DEBOUNCE_MS = 100;

interface InstalledGuard {
  uninstall: () => void;
}

let installed: InstalledGuard | null = null;

export interface InstallResizeGuardOptions {
  /** Override the debounce (testing). */
  debounceMs?: number;
  /** Override the writable used for the clear sequence (testing). */
  out?: NodeJS.WriteStream;
  /** Optional after-clear callback so chatSession can re-render the prompt + status line. */
  onCleared?: () => void;
}

/**
 * Install a 'resize' listener on `process.stdout`. No-op when stdout
 * is non-TTY or MCP serve mode is active. Idempotent — calling twice
 * returns the same teardown.
 */
export function installResizeGuard(opts: InstallResizeGuardOptions = {}): () => void {
  if (installed) return installed.uninstall;

  const out = opts.out ?? process.stdout;
  if (!out || !out.isTTY) {
    const noop = (): void => { /* no-op for non-TTY */ };
    installed = { uninstall: noop };
    return noop;
  }
  if (isMcpServeMode()) {
    const noop = (): void => { /* no-op in MCP serve */ };
    installed = { uninstall: noop };
    return noop;
  }

  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  let pending: NodeJS.Timeout | null = null;

  const onResize = (): void => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      try {
        out.write(HARD_CLEAR);
      } catch { /* defensive */ }
      try {
        opts.onCleared?.();
      } catch { /* re-render must not crash the listener */ }
    }, debounceMs);
  };

  out.on('resize', onResize);

  const uninstall = (): void => {
    if (!installed) return;
    out.removeListener('resize', onResize);
    if (pending) {
      clearTimeout(pending);
      pending = null;
    }
    installed = null;
  };
  installed = { uninstall };
  return uninstall;
}

/** Test helper: drop install state. */
export function _resetForTests(): void {
  if (installed) installed.uninstall();
  installed = null;
}

/** Constant exposed for smokes — they assert we emit this exact bytes. */
export const HARD_CLEAR_SEQUENCE = HARD_CLEAR;
