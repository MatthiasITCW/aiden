/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/mcp/server/diagnostics.ts — Phase v4.1-mcp
 *
 * Build fingerprint + counts surfaced by the `aiden mcp status` CLI
 * subcommand and the launch log line. The fingerprint follows the same
 * convention the Telegram adapter set in v4.1-3.2 — a constant string
 * the user can grep for to verify the build that's actually running
 * matches the phase they expected.
 *
 * Bump on every shipped phase. Format: `v4.1-mcp[+suffix]`.
 */

import type { ToolRegistry } from '../../toolRegistry';
import type { SkillLoader } from '../../skillLoader';
import {
  exposedToolNames,
  readToolBridgeEnv,
  type ToolBridgeEnv,
} from './toolBridge';

/** Build fingerprint — bump per phase. Surfaced in `aiden mcp status`
 *  and the stderr launch line so it's grep-able from the spawning
 *  client's log stream. */
export const AIDEN_MCP_BUILD = 'v4.1-mcp.2';

export interface McpDiagnostics {
  build: string;
  toolsTotal: number;
  toolsExposed: number;
  skillsTotal: number;
  env: {
    allowDestructive: boolean;
    allowlist: string[] | null;
  };
}

export async function collectMcpDiagnostics(
  registry: ToolRegistry,
  loader: SkillLoader,
  env: ToolBridgeEnv = readToolBridgeEnv(),
): Promise<McpDiagnostics> {
  const exposed = exposedToolNames(registry, env);
  const skills = await loader.list();
  return {
    build: AIDEN_MCP_BUILD,
    toolsTotal: registry.list().length,
    toolsExposed: exposed.length,
    skillsTotal: skills.length,
    env: {
      allowDestructive: env.allowDestructive,
      allowlist: env.allowlist ? [...env.allowlist].sort() : null,
    },
  };
}
