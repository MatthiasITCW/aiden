# Phase 16c — Streaming responses (completed 2026-05-05)

End-to-end token streaming wired into adapters → agent loop → fallback
chain → CLI display → `/streaming` slash command. Default OFF for v4.0
(opt-in via `/streaming on`).

## Hermes audit summary

`docs/sprint/hermes-streaming-audit.md`. Hermes uses one unified
`_interruptible_streaming_api_call` that branches per `api_mode` and
ties streaming to the agent loop via three callbacks. Tool-call
interleaving is buffer-and-suppress: once any tool call appears in a
turn, subsequent text deltas stop streaming. v4 adapts that into an
explicit `StreamEvent` discriminated union returned from
`callStream()` — same semantics, more idiomatic TS.

## Adapter shapes

| Adapter | Wire | First-token cue | Tool-arg accumulation |
|---------|------|-----------------|------------------------|
| chat_completions | SSE `data:` lines, `[DONE]` sentinel | `delta.content` string | tool_calls[].function.arguments concatenated, JSON.parse at end |
| anthropic_messages | SSE dispatched on JSON `type` field | `content_block_delta` text_delta | `input_json_delta.partial_json` per block index |
| ollama_prompt_tools | NDJSON (no SSE framing) | `message.content` per chunk | extracted post-stream from `<tool_call>...</tool_call>` tags |

Shared `parseSseStream` (in `chatCompletionsAdapter.ts`) is reused by
the Anthropic adapter. Ollama hand-rolls a newline-delimited JSON
reader. Codex streaming and Anthropic extended-thinking deferred to
v4.1.

## AidenAgent loop changes

`runConversation(messages, opts?)` gained an optional
`RunConversationOptions` (`stream`/`onDelta`/`onFirstDelta`/`onToolCallStart`).
When `stream:true` and the adapter implements `callStream`, the loop
calls `runStreamingTurn` per turn, iterates the async generator, and
relays events through callbacks. The assembled `ProviderCallOutput`
from the `done` event feeds the existing loop body — tool dispatch,
trace, HonestyEnforcement, SkillTeacher, fallback strategy are
unchanged.

Tool-call interleaving (Hermes pattern): adapters suppress text deltas
the moment a `tool_call` event surfaces in the same turn. Display
switches modes (spinner/tool indicator) without text leaking onto the
line. After tools run, the next streaming turn starts fresh.

## Fallback chain mid-stream 429

`FallbackAdapter.callStream` mirrors `call()`'s slot iteration. On a
rate-limit error thrown BEFORE any event yields, the slot is marked +
60 s cooldown set + chain advances. If a 429 fires AFTER tokens
yielded (rare; providers typically close SSE silently), the error
propagates — partial-token loss is the chosen tradeoff per audit
decision; Hermes's "silent retry with reconnecting banner" is deferred
to v4.1. Slots without `callStream` fall through to `.call()` and
yield a synthetic `done` event.

## /streaming command + default state

`/streaming` shows current state, `/streaming on|off|show` toggles +
persists to `display.streaming`. Default: **OFF** for v4.0 launch.
Chat REPL reads the flag at the top of every turn, so the toggle takes
effect on the next message — no restart.

## Smoke gate result

`scripts/smoke-phase16c.ts` against live Groq, all 9 steps PASS:

- Baseline OFF: zero delta callbacks, response present
- Streaming ON poem: first delta at **356 ms**, **115 deltas**, content
  bytes match sum of deltas (488ch=488ch)
- Tool path: turn completed (635ch), 116 deltas streamed, no deadlock
- Fallback diagnostics: 6 slots, active=groq2, all state intact

First 3 deltas of poem: `["NSE", " swing", " trading"]` — token
boundaries match BPE, no SSE flush-the-whole-response pathology.

## Test counts

- New unit tests: **15** (`tests/v4/streaming.test.ts`)
- Assertion bumps: 2 (config streaming default, barrel command count)
- Cumulative v4 passing: **1062** (3 live-LLM integration flakes from
  Groq rate-limit pressure during same vitest run; pass in isolation)
- `tsc --noEmit -p .` clean

## Deferred to v4.1

- Codex `responses` streaming
- Anthropic extended-thinking (`thinking_delta`) surfacing
- Hermes-style silent retry on mid-tool-call SSE drop with
  "Reconnecting…" banner
- `<think>` tag suppression in streamed display (current adapters
  don't emit those tags)

## Files touched

- `providers/v4/types.ts` (StreamEvent), `chatCompletionsAdapter.ts`
  (parseSseStream + callStream + tool_use_failed recovery),
  `anthropicAdapter.ts`, `ollamaPromptToolsAdapter.ts`
- `core/v4/aidenAgent.ts` (RunConversationOptions, runStreamingTurn),
  `providerFallback.ts` (FallbackAdapter.callStream),
  `config.ts` (default flipped)
- `cli/v4/display.ts` (streamPartial/streamComplete/streamToolIndicator),
  `chatSession.ts` (wiring), `commands/streaming.ts` (new) + index.ts
- `tests/v4/streaming.test.ts` (new), `config.test.ts`,
  `cli/commands.test.ts` (assertions)
- `scripts/smoke-phase16c.ts` (new)
- `docs/sprint/hermes-streaming-audit.md` (new), this file

## Note: buffer-on-tool-call (added in 16c.2)

When the LLM emits a tool call mid-stream, the agent suppresses further
delta events until the tool completes. This matches Hermes
(`run_agent.py:6852` / `7053`) and is **by design** — tool prep prose
that the model will discard once it sees the tool result is noise.
**Pure-text responses stream token-by-token**; only tool-using turns
buffer. If a smoke run feels "non-streaming," check whether the prompt
triggered a tool. `scripts/smoke-streaming-visibility.ts` exercises the
non-tool path explicitly.
