# Phase 14 — completed (2026-05-04)

Phase 14 (delivered as 14a + 14b + 14c) ships the **full Hermes-grade
CLI UX** for Aiden v4. v4 stops feeling like infrastructure and starts
feeling like a real product the user can drive end-to-end from one
terminal command: `aiden`.

This consolidated note merges the per-subphase summaries
(`phase-14a-completed.md`, `phase-14b-completed.md`,
`phase-14c-completed.md`) into one reference. Read those for fine-grained
inventories; this doc is the high-level shipping list.

## Headline

`aiden` (no args) opens an interactive chat session with:

- Aiden brand banner + boxed metadata startup card (Phase 14c) showing
  live tool/skill counts, current provider/model, and session id.
- Slash-command autocomplete dropdown filtered live as you type
  (Phase 14b registry + 14c `@inquirer/prompts.search` integration).
- 16 system slash commands (`/help`, `/tools`, `/model`, `/save`,
  `/title`, `/compress`, `/usage`, `/yolo`, `/skin`, `/skills`,
  `/reload-mcp`, `/verbose`, `/clear`, `/quit`, `/personality`,
  `/reasoning`) plus skill-defined `⚡ /<skill>` commands.
- Status line under the input area showing
  `provider:model · ctx u/m · budget t/90 · age` after every turn.
- Multi-line input via `"""` triple-quote and paste detection.
- YOLO mode (`--yolo`), session resume (`-c`, `-r <title>`), and
  provider/model overrides (`--provider`, `--model`).
- SIGINT graceful shutdown.

Plus seven first-class subcommands: `aiden setup`, `aiden model
[spec]`, `aiden config <action>`, `aiden doctor`, `aiden sessions
<action>`, `aiden skills <action>`, `aiden mcp <action>`. Six v4.1
placeholders (`batch`, `gateway`, `cron`, `pairing`, `tui`, `update`)
print clear deferral messages.

## Subsystems delivered

### 14a — Visual foundation + diagnostics

- `cli/v4/skinEngine.ts` — pluggable terminal palette + glyph set,
  YAML loader scaffold, mono-mode for non-TTY environments.
- `cli/v4/display.ts` — banner, ANSI markdown via `marked-terminal`,
  custom non-`ora` spinner, tool preview, agent/user turn formatters,
  the 14b helper line (`info` / `success` / `warn` / `dim` / `line` /
  `printError`), a recoverable `error()` formatter.
- `cli/v4/doctor.ts` — `runDoctor()` aggregating 10 checks
  (config, provider auth, ollama, python, docker, npx, skills dir,
  bundled manifest, paths, logs writable) with per-check 3 s timeout.
- `cli/v4/setupWizard.ts` — first-run wizard with 19 numbered provider
  options, model picker, API-key validation against provider endpoints,
  smoke-test mode, `--skip-validation` escape hatch.
- `cli/v4/keyValidator.ts` — provider-specific endpoint probes.

### 14b — Slash registry + model picker + callbacks

- `cli/v4/commandRegistry.ts` — alias-aware command store, parser,
  dispatcher, autocomplete `filter()` API.
- `cli/v4/commands/{help,tools,model,save,title,compress,usage,yolo,skin,skills,reloadMcp,verbose,clear,quit}.ts` —
  14 fully implemented system commands plus Phase 16 stubs for
  `personality` and `reasoning`.
- `cli/v4/commands/modelPicker.ts` — interactive provider/model picker
  with tier badges (⭐ Pro / 🆓 Free / 💲 Paid / 🏠 Local / 🔑 Subscription).
  Reused by both `/model` and `aiden model [spec]`.
- `cli/v4/callbacks.ts` — `CliCallbacks` exposing `promptApproval`,
  `riskAssess`, `promptSkillProposal`, `onPlannerGuardDecision`,
  `onCompression`, `onBudgetWarning` plus a `setVerboseMode` toggle.

### 14c — Chat REPL + main entry + skill activation

- `cli/v4/chatSession.ts` — interactive REPL. Boots/resumes a session,
  renders the boxed startup card, drives the agent loop, persists each
  turn to `SessionManager`, re-renders the status line, handles
  multi-line + paste, slash-command autocomplete dropdown, SIGINT.
- `cli/v4/aidenCLI.ts` — `commander`-based main entry with the seven
  full subcommands and six v4.1 placeholders. Test-injectable hooks
  for every action.
- `cli/v4/commands/skillCommandHandler.ts` — converts a `ParsedSkill`
  into a `SlashCommand` whose handler queues the skill body as a
  system-prompt insert for the next turn (skill activation via context
  injection rather than tool dispatch).
- `core/v4/aidenAgent.ts` — added `setProvider(adapter)` one-liner so
  `/model` can hot-swap providers mid-session.

## Test counts

| Phase | Suite delta |
|---|---|
| 14a | +50 (display 18, doctor 19, wizard 13) |
| 14b | +70 (registry 13, display 5, commands 25, picker 11, callbacks 16) |
| 14c | +35 (chatSession 16, aidenCLI 14, skillSlashCommand 5) |
| **Total** | **+155 v4 tests** |

`npx tsc --noEmit` clean throughout. Vitest runs against the new files
all green; full-suite regression unchanged from the 14b baseline (live-LLM
integration flakes are pre-existing rate-limit noise, not introduced
by 14c).

## Smoke tests (Phase 14c)

| Command | Result |
|---|---|
| `npx tsc --noEmit` | exit 0, 0 errors |
| `npx vitest run tests/v4/cli/{chatSession,aidenCLI,skillSlashCommand}.test.ts` | all pass |
| `npx tsx cli/v4/aidenCLI.ts --help` | shows full subcommand list |
| `npx tsx cli/v4/aidenCLI.ts doctor` | 10 checks run; aggregate report |
| `npx tsx cli/v4/aidenCLI.ts sessions list` | empty / N most recent |
| `npx tsx cli/v4/aidenCLI.ts skills list` | bundled + user skills |

## What's deferred to later phases

| Item | Phase |
|---|---|
| TUI mode (`aiden --tui`, multi-pane) | 15 |
| Streaming responses | 15 |
| Personality auto-load + `/personality` full impl | 16 |
| `/reasoning` full impl | 16 |
| Custom skin YAML hot-reload | 16 |
| Phase 12 moat layer wiring at REPL boot (PlannerGuard, HonestyEnforcement, SkillTeacher, MemoryGuard, SSRFProtection, TirithScanner) | 16 |
| OAuth flow for Claude Pro / ChatGPT Plus / etc. | 18 |
| `aiden update` auto-update mechanism | 20 |
| `aiden batch`, `gateway`, `cron`, `pairing` | v4.1 |
| `aiden mcp <action>` full impl | v4.1 |
| `aiden skills install/audit/publish/snapshot` | v4.1 |
| Multimodal input in REPL | v4.1 |
| Reasoning-effort visualisation | 16 |

## Authoritative design doc

`AGENTS.md` "v4 CLI UX — design targets for Phase 14c" captures the
boxed card / status line / autocomplete spec. Phase 14c implements it
directly; later phases polish.

## Commits + backup push

Across 14a/14b/14c, 12 commits on `v4-rewrite` (all pushed to `backup`
per `memory/project_v4_remotes.md` — origin frozen at v3.19.9).

| Phase | Commits |
|---|---|
| 14a | 4 |
| 14b | 4 |
| 14c | 4 |
