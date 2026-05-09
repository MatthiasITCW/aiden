/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/voice.ts — Phase v4.1-voice-cli
 *
 * `/voice` slash command. Subcommands:
 *
 *   /voice on            — enable voice mode for this session
 *   /voice off           — disable
 *   /voice toggle        — flip on/off
 *   /voice status        — show fingerprint + backend + provider availability
 *   /voice mode push     — switch to push-to-talk (default)
 *   /voice mode continuous — switch to continuous (VAD-driven)
 *   /voice provider <name> — pin TTS provider (edge | sapi | elevenlabs | voxcpm)
 *   /voice voice <id>    — pin TTS voice (default: en-US-AriaNeural)
 *
 * Persistence: writes to the user's `.aiden/.env` via `upsertEnvVar`
 * so settings survive REPL restarts. Mirrors the channel slash
 * command's atomic .env mutation pattern.
 *
 * State surfaces via `process.env` keys:
 *   AIDEN_VOICE_ENABLED   — "1" / "0"
 *   AIDEN_VOICE_MODE      — "push-to-talk" / "continuous"
 *   AIDEN_VOICE_TTS_VOICE — voice id
 *   AIDEN_VOICE_PROVIDER  — provider override
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { SlashCommand, SlashCommandHandler } from '../commandRegistry';
import {
  collectVoiceDiagnostics,
  AIDEN_VOICE_CLI_BUILD,
} from '../../../core/v4/voice/diagnostics';

// .env upsert (atomic) — mirrors the channel slash command's
// pattern. Local to this file so the import surface stays tight.

async function upsertEnvVar(envFile: string, key: string, value: string): Promise<void> {
  const k = key.toUpperCase();
  let body = '';
  try { body = await fs.readFile(envFile, 'utf8'); } catch { /* fresh file */ }
  const lines = body.split(/\r?\n/);
  let replaced = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith(`${k}=`)) {
      lines[i] = `${k}=${value}`;
      replaced = true;
    }
  }
  if (!replaced) lines.push(`${k}=${value}`);
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  await fs.mkdir(path.dirname(envFile), { recursive: true });
  const tmp = `${envFile}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${lines.join('\n')}\n`, 'utf8');
  await fs.rename(tmp, envFile);
}

async function deleteEnvKey(envFile: string, key: string): Promise<boolean> {
  const k = key.toUpperCase();
  let body = '';
  try { body = await fs.readFile(envFile, 'utf8'); } catch { return false; }
  const lines = body.split(/\r?\n/);
  const filtered = lines.filter((l) => !l.startsWith(`${k}=`));
  if (filtered.length === lines.length) return false;
  while (filtered.length > 0 && filtered[filtered.length - 1] === '') filtered.pop();
  const tmp = `${envFile}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${filtered.join('\n')}\n`, 'utf8');
  await fs.rename(tmp, envFile);
  return true;
}

const USAGE = [
  'Usage:',
  '  /voice on | off | toggle',
  '  /voice status',
  '  /voice mode push | continuous',
  '  /voice provider edge | sapi | elevenlabs | voxcpm',
  '  /voice voice <id>     (e.g. en-US-AriaNeural)',
].join('\n');

const handler: SlashCommandHandler = async (ctx) => {
  const display = ctx.display;
  const action = (ctx.args[0] ?? 'status').toLowerCase();
  const paths = ctx.paths;

  switch (action) {
    case 'on':
    case 'off':
    case 'toggle': {
      const current = process.env.AIDEN_VOICE_ENABLED === '1';
      const next = action === 'on'
        ? true
        : action === 'off'
        ? false
        : !current;
      process.env.AIDEN_VOICE_ENABLED = next ? '1' : '0';
      if (paths) {
        try {
          if (next) await upsertEnvVar(paths.envFile, 'AIDEN_VOICE_ENABLED', '1');
          else      await deleteEnvKey(paths.envFile, 'AIDEN_VOICE_ENABLED');
        } catch (err) {
          display.warn(`Could not persist /voice ${action} to .env: ${(err as Error).message}`);
        }
      }
      const tty = !!process.stdin.isTTY && !!process.stdout.isTTY;
      if (next && !tty) {
        display.warn('Voice mode requested, but stdin is not a TTY. The next REPL session must run in an interactive terminal.');
      }
      display.info(`voice mode ${next ? 'on' : 'off'}`);
      return;
    }

    case 'status': {
      const diag = await collectVoiceDiagnostics();
      display.info(`Aiden voice — ${AIDEN_VOICE_CLI_BUILD}`);
      display.info(`  enabled:        ${process.env.AIDEN_VOICE_ENABLED === '1' ? 'yes' : 'no'}`);
      display.info(`  tty:            ${diag.isTty ? 'yes' : 'no (voice refused — non-TTY stdin)'}`);
      display.info(`  mic backend:    ${diag.audio.backend}`);
      display.info(`  mic active:     ${diag.audio.active ? 'yes' : 'no'}`);
      display.info(`  sox on PATH:    ${diag.audio.soxOnPath ? 'yes' : 'no'}`);
      display.info(`  mode:           ${diag.config.mode}`);
      display.info(`  tts voice:      ${diag.config.ttsVoice}`);
      display.info(`  beeps:          ${diag.config.beepsEnabled ? 'on' : 'off'}`);
      display.info(`  tts providers:`);
      for (const p of diag.ttsProviders) {
        const tag = p.available ? '✓' : '✗';
        display.info(`    ${tag} ${p.name.padEnd(12)} ${p.note ?? ''}`);
      }
      return;
    }

    case 'mode': {
      const sub = (ctx.args[1] ?? '').toLowerCase();
      if (sub !== 'push' && sub !== 'push-to-talk' && sub !== 'continuous') {
        display.warn('Mode must be "push" or "continuous"');
        return;
      }
      const value = sub === 'continuous' ? 'continuous' : 'push-to-talk';
      process.env.AIDEN_VOICE_MODE = value;
      if (paths) {
        try { await upsertEnvVar(paths.envFile, 'AIDEN_VOICE_MODE', value); }
        catch (err) { display.warn(`Could not persist mode: ${(err as Error).message}`); }
      }
      display.info(`voice mode = ${value}`);
      return;
    }

    case 'provider': {
      const provider = (ctx.args[1] ?? '').toLowerCase();
      const valid = ['edge', 'sapi', 'elevenlabs', 'voxcpm'];
      if (!valid.includes(provider)) {
        display.warn(`Provider must be one of: ${valid.join(', ')}`);
        return;
      }
      process.env.AIDEN_VOICE_PROVIDER = provider;
      if (paths) {
        try { await upsertEnvVar(paths.envFile, 'AIDEN_VOICE_PROVIDER', provider); }
        catch (err) { display.warn(`Could not persist provider: ${(err as Error).message}`); }
      }
      display.info(`tts provider = ${provider}`);
      return;
    }

    case 'voice': {
      const voiceId = (ctx.args[1] ?? '').trim();
      if (!voiceId) {
        display.warn('Voice id required (e.g. en-US-AriaNeural)');
        return;
      }
      process.env.AIDEN_VOICE_TTS_VOICE = voiceId;
      if (paths) {
        try { await upsertEnvVar(paths.envFile, 'AIDEN_VOICE_TTS_VOICE', voiceId); }
        catch (err) { display.warn(`Could not persist voice: ${(err as Error).message}`); }
      }
      display.info(`tts voice = ${voiceId}`);
      return;
    }

    case 'help':
    case '--help':
    case '-h':
      display.info(USAGE);
      return;

    default:
      display.warn(`Unknown action: ${action}`);
      display.info(USAGE);
      return;
  }
};

export const voice: SlashCommand = {
  name:        'voice',
  description: 'Voice mode (PTT + TTS). Subcommands: on/off/toggle/status/mode/provider/voice',
  category:    'system',
  handler,
};
