/**
 * Copyright (c) 2026 Shiva Deore (Taracod). Licensed under AGPL-3.0.
 *
 * Aiden — local-first agent.
 */
/**
 * core/voice/audioBackend.ts — Phase v4.1-cross-platform
 *
 * Detects which audio playback / recording backend is available on
 * the current platform and surfaces friendly install hints when the
 * stack is missing. Used by `audio.ts` and `tts.ts` instead of
 * blowing up with a raw spawn-failure stack trace.
 *
 *   Windows : winmm.dll MCI via PowerShell (always available)
 *   macOS   : afplay (playback, system) + sox (record)
 *   Linux   : aplay/paplay (playback) + arecord/sox (record)
 *
 * The detection probe runs `<bin> --version` (or `which`) with a
 * 1.5s timeout; total cost on first call is bounded under 2s.
 * Results are cached for the process lifetime so repeated checks
 * are free.
 */

import { execSync } from 'node:child_process';

export type AudioPurpose = 'playback' | 'record';

export interface AudioBackend {
  /** OS-specific binary name we look for via `which` / `where`. */
  bin:        string;
  /** Friendly label for diagnostics. */
  label:      string;
  /** Friendly install hint surfaced when missing. */
  installHint: string;
  /** Set true when this backend is known to ship with the OS. */
  builtin:    boolean;
}

const BACKENDS: Record<NodeJS.Platform | 'fallback', { playback: AudioBackend[]; record: AudioBackend[] }> = {
  win32: {
    playback: [
      { bin: 'powershell', label: 'PowerShell + winmm.dll', installHint: 'PowerShell ships with Windows.', builtin: true },
    ],
    record: [
      { bin: 'powershell', label: 'PowerShell + winmm.dll', installHint: 'PowerShell ships with Windows.', builtin: true },
    ],
  },
  darwin: {
    playback: [
      { bin: 'afplay', label: 'afplay', installHint: 'afplay ships with macOS.', builtin: true },
      { bin: 'sox',    label: 'sox',    installHint: 'brew install sox',          builtin: false },
    ],
    record: [
      { bin: 'sox',    label: 'sox',    installHint: 'brew install sox',          builtin: false },
    ],
  },
  linux: {
    playback: [
      { bin: 'paplay',  label: 'paplay (PulseAudio)', installHint: 'sudo apt install pulseaudio-utils  (or use ALSA: sudo apt install alsa-utils)', builtin: false },
      { bin: 'aplay',   label: 'aplay (ALSA)',        installHint: 'sudo apt install alsa-utils',     builtin: false },
      { bin: 'sox',     label: 'sox',                 installHint: 'sudo apt install sox',            builtin: false },
    ],
    record: [
      { bin: 'arecord', label: 'arecord (ALSA)', installHint: 'sudo apt install alsa-utils', builtin: false },
      { bin: 'sox',     label: 'sox',            installHint: 'sudo apt install sox',        builtin: false },
    ],
  },
  // Catch-all for unknown platforms — no backends, friendly error.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fallback: { playback: [], record: [] } as any,
  // Other Node.js platforms get the empty fallback via lookup.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  aix: { playback: [], record: [] } as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  freebsd: { playback: [], record: [] } as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  openbsd: { playback: [], record: [] } as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sunos: { playback: [], record: [] } as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  android: { playback: [], record: [] } as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cygwin: { playback: [], record: [] } as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  haiku: { playback: [], record: [] } as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  netbsd: { playback: [], record: [] } as any,
};

const cache = new Map<string, boolean>();

/** Probe whether `bin` is on PATH. Cross-platform via `which` / `where`. */
function probe(bin: string): boolean {
  if (cache.has(bin)) return cache.get(bin)!;
  const cmd = process.platform === 'win32' ? `where ${bin}` : `which ${bin}`;
  try {
    execSync(cmd, { stdio: 'ignore', timeout: 1500, windowsHide: true });
    cache.set(bin, true);
    return true;
  } catch {
    cache.set(bin, false);
    return false;
  }
}

/** Return the first available backend for `purpose` on the current platform, or null. */
export function detectBackend(purpose: AudioPurpose): AudioBackend | null {
  const platformKey = process.platform as NodeJS.Platform;
  const slot = BACKENDS[platformKey] ?? BACKENDS.fallback;
  const candidates = slot[purpose] ?? [];
  for (const b of candidates) {
    if (b.builtin || probe(b.bin)) return b;
  }
  return null;
}

/**
 * Build a friendly multi-line message describing the missing backend
 * and how to install it. Used by audio.ts / tts.ts when the chosen
 * spawn fails OR detectBackend returns null up front.
 */
export function missingBackendMessage(purpose: AudioPurpose): string {
  const platformKey = process.platform as NodeJS.Platform;
  const slot = BACKENDS[platformKey] ?? BACKENDS.fallback;
  const candidates = slot[purpose] ?? [];
  if (candidates.length === 0) {
    return `Audio ${purpose} unavailable on ${process.platform}. Aiden does not yet ship a backend for this platform.`;
  }
  const labels  = candidates.map((c) => c.label).join(' / ');
  const installs = candidates.map((c) => `  - ${c.installHint}`).join('\n');
  return `Audio ${purpose} backend not found. Aiden looked for: ${labels}\nInstall one of:\n${installs}`;
}

/**
 * Reset the probe cache. Test-only; not exposed via the barrel.
 */
export function _resetBackendCacheForTests(): void {
  cache.clear();
}

/** Public read-only view for diagnostics (used by `aiden doctor`). */
export function listKnownBackends(purpose: AudioPurpose): AudioBackend[] {
  const platformKey = process.platform as NodeJS.Platform;
  const slot = BACKENDS[platformKey] ?? BACKENDS.fallback;
  return slot[purpose] ?? [];
}
