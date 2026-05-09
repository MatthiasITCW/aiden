/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/logger/sinks/nullSink.ts — Phase v4.1-1.3a
 *
 * Discard every record. The default for `'test'` mode so vitest output
 * stays clean even when the code under test emits warnings — and the
 * fallback when a module is constructed without a logger (the
 * `noopLogger` factory in `../factory.ts` uses this).
 *
 * `MemorySink` is also here: it captures records into an in-process
 * array so tests can assert on log output without any I/O. Two surfaces
 * in one file because they share the "nothing leaves this process"
 * property.
 */

import type { LogRecord, LoggerSink } from '../logger';

/** Drops every record. */
export class NullSink implements LoggerSink {
  write(_record: LogRecord): void { /* no-op */ }
}

/**
 * Captures every record into `records`. Tests use this:
 *
 *   const sink = new MemorySink();
 *   const log = new CoreLogger({ sinks: [sink] });
 *   log.info('hello');
 *   expect(sink.records[0].msg).toBe('hello');
 *
 * `clear()` resets between assertions; `findScope()` is a small
 * convenience for "did the channels.telegram scope log anything?".
 */
export class MemorySink implements LoggerSink {
  readonly records: LogRecord[] = [];

  write(r: LogRecord): void {
    this.records.push(r);
  }

  clear(): void {
    this.records.length = 0;
  }

  findScope(scope: string): LogRecord[] {
    return this.records.filter(
      (r) => r.scope === scope || r.scope.startsWith(`${scope}.`),
    );
  }
}
