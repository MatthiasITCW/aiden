# Phase 16c.2 — `.env` not loaded at boot + slot/source visibility

## Root cause
The runtime never loaded `paths.envFile`. `setupWizard.ts::upsertEnvVar`
writes to `%LOCALAPPDATA%\aiden\.env` but no boot path read it back, so
the runtime saw only Windows User env. The "slot label swap" was just
different keys in Windows env vs. the aiden file the user thought was
authoritative.

## Fixes
- `cli/v4/envSources.ts` (new) — `loadAidenEnvFile()` parses the file,
  fills `process.env` (preset entries win — Hermes pattern), tags each
  key `'preset' | 'aiden-env'` for diagnostics.
- `aidenCLI.ts::buildAgentRuntime` — call the loader right after
  `ensureAidenDirsExist`, before any provider resolution.
- `providerFallback.ts::ProviderSlot` — `envVar?: string` field threaded
  through `buildDefaultSlots`, `togetherSlot`, and `getDiagnostics`.
- `commands/providers.ts` — appends `← GROQ_API_KEY_N (aiden .env | shell/system env | unset)`
  per slot.

## Streaming visibility (separate task)
`scripts/smoke-streaming-visibility.ts` (new) sends a non-tool prompt
with streaming on. Live: **140 deltas, first delta @ 153ms, median gap
0ms** — streaming is genuinely incremental. Closing note in the 16c phase
doc documents **buffer-on-tool-call** as by-design (Hermes pattern).

## Tests
+6 in `tests/v4/cli/aidenEnvLoader.test.ts`: slot→envVar mapping (×2),
load-when-unset, preserve-preset, strip-quotes, unset returns "unset".
v4 unit suite **1051 pass / 1 skip** (was 1047). `tsc --noEmit` clean.

## Deferred
User has 3 layers of env config (Windows User > shell > aiden file)
with conflicting values. We don't reconcile — `/providers` now makes the
source visible (`GROQ_API_KEY_4=aiden-env`, `GROQ_API_KEY=preset`, …) so
they can fix manually.
