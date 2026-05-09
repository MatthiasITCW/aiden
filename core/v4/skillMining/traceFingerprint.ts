/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/skillMining/traceFingerprint.ts — Phase v4.1-skill-mining
 *
 * Deterministic content-addressing for tool-call traces.
 *
 * The fingerprint is the sha256 hex of the normalized
 * (toolName, sorted-arg-keys) sequence joined by `|`.
 *
 * Properties (verified by smoke):
 *   - identical traces produce identical hashes
 *   - traces that differ only in arg *values* (same arg keys)
 *     produce identical hashes — this is the desired behavior:
 *     "search github for X" and "search github for Y" should
 *     dedup to one candidate
 *   - traces with different tool sequences or arg keys produce
 *     different hashes
 *   - deterministic across runs (no salt, no time)
 *
 * The candidateStore + skillMiner use this to dedup proposals;
 * the rejected list also tracks fingerprints so a user-rejected
 * workflow doesn't get re-proposed on the next run.
 */

import { createHash } from 'node:crypto';

export interface FingerprintEntry {
  name:  string;
  args?: Record<string, unknown> | unknown;
}

/** Normalize a single trace entry to its fingerprint contribution. */
function normalizeEntry(entry: FingerprintEntry): string {
  const name = String(entry.name ?? '').trim().toLowerCase();
  let argKeys: string[] = [];
  if (entry.args && typeof entry.args === 'object' && !Array.isArray(entry.args)) {
    argKeys = Object.keys(entry.args as Record<string, unknown>).sort();
  }
  return `${name}(${argKeys.join(',')})`;
}

/**
 * Fingerprint a trace. Returns a 64-char lowercase sha256 hex.
 * Empty trace is a valid input (returns the hash of the empty
 * normalized string) — callers should reject empty traces before
 * fingerprinting to keep the pending queue free of useless entries.
 */
export function traceFingerprint(trace: FingerprintEntry[]): string {
  const normalized = trace.map(normalizeEntry).join('|');
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}
