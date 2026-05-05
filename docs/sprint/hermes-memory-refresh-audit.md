# Hermes audit — memory refresh mid-session (Phase 16d prep)

**Date:** 2026-05-04
**Question:** Does Hermes refresh MEMORY.md / USER.md mid-session, or does it accept a stale snapshot to keep the prefix cache hot? If stale, what's their UX mitigation?

## Sources

- `C:\Users\shiva\references\hermes-agent\website\docs\user-guide\features\memory.md:47` — definitive design statement
- `C:\Users\shiva\references\hermes-agent\agent\memory_manager.py:266` — `MemoryManager.build_system_prompt()` (called only at session-prompt-assembly time)
- `C:\Users\shiva\references\hermes-agent\agent\memory_manager.py:485` — `on_memory_write` hook (notifies external providers, NOT the prompt builder)
- `C:\Users\shiva\references\hermes-agent\agent\memory_provider.py:84` — `system_prompt_block()` is "STATIC provider info"; recall context goes through `prefetch()` (separate per-turn channel)

## Findings

1. **Hermes intentionally freezes the snapshot.** `memory.md:47` is explicit: "The system prompt injection is captured once at session start and never changes mid-session. This is intentional — it preserves the LLM's prefix cache for performance. When the agent adds/removes memory entries during a session, the changes are persisted to disk immediately but won't appear in the system prompt until the next session starts."

2. **No invalidation hook exists for the built-in memory.** `on_memory_write` (memory_manager.py:485) only fans out to *external* providers so they can refresh their own caches. The built-in file-backed memory does NOT rebuild the system prompt block when `memory_add`/`memory_replace`/`memory_remove` fires.

3. **UX mitigation: tool responses always show live state.** From `memory.md:47`: "Tool responses always show the live state." When the agent calls `memory_add`, the tool response includes the post-write file contents — so within the same turn the agent has live data via the tool result message, even though slot-3 of the system prompt is stale.

4. **Recall context is a separate per-turn channel.** `memory_provider.py:84-89` separates `system_prompt_block()` (static, frozen) from `prefetch(query)` (per-turn dynamic recall). External providers like Honcho use `prefetch` to inject fresh context into a tail block. The built-in provider doesn't override `prefetch` — it relies on the frozen snapshot only.

5. **Documented user expectation:** changes are "visible next session." There's no in-session indicator beyond the tool response itself.

## Decision: **diverge** (use strategy (b) — invalidate on write)

DevOS v4 has a tighter UX surface than Hermes: this is a single-user CLI where the user *will* say "remember X" and immediately ask "what do you remember?" in the same session. Hermes ships across multi-platform deployments where session boundaries are clearer; we don't have that excuse.

We diverge with a small, targeted change:

- Keep the frozen-snapshot convention as the **default** for prefix-cache stability
- Add an `invalidateSnapshot()` event on the `MemoryManager` that flips a dirty bit
- `AidenAgent.runConversation()` checks the dirty bit before each turn; if set, it rebuilds slots 3+4 from a fresh `loadSnapshot()` and resets the bit
- The cache only breaks on the turn *after* a memory write — every other turn still hits the prefix cache cleanly

Trade-off: one cache-miss per memory mutation. Acceptable: memory writes happen at most a handful of times per session, and the alternative (frozen) means user-visible bugs we already know about ("what do you remember about me?" returning "nothing" right after `memory_add` succeeded).

We also adopt Hermes's UX mitigation: render an inline `✓ Saved to memory.` confirmation gated on `verified=true` from the memory tool's post-write check (Phase 9 wrappers already surface this flag).

## What we're NOT copying

- The external-provider plugin lifecycle (Hermes' Honcho/Mem0 adapters). v4.0.0 ships built-in only; plugins land in v4.1.
- Hermes's `prefetch`/`queue_prefetch` per-turn recall channel. With strategy (b) the frozen snapshot stays adequate.
