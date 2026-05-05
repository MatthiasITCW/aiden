/**
 * core/v4/plugins/pluginPermissions.ts — Aiden v4.0.0 (Phase 17 Task 3+4)
 *
 * Loads and saves the per-plugin granted-permissions file. Lives under
 * the plugin's own directory (`.granted-permissions.json`) so a fresh
 * install starts ungranted and `/plugins remove` cleans it up
 * automatically.
 *
 * Advisory only — Pro-tier trust UX, not a security boundary (per audit).
 * The plugin loader's `isPermissionGranted` hook reads through this; a
 * malicious plugin can bypass.
 *
 * File format: { "version": 1, "granted": ["network", ...] }
 *
 * Hermes has no equivalent — this is net-new for Aiden.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  PERMISSION_TYPES,
  type PluginPermission,
  type PluginManifest,
} from './pluginManifest';

export const GRANTED_FILE = '.granted-permissions.json';
export const GRANTED_VERSION = 1;

interface GrantedFileShape {
  version: number;
  granted: string[];
}

/**
 * Read the granted-permissions file for a plugin. Returns the empty
 * array on missing file or any parse error — failure-safe so a corrupt
 * file becomes "no grants" rather than a load error.
 */
export async function loadGrantedPermissions(
  pluginDir: string,
): Promise<PluginPermission[]> {
  const file = path.join(pluginDir, GRANTED_FILE);
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(text) as Partial<GrantedFileShape>;
    if (!parsed || !Array.isArray(parsed.granted)) return [];
    return parsed.granted.filter(
      (p): p is PluginPermission =>
        typeof p === 'string' && (PERMISSION_TYPES as readonly string[]).includes(p),
    );
  } catch {
    return [];
  }
}

/**
 * Persist the grant set. Overwrites any existing file. Caller must have
 * already validated permissions (every entry in PERMISSION_TYPES) — we
 * write whatever is given so explicit denial of `[]` is representable.
 */
export async function saveGrantedPermissions(
  pluginDir: string,
  granted: PluginPermission[],
): Promise<void> {
  const file = path.join(pluginDir, GRANTED_FILE);
  const payload: GrantedFileShape = { version: GRANTED_VERSION, granted };
  await fs.writeFile(file, JSON.stringify(payload, null, 2) + '\n');
}

/**
 * Build the `isPermissionGranted` hook the loader expects. Caches the
 * grant lookup per plugin path so a single `discoverAndLoad()` doesn't
 * re-read each file once per declared permission.
 */
export function buildPermissionChecker(
  cache = new Map<string, Set<string>>(),
): (manifest: PluginManifest, permission: string) => boolean {
  return (manifest, permission) => {
    if (!manifest.path) return false;
    let grants = cache.get(manifest.path);
    if (!grants) {
      // Synchronous read — checker is called inside the loader's load
      // path which is already async, but the loader expects a sync hook.
      // Use the sync API on first call, then memoise.
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fsSync = require('node:fs') as typeof import('node:fs');
        const file = path.join(manifest.path, GRANTED_FILE);
        const text = fsSync.readFileSync(file, 'utf8');
        const parsed = JSON.parse(text) as Partial<GrantedFileShape>;
        grants = new Set(
          Array.isArray(parsed.granted)
            ? parsed.granted.filter((p) => typeof p === 'string')
            : [],
        );
      } catch {
        grants = new Set();
      }
      cache.set(manifest.path, grants);
    }
    return grants.has(permission);
  };
}

/**
 * Pretty-print a manifest's install summary for the slash-command
 * confirmation prompt. Pure function — caller owns rendering.
 */
export function formatInstallSummary(manifest: PluginManifest): string {
  const lines: string[] = [];
  lines.push(`Plugin: ${manifest.name} v${manifest.version}`);
  if (manifest.author) lines.push(`Author: ${manifest.author}`);
  if (manifest.description) lines.push(`Description: ${manifest.description}`);
  lines.push(`Tools: ${manifest.tools.length ? manifest.tools.join(', ') : '(none)'}`);
  lines.push(`Skills: ${manifest.skills.length ? manifest.skills.join(', ') : '(none)'}`);
  lines.push(
    `Providers: ${manifest.providers.length ? manifest.providers.join(', ') : '(none)'}`,
  );
  lines.push(
    `Permissions requested: ${
      manifest.permissions.length ? manifest.permissions.join(', ') : '(none)'
    }`,
  );
  return lines.join('\n');
}
