/**
 * Phase 17.1 regression tests — three small fixes from manual smoke.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { resolveAidenPaths, ensureAidenDirsExist } from '../../../core/v4/paths';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { PluginLoader } from '../../../core/v4/plugins/pluginLoader';
import {
  evaluatePermissionState,
  saveGrantedPermissions,
  loadGrantedPermissions,
} from '../../../core/v4/plugins/pluginPermissions';
import { plugins as pluginsCmd } from '../../../cli/v4/commands/plugins';
import {
  CommandRegistry,
  type SlashCommandContext,
} from '../../../cli/v4/commandRegistry';
import { MANIFEST_VERSION } from '../../../core/v4/plugins/pluginManifest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const cdpPlugin = require('../../../plugins/aiden-plugin-cdp-browser/index.js');

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-17-1-'));
});
afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function captured() {
  const o: any = { out: [], errs: [] };
  o.info = (m: string) => o.out.push('info:' + m);
  o.warn = (m: string) => o.out.push('warn:' + m);
  o.dim = (m: string) => o.out.push('dim:' + m);
  o.write = (m: string) => o.out.push(m);
  o.line = () => o.out.push('---');
  o.printError = (...m: string[]) => o.errs.push(m.join(' | '));
  o.success = (m: string) => o.out.push('ok:' + m);
  o.startSpinner = () => ({ stop() {} });
  return o;
}

async function writePlugin(
  root: string,
  name: string,
  permissions: string[],
): Promise<string> {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'plugin.json'),
    JSON.stringify({
      manifestVersion: MANIFEST_VERSION,
      name,
      version: '1.0.0',
      author: 't',
      description: 'd',
      tools: [],
      permissions,
    }),
  );
  await fs.writeFile(
    path.join(dir, 'index.js'),
    `module.exports = { register() {} };`,
  );
  return dir;
}

describe('Phase 17.1: /plugins grant confirm fires for real', () => {
  it('63. confirm hook is invoked exactly once with a y/N prompt', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    await writePlugin(paths.pluginsDir, 'svc', ['network']);
    const loader = new PluginLoader({
      paths,
      toolRegistry: new ToolRegistry(),
      evaluatePermissions: evaluatePermissionState,
    });
    await loader.discoverAndLoad();

    const confirm = vi.fn(async () => true);
    const ctx: SlashCommandContext = {
      args: ['grant', 'svc'],
      rawArgs: 'grant svc',
      display: captured(),
      registry: new CommandRegistry(),
      paths,
      pluginLoader: loader,
      confirm,
    };
    await pluginsCmd.handler(ctx);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[0]).toMatch(/\[y\/N\]/);
  });

  it('64. confirm rejected → grant cancelled, granted file NOT written', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    const dir = await writePlugin(paths.pluginsDir, 'svc', ['network']);
    const loader = new PluginLoader({
      paths,
      toolRegistry: new ToolRegistry(),
      evaluatePermissions: evaluatePermissionState,
    });
    await loader.discoverAndLoad();

    const confirm = vi.fn(async () => false);
    const ctx: SlashCommandContext = {
      args: ['grant', 'svc'],
      rawArgs: 'grant svc',
      display: captured(),
      registry: new CommandRegistry(),
      paths,
      pluginLoader: loader,
      confirm,
    };
    await pluginsCmd.handler(ctx);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(await loadGrantedPermissions(dir)).toEqual([]);
  });
});

describe('Phase 17.1: CDP tool definitions carry inputSchema', () => {
  it('65. all three CDP tools expose a JSON Schema parameters block', () => {
    const fakeClient = {
      click: async () => ({}),
      extract: async () => ({}),
      evaluate: async () => ({}),
    };
    const handlers = cdpPlugin.buildToolHandlers(fakeClient);

    expect(handlers).toHaveLength(3);
    for (const h of handlers) {
      expect(h.schema.name).toMatch(/^browser_real_(click|extract|eval)$/);
      // The canonical tool-schema field is `inputSchema` (camelCase) — the
      // Together / OpenAI / Anthropic adapters all read this and translate
      // to wire format. Phase 17 shipped with `input_schema` (snake_case)
      // so the chat-completions adapter saw `undefined` and dropped the
      // `parameters` field, causing a 400 from Together: "tools[40].function:
      // missing field 'parameters'".
      expect(h.schema).toHaveProperty('inputSchema');
      expect(h.schema.inputSchema).toMatchObject({
        type: 'object',
        properties: expect.any(Object),
      });
    }

    const click = handlers.find(
      (h: any) => h.schema.name === 'browser_real_click',
    );
    expect(click.schema.inputSchema.required).toContain('selector');
    const ev = handlers.find(
      (h: any) => h.schema.name === 'browser_real_eval',
    );
    expect(ev.schema.inputSchema.required).toContain('script');
  });
});

describe('Phase 17.1: NEW perms warning gated on actual upgrade', () => {
  it('66. first install (no granted file) → no NEW framing', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    await writePlugin(paths.pluginsDir, 'fresh', ['network', 'browser']);
    const loader = new PluginLoader({
      paths,
      toolRegistry: new ToolRegistry(),
      evaluatePermissions: evaluatePermissionState,
    });
    await loader.discoverAndLoad();
    const display = captured();
    const ctx: SlashCommandContext = {
      args: ['grant', 'fresh'],
      rawArgs: 'grant fresh',
      display,
      registry: new CommandRegistry(),
      paths,
      pluginLoader: loader,
      confirm: async () => true,
    };
    await pluginsCmd.handler(ctx);

    const out = display.out.join('\n');
    expect(out).not.toMatch(/NEW permissions requested/);
    // Plain summary should still list the perms.
    expect(out).toContain('Permissions requested: network, browser');
  });

  it('67. upgrade (granted file with subset) → NEW framing on the diff only', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    const dir = await writePlugin(paths.pluginsDir, 'grew', [
      'network',
      'shell',
    ]);
    await saveGrantedPermissions(dir, ['network']);
    const loader = new PluginLoader({
      paths,
      toolRegistry: new ToolRegistry(),
      evaluatePermissions: evaluatePermissionState,
    });
    await loader.discoverAndLoad();
    const display = captured();
    const ctx: SlashCommandContext = {
      args: ['grant', 'grew'],
      rawArgs: 'grant grew',
      display,
      registry: new CommandRegistry(),
      paths,
      pluginLoader: loader,
      confirm: async () => true,
    };
    await pluginsCmd.handler(ctx);

    const out = display.out.join('\n');
    expect(out).toMatch(/NEW permissions requested: shell/);
    // shell is the diff; network was already granted so should NOT appear in NEW.
    expect(out).not.toMatch(/NEW permissions requested:.*network/);
  });
});
