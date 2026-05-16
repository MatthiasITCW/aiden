/**
 * v4.5 Phase 1 — eventLoopLag sampler tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  startEventLoopLagSampler,
  stopEventLoopLagSampler,
  getEventLoopLagMs,
  isEventLoopResponsive,
} from '../../../core/v4/daemon/eventLoopLag';

beforeEach(() => { stopEventLoopLagSampler(); });
afterEach(()  => { stopEventLoopLagSampler(); });

describe('eventLoopLag', () => {
  it('returns 0 lag when sampler not started', () => {
    expect(getEventLoopLagMs()).toBe(0);
    expect(isEventLoopResponsive()).toBe(false);
  });

  it('start + measure → responsive', async () => {
    startEventLoopLagSampler();
    // Wait a few sample intervals.
    await new Promise((r) => setTimeout(r, 250));
    expect(isEventLoopResponsive()).toBe(true);
    expect(getEventLoopLagMs()).toBeGreaterThanOrEqual(0);
  });

  it('stop + getEventLoopLagMs returns to 0', async () => {
    startEventLoopLagSampler();
    await new Promise((r) => setTimeout(r, 150));
    stopEventLoopLagSampler();
    expect(getEventLoopLagMs()).toBe(0);
  });
});
