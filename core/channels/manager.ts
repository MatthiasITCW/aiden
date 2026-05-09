// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================

// core/channels/manager.ts — Unified channel lifecycle manager.
//
// Usage (in server startup):
//
//   import { channelManager } from './channels/manager'
//   import { DiscordAdapter } from './channels/discord'
//   import { SlackAdapter }   from './channels/slack'
//   import { WebhookAdapter } from './channels/webhook'
//
//   channelManager.register(new DiscordAdapter())
//   channelManager.register(new SlackAdapter())
//   channelManager.register(new WebhookAdapter(expressApp))
//
//   const results = await channelManager.startAll()
//   // logs: "Channels: discord ✓ | slack (disabled) | webhook ✓"

import type { ChannelAdapter } from './adapter'
import { noopLogger, type Logger } from '../v4/logger'

// ── Result types ───────────────────────────────────────────

export interface ChannelStartResult {
  name:    string
  status:  'started' | 'disabled' | 'failed'
  error?:  string
}

export interface ChannelStatus {
  name:                string
  healthy:             boolean
  lastActivity?:       number
  lastMessageTimestamp?: number
  configValid:         boolean
}

// ── ChannelManager ─────────────────────────────────────────

export interface ChannelManagerOptions {
  /**
   * Phase v4.1-1.3a — logger for startup / lifecycle events. Defaults
   * to noopLogger (silent). Boot path passes a real one; the singleton
   * exposes `attachLogger()` for retroactive injection by api/server.ts.
   */
  logger?: Logger
}

export class ChannelManager {
  private adapters:     Map<string, ChannelAdapter> = new Map()
  private lastActivity: Map<string, number>         = new Map()
  private log:          Logger

  constructor(opts: ChannelManagerOptions = {}) {
    this.log = opts.logger ?? noopLogger()
  }

  /**
   * Phase v4.1-1.3a — late-binding logger setter. Lets the singleton
   * pick up a real logger after construction (api/server.ts boot path
   * imports the singleton; we can't change its constructor without
   * breaking every existing import site).
   */
  attachLogger(logger: Logger): void {
    this.log = logger
  }

  /** Register an adapter — must be called before startAll(). */
  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.name, adapter)
    // Phase v4.1-1.3a — hand the adapter a scoped child logger so its
    // own diagnostics route through the same sink chain as the manager.
    // Adapters that haven't been migrated yet skip silently (no method).
    if (typeof adapter.attachLogger === 'function') {
      adapter.attachLogger(this.log.child(adapter.name))
    }
  }

  /**
   * Start all registered adapters.
   * Each adapter self-checks its credentials and reports 'started' or 'disabled'.
   * Adapters that throw are marked 'failed' — startup continues for others.
   */
  async startAll(): Promise<ChannelStartResult[]> {
    const results: ChannelStartResult[] = []

    for (const [name, adapter] of this.adapters) {
      try {
        await adapter.start()
        const status: ChannelStartResult['status'] = adapter.isHealthy() ? 'started' : 'disabled'
        results.push({ name, status })
      } catch (error: any) {
        this.log.error(`${name} failed to start: ${error.message}`)
        results.push({ name, status: 'failed', error: String(error.message) })
      }
    }

    // Summary line — single info record so log files capture the
    // boot snapshot. CLI mode: routes to file only (REPL stays clean).
    // Serve mode: routes to NDJSON stdout for log aggregators.
    const summary = results
      .map(r => {
        if (r.status === 'started')  return `${r.name} ✓`
        if (r.status === 'disabled') return `${r.name} (disabled)`
        return `${r.name} ✗ ${r.error ?? ''}`
      })
      .join(' | ')

    if (results.length > 0) this.log.info(`startup: ${summary}`)

    return results
  }

  /** Gracefully stop all adapters — called on SIGTERM / shutdown */
  async stopAll(): Promise<void> {
    for (const [, adapter] of this.adapters) {
      try {
        await adapter.stop()
      } catch (e: any) {
        this.log.error(`Error stopping ${adapter.name}: ${e.message}`)
      }
    }
  }

  /** Current health status for all registered adapters */
  getStatus(): ChannelStatus[] {
    return Array.from(this.adapters.values()).map(adapter => ({
      name:                 adapter.name,
      healthy:              adapter.isHealthy(),
      lastActivity:         this.lastActivity.get(adapter.name),
      lastMessageTimestamp: this.lastActivity.get(adapter.name),
      configValid:          adapter.isHealthy(),
    }))
  }

  /** Record an activity timestamp for a channel (called by gateway hooks, etc.) */
  recordActivity(name: string): void {
    this.lastActivity.set(name, Date.now())
  }

  /** Restart a specific adapter by name */
  async restart(name: string): Promise<ChannelStartResult> {
    const adapter = this.adapters.get(name)
    if (!adapter) return { name, status: 'failed', error: `Unknown channel: ${name}` }
    try {
      await adapter.stop()
      await adapter.start()
      return { name, status: adapter.isHealthy() ? 'started' : 'disabled' }
    } catch (error: any) {
      return { name, status: 'failed', error: String(error.message) }
    }
  }

  /** Get a single adapter by name */
  get(name: string): ChannelAdapter | undefined {
    return this.adapters.get(name)
  }
}

/** Singleton instance — import this in server.ts and cli handlers */
export const channelManager = new ChannelManager()
