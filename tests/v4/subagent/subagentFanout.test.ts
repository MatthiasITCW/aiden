import { describe, test, expect } from 'vitest';
import { makeSubagentFanoutTool } from '../../../tools/v4/subagent/subagentFanout';

/**
 * Phase v4.1.1-oauth-fix Phase 2 — regression for the chatgpt-plus 400.
 *
 * OpenAI's Codex backend rejected every request that included the
 * `subagent_fanout` tool with:
 *
 *   Invalid schema for function 'subagent_fanout':
 *   In context=('properties', 'tasks'), array schema missing items.
 *
 * The `tasks` array declaration was missing an `items` field. This
 * regression test guarantees the inner shape stays explicit and matches
 * the PartitionTask interface in core/v4/subagent/fanout.ts.
 *
 * The factory below is invoked with minimum-viable stubs because we only
 * inspect the produced `.schema`; nothing actually executes.
 */

const stubFactoryOpts = {
  resolveProviders:    () => [],
  resolveActiveModel:  () => ({ providerId: 'stub', modelId: 'stub' }),
  // Schema inspection doesn't touch the adapter; cast keeps the test
  // independent of the full ProviderAdapter surface.
  aggregatorAdapter:   {} as never,
  runChild:            async () => '',
};

describe('subagent_fanout schema validation (regression for OpenAI 400)', () => {
  test('tasks property is an array with an items declaration', () => {
    const tool = makeSubagentFanoutTool(stubFactoryOpts);
    const tasksSchema =
      (tool.schema.inputSchema as Record<string, any>).properties.tasks;
    expect(tasksSchema.type).toBe('array');
    expect(tasksSchema.items).toBeDefined();
    expect(tasksSchema.items.type).toBe('object');
  });

  test('tasks.items mirrors PartitionTask (goal required, context/role optional)', () => {
    const tool = makeSubagentFanoutTool(stubFactoryOpts);
    const itemsSchema =
      (tool.schema.inputSchema as Record<string, any>).properties.tasks.items;
    expect(itemsSchema.required).toEqual(['goal']);
    expect(itemsSchema.properties.goal.type).toBe('string');
    expect(itemsSchema.properties.context.type).toBe('string');
    expect(itemsSchema.properties.role.type).toBe('string');
  });

  test('tasks.items declares no extra unexpected properties', () => {
    const tool = makeSubagentFanoutTool(stubFactoryOpts);
    const props =
      (tool.schema.inputSchema as Record<string, any>).properties.tasks.items.properties;
    // If a new PartitionTask field is added, update this expectation —
    // forcing a deliberate schema review.
    expect(Object.keys(props).sort()).toEqual(['context', 'goal', 'role']);
  });

  test('outer schema still requires mode', () => {
    const tool = makeSubagentFanoutTool(stubFactoryOpts);
    const inputSchema = tool.schema.inputSchema as Record<string, any>;
    expect(inputSchema.required).toContain('mode');
  });
});
