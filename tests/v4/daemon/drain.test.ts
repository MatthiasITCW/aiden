/**
 * v4.5 Phase 1 — drain ordering tests.
 *
 * Verifies the 5-step ordering via a call-order spy: notify →
 * (drain) → killToolSubprocesses → closeResources → final markers.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  performDrain,
  _resetDrainStateForTests,
} from '../../../core/v4/daemon/drain';

beforeEach(() => { _resetDrainStateForTests(); });

interface OrderedCall { name: string; t: number; }

function makeRecorder(): { calls: OrderedCall[]; record: (name: string) => void } {
  const calls: OrderedCall[] = [];
  return { calls, record: (name) => calls.push({ name, t: Date.now() }) };
}

describe('performDrain — ordering', () => {
  it('happy path: notify → killToolSubprocesses → closeResources → final markers', async () => {
    const { calls, record } = makeRecorder();
    await performDrain({
      drainTimeoutMs:       0,
      reason:               'sigterm',
      callProcessExit:      false,
      notifySessions:       () => { record('notify'); },
      activeRuns:           () => { record('activeRuns'); return []; },
      killToolSubprocesses: () => { record('killSub'); },
      closeBrowser:         () => { record('browser'); },
      closeCron:            () => { record('cron'); },
      closeDocker:          () => { record('docker'); },
      closeIdempotency:     () => { record('idem'); },
      closeResources:       () => { record('resources'); return { reaped: 1, failed: 0 }; },
      touchCleanShutdown:   () => { record('cleanShutdown'); },
      removePid:            () => { record('removePid'); },
      markShutdown:         () => { record('markShutdown'); },
    });
    const names = calls.map((c) => c.name);
    // notify must come before killSub; killSub must come before resources.
    expect(names.indexOf('notify')).toBeLessThan(names.indexOf('killSub'));
    expect(names.indexOf('killSub')).toBeLessThan(names.indexOf('resources'));
    expect(names).toContain('cleanShutdown');
    expect(names).toContain('removePid');
    // Step 0 + Step 5 both call markShutdown.
    expect(names.filter((n) => n === 'markShutdown').length).toBe(2);
  });

  it('drain timeout: marks remaining runs resume_pending + interrupts', async () => {
    const { calls, record } = makeRecorder();
    let callIdx = 0;
    // activeRuns returns [101] on first call (before drain), [101] on
    // second call (after timeout → still active).
    const activeRuns = (): number[] => {
      callIdx += 1;
      record(`activeRuns:${callIdx}`);
      return [101];
    };
    const result = await performDrain({
      drainTimeoutMs:        10,            // tiny so test runs fast
      postInterruptGraceMs:  10,
      reason:                'sigterm',
      callProcessExit:       false,
      activeRuns,
      markResumePending:    (rid, reason) => { record(`resumePending:${rid}:${reason}`); },
      interruptRun:         (rid, reason) => { record(`interrupt:${rid}:${reason}`); },
      killToolSubprocesses: () => { record('killSub'); },
      closeResources:       () => { record('resources'); },
      removePid:            () => { record('removePid'); },
      markShutdown:         () => { record('markShutdown'); },
      touchCleanShutdown:   () => { record('cleanShutdown'); },
    });
    expect(result.drainTimedOut).toBe(true);
    expect(result.resumePendingIds).toEqual([101]);
    const names = calls.map((c) => c.name);
    expect(names).toContain('resumePending:101:drain_timeout');
    expect(names).toContain('interrupt:101:shutdown');
  });

  it('second invocation is idempotent (returns immediately)', async () => {
    _resetDrainStateForTests();
    let count = 0;
    const inc = () => { count += 1; };
    await performDrain({
      drainTimeoutMs: 0, reason: 'sigterm', callProcessExit: false,
      removePid: inc, markShutdown: inc, touchCleanShutdown: inc,
    });
    // Already drained. A second performDrain returns immediately
    // without touching anything.
    const r2 = await performDrain({
      drainTimeoutMs: 0, reason: 'sigterm', callProcessExit: false,
      removePid: inc, markShutdown: inc, touchCleanShutdown: inc,
    });
    expect(r2.durationMs).toBe(0);
    // count from first call: removePid + 2× markShutdown + touchCleanShutdown = 4
    // No additional calls from the second invocation.
    expect(count).toBe(4);
  });

  it('killToolSubprocesses runs BEFORE closeResources', async () => {
    const { calls, record } = makeRecorder();
    await performDrain({
      drainTimeoutMs: 0, reason: 'sigterm', callProcessExit: false,
      killToolSubprocesses: () => { record('killSub'); },
      closeResources:       () => { record('resources'); },
    });
    const ks = calls.findIndex((c) => c.name === 'killSub');
    const rs = calls.findIndex((c) => c.name === 'resources');
    expect(ks).toBeGreaterThanOrEqual(0);
    expect(rs).toBeGreaterThanOrEqual(0);
    expect(ks).toBeLessThan(rs);
  });
});
