/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/shellInterpolation.ts — Phase v4.1-tier3-essentials
 *
 * Inline shell expansion. When a user prompt contains one or more
 * `{!cmd}` spans, we run each command, splice the output back in,
 * and submit the rewritten prompt to the agent.
 *
 * Rules:
 *   - Each `{!cmd}` runs via `child_process.exec` with a 5s wallclock
 *     timeout (kill on overrun).
 *   - Output is stdout (or stderr if stdout empty), trimmed, capped
 *     at 500 visible chars. Multi-line output is collapsed to the
 *     first 500 chars verbatim — newlines preserved.
 *   - On non-zero exit / timeout / spawn failure, the span is
 *     replaced with `[shell:error]` so the rest of the prompt still
 *     submits.
 *   - Every span runs in parallel; total wait bounded by the slowest
 *     single command.
 *
 * MCP serve mode never reaches this path (REPL doesn't run there).
 *
 * Security: this expands BEFORE the agent loop, so the same
 * `approvalEngine` gate the user has on the in-agent `shell_exec`
 * tool does NOT apply here. To prevent an unattended REPL from
 * exfiltrating arbitrary command output, callers SHOULD only invoke
 * this on user-typed prompts (never on tool-emitted text). chatSession
 * applies it to `readUserInput`'s return value, which is exactly that.
 */

import { exec } from 'node:child_process';

/** Matches `{!cmd}` spans non-greedily so `{!a} {!b}` produces two matches. */
export const INTERPOLATION_RE = /\{!(.+?)\}/g;

/** Truthy check used by callers that want to skip the work entirely. */
export function hasInterpolation(text: string): boolean {
  return /\{![^}]+\}/.test(text);
}

/** Default output cap (visible chars per span). */
const OUTPUT_CAP = 500;
/** Default wallclock timeout per span (ms). */
const TIMEOUT_MS = 5_000;

export interface InterpolationOptions {
  timeoutMs?: number;
  outputCap?: number;
}

interface SpanResult {
  start:  number;
  end:    number;
  text:   string;  // replacement text (output or `[shell:error]`)
}

/**
 * Run a single `cmd` and return the trimmed output (or `[shell:error]`).
 * Always resolves; never rejects.
 */
async function runOne(cmd: string, opts: Required<InterpolationOptions>): Promise<string> {
  return new Promise<string>((resolve) => {
    let settled = false;
    const child = exec(cmd, { timeout: opts.timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (settled) return;
      settled = true;
      if (err) {
        // exec sets err.killed=true on timeout. Either way:
        // surface a marker rather than a partial command output.
        resolve('[shell:error]');
        return;
      }
      const out = (stdout && stdout.length > 0 ? stdout : stderr ?? '').trim();
      if (out.length === 0) {
        resolve('');
        return;
      }
      if (out.length <= opts.outputCap) {
        resolve(out);
      } else {
        resolve(out.slice(0, opts.outputCap) + '…');
      }
    });
    // Defensive: kill on timeout in case `exec`'s built-in timeout
    // misses the window (Windows shell quirks). The exec callback
    // above will still fire.
    setTimeout(() => {
      if (!settled) {
        try { child.kill('SIGKILL'); } catch { /* */ }
      }
    }, opts.timeoutMs + 500);
  });
}

/**
 * Expand every `{!cmd}` in `text`, returning the rewritten string.
 * If `text` contains no spans, returned verbatim with no work done.
 */
export async function expand(
  text: string,
  optsIn: InterpolationOptions = {},
): Promise<string> {
  if (!hasInterpolation(text)) return text;

  const opts: Required<InterpolationOptions> = {
    timeoutMs: optsIn.timeoutMs ?? TIMEOUT_MS,
    outputCap: optsIn.outputCap ?? OUTPUT_CAP,
  };

  // Collect all matches up front so we can splice in order.
  const matches: { start: number; end: number; cmd: string }[] = [];
  for (const m of text.matchAll(INTERPOLATION_RE)) {
    if (m.index === undefined) continue;
    matches.push({
      start: m.index,
      end:   m.index + m[0].length,
      cmd:   (m[1] ?? '').trim(),
    });
  }

  // Run all spans in parallel.
  const replacements = await Promise.all(
    matches.map(async (m): Promise<SpanResult> => ({
      start: m.start,
      end:   m.end,
      text:  m.cmd.length > 0 ? await runOne(m.cmd, opts) : '',
    })),
  );

  // Splice from right-to-left so earlier spans' positions stay valid.
  let out = text;
  for (let i = replacements.length - 1; i >= 0; i -= 1) {
    const r = replacements[i];
    out = out.slice(0, r.start) + r.text + out.slice(r.end);
  }
  return out;
}

/**
 * Cheap surface count for the pre-submit "[shell] running N
 * interpolations…" status line.
 */
export function countSpans(text: string): number {
  let n = 0;
  for (const _ of text.matchAll(INTERPOLATION_RE)) n += 1;
  return n;
}
