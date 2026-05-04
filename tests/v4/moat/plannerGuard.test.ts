import { describe, it, expect, vi } from 'vitest';
import {
  PlannerGuard,
  type PlannerGuardRegistry,
} from '../../../moat/plannerGuard';
import type { ToolHandler } from '../../../core/v4/toolRegistry';
import type {
  ProviderAdapter,
  ProviderCallOutput,
  ToolSchema,
} from '../../../providers/v4/types';

// ── Test fixtures ──────────────────────────────────────────────────

const schema = (name: string, description = ''): ToolSchema => ({
  name,
  description,
  inputSchema: { type: 'object', properties: {} },
});

const handler = (name: string, toolset?: string): ToolHandler => ({
  schema: schema(name),
  category: 'read',
  mutates: false,
  toolset,
  execute: async () => ({}),
});

class MockRegistry implements PlannerGuardRegistry {
  constructor(private readonly handlers: ToolHandler[]) {}
  list(): string[] {
    return this.handlers.map((h) => h.schema.name);
  }
  get(name: string): ToolHandler | undefined {
    return this.handlers.find((h) => h.schema.name === name);
  }
  getSchemas(filterToolsets?: string[]): ToolSchema[] {
    return this.handlers
      .filter(
        (h) =>
          !filterToolsets ||
          filterToolsets.length === 0 ||
          (h.toolset && filterToolsets.includes(h.toolset)),
      )
      .map((h) => h.schema);
  }
}

const FULL_REGISTRY = new MockRegistry([
  handler('file_read', 'files'),
  handler('file_write', 'files'),
  handler('web_search', 'web'),
  handler('web_fetch', 'web'),
  handler('browser_click', 'browser'),
  handler('browser_screenshot', 'browser'),
  handler('shell_exec', 'terminal'),
  handler('execute_code', 'execute'),
  handler('memory_add', 'memory'),
  handler('memory_remove', 'memory'),
  handler('skills_list', 'skills'),
  handler('skill_view', 'skills'),
  handler('lookup_tool_schema', 'meta'),
  handler('session_search', 'sessions'),
  handler('process_spawn', 'process'),
]);

class FakeAdapter implements ProviderAdapter {
  apiMode = 'chat_completions' as const;
  constructor(
    private readonly handler: () =>
      | Promise<ProviderCallOutput>
      | ProviderCallOutput,
  ) {}
  async call(): Promise<ProviderCallOutput> {
    return await this.handler();
  }
}

// ── Tests ──────────────────────────────────────────────────────────

describe('PlannerGuard — off mode', () => {
  it('1. off mode returns all tools as selected, none excluded', async () => {
    const guard = new PlannerGuard(FULL_REGISTRY, 'off');
    const decision = await guard.decide('anything', []);
    expect(decision.selectedTools).toHaveLength(15);
    expect(decision.excludedTools).toEqual([]);
    expect(decision.reason).toBe('no_filter');
  });
});

describe('PlannerGuard — rule_based', () => {
  it('2. file keywords select files toolset (+ core)', async () => {
    const guard = new PlannerGuard(FULL_REGISTRY, 'rule_based');
    const decision = await guard.decide('please read this file', []);
    expect(decision.selectedTools).toContain('file_read');
    expect(decision.selectedTools).toContain('file_write');
    // Core always-on tools present (those that exist):
    expect(decision.selectedTools).toContain('skills_list');
    expect(decision.selectedTools).toContain('lookup_tool_schema');
    expect(decision.selectedTools).toContain('session_search');
    expect(decision.selectedTools).not.toContain('browser_click');
    expect(decision.reason).toBe('rule_match');
  });

  it('3. web keywords select web toolset', async () => {
    const guard = new PlannerGuard(FULL_REGISTRY, 'rule_based');
    const decision = await guard.decide('search the web for typescript', []);
    expect(decision.selectedTools).toContain('web_search');
    expect(decision.selectedTools).toContain('web_fetch');
    expect(decision.selectedTools).not.toContain('shell_exec');
  });

  it('4. multiple keywords union toolsets', async () => {
    const guard = new PlannerGuard(FULL_REGISTRY, 'rule_based');
    const decision = await guard.decide('search the web then save the file', []);
    expect(decision.selectedTools).toContain('web_search');
    expect(decision.selectedTools).toContain('file_write');
  });

  it('5. always includes core tools even on file-only intent', async () => {
    const guard = new PlannerGuard(FULL_REGISTRY, 'rule_based');
    const decision = await guard.decide('write this file', []);
    expect(decision.selectedTools).toContain('skills_list');
    expect(decision.selectedTools).toContain('lookup_tool_schema');
    expect(decision.selectedTools).toContain('session_search');
  });

  it('6. no rule match returns only core tools', async () => {
    const guard = new PlannerGuard(FULL_REGISTRY, 'rule_based');
    const decision = await guard.decide('hi there friend', []);
    expect(decision.selectedTools.sort()).toEqual(
      ['lookup_tool_schema', 'session_search', 'skills_list'].sort(),
    );
    // file_read etc. excluded
    expect(decision.excludedTools).toContain('file_read');
    expect(decision.excludedTools).toContain('web_search');
    expect(decision.reason).toBe('rule_match');
  });

  it('7. skill-required toolsets become active after activateToolsets()', async () => {
    const guard = new PlannerGuard(FULL_REGISTRY, 'rule_based');
    // First turn: no match → only core.
    let decision = await guard.decide('hello', []);
    expect(decision.selectedTools).not.toContain('browser_click');
    // Skill activation (e.g. user opened a browser-using skill).
    guard.activateToolsets(['browser']);
    decision = await guard.decide('hello again', []);
    expect(decision.selectedTools).toContain('browser_click');
    expect(decision.selectedTools).toContain('browser_screenshot');
  });

  it('8. empty user message returns core tools only', async () => {
    const guard = new PlannerGuard(FULL_REGISTRY, 'rule_based');
    const decision = await guard.decide('', []);
    expect(decision.selectedTools.sort()).toEqual(
      ['lookup_tool_schema', 'session_search', 'skills_list'].sort(),
    );
  });

  it('9. multi-tool message: union of all matched toolsets', async () => {
    const guard = new PlannerGuard(FULL_REGISTRY, 'rule_based');
    const decision = await guard.decide(
      'open browser, run a python script, save to a file, and remember the result',
      [],
    );
    expect(decision.selectedTools).toContain('browser_click');
    expect(decision.selectedTools).toContain('execute_code');
    expect(decision.selectedTools).toContain('file_write');
    expect(decision.selectedTools).toContain('memory_add');
  });

  it('10. decide returns excludedTools alongside selectedTools', async () => {
    const guard = new PlannerGuard(FULL_REGISTRY, 'rule_based');
    const decision = await guard.decide('write this file', []);
    const allNames = FULL_REGISTRY.list();
    const selectedSet = new Set(decision.selectedTools);
    const excludedSet = new Set(decision.excludedTools);
    // Selected ∪ Excluded = full registry; intersection empty.
    for (const n of allNames) {
      expect(selectedSet.has(n) || excludedSet.has(n)).toBe(true);
    }
    for (const n of decision.selectedTools) {
      expect(excludedSet.has(n)).toBe(false);
    }
  });
});

describe('PlannerGuard — llm_classified', () => {
  it('11. parses JSON array response and selects subset', async () => {
    const adapter = new FakeAdapter(() => ({
      content: '["file_read","web_search"]',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const guard = new PlannerGuard(FULL_REGISTRY, 'llm_classified', adapter);
    const decision = await guard.decide('something', []);
    expect(decision.reason).toBe('llm_classification');
    expect(decision.selectedTools).toContain('file_read');
    expect(decision.selectedTools).toContain('web_search');
    // Core tools always added.
    expect(decision.selectedTools).toContain('skills_list');
    expect(decision.confidence).toBeGreaterThan(0);
  });

  it('12. malformed LLM response falls back to rule_based', async () => {
    const adapter = new FakeAdapter(() => ({
      content: 'this is not json at all',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const guard = new PlannerGuard(FULL_REGISTRY, 'llm_classified', adapter);
    const decision = await guard.decide('write this file', []);
    expect(decision.reason).toBe('fallback');
    expect(decision.selectedTools).toContain('file_write');
  });

  it('13. timeout falls back to rule_based', async () => {
    // Adapter that never resolves.
    const adapter = new FakeAdapter(
      () =>
        new Promise(() => {
          /* never resolves */
        }),
    );
    const guard = new PlannerGuard(FULL_REGISTRY, 'llm_classified', adapter);
    // Use fake timers to skip the 4s wait.
    vi.useFakeTimers();
    const promise = guard.decide('search the web', []);
    await vi.advanceTimersByTimeAsync(5000);
    const decision = await promise;
    vi.useRealTimers();
    expect(decision.reason).toBe('fallback');
    expect(decision.selectedTools).toContain('web_search');
  });

  it('14. setMode mid-session changes behavior', async () => {
    const adapter = new FakeAdapter(() => ({
      content: '["file_read"]',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const guard = new PlannerGuard(FULL_REGISTRY, 'rule_based', adapter);
    let decision = await guard.decide('search web', []);
    expect(decision.reason).toBe('rule_match');
    expect(decision.selectedTools).toContain('web_search');
    guard.setMode('llm_classified');
    decision = await guard.decide('search web', []);
    expect(decision.reason).toBe('llm_classification');
    expect(decision.selectedTools).toContain('file_read');
  });

  it('15. llm_classified empty array falls back to rule_based', async () => {
    const adapter = new FakeAdapter(() => ({
      content: '[]',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const guard = new PlannerGuard(FULL_REGISTRY, 'llm_classified', adapter);
    const decision = await guard.decide('please save my file', []);
    expect(decision.reason).toBe('fallback');
    expect(decision.selectedTools).toContain('file_write');
  });
});
