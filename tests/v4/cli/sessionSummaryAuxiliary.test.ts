import { describe, it, expect } from 'vitest';
import { parseSessionBulletsResponse } from '../../../cli/v4/chatSession';

/**
 * Phase v4.1.2 session-summary-followup — defensive parser for the
 * auxiliary client's JSON-array response.
 *
 * Contract:
 *   - Direct JSON.parse of clean output yields the bullets
 *   - Markdown code-fenced output is unwrapped first
 *   - Prose-wrapped output yields bullets via first-balanced-[...] fallback
 *   - Non-string array members are filtered out
 *   - Empty / whitespace-only / non-array inputs return null
 *   - Empty arrays return null (caller retries)
 */
describe('parseSessionBulletsResponse', () => {
  it('parses a clean JSON array of strings', () => {
    const out = parseSessionBulletsResponse(
      '["shipped v4.1.1","diagnosed oauth","fixed schema","added doctor flag","queued aux fallback"]',
    );
    expect(out).toEqual([
      'shipped v4.1.1',
      'diagnosed oauth',
      'fixed schema',
      'added doctor flag',
      'queued aux fallback',
    ]);
  });

  it('handles surrounding whitespace + newlines', () => {
    const out = parseSessionBulletsResponse('\n\n  ["a","b","c"]  \n');
    expect(out).toEqual(['a', 'b', 'c']);
  });

  it('unwraps a fenced JSON code block (```json ... ```)', () => {
    const raw = [
      'Sure, here are the bullets:',
      '```json',
      '["one","two","three"]',
      '```',
    ].join('\n');
    expect(parseSessionBulletsResponse(raw)).toEqual(['one', 'two', 'three']);
  });

  it('unwraps an unlabeled fenced code block (``` ... ```)', () => {
    const raw = '```\n["x", "y"]\n```';
    expect(parseSessionBulletsResponse(raw)).toEqual(['x', 'y']);
  });

  it('falls back to first-balanced-[...] when wrapped in prose', () => {
    const raw =
      'Here\'s the summary: ["alpha","beta","gamma"]. Hope this helps!';
    expect(parseSessionBulletsResponse(raw)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('filters non-string entries out', () => {
    const out = parseSessionBulletsResponse(
      '["valid", 42, null, "another", {"nope": 1}]',
    );
    expect(out).toEqual(['valid', 'another']);
  });

  it('trims whitespace inside each bullet', () => {
    const out = parseSessionBulletsResponse('["  padded  ", "\\n\\nspaced\\n"]');
    expect(out).toEqual(['padded', 'spaced']);
  });

  it('returns null for empty string', () => {
    expect(parseSessionBulletsResponse('')).toBeNull();
    expect(parseSessionBulletsResponse('   ')).toBeNull();
  });

  it('returns null for non-array JSON without any recoverable bracket', () => {
    expect(parseSessionBulletsResponse('"just a string"')).toBeNull();
    expect(parseSessionBulletsResponse('null')).toBeNull();
    expect(parseSessionBulletsResponse('42')).toBeNull();
  });

  it('recovers bullets from object-wrapped JSON via the bracket-fallback', () => {
    // Lenient on purpose — if the auxiliary client returns
    // `{"bullets":[...]}` despite being asked for a bare array, we
    // still extract usable content rather than failing the user.
    expect(parseSessionBulletsResponse('{"bullets": ["a", "b"]}'))
      .toEqual(['a', 'b']);
  });

  it('returns null for malformed JSON with no recoverable array', () => {
    expect(parseSessionBulletsResponse('I cannot summarise this.')).toBeNull();
    expect(parseSessionBulletsResponse('not json {definitely not}')).toBeNull();
  });

  it('returns null for empty array (caller should retry)', () => {
    expect(parseSessionBulletsResponse('[]')).toBeNull();
    expect(parseSessionBulletsResponse('["", "   ", ""]')).toBeNull();
  });
});
