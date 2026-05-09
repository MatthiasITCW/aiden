/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/voiceCli.ts — Phase v4.1-voice-cli
 *
 * `aiden voice <action>` top-level CLI subcommand. Three actions:
 *
 *   doctor          — print diagnostics: build, TTY, mic backend,
 *                     TTS providers, current config. No mic open.
 *   tts <text>      — synthesise + play one short clip. Real
 *                     provider call.
 *   transcribe <f>  — STT one audio file. Reuses the v4.1-3
 *                     `whisper-transcribe` channel pipeline.
 *
 * Distinct from the `/voice` slash command (which mutates session
 * state from inside the REPL). This subcommand exists so users can
 * verify mic + speaker setup BEFORE entering the REPL — useful for
 * first-run mic-permission grants on Windows where the OS prompts
 * the first time the device is opened.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { promises as fs } from 'node:fs';

import { collectVoiceDiagnostics, AIDEN_VOICE_CLI_BUILD } from '../../core/v4/voice/diagnostics';
import { synthesize, cleanForTTS } from '../../core/voice/tts';
import { transcribeForChannel } from '../../core/channels/whisper-transcribe';

export interface RunVoiceOptions {
  writeOut?: (text: string) => void;
  writeErr?: (text: string) => void;
}

export async function runVoiceSubcommand(
  action: string,
  args: string[],
  opts: RunVoiceOptions = {},
): Promise<number> {
  const writeOut = opts.writeOut ?? ((t: string) => process.stdout.write(t));
  const writeErr = opts.writeErr ?? ((t: string) => process.stderr.write(t));

  switch (action) {
    case 'doctor': {
      const diag = await collectVoiceDiagnostics();
      writeOut(`Aiden voice — ${AIDEN_VOICE_CLI_BUILD}\n`);
      writeOut(`  tty:            ${diag.isTty ? 'yes' : 'no'}\n`);
      writeOut(`  enabled:        ${diag.enabled ? 'yes' : 'no (refused — non-TTY stdin)'}\n`);
      writeOut(`  mic backend:    ${diag.audio.backend}\n`);
      writeOut(`  mic active:     ${diag.audio.active ? 'yes' : 'no'}\n`);
      writeOut(`  sox on PATH:    ${diag.audio.soxOnPath ? 'yes' : 'no'}\n`);
      writeOut(`  mode:           ${diag.config.mode}\n`);
      writeOut(`  tts voice:      ${diag.config.ttsVoice}\n`);
      writeOut(`  beeps:          ${diag.config.beepsEnabled ? 'on' : 'off'}\n`);
      writeOut(`  tts providers:\n`);
      for (const p of diag.ttsProviders) {
        const tag = p.available ? '✓' : '✗';
        writeOut(`    ${tag} ${p.name.padEnd(12)} ${p.note ?? ''}\n`);
      }
      // Mic-backend hint when nothing is installed.
      if (diag.audio.backend === 'unavailable') {
        writeOut(`\n  Hint: install \`decibri\` (npm i decibri) for prebuilt mic capture,\n`);
        writeOut(`        OR install sox (https://sox.sourceforge.io/) + node-record-lpcm16.\n`);
      }
      return 0;
    }

    case 'tts': {
      const text = args.join(' ').trim();
      if (!text) {
        writeErr(`Usage: aiden voice tts "<text>"\n`);
        return 1;
      }
      const cleaned = cleanForTTS(text);
      if (!cleaned) {
        writeErr(`Empty after cleanForTTS — nothing to speak.\n`);
        return 1;
      }
      writeOut(`Synthesising via TTS chain (${cleaned.length} chars)...\n`);
      const r = await synthesize({ text: cleaned });
      if (r.error) {
        writeErr(`TTS failed: ${r.error}\n`);
        return 1;
      }
      writeOut(`TTS ok — provider: ${r.provider}, ${r.durationMs}ms\n`);
      return 0;
    }

    case 'transcribe': {
      const filePath = args[0];
      if (!filePath) {
        writeErr(`Usage: aiden voice transcribe <audio-file>\n`);
        return 1;
      }
      try {
        await fs.access(filePath);
      } catch {
        writeErr(`File not found: ${filePath}\n`);
        return 1;
      }
      writeOut(`Transcribing ${filePath}...\n`);
      const r = await transcribeForChannel({ filePath });
      if (!r.success) {
        writeErr(`Transcribe failed: ${r.error ?? 'unknown'}\n`);
        return 1;
      }
      const conf = typeof r.avgLogprob === 'number'
        ? ` (avgLogprob=${r.avgLogprob.toFixed(2)})`
        : '';
      writeOut(`Transcript${conf}:\n${r.text ?? ''}\n`);
      return 0;
    }

    default: {
      writeErr(`Unknown 'aiden voice' action: ${action}\n`);
      writeErr(`Actions: doctor | tts <text> | transcribe <file>\n`);
      return 1;
    }
  }
}

export { AIDEN_VOICE_CLI_BUILD };
