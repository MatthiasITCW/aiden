/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/show.ts — Tier-3.1 (v4.1-tier3.1)
 *
 * `/show <id>` — print a previously compressed paste. Compressed
 * pastes are echoed in the REPL as `[paste #<id>: <N> lines, <KB>]`
 * and stored on disk; this command reverses that for the user
 * (NOT the agent — the agent receives the full original text at
 * paste time).
 */

import type { SlashCommand } from '../commandRegistry';
import { expandPaste } from '../pasteCompression';

export const show: SlashCommand = {
  name: 'show',
  description: 'Print the original content of a compressed paste (/show <id>).',
  category: 'system',
  icon: '>',
  handler: async (ctx) => {
    const id = (ctx.args[0] ?? '').trim();
    if (!id) {
      ctx.display.warn('Usage: /show <id>  (id from the [paste #<id>: ...] echo)');
      return {};
    }
    const original = await expandPaste(id);
    if (original == null) {
      ctx.display.warn(`No paste with id ${id} found.`);
      return {};
    }
    ctx.display.write('\n');
    ctx.display.write(original);
    if (!original.endsWith('\n')) ctx.display.write('\n');
    ctx.display.write('\n');
    return {};
  },
};
