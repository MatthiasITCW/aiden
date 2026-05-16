/**
 * v4.5 Phase 1 — restartFailureCounter tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import {
  createRestartFailureCounter,
  DEFAULT_STUCK_LOOP_THRESHOLD,
} from '../../../core/v4/daemon/restartFailureCounter';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});
afterEach(() => { try { db.close(); } catch { /* noop */ } });

describe('restartFailureCounter', () => {
  it('default threshold is 3', () => {
    expect(DEFAULT_STUCK_LOOP_THRESHOLD).toBe(3);
  });

  it('increments + reports newCount + autoSuspended', () => {
    const c = createRestartFailureCounter({ db });
    const a = c.incrementForSession('s1');
    expect(a).toEqual({ newCount: 1, autoSuspended: false });
    const b = c.incrementForSession('s1');
    expect(b).toEqual({ newCount: 2, autoSuspended: false });
    const cc = c.incrementForSession('s1');
    expect(cc).toEqual({ newCount: 3, autoSuspended: true });
  });

  it('honors custom threshold', () => {
    const c = createRestartFailureCounter({ db, threshold: 2 });
    expect(c.incrementForSession('s1').autoSuspended).toBe(false);
    expect(c.incrementForSession('s1').autoSuspended).toBe(true);
  });

  it('isAutoSuspended reflects state', () => {
    const c = createRestartFailureCounter({ db, threshold: 1 });
    expect(c.isAutoSuspended('s1')).toBe(false);
    c.incrementForSession('s1');
    expect(c.isAutoSuspended('s1')).toBe(true);
  });

  it('reset clears the row', () => {
    const c = createRestartFailureCounter({ db, threshold: 1 });
    c.incrementForSession('s1');
    expect(c.isAutoSuspended('s1')).toBe(true);
    c.resetForSession('s1');
    expect(c.isAutoSuspended('s1')).toBe(false);
  });

  it('listSuspended returns only auto-suspended rows', () => {
    const c = createRestartFailureCounter({ db, threshold: 2 });
    c.incrementForSession('s1');
    c.incrementForSession('s2');
    c.incrementForSession('s2');
    const list = c.listSuspended();
    expect(list.map((r) => r.sessionId)).toEqual(['s2']);
  });
});
