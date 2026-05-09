// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================

// core/channels/adapter.ts — Minimal contract every channel adapter must satisfy.
//
// All channel adapters (Discord, Slack, Webhook, Telegram wrapper, etc.) implement
// this interface so the ChannelManager can start, stop, and query them uniformly.
//
// Phase v4.1-1.3a — adapters opt into the unified Logger contract via
// `attachLogger`. The ChannelManager calls it on register() with a child
// logger scoped to the adapter name (e.g. `channels.telegram`). Adapters
// that don't implement it keep their legacy console.* behaviour — the
// rollout is per-adapter.

import type { Logger } from '../v4/logger'

export interface ChannelAdapter {
  /** Unique channel name — matches gateway ChannelType where applicable */
  readonly name: string

  /**
   * Start the channel: connect to the external service, register event handlers,
   * and call gateway.registerChannel() for outbound delivery.
   * Must NOT throw if credentials are missing — log a warning and return.
   */
  start(): Promise<void>

  /**
   * Gracefully disconnect and clean up resources.
   * Called on SIGTERM / shutdown — must never throw.
   */
  stop(): Promise<void>

  /**
   * Send a message to a specific target on this channel.
   * target semantics are channel-specific (channelId, userId, etc.)
   */
  send(target: string, message: string): Promise<void>

  /** True if the adapter is connected and healthy. */
  isHealthy(): boolean

  /**
   * Phase v4.1-1.3a — optional logger handoff. ChannelManager.register
   * invokes this when present so the adapter routes diagnostics through
   * a scoped child logger instead of console.*. Optional because the
   * migration is rolling out adapter-by-adapter; new code must implement
   * it (and never call console.* directly).
   */
  attachLogger?(logger: Logger): void
}
