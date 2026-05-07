/**
 * Phase 18 Task 4 — setup wizard OAuth integration tests.
 *
 * The wizard's `kind: 'pro'` path now runs the real OAuth flow via
 * OAuthProviderRuntime. These tests stub the plugin's buildProvider to
 * return a synthetic OAuthProvider so we never touch network or load
 * the real Claude/ChatGPT plugins (their OAuth fixtures are tested
 * separately in claudeProPlugin.test.ts / chatgptPlusPlugin.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runSetupWizard, PROVIDERS } from '../../../cli/v4/setupWizard';
import {
  resolveAidenPaths,
  ensureAidenDirsExist,
} from '../../../core/v4/paths';
import {
  loadTokens,
} from '../../../core/v4/auth/tokenStore';
import { Display } from '../../../cli/v4/display';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-wizard-oauth-'));
  process.env.AIDEN_TOKEN_KEY = 'test-key';
});
afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  delete process.env.AIDEN_TOKEN_KEY;
});

/**
 * Stub the plugin's buildProvider to return a synthetic OAuthProvider so
 * the wizard exercises the OAuthProviderRuntime path end-to-end without
 * any real plugin code or network. Patches Node's require cache for the
 * given module path.
 */
function stubPluginBuildProvider(
  pluginRelPath: string,
  providerSpec: {
    id: string;
    displayName: string;
    defaultModels: string[];
    loginResult: any;
  },
): () => void {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const absPath = path.resolve(repoRoot, pluginRelPath);
  // Pre-load + stash original.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const original = require(absPath);
  const stubbed = {
    ...original,
    buildProvider: () => ({
      id: providerSpec.id,
      displayName: providerSpec.displayName,
      defaultModels: providerSpec.defaultModels,
      async login() {
        return providerSpec.loginResult;
      },
      async refresh() {
        return providerSpec.loginResult;
      },
      describeRuntime() {
        return { apiMode: 'anthropic_messages', baseUrl: 'http://stub' };
      },
    }),
  };
  // Patch the cache.
  require.cache[require.resolve(absPath)]!.exports = stubbed;
  return () => {
    require.cache[require.resolve(absPath)]!.exports = original;
  };
}

function fakePrompts(answers: {
  providerIndex?: number;
  confirm?: boolean;
  pasteCode?: string;
}) {
  return {
    async choose(_q: string, _choices: string[]) {
      return answers.providerIndex ?? 1;
    },
    async input(_q: string, _opts?: any) {
      return answers.pasteCode ?? '';
    },
    async confirm(_q: string, def?: boolean) {
      return answers.confirm ?? def ?? false;
    },
  };
}

/**
 * Phase 30.2.1: scripted prompts for OAuth-decline / OAuth-fail tests.
 * The wizard now loops back to provider pick on these paths instead of
 * returning oauth-skipped/oauth-failed, so tests need a queue to feed
 * a follow-up "pick a different provider" answer that terminates the
 * outer loop deterministically.
 */
function scriptedPrompts(answers: {
  choose: number[];
  input?: string[];
  confirm?: boolean[];
}) {
  const choose = [...answers.choose];
  const input = [...(answers.input ?? [])];
  const confirm = [...(answers.confirm ?? [])];
  return {
    async choose(_q: string, _choices: string[]) {
      if (choose.length === 0) throw new Error('scriptedPrompts.choose: queue empty');
      return choose.shift()!;
    },
    async input(_q: string, _opts?: any) {
      return input.shift() ?? '';
    },
    async confirm(_q: string, _def?: boolean) {
      return confirm.shift() ?? false;
    },
  };
}

const claudeProIdx = PROVIDERS.findIndex((p) => p.id === 'claude-pro') + 1;
const chatgptPlusIdx = PROVIDERS.findIndex((p) => p.id === 'chatgpt-plus') + 1;
const ollamaIdx = PROVIDERS.findIndex((p) => p.id === 'ollama') + 1;

describe('setup wizard — OAuth provider integration (kind: pro)', () => {
  it('44. user picks claude-pro → confirm → login → tokens persisted + config written', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);

    const restore = stubPluginBuildProvider(
      'plugins/aiden-plugin-claude-pro/index.js',
      {
        id: 'claude-pro',
        displayName: 'Claude Pro / Max',
        defaultModels: ['claude-opus-4-7', 'claude-sonnet-4-6'],
        loginResult: {
          accessToken: 'fresh-AT',
          refreshToken: 'fresh-RT',
          expiresInSeconds: 3600,
          extras: { account: 'shiva@example.com' },
        },
      },
    );

    try {
      const display = new Display();
      const result = await runSetupWizard({
        paths,
        display,
        // Phase 30.2.1: claude-pro moved to index [9] in the reordered list.
        prompts: fakePrompts({ providerIndex: claudeProIdx, confirm: true }),
        skipValidation: true,
      });

      expect(result.status).toBe('configured');
      expect(result.ran).toBe(true);
      expect(result.config?.model.provider).toBe('claude-pro');
      expect(result.config?.providers?.['claude-pro']).toEqual({
        auth: 'oauth',
      });

      // tokens.json was written through tokenStore.
      const tokens = await loadTokens(paths, 'claude-pro');
      expect(tokens?.accessToken).toBe('fresh-AT');
      expect(tokens?.refreshToken).toBe('fresh-RT');
      expect(tokens?.account).toBe('shiva@example.com');
    } finally {
      restore();
    }
  });

  it('45. user picks claude-pro → declines confirm → wizard loops back to provider pick (Phase 30.2.1)', async () => {
    // Phase 30.2.1 — the prior `oauth-skipped` skipReason was replaced
    // with `continue outer`, so a confirm-decline now loops back to the
    // provider picker. We script a follow-up Ollama pick (probe stubbed
    // ok) to terminate the loop with status='configured'. The key
    // assertion is "no tokens persisted for claude-pro".
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);

    const restore = stubPluginBuildProvider(
      'plugins/aiden-plugin-claude-pro/index.js',
      {
        id: 'claude-pro',
        displayName: 'Claude Pro / Max',
        defaultModels: ['claude-opus-4-7'],
        loginResult: {
          accessToken: 'should-never-persist',
          refreshToken: null,
          expiresInSeconds: 0,
        },
      },
    );

    try {
      const fetchImpl = (async () => ({ ok: true } as Response)) as unknown as typeof fetch;
      const result = await runSetupWizard({
        paths,
        display: new Display(),
        prompts: scriptedPrompts({
          choose: [claudeProIdx, ollamaIdx],
          confirm: [false],
          input: ['llama3.1:8b'],
        }),
        fetchImpl,
        skipValidation: true,
      });
      // Loop ended on Ollama which configures successfully.
      expect(result.status).toBe('configured');
      expect(result.config?.model.provider).toBe('ollama');
      // Critical: claude-pro tokens were NOT persisted because the user
      // declined the OAuth confirm.
      expect(await loadTokens(paths, 'claude-pro')).toBeNull();
    } finally {
      restore();
    }
  });

  it('46. user picks chatgpt-plus → device-code login → config + tokens persisted', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);

    const restore = stubPluginBuildProvider(
      'plugins/aiden-plugin-chatgpt-plus/index.js',
      {
        id: 'chatgpt-plus',
        displayName: 'ChatGPT Plus',
        defaultModels: ['gpt-5'],
        loginResult: {
          accessToken: 'gpt-AT',
          refreshToken: 'gpt-RT',
          expiresInSeconds: 7200,
          extras: { email: 'user@example.com' },
        },
      },
    );

    try {
      const result = await runSetupWizard({
        paths,
        display: new Display(),
        // Phase 30.2.1: chatgpt-plus moved to index [10] in the reordered list.
        prompts: fakePrompts({ providerIndex: chatgptPlusIdx, confirm: true }),
        skipValidation: true,
      });
      expect(result.status).toBe('configured');
      expect(result.config?.model.provider).toBe('chatgpt-plus');
      const tokens = await loadTokens(paths, 'chatgpt-plus');
      expect(tokens?.accessToken).toBe('gpt-AT');
      expect(tokens?.account).toBe('user@example.com');
    } finally {
      restore();
    }
  });

  it('47. login throws → wizard loops back to provider pick (Phase 30.2.1)', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);

    const restore = stubPluginBuildProvider(
      'plugins/aiden-plugin-claude-pro/index.js',
      {
        id: 'claude-pro',
        displayName: 'Claude Pro / Max',
        defaultModels: ['claude-opus-4-7'],
        loginResult: null as any,
      },
    );
    // Replace the buildProvider's login() to throw.
    require.cache[
      require.resolve(path.resolve(__dirname, '..', '..', '..', 'plugins/aiden-plugin-claude-pro/index.js'))
    ]!.exports.buildProvider = () => ({
      id: 'claude-pro',
      displayName: 'Claude Pro / Max',
      defaultModels: ['claude-opus-4-7'],
      async login() {
        throw new Error('Token exchange failed: HTTP 400');
      },
      async refresh() {
        throw new Error('not used');
      },
      describeRuntime() {
        return { apiMode: 'anthropic_messages' as const };
      },
    });

    try {
      const fetchImpl = (async () => ({ ok: true } as Response)) as unknown as typeof fetch;
      const result = await runSetupWizard({
        paths,
        display: new Display(),
        // Phase 30.2.1: login throws → continue outer → second pick is
        // Ollama which terminates the loop with status='configured'.
        // claude-pro tokens must remain unpersisted.
        prompts: scriptedPrompts({
          choose: [claudeProIdx, ollamaIdx],
          confirm: [true /* user wants to proceed; login then throws */],
          input: ['llama3.1:8b'],
        }),
        fetchImpl,
        skipValidation: true,
      });
      expect(result.status).toBe('configured');
      expect(result.config?.model.provider).toBe('ollama');
      expect(await loadTokens(paths, 'claude-pro')).toBeNull();
    } finally {
      restore();
    }
  });
});
