# Hermes audit — OAuth provider routing (Phase 21 #5)

**Method:** graphify keyword scan + targeted reads on `agent/credential_pool.py`, `agent/credential_sources.py`, `agent/anthropic_adapter.py`, `hermes_cli/auth_commands.py`.

## Hermes canonical pattern

### One provider, many sources
Hermes has **one provider name per service** (`anthropic`, `openai-codex`, `nous`) and **multiple sources** that can seed credentials for it.

| Service | Canonical provider | Possible sources |
|---|---|---|
| Anthropic OAuth (Claude.ai) | `anthropic` | `claude_code` (~/.claude/.credentials.json), `hermes_pkce` (~/.hermes/.anthropic_oauth.json), `manual`, `env:ANTHROPIC_API_KEY` |
| OpenAI Codex (ChatGPT Plus) | `openai-codex` | `device_code` (auth.json::providers.openai-codex), `manual`, `env:OPENAI_API_KEY` |

`credential_sources.py:1-44` documents this contract: each source has its own `_seed_from_*` reader plus a unified `RemovalStep`. Providers do NOT have aliases — `anthropic` is `anthropic` everywhere.

### Single source of truth at inference time
- `credential_pool.py::CredentialPool.load_pool()` aggregates **every** source into one in-memory pool keyed by `(provider, model_class)`.
- The inference code path (e.g. `anthropic_adapter.py::AnthropicAdapter.__init__`) calls `pool.get_for_provider("anthropic")` — it never inspects WHERE the credential came from.
- Result: a `/model anthropic claude-opus-4-5` switch and a CLI inference call read **the same pool entry**. There is no second routing path.

### No provider aliases
Searches confirm: no `claude_subscription` or `chatgpt_subscription` parallel keys. The closest parallel — `--provider claude_code` for the legacy Claude Code device-code flow — is a SOURCE name, not a provider name; it lives under `provider=anthropic, source=claude_code`.

### How Hermes prevents the bug class
- One registry. One key per service. Picker enumerates that registry. Resolver reads from the same registry. **No parallel listing.**
- Source diversity is hidden behind the pool API. The picker never asks "which source" — only "which provider".

`agent/credential_pool.py:423` hard-asserts `self.provider != "anthropic"` to skip non-anthropic entries — every consumer trusts the canonical provider name.

## Resolver chain appendix (Phase 21 #5 reopen)

After the registry unification (commit 9b3ecab) the user retest still
hit `No credentials found for apiMode='codex_responses' at auth.json`.
Re-audit revealed the actual call-chain bug — orthogonal to the
registry shape:

- `runtimeResolver.resolveCredentials()` line 227 has the canonical
  Phase 18 OAuth fast-path: `if (entry.oauth && options.paths) { ...
  loadTokens(paths, entry.oauth.providerId) }`.
- The fast-path is gated on **`options.paths`** being passed.
- `chatSession.setProvider()` (line 157) called
  `this.opts.resolver.resolve({ providerId, modelId })` — **no paths**.
- Without paths the gate fails, the fast-path is skipped, and the chain
  falls through to the legacy `credentialResolver.getCredentialsForMode`
  which reads from `auth.json` and throws the user-reported error.

### Hermes equivalent

`hermes_cli/main.py::HermesCLI._handle_model_command` calls
`get_pool_for_provider(provider_id)` which reads from a single
`load_pool()` — no separate "paths" parameter. Hermes routes purely by
provider id; the pool knows where credentials live for each source. By
contrast, Aiden's runtimeResolver still threads paths through every
call site, so any forgetful caller defeats the OAuth fast-path
silently.

### Fix

`chatSession.setProvider()` now forwards `this.opts.paths` to
`resolver.resolve()`. Auxiliary client wrapper (`aidenCLI:591`) does
the same. Both call sites are covered. Cross-call integration tests
were added to catch future regressions — the original parity tests
verified registry shape only and would not have caught this.

## Codex model IDs appendix (Phase 21 #6)

After bug #5 routing was unblocked, the user got an OpenAI 400 on
inference: *"The 'gpt-5' model is not supported when using Codex with
a ChatGPT account."* The Codex OAuth endpoint
(`chatgpt.com/backend-api/codex/responses`) has its own model slug
taxonomy distinct from the direct `api.openai.com` names. Hermes
canonical list (`agent/model_metadata.py:_CODEX_OAUTH_CONTEXT_FALLBACK`,
verified Apr 2026 via live `/codex/models` probe):

| Slug | Context | Notes |
|---|---|---|
| `gpt-5.1-codex-max` | 272K | Flagship, recommended default |
| `gpt-5.1-codex-mini` | 272K | Small / fast |
| `gpt-5.3-codex` | 272K | |
| `gpt-5.2-codex` | 272K | |
| `gpt-5.5` | 272K | Direct API serves 1.05M; Codex caps at 272K |
| `gpt-5.4` | 272K | |
| `gpt-5.4-mini` | 272K | |
| `gpt-5.2` | 272K | |
| `gpt-5` | 272K | Base; some accounts entitle only `*-codex` variants |

Hermes does a live `/codex/models?client_version=1.0.0` probe at
runtime (`_fetch_codex_oauth_context_lengths`, 1h cache) and falls
back to the table above. Aiden v4.0 hardcodes the table; live probe
ports to v4.1.

The names `gpt-5-mini` and `gpt-5-codex` (as we previously listed)
are NOT valid Codex slugs — they're OpenAI direct-API names that
look similar but the Codex backend rejects them.
Adopt Hermes pattern. Aiden has **two parallel registry entries per OAuth service** today (`claude_subscription` + `claude-pro`, `chatgpt_subscription` + `chatgpt-plus`). The legacy snake_case stubs lack `oauth.providerId`; selecting them through the picker routes credentials through the deprecated `auth.json` `credentialResolver` path which has no fresh tokenStore awareness.

The fix is **deletion**, not aliasing. A single canonical entry per service; remove the stubs entirely. This matches Hermes one-name-per-service and eliminates the divergence at its root.
