/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/mcp.ts — Phase v4.1-mcp
 *
 * `aiden mcp <action>` subcommand. Three actions:
 *
 *   serve   — spawn the MCP stdio server. Blocks until parent closes
 *             stdio (this is the canonical Claude Desktop /
 *             Cursor / Claude Code lifecycle).
 *   status  — print build fingerprint, exposed tool/skill counts, and
 *             current env config. Quick sanity check before pointing
 *             a client at the binary.
 *   tools   — list every exposed tool name + category. Useful when the
 *             user wants to know what their allowlist currently maps
 *             to before they save the client config.
 *
 * `serve` runs in a deliberately stripped-down runtime: tools,
 * skill loader, sessions, memory, processes — but NO provider /
 * adapter / agent loop. The MCP protocol IS the agent loop here; the
 * spawning client owns the model. This keeps `aiden mcp serve`
 * startable on a freshly-installed Aiden with zero provider keys.
 *
 * Phase-9 approval engine is intentionally NOT wired. The bridge
 * env-gate (`AIDEN_MCP_ALLOW_DESTRUCTIVE`) is the consent layer when
 * there's no human at the REPL. The bridge filter blocks mutating
 * tools by default; opting in means the user accepted server-side
 * execution risk at config time.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { resolveAidenPaths, ensureAidenDirsExist } from '../../../core/v4/paths';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { SkillLoader } from '../../../core/v4/skillLoader';
import { SessionStore } from '../../../core/v4/sessionStore';
import { SessionManager } from '../../../core/v4/sessionManager';
import { MemoryManager } from '../../../core/v4/memoryManager';
import { ProcessRegistry } from '../../../core/v4/processRegistry';
import { ConfigManager } from '../../../core/v4/config';
import {
  FallbackAdapter,
  buildDefaultSlots,
  type ProviderSlot,
} from '../../../core/v4/providerFallback';
import { ChatCompletionsAdapter } from '../../../providers/v4/chatCompletionsAdapter';
import { AidenAgent } from '../../../core/v4/aidenAgent';
import { createBootLogger } from '../../../core/v4/logger/factory';
import { registerAllTools, makeSubagentFanoutTool } from '../../../tools/v4/index';
import {
  loadMcpEnvSources,
  describeProviderKeys,
  KNOWN_PROVIDER_KEYS,
  type McpEnvLoadReport,
} from '../envSources';
import { CredentialResolver } from '../../../providers/v4/credentialResolver';
import { RuntimeResolver } from '../../../providers/v4/runtimeResolver';
import type { ProviderAdapter, Message as ProviderMessage } from '../../../providers/v4/types';
import type { ProviderOption } from '../../../core/v4/subagent/providerRotation';
import type { RunChildArgs } from '../../../core/v4/subagent/fanout';

import {
  startStdioMcpServer,
  AIDEN_MCP_BUILD,
} from '../../../core/v4/mcp/server/stdioServer';
import {
  collectMcpDiagnostics,
} from '../../../core/v4/mcp/server/diagnostics';
import {
  buildToolsList,
  readToolBridgeEnv,
} from '../../../core/v4/mcp/server/toolBridge';

export interface RunMcpOptions {
  /** Override stdout writer for tests / hooks. Status + tools subcommands
   *  use this; serve writes nothing to stdout (protocol channel). */
  writeOut?: (text: string) => void;
  /** Override stderr writer for tests. */
  writeErr?: (text: string) => void;
  /** Override paths root for tests. */
  pathsOverride?: ReturnType<typeof resolveAidenPaths>;
}

/** Build the slim runtime an MCP server needs. Tools + skills + the
 *  subsystems they consume — no provider, no agent. */
async function buildMcpRuntime(opts: RunMcpOptions = {}) {
  const paths = opts.pathsOverride ?? resolveAidenPaths();
  await ensureAidenDirsExist(paths);

  // ── Phase v4.1-mcp.2 — eager .env load ───────────────────────
  // Stdio MCP clients (Claude Desktop, Cursor) spawn `aiden mcp
  // serve` with an EMPTY env block by default. Without an explicit
  // `env: {...}` per-server entry in their config, our spawned
  // process has no GROQ_API_KEY etc., and any provider-using tool
  // (subagent_fanout, web_search, fetch_url, …) fails. Load the
  // well-known .env locations BEFORE the registry is built so tool
  // factories that read env at registration time see live values.
  // Fill-only — process.env wins, file values fill gaps.
  const envReport: McpEnvLoadReport = loadMcpEnvSources({
    aidenHomeEnv: paths.envFile,
  });

  // mcp-stdio mode: file sink + stderr only. Crucial: this MUST happen
  // before any module emits via console.* — but we don't use console in
  // this module, and mcp-stdio mode + the no-stdout-sink invariant in
  // factory.ts guarantee the protocol channel stays clean.
  const { logger } = createBootLogger({ mode: 'mcp-stdio', logsDir: paths.logsDir });

  // Log the env-load report. NEVER log values — only paths + key
  // NAMES. The mcp-stdio logger writes to file + stderr (zero stdout
  // sinks per v4.1-mcp), so spawning clients see this in their MCP
  // log stream and grep can confirm keys loaded.
  for (const a of envReport.attempts) {
    logger.info(
      `mcp env: ${a.exists ? 'loaded' : 'skipped (missing)'} ${a.path}`,
      {
        scope:    'mcp',
        path:     a.path,
        exists:   a.exists,
        applied:  a.appliedKeys.length,
        keyNames: a.appliedKeys,
      },
    );
  }

  const registry = new ToolRegistry();
  registerAllTools(registry);

  const skillLoader = new SkillLoader(paths);
  await skillLoader.loadAll().catch(() => undefined);

  const store = new SessionStore(paths.sessionsDb);
  const sessions = new SessionManager(store);

  const memory = new MemoryManager(paths);

  const processes = new ProcessRegistry();

  const toolContext = {
    cwd: process.cwd(),
    paths,
    sessions,
    memory,
    processes,
    skillLoader,
    // approvalEngine / ssrfProtection / tirithScanner / memoryGuard
    // intentionally omitted — see header comment.
  };

  // ── Phase v4.1-subagent.2 — wire real subagent_fanout factory ────
  //
  // Without this, the stub registered by `registerAllTools` (from
  // `registerReadOnlyTools`) returns "no providers configured" on
  // every MCP-side call because its `resolveProviders` is `() => []`.
  // The CLI path replaces the stub inside `buildAgentRuntime`; the
  // MCP path is a different runtime build, so it needs its own
  // replacement here.
  //
  // Provider resolution mirrors `buildAgentRuntime` but stripped:
  //   1. Read config.yaml when present; fall back to groq /
  //      llama-3.3-70b-versatile (the same default the CLI uses).
  //   2. RuntimeResolver constructs the active adapter.
  //   3. If providerId is groq/together (chat_completions with
  //      multi-slot fallback), wrap in FallbackAdapter so subagent
  //      rotation gets a real list of provider options.
  //
  // When credentials are missing, leave the stub in place — the
  // status command's "provider keys" block tells the user what to
  // fix. We never throw out of buildMcpRuntime; an unwired stub is
  // strictly better UX than a crashed MCP server.
  await wireSubagentFanout({
    registry,
    paths,
    sessionManager: sessions,
    memoryManager: memory,
    skillLoader,
    logger: logger.child('subagent'),
  });

  return { paths, registry, skillLoader, toolContext, logger };
}

/** Mirror of `buildAgentFallbackSlots` (cli/v4/aidenCLI.ts) inlined
 *  here to avoid a load-time module cycle between aidenCLI and mcp.ts.
 *  Wraps the resolver-resolved primary adapter as slot 0 and appends
 *  the env-var-derived defaults so multi-key Groq fanouts and
 *  Together failover work without a config-yaml round-trip. */
function buildMcpFallbackSlots(
  primary: ProviderAdapter,
  primaryProviderId: string,
  primaryModelId: string,
): ProviderSlot[] {
  const defaults = buildDefaultSlots({
    adapterFactory: (cfg) =>
      new ChatCompletionsAdapter({
        baseUrl:      cfg.baseUrl,
        apiKey:       cfg.apiKey,
        model:        cfg.model,
        providerName: cfg.providerName,
      }),
  });
  const primarySlot: ProviderSlot = {
    id:         'primary',
    providerId: primaryProviderId,
    modelId:    primaryModelId,
    keyPresent: true,
    keyTail:    null,
    build:      () => primary,
  };
  return [primarySlot, ...defaults];
}

interface WireOptions {
  registry: ToolRegistry;
  paths: ReturnType<typeof resolveAidenPaths>;
  sessionManager: SessionManager;
  memoryManager: MemoryManager;
  skillLoader: SkillLoader;
  logger: import('../../../core/v4/logger/logger').Logger;
}

/** Resolve adapter + wire `subagent_fanout` into the MCP registry.
 *  Soft-fails (logs + leaves stub) when credentials are missing. */
async function wireSubagentFanout(opts: WireOptions): Promise<void> {
  const config = new ConfigManager(opts.paths);
  try { await config.load(); } catch {
    // ENOENT → defaults. Other parse errors are logged but non-fatal.
    opts.logger.warn('config.yaml load failed; using defaults', { scope: 'mcp' });
  }

  const providerId = config.getValue<string>('model.provider', 'groq')!;
  const modelId    = config.getValue<string>('model.modelId', 'llama-3.3-70b-versatile')!;

  const credentialResolver = new CredentialResolver(opts.paths.authJson);
  const resolver           = new RuntimeResolver(credentialResolver);

  let adapter: ProviderAdapter;
  try {
    adapter = await resolver.resolve({ providerId, modelId, config, paths: opts.paths });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.logger.warn(
      'subagent_fanout NOT wired — provider resolution failed (run `aiden setup` or set keys in .env)',
      { scope: 'mcp', providerId, modelId, error: msg },
    );
    return;
  }

  // Wrap in FallbackAdapter when the active provider is one of the
  // chat-completions families with multi-slot fallback support.
  // Same pattern aidenCLI.ts uses (line ~562); slot construction is
  // inlined to avoid a module cycle between aidenCLI and mcp.ts.
  let wrapped: ProviderAdapter = adapter;
  if (adapter.apiMode === 'chat_completions'
      && (providerId === 'groq' || providerId === 'together')) {
    const slots = buildMcpFallbackSlots(adapter, providerId, modelId);
    const reachable = slots.filter((s) => s.keyPresent);
    if (reachable.length >= 2) {
      wrapped = new FallbackAdapter({
        apiMode: 'chat_completions',
        slots,
        onRateLimit: (slotId) => opts.logger.info(`slot ${slotId} rate-limited`, { scope: 'mcp' }),
      });
    }
  }

  const finalAdapter = wrapped;

  opts.registry.register(makeSubagentFanoutTool({
    logger: opts.logger,
    resolveActiveModel: () => ({ providerId, modelId }),
    aggregatorAdapter: finalAdapter,
    resolveProviders: (): ProviderOption[] => {
      if (finalAdapter instanceof FallbackAdapter) {
        const diag = finalAdapter.getDiagnostics();
        const live = diag.slots.filter((s) => s.keyPresent);
        if (live.length > 0) {
          return live.map((s) => ({
            providerId: s.providerId,
            modelId:    s.modelId,
            label:      s.id,
          }));
        }
      }
      return [{ providerId, modelId }];
    },
    runChild: async (childOpts: RunChildArgs): Promise<string> => {
      const childCtx = {
        cwd:           process.cwd(),
        paths:         opts.paths,
        sessions:      opts.sessionManager,
        memory:        opts.memoryManager,
        skillLoader:   opts.skillLoader,
        // approvalEngine intentionally undefined — N children
        // contending for one stdin REPL would deadlock under MCP.
      };

      // Filter the child tool surface — read-only by default; opt-in
      // via AIDEN_SUBAGENT_ALLOW_DESTRUCTIVE=1 (mirrors MCP env from
      // v4.1-mcp). Recursive fanout disallowed (depth=1).
      const allowDestructive =
        process.env.AIDEN_SUBAGENT_ALLOW_DESTRUCTIVE === '1' ||
        process.env.AIDEN_SUBAGENT_ALLOW_DESTRUCTIVE === 'true';
      const childToolNames: string[] = [];
      for (const name of opts.registry.list()) {
        const h = opts.registry.get(name);
        if (!h) continue;
        if (h.mutates && !allowDestructive) continue;
        if (name === 'subagent_fanout') continue;
        childToolNames.push(name);
      }
      const childExecutor = opts.registry.buildExecutor(childCtx);
      const childTools = childToolNames
        .map((n) => opts.registry.get(n)?.schema)
        .filter((s): s is NonNullable<typeof s> => !!s);

      // Per-child cloned FallbackAdapter — own rate-limit state.
      const childProvider = finalAdapter instanceof FallbackAdapter
        ? finalAdapter.clone()
        : finalAdapter;

      const child = new AidenAgent({
        provider:     childProvider,
        tools:        childTools,
        toolExecutor: childExecutor,
        maxTurns:     childOpts.maxIterations,
        providerId:   childOpts.provider.providerId,
        modelId:      childOpts.provider.modelId,
        // No promptBuilder — children get a brief system prompt
        // (same lesson as v4.1-subagent.1: full SOUL.md makes
        // trivial fanouts spend 30s+ on verbose self-introductions).
      });

      if (childOpts.signal.aborted) {
        throw new Error('aborted before dispatch');
      }
      const roleLine = childOpts.role ? `Role: ${childOpts.role}. ` : '';
      const childSystemPrompt =
        `You are one of N parallel subagents. ${roleLine}` +
        `Answer the user's request concisely. Use available tools when ` +
        `the answer requires real-world information you don't have memorized.`;
      const history: ProviderMessage[] = [
        { role: 'system', content: childSystemPrompt },
        { role: 'user',   content: childOpts.prompt },
      ];
      const result = await child.runConversation(history);
      return result.finalContent;
    },
  }));
  opts.logger.info('subagent_fanout: wired (replaces stub) [mcp serve]', {
    providerId,
    modelId,
    fallback: finalAdapter instanceof FallbackAdapter ? 'FallbackAdapter' : 'direct',
  });
}

export async function runMcpSubcommand(
  action: string,
  opts: RunMcpOptions = {},
): Promise<number> {
  const writeOut = opts.writeOut ?? ((t: string) => process.stdout.write(t));
  const writeErr = opts.writeErr ?? ((t: string) => process.stderr.write(t));

  switch (action) {
    case 'serve': {
      const { registry, skillLoader, toolContext, logger } =
        await buildMcpRuntime(opts);

      await startStdioMcpServer({
        registry,
        skillLoader,
        toolContext,
        logger,
      });

      // Block forever — parent closes stdio when the client disconnects,
      // which tears down the SDK transport and unwinds the process.
      await new Promise<void>(() => undefined);
      return 0;
    }

    case 'status': {
      const { registry, skillLoader } = await buildMcpRuntime(opts);
      const diag = await collectMcpDiagnostics(registry, skillLoader);
      writeOut(`Aiden MCP server\n`);
      writeOut(`  build:           ${diag.build}\n`);
      writeOut(`  tools (total):   ${diag.toolsTotal}\n`);
      writeOut(`  tools (exposed): ${diag.toolsExposed}\n`);
      writeOut(`  skills:          ${diag.skillsTotal}\n`);
      writeOut(`  allowDestructive: ${diag.env.allowDestructive ? 'yes' : 'no'}\n`);
      writeOut(
        `  allowlist:       ${
          diag.env.allowlist
            ? diag.env.allowlist.join(', ') || '(empty)'
            : '(unset — all)'
        }\n`,
      );

      // Phase v4.1-mcp.2 — provider key presence + source. NEVER log
      // values; only the source tag (preset / aiden-env / unset).
      writeOut(`  provider keys:\n`);
      const keys = describeProviderKeys();
      const present = keys.filter((k) => k.present).length;
      writeOut(`    detected:      ${present}/${keys.length}\n`);
      for (const k of keys) {
        const tag = k.present ? '✓' : '✗';
        // Lower-case the key for display: "GROQ_API_KEY" → "groq".
        const label = k.key.replace(/_API_KEY$/, '').toLowerCase();
        const src = k.present
          ? (k.source === 'aiden-env' ? '(.env)' : '(preset)')
          : '(unset)';
        writeOut(`    ${tag} ${label.padEnd(12)} ${src}\n`);
      }
      return 0;
    }

    case 'tools': {
      const { registry } = await buildMcpRuntime(opts);
      const env = readToolBridgeEnv();
      const list = buildToolsList(registry, env);
      writeOut(`Aiden MCP — exposed tools (${list.length})\n`);
      for (const tool of list) {
        const handler = registry.get(tool.name);
        const cat = handler?.category ?? '?';
        const set = handler?.toolset ?? '-';
        writeOut(`  ${tool.name.padEnd(28)}  ${cat.padEnd(8)}  [${set}]\n`);
      }
      return 0;
    }

    default: {
      writeErr(`Unknown 'aiden mcp' action: ${action}\n`);
      writeErr(`Actions: serve | status | tools\n`);
      return 1;
    }
  }
}

export { AIDEN_MCP_BUILD };
