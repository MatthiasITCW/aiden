// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================

// core/channels/pdf-extract.ts — Phase v4.1-4.
//
// Channel-side adapter for inbound PDFs. Wraps the existing
// `core/fileIngestion.ts` `extractPDF` function with the policies
// the Telegram adapter cares about:
//
//   1. 20 MB pre-download size cap matching Telegram's documented
//      Bot API getFile attachment limit. Refusing here keeps the
//      polling loop from spending bandwidth on a payload Telegram
//      would refuse to deliver anyway.
//   2. Token-budget truncation. The agent loop has to fit the PDF
//      content INSIDE the user turn alongside system prompts, prior
//      history, and a reserve for the response. We cap injected text
//      at the lesser of:
//        - 50,000 characters (hard ceiling — keeps pathological
//          200-page PDFs from blowing the budget on small models)
//        - (modelContextWindow - 8K reserved-for-response) * 4
//          chars/token (rough OpenAI heuristic, errs on the safe side)
//      and report `{ truncated: true, originalChars }` so the channel
//      adapter can append a "PDF truncated to fit context, original
//      was N chars" note inside the agent annotation.
//   3. Result-shape contract that maps onto the bracketed user-turn
//      annotation the adapter emits. Failures return `success:false`
//      with a human-readable `error` so the agent gets a directive
//      ("[transcription failed: …. Apologize and ask them to send a
//      shorter file.]") instead of an empty message.
//
// Logger comes from the v4.1-1.3a contract; defaults to a noop sink.

import { promises as fs } from 'node:fs'

import { extractPDF } from '../fileIngestion'
import { noopLogger, type Logger } from '../v4/logger'

// 20 MiB. Telegram's documented Bot API attachment download limit.
// Anything bigger would have been refused by getFile upstream, so
// we reject here without spending bandwidth on the round-trip.
export const MAX_PDF_BYTES = 20 * 1024 * 1024

/** Hard ceiling on injected PDF text — protects small-context models. */
export const HARD_CHAR_CAP = 50_000

/** Reserved tokens for the agent's response when computing context budget. */
const RESPONSE_RESERVED_TOKENS = 8_000

/** Conservative chars-per-token estimate for budget math. */
const CHARS_PER_TOKEN = 4

/**
 * Test seam — production wires `extractPDF` from `../fileIngestion`,
 * smokes inject a stub that returns canned text without invoking
 * `pdf-parse`.
 */
export type ExtractFn = (filePath: string) => Promise<{
  text:      string
  wordCount: number
  pageCount: number
  format:    string
}>

export interface PdfOptions {
  /** Absolute path to a downloaded PDF file. */
  filePath: string
  /**
   * Active model context window (tokens). When set, the truncation
   * cap is computed as `min(HARD_CHAR_CAP, (window - 8K) * 4)`. When
   * unset, falls back to `HARD_CHAR_CAP`.
   */
  modelContextWindow?: number
  /** Logger from `core/v4/logger`. Defaults to noop. */
  logger?: Logger
  /** Test seam — override the size cap without staging a 20 MB fixture. */
  maxBytesOverride?: number
  /** Test seam — inject a fake extractor. */
  extractFn?: ExtractFn
}

export interface PdfResult {
  /** True when extraction produced usable text. */
  success: boolean
  /** Extracted text, possibly truncated; empty on failure. */
  text?: string
  /** True when the original text was longer than the budget. */
  truncated: boolean
  /** Pre-truncation character count; only present when truncated or on success. */
  originalChars?: number
  /** Pages parsed by `pdf-parse`. */
  pageCount?: number
  /** Word count of the FINAL (post-truncation) text. */
  wordCount?: number
  /** Populated on `success: false`; safe to surface to the agent. */
  error?: string
}

/**
 * Extract a PDF and return text bounded by the channel-layer's
 * truncation policy. Never throws — failures land on
 * `success: false` with a human-readable `error`.
 */
export async function extractPdfForChannel(opts: PdfOptions): Promise<PdfResult> {
  const log = opts.logger ?? noopLogger()
  const cap = opts.maxBytesOverride ?? MAX_PDF_BYTES

  // ── 1. Size precheck ────────────────────────────────────────────
  let sizeBytes: number
  try {
    const st = await fs.stat(opts.filePath)
    sizeBytes = st.size
  } catch (e: any) {
    log.warn('pdf file not readable', { path: opts.filePath, error: e?.message })
    return { success: false, truncated: false, error: `pdf file not readable: ${e?.message ?? 'unknown error'}` }
  }
  if (sizeBytes > cap) {
    log.warn('pdf file too large', { sizeBytes, cap })
    return {
      success:   false,
      truncated: false,
      error:     `PDF too large: ${(sizeBytes / (1024 * 1024)).toFixed(1)} MB ` +
                 `(cap is ${(cap / (1024 * 1024)).toFixed(0)} MB).`,
    }
  }

  // ── 2. Hand off to the local extractor ──────────────────────────
  const extractor = opts.extractFn ?? extractPDF
  let extracted: { text: string; wordCount: number; pageCount: number; format: string }
  try {
    extracted = await extractor(opts.filePath)
  } catch (e: any) {
    log.error('pdf extraction threw', { error: e?.message ?? String(e) })
    return {
      success:   false,
      truncated: false,
      error:     `pdf extraction failed: ${e?.message ?? 'unknown error'}`,
    }
  }

  const fullText = (extracted.text ?? '').trim()
  if (!fullText) {
    log.warn('pdf extracted empty text', { pageCount: extracted.pageCount })
    return {
      success:   false,
      truncated: false,
      pageCount: extracted.pageCount,
      error:     'pdf extraction returned empty text (scanned image PDF?)',
    }
  }

  // ── 3. Truncation budget ────────────────────────────────────────
  const charBudget = computeCharBudget(opts.modelContextWindow)
  const originalChars = fullText.length

  if (originalChars <= charBudget) {
    log.info('pdf extracted', {
      pageCount:  extracted.pageCount,
      chars:      originalChars,
      truncated:  false,
    })
    return {
      success:    true,
      text:       fullText,
      truncated:  false,
      originalChars,
      pageCount:  extracted.pageCount,
      wordCount:  extracted.wordCount,
    }
  }

  // Truncate to the budget — slice on a sentence/paragraph boundary
  // when one's available within the last 1 KB of the budget so we
  // don't mid-word the agent's view of the text.
  const truncatedText = truncateOnBoundary(fullText, charBudget)
  log.info('pdf extracted (truncated)', {
    pageCount:    extracted.pageCount,
    originalChars,
    finalChars:   truncatedText.length,
    budget:       charBudget,
  })

  return {
    success:       true,
    text:          truncatedText,
    truncated:     true,
    originalChars,
    pageCount:     extracted.pageCount,
    wordCount:     countWords(truncatedText),
  }
}

/**
 * Compute the truncation budget. When `modelContextWindow` is given,
 * subtract 8K reserved-for-response tokens, multiply by 4 chars/token,
 * and cap at the hard 50K ceiling. When not given, fall back to the
 * hard ceiling. Always returns at least 4 KB so a tiny-context model
 * doesn't end up with nothing.
 */
function computeCharBudget(modelContextWindow: number | undefined): number {
  if (typeof modelContextWindow !== 'number' || !Number.isFinite(modelContextWindow) || modelContextWindow <= 0) {
    return HARD_CHAR_CAP
  }
  const usableTokens = Math.max(0, modelContextWindow - RESPONSE_RESERVED_TOKENS)
  const usableChars  = usableTokens * CHARS_PER_TOKEN
  const budget = Math.min(HARD_CHAR_CAP, usableChars)
  return Math.max(budget, 4_000)
}

/**
 * Slice `text` at `cap` characters but try to land on the last newline
 * in the trailing 1 KB of the cap, falling back to the last sentence
 * terminator, finally a hard cut.
 */
function truncateOnBoundary(text: string, cap: number): string {
  if (text.length <= cap) return text
  const window = text.slice(0, cap)
  const tailStart = Math.max(0, cap - 1024)
  const lastNewline = window.lastIndexOf('\n', cap)
  if (lastNewline >= tailStart) return window.slice(0, lastNewline)
  // Match common sentence terminators; English-centric but Devanagari
  // and Latin punctuation both work since `.` is in the regex.
  const terminator = window.slice(tailStart).search(/[.!?।]\s/)
  if (terminator >= 0) {
    const cutAt = tailStart + terminator + 1
    return window.slice(0, cutAt)
  }
  return window
}

function countWords(text: string): number {
  if (!text) return 0
  return text.trim().split(/\s+/).filter(Boolean).length
}
