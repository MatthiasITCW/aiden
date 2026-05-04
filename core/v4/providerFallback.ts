/**
 * core/v4/providerFallback.ts — Aiden v4.0.0 (Phase 16b.1)
 *
 * Shared provider fallback chain. Used by both:
 *   - the runtime path (AidenAgent provider call site, via aidenCLI boot)
 *   - the test helper (tests/v4/_helpers/testProvider.ts)
 *
 * Pattern: ordered list of provider "slots". When a slot's call throws a
 * rate-limit-shaped error, advance to the next slot. Non-rate-limit errors
 * propagate immediately — those are real bugs, not transient quota.
 *
 * Why a separate module: 16b's smoke gate revealed Groq was rate-limiting
 * the FIRST "hi" of every session. Test infra had a multi-tier fallback
 * (Groq → Groq2 → Groq3 → Groq4 → Together) that made tests robust; the
 * runtime path surfaced the raw "Provider groq rate limited" to the user.
 * This module lets the runtime borrow the same chain.
 *
 * Design note: this module is provider-agnostic. Slots carry an opaque
 * `id` for diagnostics (`/providers` reads it) plus a synchronous adapter
 * builder. The chain runner accepts a `requestFn(adapter)` and a list of
 * slots; both consumers wire the same primitives differently.
 */

import type {
  ProviderAdapter,
  ProviderCallInput,
  ProviderCallOutput,
} from '../../providers/v4/types';

/**
 * One slot in the fallback chain. `id` is a short stable key for
 * diagnostics ('groq', 'groq2', 'groq3', 'together'). `build()` returns
 * a ready-to-call adapter when the slot is reachable, or null when the
 * slot's credentials aren't configured (the chain skips it).
 *
 * `keyPresent` and `keyTail` feed `/providers` rendering. `keyTail` is
 * the masked tail (last 4 chars) — never the whole key.
 */
export interface ProviderSlot {
  id: string;
  /** Null when no key is configured for this slot. */
  build(): ProviderAdapter | null;
  /** True when an API key (or OAuth) is configured. */
  keyPresent: boolean;
  /** Last 4 chars of the key, or null when keyPresent is false. */
  keyTail: string | null;
  /** Provider id understood by the resolver/registry (e.g. 'groq'). */
  providerId: string;
  /** Model id valid for `providerId`. */
  modelId: string;
}

/**
 * Loose 429 / rate-limit detector. Matches:
 *   - `ProviderRateLimitError` instances (constructor name check)
 *   - error messages containing '429', 'rate limit', 'rate-limit',
 *     'rate_limit', 'too many requests', 'quota'
 *   - explicit `(err as any).rateLimit === true`
 */
export function isRateLimitError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { message?: string; name?: string; rateLimit?: unknown; statusCode?: unknown };
  if (e.rateLimit === true) return true;
  if (e.statusCode === 429) return true;
  if (typeof e.name === 'string' && e.name.toLowerCase().includes('ratelimit')) {
    return true;
  }
  const msg = (e.message ?? '').toLowerCase();
  return (
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('rate-limit') ||
    msg.includes('rate_limit') ||
    msg.includes('too many requests') ||
    msg.includes('quota exceeded')
  );
}

/**
 * Mask an API key for display. Returns `null` for empty/falsy input.
 * Keeps the last 4 chars and replaces the rest with `•` (one mid-dot per
 * masked char, capped at 8 to keep the line short).
 */
export function maskKey(key: string | null | undefined): string | null {
  if (!key || typeof key !== 'string') return null;
  if (key.length <= 4) return '••••';
  const tail = key.slice(-4);
  const masked = '•'.repeat(Math.min(8, key.length - 4));
  return `${masked}${tail}`;
}

export interface ChainRunResult<T> {
  /** Successful slot id, when one returned. */
  slotId: string;
  value: T;
}

/**
 * Run `requestFn` against each slot in order until one succeeds. Skips
 * slots whose `build()` returns null (no key). On rate-limit errors,
 * advances to the next slot. On any other error, rethrows immediately.
 *
 * Throws a `ChainExhaustedError` after the last configured slot fails
 * with a rate-limit error.
 */
export async function runFallbackChain<T>(
  slots: ProviderSlot[],
  requestFn: (adapter: ProviderAdapter, slot: ProviderSlot) => Promise<T>,
  observers: { onRateLimit?: (slotId: string, err: Error) => void } = {},
): Promise<ChainRunResult<T>> {
  let lastErr: Error | null = null;
  let attemptedAny = false;

  for (const slot of slots) {
    const adapter = slot.build();
    if (!adapter) continue;
    attemptedAny = true;
    try {
      const value = await requestFn(adapter, slot);
      return { slotId: slot.id, value };
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (isRateLimitError(e)) {
        observers.onRateLimit?.(slot.id, e);
        lastErr = e;
        continue;
      }
      throw e;
    }
  }

  if (!attemptedAny) {
    throw new ChainExhaustedError(
      'No provider slots configured (no API keys found). Set GROQ_API_KEY or TOGETHER_API_KEY.',
      [],
    );
  }
  throw new ChainExhaustedError(
    `All provider slots rate-limited. Last error: ${lastErr?.message ?? 'unknown'}`,
    slots.map((s) => s.id),
    lastErr ?? undefined,
  );
}

/** Thrown by `runFallbackChain` when every configured slot rate-limits. */
export class ChainExhaustedError extends Error {
  readonly slotsTried: string[];
  readonly cause?: Error;
  constructor(message: string, slotsTried: string[], cause?: Error) {
    super(message);
    this.name = 'ChainExhaustedError';
    this.slotsTried = slotsTried;
    this.cause = cause;
  }
}

// ─── Default slot builders for Groq → Groq2 → Groq3 → Together ──────

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const TOGETHER_BASE_URL = 'https://api.together.xyz/v1';
const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile';
const DEFAULT_TOGETHER_MODEL = 'meta-llama/Llama-3.3-70B-Instruct-Turbo';

export interface DefaultSlotsOptions {
  /** Optional override for Groq model id. */
  groqModel?: string;
  /** Optional override for Together model id. */
  togetherModel?: string;
  /**
   * Adapter factory. Tests inject a stub; the runtime passes a closure that
   * builds a ChatCompletionsAdapter. Keeping this injectable means this
   * file has zero hard dependency on a specific adapter class.
   */
  adapterFactory: (config: {
    baseUrl: string;
    apiKey: string;
    model: string;
    providerName: string;
  }) => ProviderAdapter;
  /** Read env vars from this object (defaults to process.env). */
  env?: Record<string, string | undefined>;
}

/**
 * Build the default 5-tier slot list:
 *   GROQ_API_KEY → GROQ_API_KEY_2 → GROQ_API_KEY_3 → GROQ_API_KEY_4
 *     → TOGETHER_API_KEY
 *
 * Slots without a configured key are still included (so `/providers` can
 * render them as "unset"); their `build()` returns null and the chain
 * runner skips them.
 */
export function buildDefaultSlots(opts: DefaultSlotsOptions): ProviderSlot[] {
  const env = opts.env ?? process.env;
  const groqModel = opts.groqModel ?? env.GROQ_TEST_MODEL ?? DEFAULT_GROQ_MODEL;
  const togetherModel = opts.togetherModel ?? env.TOGETHER_TEST_MODEL ?? DEFAULT_TOGETHER_MODEL;

  const buildGroqSlot = (id: string, envVar: string): ProviderSlot => {
    const key = env[envVar];
    return {
      id,
      providerId: 'groq',
      modelId: groqModel,
      keyPresent: !!key,
      keyTail: key ? key.slice(-4) : null,
      build: () =>
        key
          ? opts.adapterFactory({
              baseUrl: GROQ_BASE_URL,
              apiKey: key,
              model: groqModel,
              providerName: 'groq',
            })
          : null,
    };
  };

  const togetherKey = env.TOGETHER_API_KEY;
  const togetherSlot: ProviderSlot = {
    id: 'together',
    providerId: 'together',
    modelId: togetherModel,
    keyPresent: !!togetherKey,
    keyTail: togetherKey ? togetherKey.slice(-4) : null,
    build: () =>
      togetherKey
        ? opts.adapterFactory({
            baseUrl: TOGETHER_BASE_URL,
            apiKey: togetherKey,
            model: togetherModel,
            providerName: 'together',
          })
        : null,
  };

  return [
    buildGroqSlot('groq', 'GROQ_API_KEY'),
    buildGroqSlot('groq2', 'GROQ_API_KEY_2'),
    buildGroqSlot('groq3', 'GROQ_API_KEY_3'),
    buildGroqSlot('groq4', 'GROQ_API_KEY_4'),
    togetherSlot,
  ];
}

// ─── Runtime adapter wrapper ──────────────────────────────────────────

/**
 * Tracks per-slot rate-limit state so `/providers` can render which slots
 * are currently active vs. cooling off. Cooldown is purely advisory — the
 * chain still tries each slot on every call to recover quickly.
 */
export interface SlotState {
  rateLimited: boolean;
  /** Wall-clock ms when the slot last rate-limited. */
  lastRateLimitAt: number | null;
  /** Total successful calls observed for this slot. */
  successCount: number;
  /** Total rate-limit events observed for this slot. */
  rateLimitCount: number;
}

/**
 * `ProviderAdapter` implementation that fronts a list of slots and falls
 * through on rate-limit errors. The first slot's `apiMode` is used as the
 * declared mode — every slot in the chain MUST share the same `apiMode`
 * for the agent loop's tool-call wiring to stay consistent.
 *
 * Currently used at the runtime path in `cli/v4/aidenCLI.ts::buildAgentRuntime`
 * to harden the AidenAgent against transient Groq quota.
 */
export class FallbackAdapter implements ProviderAdapter {
  readonly apiMode: ProviderAdapter['apiMode'];
  private readonly slots: ProviderSlot[];
  private readonly state: Map<string, SlotState> = new Map();
  private lastSuccessfulSlot: string | null = null;
  private readonly onRateLimit?: (slotId: string, err: Error) => void;
  private readonly onFallback?: (
    fromSlotId: string,
    toSlotId: string,
  ) => void;

  constructor(opts: {
    /** First slot's apiMode. Must match every other slot. */
    apiMode: ProviderAdapter['apiMode'];
    slots: ProviderSlot[];
    onRateLimit?: (slotId: string, err: Error) => void;
    onFallback?: (fromSlotId: string, toSlotId: string) => void;
  }) {
    this.apiMode = opts.apiMode;
    this.slots = opts.slots;
    this.onRateLimit = opts.onRateLimit;
    this.onFallback = opts.onFallback;
    for (const s of opts.slots) {
      this.state.set(s.id, {
        rateLimited: false,
        lastRateLimitAt: null,
        successCount: 0,
        rateLimitCount: 0,
      });
    }
  }

  async call(input: ProviderCallInput): Promise<ProviderCallOutput> {
    let lastSlotTried: string | null = null;
    const result = await runFallbackChain(
      this.slots,
      async (adapter, slot) => {
        if (lastSlotTried && lastSlotTried !== slot.id) {
          this.onFallback?.(lastSlotTried, slot.id);
        }
        lastSlotTried = slot.id;
        return adapter.call(input);
      },
      {
        onRateLimit: (slotId, err) => {
          const s = this.state.get(slotId);
          if (s) {
            s.rateLimited = true;
            s.lastRateLimitAt = Date.now();
            s.rateLimitCount += 1;
          }
          this.onRateLimit?.(slotId, err);
        },
      },
    );
    const s = this.state.get(result.slotId);
    if (s) {
      s.rateLimited = false;
      s.successCount += 1;
    }
    this.lastSuccessfulSlot = result.slotId;
    return result.value;
  }

  /** Diagnostic snapshot for `/providers`. */
  getDiagnostics(): {
    slots: Array<{
      id: string;
      providerId: string;
      modelId: string;
      keyPresent: boolean;
      keyTail: string | null;
      state: SlotState;
      active: boolean;
    }>;
    activeSlotId: string | null;
  } {
    return {
      slots: this.slots.map((s) => ({
        id: s.id,
        providerId: s.providerId,
        modelId: s.modelId,
        keyPresent: s.keyPresent,
        keyTail: s.keyTail,
        state: this.state.get(s.id)!,
        active: s.id === this.lastSuccessfulSlot,
      })),
      activeSlotId: this.lastSuccessfulSlot,
    };
  }
}
