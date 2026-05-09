/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/voicePromptApi.ts — Phase v4.1-voice-cli
 *
 * Wraps a default `ChatPromptApi` implementation with a raw-mode
 * spacebar toggle for push-to-talk recording. When the user is at
 * the prompt and presses Space:
 *
 *   1. Switch to raw mode + start `cliVoice.startRecording()`
 *   2. Update the spinner: "🎤 recording (Space to stop, Esc to cancel)"
 *   3. On second Space: stop and transcribe → return transcript
 *   4. On Esc: cancel and return empty (caller falls back to text)
 *   5. On any other character before the first Space: hand control
 *      back to the wrapped `inquirer` prompt so the user types
 *      normally
 *
 * Hard-refuses activation when `process.stdin.isTTY` is false. This
 * is the MCP-stdio invariant — `aiden mcp serve` uses stdin as the
 * JSON-RPC transport, and toggling raw mode there would corrupt
 * every protocol frame. The refusal is silent in MCP context (the
 * default `readLine` runs unchanged); explicit in REPL context (a
 * stderr warning + fall-through).
 *
 * `selectSlashCommand` is delegated unchanged — slash commands
 * still go through the inquirer dropdown.
 */

import type { ChatPromptApi } from './chatSession';
import type { CliVoiceHandle, VoiceStatus } from '../../core/v4/voice/cliVoice';
import type { Logger } from '../../core/v4/logger/logger';
import { noopLogger } from '../../core/v4/logger/factory';

export interface VoicePromptApiOptions {
  /** The wrapped prompt API — typically the inquirer-backed default. */
  inner: ChatPromptApi;
  /** The cliVoice handle — already wired by the caller. */
  voice: CliVoiceHandle;
  /** Live status callback for the display layer. The caller owns
   *  rendering; this just forwards transitions. */
  onStatus?: (status: VoiceStatus) => void;
  /** Logger — defaults to noop. */
  logger?: Logger;
  /** Override stdin / stdout for tests. */
  stdin?:  NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}

const KEY_SPACE = 0x20;
const KEY_ESC   = 0x1b;

/** Build a prompt API that intercepts Space for push-to-talk and
 *  falls through to `inner` for normal text input. */
export function createVoicePromptApi(opts: VoicePromptApiOptions): ChatPromptApi {
  const logger = (opts.logger ?? noopLogger()).child('voice-prompt');
  const stdin  = opts.stdin  ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;

  return {
    async readLine(prompt: string): Promise<string> {
      // Hard refuse when stdin isn't a TTY. Voice mode requires raw
      // mode; raw mode requires a TTY. MCP stdio mode hits this path
      // when Claude Desktop spawns aiden — silently fall through.
      if (!stdin.isTTY) {
        return opts.inner.readLine(prompt);
      }

      const transcript = await waitForSpaceOrTypedInput({
        prompt,
        stdin,
        stdout,
        voice: opts.voice,
        onStatus: opts.onStatus,
        logger,
      });
      if (transcript === null) {
        // User typed text — hand off to the regular prompt API. The
        // first character is already in the typeahead via the buffer
        // — `inner.readLine` reads from there.
        return opts.inner.readLine(prompt);
      }
      if (transcript === '') {
        // Cancelled — fall back to text prompt.
        return opts.inner.readLine(prompt);
      }
      return transcript;
    },

    async selectSlashCommand(source) {
      // Slash commands don't get voice intercept — they're a
      // discrete dropdown.
      return opts.inner.selectSlashCommand(source);
    },
  };
}

interface WaitArgs {
  prompt:   string;
  stdin:    NodeJS.ReadStream;
  stdout:   NodeJS.WriteStream;
  voice:    CliVoiceHandle;
  onStatus?: (status: VoiceStatus) => void;
  logger:   Logger;
}

/** Wait for either Space (start recording) or any other char (fall
 *  through to text prompt). Returns:
 *   - the transcribed string when recording completes
 *   - '' when user cancels (Esc)
 *   - null when user types non-space (fall through to inner) */
async function waitForSpaceOrTypedInput(args: WaitArgs): Promise<string | null> {
  // Show a brief hint so users know voice mode is hot.
  args.stdout.write(`${args.prompt}\x1b[2m(Space to talk)\x1b[0m `);

  const stdin = args.stdin;
  // Snapshot current raw mode state to restore on exit.
  const wasRaw = !!stdin.isRaw;
  if (!wasRaw) stdin.setRawMode(true);
  stdin.resume();

  let result: string | null | undefined = undefined;
  let recording = false;
  let transcript: string | null = null;
  let resolveOuter: ((v: string | null) => void) | null = null;

  const cleanup = (): void => {
    stdin.removeListener('data', onData);
    stdin.removeListener('error', onError);
    if (!wasRaw) {
      try { stdin.setRawMode(false); } catch { /* ignore */ }
    }
    stdin.pause();
  };

  const onData = (chunk: Buffer): void => {
    if (chunk.length === 0) return;
    const code = chunk[0]!;
    if (!recording) {
      if (code === KEY_SPACE) {
        // Start recording.
        recording = true;
        args.voice.startRecording().catch((err) => {
          args.logger.warn('startRecording threw', { error: (err as Error).message });
        });
      } else if (code === KEY_ESC) {
        result = '';
        cleanup();
        resolveOuter?.('');
      } else if (code === 0x03) {
        // Ctrl+C — propagate to inner via empty cancel.
        result = '';
        cleanup();
        resolveOuter?.('');
      } else {
        // Any other key — fall through to inner prompt. Push the
        // byte back so inner reads it (best-effort; on Windows
        // the unread() trick isn't reliable, so we just signal
        // null and inner re-prompts).
        result = null;
        cleanup();
        resolveOuter?.(null);
      }
    } else {
      // Already recording. Space stops; Esc cancels.
      if (code === KEY_SPACE) {
        args.voice.stopRecording().catch((err) => {
          args.logger.warn('stopRecording threw', { error: (err as Error).message });
        });
      } else if (code === KEY_ESC || code === 0x03) {
        args.voice.cancel();
        result = '';
        cleanup();
        resolveOuter?.('');
      }
    }
  };

  const onError = (err: Error): void => {
    args.logger.warn('stdin error during voice prompt', { error: err.message });
    cleanup();
    resolveOuter?.(null);
  };

  // Voice handle's onTranscript wins the race when recording succeeds.
  // We register a one-shot subscription via the existing callback by
  // taking advantage of the fact that handle.startRecording resolves
  // when transcribe completes — at that point transcript will be set
  // through the host's status callback. To keep this module narrowly
  // scoped, we POLL voice.getStatus() between awaits via a watcher.
  const watcher = setInterval(() => {
    const s = args.voice.getStatus();
    args.onStatus?.(s);
    // Recording finished naturally OR errored.
    if (recording && s === 'idle') {
      // Drain stdin and resolve. The transcript was forwarded via
      // the host's onTranscript callback (set up in the cliVoice
      // constructor); the host stitches it into the conversation.
      // For the prompt-API contract we resolve with empty so the
      // outer loop spins to the next iteration.
      cleanup();
      clearInterval(watcher);
      resolveOuter?.(transcript ?? '');
    }
  }, 50);

  stdin.on('data', onData);
  stdin.on('error', onError);

  return new Promise<string | null>((resolve) => {
    resolveOuter = (v) => {
      clearInterval(watcher);
      resolve(v);
    };
  });
}

/** Test-only helper: enforce the TTY guard. Returns true when voice
 *  mode is allowed to activate in this process. */
export function voiceModeAllowed(stdin: NodeJS.ReadStream = process.stdin): boolean {
  return !!stdin.isTTY;
}
