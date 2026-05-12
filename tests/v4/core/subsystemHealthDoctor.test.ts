/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * Phase v4.1.2-slice3 — verifies `renderSubsystemHealthSection`
 * follows the slice3 Q4 decision: omit entirely when no registry,
 * one-line green summary when all subsystems healthy, expanded
 * block only on degradation (with the explicit "honesty (not
 * instrumented yet)" tail).
 */
import { describe, it, expect } from 'vitest';
import { renderSubsystemHealthSection } from '../../../cli/v4/doctor';
import {
  createSubsystemHealthRegistry,
  SubsystemHealthTracker,
} from '../../../core/v4/subsystemHealth';

describe('renderSubsystemHealthSection', () => {
  it('renders nothing when no registry is passed', () => {
    expect(renderSubsystemHealthSection(undefined)).toBe('');
  });

  it('renders nothing when the registry is empty', () => {
    const r = createSubsystemHealthRegistry();
    expect(renderSubsystemHealthSection(r)).toBe('');
  });

  it('renders the green one-liner when every subsystem is healthy', () => {
    const r = createSubsystemHealthRegistry();
    const t1 = new SubsystemHealthTracker('skill-teacher');
    const t2 = new SubsystemHealthTracker('skill-miner');
    t1.recordSuccess();
    t2.recordSuccess();
    r.register('skill-teacher', () => t1.snapshot());
    r.register('skill-miner',   () => t2.snapshot());
    const out = renderSubsystemHealthSection(r);
    expect(out).toContain('all green');
    expect(out).toContain('2 subsystems');
    // No degraded block, no honesty tail in green path.
    expect(out).not.toContain('not instrumented');
    expect(out).not.toContain('last');
  });

  it('expands to the per-subsystem block on degradation', () => {
    const r = createSubsystemHealthRegistry();
    const teacher = new SubsystemHealthTracker('skill-teacher');
    const miner   = new SubsystemHealthTracker('skill-miner');
    miner.recordFailure(new Error('parseSkillContent: malformed YAML'));
    teacher.recordSuccess();
    r.register('skill-teacher', () => teacher.snapshot());
    r.register('skill-miner',   () => miner.snapshot());
    const out = renderSubsystemHealthSection(r);
    expect(out).toContain('Subsystem health');
    expect(out).toContain('skill-teacher');
    expect(out).toContain('skill-miner');
    expect(out).toContain('malformed YAML');
    // Honesty is explicitly surfaced as un-instrumented when expanded.
    expect(out).toContain('honesty');
    expect(out).toContain('not instrumented yet');
  });

  it('renders the consecutive-failure streak when >1', () => {
    const r = createSubsystemHealthRegistry();
    const t = new SubsystemHealthTracker('compressor');
    t.recordFailure('aux 500');
    t.recordFailure('aux 500');
    t.recordFailure('aux 500');
    r.register('compressor', () => t.snapshot());
    const out = renderSubsystemHealthSection(r);
    expect(out).toContain('3 consecutive');
  });

  it('omits the streak suffix when only one failure has occurred', () => {
    const r = createSubsystemHealthRegistry();
    const t = new SubsystemHealthTracker('compressor');
    t.recordFailure('one-off');
    r.register('compressor', () => t.snapshot());
    const out = renderSubsystemHealthSection(r);
    expect(out).not.toContain('consecutive');
  });
});
