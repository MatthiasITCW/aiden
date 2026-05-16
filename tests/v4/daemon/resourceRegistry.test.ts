/**
 * v4.5 Phase 1 — resourceRegistry tests.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createResourceRegistry,
  _resetResourceRegistryForTests,
} from '../../../core/v4/daemon/resourceRegistry';

beforeEach(() => { _resetResourceRegistryForTests(); });

describe('resourceRegistry', () => {
  it('register + list', () => {
    const reg = createResourceRegistry();
    let closed = false;
    const id = reg.register({
      kind: 'docker_session',
      owner: 'sess-1',
      close: () => { closed = true; },
    });
    expect(typeof id).toBe('string');
    const list = reg.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(id);
    expect(closed).toBe(false);
  });

  it('release calls close + removes from registry', async () => {
    const reg = createResourceRegistry();
    let closed = false;
    const id = reg.register({
      kind: 'http_client',
      owner: 'global',
      close: () => { closed = true; },
    });
    await reg.release(id);
    expect(closed).toBe(true);
    expect(reg.list()).toHaveLength(0);
  });

  it('release is idempotent on unknown id', async () => {
    const reg = createResourceRegistry();
    await expect(reg.release('does-not-exist')).resolves.toBeUndefined();
  });

  it('sweep reaps TTL-exceeded resources', async () => {
    const reg = createResourceRegistry();
    let closed = 0;
    reg.register({
      kind: 'http_client',
      owner: 'g',
      ttlMs: 1,
      close: () => { closed += 1; },
    });
    // Wait until ttl elapsed.
    await new Promise((r) => setTimeout(r, 50));
    const r = await reg.sweep();
    expect(r.reaped).toBe(1);
    expect(closed).toBe(1);
  });

  it('sweep leaves resources without TTL alone', async () => {
    const reg = createResourceRegistry();
    reg.register({ kind: 'http_client', owner: 'g', close: () => undefined });
    const r = await reg.sweep();
    expect(r.reaped).toBe(0);
    expect(reg.list()).toHaveLength(1);
  });

  it('touch refreshes lastUsedAt', () => {
    const reg = createResourceRegistry();
    const id = reg.register({ kind: 'browser_context', owner: 'g', close: () => undefined });
    const before = reg.list()[0].lastUsedAt;
    return new Promise<void>((resolve) => setTimeout(() => {
      reg.touch(id);
      const after = reg.list()[0].lastUsedAt;
      expect(after).toBeGreaterThanOrEqual(before);
      resolve();
    }, 10));
  });

  it('reapAll closes everything + reports counts', async () => {
    const reg = createResourceRegistry();
    let closedA = false, closedB = false;
    reg.register({ kind: 'http_client', owner: 'g', close: () => { closedA = true; } });
    reg.register({ kind: 'subprocess',  owner: 'g', close: () => { closedB = true; } });
    const r = await reg.reapAll();
    expect(r.reaped).toBe(2);
    expect(r.failed).toBe(0);
    expect(closedA && closedB).toBe(true);
    expect(reg.list()).toHaveLength(0);
  });

  it('reapAll isolates failures', async () => {
    const reg = createResourceRegistry();
    reg.register({ kind: 'http_client', owner: 'g', close: () => undefined });
    reg.register({ kind: 'subprocess',  owner: 'g', close: () => { throw new Error('boom'); } });
    const r = await reg.reapAll();
    expect(r.reaped).toBe(1);
    expect(r.failed).toBe(1);
  });

  it('budgetByKind sums budget units', () => {
    const reg = createResourceRegistry();
    reg.register({ kind: 'docker_session', owner: 'a', budgetUnits: 512, close: () => undefined });
    reg.register({ kind: 'docker_session', owner: 'b', budgetUnits: 256, close: () => undefined });
    reg.register({ kind: 'http_client',    owner: 'c',                  close: () => undefined });
    const b = reg.budgetByKind();
    expect(b.docker_session.count).toBe(2);
    expect(b.docker_session.budgetUnits).toBe(768);
    expect(b.http_client.count).toBe(1);
    expect(b.http_client.budgetUnits).toBe(0);
  });

  it('list filter by kind/owner', () => {
    const reg = createResourceRegistry();
    reg.register({ kind: 'docker_session', owner: 'a', close: () => undefined });
    reg.register({ kind: 'docker_session', owner: 'b', close: () => undefined });
    reg.register({ kind: 'http_client',    owner: 'a', close: () => undefined });
    expect(reg.list({ kind: 'docker_session' })).toHaveLength(2);
    expect(reg.list({ owner: 'a' })).toHaveLength(2);
    expect(reg.list({ owner: 'a', kind: 'http_client' })).toHaveLength(1);
  });
});
