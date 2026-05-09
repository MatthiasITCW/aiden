// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================
//
// core/v4/cron/atomicWrite.ts — crash-safe JSON writer.
//
// Writes go through a temp file in the same directory, are
// fsync'd, then renamed onto the destination. The rename is
// atomic on POSIX and on NTFS (ReplaceFile semantics), so a
// process death mid-write never leaves a half-written file
// at the destination path.
//
// A per-path mutex serialises concurrent writers in-process so
// two callers racing to update the same file produce one valid
// final state instead of an interleaved corrupt one.

import * as fsp  from 'fs/promises'
import * as path from 'path'

const inflight: Map<string, Promise<void>> = new Map()

export async function writeJsonAtomic(
  filePath: string,
  data:     unknown,
): Promise<void> {
  const previous = inflight.get(filePath) ?? Promise.resolve()
  const next     = previous.catch(() => undefined).then(() => doWrite(filePath, data))
  inflight.set(filePath, next)
  try {
    await next
  } finally {
    if (inflight.get(filePath) === next) inflight.delete(filePath)
  }
}

async function doWrite(filePath: string, data: unknown): Promise<void> {
  // Phase v4.1-cron — symlink-aware rename. If the destination
  // path is a symlink (e.g. cron_jobs.json points at a file in a
  // shared directory), naive `fs.rename` *replaces* the symlink with
  // a regular file, detaching it from the link target. Resolve the
  // symlink first so the rename lands on the actual target. When the
  // path is NOT a symlink (or doesn't exist yet), `realpath` returns
  // the path itself or throws ENOENT — both safe to fall through.
  let resolvedPath = filePath
  try {
    resolvedPath = await fsp.realpath(filePath)
  } catch {
    // ENOENT (file doesn't exist yet) or non-symlink — use original.
  }

  const dir     = path.dirname(resolvedPath)
  const baseTmp = `.${path.basename(resolvedPath)}.${process.pid}.${Date.now()}.tmp`
  const tmpPath = path.join(dir, baseTmp)

  await fsp.mkdir(dir, { recursive: true })

  const json = JSON.stringify(data, null, 2)
  const fh   = await fsp.open(tmpPath, 'w', 0o600)
  try {
    await fh.writeFile(json, 'utf8')
    // Force the bytes to disk before rename — without this a crash between
    // rename() and the kernel's writeback can still leave an empty file.
    try { await fh.sync() } catch { /* best-effort on platforms without fsync */ }
  } finally {
    await fh.close()
  }

  try {
    await fsp.rename(tmpPath, resolvedPath)
  } catch (err) {
    // rename failed — clean up the orphan temp file before re-raising.
    try { await fsp.unlink(tmpPath) } catch { /* nothing more we can do */ }
    throw err
  }

  // Owner-only access. Best-effort: NTFS may refuse but we try anyway.
  try { await fsp.chmod(resolvedPath, 0o600) } catch { /* windows / non-POSIX */ }
}

// Test hook — drains queued writes so tests can assert on disk state.
export async function awaitAllPending(): Promise<void> {
  const pending = Array.from(inflight.values())
  await Promise.allSettled(pending)
}
