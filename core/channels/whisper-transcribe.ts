// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================

// core/channels/whisper-transcribe.ts — Phase v4.1-3.
//
// Channel-side Whisper adapter. Wraps the canonical
// `core/voice/stt.ts` chain with three Telegram-specific concerns:
//
//   1. 25 MB pre-upload size cap. Telegram voice/audio messages can
//      claim arbitrary `file_size`; if a malicious caller manages to
//      pass through a 200 MB blob we want to refuse before burning a
//      Whisper API quota. The cap matches both the Telegram Bot API
//      attachment ceiling and the OpenAI Whisper request limit.
//   2. Whisper hallucination guard. Both Groq and OpenAI Whisper
//      sometimes return a known set of "noise transcripts" on near-
//      silent input — "Thank you for watching", "Subtitles by …",
//      etc. We catch the common shapes and convert them to an
//      `isHallucination` failure so the caller can render a helpful
//      "I couldn't make out your voice — please type instead"
//      annotation rather than ferrying the noise to the agent.
//   3. Result-shape contract that matches the channel adapter's
//      expectations:
//        TranscriptionResult = {
//          success, text?, avgLogprob?, error?, isHallucination?,
//          provider?, durationMs?
//        }
//      `avgLogprob` is the average of segment-level Whisper
//      `avg_logprob` — values are negative; closer to 0 = more
//      confident. The Telegram adapter uses this against the
//      `TELEGRAM_VOICE_CONFIDENCE_THRESHOLD` env var (default -0.5)
//      to decide whether to echo the transcript to the user before
//      handing it to the agent.
//
// No console.* — every diagnostic uses the injected `Logger` from
// `core/v4/logger`, defaulting to noop when none is wired.

import { promises as fs } from 'node:fs'

import { transcribe, type SttOptions } from '../voice/stt'
import { noopLogger, type Logger }      from '../v4/logger'

// 25 MiB. Telegram Bot API hard cap for attachments downloadable via
// getFile() is 20 MB (the *upload* limit is 50 MB), and OpenAI's
// Whisper request limit is 25 MB. Use the higher of the two we're
// sending TO so a fortunate-edge-case 22 MB OGG doesn't fail late.
export const MAX_VOICE_BYTES = 25 * 1024 * 1024

/**
 * Whisper hallucination patterns. Case-insensitive, anchored loosely
 * so common variants (capitalisation, surrounding punctuation, the
 * "by Amara.org" credit appearing on its own line) all match. Order
 * is irrelevant — we OR them.
 *
 * Sources observed on near-silent or short noise inputs from both the
 * Groq `whisper-large-v3` model and the OpenAI `whisper-1` model.
 */
const HALLUCINATION_PATTERNS: readonly RegExp[] = [
  /thank\s+you\s+for\s+watching/i,
  /thanks\s+for\s+watching/i,
  /subtitles?\s+by/i,
  /amara\.org/i,
  /¡subt[íi]tulos\s+por/i,
  /sous-titrage/i,
]

export interface TranscriptionResult {
  success:          boolean
  text?:            string
  avgLogprob?:      number
  error?:           string
  isHallucination?: boolean
  provider?:        string
  durationMs?:      number
}

export interface TranscribeOptions {
  /** Absolute path to a downloaded audio file (.ogg / .mp3 / .wav etc.). */
  filePath:  string
  /** BCP-47 language hint, e.g. 'hi' or 'mr'. Optional — default auto. */
  language?: string
  /** Logger from core/v4/logger. Defaults to noop (REPL-safe). */
  logger?:   Logger
  /**
   * Test seam — override the size cap. Production code never sets this;
   * the smoke uses it to verify the cap fires without staging a 25 MB
   * fixture on disk.
   */
  maxBytesOverride?: number
}

/**
 * Transcribe an audio file via the existing Aiden Whisper chain,
 * applying channel-side guards (size cap, hallucination filter,
 * confidence surfacing).
 *
 * Never throws — failures land on `result.success = false` with a
 * human-readable `error`. Callers should treat any of these as a
 * "transcription failed" signal:
 *
 *   - `success === false`            (size cap, network, no provider)
 *   - `isHallucination === true`     (transcript matched noise pattern)
 *
 * Confident vs. low-confidence is the caller's call. Use:
 *
 *     const confident = (result.avgLogprob ?? 0) >= -0.5
 *
 * (default threshold; configurable via `TELEGRAM_VOICE_CONFIDENCE_THRESHOLD`).
 */
export async function transcribeForChannel(
  opts: TranscribeOptions,
): Promise<TranscriptionResult> {
  const log = opts.logger ?? noopLogger()
  const cap = opts.maxBytesOverride ?? MAX_VOICE_BYTES

  // ── 1. Size precheck ────────────────────────────────────────────
  // Stat the file directly rather than trusting whatever size hint
  // came down the wire — by the time this runs the file is on local
  // disk, so the on-disk size is the truth. Refusing here avoids
  // burning a Whisper API call on a payload it would reject anyway.
  let sizeBytes: number
  try {
    const st = await fs.stat(opts.filePath)
    sizeBytes = st.size
  } catch (e: any) {
    log.warn('voice file not readable', { path: opts.filePath, error: e?.message })
    return {
      success: false,
      error:   `audio file not readable: ${e?.message ?? 'unknown error'}`,
    }
  }
  if (sizeBytes > cap) {
    log.warn('voice file too large', { sizeBytes, cap })
    return {
      success: false,
      error:   `File too large: ${(sizeBytes / (1024 * 1024)).toFixed(1)} MB ` +
               `(cap is ${(cap / (1024 * 1024)).toFixed(0)} MB).`,
    }
  }

  // ── 2. Hand off to the canonical chain ──────────────────────────
  const sttOpts: SttOptions = {
    audioFilePath: opts.filePath,
    logger:        log,
  }
  if (opts.language) sttOpts.language = opts.language

  const result = await transcribe(sttOpts)

  if (result.error || !result.text) {
    return {
      success:    false,
      error:      result.error ?? 'empty transcript',
      provider:   result.provider,
      durationMs: result.durationMs,
    }
  }

  // ── 3. Hallucination guard ──────────────────────────────────────
  if (isHallucinatedTranscript(result.text)) {
    log.info('hallucinated transcript discarded', { snippet: result.text.slice(0, 60) })
    return {
      success:         false,
      isHallucination: true,
      text:            result.text,
      error:           'Whisper returned a known noise pattern',
      provider:        result.provider,
      durationMs:      result.durationMs,
    }
  }

  return {
    success:    true,
    text:       result.text,
    provider:   result.provider,
    durationMs: result.durationMs,
    ...(typeof result.confidence === 'number' ? { avgLogprob: result.confidence } : {}),
  }
}

/**
 * True when `text` matches one of the well-known Whisper noise
 * outputs. Empty / whitespace-only strings also count — both Whisper
 * variants emit them on dead silence and the channel layer wants
 * them treated identically to noise.
 */
export function isHallucinatedTranscript(text: string): boolean {
  if (!text || !text.trim()) return true
  for (const re of HALLUCINATION_PATTERNS) {
    if (re.test(text)) return true
  }
  return false
}
