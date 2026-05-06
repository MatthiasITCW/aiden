# Diagnostic — OAuth provider routing root cause (Phase 21 #5)

## Symptom (verbatim)
> /auth login chatgpt-plus → success
> /model → ChatGPT Plus → error: "OAuth credentials missing... apiMode='codex_responses' at C:\Users\shiva\AppData\Local\aiden\auth.json"

The error references `auth.json` (legacy unified credential file) — but the user authenticated through `tokenStore` (Phase 18 per-provider files at `<aiden-home>/auth/<provider>.json`). Two routing paths exist; the picker chose the wrong one.

## Divergence map

`PROVIDER_REGISTRY` has **two** entries per OAuth service:

| Surface | Legacy stub (Phase 5) | Phase 18 OAuth |
|---|---|---|
| Registry key | `claude_subscription` | `claude-pro` |
| Registry key | `chatgpt_subscription` | `chatgpt-plus` |
| Has `oauth.providerId` | ❌ | ✅ |
| Token source at runtime | `credentialResolver` → `auth.json` (legacy) | `tokenStore` → `<aiden-home>/auth/<id>.json` (Phase 18) |
| Discoverable in picker | ✅ (via `Object.values(PROVIDER_REGISTRY)`) | ✅ (same) |
| Selected by `/model` | ✅ — same display name | ✅ — same display name |

The model picker (`cli/v4/commands/modelPicker.ts:105-118`) enumerates the registry verbatim and shows BOTH entries. Display names look near-identical (`Claude Pro/Max subscription` vs `Claude Pro / Max (OAuth)`). When the user picks the legacy stub, `runtimeResolver.resolveCredentials()` (line 227) hits the `entry.oauth` check, finds `undefined` (legacy stubs don't carry it), skips the tokenStore branch, and falls through to the credentialResolver/auth.json path (line 273-298). That path has no Phase 18 tokens → throws the user-reported error with the misleading `auth.json` reference.

## The "9 files" the Phase 18 status doc mentioned

Refs to legacy IDs across the v4 codebase (24 hits, 8 files):

| File | Refs | Role |
|---|---|---|
| `providers/v4/registry.ts` | 6 | Registry definitions + comments |
| `providers/v4/modelCatalog.ts` | 6 | Model→provider mapping (5 Claude rows + 1 ChatGPT row use legacy IDs) |
| `providers/v4/runtimeResolver.ts` | 1 | Comment only |
| `core/v4/promptCaching.ts` | 1 | `isSupported(providerId, ...)` checks `claude_subscription` for cache flag |
| `tests/v4/cli/modelPicker.test.ts` | 3 | Picker enumerates legacy entries |
| `tests/v4/modelCatalog.test.ts` | 2 | Asserts `providers.has('claude_subscription')` |
| `tests/v4/promptCaching.test.ts` | 1 | Asserts cache support for `claude_subscription` |
| `tests/v4/runtimeResolver.test.ts` | 1 | Resolver test uses legacy ID as a fixture |

## Affected surfaces (predicted impact)

This same root cause WILL hit:

1. **`/model` switch to claude-pro** — same picker, same dual-listing. User picks `claude_subscription` (legacy), gets the same `auth.json` error.
2. **`/providers` display** — likely shows two rows per service, neither clearly "the right one."
3. **Setup wizard** — the wizard already uses kebab-case IDs (`setupWizard.ts:58`), so it routes correctly. But a user who manually edits `config.yaml` after wizard completion can land on either ID.
4. **Future OAuth providers (v4.1)** — the duplicate-entry pattern is a footgun. Anyone adding a new OAuth provider must remember to NOT also add a legacy snake_case stub.

## Root cause (one line)

**The registry has two entries per OAuth service, only one of which is wired through Phase 18 `tokenStore`. The picker shows both. The legacy entry routes through the deprecated `auth.json` path.**

## Recommended fix (Hermes pattern)

Delete the legacy stubs entirely. One canonical registry entry per OAuth service:

- `claude_subscription` → DELETE; canonical key is `claude-pro`.
- `chatgpt_subscription` → DELETE; canonical key is `chatgpt-plus`.

Cascade through the 8 files: rewire `modelCatalog` rows to canonical IDs, update `promptCaching.isSupported` to check `claude-pro`, refresh tests. Comments referencing legacy IDs can stay as historical notes; only live references must move.

This matches Hermes's one-provider-name-per-service contract and eliminates the second routing path. The runtimeResolver code is **already correct** (the `entry.oauth` fast path at line 227 is the canonical Phase 18 lookup); we just have to make sure every registry entry that NEEDS that path actually has `oauth.providerId` set.

## Why deletion (not aliasing)

Aliasing keeps the duplicate display in the picker. Hermes has no aliases — one canonical name. We have no users on stable v4 (still beta), so `claude_subscription` references in user `config.yaml` files don't exist in the wild. Pure deletion is the cleanest path.

## Cost

8 files touched, ~30 lines net change. Tests cascade (3 test files updated). Single commit covers the unification.
