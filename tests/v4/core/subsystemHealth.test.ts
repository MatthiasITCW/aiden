/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * Phase v4.1.2-slice3 — SubsystemHealthTracker + SubsystemHealthRegistry
 * unit coverage. The four production subsystems (compressor, skill-
 * teacher, skill-miner, logger) are tested separately; this file
 * focuses on the registry/tracker primitives so the contract is
 * locked before downstream callers depend on it.
 */
import { describe, it, expect } from 'vitest';
import {
  SubsystemHealthTracker,
  createSubsystemHealthRegistry,
  type SubsystemHealth,
} from '../../../core/v4/subsystemHealth';

describe('SubsystemHealthTracker', () => {
  it('starts at zero', () => {
    const t = new SubsystemHealthTracker('x');
    const snap = t.snapshot();
    expect(snap.subsystem).toBe('x');
    expect(snap.totalCalls).toBe(0);
    expect(snap.totalErrors).toBe(0);
    expect(snap.lastError).toBeUndefined();
  });

  it('records a success without an error block', () => {
    const t = new SubsystemHealthTracker('s');
    t.recordSuccess();
    t.recordSuccess();
    const snap = t.snapshot();
    expect(snap.totalCalls).toBe(2);
    expect(snap.totalErrors).toBe(0);
    expect(snap.lastError).toBeUndefined();
  });

  it('records a failure with the error message and consecutive count', () => {
    const t = new SubsystemHealthTracker('f');
    t.recordFailure(new Error('disk full'));
    const snap = t.snapshot();
    expect(snap.totalCalls).toBe(1);
    expect(snap.totalErrors).toBe(1);
    expect(snap.lastError?.message).toBe('disk full');
    expect(snap.lastError?.consecutive).toBe(1);
    expect(snap.lastError?.at).toBeInstanceOf(Date);
  });

  it('increments consecutive on a streak; resets on success', () => {
    const t = new SubsystemHealthTracker('streak');
    t.recordFailure('boom');
    t.recordFailure('boom');
    t.recordFailure('boom');
    expect(t.snapshot().lastError?.consecutive).toBe(3);
    t.recordSuccess();
    // lastError remains (we keep the message) but consecutive resets.
    expect(t.snapshot().lastError?.consecutive).toBe(0);
    t.recordFailure('again');
    expect(t.snapshot().lastError?.consecutive).toBe(1);
  });

  it('caps the error message at 200 chars with an ellipsis', () => {
    const t = new SubsystemHealthTracker('cap');
    const long = 'a'.repeat(500);
    t.recordFailure(new Error(long));
    const msg = t.snapshot().lastError!.message;
    expect(msg.length).toBe(200);
    expect(msg.endsWith('...')).toBe(true);
  });

  it('handles non-Error throwables (strings, objects, undefined)', () => {
    const t = new SubsystemHealthTracker('throw');
    t.recordFailure('plain string error');
    expect(t.snapshot().lastError?.message).toBe('plain string error');
    t.recordFailure({ code: 'EACCES', errno: -13 });
    expect(t.snapshot().lastError?.message).toContain('EACCES');
    t.recordFailure(undefined);
    expect(t.snapshot().lastError?.message).toBeTypeOf('string');
  });
});

describe('createSubsystemHealthRegistry', () => {
  it('returns a snapshot covering every registered reader', () => {
    const r = createSubsystemHealthRegistry();
    const a = new SubsystemHealthTracker('a');
    const b = new SubsystemHealthTracker('b');
    a.recordFailure('a-broke');
    b.recordSuccess();
    r.register('a', () => a.snapshot());
    r.register('b', () => b.snapshot());
    const snaps = r.snapshot();
    expect(snaps.map((s) => s.subsystem).sort()).toEqual(['a', 'b']);
    const aSnap = snaps.find((s) => s.subsystem === 'a')!;
    expect(aSnap.totalErrors).toBe(1);
    expect(aSnap.lastError?.message).toBe('a-broke');
  });

  it('flattens array-valued readers (used for the per-sink Logger surface)', () => {
    const r = createSubsystemHealthRegistry();
    r.register('logger', () => ([
      { subsystem: 'logger:file', totalCalls: 10, totalErrors: 0 },
      { subsystem: 'logger:stderr', totalCalls: 4, totalErrors: 1,
        lastError: { message: 'EBADF', at: new Date(), consecutive: 1 } },
    ] satisfies SubsystemHealth[]));
    const snaps = r.snapshot();
    expect(snaps.map((s) => s.subsystem))
      .toEqual(['logger:file', 'logger:stderr']);
  });

  it('survives a reader that throws (telemetry must not break doctor)', () => {
    const r = createSubsystemHealthRegistry();
    r.register('good', () => ({
      subsystem: 'good', totalCalls: 1, totalErrors: 0,
    }));
    r.register('bad', () => { throw new Error('reader explosion'); });
    const snaps = r.snapshot();
    // Good reader still produced its entry; bad reader skipped.
    expect(snaps.length).toBe(1);
    expect(snaps[0].subsystem).toBe('good');
  });

  it('last-write-wins on duplicate registration', () => {
    const r = createSubsystemHealthRegistry();
    r.register('x', () => ({ subsystem: 'x', totalCalls: 1, totalErrors: 0 }));
    r.register('x', () => ({ subsystem: 'x', totalCalls: 99, totalErrors: 0 }));
    expect(r.snapshot()[0].totalCalls).toBe(99);
  });

  it('reset() drops all readers', () => {
    const r = createSubsystemHealthRegistry();
    r.register('x', () => ({ subsystem: 'x', totalCalls: 1, totalErrors: 0 }));
    expect(r.snapshot()).toHaveLength(1);
    r.reset();
    expect(r.snapshot()).toEqual([]);
  });
});
