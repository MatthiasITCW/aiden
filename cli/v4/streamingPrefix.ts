/**
 * Copyright (c) 2026 Shiva Deore (Taracod). Licensed under AGPL-3.0.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/streamingPrefix.ts — Phase v4.1-reply-formatting
 *
 * Stable-prefix split for streaming markdown. Given the running
 * buffered text, return the index of the last "safe" boundary —
 * a `\n\n` that lies OUTSIDE any open code fence. Content above
 * the boundary is locked (already rendered, won't redraw); content
 * below the boundary is the suffix the caller may re-render.
 *
 *   safePrefixBoundary("# H\n\nbody\n\nmore") === <index after 2nd \n\n>
 *   safePrefixBoundary("```ts\nstill open") === 0  // inside fence
 *
 * Pure function. Used by display.streamComplete to decide whether to
 * re-render the whole stream as markdown or only the trailing chunk.
 */

/**
 * Returns the index in `text` immediately AFTER the last `\n\n` that
 * lies outside an open code fence. Returns 0 when no safe boundary
 * exists (e.g. when the text is entirely inside an open fence).
 */
export function safePrefixBoundary(text: string): number {
  let inFence = false;
  let fenceMarker: '```' | '~~~' | null = null;
  let lastBoundary = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (!inFence) {
      // Open fence?
      if (text.startsWith('```', i)) {
        inFence = true;
        fenceMarker = '```';
        i += 3;
        continue;
      }
      if (text.startsWith('~~~', i)) {
        inFence = true;
        fenceMarker = '~~~';
        i += 3;
        continue;
      }
      // Paragraph break — `\n\n` (or `\n  \n` with whitespace gap).
      if (text[i] === '\n' && /\n[ \t]*\n/.test(text.slice(i, i + 4))) {
        // Advance past the consecutive whitespace+newlines.
        let j = i;
        while (j < n && (text[j] === '\n' || text[j] === ' ' || text[j] === '\t')) {
          j += 1;
        }
        // Boundary is the START of the post-break content.
        lastBoundary = j;
        i = j;
        continue;
      }
    } else {
      // Close fence?
      if (fenceMarker && text.startsWith(fenceMarker, i)) {
        inFence = false;
        fenceMarker = null;
        i += 3;
        continue;
      }
    }
    i += 1;
  }
  return lastBoundary;
}

/**
 * Split `text` at the safe boundary. `prefix` is locked content
 * (already rendered), `suffix` is the unstable tail the caller
 * should re-render on the next pass.
 */
export function splitAtBoundary(text: string): { prefix: string; suffix: string } {
  const idx = safePrefixBoundary(text);
  return { prefix: text.slice(0, idx), suffix: text.slice(idx) };
}

/**
 * Helper: detect whether `text` ends inside an open code fence.
 * The streaming renderer uses this to decide whether to defer
 * markdown rendering until the fence closes.
 */
export function endsInsideFence(text: string): boolean {
  let inFence = false;
  let fenceMarker: '```' | '~~~' | null = null;
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (!inFence) {
      if (text.startsWith('```', i)) { inFence = true; fenceMarker = '```'; i += 3; continue; }
      if (text.startsWith('~~~', i)) { inFence = true; fenceMarker = '~~~'; i += 3; continue; }
    } else if (fenceMarker && text.startsWith(fenceMarker, i)) {
      inFence = false;
      fenceMarker = null;
      i += 3;
      continue;
    }
    i += 1;
  }
  return inFence;
}
