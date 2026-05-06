import { describe, it, expect } from 'vitest';

import { TIPS, getRandomTip } from '../../../cli/v4/tips';

describe('cli/v4/tips', () => {
  it('ships a non-empty pool of single-line tips', () => {
    expect(TIPS.length).toBeGreaterThanOrEqual(8);
    for (const t of TIPS) {
      expect(t).not.toContain('\n');
      expect(t.length).toBeGreaterThan(0);
    }
  });

  it('pool covers the launch-critical commands', () => {
    const pool = TIPS.join('\n');
    expect(pool).toMatch(/\/help/);
    expect(pool).toMatch(/Ctrl\+C/);
    expect(pool).toMatch(/aiden doctor/);
    expect(pool).toMatch(/\/yolo/);
    expect(pool).toMatch(/\/personality/);
    expect(pool).toMatch(/SOUL\.md/);
    expect(pool).toMatch(/\/streaming/);
    expect(pool).toMatch(/\/skills/);
    expect(pool).toMatch(/aiden setup model/);
    expect(pool).toMatch(/[Mm]emory/);
  });

  it('getRandomTip returns a member of the pool', () => {
    for (let i = 0; i < 25; i += 1) {
      expect(TIPS).toContain(getRandomTip());
    }
  });

  it('getRandomTip selection is deterministic with injected rand', () => {
    expect(getRandomTip(() => 0)).toBe(TIPS[0]);
    expect(getRandomTip(() => 0.999)).toBe(TIPS[TIPS.length - 1]);
    // Mid-point picks the middle entry.
    const mid = Math.floor(0.5 * TIPS.length);
    expect(getRandomTip(() => 0.5)).toBe(TIPS[mid]);
  });
});
