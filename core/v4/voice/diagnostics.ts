/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/voice/diagnostics.ts — Phase v4.1-voice-cli
 *
 * Build fingerprint + provider/backend snapshot surfaced by
 * `aiden voice doctor` and `/voice status`. Bump on every shipped
 * phase. Format: `v4.1-voice-cli[+suffix]`.
 */

import { resolveAudioBackend, getAudioDiagnostics, type AudioBackend } from './audioStream';
import { getTtsProviders } from '../../voice/tts';
import type { Logger } from '../logger/logger';
import { noopLogger } from '../logger/factory';

/** Build fingerprint — bump per phase. Surfaced in `aiden voice
 *  doctor` and the `/voice status` slash command. */
export const AIDEN_VOICE_CLI_BUILD = 'v4.1-voice-cli';

/** Persisted voice-mode preferences. Reads from env (no config
 *  state mutation in this phase — that's `/voice` slash command's
 *  scope). */
export interface VoiceConfig {
  /** Default TTS voice id. en-US-AriaNeural per locked decision. */
  ttsVoice: string;
  /** PTT vs continuous mode. PTT default. */
  mode: 'push-to-talk' | 'continuous';
  /** Audible 880/660Hz beeps on record start/stop. Off by default. */
  beepsEnabled: boolean;
}

const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  ttsVoice: 'en-US-AriaNeural',
  mode: 'push-to-talk',
  beepsEnabled: false,
};

/** Read voice-mode env config. Pure function over `process.env` —
 *  callers can override env by passing a different bag. */
export function readVoiceConfig(env: NodeJS.ProcessEnv = process.env): VoiceConfig {
  const cfg: VoiceConfig = { ...DEFAULT_VOICE_CONFIG };
  if (typeof env.AIDEN_VOICE_TTS_VOICE === 'string' && env.AIDEN_VOICE_TTS_VOICE.length > 0) {
    cfg.ttsVoice = env.AIDEN_VOICE_TTS_VOICE;
  }
  if (env.AIDEN_VOICE_MODE === 'continuous') {
    cfg.mode = 'continuous';
  }
  if (env.AIDEN_VOICE_BEEPS === '1' || env.AIDEN_VOICE_BEEPS === 'true') {
    cfg.beepsEnabled = true;
  }
  return cfg;
}

export interface VoiceDiagnostics {
  build: string;
  /** Whether the running process is on a TTY (raw-mode requirement). */
  isTty: boolean;
  /** Whether voice mode is allowed in this process (false in MCP stdio). */
  enabled: boolean;
  /** Mic backend availability + active state. */
  audio: {
    backend: AudioBackend;
    active:  boolean;
    soxOnPath: boolean;
  };
  /** Configured TTS providers from the existing `core/voice/tts.ts` chain. */
  ttsProviders: Array<{ name: string; available: boolean; note?: string }>;
  config: VoiceConfig;
}

/** Build the diagnostics snapshot. Used by `aiden voice doctor`,
 *  `/voice status`, and runtime smoke verification. */
export async function collectVoiceDiagnostics(
  logger: Logger = noopLogger(),
): Promise<VoiceDiagnostics> {
  const isTty = !!process.stdin.isTTY && !!process.stdout.isTTY;
  // Voice mode is REFUSED when stdin isn't a TTY — that's the MCP
  // stdio invariant. The `aiden mcp serve` process must never enter
  // raw mode (would corrupt JSON-RPC frames).
  const enabled = isTty;
  const audio = await getAudioDiagnostics(logger);
  return {
    build:        AIDEN_VOICE_CLI_BUILD,
    isTty,
    enabled,
    audio: {
      backend:   audio.resolved ?? 'unavailable',
      active:    audio.active,
      soxOnPath: audio.soxOnPath,
    },
    ttsProviders: getTtsProviders(),
    config:       readVoiceConfig(),
  };
}
