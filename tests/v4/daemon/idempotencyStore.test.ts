/**
 * v4.5 Phase 1 — idempotencyStore tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createIdempotencyStore } from '../../../core/v4/daemon/idempotencyStore';
import type { IdempotencyStore } from '../../../core/v4/daemon/idempotencyStore';

let db: Database.Database;
let store: IdempotencyStore;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  // disable sweep timer for deterministic tests
  store = createIdempotencyStore({ db, sweepIntervalMs: 0 });
});
afterEach(() => {
  store.close();
  try { db.close(); } catch { /* noop */ }
});

describe('idempotencyStore.getOrSet', () => {
  it('compute on first call, cache on second', async () => {
    let calls = 0;
    const compute = (): Promise<{ responseJson: string; statusCode: number }> => {
      calls += 1;
      return Promise.resolve({ responseJson: '{"ok":1}', statusCode: 200 });
    };
    const r1 = await store.getOrSet('webhook', 'k1', 'fp', compute);
    const r2 = await store.getOrSet('webhook', 'k1', 'fp', compute);
    expect(r1.responseJson).toBe('{"ok":1}');
    expect(r2.responseJson).toBe('{"ok":1}');
    expect(calls).toBe(1);
  });

  it('different fingerprint forces recompute', async () => {
    let calls = 0;
    await store.getOrSet('webhook', 'k1', 'fp-a', () => {
      calls += 1;
      return { responseJson: '{}', statusCode: 200 };
    });
    await store.getOrSet('webhook', 'k1', 'fp-b', () => {
      calls += 1;
      return { responseJson: '{}', statusCode: 200 };
    });
    expect(calls).toBe(2);
  });

  it('separate scopes do not collide', async () => {
    await store.getOrSet('webhook', 'k', null, () => ({ responseJson: 'w', statusCode: 200 }));
    await store.getOrSet('api_run', 'k', null, () => ({ responseJson: 'a', statusCode: 200 }));
    expect(store.get('webhook', 'k')?.responseJson).toBe('w');
    expect(store.get('api_run', 'k')?.responseJson).toBe('a');
  });
});

describe('idempotencyStore L1/L2', () => {
  it('L1 miss + L2 hit reseeds L1', async () => {
    // Force a write via getOrSet, then drop L1 by re-creating the store
    // sharing the same db.
    await store.getOrSet('webhook', 'k', null, () => ({ responseJson: 'v', statusCode: 200 }));
    store.close();
    const store2 = createIdempotencyStore({ db, sweepIntervalMs: 0 });
    const got = store2.get('webhook', 'k');
    expect(got?.responseJson).toBe('v');
    expect(store2.stats().l1).toBe(1);    // got() reseeded
    store2.close();
  });

  it('reseed() loads L2 entries into L1 on boot', () => {
    store.set('webhook', 'k1', null, { responseJson: '1', statusCode: 200 });
    store.set('webhook', 'k2', null, { responseJson: '2', statusCode: 200 });
    store.close();
    const store2 = createIdempotencyStore({ db, sweepIntervalMs: 0 });
    const r = store2.reseed();
    expect(r.loaded).toBe(2);
    expect(store2.stats().l1).toBe(2);
    store2.close();
  });
});

describe('idempotencyStore TTL', () => {
  it('expired L2 rows are not returned', async () => {
    store.set('webhook', 'k', null, { responseJson: 'x', statusCode: 200 }, 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(store.get('webhook', 'k')).toBeNull();
  });

  it('sweepExpired deletes L2 rows past their TTL', async () => {
    store.set('webhook', 'a', null, { responseJson: '1', statusCode: 200 }, 1);
    store.set('webhook', 'b', null, { responseJson: '2', statusCode: 200 }, 10 * 60_000);
    await new Promise((r) => setTimeout(r, 20));
    const r = store.sweepExpired();
    expect(r.deleted).toBe(1);
    expect(store.stats().l2).toBe(1);
  });
});

describe('idempotencyStore.stats', () => {
  it('returns L1 + L2 counts', async () => {
    await store.getOrSet('webhook', 'k1', null, () => ({ responseJson: 'v', statusCode: 200 }));
    expect(store.stats()).toEqual({ l1: 1, l2: 1 });
  });
});
