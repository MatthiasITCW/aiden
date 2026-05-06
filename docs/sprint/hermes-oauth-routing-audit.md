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

## Decision for Aiden
Adopt Hermes pattern. Aiden has **two parallel registry entries per OAuth service** today (`claude_subscription` + `claude-pro`, `chatgpt_subscription` + `chatgpt-plus`). The legacy snake_case stubs lack `oauth.providerId`; selecting them through the picker routes credentials through the deprecated `auth.json` `credentialResolver` path which has no fresh tokenStore awareness.

The fix is **deletion**, not aliasing. A single canonical entry per service; remove the stubs entirely. This matches Hermes one-name-per-service and eliminates the divergence at its root.
