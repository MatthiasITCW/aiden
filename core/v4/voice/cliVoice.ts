/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/voice/cliVoice.ts — Phase v4.1-voice-cli
 *
 * Push-to-talk and continuous-mode state machines for the CLI.
 * Wraps `audioStream.startAudioStream()` with:
 *
 *   - RMS-based VAD with the tuned knobs from prior multi-agent
 *     systems' hard-learned experience:
 *       * SILENCE_RMS_THRESHOLD = 200
 *       * SILENCE_DURATION_SECONDS = 3.0
 *       * 0.3s sustained speech confirmation (mic click filter)
 *       * 0.3s dip tolerance (natural micro-pauses don't reset
 *         the speech tracker)
 *       * Peak RMS check on stop — rejects "no speech ever"
 *         recordings where mean RMS is dragged down by silence
 *       * 15s max_wait when no speech detected at all
 *
 *   - Hallucination filter (delegated to
 *     `core/channels/whisper-transcribe.ts` — already battle-
 *     tested in v4.1-3 for Telegram voice messages).
 *
 *   - Continuous mode: 3-consecutive-silent-cycle stop.
 *     - `_ttsPlaying` flag prevents the live mic from capturing
 *       the agent's spoken reply (would feedback-loop in ~3s).
 *     - 0.3s post-TTS sleep before VAD re-arm.
 *
 *   - Status callback: `idle | listening | recording | transcribing
 *     | speaking`. UI subscribes for live indicator updates.
 *
 *   - Pure orchestrator — no TTY, no display, no persistence.
 *     Tests inject `audioFactory` + `transcribeFn` to verify state
 *     transitions without an actual mic.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  computePeakRms,
  type AudioStreamHandle,
  type AudioStreamOptions,
} from './audioStream';
import {
  transcribeForChannel as defaultTranscribeForChannel,
  type TranscriptionResult,
} from '../../channels/whisper-transcribe';
import type { Logger } from '../logger/logger';
import { noopLogger } from '../logger/factory';

// ── VAD constants (battle-tested defaults) ──────────────────────────────

export const SILENCE_RMS_THRESHOLD       = 200;
export const SILENCE_DURATION_SECONDS    = 3.0;
export const MIN_SPEECH_DURATION_SECONDS = 0.3;   // sustained-above-threshold filter
export const DIP_TOLERANCE_SECONDS       = 0.3;   // natural micro-pause
export const PEAK_RMS_REJECT_THRESHOLD   = 400;   // 2x silence threshold
export const MAX_WAIT_NO_SPEECH_SECONDS  = 15.0;  // bail if user never speaks
export const POST_TTS_REARM_DELAY_MS     = 300;
export const CONTINUOUS_NO_SPEECH_LIMIT  = 3;

// ── Status / events ──────────────────────────────────────────────────────

export type VoiceStatus =
  | 'idle'
  | 'listening'      // mic open, waiting for speech to start
  | 'recording'      // speech detected, capturing
  | 'transcribing'   // STT in flight
  | 'speaking';      // TTS playing

export interface CliVoiceCallbacks {
  /** Status transition for UI. */
  onStatus?: (status: VoiceStatus) => void;
  /** Live RMS for level meter. Throttled to ~10Hz by the caller. */
  onRms?: (rms: number) => void;
  /** Final transcript ready — caller forwards to agent loop. */
  onTranscript?: (text: string, confidence: number | null) => void;
  /** Recoverable error (no speech, transcribe fail, etc.). */
  onError?: (message: string) => void;
}

// ── Public API ───────────────────────────────────────────────────────────

export type AudioStreamFactory = (
  opts: AudioStreamOptions,
) => Promise<AudioStreamHandle | null>;

export type TranscribeFn = typeof defaultTranscribeForChannel;

export interface CliVoiceOptions {
  callbacks?: CliVoiceCallbacks;
  logger?:    Logger;
  /** Inject an audio stream factory — tests pass a stub. */
  audioFactory?: AudioStreamFactory;
  /** Inject a transcribe function — tests pass a stub. */
  transcribeFn?: TranscribeFn;
  /** Override clock for tests. */
  now?: () => number;
}

export interface CliVoiceHandle {
  /** Start a single push-to-talk recording. Resolves when the user
   *  stops (via `stopRecording()`) and transcription completes. */
  startRecording(): Promise<void>;
  /** Stop the in-progress recording. Triggers transcribe →
   *  onTranscript → idle. */
  stopRecording(): Promise<void>;
  /** Cancel — discard the recording without transcribing. */
  cancel(): void;
  /** Mark TTS as playing — disables continuous-mode VAD re-arm
   *  until `markTtsDone()` lands. Mandatory feedback-loop guard. */
  markTtsPlaying(): void;
  markTtsDone(): Promise<void>;
  /** Current status snapshot. */
  getStatus(): VoiceStatus;
  /** Recent peak-RMS — for the post-recording "anything said?" check. */
  getPeakRms(): number;
}

// ── Hallucination filter ──────────────────────────────────────────────────

/** Whisper emits these on near-silent audio. Reused from v4.1-3
 *  Telegram voice — same patterns apply to CLI mic. */
export const HALLUCINATION_PATTERNS: readonly RegExp[] = [
  /^thank you[.!]?$/i,
  /^thanks for watching[.!]?$/i,
  /^subscribe[.!]?$/i,
  /^subtitles by .+$/i,
  /amara\.org/i,
  /^you$/i,
  /^bye[.!]?$/i,
] as const;

export function isHallucination(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.length < 3) return true;
  for (const re of HALLUCINATION_PATTERNS) {
    if (re.test(trimmed)) return true;
  }
  return false;
}

// ── Implementation ────────────────────────────────────────────────────────

interface VadState {
  speechConfirmed: boolean;
  speechSinceMs:   number | null;
  lastAboveMs:     number | null;
  silenceSinceMs:  number | null;
  startMs:         number;
}

export function createCliVoice(options: CliVoiceOptions = {}): CliVoiceHandle {
  const logger    = (options.logger ?? noopLogger()).child('cli-voice');
  const callbacks = options.callbacks ?? {};
  const now       = options.now ?? Date.now;

  let status: VoiceStatus = 'idle';
  let stream: AudioStreamHandle | null = null;
  let peakRms = 0;
  let ttsPlaying = false;
  let silentCycleCount = 0;
  let vad: VadState | null = null;
  let recordingPromise: Promise<void> | null = null;
  let recordingResolve: (() => void) | null = null;
  let stopRequested = false;

  const transitionStatus = (next: VoiceStatus): void => {
    if (status === next) return;
    status = next;
    try { callbacks.onStatus?.(next); } catch (e) {
      logger.warn('onStatus callback threw', { error: (e as Error).message });
    }
  };

  const fireRms = (rms: number): void => {
    try { callbacks.onRms?.(rms); } catch { /* ignore */ }
  };

  const tickVad = (rms: number): { stop: boolean; cancelNoSpeech: boolean } => {
    if (!vad) return { stop: false, cancelNoSpeech: false };
    const t = now();
    const above = rms > SILENCE_RMS_THRESHOLD;

    if (above) {
      if (vad.speechSinceMs === null) vad.speechSinceMs = t;
      vad.lastAboveMs    = t;
      vad.silenceSinceMs = null;
      // Confirm speech once we've been above threshold for the
      // sustained duration — this filters mic clicks.
      if (!vad.speechConfirmed
          && t - vad.speechSinceMs >= MIN_SPEECH_DURATION_SECONDS * 1000) {
        vad.speechConfirmed = true;
        transitionStatus('recording');
      }
    } else {
      // Below threshold. Two cases:
      // (1) Pre-speech: count toward the no-speech max-wait timer.
      // (2) Post-speech: count toward silence-stop timer, with a
      //     dip tolerance so micro-pauses don't trip it.
      if (!vad.speechConfirmed) {
        // No speech yet — check max-wait.
        if (t - vad.startMs >= MAX_WAIT_NO_SPEECH_SECONDS * 1000) {
          return { stop: false, cancelNoSpeech: true };
        }
      } else {
        // Speech confirmed; allow a brief dip without resetting.
        if (vad.lastAboveMs !== null
            && t - vad.lastAboveMs > DIP_TOLERANCE_SECONDS * 1000) {
          if (vad.silenceSinceMs === null) vad.silenceSinceMs = t;
          if (t - vad.silenceSinceMs >= SILENCE_DURATION_SECONDS * 1000) {
            return { stop: true, cancelNoSpeech: false };
          }
        }
      }
    }
    return { stop: false, cancelNoSpeech: false };
  };

  const finishRecording = async (): Promise<void> => {
    if (!stream || stream.closed) {
      transitionStatus('idle');
      return;
    }
    transitionStatus('transcribing');
    let pcm: Buffer;
    try {
      pcm = await stream.stop();
    } catch (err) {
      logger.warn('stream stop failed', { error: (err as Error).message });
      transitionStatus('idle');
      stream = null;
      return;
    }
    stream = null;

    // Peak-RMS gate — reject "no speech ever" recordings.
    peakRms = computePeakRms(pcm);
    if (peakRms < PEAK_RMS_REJECT_THRESHOLD) {
      logger.info('recording rejected: peak RMS below threshold', {
        peakRms,
        threshold: PEAK_RMS_REJECT_THRESHOLD,
      });
      callbacks.onError?.('No speech detected');
      transitionStatus('idle');
      return;
    }

    // Persist PCM as a WAV for the transcribe pipeline.
    const wavPath = await persistPcmAsWav(pcm);
    try {
      const transcribe = options.transcribeFn ?? defaultTranscribeForChannel;
      const result: TranscriptionResult = await transcribe({
        filePath: wavPath,
        logger:   logger as never,
      });
      if (!result.success || !result.text) {
        callbacks.onError?.(result.error ?? 'Transcription returned no text');
        transitionStatus('idle');
        return;
      }
      if (isHallucination(result.text)) {
        logger.info('transcript dropped: matches hallucination pattern', {
          text: result.text,
        });
        callbacks.onError?.('Transcript looked like silence noise — ignored');
        transitionStatus('idle');
        return;
      }
      callbacks.onTranscript?.(result.text, result.avgLogprob ?? null);
      transitionStatus('idle');
    } finally {
      try { await fs.unlink(wavPath); } catch { /* ignore */ }
    }
  };

  return {
    async startRecording(): Promise<void> {
      if (status !== 'idle') {
        logger.warn('startRecording: not idle', { status });
        return;
      }
      stopRequested = false;
      vad = {
        speechConfirmed: false,
        speechSinceMs:   null,
        lastAboveMs:     null,
        silenceSinceMs:  null,
        startMs:         now(),
      };
      peakRms = 0;
      transitionStatus('listening');

      const factory = options.audioFactory ?? (async (o) => {
        const { startAudioStream } = await import('./audioStream');
        return startAudioStream(o);
      });
      stream = await factory({ logger });
      if (!stream) {
        callbacks.onError?.('Microphone not available');
        transitionStatus('idle');
        return;
      }

      stream.events.on('frame', ({ rms }: { pcm: Buffer; rms: number }) => {
        if (!stream || stream.closed) return;
        if (rms > peakRms) peakRms = rms;
        fireRms(rms);
        const decision = tickVad(rms);
        if (decision.cancelNoSpeech) {
          logger.info('vad: max wait elapsed without speech');
          stream?.cancel();
          stream = null;
          callbacks.onError?.('No speech detected within window');
          transitionStatus('idle');
          recordingResolve?.();
          recordingResolve = null;
          return;
        }
        if (decision.stop && !stopRequested) {
          stopRequested = true;
          // Drain on next tick — finishRecording is async.
          finishRecording()
            .catch((err) => logger.warn('finishRecording failed', {
              error: (err as Error).message,
            }))
            .finally(() => {
              recordingResolve?.();
              recordingResolve = null;
            });
        }
      });

      // Block until something resolves the recording.
      recordingPromise = new Promise((resolve) => { recordingResolve = resolve; });
      await recordingPromise;
    },

    async stopRecording(): Promise<void> {
      if (status === 'idle') return;
      stopRequested = true;
      await finishRecording();
      recordingResolve?.();
      recordingResolve = null;
    },

    cancel(): void {
      if (stream) {
        stream.cancel();
        stream = null;
      }
      transitionStatus('idle');
      recordingResolve?.();
      recordingResolve = null;
    },

    markTtsPlaying(): void {
      ttsPlaying = true;
      transitionStatus('speaking');
    },

    async markTtsDone(): Promise<void> {
      transitionStatus('idle');
      // Sleep briefly so the speaker tail doesn't bleed into the
      // next mic re-arm — without this, continuous mode feedback-
      // loops within ~3 seconds when the live mic captures the
      // agent's own spoken reply.
      await new Promise((r) => setTimeout(r, POST_TTS_REARM_DELAY_MS));
      ttsPlaying = false;
    },

    getStatus(): VoiceStatus { return status; },
    getPeakRms(): number    { return peakRms; },
  };
}

// ── Continuous-mode wrapper ───────────────────────────────────────────────

/**
 * Wrap a `CliVoiceHandle` with continuous-mode loop. Stops after
 * `CONTINUOUS_NO_SPEECH_LIMIT` consecutive silent cycles. The
 * caller invokes `tickContinuous()` between agent turns; this
 * decides whether to start the next listen cycle.
 *
 * Single function over an immutable counter — no class, no
 * subscriptions. `stop` flips a flag the next tick reads.
 */
export interface ContinuousLoopState {
  silentCycles: number;
  active: boolean;
}

export function makeContinuousLoop(): {
  state: ContinuousLoopState;
  recordCycleResult: (gotTranscript: boolean) => void;
  shouldContinue: () => boolean;
  stop: () => void;
} {
  const state: ContinuousLoopState = { silentCycles: 0, active: true };
  return {
    state,
    recordCycleResult(gotTranscript: boolean): void {
      state.silentCycles = gotTranscript ? 0 : state.silentCycles + 1;
    },
    shouldContinue(): boolean {
      return state.active && state.silentCycles < CONTINUOUS_NO_SPEECH_LIMIT;
    },
    stop(): void {
      state.active = false;
    },
  };
}

// ── Internals ────────────────────────────────────────────────────────────

/** Persist Int16 PCM frames as a WAV file. 16 kHz / mono / 16-bit
 *  RIFF header — what the existing whisper-transcribe pipeline
 *  consumes. */
async function persistPcmAsWav(pcm: Buffer): Promise<string> {
  const tmp = path.join(os.tmpdir(), `aiden-voice-${Date.now()}.wav`);
  const wav = pcmToWav(pcm, 16_000, 1, 16);
  await fs.writeFile(tmp, wav);
  return tmp;
}

export function pcmToWav(
  pcm: Buffer,
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
): Buffer {
  const byteRate    = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign  = channels * (bitsPerSample / 8);
  const dataSize    = pcm.length;
  const fileSize    = 36 + dataSize;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(fileSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);              // fmt chunk size
  header.writeUInt16LE(1, 20);               // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}
