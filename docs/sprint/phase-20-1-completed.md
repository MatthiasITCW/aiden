# Phase 20.1 — /doctor slash command + auto-update verification (completed)

**Branch:** `v4-rewrite` · **Range:** `c0414c9..HEAD` (1 fix commit + this doc)
**Status:** closed.

## Why
Phase 20 manual smoke surfaced two anomalies:
1. `/doctor` returned "Unknown command" in the REPL.
2. The npm update notification didn't fire after a manual version bump test.

## Findings
- **/doctor was never a slash command.** Phase 20 Task 7 added check functions to `cli/v4/doctor.ts` and a `commander` shell subcommand, but no `cli/v4/commands/doctor.ts` was registered. Adding it now (`category: 'system'`) flows through `/help` automatically.
- **Auto-update IS wired** in `aidenCLI.ts:528` — `setImmediate(async ...)` dynamically imports `checkForUpdate` + `formatUpdateLine`. Smoke didn't fire because `aiden-runtime@4.0.0-beta.1` is unpublished — the registry probe returns nothing newer than installed (correct silent behaviour).

## What shipped
- `cli/v4/commands/doctor.ts` — `/doctor` slash command, walks `runDoctor()`, renders rows via `display.*`.
- Registered in `commands/index.ts` (23 → 24 commands).
- `/help` lists it automatically via `category: 'system'`.
- Boot-wiring guard test prevents silent removal of the auto-update path in future refactors.

## Tests
+3 unit (spec asked ≥3): registration · output sections · boot-wiring guard. v4 cli suite: 296/296.

## Author
Shiva Deore. Pushed to `backup/v4-rewrite`.

## Next
Phase 21 — manual QA matrix on Win / macOS / Linux.
