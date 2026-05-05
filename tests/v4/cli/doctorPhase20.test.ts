import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  resolveAidenPaths,
  ensureAidenDirsExist,
} from '../../../core/v4/paths';
import { saveLicense, type LicenseCache } from '../../../core/v4/license/licenseStore';
import { checkLicense, checkUpdate } from '../../../cli/v4/doctor';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-doctor20-'));
  process.env.AIDEN_MACHINE_KEY = 'test-machine-key-doctor20';
});
afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  delete process.env.AIDEN_MACHINE_KEY;
  delete process.env.AIDEN_NO_UPDATE_CHECK;
});

describe('Phase 20 doctor checks', () => {
  it('1. checkLicense reports free tier when no cache exists', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    const r = await checkLicense({ paths, timeoutMs: 1000 });
    expect(r.passed).toBe(true);
    expect(r.message).toContain('free tier');
  });

  it('2. checkLicense reports Pro tier with plan when cache is valid', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    const cache: LicenseCache = {
      key: 'AIDEN-PRO-ABC12-DEF34-GHI56',
      valid: true,
      plan: 'pro_yearly',
      expiresAt: '2099-01-01T00:00:00Z',
      features: { multi_tool_approval: true },
      lastVerified: Date.now(),
    };
    await saveLicense(paths, cache);
    const r = await checkLicense({ paths, timeoutMs: 1000 });
    expect(r.passed).toBe(true);
    expect(r.message).toContain('Pro');
    expect(r.message).toContain('pro_yearly');
  });

  it('3. checkUpdate reports up-to-date when AIDEN_NO_UPDATE_CHECK is set', async () => {
    process.env.AIDEN_NO_UPDATE_CHECK = '1';
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    const r = await checkUpdate({
      paths,
      installedVersion: '4.0.0-beta.1',
      timeoutMs: 1000,
    });
    expect(r.passed).toBe(true);
    // No update available because env var disabled the check; status.latest is null.
    expect(r.message).toContain('up to date');
  });
});
