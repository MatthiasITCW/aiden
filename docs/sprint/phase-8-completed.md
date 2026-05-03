# Phase 8 — Completed

**Date:** 2026-05-04
**Branch:** `v4-rewrite`
**Commits (5 feature + this summary):**
- `a11456e` — feat(v4): process registry implementation
- `95e1d7b` — feat(v4): file write/patch/delete/move/copy tools
- `912fb19` — feat(v4): shell_exec + local + Docker terminal backends
- `68e097a` — feat(v4): browser write tools + execute_code + process tools + registerAllTools
- `65ac48f` — test(v4): integration tests for AidenAgent with write tools
- (this file) — docs(v4): phase 8 summary

## Goal

Add the destructive/mutating capabilities. After this phase
`AidenAgent` can write/patch/delete/move/copy files, run shell
commands (local + Docker backends), navigate/click/type/fill/scroll/close
the browser, run Python code in a sandbox, and manage background
processes (spawn/list/log_read/kill/wait). Phase 9 will layer the
approval engine on top of every `mutates: true` handler.

## Task 1 — v3 + Hermes inventory

| v4 tool             | v3 source                              | Strategy |
|---------------------|----------------------------------------|----------|
| `file_write`        | `core/toolRegistry.ts:942`             | wrapped (stripped v3 permission gate) |
| `file_patch`        | not in v3                              | built (string find/replace, refuses ambiguous matches) |
| `file_delete`       | not in v3                              | built (`fs.rm`, refuses fs root) |
| `file_move`         | not in v3                              | built (`fs.rename`, EXDEV fallback) |
| `file_copy`         | not in v3                              | built (`fs.cp`) |
| `shell_exec`        | `core/toolRegistry.ts:737`             | adapted (stripped v3 permissionSystem; Phase 9 readds via approval engine) |
| `browser_navigate`  | `core/playwrightBridge.ts:98` `pwNavigate` | wrapped |
| `browser_click`     | `core/playwrightBridge.ts:126` `pwClick` + `pwClickFirstResult` | wrapped |
| `browser_type`      | `core/playwrightBridge.ts:196` `pwType` | wrapped |
| `browser_fill`      | not in v3                              | built (fans out to `pwType`) |
| `browser_scroll`    | `core/playwrightBridge.ts:206` `pwScroll` | wrapped |
| `browser_close`     | `core/playwrightBridge.ts:273` `pwClose` | wrapped |
| `execute_code`      | `core/codeInterpreter.ts:26` `runInSandbox` | simplified wrap (Python only, no packages, no tool RPC) |
| `process_*` (5)     | not in v3                              | built fresh against new `core/v4/processRegistry.ts` |
| Process registry    | not in v3 (Phase 1 stub)               | built fresh; Hermes pattern was too elaborate to port |
| Docker backend      | partial (`core/sandboxRunner.ts`)      | built minimal (`docker run --rm -v cwd:/workspace`) |

Hermes's full code-exec / Docker backends are 1.6k / 645 lines each —
v4 ships ~150-line minimums; Phase 9+ harden as the approval engine
sets policy.

## Wrapper count by category

| Category | Tools | Names |
|---|---:|---|
| Files (write) | 5 | file_write, file_patch, file_delete, file_move, file_copy |
| Terminal | 1 | shell_exec |
| Browser (write) | 6 | browser_navigate, browser_click, browser_type, browser_fill, browser_scroll, browser_close |
| Code exec | 1 | execute_code |
| Process | 5 | process_spawn, process_list, process_log_read, process_kill, process_wait |
| **Phase 8 total** | **18** | |
| Phase 7 read-only | 16 | (unchanged) |
| **Cumulative v4** | **34** | |

18 new wrappers vs. the 25–30 estimate — v3 didn't have the patch /
delete / move / copy / fill set, so the count is leaner than the
guess; everything in scope is shipped.

## Process registry public API

```ts
// core/v4/processRegistry.ts (~190 lines)
export interface ProcessHandle {
  id: string; command: string; pid: number; startedAt: number;
  status: 'running' | 'exited' | 'killed';
  exitCode?: number; exitedAt?: number;
}
export interface SpawnOpts { cwd?: string; env?: Record<string,string>; shell?: boolean }
export class ProcessRegistry {
  spawn(command: string, opts?: SpawnOpts): ProcessHandle;
  list(): ProcessHandle[];
  get(id: string): ProcessHandle | null;
  readLog(id: string, lines?: number): string[];   // default 100, ring buffer caps at 1000
  kill(id: string, signal?: NodeJS.Signals): boolean;
  waitFor(id: string, timeoutMs?: number): Promise<ProcessHandle>;
  cleanup(): void;                                  // call on shutdown
}
```

`ToolContext` grew `processes?: ProcessRegistry`, `terminalBackend?:
'local' | 'docker'`, `dockerImage?: string`. Phase 9 will add
`approvalEngine?: ApprovalEngine` to gate `mutates: true` calls.

## Docker backend status

**Skipped at runtime.** `isDockerAvailable()` returned false on the
build machine — the Docker daemon is not running. Test 9
(`dockerBackend > executes if Docker available`) skipped cleanly per
Stop-condition in the prompt. Test 10 confirmed the docker-unavailable
error path returns a clear `stderr: /docker/i` rather than crashing.
shell_exec routing test (Test 12) confirmed the dispatch reaches the
Docker backend; no failure on routing.

## execute_code status

**Python found** (`python` on PATH; cached after first probe). All
six tests pass — print(1+1) returns "2", error capture, timeout, and
empty-code no-op all confirmed. Per-call `_resetPythonCache()` is
exposed for tests.

## Test counts

| Suite | Phase 7 | Phase 8 | Δ |
|---|---:|---:|---:|
| `tests/v4/processRegistry.test.ts` | n/a | 10 | +10 |
| `tests/v4/tools/files.test.ts` | 10 | 26 | +16 |
| `tests/v4/tools/terminal.test.ts` | n/a | 12 (1 docker-skip) | +12 |
| `tests/v4/tools/browser.test.ts` | 7 | 14 | +7 |
| `tests/v4/tools/execute_code.test.ts` | n/a | 6 | +6 |
| `tests/v4/tools/process.test.ts` | n/a | 5 | +5 |
| `tests/v4/integration/aidenAgent.writeTools.test.ts` | n/a | 2 (live Groq) | +2 |
| **Phase 8 new** | | | **+58** |

Cumulative v4: **291 passed, 3 skipped** (vs. 234 in Phase 7 — 1
docker-skip + 2 prior skips).

## Verification

| Step | Result |
|---|---|
| `npx tsc --noEmit` | ✅ 0 errors |
| `npx vitest run tests/v4/` | ✅ 291 passed, 3 skipped |
| Live Groq integration (file_write) | ✅ writes "hello v4" to disk; verified via fs.readFile |
| Live Groq integration (shell_exec) | ✅ marker text returned; passed first try (no Phase 7-style llama wire-format quirk on `shell_exec`) |
| `npm test` (full regression) | ✅ **1706 passed**, 3 skipped, 1 todo. Same 16 pre-existing native-modules / zod failures from Phase 7 — no new regressions. |
| Zero v3 regressions | ✅ |

## Cost spent

Two live Groq integration calls (file_write + shell_exec). Both
single-shot first try; Phase 7's llama-3.3 `web_search` wire-format
quirk did not surface for `shell_exec` or `file_write`. Estimated
**< $0.01 USD** total.

## Graphify

| Metric | Pre-Phase 8 | Post-Phase 8 | Δ |
|---|---:|---:|---:|
| Nodes | 2065 | **2114** | +49 |
| Edges | 3707 | 3779 | +72 |
| Files indexed | 385 | 408 | +23 |

Hook fired on each commit; rebuild ran inline.

## What Phase 9 needs

- **Approval engine + dangerous command detection.** Every `mutates:
  true` handler in Phase 8 should be gated. ToolContext already has
  the `approvalEngine?` slot reserved.
- **Tirith / shell-injection scanner** sitting in front of
  `shell_exec` before the local/docker backends route.
- **SSRF protection** on web tools (`web_fetch`, `web_page`,
  `browser_navigate`).
- **Memory write tools** (`memory_store`, `memory_forget`) gated
  behind MemoryGuard.
- **Tool-name disambiguation / system-prompt builder** to address
  the llama-3.3 `web_search` regression noted in Phase 7.
- **Skill manage tool** to replace the Phase 7 stub.
- **Per-session isolation** for `shell_exec` and `process_*` so a
  session-scoped registry replaces the global one.

## Acceptance check (Phase 8)

- [x] Task 1 v3 + Hermes inventory reported BEFORE wrapping
- [x] processRegistry.ts implements all required methods
- [x] 18 write/execute tools wrapped or built
- [x] Docker backend wired (integration skipped — Docker not running on host)
- [x] execute_code works for simple Python (Python on PATH)
- [x] Both integration tests pass (file_write + shell_exec live Groq)
- [x] All 58 new tests pass
- [x] `npx tsc --noEmit` zero errors
- [x] Full regression: v3 baseline preserved
- [x] Five feature commits on `v4-rewrite`, all pushed to `backup`
- [x] phase-8-completed.md under 200 lines
