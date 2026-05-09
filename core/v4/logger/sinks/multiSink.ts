/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/logger/sinks/multiSink.ts — Phase v4.1-1.3a
 *
 * `Logger` already fans out to every attached sink, so MultiSink is
 * thin sugar for the cases where a sink itself wants to delegate to
 * several others (e.g. wrap a stderr-warn-only filter and a file
 * everything filter behind a single object the caller treats as one
 * sink). In 3a it's used by tests; production logger compositions go
 * through `factory.createBootLogger` which picks sinks per mode.
 */

import type { LogRecord, LoggerSink } from '../logger';

export class MultiSink implements LoggerSink {
  constructor(private readonly children: LoggerSink[]) {}

  write(r: LogRecord): void {
    for (const c of this.children) {
      try { c.write(r); } catch { /* one sink's failure must not poison the others */ }
    }
  }

  async close(): Promise<void> {
    for (const c of this.children) {
      if (typeof c.close === 'function') {
        try { await c.close(); } catch { /* ignore */ }
      }
    }
  }
}
