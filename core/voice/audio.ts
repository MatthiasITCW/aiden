// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================

// core/voice/audio.ts — Platform audio I/O: recording + playback.
//
// Recording:   Windows MCI (P/Invoke via PowerShell, no third-party dep)
// Playback:    Windows Media Player (presentationCore) → Start-Process fallback
//
// Cross-platform note: recording falls back to arecord/sox on Linux/macOS.
// Playback falls back to afplay (macOS) / paplay (Linux).

import fs   from 'fs'
import path from 'path'
import { exec }     from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

const WORKSPACE = path.join(process.cwd(), 'workspace')

function ensureWorkspace(): void {
  if (!fs.existsSync(WORKSPACE)) fs.mkdirSync(WORKSPACE, { recursive: true })
}

// ── Record audio from microphone ──────────────────────────────────────────────

/**
 * Record audio from the default microphone.
 *
 * @param durationSeconds  Recording length in seconds (default 5).
 * @param outputPath       Where to save the .wav file. Defaults to a temp file in workspace/.
 * @returns                Resolved path to the recorded file.
 */
export async function recordAudio(
  durationSeconds: number = 5,
  outputPath?: string,
): Promise<string> {
  ensureWorkspace()

  const outPath = outputPath ?? path.join(WORKSPACE, `recording_${Date.now()}.wav`)
  const durationMs = Math.round(durationSeconds * 1000)

  if (process.platform === 'win32') {
    return _recordWindows(outPath, durationMs)
  } else {
    return _recordUnix(outPath, durationMs)
  }
}

async function _recordWindows(outputPath: string, durationMs: number): Promise<string> {
  const escapedPath = outputPath.replace(/\\/g, '\\\\')

  const psScript = `
Add-Type -TypeDefinition @"
using System;
using System.Threading;
using System.Runtime.InteropServices;

public class AudioRecorder {
  [DllImport("winmm.dll")]
  private static extern int mciSendString(
    string command,
    System.Text.StringBuilder returnValue,
    int returnLength,
    IntPtr winHandle
  );

  public static void Record(string outputPath, int durationMs) {
    mciSendString("open new Type waveaudio Alias recsound", null, 0, IntPtr.Zero);
    mciSendString("set recsound channels 1 bitspersample 16 samplespersec 16000", null, 0, IntPtr.Zero);
    mciSendString("record recsound", null, 0, IntPtr.Zero);
    Thread.Sleep(durationMs);
    mciSendString("stop recsound", null, 0, IntPtr.Zero);
    mciSendString("save recsound " + outputPath, null, 0, IntPtr.Zero);
    mciSendString("close recsound", null, 0, IntPtr.Zero);
  }
}
"@
[AudioRecorder]::Record("${escapedPath}", ${durationMs})
Write-Output "${outputPath}"
`.trim()

  const psFile = path.join(WORKSPACE, `record_${Date.now()}.ps1`)
  fs.writeFileSync(psFile, psScript)

  try {
    await execAsync(
      `powershell.exe -ExecutionPolicy Bypass -File "${psFile}"`,
      { timeout: durationMs + 8_000 },
    )
    return outputPath
  } catch (e: any) {
    throw new Error(`[Audio] Recording failed: ${e.message}`)
  } finally {
    try { fs.unlinkSync(psFile) } catch { /* ignore */ }
  }
}

async function _recordUnix(outputPath: string, durationMs: number): Promise<string> {
  const seconds = Math.ceil(durationMs / 1000)
  // Phase v4.1-cross-platform: detect available backend up-front so
  // a missing sox/arecord surfaces a friendly install hint instead of
  // a raw spawn-failure stack trace.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { detectBackend, missingBackendMessage } = require('./audioBackend')
  const backend = detectBackend('record')
  if (!backend) {
    throw new Error(`[Audio] ${missingBackendMessage('record')}`)
  }
  // Try sox first, then arecord
  try {
    await execAsync(`sox -d -t wav "${outputPath}" trim 0 ${seconds}`, { timeout: durationMs + 5_000 })
  } catch {
    try {
      await execAsync(
        `arecord -d ${seconds} -f S16_LE -r 16000 -c 1 "${outputPath}"`,
        { timeout: durationMs + 5_000 },
      )
    } catch {
      throw new Error(`[Audio] ${missingBackendMessage('record')}`)
    }
  }
  return outputPath
}

// ── Play audio ────────────────────────────────────────────────────────────────

/**
 * Play an audio file (wav / mp3 / ogg).
 * Non-blocking on Windows (fires MediaPlayer async); blocking on Unix.
 *
 * @param audioSource  Path to audio file, or raw audio Buffer.
 */
export async function playAudio(audioSource: string | Buffer): Promise<void> {
  ensureWorkspace()

  let filePath: string
  let isTmp = false

  if (Buffer.isBuffer(audioSource)) {
    filePath = path.join(WORKSPACE, `playback_${Date.now()}.wav`)
    fs.writeFileSync(filePath, audioSource)
    isTmp = true
  } else {
    filePath = audioSource
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`[Audio] File not found: ${filePath}`)
  }

  try {
    if (process.platform === 'win32') {
      await _playWindows(filePath)
    } else {
      await _playUnix(filePath)
    }
  } finally {
    if (isTmp) {
      setTimeout(() => { try { fs.unlinkSync(filePath) } catch { /* ignore */ } }, 10_000)
    }
  }
}

async function _playWindows(filePath: string): Promise<void> {
  // Phase v4.1-voice-cli (Piece 0) — replaced the hard-coded
  // `Start-Sleep -Seconds 10` with a NaturalDuration poll loop. The
  // old code cut off any TTS reply longer than 10s mid-sentence;
  // voice-mode replies of meaningful length need actual completion
  // tracking. MediaPlayer.Open is async — we wait up to 5s for
  // NaturalDuration to populate, then sleep the actual duration
  // (capped at 5min as a runaway guard). The 10s fallback is
  // preserved when NaturalDuration never resolves (codec issues,
  // streaming sources).
  const escaped = filePath.replace(/\\/g, '\\\\')
  const psBody = [
    'Add-Type -AssemblyName presentationCore',
    '$mp = New-Object System.Windows.Media.MediaPlayer',
    `$mp.Open([uri]'${escaped}')`,
    '$wait = 0',
    'while (-not $mp.NaturalDuration.HasTimeSpan -and $wait -lt 50) { Start-Sleep -Milliseconds 100; $wait++ }',
    '$mp.Play()',
    'if ($mp.NaturalDuration.HasTimeSpan) {',
    '  $secs = [Math]::Min(300, [Math]::Ceiling($mp.NaturalDuration.TimeSpan.TotalSeconds + 0.5))',
    '  Start-Sleep -Seconds ([int]$secs)',
    '} else { Start-Sleep -Seconds 10 }',
    '$mp.Stop()',
    '$mp.Close()',
  ].join('; ')
  await execAsync(
    `powershell -Command "${psBody}"`,
    // 5 min cap on the duration poll + a generous teardown margin.
    { timeout: 320_000 },
  ).catch(async () => {
    // Fallback: system default media player (fire-and-forget — caller
    // doesn't wait for completion, but at least audio plays).
    await execAsync(`powershell -Command "Start-Process '${escaped}'"`, { timeout: 5_000 })
      .catch(() => { /* ignore */ })
  })
}

async function _playUnix(filePath: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { detectBackend, missingBackendMessage } = require('./audioBackend')
  if (process.platform === 'darwin') {
    try {
      await execAsync(`afplay "${filePath}"`, { timeout: 30_000 })
    } catch {
      throw new Error(`[Audio] ${missingBackendMessage('playback')}`)
    }
  } else {
    // Linux — try paplay then aplay, surface friendly error if both fail.
    const backend = detectBackend('playback')
    if (!backend) throw new Error(`[Audio] ${missingBackendMessage('playback')}`)
    try {
      await execAsync(`paplay "${filePath}"`, { timeout: 30_000 })
    } catch {
      try {
        await execAsync(`aplay "${filePath}"`, { timeout: 30_000 })
      } catch {
        throw new Error(`[Audio] ${missingBackendMessage('playback')}`)
      }
    }
  }
}

// ── Availability check ────────────────────────────────────────────────────────

/** Returns true if audio recording is likely possible on this system. */
export async function checkAudioAvailable(): Promise<boolean> {
  if (process.platform === 'win32') {
    try {
      await execAsync(
        'powershell -Command "Add-Type -AssemblyName System.Speech; Write-Output ok"',
        { timeout: 3_000 },
      )
      return true
    } catch {
      return false
    }
  }
  // Unix: check for arecord or sox
  try {
    await execAsync('which arecord || which sox', { timeout: 2_000 })
    return true
  } catch {
    return false
  }
}
