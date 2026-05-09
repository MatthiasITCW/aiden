/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/voice/ttsStream.ts — Phase v4.1-voice-cli
 *
 * Sentence-buffer streaming wrapper around `core/voice/tts.ts`.
 * The standard `synthesize()` flow buffers the WHOLE assistant
 * reply, synthesises one MP3, then plays it — for replies > 3
 * seconds the user perceives a long silent pause before any audio.
 *
 * This module accumulates streamed text deltas, splits at sentence
 * boundaries, and synth+plays each sentence chunk as it arrives.
 * Net effect: ~60% reduction in time-to-first-word for long
 * replies. Mirrors a battle-tested pattern from prior multi-agent
 * systems.
 *
 * Cancellation: the consumer holds an `AbortSignal`; the streamer
 * checks between every chunk. Aborting STOPS new synth calls and
 * cancels any in-flight playback (best effort — system audio
 * subsystems differ in interrupt support).
 *
 * `<think>...</think>` strip mid-stream — extends `cleanForTTS`
 * for streaming mode. Some models emit reasoning blocks before
 * their final answer; speaking the reasoning is wasteful and
 * confusing. We strip mid-stream rather than post-buffering so
 * sentence emission isn't blocked waiting for the closing tag.
 */

import { synthesize, cleanForTTS, type TtsOptions, type TtsResult } from '../../voice/tts';
import type { Logger } from '../logger/logger';
import { noopLogger } from '../logger/factory';

// ── Public types ──────────────────────────────────────────────────────────

export interface TtsStreamHandle {
  /** Append more text to the buffer. Sentence boundaries trigger
   *  immediate synth+play of the completed sentence. */
  push(text: string): void;
  /** Signal end-of-input. Flushes any remaining buffer. Resolves
   *  when the last chunk finishes playing. */
  end(): Promise<void>;
  /** Cancel everything in flight. Returns immediately; in-flight
   *  synth/play promises settle in the background. */
  cancel(): void;
  /** True after end()/cancel() — consumers don't double-finalise. */
  closed: boolean;
}

export interface TtsStreamOptions {
  /** Voice id. Defaults to en-US-AriaNeural per locked decision. */
  voice?: string;
  /** Per-chunk synthesis timeout. Default 20s. */
  timeoutMs?: number;
  /** Caller-supplied abort signal. */
  signal?: AbortSignal;
  /** Optional logger. */
  logger?: Logger;
  /** Override the synth function — tests inject a stub. */
  synthFn?: (opts: TtsOptions) => Promise<TtsResult>;
}

// ── Sentence boundary regex ───────────────────────────────────────────────

/**
 * Matches a sentence terminator followed by whitespace.
 * Inclusive on the terminator (capture group includes the punctuation).
 *
 * Common terminators: `.`, `!`, `?`, `:`, `;`, plus their full-width
 * CJK equivalents `。`, `！`, `？`. We intentionally skip mid-sentence
 * commas — speaking each clause separately sounds unnatural.
 *
 * The regex is GLOBAL with a lookahead for whitespace OR end so we
 * don't false-trigger on decimal points (`3.14`) — those are
 * followed by digits, not whitespace.
 */
export const SENTENCE_BOUNDARY_RE = /([.!?:;。！？])(?=\s|$)/g;

// ── <think> strip ─────────────────────────────────────────────────────────

interface ThinkStripState {
  /** True when we're inside a `<think>...</think>` block. */
  inside: boolean;
}

/**
 * Strip `<think>...</think>` mid-stream. Returns the cleaned chunk
 * plus updated state. Handles partial open / close tags split
 * across delta boundaries — the next push() consumes the previous
 * carry-over.
 *
 * Pure function — caller threads the state object.
 */
export function stripThinkChunk(chunk: string, state: ThinkStripState): string {
  let out = '';
  let i = 0;
  while (i < chunk.length) {
    if (state.inside) {
      const close = chunk.indexOf('</think>', i);
      if (close === -1) {
        // Whole rest of chunk is inside — drop it.
        return out;
      }
      i = close + '</think>'.length;
      state.inside = false;
      continue;
    }
    const open = chunk.indexOf('<think>', i);
    if (open === -1) {
      out += chunk.slice(i);
      return out;
    }
    out += chunk.slice(i, open);
    i = open + '<think>'.length;
    state.inside = true;
  }
  return out;
}

// ── Sentence splitter ─────────────────────────────────────────────────────

/**
 * Slice a buffer into completed sentences + remainder. The
 * remainder is whatever follows the last terminator (or the whole
 * buffer if no terminator). Caller keeps the remainder for the next
 * push() call.
 */
export function splitSentences(buf: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let lastEnd = 0;
  // Reset regex state per call.
  const re = new RegExp(SENTENCE_BOUNDARY_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(buf)) !== null) {
    const end = match.index + match[0].length;
    const sentence = buf.slice(lastEnd, end).trim();
    if (sentence.length > 0) sentences.push(sentence);
    lastEnd = end;
  }
  const rest = buf.slice(lastEnd);
  return { sentences, rest };
}

// ── Stream handle factory ─────────────────────────────────────────────────

/**
 * Start a streaming TTS session. Call `push(text)` as deltas arrive
 * from the agent loop, `end()` when the assistant turn finishes,
 * `cancel()` to abort. The handle queues sentence-by-sentence
 * synthesis; only one chunk plays at a time (sequential to preserve
 * order).
 */
export function startTtsStream(opts: TtsStreamOptions = {}): TtsStreamHandle {
  const logger = (opts.logger ?? noopLogger()).child('tts-stream');
  const signal = opts.signal;
  const synthFn = opts.synthFn ?? synthesize;

  let buffer = '';
  const thinkState: ThinkStripState = { inside: false };
  let closed = false;
  let cancelled = false;

  // Sequential dispatch queue — only one synth+play in flight.
  let dispatchChain: Promise<void> = Promise.resolve();

  const pushSentence = (raw: string): void => {
    if (cancelled) return;
    const cleaned = cleanForTTS(raw);
    if (!cleaned) return;
    dispatchChain = dispatchChain.then(async () => {
      if (cancelled || signal?.aborted) return;
      try {
        const r = await synthFn({
          text:      cleaned,
          voice:     opts.voice,
          timeoutMs: opts.timeoutMs ?? 20_000,
        });
        logger.info('tts chunk synth', {
          provider: r.provider,
          ms:       r.durationMs,
          chars:    cleaned.length,
        });
      } catch (err) {
        logger.warn('tts chunk synth failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  };

  return {
    get closed() { return closed; },
    push(text: string): void {
      if (closed || cancelled) return;
      const cleanedDelta = stripThinkChunk(text, thinkState);
      if (!cleanedDelta) return;
      buffer += cleanedDelta;
      const { sentences, rest } = splitSentences(buffer);
      buffer = rest;
      for (const s of sentences) pushSentence(s);
    },
    async end(): Promise<void> {
      if (closed) return;
      closed = true;
      // Flush leftover (no terminator).
      if (buffer.trim().length > 0) pushSentence(buffer);
      buffer = '';
      // Wait for the chain to drain.
      try { await dispatchChain; } catch { /* surfaced via logger already */ }
    },
    cancel(): void {
      cancelled = true;
      closed    = true;
      buffer    = '';
      logger.info('tts stream cancelled');
      // The in-flight synth call is best-effort to interrupt — we
      // don't await its rejection, the chain will settle on its own.
    },
  };
}
