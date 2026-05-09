// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================

// core/channels/photo-vision.ts — Phase v4.1-4.
//
// Channel-side adapter for inbound photos. Wraps the existing
// `core/visionAnalyze.ts` chain with Telegram-specific concerns:
//
//   1. 25 MB pre-download size cap. Mirrors the voice path's policy
//      (Telegram Bot API getFile limit is the binding constraint).
//      Refusing here saves the round-trip when we already know the
//      payload is too big for the providers.
//   2. Mode decision — `native` vs `text` — based on whether the
//      currently active model carries a `supportsVision: true` flag in
//      `providers/v4/modelCatalog.ts`. When vision is supported, the
//      channel adapter attaches the file path on the user turn so the
//      provider sees pixels directly. Otherwise we pre-analyze with
//      the auxiliary `analyzeImage` chain (Anthropic / OpenAI / Ollama
//      llava) and prepend a description annotation — same "smuggle
//      into agent turn" pattern as voice transcripts.
//   3. Result-shape contract that matches the channel adapter's
//      expectations so the Telegram adapter's `handlePhotoMessage`
//      can branch on `mode` and assemble the right outbound payload.
//
// Logger comes from the v4.1-1.3a contract; defaults to a noop sink
// so anything that calls into this module without a wired logger
// stays REPL-clean.

import { promises as fs } from 'node:fs'

import { findModel } from '../../providers/v4/modelCatalog'
import { analyzeImage } from '../visionAnalyze'
import { noopLogger, type Logger } from '../v4/logger'

// 25 MiB. Matches the voice cap and the OpenAI / Anthropic vision
// request-size envelopes; Telegram's getFile cap is 20 MB so a 25 MB
// payload would already have been rejected upstream — but keeping
// these caps consistent simplifies the operator mental model.
export const MAX_PHOTO_BYTES = 25 * 1024 * 1024

/**
 * Default text-mode prompt. Single source so smokes and the adapter
 * agree on what gets sent to the auxiliary vision chain. Phrased
 * for the agent's perspective — the description ends up bracketed
 * inside an "[The user sent an image. Description: ...]" annotation.
 */
const DEFAULT_DESCRIBE_PROMPT =
  'Describe everything visible in this image in detail. Include any ' +
  'text, code, layout, objects, people, colors, and any other notable ' +
  'visual information.'

/**
 * Test seam — production wires `analyzeImage` from `../visionAnalyze`,
 * smokes inject a stub that returns canned `VisionResult` values
 * without hitting Anthropic / OpenAI / Ollama.
 */
export type AnalyzeFn = (
  imageSource: string,
  prompt:      string,
  logger?:     Logger,
) => Promise<{ description: string; provider: string; modelUsed: string; durationMs: number }>

export interface PhotoOptions {
  /** Absolute path to a downloaded photo file (.jpg / .png / .webp etc.). */
  filePath: string
  /**
   * Active model identifier — used to decide native vs text routing
   * via `findModel().supportsVision`. When either id is missing, or
   * the lookup returns no entry, we default to `'text'` mode so the
   * pipeline still produces a usable description.
   */
  providerId?: string
  modelId?:    string
  /** Logger from `core/v4/logger`. Defaults to noop. */
  logger?:     Logger
  /** Test seam — override the size cap without staging large fixtures. */
  maxBytesOverride?: number
  /** Test seam — inject a fake vision-analysis function. */
  analyzeFn?: AnalyzeFn
  /** Custom prompt for the text path; falls back to the default. */
  prompt?: string
}

export interface PhotoResult {
  /** True when the routing decision and any fetch succeeded. */
  success:  boolean
  /** `'native'` = adapter should attach the file path on the user turn;
   *  `'text'`   = adapter should smuggle the description into the user
   *  turn as a bracketed annotation. */
  mode:     'native' | 'text'
  /** When mode is 'native': the local file path the adapter should attach. */
  nativePath?:  string
  /** When mode is 'text': the auxiliary description the adapter should smuggle. */
  description?: string
  /** Auxiliary chain identifier (text mode only). */
  provider?:    string
  modelUsed?:   string
  durationMs?:  number
  /** Populated on `success: false`; safe to surface to the agent. */
  error?:       string
}

/**
 * Decide how an inbound photo should be presented to the model and
 * (in text mode) generate the description the channel adapter will
 * smuggle into the agent's user turn.
 *
 * Never throws — failures land on `success: false` with a
 * human-readable `error`. Callers downstream decide whether to:
 *   - hand a `[The user sent an image but description failed: ...]`
 *     directive to the agent, or
 *   - render a friendly user-facing reject reply.
 */
export async function analyzePhotoForChannel(opts: PhotoOptions): Promise<PhotoResult> {
  const log = opts.logger ?? noopLogger()
  const cap = opts.maxBytesOverride ?? MAX_PHOTO_BYTES

  // ── 1. Size precheck ────────────────────────────────────────────
  let sizeBytes: number
  try {
    const st = await fs.stat(opts.filePath)
    sizeBytes = st.size
  } catch (e: any) {
    log.warn('photo file not readable', { path: opts.filePath, error: e?.message })
    return { success: false, mode: 'text', error: `photo file not readable: ${e?.message ?? 'unknown error'}` }
  }
  if (sizeBytes > cap) {
    log.warn('photo file too large', { sizeBytes, cap })
    return {
      success: false,
      mode:    'text',
      error:   `Photo too large: ${(sizeBytes / (1024 * 1024)).toFixed(1)} MB ` +
               `(cap is ${(cap / (1024 * 1024)).toFixed(0)} MB).`,
    }
  }

  // ── 2. Mode decision ────────────────────────────────────────────
  const mode = decideMode(opts.providerId, opts.modelId, log)

  if (mode === 'native') {
    log.info('photo routed native', {
      providerId: opts.providerId,
      modelId:    opts.modelId,
      sizeBytes,
    })
    return { success: true, mode: 'native', nativePath: opts.filePath }
  }

  // ── 3. Text mode: pre-analyze via the auxiliary vision chain ────
  const analyze = opts.analyzeFn ?? analyzeImage
  try {
    const visionResult = await analyze(
      opts.filePath,
      opts.prompt ?? DEFAULT_DESCRIBE_PROMPT,
      log,
    )
    const description = (visionResult.description ?? '').trim()
    if (!description) {
      log.warn('vision chain returned empty description', { provider: visionResult.provider })
      return {
        success: false,
        mode:    'text',
        error:   'vision chain returned an empty description',
        provider:   visionResult.provider,
        modelUsed:  visionResult.modelUsed,
        durationMs: visionResult.durationMs,
      }
    }
    return {
      success:    true,
      mode:       'text',
      description,
      provider:   visionResult.provider,
      modelUsed:  visionResult.modelUsed,
      durationMs: visionResult.durationMs,
    }
  } catch (e: any) {
    log.error('vision chain threw', { error: e?.message ?? String(e) })
    return {
      success: false,
      mode:    'text',
      error:   `vision chain failed: ${e?.message ?? 'unknown error'}`,
    }
  }
}

/**
 * Resolve native-vs-text routing for the active model. Returns
 * `'text'` whenever:
 *   - either id is missing (caller didn't tell us)
 *   - the model isn't in `MODEL_CATALOG` (registry drift)
 *   - the model's `supportsVision` is false
 *   - the lookup throws for any reason
 *
 * `'text'` is the safe fallback — it always works because the
 * auxiliary `analyzeImage` chain runs against its own provider keys
 * independent of whatever the user has selected for the agent loop.
 */
function decideMode(
  providerId: string | undefined,
  modelId:    string | undefined,
  log:        Logger,
): 'native' | 'text' {
  if (!providerId || !modelId) {
    log.debug('photo mode: missing provider/model id, defaulting to text')
    return 'text'
  }
  try {
    const entry = findModel(providerId, modelId)
    if (!entry) {
      log.debug('photo mode: model not in catalog, defaulting to text', { providerId, modelId })
      return 'text'
    }
    return entry.supportsVision ? 'native' : 'text'
  } catch (e: any) {
    log.debug('photo mode: lookup threw, defaulting to text', { error: e?.message })
    return 'text'
  }
}
