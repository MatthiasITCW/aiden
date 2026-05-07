import { describe, it, expect } from 'vitest';

import { extractInlineToolCalls } from '../../../providers/v4/chatCompletionsAdapter';

/**
 * Phase 21 #4 — inline `<tool_call>` extraction (Hermes/Qwen format).
 *
 * The `<tool_call>...</tool_call>` wrapping is a public format used by
 * Nous Hermes / Qwen open-source models. These tests pin parser
 * behaviour to that format spec — closed tags, truncated tags, malformed
 * JSON, multiple calls in one stream — so a model regression fails
 * loudly here rather than silently leaking tool JSON to the user.
 */
describe('Phase 21 #4 — extractInlineToolCalls', () => {
  it('1. closed <tool_call> tag → synthesizes ToolCallRequest, strips from content', () => {
    const text =
      'Reasoning aside.\n<tool_call>{"name": "memory_read", "arguments": {"path": "USER.md"}}</tool_call>';
    const r = extractInlineToolCalls(text);
    expect(r).not.toBeNull();
    expect(r!.toolCalls.length).toBe(1);
    expect(r!.toolCalls[0].name).toBe('memory_read');
    expect(r!.toolCalls[0].arguments).toEqual({ path: 'USER.md' });
    expect(r!.content).toBe('Reasoning aside.');
  });

  it('2. unclosed <tool_call> (truncated generation) is recovered', () => {
    const text = '<tool_call>{"name": "web_search", "arguments": {"query": "weather"}}';
    const r = extractInlineToolCalls(text);
    expect(r).not.toBeNull();
    expect(r!.toolCalls[0].name).toBe('web_search');
    expect(r!.toolCalls[0].arguments).toEqual({ query: 'weather' });
    expect(r!.content).toBeNull(); // nothing before the tag
  });

  it('3. content without <tool_call> tag → null (no extraction, no false positive)', () => {
    expect(extractInlineToolCalls('Just regular text. {"foo": "bar"}')).toBeNull();
    expect(extractInlineToolCalls('')).toBeNull();
    expect(extractInlineToolCalls(null)).toBeNull();
    expect(extractInlineToolCalls(undefined)).toBeNull();
  });

  it('4. malformed JSON inside tag → null (no crash, no spurious tool call)', () => {
    const text = '<tool_call>not json at all</tool_call>';
    expect(extractInlineToolCalls(text)).toBeNull();
  });

  it('5. tag with name missing → skipped silently', () => {
    const text = '<tool_call>{"arguments": {"path": "x"}}</tool_call>';
    expect(extractInlineToolCalls(text)).toBeNull();
  });

  it('6. multiple tool_calls in one content → all extracted, content is everything before first tag', () => {
    const text =
      'Plan:\n<tool_call>{"name": "a", "arguments": {}}</tool_call><tool_call>{"name": "b", "arguments": {"k": 1}}</tool_call>';
    const r = extractInlineToolCalls(text);
    expect(r).not.toBeNull();
    expect(r!.toolCalls.map((tc) => tc.name)).toEqual(['a', 'b']);
    expect(r!.toolCalls[1].arguments).toEqual({ k: 1 });
    expect(r!.content).toBe('Plan:');
  });

  it('7. exactly the user-reported leak shape (verbatim) extracts cleanly', () => {
    // From the user's bug report — the full closed-form string the
    // model SHOULD have emitted parses to a clean tool call with no
    // leaked text in `content`.
    const text = '<tool_call>{"name": "memory_read", "arguments": {"path": "USER.md"}}</tool_call>';
    const r = extractInlineToolCalls(text);
    expect(r).not.toBeNull();
    expect(r!.content).toBeNull();
    expect(r!.toolCalls[0]).toEqual({
      id: expect.stringMatching(/^tc-inline-/),
      name: 'memory_read',
      arguments: { path: 'USER.md' },
    });
  });
});

/**
 * Phase 28.2 — bare JSON tool-call detection. Llama / NVIDIA-Llama /
 * Qwen sometimes emit `{"name": "...", "parameters": {...}}` directly
 * inside the answer text without any wrapping `<tool_call>` or
 * `<function=>` tag. The detector recovers these only when the name
 * matches a tool the provider was actually offered, so JSON inside
 * answer prose for educational purposes does not auto-execute.
 */
describe('Phase 28.2 — bare JSON inline tool calls', () => {
  it('1. raw `{"name":"web_search", "parameters":{...}}` after prose extracts', () => {
    const text =
      'The provided code failed... Here\'s an alternative: ' +
      '{"name": "web_search", "parameters": {"query": "joke of the day"}}';
    const r = extractInlineToolCalls(text, new Set(['web_search']));
    expect(r).not.toBeNull();
    expect(r!.toolCalls.length).toBe(1);
    expect(r!.toolCalls[0].name).toBe('web_search');
    expect(r!.toolCalls[0].arguments).toEqual({ query: 'joke of the day' });
    // Content has the JSON stripped; trailing prose preserved.
    expect(r!.content).toMatch(/^The provided code failed/);
    expect(r!.content).not.toContain('"name"');
  });

  it('2. raw JSON with `arguments` key (alias for parameters) also works', () => {
    const text = '{"name": "memory_add", "arguments": {"text": "remember this"}}';
    const r = extractInlineToolCalls(text, new Set(['memory_add']));
    expect(r).not.toBeNull();
    expect(r!.toolCalls[0]).toEqual({
      id: expect.stringMatching(/^tc-inline-/),
      name: 'memory_add',
      arguments: { text: 'remember this' },
    });
    expect(r!.content).toBeNull();
  });

  it('3. JSON inside ```fenced code block``` is left alone', () => {
    const text =
      'Here is an example tool call shape:\n```json\n' +
      '{"name": "web_search", "parameters": {"query": "x"}}\n' +
      '```\nUse the tool API instead of pasting JSON.';
    const r = extractInlineToolCalls(text, new Set(['web_search']));
    expect(r).toBeNull();
  });

  it('4. JSON inside `inline backticks` is left alone', () => {
    const text =
      'Send `{"name": "web_search", "parameters": {"query": "x"}}` to the API.';
    const r = extractInlineToolCalls(text, new Set(['web_search']));
    expect(r).toBeNull();
  });

  it('5. unknown tool name → leaves text alone (no false-positive execute)', () => {
    const text = '{"name": "definitely_not_a_tool", "parameters": {"q": "x"}}';
    const r = extractInlineToolCalls(text, new Set(['web_search']));
    expect(r).toBeNull();
  });

  it('6. malformed JSON → leaves text alone', () => {
    const text = '{"name": "web_search" "parameters": {missing_quotes: x}}';
    const r = extractInlineToolCalls(text, new Set(['web_search']));
    expect(r).toBeNull();
  });

  it('7. multiple inline JSON tool calls in one response → all extracted', () => {
    const text =
      'First: {"name": "web_search", "parameters": {"query": "a"}} ' +
      'then {"name": "web_fetch", "parameters": {"url": "https://x"}}';
    const r = extractInlineToolCalls(text, new Set(['web_search', 'web_fetch']));
    expect(r).not.toBeNull();
    expect(r!.toolCalls.length).toBe(2);
    expect(r!.toolCalls.map((tc) => tc.name)).toEqual(['web_search', 'web_fetch']);
    expect(r!.toolCalls[1].arguments).toEqual({ url: 'https://x' });
  });

  it('8. without `knownToolNames` argument, raw JSON detector does NOT fire (back-compat)', () => {
    const text = '{"name": "web_search", "parameters": {"query": "x"}}';
    expect(extractInlineToolCalls(text)).toBeNull();
    expect(extractInlineToolCalls(text, new Set())).toBeNull();
  });

  it('9. mixed: legacy <tool_call> tag + bare JSON in same content → both extract', () => {
    const text =
      'Plan:\n' +
      '<tool_call>{"name": "skill_view", "arguments": {"name": "git"}}</tool_call>\n' +
      'Then: {"name": "web_search", "parameters": {"query": "rebase"}}';
    const r = extractInlineToolCalls(text, new Set(['skill_view', 'web_search']));
    expect(r).not.toBeNull();
    expect(r!.toolCalls.length).toBe(2);
    expect(r!.toolCalls.map((tc) => tc.name)).toEqual(['skill_view', 'web_search']);
  });

  it('10. JSON-shaped value that is not a tool call (no parameters key) → leaves alone', () => {
    const text = 'Config: {"name": "web_search", "version": "1.0"}';
    const r = extractInlineToolCalls(text, new Set(['web_search']));
    expect(r).toBeNull();
  });

  it('11. parameters value must be an object, not array', () => {
    const text = '{"name": "web_search", "parameters": ["query", "x"]}';
    const r = extractInlineToolCalls(text, new Set(['web_search']));
    expect(r).toBeNull();
  });

  it('12. existing regression: bare JSON without knownToolNames still returns null (test #3 above)', () => {
    expect(extractInlineToolCalls('Just regular text. {"foo": "bar"}')).toBeNull();
  });
});
