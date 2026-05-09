/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/voice/audioStream.ts — Phase v4.1-voice-cli
 *
 * Streaming microphone capture with lazy-loaded backend.
 * Two-tier fallback:
 *
 *   1. PRIMARY: `decibri` — Rust/cpal via napi-rs, prebuilt binaries
 *      for Win/mac/Linux. Zero compile, zero system bin, true
 *      streaming Readable, 16k PCM native.
 *   2. FALLBACK: `node-record-lpcm16` — shells out to `sox`/`rec`.
 *      Used when decibri's prebuilt binary is unavailable for the
 *      target arch (rare).
 *   3. UNAVAILABLE: neither installs — `startStream()` returns null
 *      and the caller surfaces a clear "install sox or check mic
 *      drivers" hint via `aiden voice doctor`.
 *
 * Lazy import is mandatory — eager loading the audio library breaks
 * SSH-only / Docker / WSL boots where no audio device exists. We
 * import at first use, cache the resolved backend, and never
 * re-probe.
 *
 * Idle-timeout 5min auto-close mirrors `core/playwrightBridge.ts`
 * — no use of mic for 5 minutes → release the device handle. Voice
 * mode re-acquires on next `startStream()`.
 *
 * The stream emits Int16 PCM frames at 16 kHz / mono. Each frame is
 * a Buffer the consumer can compute RMS over (cliVoice does this
 * for VAD).
 */

import { EventEmitter } from 'node:events';
import type { Logger } from '../logger/logger';
import { noopLogger } from '../logger/factory';

// ── Public types ──────────────────────────────────────────────────────────

export interface AudioStreamHandle {
  /** Stop the stream. Resolves with the concatenated PCM buffer
   *  (16-bit signed little-endian, mono, 16 kHz). */
  stop(): Promise<Buffer>;
  /** Cancel the stream and discard buffered frames. */
  cancel(): void;
  /** Per-frame event emitter — subscribe for real-time RMS / level
   *  meter updates. Emits `'frame'` with `{ pcm: Buffer, rms: number }`. */
  events: EventEmitter;
  /** True after stop()/cancel() — consumers don't double-stop. */
  closed: boolean;
}

export type AudioBackend = 'decibri' | 'node-record-lpcm16' | 'unavailable';

export interface AudioStreamOptions {
  sampleRate?: number;     // default 16000
  channels?:   number;     // default 1
  logger?:     Logger;
}

// ── Idle-timeout state ────────────────────────────────────────────────────

const IDLE_MS = 5 * 60 * 1000;
let _activeBackend: AudioBackend | null = null;
let _idleTimer:     NodeJS.Timeout | null = null;
let _activeHandle:  AudioStreamHandle | null = null;

function resetIdleTimer(logger: Logger): void {
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => {
    logger.info('audio stream: idle 5min — releasing backend');
    _activeBackend = null;
    _idleTimer     = null;
  }, IDLE_MS);
}

// ── Backend probing ───────────────────────────────────────────────────────

let _resolvedBackend: AudioBackend | null = null;

/**
 * Probe which mic backend is usable on this system. Cached after
 * first call. Pass `force` to re-probe (rare; only useful after the
 * user installs a missing dep mid-session).
 */
export async function resolveAudioBackend(
  logger: Logger = noopLogger(),
  force = false,
): Promise<AudioBackend> {
  if (_resolvedBackend && !force) return _resolvedBackend;

  // Tier 1: decibri prebuilt
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require.resolve('decibri');
    _resolvedBackend = 'decibri';
    logger.info('audio stream: backend = decibri (prebuilt)');
    return _resolvedBackend;
  } catch { /* not installed */ }

  // Tier 2: node-record-lpcm16 (requires sox on PATH)
  try {
    require.resolve('node-record-lpcm16');
    _resolvedBackend = 'node-record-lpcm16';
    logger.info('audio stream: backend = node-record-lpcm16 (requires sox)');
    return _resolvedBackend;
  } catch { /* not installed */ }

  _resolvedBackend = 'unavailable';
  logger.warn('audio stream: no backend available — install `decibri` (npm) or `sox` + `node-record-lpcm16`');
  return _resolvedBackend;
}

/** Test-only: clear the cached backend so the next call re-probes. */
export function __resetAudioBackend(): void {
  _resolvedBackend = null;
}

// ── RMS helper ────────────────────────────────────────────────────────────

/** Root-mean-square of a 16-bit signed PCM buffer. Returns 0 for
 *  empty buffers. Used by the VAD in `cliVoice.ts`. */
export function computeRms(pcm: Buffer): number {
  if (pcm.length < 2) return 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const sample = pcm.readInt16LE(i);
    sum += sample * sample;
    count += 1;
  }
  if (count === 0) return 0;
  return Math.round(Math.sqrt(sum / count));
}

/** Peak amplitude (absolute value) over a 16-bit signed PCM buffer.
 *  Peak RMS check on stop — rejects "no speech ever" recordings
 *  whose mean RMS is dragged down by trailing silence. */
export function computePeakRms(pcm: Buffer): number {
  if (pcm.length < 2) return 0;
  let peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const sample = Math.abs(pcm.readInt16LE(i));
    if (sample > peak) peak = sample;
  }
  return peak;
}

// ── Stream factory ────────────────────────────────────────────────────────

/**
 * Start streaming microphone PCM. Returns null when no backend is
 * available — caller surfaces a friendly error.
 */
export async function startAudioStream(
  opts: AudioStreamOptions = {},
): Promise<AudioStreamHandle | null> {
  const logger = (opts.logger ?? noopLogger()).child('audio-stream');
  const sampleRate = opts.sampleRate ?? 16_000;
  const channels   = opts.channels   ?? 1;

  const backend = await resolveAudioBackend(logger);
  if (backend === 'unavailable') return null;

  // Refuse a second concurrent stream — the audio device handle is
  // singleton (mirrors `playwrightBridge` invariant).
  if (_activeHandle && !_activeHandle.closed) {
    logger.warn('audio stream: already active — refusing concurrent claim');
    return null;
  }

  _activeBackend = backend;
  resetIdleTimer(logger);

  const handle = backend === 'decibri'
    ? await startDecibri({ sampleRate, channels, logger })
    : await startNodeRecord({ sampleRate, channels, logger });

  if (!handle) return null;
  _activeHandle = handle;
  return handle;
}

// ── decibri backend ───────────────────────────────────────────────────────

async function startDecibri(args: {
  sampleRate: number;
  channels:   number;
  logger:     Logger;
}): Promise<AudioStreamHandle | null> {
  const { logger, sampleRate, channels } = args;
  let mod: { default?: unknown } | unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require('decibri');
  } catch (err) {
    logger.warn('audio stream: decibri load failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // The decibri public surface is `Recorder` or `Input`; the exact
  // shape varies by minor version. We accept either via a tiny
  // adapter so this module survives a v0.x → v1.x bump.
  const factory = (mod as { Recorder?: unknown; Input?: unknown }).Recorder
              ?? (mod as { Recorder?: unknown; Input?: unknown }).Input;
  if (typeof factory !== 'function') {
    logger.warn('audio stream: decibri exports unrecognised shape — falling back');
    return null;
  }

  let buffers: Buffer[] = [];
  const events = new EventEmitter();
  let closed = false;
  let recorder: { stop?: () => void; close?: () => void } | null = null;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recorder = new (factory as any)({ sampleRate, channels });
    // Decibri exposes a Readable on `.stream` or directly is one.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = (recorder as any).stream ?? recorder;
    if (stream && typeof stream.on === 'function') {
      stream.on('data', (pcm: Buffer) => {
        if (closed) return;
        buffers.push(pcm);
        const rms = computeRms(pcm);
        events.emit('frame', { pcm, rms });
      });
      stream.on('error', (err: Error) => {
        logger.warn('audio stream: decibri stream error', { error: err.message });
        events.emit('error', err);
      });
    }
  } catch (err) {
    logger.warn('audio stream: decibri init failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  return {
    events,
    get closed() { return closed; },
    async stop(): Promise<Buffer> {
      if (closed) return Buffer.concat(buffers);
      closed = true;
      try { recorder?.stop?.(); } catch { /* ignore */ }
      try { recorder?.close?.(); } catch { /* ignore */ }
      _activeHandle = null;
      const out = Buffer.concat(buffers);
      buffers = [];
      return out;
    },
    cancel(): void {
      if (closed) return;
      closed = true;
      try { recorder?.stop?.(); } catch { /* ignore */ }
      try { recorder?.close?.(); } catch { /* ignore */ }
      _activeHandle = null;
      buffers = [];
    },
  };
}

// ── node-record-lpcm16 backend ────────────────────────────────────────────

async function startNodeRecord(args: {
  sampleRate: number;
  channels:   number;
  logger:     Logger;
}): Promise<AudioStreamHandle | null> {
  const { logger, sampleRate, channels } = args;
  let mod: unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require('node-record-lpcm16');
  } catch (err) {
    logger.warn('audio stream: node-record-lpcm16 load failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recordFn = (mod as any).record;
  if (typeof recordFn !== 'function') {
    logger.warn('audio stream: node-record-lpcm16 exports unrecognised shape');
    return null;
  }

  let buffers: Buffer[] = [];
  const events = new EventEmitter();
  let closed = false;
  let recording: { stop?: () => void; stream?: () => NodeJS.ReadableStream } | null = null;

  try {
    recording = recordFn({
      sampleRate,
      channels,
      audioType: 'wav',
      threshold: 0,
    });
    const stream = recording!.stream?.();
    if (stream) {
      stream.on('data', (pcm: Buffer) => {
        if (closed) return;
        buffers.push(pcm);
        const rms = computeRms(pcm);
        events.emit('frame', { pcm, rms });
      });
      stream.on('error', (err: Error) => {
        logger.warn('audio stream: node-record-lpcm16 stream error', { error: err.message });
        events.emit('error', err);
      });
    }
  } catch (err) {
    logger.warn('audio stream: node-record-lpcm16 init failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  return {
    events,
    get closed() { return closed; },
    async stop(): Promise<Buffer> {
      if (closed) return Buffer.concat(buffers);
      closed = true;
      try { recording?.stop?.(); } catch { /* ignore */ }
      _activeHandle = null;
      const out = Buffer.concat(buffers);
      buffers = [];
      return out;
    },
    cancel(): void {
      if (closed) return;
      closed = true;
      try { recording?.stop?.(); } catch { /* ignore */ }
      _activeHandle = null;
      buffers = [];
    },
  };
}

// ── Diagnostics ───────────────────────────────────────────────────────────

export interface AudioBackendDiagnostics {
  resolved:   AudioBackend | null;
  active:     boolean;
  /** Path PATH check for sox — informational only. */
  soxOnPath:  boolean;
}

export async function getAudioDiagnostics(
  logger: Logger = noopLogger(),
): Promise<AudioBackendDiagnostics> {
  const resolved = await resolveAudioBackend(logger);
  let soxOnPath = false;
  try {
    const { execSync } = await import('node:child_process');
    const probe = process.platform === 'win32' ? 'where sox' : 'which sox';
    execSync(probe, { stdio: 'ignore', timeout: 2_000 });
    soxOnPath = true;
  } catch { /* sox not on PATH */ }
  return {
    resolved,
    active:    !!_activeHandle && !_activeHandle.closed,
    soxOnPath,
  };
}
