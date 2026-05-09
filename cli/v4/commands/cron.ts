/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/cron.ts — Phase 24.1b
 *
 * `/cron [add|list|run|show|logs|enable|disable|remove] ...`
 *
 * Subcommand surface:
 *   add <name> <schedule> <command>  — create a job
 *   list                             — table of jobs
 *   run <id|name>                    — fire immediately
 *   show <id|name>                   — full detail incl. last output
 *   logs <id|name>                   — tail last 100 lines of run log
 *   enable / disable <id|name>       — toggle without deleting
 *   remove <id|name>                 — confirm + delete
 *
 * Quoting: the registry's tokenizer is whitespace-only, so this command
 * re-parses ctx.rawArgs to honour double-quoted strings (necessary
 * because schedules and commands routinely contain spaces, e.g.
 * `/cron add brief "0 9 * * *" "give me NSE top movers"`).
 */

import { promises as fsp } from 'node:fs';
import * as fs   from 'node:fs';
import * as path from 'node:path';
import * as os   from 'node:os';

import type { SlashCommand, SlashCommandContext } from '../commandRegistry';
import { renderTable } from '../table';
import {
  createJob, listJobs, getJob,
  pauseJob, resumeJob, deleteJob, triggerJob,
  awaitPendingSaves,
  getDiagnostics,
  AIDEN_CRON_BUILD,
  type CronJob,
} from '../../../core/cronManager';

const NAME_RE      = /^[A-Za-z0-9_-]+$/;
const LOGS_DIR     = path.join(os.homedir(), '.aiden', 'cron-logs');
const TAIL_LINES   = 100;

// ── Quote-aware arg tokenizer ──────────────────────────────────────────────
//
// Splits on whitespace but treats `"..."` (and `'...'`) as a single token
// so schedules and commands keep their internal spaces.

export function tokenize(raw: string): string[] {
  const out: string[] = [];
  const s = raw ?? '';
  let cur  = '';
  let inDQ = false;
  let inSQ = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' && !inSQ) { inDQ = !inDQ; continue; }
    if (ch === "'" && !inDQ) { inSQ = !inSQ; continue; }
    if (!inDQ && !inSQ && /\s/.test(ch)) {
      if (cur.length > 0) { out.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

// ── Resolve id-prefix or exact name ────────────────────────────────────────

export function resolveJob(ref: string): CronJob | null {
  if (!ref) return null;
  const all = listJobs();
  // Exact id wins.
  const exactId = all.find(j => j.id === ref);
  if (exactId) return exactId;
  // Exact name (description).
  const exactName = all.find(j => j.description === ref);
  if (exactName) return exactName;
  // Unique prefix on id.
  const idPref = all.filter(j => j.id.startsWith(ref));
  if (idPref.length === 1) return idPref[0];
  return null;
}

// ── Rendering ──────────────────────────────────────────────────────────────

function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}

function colourResult(
  ctx: SlashCommandContext,
  result?: 'ok' | 'fail' | 'warn' | 'error' | 'timeout' | null,
): string {
  if (result === 'ok')      return '✓';
  if (result === 'warn')    return '∼';
  if (result === 'fail'
   || result === 'error'
   || result === 'timeout') return '✗';
  return '·';
}

function fmtTime(iso?: string): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toISOString().replace('T', ' ').slice(0, 16);
}

// ── Subcommand handlers ────────────────────────────────────────────────────

async function cmdAdd(ctx: SlashCommandContext, args: string[]): Promise<void> {
  if (args.length < 3) {
    ctx.display.printError('Usage: /cron add <name> <schedule> <command>');
    return;
  }
  const [name, schedule, ...rest] = args;
  const command = rest.join(' ');

  if (!NAME_RE.test(name)) {
    ctx.display.printError(
      `Invalid name "${name}". Use alphanumeric, dash, or underscore only.`,
    );
    return;
  }
  if (!command) {
    ctx.display.printError('Command is required.');
    return;
  }
  if (resolveJob(name)) {
    ctx.display.printError(`A job named "${name}" already exists.`);
    return;
  }

  try {
    const job = createJob(name, schedule, command);
    ctx.display.success(
      `Created [${shortId(job.id)}] ${job.description} — ${job.schedule}`,
    );
    if (job.nextRun) ctx.display.dim(`next run: ${fmtTime(job.nextRun)}`);
  } catch (e: any) {
    ctx.display.printError(`Could not create job: ${e?.message ?? e}`);
  }
}

function cmdList(ctx: SlashCommandContext): void {
  const jobs = listJobs();
  if (jobs.length === 0) {
    ctx.display.dim('No cron jobs. Use /cron add <name> <schedule> <command>.');
    return;
  }
  const rows = jobs.map(j => ({
    id:        shortId(j.id),
    name:      j.description || '(unnamed)',
    schedule:  j.schedule,
    enabled:   j.enabled ? 'on' : 'off',
    lastRun:   fmtTime(j.lastRun),
    result:    j.lastResult ?? '—',
  }));
  ctx.display.write(
    renderTable(rows, [
      { key: 'id',       header: 'ID',       align: 'left'  },
      { key: 'name',     header: 'Name',     align: 'left', flex: true },
      { key: 'schedule', header: 'Schedule', align: 'left'  },
      { key: 'enabled',  header: 'En',       align: 'center',
        color: (v) => (v === 'on' ? 'success' : 'muted') },
      { key: 'lastRun',  header: 'Last Run', align: 'left'  },
      { key: 'result',   header: 'R',        align: 'center',
        color: (v) => (v === 'ok' ? 'success' : v === 'fail' ? 'error' : 'muted') },
    ]),
  );
}

async function cmdRun(ctx: SlashCommandContext, args: string[]): Promise<void> {
  const job = resolveJob(args[0] ?? '');
  if (!job) { ctx.display.printError(`Job not found: ${args[0] ?? '(missing)'}`); return; }
  ctx.display.info(`Triggering [${shortId(job.id)}] ${job.description}…`);
  const ok = await triggerJob(job.id);
  if (!ok) { ctx.display.printError('Trigger failed.'); return; }
  const fresh = getJob(job.id);
  if (fresh?.lastResult === 'ok') ctx.display.success(`Done (${fmtTime(fresh.lastRun)}).`);
  else                            ctx.display.warn(`Finished with errors (${fmtTime(fresh?.lastRun)}).`);
  if (fresh?.lastOutput) {
    ctx.display.dim('--- output ---');
    ctx.display.write(fresh.lastOutput.replace(/\n?$/, '\n'));
  }
}

function cmdShow(ctx: SlashCommandContext, args: string[]): void {
  const job = resolveJob(args[0] ?? '');
  if (!job) { ctx.display.printError(`Job not found: ${args[0] ?? '(missing)'}`); return; }
  ctx.display.info(`${job.description} [${job.id}]`);
  ctx.display.write(`schedule    : ${job.schedule}\n`);
  ctx.display.write(`kind        : ${job.kind}\n`);
  ctx.display.write(`command     : ${job.action}\n`);
  ctx.display.write(`enabled     : ${job.enabled ? 'yes' : 'no'}\n`);
  ctx.display.write(`runs        : ${job.runCount}\n`);
  ctx.display.write(`last run    : ${fmtTime(job.lastRun)}\n`);
  ctx.display.write(`last result : ${job.lastResult ?? '—'}\n`);
  ctx.display.write(`next run    : ${fmtTime(job.nextRun)}\n`);
  if (job.lastOutput) {
    ctx.display.dim('--- last output ---');
    ctx.display.write(job.lastOutput.replace(/\n?$/, '\n'));
  }
}

async function cmdLogs(ctx: SlashCommandContext, args: string[]): Promise<void> {
  const job = resolveJob(args[0] ?? '');
  if (!job) { ctx.display.printError(`Job not found: ${args[0] ?? '(missing)'}`); return; }
  const logPath = path.join(LOGS_DIR, `${job.id}.log`);
  if (!fs.existsSync(logPath)) {
    ctx.display.dim(`No log yet for ${job.description} (${shortId(job.id)}).`);
    return;
  }
  const text  = await fsp.readFile(logPath, 'utf8');
  const lines = text.split(/\r?\n/);
  const tail  = lines.slice(Math.max(0, lines.length - TAIL_LINES - 1));
  ctx.display.dim(`--- ${logPath} (last ${tail.length} lines) ---`);
  ctx.display.write(tail.join('\n') + '\n');
}

function cmdEnable(ctx: SlashCommandContext, args: string[]): void {
  const job = resolveJob(args[0] ?? '');
  if (!job) { ctx.display.printError(`Job not found: ${args[0] ?? '(missing)'}`); return; }
  if (resumeJob(job.id)) ctx.display.success(`Enabled ${job.description}.`);
  else                   ctx.display.printError('Enable failed.');
}

function cmdDisable(ctx: SlashCommandContext, args: string[]): void {
  const job = resolveJob(args[0] ?? '');
  if (!job) { ctx.display.printError(`Job not found: ${args[0] ?? '(missing)'}`); return; }
  if (pauseJob(job.id)) ctx.display.success(`Disabled ${job.description}.`);
  else                  ctx.display.printError('Disable failed.');
}

async function cmdStatus(ctx: SlashCommandContext): Promise<void> {
  const diag = await getDiagnostics();
  ctx.display.info(`Aiden cron — ${AIDEN_CRON_BUILD}`);
  ctx.display.write(`  schema version : ${diag.schemaVersion}\n`);
  ctx.display.write(`  tick interval  : ${diag.tickMs}ms\n`);
  ctx.display.write(`  fire timeout   : ${diag.timeoutMs}ms\n`);
  ctx.display.write(`  heartbeat      : ${diag.heartbeatActive ? 'active' : 'idle'}\n`);
  ctx.display.write(`  last heartbeat : ${diag.lastHeartbeatAt ?? 'never'}\n`);
  ctx.display.write(`  skipped ticks  : ${diag.skippedTicks}\n`);
  ctx.display.write(`  fires (boot)   : ${diag.firesStarted}\n`);
  ctx.display.write(`  lock           : ${diag.lock.held ? 'held' : 'free'} (${diag.lock.path})\n`);
  if (diag.recentFires.length > 0) {
    ctx.display.write(`  recent fires:\n`);
    for (const r of diag.recentFires) {
      const tag = r.status === 'ok' ? '✓'
                : r.status === 'warn' ? '∼'
                : r.status === 'timeout' ? 'T'
                : '✗';
      ctx.display.write(
        `    ${tag} [${r.jobId.slice(0, 8)}]  ${fmtTime(r.startedAt)}  ${r.durationMs}ms` +
        `${r.error ? '  ' + r.error.slice(0, 60) : ''}\n`,
      );
    }
  }
}

async function cmdRemove(ctx: SlashCommandContext, args: string[]): Promise<void> {
  const job = resolveJob(args[0] ?? '');
  if (!job) { ctx.display.printError(`Job not found: ${args[0] ?? '(missing)'}`); return; }
  // Confirmation: prefer ctx.prompt so we own the y/N parsing — that way
  // typing the job's id (or anything other than y/yes) is unambiguously
  // treated as cancel. If neither prompt nor confirm is wired we refuse the
  // destructive op rather than surprise-deleting.
  const question = `Delete cron job "${job.description}" [${shortId(job.id)}]? (y/N) `;
  let ok = false;
  if (ctx.prompt) {
    const answer = (await ctx.prompt(question)).trim();
    ok = /^(y|yes)$/i.test(answer);
  } else if (ctx.confirm) {
    ok = await ctx.confirm(question);
  }
  if (!ok) { ctx.display.dim('Cancelled.'); return; }
  if (deleteJob(job.id)) {
    await awaitPendingSaves();
    ctx.display.success(`Removed ${job.description}.`);
  } else {
    ctx.display.printError('Remove failed.');
  }
}

// ── SlashCommand definition ────────────────────────────────────────────────

export const cron: SlashCommand = {
  name: 'cron',
  description: 'Manage scheduled jobs (add, list, run, logs, enable/disable, remove).',
  category: 'system',
  icon: '⏰',
  handler: async (ctx) => {
    const tokens = tokenize(ctx.rawArgs);
    const sub    = (tokens[0] ?? 'list').toLowerCase();
    const rest   = tokens.slice(1);

    switch (sub) {
      case 'add':                 await cmdAdd    (ctx, rest); break;
      case 'list':  case 'ls':    cmdList         (ctx);       break;
      case 'run':   case 'trigger': await cmdRun  (ctx, rest); break;
      case 'show':  case 'info':  cmdShow         (ctx, rest); break;
      case 'status':              await cmdStatus (ctx);       break;
      case 'logs':  case 'log':   await cmdLogs   (ctx, rest); break;
      case 'enable':              cmdEnable       (ctx, rest); break;
      case 'disable': case 'pause': cmdDisable    (ctx, rest); break;
      case 'remove':  case 'rm': case 'delete':
                                  await cmdRemove (ctx, rest); break;
      case 'help':
      case '?':
        ctx.display.info('/cron usage:');
        ctx.display.write('  /cron add <name> <schedule> <command>\n');
        ctx.display.write('  /cron list\n');
        ctx.display.write('  /cron run <id|name>\n');
        ctx.display.write('  /cron show <id|name>\n');
        ctx.display.write('  /cron logs <id|name>\n');
        ctx.display.write('  /cron enable|disable <id|name>\n');
        ctx.display.write('  /cron remove <id|name>\n');
        ctx.display.write('  /cron status                  (v4.1-cron diagnostics)\n');
        ctx.display.dim('Schedules: cron expr ("0 9 * * *"), interval ("every 2m"), one-shot ISO.');
        break;
      default:
        ctx.display.printError(`Unknown subcommand: ${sub}. Try /cron help.`);
    }
  },
};
