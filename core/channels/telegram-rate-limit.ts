// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================

// core/channels/telegram-rate-limit.ts — Phase v4.1-2.
//
// Sliding-window per-user rate limiter for the Telegram channel.
//
// Design:
//   - In-memory only — resets on aiden restart. The threat model is
//     "stop a single chatter from burning the bot owner's quota in
//     one sitting"; a restart-bypass that costs the abuser an entire
//     restart-window's worth of messages is acceptable.
//   - Single user-id keyspace across all chats — a spammer can't dodge
//     by hopping between groups.
//   - 1-minute sliding window, default 5 messages. Both knobs are
//     configurable via env (`TELEGRAM_USER_RATE_LIMIT`,
//     `TELEGRAM_USER_RATE_WINDOW_MS`) so an op who hosts the bot for a
//     bigger community can bump them without code changes.
//   - `shouldThrottle(userId)` is the only consumer-facing method —
//     records the access *and* reports whether the caller should drop
//     the message. One lookup, one mutation, one decision.
//   - A coalescing sweeper trims stale buckets every 5 minutes so an
//     adversary can't blow the heap by hammering with fresh user ids.
//
// `TelegramRateLimiter` accepts an injected logger from the unified
// `Logger` contract (Phase v4.1-1.3a) — diagnostics file-only, REPL
// stays sacred. No console.* anywhere in this module.

import { noopLogger, type Logger } from '../v4/logger'

const DEFAULT_LIMIT     = 5
const DEFAULT_WINDOW_MS = 60_000
const SWEEP_INTERVAL_MS = 5 * 60 * 1000  // prune buckets idle > sweep+window

export interface TelegramRateLimiterOptions {
  /** Override the default 5 msgs / minute. */
  limit?:    number
  /** Override the default 60s window. */
  windowMs?: number
  /** Logger from the v4.1-1.3a Logger contract. Defaults to noop. */
  logger?:   Logger
  /** Test seam — fake clock. Defaults to `Date.now`. */
  now?:      () => number
}

export class TelegramRateLimiter {
  private readonly limit:    number
  private readonly windowMs: number
  private readonly now:      () => number
  private readonly buckets:  Map<string, number[]> = new Map()
  private readonly log:      Logger
  private sweepTimer:        NodeJS.Timeout | null = null

  constructor(opts: TelegramRateLimiterOptions = {}) {
    this.limit    = readPositiveInt(process.env.TELEGRAM_USER_RATE_LIMIT, opts.limit       ?? DEFAULT_LIMIT)
    this.windowMs = readPositiveInt(process.env.TELEGRAM_USER_RATE_WINDOW_MS, opts.windowMs ?? DEFAULT_WINDOW_MS)
    this.now      = opts.now ?? Date.now
    this.log      = opts.logger ?? noopLogger()
  }

  /**
   * Record an attempted message + return true when the caller should
   * drop it. The bucket is updated on every call (even ones that get
   * throttled), so a sustained over-limit user stays throttled until
   * the oldest message in their window ages out.
   */
  shouldThrottle(userId: string): boolean {
    if (!userId) return false
    const cutoff = this.now() - this.windowMs
    const bucket = this.buckets.get(userId) ?? []
    // Drop expired entries from the front (oldest-first list).
    while (bucket.length > 0 && bucket[0] <= cutoff) bucket.shift()
    if (bucket.length >= this.limit) {
      // Don't append on throttle so the window can age out cleanly —
      // appending here would reset the user's clock every time they
      // try to spam, locking them in indefinitely.
      this.buckets.set(userId, bucket)
      this.log.warn(`rate-limited`, { userId, count: bucket.length, limit: this.limit })
      return true
    }
    bucket.push(this.now())
    this.buckets.set(userId, bucket)
    this.scheduleSweep()
    return false
  }

  /** Test / diagnostic accessor — current bucket size for a user. */
  getCount(userId: string): number {
    const bucket = this.buckets.get(userId)
    if (!bucket) return 0
    const cutoff = this.now() - this.windowMs
    return bucket.filter((t) => t > cutoff).length
  }

  /** Stop the sweep timer (called on adapter teardown). */
  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
  }

  // ── Internal: prune fully-expired buckets so memory doesn't drift. ──

  private scheduleSweep(): void {
    if (this.sweepTimer) return
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS)
    // Don't keep the process alive just for the sweeper.
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref()
  }

  private sweep(): void {
    const cutoff = this.now() - this.windowMs
    let pruned = 0
    for (const [userId, bucket] of this.buckets) {
      const filtered = bucket.filter((t) => t > cutoff)
      if (filtered.length === 0) {
        this.buckets.delete(userId)
        pruned += 1
      } else {
        this.buckets.set(userId, filtered)
      }
    }
    if (pruned > 0) this.log.debug(`swept ${pruned} stale buckets`)
  }
}

/**
 * Parse a positive integer env var with a fallback. Negative / NaN /
 * empty values fall back to the default — better than crashing the
 * adapter because someone fat-fingered an env var.
 */
function readPositiveInt(envValue: string | undefined, fallback: number): number {
  if (typeof envValue !== 'string' || envValue.trim() === '') return fallback
  const n = Number.parseInt(envValue, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
