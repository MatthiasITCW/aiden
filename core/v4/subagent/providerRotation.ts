/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/subagent/providerRotation.ts — Phase v4.1-subagent
 *
 * Round-robin provider selection across N subagents. v3's lesson —
 * "N samples from one provider is `temperature` with extra steps" —
 * makes provider diversity load-bearing for fanout. This module
 * decides which provider each subagent uses.
 *
 * Two layers:
 *
 *   1. If multiple providers are configured (i.e. multiple keys
 *      across distinct providerIds), round-robin across them.
 *   2. If only one provider is configured, fall back to round-robin
 *      across the slots WITHIN that provider (Groq slot 1/2/3/4,
 *      Together primary/fallback). Diversity reduces to temperature
 *      variation; the diagnostics flag this with
 *      `singleProviderWarning: true`.
 *
 * The module does NOT build adapters — it picks PROVIDER IDS and
 * leaves adapter construction to the caller (which knows how to
 * resolve a credential / clone a FallbackAdapter / etc).
 */

/** A configured provider option — one per available providerId. */
export interface ProviderOption {
  providerId: string;
  modelId:    string;
  /** Surfaced in diagnostics so the user can see what each subagent
   *  ran against. */
  label?: string;
}

export interface RotationResult {
  /** Per-subagent provider assignment, length === n. */
  assignments: ProviderOption[];
  /** True when fewer than 2 distinct providerIds were available —
   *  diversity reduces to temperature variation. */
  singleProviderWarning: boolean;
}

/**
 * Pick a provider for each of `n` subagents. `available` is the list
 * of configured options the caller has resolved; ordering matters
 * (the first becomes the primary fallback when round-robin wraps).
 *
 * The function is deterministic given the same inputs — useful for
 * tests and for users debugging "why did subagent 3 hit Together?".
 */
export function rotateProviders(
  n: number,
  available: ProviderOption[],
): RotationResult {
  if (available.length === 0) {
    throw new Error('subagent_fanout: no providers available for rotation');
  }
  if (n < 1) {
    throw new Error(`subagent_fanout: n must be >= 1, got ${n}`);
  }

  const distinct = new Set(available.map((o) => o.providerId));
  const singleProviderWarning = distinct.size < 2;

  const assignments: ProviderOption[] = [];
  for (let i = 0; i < n; i += 1) {
    assignments.push(available[i % available.length]!);
  }
  return { assignments, singleProviderWarning };
}
