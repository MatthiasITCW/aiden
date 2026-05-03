# Phase 6 — Completed

**Date:** 2026-05-04
**Branch:** `v4-rewrite`
**Commits:**
- `8b0a48b` — feat(v4): cross-platform paths + credentialResolver migration
- `8d20cc6` — feat(v4): SQLite session store + FTS5 search + session manager
- `cea55e3` — feat(v4): memory system (MEMORY.md + USER.md frozen-snapshot)
- `bc6bf0d` — feat(v4): config.yaml parser + RuntimeResolver wiring
- (this file) — docs(v4): phase 6 summary

## Goal

Persistent state for v4. After Phase 6, sessions survive CLI restarts in
`sessions.db` (SQLite + FTS5), `MEMORY.md` / `USER.md` load as a frozen
snapshot, and `config.yaml` unblocks the Phase 5 `ConfigProvider` stub.

## Hermes pattern summary (Task 1)

- **SQLite + FTS5 schema.** Hermes `hermes_state.SessionDB` uses sessions /
  messages tables with FTS5 virtual indexes kept in sync via AFTER
  INSERT/DELETE/UPDATE triggers, WAL journal mode, and `foreign_keys=ON`.
  Aiden v4 mirrors this — minus Hermes's trigram-FTS table and CJK fallback
  (Phase 13 polish if it lands at all). Snippets via
  `snippet(messages_fts, 0, '>>>', '<<<', '...', 16)`, ranking via `bm25`.
- **Frozen-snapshot memory.** `tools/memory_tool.MemoryStore` keeps a
  `_system_prompt_snapshot` captured at `load_from_disk()` separate from
  the live entries that mutate. The snapshot stays in the system prompt
  unchanged for the whole session, preserving the prompt cache; writes
  hit disk immediately for the *next* session. Aiden's `MemoryManager`
  ports this exactly with raw-text snapshots.
- **Substring-match mutations.** `MemoryStore.replace`/`remove` find
  entries containing `old_text` as a substring. Zero matches → error.
  Multiple distinct matches → error with previews. Multiple identical
  duplicates → operate on the first. Capacity (2200 / 1375 chars) is
  validated *before* writing.
- **Config env-var interpolation.** Hermes `_expand_env_vars` recursively
  walks parsed YAML and runs `re.sub(r"\${([^}]+)}", lambda m: env.get(m.group(1), m.group(0)), v)`.
  Unset vars stay literal — callers detect-and-fail rather than silently
  ship empty strings. Aiden ports this verbatim and exposes it through
  `ConfigManager.get`/`getValue` rather than at parse time so fresh env
  changes are picked up without reload.
- **Cross-platform paths.** Hermes is `~/.hermes` on every platform and
  has no native Windows support. Aiden's `resolveAidenPaths` adds
  first-class `%LOCALAPPDATA%\aiden\` (with cygwin/MINGW fallback) and
  `~/Library/Application Support/aiden`, with `AIDEN_HOME` overriding
  everything for tests. `credentialResolver` migrated to consume the
  shared module — single source of truth.

## Public APIs

```ts
// core/v4/paths.ts (132 lines)
export function resolveAidenRoot(opts?: { rootOverride?: string }): string;
export function resolveAidenPaths(opts?: { rootOverride?: string }): AidenPaths;
export async function ensureAidenDirsExist(paths: AidenPaths): Promise<void>;

// core/v4/sessionStore.ts (369 lines)
new SessionStore(dbPath);
  createSession / getSession / updateSession / deleteSession / listSessions
  appendMessage / getMessages
  addTokenUsage(id, inputDelta, outputDelta)
  search(query, limit?) → SessionSearchResult[]
  close();

// core/v4/sessionManager.ts (171 lines)
new SessionManager(store);
  startSession({ title?, providerId, modelId }) → SessionRecord
  resumeLatest() / resumeById(idOrTitle)
  recordTurn(sessionId, messages, usage, turnNumber?)
  search(query, limit?);

// core/v4/memoryManager.ts (240 lines)  + memoryProvider.ts (50 lines)
new MemoryManager(paths);
  loadSnapshot() → MemorySnapshot
  add(file, content) / replace(file, oldText, newText) / remove(file, text)
    → { ok: boolean; reason?: string }
// Limits: MEMORY.md=2200 chars, USER.md=1375 chars, separator '\n§\n'

// core/v4/config.ts (228 lines)
new ConfigManager(paths);
  load() / save(config?) / reload() → boolean
  get(key) / getValue<T>(key, default?) / set(key, value)
  snapshot() → AidenConfig
// implements ConfigProvider — drops into RuntimeResolver.options.config
```

## Test coverage

| File | New cases | Pass |
|---|---:|:---:|
| `tests/v4/paths.test.ts` | 9 | ✅ |
| `tests/v4/sessionStore.test.ts` | 13 | ✅ |
| `tests/v4/sessionManager.test.ts` | 11 | ✅ |
| `tests/v4/memoryManager.test.ts` | 16 | ✅ |
| `tests/v4/config.test.ts` | 11 | ✅ |
| **Phase 6 unit total** | **60** | **60/60** |

**Cumulative v4 tests:** Phase 5 reported 123 passed / 2 skipped.
Phase 6 brings the v4 suite to **184 passed, 2 skipped** (full
`tests/v4/` run, integration tests in their declared
skip-when-no-key state).

## Verification

| Step | Result |
|---|---|
| `npx tsc --noEmit` | ✅ 0 errors |
| `npx vitest run tests/v4/` | ✅ 184 passed, 2 skipped |
| `npm test` (full regression) | ✅ **1599 passed**, 2 skipped, 1 todo. Same 16 pre-existing native-modules/zod file failures (vendored puppeteer/zod with missing dev deps) carried from Phase 4-5. |
| Zero v3 regressions | ✅ |

One flaky live-Groq date assertion in `chatCompletionsAdapter.groq.test.ts`
appeared on first run, passed on re-run. Non-deterministic LLM output —
not a Phase 6 regression.

## Dependencies added

- `better-sqlite3@^12` — sync SQLite bindings, FTS5 verified compiled in
  on the bundled SQLite 3.53.0 build.
- `@types/better-sqlite3` (dev).
- `js-yaml@^4` promoted from transitive (already pulled by electron-updater
  / puppeteer) to a direct dependency. Types already direct.

## Graphify

| Metric | Pre-Phase 6 | Post-Phase 6 | Δ |
|---|---:|---:|---:|
| Nodes | 1956 | **2017** | +61 |
| Edges | 3556 | 3646 | +90 |
| Communities | 141 | 140 | -1 |

Hook fired on each commit; rebuild ran inline.

## Skipped / deferred (by design)

- **Memory provider plugins** (Honcho, Mem0, Hindsight, etc.) — v4.1.
  Interface in `memoryProvider.ts` is the contract.
- **Filesystem-watch hot reload** for `config.yaml` — Phase 13 polish.
  `ConfigManager.reload()` is the manual surface meanwhile.
- **`aiden config` slash commands** (view / edit / set / check / migrate)
  — Phase 13.
- **Session export / import / archival** — v4.1+.
- **`/insights` token usage analytics** — Phase 13.
- **Trigram FTS5 + CJK fallback search** — defer until a non-Latin user
  reports gaps; current `unicode61` tokenizer covers Phase 6.
- **MemoryGuard wrap** (Aiden's honesty-enforcement layer around memory
  tools) — Phase 9 alongside the agent honesty system.

## What Phase 7 needs to know

**Phase 7 mission:** Tool registry rewire + 86 tools wrapped with JSON
schemas.

**Surfaces ready to plug into:**
- `SessionManager.recordTurn` is the persistence sink for the agent
  loop — call it once per AidenAgent turn with the new messages and
  token usage.
- `MemoryManager` is a `MemoryProvider`. The agent loop calls
  `loadSnapshot()` once at startup and injects the raw text into the
  system prompt; mutations (memory tool calls) go through `add` /
  `replace` / `remove` and never touch the prompt mid-session.
- `ConfigManager` implements `ConfigProvider` — wire it into
  `RuntimeResolver` via `options.config` once the agent boot path is
  in place. No resolver code change needed.
- `resolveAidenPaths()` is the single source of truth for every on-disk
  path the runtime touches. Tools that need data dirs (skill teacher,
  plugin loader) should consume it instead of reaching for env vars.

## Acceptance check (Phase 6)

- [x] Task 1 5-bullet Hermes summary reported BEFORE coding
- [x] All 6 subsystems implemented per spec
- [x] `credentialResolver` migrated to use AidenPaths (no inline path logic)
- [x] FTS5 triggers in place — search verified across multiple sessions
- [x] Memory capacity limits enforced (2200 / 1375)
- [x] config.yaml `${VAR}` interpolation works; unset vars left literal
- [x] All 60 new tests pass
- [x] `npx tsc --noEmit` zero errors
- [x] Full regression: 1599 passed, no v3 regression
- [x] Four feature commits on `v4-rewrite`, all pushed to `backup`
- [x] `docs/sprint/phase-6-completed.md` under 200 lines
