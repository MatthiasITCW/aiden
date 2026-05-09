// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================

// core/channels/telegram-groups.ts — Phase v4.1-2.
//
// Persistent per-group state for the Telegram channel:
//   - paused              — admin /pause stops the bot from replying
//   - allowedUsers        — opt-in restriction set by /allowusers
//   - title               — group display name (cached for /channel
//                           telegram groups list — Telegram's getChat
//                           costs an HTTP call per query)
//   - lastMessageAt       — wall-clock of the last seen inbound msg
//   - lastAdminAction     — when an admin last touched the state
//   - firstSeenAt         — when the bot first observed this group
//
// State lives at `<aidenRoot>/state/telegram-groups.json`. Atomic
// writes (tmp → rename) keep the file consistent across process
// crashes. Loaded once at adapter start; mutations debounce flushes
// at 1 s so a burst of admin commands doesn't hammer the disk.
//
// All diagnostics route through the v4.1-1.3a Logger contract.
// No console.* anywhere in this module.

import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'

import type { AidenPaths } from '../v4/paths'
import { noopLogger, type Logger } from '../v4/logger'

/** On-disk shape — keep narrow + JSON-safe. */
export interface TelegramGroupState {
  /** Numeric Telegram chat id, stored as string for JSON safety. */
  groupId:          string
  title?:           string
  paused:           boolean
  /** When non-empty, only these user ids may converse with the bot here. */
  allowedUsers:     string[]
  firstSeenAt:      number
  lastMessageAt?:   number
  lastAdminAction?: { actor: string; cmd: string; at: number }
}

interface OnDiskShape {
  version: 1
  groups:  Record<string, TelegramGroupState>
}

export interface TelegramGroupStoreOptions {
  paths:   AidenPaths
  logger?: Logger
  /** Debounce window for the on-disk flush (ms). Default 1000. */
  flushDebounceMs?: number
}

/**
 * In-memory + disk-backed store of per-group state. Read paths are
 * always synchronous reads of the in-memory map; mutations schedule
 * a debounced flush so a burst of admin commands collapses to one
 * write.
 */
export class TelegramGroupStore {
  private readonly statePath:        string
  private readonly stateDir:         string
  private readonly groups:           Map<string, TelegramGroupState> = new Map()
  private readonly log:              Logger
  private readonly flushDebounceMs:  number
  private flushTimer:                NodeJS.Timeout | null = null
  private loaded:                    boolean = false

  constructor(opts: TelegramGroupStoreOptions) {
    this.stateDir         = path.join(opts.paths.root, 'state')
    this.statePath        = path.join(this.stateDir, 'telegram-groups.json')
    this.log              = opts.logger ?? noopLogger()
    this.flushDebounceMs  = opts.flushDebounceMs ?? 1000
  }

  /**
   * Synchronously load on first call. Subsequent calls are no-ops.
   * Failure to read is treated as "fresh state" — better than crashing
   * the adapter on a malformed file.
   */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    if (!existsSync(this.statePath)) return
    try {
      const raw    = await fs.readFile(this.statePath, 'utf8')
      const parsed = JSON.parse(raw) as OnDiskShape
      if (parsed?.version !== 1 || !parsed.groups) return
      for (const [id, g] of Object.entries(parsed.groups)) {
        if (g && typeof g === 'object' && 'groupId' in g) {
          this.groups.set(id, normalizeOnLoad(g as TelegramGroupState))
        }
      }
      this.log.info(`loaded ${this.groups.size} group(s)`)
    } catch (err: any) {
      this.log.warn(`could not load state: ${err?.message ?? err}`)
    }
  }

  /** True when this group is allowed to interact with the bot. */
  isPaused(groupId: string): boolean {
    return this.groups.get(groupId)?.paused === true
  }

  /**
   * When an allowed-users list is set on a group, only those users may
   * converse. Empty list (the default) → everyone in the group is OK.
   * Returns true when the user is allowed.
   */
  userIsAllowed(groupId: string, userId: string): boolean {
    const g = this.groups.get(groupId)
    if (!g || g.allowedUsers.length === 0) return true
    return g.allowedUsers.includes(userId)
  }

  /** Public accessor for /channel telegram groups list. */
  list(): TelegramGroupState[] {
    return Array.from(this.groups.values()).sort((a, b) =>
      (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0),
    )
  }

  get(groupId: string): TelegramGroupState | undefined {
    return this.groups.get(groupId)
  }

  /** Record an inbound observation — bumps lastMessageAt + caches title. */
  observeMessage(groupId: string, opts: { title?: string }): void {
    const existing = this.groups.get(groupId)
    const now = Date.now()
    if (existing) {
      existing.lastMessageAt = now
      if (opts.title && existing.title !== opts.title) existing.title = opts.title
    } else {
      this.groups.set(groupId, {
        groupId,
        title:         opts.title,
        paused:        false,
        allowedUsers:  [],
        firstSeenAt:   now,
        lastMessageAt: now,
      })
    }
    this.scheduleFlush()
  }

  setPaused(groupId: string, paused: boolean, actor: string): void {
    const g = this.ensureGroup(groupId)
    g.paused = paused
    g.lastAdminAction = { actor, cmd: paused ? 'pause' : 'resume', at: Date.now() }
    this.scheduleFlush()
  }

  setAllowedUsers(groupId: string, userIds: string[], actor: string): void {
    const g = this.ensureGroup(groupId)
    g.allowedUsers = [...new Set(userIds.map(s => s.trim()).filter(Boolean))]
    g.lastAdminAction = { actor, cmd: 'allowusers', at: Date.now() }
    this.scheduleFlush()
  }

  recordAdminAction(groupId: string, cmd: string, actor: string): void {
    const g = this.ensureGroup(groupId)
    g.lastAdminAction = { actor, cmd, at: Date.now() }
    this.scheduleFlush()
  }

  /** Force-flush + clear debounce timer (called on adapter teardown). */
  async flushNow(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    await this.writeFile()
  }

  // ── Internals ─────────────────────────────────────────────────

  private ensureGroup(groupId: string): TelegramGroupState {
    let g = this.groups.get(groupId)
    if (!g) {
      g = {
        groupId,
        paused:       false,
        allowedUsers: [],
        firstSeenAt:  Date.now(),
      }
      this.groups.set(groupId, g)
    }
    return g
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.writeFile().catch((err) =>
        this.log.warn(`flush failed: ${err?.message ?? err}`),
      )
    }, this.flushDebounceMs)
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref()
  }

  private async writeFile(): Promise<void> {
    const payload: OnDiskShape = {
      version: 1,
      groups:  Object.fromEntries(this.groups),
    }
    await fs.mkdir(this.stateDir, { recursive: true })
    const tmp = `${this.statePath}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
    await fs.rename(tmp, this.statePath)
  }
}

/**
 * Defensive load-time normaliser — older state files may be missing
 * fields we've since added; fall back to safe defaults instead of
 * propagating undefined into the rest of the adapter.
 */
function normalizeOnLoad(raw: TelegramGroupState): TelegramGroupState {
  return {
    groupId:         String(raw.groupId),
    title:           typeof raw.title === 'string' ? raw.title : undefined,
    paused:          raw.paused === true,
    allowedUsers:    Array.isArray(raw.allowedUsers) ? raw.allowedUsers.map(String) : [],
    firstSeenAt:     typeof raw.firstSeenAt === 'number' ? raw.firstSeenAt : Date.now(),
    lastMessageAt:   typeof raw.lastMessageAt === 'number' ? raw.lastMessageAt : undefined,
    lastAdminAction: raw.lastAdminAction && typeof raw.lastAdminAction === 'object'
      ? raw.lastAdminAction
      : undefined,
  }
}
