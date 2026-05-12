/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/subsystemHealth.ts — Phase v4.1.2-slice3.
 *
 * Lightweight in-process telemetry for the silent-failure layers.
 * Four subsystems (ContextCompressor, SkillTeacher, SkillMiner,
 * Logger) historically caught errors and continued without
 * surfacing them — masking real bugs that were diagnosable only
 * after manual instrumentation. This module is the surface.
 *
 * Design (decision tree from slice3 Phase 3):
 *   Option C — subsystem-owned state object, optionally registered
 *   with a shared registry. The registry is constructor-injected
 *   (no singleton — singletons leak state between parallel tests),
 *   and every record op is O(1) and side-effect-free (no I/O, no
 *   log writes, no recursion through the Logger we are tracking).
 *
 * Surface:
 *   - `SubsystemHealth`        — read-only snapshot shape doctor renders
 *   - `SubsystemHealthTracker` — per-subsystem owned counter
 *   - `SubsystemHealthRegistry`— optional aggregator AidenAgent owns
 *
 * Subsystems may operate without a tracker (back-compat); when a
 * tracker is wired they call `recordSuccess()` / `recordFailure(err)`
 * at the appropriate points. The registry is read by `aiden doctor`
 * via the AidenAgent public field.
 */

/** Snapshot rendered by `aiden doctor`. Pure read shape. */
export interface SubsystemHealth {
  /** Stable subsystem id — e.g. 'compressor', 'skill-miner'. */
  subsystem:    string;
  /** Every recordSuccess() and recordFailure() call increments this. */
  totalCalls:   number;
  /** Every recordFailure() call increments this. */
  totalErrors:  number;
  /** Set after the first recordFailure(); cleared by recordSuccess. */
  lastError?: {
    message:     string;
    at:          Date;
    /** Errors-in-a-row since the last success (or since the tracker began). */
    consecutive: number;
  };
}

/**
 * Per-subsystem health counter. One instance per subsystem; cheap
 * to construct (no I/O, no allocations beyond the counter object).
 *
 * Subsystems hold a private tracker (or undefined for back-compat)
 * and call `recordSuccess()` / `recordFailure(err)` from their
 * critical paths. The tracker is registered with the registry at
 * construction; doctor reads the snapshot lazily.
 */
export class SubsystemHealthTracker {
  private _totalCalls  = 0;
  private _totalErrors = 0;
  private _consecutive = 0;
  private _lastError?: { message: string; at: Date };

  /**
   * @param subsystem  Stable id rendered by doctor. Prefer kebab-case
   *                   ('compressor', 'skill-teacher', 'logger:file-sink').
   */
  constructor(public readonly subsystem: string) {}

  /** O(1): bump call counter, reset consecutive-failure streak. */
  recordSuccess(): void {
    this._totalCalls  += 1;
    this._consecutive  = 0;
  }

  /**
   * O(1): bump call + error counters, update lastError with a
   * length-capped message. Never logs (would recurse through the
   * Logger we are tracking) and never writes to disk.
   */
  recordFailure(err: unknown): void {
    this._totalCalls  += 1;
    this._totalErrors += 1;
    this._consecutive += 1;
    const raw =
      err instanceof Error ? err.message
        : typeof err === 'string' ? err
          : safeStringify(err);
    this._lastError = {
      message: truncate(raw, 200),
      at:      new Date(),
    };
  }

  /** Render the current state. Doctor invokes this on demand. */
  snapshot(): SubsystemHealth {
    const snap: SubsystemHealth = {
      subsystem:   this.subsystem,
      totalCalls:  this._totalCalls,
      totalErrors: this._totalErrors,
    };
    if (this._lastError) {
      snap.lastError = {
        message:     this._lastError.message,
        at:          this._lastError.at,
        consecutive: this._consecutive,
      };
    }
    return snap;
  }
}

/**
 * Optional aggregator. AidenAgent owns one instance and plumbs it
 * into each subsystem at construction. Doctor reads the registry's
 * snapshot to render its "Subsystem health" section.
 *
 * Registration is by reader function so subsystems can also expose
 * non-tracker derived health (e.g. Logger renders per-sink counts
 * which aren't a single tracker's snapshot).
 */
export interface SubsystemHealthRegistry {
  /**
   * Register a subsystem. The reader function is invoked at snapshot
   * time — it must be O(1) and side-effect-free. Re-registering the
   * same id replaces the previous reader (last-write-wins).
   */
  register(subsystem: string, reader: () => SubsystemHealth | SubsystemHealth[]): void;

  /** Read every registered subsystem's current state. */
  snapshot(): SubsystemHealth[];

  /** Test seam — drop all registrations. */
  reset(): void;
}

/** Build a fresh registry. No I/O; cheap. */
export function createSubsystemHealthRegistry(): SubsystemHealthRegistry {
  const readers = new Map<string, () => SubsystemHealth | SubsystemHealth[]>();
  return {
    register(subsystem, reader) {
      readers.set(subsystem, reader);
    },
    snapshot() {
      const out: SubsystemHealth[] = [];
      for (const reader of readers.values()) {
        try {
          const v = reader();
          if (Array.isArray(v)) out.push(...v);
          else                  out.push(v);
        } catch {
          // Reader threw — skip it. Telemetry must never break doctor.
        }
      }
      return out;
    },
    reset() {
      readers.clear();
    },
  };
}

// ── private helpers ───────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}

function safeStringify(v: unknown): string {
  // `JSON.stringify(undefined)` returns the value `undefined`, not the
  // string "undefined" — guard so the downstream length-cap doesn't
  // crash. Symbols, functions, and circular objects also need a
  // String() fallback.
  try {
    const out = JSON.stringify(v);
    return typeof out === 'string' ? out : String(v);
  } catch {
    return String(v);
  }
}
