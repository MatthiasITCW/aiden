/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/mcp/server/skillBridge.ts — Phase v4.1-mcp
 *
 * Expose Aiden's loaded skills as MCP resources. Skills are inert
 * markdown playbooks (`SKILL.md` + frontmatter), perfect candidates for
 * MCP's read-only resource surface.
 *
 * URI scheme — `aiden-skill://<name>`. We deliberately namespaced this
 * (rather than the bare `skill://`) so when a client connects to multiple
 * agent MCP servers, resource URIs do not collide. The `name` segment is
 * the SKILL.md frontmatter `name` field, which is already the lookup key
 * used by the rest of the runtime (`SkillLoader.load(name)`).
 *
 * The bridge is intentionally read-only:
 *   - `resources/list` enumerates every loaded skill
 *   - `resources/read` returns the raw markdown (frontmatter + body)
 *
 * Mutations live behind the `skill_manage` tool; an MCP client that
 * needs to install or modify a skill must go through that tool path so
 * the same trust-level checks the REPL uses also apply remotely.
 */

import { promises as fs } from 'node:fs';
import type { SkillLoader, SkillSummary } from '../../skillLoader';

const URI_SCHEME = 'aiden-skill';
const URI_PREFIX = `${URI_SCHEME}://`;

/** MCP resource record advertised on `resources/list`. */
export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType: string;
}

/** MCP resource read response shape (one item per content read). */
export interface McpResourceContent {
  uri: string;
  mimeType: string;
  text: string;
}

export function skillUri(name: string): string {
  return `${URI_PREFIX}${encodeURIComponent(name)}`;
}

/** Pull the `<name>` segment back out of an `aiden-skill://<name>` URI.
 *  Returns null on malformed input — the read handler reports `isError`
 *  in that case rather than crashing the protocol. */
export function parseSkillUri(uri: string): string | null {
  if (!uri.startsWith(URI_PREFIX)) return null;
  const raw = uri.slice(URI_PREFIX.length);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export function summaryToResource(s: SkillSummary): McpResource {
  return {
    uri: skillUri(s.name),
    name: s.name,
    description: s.description,
    mimeType: 'text/markdown',
  };
}

/**
 * Build the resources array advertised on `resources/list`. Walks the
 * SkillLoader cache (already warmed at boot in the runtime) so this is
 * just an in-memory map.
 */
export async function buildResourcesList(
  loader: SkillLoader,
): Promise<McpResource[]> {
  const list = await loader.list();
  return list.map(summaryToResource);
}

/**
 * `resources/read` handler. Returns the raw SKILL.md content for the
 * named skill. Throws when the URI is malformed or the skill is unknown
 * — the stdio-server layer maps those to JSON-RPC errors.
 */
export async function readSkillResource(
  loader: SkillLoader,
  uri: string,
): Promise<McpResourceContent> {
  const name = parseSkillUri(uri);
  if (name === null) {
    throw new Error(`Malformed resource URI (expected ${URI_PREFIX}<name>): ${uri}`);
  }
  const skill = await loader.load(name);
  if (!skill) {
    throw new Error(`Skill not found: ${name}`);
  }
  // SKILL.md content lives on disk. The loader exposes `filePath`; read
  // the raw bytes so the client gets frontmatter + body verbatim. (We
  // could reconstruct from `frontmatter` + `content`, but raw avoids
  // round-trip drift if the loader ever rewrites YAML on parse.)
  const text = await fs.readFile(skill.filePath, 'utf-8');
  return { uri, mimeType: 'text/markdown', text };
}
