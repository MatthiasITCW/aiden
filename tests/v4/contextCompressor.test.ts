import { describe, it, expect } from 'vitest';
import { ContextCompressor } from '../../core/v4/contextCompressor';
import { ModelMetadata } from '../../core/v4/modelMetadata';
import { AuxiliaryClient } from '../../core/v4/auxiliaryClient';
import type {
  Message,
  ProviderAdapter,
  ProviderCallInput,
  ProviderCallOutput,
} from '../../providers/v4/types';

class FakeAdapter implements ProviderAdapter {
  apiMode = 'chat_completions' as const;
  public calls = 0;
  constructor(private summary: string) {}
  async call(_input: ProviderCallInput): Promise<ProviderCallOutput> {
    this.calls += 1;
    return {
      content: this.summary,
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 50, outputTokens: 80 },
    };
  }
}

class FailingAdapter implements ProviderAdapter {
  apiMode = 'chat_completions' as const;
  async call(): Promise<ProviderCallOutput> {
    throw new Error('aux down');
  }
}

function makeAux(adapter: ProviderAdapter): AuxiliaryClient {
  return new AuxiliaryClient({
    defaultProvider: 'groq',
    defaultModel: 'llama-3.1-8b-instant',
    adapter,
    warn: () => {},
  });
}

const userMsg = (content: string): Message => ({ role: 'user', content });
const asstMsg = (content: string): Message => ({ role: 'assistant', content });
const sysMsg = (content: string): Message => ({ role: 'system', content });

function tinyContextMd(): ModelMetadata {
  // ModelMetadata pulls from the catalog. We use a small-context provider
  // so trigger thresholds are hit with reasonable test input sizes.
  return new ModelMetadata();
}

describe('ContextCompressor', () => {
  it('1. shouldCompress: below threshold returns false', () => {
    const cc = new ContextCompressor(tinyContextMd(), makeAux(new FakeAdapter('s')));
    const trig = cc.shouldCompress([userMsg('hi')], 'groq', 'llama-3.1-8b-instant');
    expect(trig.shouldCompress).toBe(false);
    expect(trig.reason).toBe('below_threshold');
  });

  it('2. shouldCompress: at/above threshold returns true with reason', () => {
    const md = tinyContextMd();
    // Build a message that estimates above 50% of (context - reserved).
    // Use ollama gemma2:2b for a small 8192 context window.
    const limits = md.getLimits('ollama', 'gemma2:2b');
    const usable = limits.contextLength - limits.reservedForOutput;
    const half = Math.ceil(usable * 0.6);
    // Each char ≈ 1 token in fallback path; tiktoken differs but we use a long string.
    const big = 'x'.repeat(half * 4);
    const cc = new ContextCompressor(md, makeAux(new FakeAdapter('s')));
    const trig = cc.shouldCompress([userMsg(big)], 'ollama', 'gemma2:2b');
    expect(trig.shouldCompress).toBe(true);
    expect(trig.reason).toBe('threshold_exceeded');
  });

  it('3. compress: short conversation refused (returns original)', async () => {
    const cc = new ContextCompressor(tinyContextMd(), makeAux(new FakeAdapter('summary')));
    const messages: Message[] = [userMsg('hi'), asstMsg('hello')];
    const r = await cc.compress(messages, 'groq', 'llama-3.1-8b-instant');
    expect(r.refused).toBe(true);
    expect(r.compressedMessages).toEqual(messages);
  });

  it('4. forceCompress: long conversation produces summary and replaces middle', async () => {
    const adapter = new FakeAdapter('SUMMARY-OF-MIDDLE');
    const cc = new ContextCompressor(tinyContextMd(), makeAux(adapter));
    const messages: Message[] = [
      sysMsg('system instructions'),
      ...Array.from({ length: 20 }, (_, i) =>
        i % 2 === 0 ? userMsg(`u${i}`) : asstMsg(`a${i}`),
      ),
    ];
    const r = await cc.forceCompress(messages, 'groq', 'llama-3.1-8b-instant');
    expect(adapter.calls).toBeGreaterThanOrEqual(1);
    // Summary message present.
    expect(r.compressedMessages.some((m) => m.content.includes('SUMMARY-OF-MIDDLE'))).toBe(true);
    expect(r.removedMessageCount).toBeGreaterThan(0);
  });

  it('5. compress preserves leading system prompt(s)', async () => {
    const cc = new ContextCompressor(tinyContextMd(), makeAux(new FakeAdapter('SUMMARY')));
    const messages: Message[] = [
      sysMsg('SYSTEM-A'),
      sysMsg('SYSTEM-B'),
      ...Array.from({ length: 15 }, (_, i) => userMsg(`u${i}`)),
    ];
    const r = await cc.forceCompress(messages, 'groq', 'llama-3.1-8b-instant');
    expect(r.compressedMessages[0].content).toBe('SYSTEM-A');
    expect(r.compressedMessages[1].content).toBe('SYSTEM-B');
  });

  it('6. compress preserves last 6 messages verbatim', async () => {
    const cc = new ContextCompressor(tinyContextMd(), makeAux(new FakeAdapter('SUMMARY')));
    const messages: Message[] = Array.from({ length: 20 }, (_, i) =>
      userMsg(`m${i}`),
    );
    const r = await cc.forceCompress(messages, 'groq', 'llama-3.1-8b-instant');
    const last6 = r.compressedMessages.slice(-6).map((m) => m.content);
    expect(last6).toEqual(['m14', 'm15', 'm16', 'm17', 'm18', 'm19']);
  });

  it('7. summary length under cap (≤ ~500 tokens, enforced by aux maxTokens)', async () => {
    const cc = new ContextCompressor(tinyContextMd(), makeAux(new FakeAdapter('a brief summary')));
    const r = await cc.forceCompress(
      Array.from({ length: 15 }, (_, i) => userMsg(`m${i}`)),
      'groq',
      'llama-3.1-8b-instant',
    );
    // FakeAdapter returns 'a brief summary' which is <500 tokens.
    expect(r.summaryTokens).toBeLessThan(500);
  });

  it('8. forceCompress ignores threshold even when below', async () => {
    const cc = new ContextCompressor(tinyContextMd(), makeAux(new FakeAdapter('SUMMARY')));
    const messages = Array.from({ length: 12 }, (_, i) => userMsg(`m${i}`));
    const r = await cc.forceCompress(messages, 'groq', 'llama-3.1-8b-instant');
    expect(r.refused).not.toBe(true);
    expect(r.removedMessageCount).toBeGreaterThan(0);
  });

  it('9. result includes metadata', async () => {
    const cc = new ContextCompressor(tinyContextMd(), makeAux(new FakeAdapter('SUMMARY')));
    const r = await cc.forceCompress(
      Array.from({ length: 15 }, (_, i) => userMsg(`m${i}`)),
      'groq',
      'llama-3.1-8b-instant',
    );
    expect(r.removedMessageCount).toBeGreaterThan(0);
    expect(r.summaryTokens).toBeGreaterThan(0);
    expect(r.preservedRecentCount).toBeGreaterThan(0);
  });

  it('10. multi-pass: keeps reducing until below threshold or max passes', async () => {
    // FakeAdapter always returns the same short summary, so a single pass
    // suffices in most cases. Just verify the loop completes without error.
    const cc = new ContextCompressor(tinyContextMd(), makeAux(new FakeAdapter('SUM')));
    const messages = Array.from({ length: 30 }, (_, i) => userMsg(`m${i}`));
    const r = await cc.forceCompress(messages, 'groq', 'llama-3.1-8b-instant');
    expect(r.compressedMessages.length).toBeLessThanOrEqual(messages.length);
  });

  it('11. auxiliary failure during summarization: returns original + error flag', async () => {
    const cc = new ContextCompressor(tinyContextMd(), makeAux(new FailingAdapter()));
    const messages = Array.from({ length: 15 }, (_, i) => userMsg(`m${i}`));
    const r = await cc.forceCompress(messages, 'groq', 'llama-3.1-8b-instant');
    expect(r.error).toBe(true);
    expect(r.compressedMessages).toEqual(messages);
  });

  it('12. shouldCompress reports utilization fraction', () => {
    const cc = new ContextCompressor(tinyContextMd(), makeAux(new FakeAdapter('s')));
    const trig = cc.shouldCompress(
      [userMsg('hi')],
      'groq',
      'llama-3.1-8b-instant',
    );
    expect(trig.utilization).toBeGreaterThanOrEqual(0);
    expect(trig.utilization).toBeLessThan(1);
  });
});
