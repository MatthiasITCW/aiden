/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/logger/logger.ts — Phase v4.1-1.3a
 *
 * The Logger contract. Every module that emits diagnostics goes through
 * this — never `console.*` directly. The CLI's REPL is sacred: in
 * `cli-interactive` mode the factory wires zero stdout sinks, so a
 * misbehaving module CANNOT corrupt the chat prompt.
 *
 * Three pieces:
 *   - `Logger`       — what consumers call (debug / info / warn / error
 *                      + child(scope) for nested namespaces).
 *   - `LoggerSink`   — where lines actually go (file, stderr, null, …).
 *   - `Logger` impl  — fans every line out to all attached sinks.
 *
 * Sinks are the routing surface; the factory in `./factory.ts` picks
 * the right combination per AidenMode. Adding a new module never
 * touches sink logic — modules just call `logger.info('...')` and
 * the factory decides where it goes.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Stable numeric ordering for level filtering. */
export const LOG_LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info:  20,
  warn:  30,
  error: 40,
};

/**
 * A structured log record. Sinks see this; consumers don't construct
 * it (they call the level methods on Logger). `ctx` is an optional
 * key-value payload for structured fields (request ids, durations,
 * etc.) — sinks decide whether to render or drop it.
 */
export interface LogRecord {
  ts:    Date;
  level: LogLevel;
  /**
   * Dot-delimited scope path, e.g. `'channels.telegram'`. Built by
   * `Logger.child('telegram')` chaining off a parent `'channels'` logger.
   */
  scope: string;
  msg:   string;
  ctx?:  Record<string, unknown>;
}

/** Where log lines actually go. Implementations live in `./sinks/*`. */
export interface LoggerSink {
  /** Append one record. Failures must be swallowed — logging is best-effort. */
  write(record: LogRecord): void;
  /** Optional graceful close (flush buffers, close file handles). */
  close?(): Promise<void> | void;
}

/** Public consumer-facing interface. */
export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg:  string, ctx?: Record<string, unknown>): void;
  warn(msg:  string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;

  /**
   * Build a sub-logger with the given segment appended to this logger's
   * scope. Cheap — sub-loggers share the same sink list as the parent.
   * Use sparingly — typically once per module:
   *
   *   const log = parent.child('telegram');
   *   log.info('connected as @aiden_test_bot');
   *   // → scope = 'channels.telegram'
   */
  child(segment: string): Logger;

  /**
   * Phase v4.1-1.3a — runtime level filter. Records below this level
   * are dropped before fanout. Defaults to `'debug'` (let everything
   * through; sinks decide). `setLevel('warn')` is the production knob.
   */
  setLevel(level: LogLevel): void;
  getLevel(): LogLevel;

  /** Test seam — fully detach all sinks. Subsequent writes drop silently. */
  detachAll(): void;
}

/**
 * Default `Logger` implementation. Holds a list of sinks and the
 * current scope; child loggers share the same sink list (so updating
 * the level / detaching at the root affects everything).
 */
export class CoreLogger implements Logger {
  private level: LogLevel;
  private readonly sinks: LoggerSink[];
  private readonly scope: string;
  /** `null` means "use my parent's sinks" — the root holds the array. */
  private readonly sinksOwner: { sinks: LoggerSink[]; level: LogLevel };

  /**
   * Construct a root logger. Use `child(segment)` for sub-loggers.
   * `sinks` may be empty — useful for tests; writes silently drop.
   */
  constructor(opts: { sinks: LoggerSink[]; level?: LogLevel; scope?: string }) {
    this.scope      = opts.scope ?? '';
    this.sinks      = opts.sinks;
    this.level      = opts.level ?? 'debug';
    this.sinksOwner = { sinks: this.sinks, level: this.level };
  }

  /** Internal — used by `child()` to share state with the root. */
  private static childOf(
    parent: CoreLogger,
    segment: string,
  ): CoreLogger {
    const c = Object.create(CoreLogger.prototype) as CoreLogger;
    const nextScope = parent.scope ? `${parent.scope}.${segment}` : segment;
    Object.assign(c, {
      scope: nextScope,
      sinks: parent.sinksOwner.sinks,
      level: parent.sinksOwner.level,
      sinksOwner: parent.sinksOwner,
    });
    return c;
  }

  child(segment: string): Logger {
    return CoreLogger.childOf(this, segment);
  }

  setLevel(level: LogLevel): void {
    this.sinksOwner.level = level;
    this.level = level;
  }
  getLevel(): LogLevel {
    return this.sinksOwner.level;
  }

  detachAll(): void {
    this.sinksOwner.sinks.length = 0;
  }

  debug(msg: string, ctx?: Record<string, unknown>): void { this.write('debug', msg, ctx); }
  info(msg:  string, ctx?: Record<string, unknown>): void { this.write('info',  msg, ctx); }
  warn(msg:  string, ctx?: Record<string, unknown>): void { this.write('warn',  msg, ctx); }
  error(msg: string, ctx?: Record<string, unknown>): void { this.write('error', msg, ctx); }

  private write(level: LogLevel, msg: string, ctx?: Record<string, unknown>): void {
    if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[this.sinksOwner.level]) return;
    const record: LogRecord = {
      ts: new Date(),
      level,
      scope: this.scope,
      msg,
      ctx,
    };
    // Sinks must not throw — the helpers in ./sinks/* all wrap their
    // I/O in try/catch. Be defensive anyway.
    for (const s of this.sinksOwner.sinks) {
      try { s.write(record); } catch { /* logging must not break callers */ }
    }
  }
}
