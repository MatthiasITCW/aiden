// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================

// core/gateway.ts — Unified channel router.
// All inbound messages (dashboard, Telegram, API, future channels)
// are routed through a single processor so they share the same
// memory, context, and tool pipeline.
//
// Phase v4.1-1.3a — replaced direct console.* writes with the
// Logger contract from `core/v4/logger`. The CLI's REPL is sacred:
// in cli-interactive mode the boot logger has no stdout sink, so
// route/register lines go to ~/.aiden/logs/aiden.log instead of
// corrupting the chat prompt. The legacy code path remains
// available — until `attachLogger()` is called the noopLogger
// silently drops every record (better than console.log for the
// REPL invariant). api/server.ts in serve mode wires a logger
// that writes NDJSON to stdout, preserving the daemon trace.

import { sessionRouter } from './sessionRouter'
import { noopLogger, type Logger } from './v4/logger'

// ── Types ──────────────────────────────────────────────────────

export type ChannelType =
  | 'dashboard'
  | 'telegram'
  | 'discord'
  | 'slack'
  | 'whatsapp'
  | 'signal'
  | 'sms'
  | 'imessage'
  | 'email'
  | 'api'
  | 'tui'

export interface IncomingMessage {
  channel:      ChannelType
  channelId:    string          // chat ID, user ID, etc.
  userId:       string          // unique user identifier
  text:         string
  attachments?: string[]
  timestamp:    number
  replyTo?:     string          // message ID being replied to
  sessionId?:   string          // stable cross-channel session ID (set by routeMessage)
}

export interface OutgoingMessage {
  channel:   ChannelType
  channelId: string
  text:      string
  metadata?: {
    toolsUsed?: string[]
    cost?:      number
    duration?:  number
  }
}

export type MessageHandler  = (message: IncomingMessage) => Promise<string>
export type DeliveryHandler = (message: OutgoingMessage) => Promise<boolean>

// ── Gateway class ──────────────────────────────────────────────

class Gateway {
  private handlers:         Map<ChannelType, DeliveryHandler> = new Map()
  private messageProcessor: MessageHandler | null             = null
  private activeChannels:   Set<ChannelType>                  = new Set()
  private log:              Logger = noopLogger()

  // ── Logger injection ─────────────────────────────────────────
  //
  // Phase v4.1-1.3a — boot wires this once before any registerChannel
  // / routeMessage call. Until then, noopLogger drops everything so
  // accidentally-imported gateway code in tests / scripts can't leak
  // anything to stdout.

  attachLogger(logger: Logger): void {
    this.log = logger
  }

  // ── Register the central message processor (Aiden's brain) ───

  setProcessor(handler: MessageHandler): void {
    this.messageProcessor = handler
  }

  // ── Register a channel's outbound delivery method ─────────────

  registerChannel(channel: ChannelType, deliveryHandler: DeliveryHandler): void {
    this.handlers.set(channel, deliveryHandler)
    this.activeChannels.add(channel)
    this.log.info(`channel registered: ${channel}`)
  }

  // ── Unregister a channel ──────────────────────────────────────

  unregisterChannel(channel: ChannelType): void {
    this.handlers.delete(channel)
    this.activeChannels.delete(channel)
    this.log.info(`channel unregistered: ${channel}`)
  }

  // ── Route an incoming message through Aiden ───────────────────

  async routeMessage(message: IncomingMessage): Promise<string> {
    if (!this.messageProcessor) {
      throw new Error('No message processor registered')
    }

    // Resolve stable cross-channel session and attach sessionId
    const session        = sessionRouter.getSession(message.userId, message.channel)
    session.messageCount++
    message.sessionId    = session.sessionId

    this.log.debug(
      `${message.channel}:${message.channelId} → "${message.text.substring(0, 60)}"`,
      { sessionId: session.sessionId },
    )

    const start = Date.now()

    try {
      let response = await this.messageProcessor(message)
      const duration = Date.now() - start

      this.log.debug(`response ready → ${message.channel}`, { durationMs: duration })

      // Hint on Telegram first message: conversation continues on desktop
      if (message.channel === 'telegram' && session.messageCount === 1) {
        response += '\n\n_Tip: Continue this conversation on your desktop dashboard with full context._'
      }

      return response
    } catch (error) {
      this.log.error(
        `processing failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      return 'Something went wrong processing your message. Try again.'
    }
  }

  // ── Deliver a message to a specific channel ───────────────────

  async deliver(message: OutgoingMessage): Promise<boolean> {
    const handler = this.handlers.get(message.channel)
    if (!handler) {
      this.log.warn(`no handler for channel: ${message.channel}`)
      return false
    }

    try {
      return await handler(message)
    } catch (error) {
      this.log.error(
        `delivery failed to ${message.channel}: ` +
          (error instanceof Error ? error.message : String(error)),
      )
      return false
    }
  }

  // ── Broadcast to all active channels ─────────────────────────

  async broadcast(text: string, exclude?: ChannelType): Promise<void> {
    for (const channel of this.activeChannels) {
      if (channel === exclude) continue
      await this.deliver({ channel, channelId: 'broadcast', text })
    }
  }

  // ── Channel status list ────────────────────────────────────────

  getStatus(): Array<{ channel: ChannelType; active: boolean }> {
    const allChannels: ChannelType[] = [
      'dashboard', 'telegram', 'discord', 'slack', 'whatsapp', 'signal', 'sms', 'imessage', 'email', 'api',
    ]
    return allChannels.map(ch => ({
      channel: ch,
      active:  this.activeChannels.has(ch),
    }))
  }
}

export const gateway = new Gateway()
