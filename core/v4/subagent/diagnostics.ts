/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/subagent/diagnostics.ts — Phase v4.1-subagent
 *
 * Build fingerprint + counts surfaced by `aiden subagent status` and
 * the per-fanout result envelope. The fingerprint follows the same
 * convention every Aiden phase since v4.1-3.2 has used: a constant
 * string the user can grep for to verify the running build matches
 * the phase they expected. Bump on every shipped phase. Format:
 * `v4.1-subagent[+suffix]`.
 */

/** Build fingerprint — bump per phase. Surfaced in `aiden subagent
 *  status` and the post-fanout summary line. */
export const AIDEN_SUBAGENT_BUILD = 'v4.1-subagent.2';

/** Diagnostics envelope returned alongside fanout results. */
export interface FanoutDiagnostics {
  build: string;
  /** N actually launched (may be < requested if pre-flight refused). */
  launched: number;
  /** N that returned a result (success path). */
  succeeded: number;
  /** N that errored or timed out. */
  failed: number;
  /** Total wall-clock from first spawn to last completion (ms). */
  totalMs: number;
  /** Per-subagent wall-clock (ms). Same order as `results`. */
  perSubagentMs: number[];
  /** Provider-id used per subagent. Same order as `results`. */
  providerDistribution: string[];
  /** True when only one provider was available — diversity reduces
   *  to temperature variation. Surface to the user so they can
   *  interpret the results correctly. */
  singleProviderWarning: boolean;
  /** When merge != 'all', the model that produced the merged
   *  output. Empty string when not applicable. */
  aggregator: string;
}
