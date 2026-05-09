/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/cronCli.ts — Phase v4.1-cron
 *
 * `aiden cron <action>` top-level CLI subcommand. Three actions:
 *
 *   status      — print build fingerprint, tick + lock state,
 *                 last 5 fires (boot-local). No mutation.
 *   list        — table of jobs (id, schedule, enabled, next run).
 *   run <id>    — fire a job immediately. Useful for scripted
 *                 "trigger this scheduled task now" flows from
 *                 a shell.
 *
 * Distinct from the `/cron` slash command (which mutates session
 * state from inside the REPL). This subcommand is for scripting +
 * sanity-checking from a non-interactive shell.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  loadJobs,
  listJobsAsync,
  triggerJob,
  getDiagnostics,
  AIDEN_CRON_BUILD,
} from '../../core/cronManager';

export interface RunCronOptions {
  writeOut?: (text: string) => void;
  writeErr?: (text: string) => void;
}

export async function runCronSubcommand(
  action: string,
  args: string[],
  opts: RunCronOptions = {},
): Promise<number> {
  const writeOut = opts.writeOut ?? ((t: string) => process.stdout.write(t));
  const writeErr = opts.writeErr ?? ((t: string) => process.stderr.write(t));

  switch (action) {
    case 'status': {
      // Booting may armed timers we don't need for status — but it
      // also populates the cache. Skip arming side-effect by NOT
      // calling loadJobs; getDiagnostics works without the cache.
      const diag = await getDiagnostics();
      writeOut(`Aiden cron — ${AIDEN_CRON_BUILD}\n`);
      writeOut(`  schema version : ${diag.schemaVersion}\n`);
      writeOut(`  tick interval  : ${diag.tickMs}ms\n`);
      writeOut(`  fire timeout   : ${diag.timeoutMs}ms\n`);
      writeOut(`  heartbeat      : ${diag.heartbeatActive ? 'active' : 'idle'}\n`);
      writeOut(`  last heartbeat : ${diag.lastHeartbeatAt ?? 'never'}\n`);
      writeOut(`  skipped ticks  : ${diag.skippedTicks}\n`);
      writeOut(`  fires (boot)   : ${diag.firesStarted}\n`);
      writeOut(`  lock           : ${diag.lock.held ? 'held' : 'free'}\n`);
      writeOut(`  lock path      : ${diag.lock.path}\n`);
      if (diag.recentFires.length > 0) {
        writeOut(`  recent fires:\n`);
        for (const r of diag.recentFires) {
          const tag = r.status === 'ok' ? '✓'
                    : r.status === 'warn' ? '∼'
                    : r.status === 'timeout' ? 'T'
                    : '✗';
          writeOut(
            `    ${tag} [${r.jobId.slice(0, 8)}]  ${r.startedAt}  ${r.durationMs}ms` +
            `${r.error ? '  ' + r.error.slice(0, 60) : ''}\n`,
          );
        }
      }
      return 0;
    }

    case 'list': {
      const jobs = await listJobsAsync();
      if (jobs.length === 0) {
        writeOut(`No cron jobs configured.\n`);
        return 0;
      }
      writeOut(`Aiden cron — ${jobs.length} job(s)\n`);
      writeOut(`  ID    NAME                            SCHEDULE                          STATE       NEXT RUN\n`);
      for (const j of jobs) {
        const id      = j.id.padEnd(5).slice(0, 5);
        const name    = (j.description || '(unnamed)').padEnd(31).slice(0, 31);
        const sched   = (j.schedule    || '?').padEnd(33).slice(0, 33);
        const stateLabel = j.state.padEnd(11).slice(0, 11);
        const next    = j.nextRun ?? 'never';
        writeOut(`  ${id} ${name} ${sched} ${stateLabel} ${next}\n`);
      }
      return 0;
    }

    case 'run': {
      const id = args[0];
      if (!id) {
        writeErr(`Usage: aiden cron run <id>\n`);
        return 1;
      }
      // loadJobs populates the cache + arms timers. The trigger is
      // what we actually want; arming is side-effect.
      await loadJobs();
      const ok = await triggerJob(id);
      if (!ok) {
        writeErr(`Job not found: ${id}\n`);
        return 1;
      }
      writeOut(`Triggered job ${id}.\n`);
      return 0;
    }

    default: {
      writeErr(`Unknown 'aiden cron' action: ${action}\n`);
      writeErr(`Actions: status | list | run <id>\n`);
      return 1;
    }
  }
}

export { AIDEN_CRON_BUILD };
