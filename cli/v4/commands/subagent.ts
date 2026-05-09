/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/subagent.ts — Phase v4.1-subagent
 *
 * `aiden subagent <action>` subcommand. Two actions:
 *
 *   status — print build fingerprint + env config + provider count.
 *   tools  — list the subagent_fanout schema (debug).
 *
 * Lightweight diagnostics surface — no provider resolution, no
 * agent runtime build. The point is "what would my fanout look like
 * before I run it?" — useful for triaging "no providers configured"
 * errors and verifying env-var allowlists before pointing a client
 * at the binary.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { registerAllTools } from '../../../tools/v4/index';
import {
  AIDEN_SUBAGENT_BUILD,
} from '../../../core/v4/subagent/diagnostics';
import {
  resolveBudget,
  MAX_FANOUT_N,
  DEFAULT_FANOUT_N,
} from '../../../core/v4/subagent/budget';
import { resolveAggregatorOverride } from '../../../core/v4/subagent/merger';

export interface RunSubagentOptions {
  writeOut?: (text: string) => void;
  writeErr?: (text: string) => void;
}

export async function runSubagentSubcommand(
  action: string,
  opts: RunSubagentOptions = {},
): Promise<number> {
  const writeOut = opts.writeOut ?? ((t: string) => process.stdout.write(t));
  const writeErr = opts.writeErr ?? ((t: string) => process.stderr.write(t));

  switch (action) {
    case 'status': {
      const budget = resolveBudget();
      const allowDestructive =
        process.env.AIDEN_SUBAGENT_ALLOW_DESTRUCTIVE === '1' ||
        process.env.AIDEN_SUBAGENT_ALLOW_DESTRUCTIVE === 'true';
      const aggOverride = resolveAggregatorOverride();
      writeOut(`Aiden subagent fanout\n`);
      writeOut(`  build:                   ${AIDEN_SUBAGENT_BUILD}\n`);
      writeOut(`  default n:               ${DEFAULT_FANOUT_N}\n`);
      writeOut(`  hard cap n:              ${MAX_FANOUT_N}\n`);
      writeOut(`  per-subagent timeout ms: ${budget.perSubagentTimeoutMs}\n`);
      writeOut(`  wall-clock cap ms:       ${budget.wallClockCapMs}\n`);
      writeOut(`  max iterations:          ${budget.maxIterations}\n`);
      writeOut(`  allowDestructive:        ${allowDestructive ? 'yes' : 'no'}\n`);
      writeOut(`  aggregator override:     ${
        aggOverride
          ? `${aggOverride.providerId}:${aggOverride.modelId}`
          : '(unset — use parent active model)'
      }\n`);
      return 0;
    }

    case 'tools': {
      const registry = new ToolRegistry();
      registerAllTools(registry);
      const handler = registry.get('subagent_fanout');
      if (!handler) {
        writeErr('subagent_fanout not registered (this is a build bug)\n');
        return 1;
      }
      writeOut(`Aiden subagent — tool schema\n`);
      writeOut(`  name:        ${handler.schema.name}\n`);
      writeOut(`  category:    ${handler.category}\n`);
      writeOut(`  mutates:     ${handler.mutates}\n`);
      writeOut(`  toolset:     ${handler.toolset}\n`);
      writeOut(`  description: ${handler.schema.description}\n`);
      writeOut(`\n  inputSchema (JSON):\n`);
      writeOut(`${JSON.stringify(handler.schema.inputSchema, null, 2)}\n`);
      return 0;
    }

    default: {
      writeErr(`Unknown 'aiden subagent' action: ${action}\n`);
      writeErr(`Actions: status | tools\n`);
      return 1;
    }
  }
}

export { AIDEN_SUBAGENT_BUILD };
