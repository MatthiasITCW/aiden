/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * providers/v4/nullAdapter.ts — Aiden v4.0.2 (Phase 30.2.1)
 *
 * A `ProviderAdapter` that throws a typed `NotConfiguredError` on every
 * call. Used when the setup wizard returns `status: 'skipped'` so the
 * REPL can boot in "explore mode" — slash commands, skill listing,
 * /providers etc. all work, but any chat attempt is intercepted by
 * `ChatSession.runAgentTurn` BEFORE reaching the agent loop and
 * surfaces a friendly "no provider configured" message.
 *
 * Why a stub instead of nullable types: every wiring downstream of
 * the resolver assumes a non-null `provider` field on AidenAgent /
 * ChatSession. Threading optionality through 6 layers of code would
 * be a much larger blast radius for v4.0.2's UX-only patch. The stub
 * is one file, one error type, fully typed.
 */

import type {
  ProviderAdapter,
  ProviderCallInput,
  ProviderCallOutput,
  ApiMode,
  StreamEvent,
} from './types';

/**
 * Sentinel error class. ChatSession checks `instanceof NotConfiguredError`
 * to decide whether to print the friendly message or fall through to
 * the generic adapter-error path.
 */
export class NotConfiguredError extends Error {
  readonly notConfigured = true as const;
  constructor(msg = 'No AI provider configured yet.') {
    super(msg);
    this.name = 'NotConfiguredError';
  }
}

/**
 * Drop-in stub adapter. Reports `chat_completions` so the rest of the
 * agent loop's provider-mode dispatch finds the same shape it expects;
 * the actual `call()` / `callStream()` paths never run because
 * `ChatSession` short-circuits on the explore-mode flag.
 */
export class NullAdapter implements ProviderAdapter {
  readonly apiMode: ApiMode = 'chat_completions';

  async call(_input: ProviderCallInput): Promise<ProviderCallOutput> {
    throw new NotConfiguredError(
      'No AI provider configured yet. Run /setup to configure a provider, ' +
        'or set an API key environment variable (e.g. GROQ_API_KEY).',
    );
  }

  async *callStream(_input: ProviderCallInput): AsyncGenerator<StreamEvent, void, void> {
    throw new NotConfiguredError(
      'No AI provider configured yet. Run /setup to configure a provider, ' +
        'or set an API key environment variable (e.g. GROQ_API_KEY).',
    );
  }
}
