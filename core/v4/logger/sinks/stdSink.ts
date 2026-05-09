/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/logger/sinks/stdSink.ts — Phase v4.1-1.3a
 *
 * Stdout / stderr sinks. Two flavours:
 *
 *   - StderrSink     — pretty single-line format; used in cli-headless
 *                      mode for warnings + errors so the user sees them
 *                      without polluting stdout (which scripts may pipe).
 *   - StdoutJsonSink — NDJSON one-record-per-line; used in `serve` mode
 *                      so log aggregators (systemd-journald, docker logs,
 *                      Loki, etc.) get structured fields.
 *
 * No StdoutPrettySink in 3a — `cli-interactive` deliberately wires no
 * stdout sink at all (REPL is sacred), and `cli-headless` uses the
 * stderr flavour so stdout stays free for tool output piping. If a
 * future mode needs colourful stdout (e.g. `aiden status` one-shot),
 * add it then.
 */

import type { LogRecord, LoggerSink, LogLevel } from '../logger';

const LEVEL_THRESHOLD: Readonly<Record<LogLevel, number>> = {
  debug: 10, info: 20, warn: 30, error: 40,
};

export interface StderrSinkOptions {
  /** Drop records below this level. Defaults to `'warn'` so info noise stays in files. */
  minLevel?: LogLevel;
}

export class StderrSink implements LoggerSink {
  private readonly minLevel: number;

  constructor(opts: StderrSinkOptions = {}) {
    this.minLevel = LEVEL_THRESHOLD[opts.minLevel ?? 'warn'];
  }

  write(r: LogRecord): void {
    if (LEVEL_THRESHOLD[r.level] < this.minLevel) return;
    const scope = r.scope ? ` [${r.scope}]` : '';
    try {
      process.stderr.write(
        `${r.ts.toISOString()} [${r.level}]${scope} ${r.msg}\n`,
      );
    } catch { /* dropped */ }
  }
}

/**
 * NDJSON stdout for `serve` mode. One record per line, structured
 * fields preserved. Aggregators love this; humans don't. Headless
 * scripts that want pretty output use the file sink instead and tail
 * the log file.
 */
export class StdoutJsonSink implements LoggerSink {
  private readonly minLevel: number;

  constructor(opts: { minLevel?: LogLevel } = {}) {
    this.minLevel = LEVEL_THRESHOLD[opts.minLevel ?? 'debug'];
  }

  write(r: LogRecord): void {
    if (LEVEL_THRESHOLD[r.level] < this.minLevel) return;
    const payload: Record<string, unknown> = {
      ts:    r.ts.toISOString(),
      level: r.level,
      scope: r.scope || undefined,
      msg:   r.msg,
    };
    if (r.ctx) Object.assign(payload, r.ctx);
    try {
      process.stdout.write(safeJson(payload) + '\n');
    } catch { /* dropped */ }
  }
}

function safeJson(obj: Record<string, unknown>): string {
  try { return JSON.stringify(obj); }
  catch { return '{"err":"unserializable"}'; }
}
