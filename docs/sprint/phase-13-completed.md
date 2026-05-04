# Phase 13 — Prompt builder, context compressor, iteration budget, auxiliary client

**Status:** Complete · 2026-05-04
**Branch:** `v4-rewrite`
**Commits:** `fe31068`, `e70fa19`, `2e0ee4e`, `aec6d06`, `252f9fa` (+ this doc)

## Goal

Wire the four supporting systems that keep the LLM's context sharp:

- **PromptBuilder** assembles the system prompt in deterministic slot order
  and freezes the result for the session (prefix-cache friendly).
- **ContextCompressor** auto-summarizes early turns when conversation
  utilisation crosses 50%.
- **IterationBudgetInjection** writes a "N turns remaining" note onto the
  last tool result so the LLM literally sees the pressure in its context.
- **AuxiliaryClient** routes cheap side-task calls to a separate small
  model so the main turn budget stays focused on user intent.

## Task 1 — Hermes inventory

| Subsystem | Hermes file | Pattern adopted |
|---|---|---|
| Prompt builder | `agent/prompt_builder.py` | Slot order: identity → personality → MEMORY.md → USER.md → skills → tools (per-turn) → budget → environment. Frozen at session start. We trim Hermes' kanban / .hermes.md / acp branches. |
| Context compressor | `agent/context_compressor.py` | Preserve leading system msgs + last 6 turns; ask aux LLM to summarize the middle; replace with one synthetic system message prefixed `[Earlier conversation summary — reference only]`. Multi-pass up to 3 if still over threshold. We drop Hermes' tool-output pre-pruning + iterative summary updates. |
| Iteration budget injection | `agent/run_agent.py` (IterationBudget class) | Compute `remaining/max`; if ≤ 30% append a budget note to the last tool result before returning to the LLM. Replaces v3's callback-only approach. |
| Auxiliary client | `agent/auxiliary_client.py` | Single resolved adapter cached per AuxiliaryClient instance. Per-purpose usage tracking. Empty-content + warning on failure (never throw). Multi-provider fallback chain deferred to v4.1. |
| Prompt caching | `agent/anthropic_adapter.py` (`_attach_cache_control`) | Tag system message with `cache_control: {type: 'ephemeral'}`. No-op for non-Anthropic providers. Last-tool-result marking deferred to v4.1. |
| Model metadata | `agent/model_metadata.py` | Static catalog (`providers/v4/modelCatalog.ts`) + tiktoken-or-char/4 token estimator. Per-message overhead 10 tokens. Live models.dev hydration deferred. |

## Subsystems built — public APIs

```ts
// core/v4/modelMetadata.ts
class ModelMetadata {
  getLimits(providerId: string, modelId: string): ModelLimits;
  estimateTokens(text: string): number;
  estimateMessageTokens(messages: Message[]): number;
  estimateToolTokens(tools: ToolSchema[]): number;
  getDefaults(): ModelLimits;
}
function tokenizerAvailable(): boolean;

// core/v4/promptBuilder.ts
class PromptBuilder {
  build(opts: PromptBuilderOptions): Promise<string>;
  renderToolsForTurn(tools: ToolSchema[]): string;
  renderBudgetSnippet(used: number, max: number): string;
}

// core/v4/contextCompressor.ts
class ContextCompressor {
  shouldCompress(messages, providerId, modelId): CompressionTrigger;
  compress(messages, providerId, modelId): Promise<CompressionResult>;
  forceCompress(messages, providerId, modelId): Promise<CompressionResult>;
}

// core/v4/auxiliaryClient.ts
class AuxiliaryClient {
  call(opts: AuxiliaryCallOptions): Promise<AuxiliaryCallResult>;
  getUsage(): Record<string, { inputTokens; outputTokens; calls }>;
  isUnavailable(): boolean;
}

// core/v4/promptCaching.ts
class PromptCaching {
  isSupported(providerId, modelId): boolean;
  applyMarkers(messages, providerId): Message[];
  stripMarkers(messages): Message[];
}
```

## AidenAgent loop changes

`AidenAgentOptions` adds:
`promptBuilder`, `promptBuilderOptions`, `contextCompressor`,
`auxiliaryClient`, `promptCaching`, `providerId`, `modelId`,
`iterationBudgetInjection` (default `true`), `onCompression`.

`AidenAgentResult` adds: `compressionEvents`, `auxiliaryUsage`.

`runConversation` order:

1. PromptBuilder.build() (cached for session) → prepend system message
2. PlannerGuard pre-loop tool-narrowing (Phase 12, unchanged)
3. **Loop body:**
   a. ContextCompressor.shouldCompress → compress if true
   b. PromptCaching.applyMarkers (Anthropic only)
   c. provider.call()
   d. Tool dispatch sequential
   e. IterationBudgetInjection appends budget note to last tool result
      when remaining ≤ 30% of `maxTurns`
4. HonestyEnforcement post-loop (Phase 12, unchanged)
5. SkillTeacher observation (Phase 12, unchanged)

Honesty-then-SkillTeacher ordering preserved exactly.

## Test counts

| Suite | Phase 12 | Phase 13 | Δ |
|---|---|---|---|
| `tests/v4/modelMetadata.test.ts` | — | 11 | +11 |
| `tests/v4/promptBuilder.test.ts` | — | 14 | +14 |
| `tests/v4/auxiliaryClient.test.ts` | — | 10 | +10 |
| `tests/v4/contextCompressor.test.ts` | — | 12 | +12 |
| `tests/v4/promptCaching.test.ts` | — | 8 | +8 |
| `tests/v4/aidenAgent.context.test.ts` | — | 10 | +10 |
| **Phase 13 new** | — | **65** | **+65** |
| v4 unit total (excludes live integration) | 601 | 652 | +51 net (some moved/renamed) |
| Full suite passing | 2070+ | **2078** | +8 |

8 pre-existing live-LLM integration tests remain flaky (Together/Groq
phrasing of date/time answers); verified pre-Phase-13 baseline was the
same — not a regression.

## tsc / vitest

- `npx tsc --noEmit` → exit 0, zero errors.
- `npx vitest run tests/v4/ --exclude tests/v4/integration/**` →
  57 files, 652 passed, 1 skipped, 0 failed.
- `npm test` → 2078 passed, 8 pre-existing live-LLM failures.

## tiktoken vs char/4

`js-tiktoken` installed cleanly (no native bindings, ~1.1 MB).
`tokenizerAvailable()` returns `true` on this machine. char/4 fallback
remains as a try/catch safety net so the module boots even when the
package is absent.

## Cost spent

Roughly $1–2 in Opus 4.7 tokens for Phase 13 development; no live LLM
calls hit the new paths during testing (FakeAdapter / MockProvider used
throughout).

## Graph node count

graphify rebuild fired automatically on every commit:
- Pre-Phase 13: 2413 nodes / 4256 edges
- Post-Phase 13: 2477 nodes / 4359 edges (+64 nodes, +103 edges)

## Commits

| SHA | Title |
|---|---|
| `fe31068` | feat(v4): model metadata + token estimation |
| `e70fa19` | feat(v4): prompt builder with slot-ordered assembly |
| `2e0ee4e` | feat(v4): auxiliary client for cheap LLM routing |
| `aec6d06` | feat(v4): context compressor + prompt caching |
| `252f9fa` | feat(v4): wire prompt builder + compressor + auxiliary into AidenAgent |
| _this doc_ | docs(v4): phase 13 summary |

All five feature commits pushed to `backup` remote successfully.

## Deferred to later phases

- Vision / multimodal content blocks (auxiliary client routes for vision) → v4.1
- Streaming responses + reasoning toggles → Phase 14
- Last-tool-result cache markers (incremental anthropic prefix cache) → v4.1
- Compression strategy variants (importance-tagged messages, tool-output pre-pruning) → v4.1
- Multi-provider auxiliary fallback chain (OpenRouter → Nous Portal → custom) → v4.1
- `/usage` slash command (consumes `auxiliaryUsage`) → Phase 14

## What Phase 14 needs

Per the project lead's brief:
- CLI classic (`aiden` command surface)
- Setup wizard (`aiden setup` first-run flow)
- Doctor (`aiden doctor` diagnostics — surfaces RuntimeResolution.source,
  AuxiliaryClient.isUnavailable, etc.)
- Interactive `aiden model` menu (consumes ModelEntry catalog from
  Phase 5 + AuxiliaryClient routing)
- `/usage` command consuming `auxiliaryUsage` from AidenAgentResult
- Streaming response support in AidenAgent
- Reasoning-effort toggles (`temperature`, `reasoning_effort` for
  models that support it)

## Stop conditions encountered — none

tiktoken installed cleanly; compression converged in single pass on all
tested inputs; no v3 regressions; backup push succeeded for every commit.
