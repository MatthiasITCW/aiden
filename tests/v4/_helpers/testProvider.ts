/**
 * tests/v4/_helpers/testProvider.ts — Aiden v4.0.0 (Phase 16b.1)
 *
 * Provider-acquisition helper for integration tests. Replaces the
 * pattern of hardcoding `GROQ_API_KEY` as a skip-guard with a
 * fallback chain so tests stay green under quota pressure.
 *
 * Fallback order (default):
 *   1. GROQ_API_KEY      — primary, free tier, fast
 *   2. GROQ_API_KEY_2    — secondary Groq account
 *   3. GROQ_API_KEY_3    — tertiary Groq account
 *   4. GROQ_API_KEY_4    — quaternary Groq account (Phase 16b.3)
 *   5. TOGETHER_API_KEY  — paid (~$10 sprint budget; use sparingly)
 *
 * Phase 16b.1: the chain primitives (`isRateLimitError`, slot builders)
 * now live in `core/v4/providerFallback.ts` so the runtime path shares
 * the same logic. This file is a thin test-flavoured wrapper.
 *
 * Tests should call `getTestProvider()`, skip gracefully if it returns
 * null, and wrap the test body in `withRateLimitFallback()` if they
 * want auto-retry on 429s mid-call.
 *
 * NOTE: provider-specific adapter tests (chatCompletionsAdapter.groq,
 * chatCompletionsAdapter.together, runtimeResolver.real) intentionally
 * do NOT use this helper — they pin a specific provider on purpose.
 */

import { ChatCompletionsAdapter } from '../../../providers/v4/chatCompletionsAdapter';
import type { ProviderAdapter } from '../../../providers/v4/types';
import {
  isRateLimitError as sharedIsRateLimitError,
  buildDefaultSlots,
  type ProviderSlot,
} from '../../../core/v4/providerFallback';

export type TestProviderSource =
  | 'groq'
  | 'groq2'
  | 'groq3'
  | 'groq4'
  | 'together';

export interface TestProvider {
  /** Canonical provider id understood by the resolver / adapter. */
  providerId: string;
  /** Model id valid for `providerId`. */
  modelId: string;
  /** Pre-built adapter ready to call. */
  adapter: ProviderAdapter;
  /** Which env var supplied this provider — useful for log/debug. */
  source: TestProviderSource;
}

export interface TestProviderOptions {
  /** Skip Groq tiers and prefer Together (cost-aware tests). */
  preferTogether?: boolean;
  /** Optional model override. Applied to whichever tier is chosen. */
  modelHint?: string;
}

const adapterFactory = (cfg: {
  baseUrl: string;
  apiKey: string;
  model: string;
  providerName: string;
}): ProviderAdapter =>
  new ChatCompletionsAdapter({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    providerName: cfg.providerName,
  });

function buildSlots(opts: TestProviderOptions = {}): ProviderSlot[] {
  return buildDefaultSlots({
    adapterFactory,
    groqModel: opts.modelHint,
    togetherModel: opts.modelHint,
  });
}

function slotToTestProvider(slot: ProviderSlot): TestProvider | null {
  const adapter = slot.build();
  if (!adapter) return null;
  return {
    providerId: slot.providerId,
    modelId: slot.modelId,
    adapter,
    source: slot.id as TestProviderSource,
  };
}

/**
 * Acquire a test provider from the configured fallback chain. Returns
 * `null` only when no key is set for any tier. Synchronous-resolvable
 * but typed `Promise<...>` to match the prompt spec — future
 * implementations may probe each provider's `/models` endpoint.
 */
export async function getTestProvider(
  opts: TestProviderOptions = {},
): Promise<TestProvider | null> {
  const slots = buildSlots(opts);
  if (opts.preferTogether) {
    // Reverse default order: try together first, then groq tiers.
    const reordered = [
      slots.find((s) => s.id === 'together')!,
      ...slots.filter((s) => s.id !== 'together'),
    ];
    for (const s of reordered) {
      const tp = slotToTestProvider(s);
      if (tp) return tp;
    }
    return null;
  }
  for (const s of slots) {
    const tp = slotToTestProvider(s);
    if (tp) return tp;
  }
  return null;
}

/**
 * Run `fn` against `initialProvider`. If it throws a rate-limit-shaped
 * error, retry with the next available provider in the chain. Returns
 * `null` only if every provider in the chain is rate-limited.
 *
 * Non-rate-limit errors propagate immediately — those are real bugs and
 * shouldn't be hidden by silent retry.
 */
export async function withRateLimitFallback<T>(
  fn: (provider: TestProvider) => Promise<T>,
  initialProvider: TestProvider | null,
): Promise<T | null> {
  if (!initialProvider) return null;

  const slots = buildSlots();
  const seen = new Set<TestProviderSource>([initialProvider.source]);
  const chain: TestProvider[] = [initialProvider];

  for (const s of slots) {
    if (seen.has(s.id as TestProviderSource)) continue;
    const tp = slotToTestProvider(s);
    if (tp) {
      chain.push(tp);
      seen.add(tp.source);
    }
  }

  let lastErr: Error | null = null;
  for (const p of chain) {
    try {
      return await fn(p);
    } catch (err) {
      if (isRateLimitError(err)) {
        lastErr = err as Error;
        // eslint-disable-next-line no-console
        console.warn(
          `[test-fallback] ${p.source} rate-limited, trying next provider`,
        );
        continue;
      }
      throw err;
    }
  }

  if (lastErr) {
    // eslint-disable-next-line no-console
    console.warn(
      `[test-fallback] All providers exhausted: ${lastErr.message}`,
    );
  }
  return null;
}

/** Re-export the shared rate-limit detector. */
export const isRateLimitError = sharedIsRateLimitError;
