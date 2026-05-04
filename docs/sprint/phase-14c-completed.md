# Phase 14c — completed (2026-05-04)

Chat REPL, main `aiden` CLI entry, sessions/skills/mcp subcommands, skill
slash command activation. v4 now opens a real interactive chat session
with the boxed startup card and live status line specified in
`AGENTS.md` "v4 CLI UX — design targets for Phase 14c".

## Hermes inventory (Task 1)

| Hermes pattern | Adopted as |
|---|---|
| `cli.py::HermesCLI.run()` (L9829) — main REPL loop, dispatches slash via `process_command()` | `ChatSession.run()` async/await variant, slash routes through `CommandRegistry.execute()` |
| `cli.py::ChatConsole` startup banner | `Display.banner()` (Phase 14a) + new boxed metadata card |
| `hermes_cli/main.py::cmd_chat()` (L1195) | `aidenCLI::runInteractiveChat()` |
| `_coalesce_session_name_args` (main.py L7641) — multi-word `-c`/`-r` joining | Skipped — commander's `<title>` arg already handles a single quoted token. Multi-word users quote. |
| `SlashCommandCompleter` + `SlashCommandAutoSuggest` (commands.py L1087/L1615) — prompt_toolkit completer | `@inquirer/prompts.search` with `source` callback against `CommandRegistry.filter()` |
| `_session_browse_picker` (main.py L361) | Out of scope — `aiden -r <title>` resolves via `SessionManager.resumeById` |
| `KawaiiSpinner` (display.py L573) | Already shipped as the custom spinner in Phase 14a |
| `cleanup()` / shutdown teardown | `process.on('SIGINT')` cleanup hook + `mcpClient.closeAll()` + `store.close()` |

## ChatSession architecture

- **State**: `history: Message[]`, `sessionId`, `currentProviderId/ModelId`,
  `totalUsage`, `startedAt`, `queuedSystemPrompts`.
- **Boot**: resolves session id (resume or fresh), renders the boxed
  card via `Display.dim()`, installs (optional) SIGINT handler.
- **Loop**: reads input via injectable `ChatPromptApi`. Slash commands
  route to `CommandRegistry`. Free-form input becomes one
  `Message{role:'user'}`, hands off to `agent.runConversation()`,
  records the tail to `SessionManager.recordTurn()`, re-renders status line.
- **Multi-line**: leading `"""` opens a buffered read; closing `"""`
  ends it. Single-chunk paste (already contains `\n`) is accepted verbatim.
- **Slash autocomplete**: `@inquirer/prompts.search` source callback
  re-queries `CommandRegistry.filter()` on each keystroke. Falls back to
  the raw input when search throws (TTY missing / Ctrl+C).
- **Skill activation**: `queueSystemPrompt(text)` queues a system message
  that's spliced into the next turn's history just before the user message
  — keeps the executor untouched and lets the LLM see the skill body
  alongside the user prompt.
- **Provider hot-swap**: `AidenAgent.setProvider()` (new one-liner)
  swaps the adapter mid-session for `/model`.

## aidenCLI subcommand coverage

| Command | Status | Notes |
|---|---|---|
| `aiden` (default) | full | `runInteractiveChat()` wires every Phase 1–13 subsystem |
| `aiden setup` | full | re-runs Phase 14a wizard with `force: true` |
| `aiden model [spec]` | full | calls Phase 14b picker; saves on success |
| `aiden config [view\|set\|check]` | full | view, set+save, check-presence |
| `aiden doctor` | full | reuses Phase 14a `runDoctorCli()` |
| `aiden sessions list\|search` | full | uses Phase 6 `SessionManager` |
| `aiden skills list\|view` | full | uses Phase 10 `SkillLoader` |
| `aiden skills install\|search\|reset\|…` | stub | "deferred to v4.1 alongside the gateway" |
| `aiden mcp <action>` | stub | gateway-bound — v4.1 |
| `aiden batch\|gateway\|cron\|pairing\|tui\|update` | stub | placeholder messages |

## Boxed card / status line / autocomplete delivery

- **Boxed card**: rendered with `╭ ╮ ╯ ╰ ─ │`, padded to inner width 67.
  Shows live tool count grouped by toolset (top 8 + overflow), live skill
  count grouped by category (top 6 + overflow), provider/model, session
  id (first 16 chars), and a footer summary. **Delivered in full.**
- **Status line**: format
  `$ provider:model  ctx u/m [▓░░░░░░░░░] %  budget t/90  age` updates
  after every turn (slash or agent). Uses `ModelMetadata.getLimits()`
  + `estimateMessageTokens()`. **Delivered in full.**
- **Autocomplete dropdown**: `@inquirer/prompts.search` with a `source`
  callback that calls `CommandRegistry.filter(input)`. Skill commands
  render with `⚡` prefix; system commands render with their own icon
  (or none). **Delivered in full**, with a graceful fallback to
  free-form input when `search` is unavailable (no TTY, Ctrl+C cancel).

## Phase 12 deferral

`PlannerGuard`, `HonestyEnforcement`, `SkillTeacher`, `MemoryGuard`,
`SSRFProtection`, `TirithScanner` are NOT wired into the REPL boot in
14c. Their bootstrap data (skill quality file path, auxiliary-LLM
endpoint, memory provider singleton) needs Phase 16 polish to settle.
The agent runs correctly without them — this matches the stop-condition
in the 14c brief.

## Tests

| Suite | New |
|---|---|
| `chatSession.test.ts` | 16 |
| `aidenCLI.test.ts` | 14 |
| `skillSlashCommand.test.ts` | 5 |
| **Phase 14c total** | **35** |

`npx tsc --noEmit` clean. Vitest run (3 new files): all green.

## Smoke tests

| Command | Result |
|---|---|
| `npx tsc --noEmit` | exit 0, no errors |
| `npx vitest run tests/v4/cli/{chatSession,aidenCLI,skillSlashCommand}.test.ts` | exit 0 |

CLI subprocess smoke (`npx tsx cli/v4/aidenCLI.ts --help`, doctor,
sessions list, skills list) recorded in the consolidated 14 doc.

## Commits + backup push

1. `feat(v4): chat session REPL with boxed startup + status line + autocomplete`
2. `feat(v4): aiden CLI main entry + sessions/skills/mcp subcommands`
3. `feat(v4): skill slash command activation`
4. `docs(v4): phase 14c + consolidated phase 14 summaries`

All pushed to `backup` (origin frozen at v3.19.9 per
`memory/project_v4_remotes.md`).

## Deferred (out of 14c)

- TUI mode → Phase 15
- Personality auto-load → Phase 16
- Custom skin yaml hot-reload → Phase 16
- Phase 12 moat layer wiring → Phase 16
- Streaming responses → Phase 15 polish
- Real OAuth flow for Pro options → Phase 18
- Auto-update mechanism → Phase 20
- Multimodal input in REPL → v4.1
