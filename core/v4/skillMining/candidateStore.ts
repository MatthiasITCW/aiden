/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/skillMining/candidateStore.ts — Phase v4.1-skill-mining
 *
 * Atomic JSON queue for mined skill candidates and rejection
 * fingerprints. Two files under `<aidenHome>/skills/learned/`:
 *
 *   - `.candidates.json` — pending review queue, append-only via
 *     this module. `/skills review` reads it; `/skills accept`
 *     and `/skills reject` mutate it.
 *
 *   - `.rejected.json` — fingerprint set the dedup gate consults
 *     so a user-rejected workflow doesn't get re-proposed on the
 *     next matching turn. Keyed by fingerprint, not id, so the
 *     dedup survives across the candidate's lifecycle.
 *
 * Concurrency: a per-process write queue serialises every mutation
 * (mirrors the BundledManifest pattern at
 * `core/v4/skillBundledManifest.ts:50-53`). Cross-process safety
 * is non-goal — the agent is a single-user CLI.
 *
 * Atomicity: writes go to a sibling `.tmp` file then `rename` over
 * the live path. Windows rename is atomic on the same volume so a
 * crash mid-write never leaves a partial JSON file.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { resolveAidenPaths } from '../paths';

export interface MinedCandidate {
  id:                   string;
  fingerprint:          string;
  sourceSessionId:      string;
  sourceTurnIdx:        number;
  createdAt:            string;
  candidateConfidence:  number;
  /** Full SKILL.md text — frontmatter + body. */
  skillContent:         string;
}

export interface RejectedFingerprint {
  fingerprint: string;
  reason?:     string;
  rejectedAt:  string;
}

interface CandidatesEnvelope {
  version:    1;
  candidates: MinedCandidate[];
}

interface RejectedEnvelope {
  version:  1;
  rejected: RejectedFingerprint[];
}

const ENVELOPE_VERSION = 1;

export class CandidateStore {
  private writeQueue: Promise<unknown> = Promise.resolve();

  /** `<aidenHome>/skills/learned/`. */
  private dir(): string {
    return path.join(resolveAidenPaths().skillsDir, 'learned');
  }
  private candidatesPath(): string {
    return path.join(this.dir(), '.candidates.json');
  }
  private rejectedPath(): string {
    return path.join(this.dir(), '.rejected.json');
  }

  private async ensureDir(): Promise<void> {
    await fsp.mkdir(this.dir(), { recursive: true });
  }

  private async readJson<T>(p: string, fallback: T): Promise<T> {
    try {
      const raw = await fsp.readFile(p, 'utf8');
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  /** Atomic `tmp` + rename. */
  private async writeJsonAtomic(p: string, data: unknown): Promise<void> {
    await this.ensureDir();
    const tmp = `${p}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fsp.rename(tmp, p);
  }

  /** Append a candidate to the pending queue. Returns the assigned id. */
  async append(candidate: MinedCandidate): Promise<MinedCandidate> {
    return new Promise((resolve, reject) => {
      this.writeQueue = this.writeQueue.then(async () => {
        try {
          const env = await this.readJson<CandidatesEnvelope>(this.candidatesPath(), {
            version: ENVELOPE_VERSION,
            candidates: [],
          });
          env.version = ENVELOPE_VERSION;
          env.candidates.push(candidate);
          await this.writeJsonAtomic(this.candidatesPath(), env);
          resolve(candidate);
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  /** Read the full pending queue, newest last. */
  async list(): Promise<MinedCandidate[]> {
    const env = await this.readJson<CandidatesEnvelope>(this.candidatesPath(), {
      version: ENVELOPE_VERSION,
      candidates: [],
    });
    return env.candidates ?? [];
  }

  /** Fetch a single candidate by id, or undefined. */
  async get(id: string): Promise<MinedCandidate | undefined> {
    const all = await this.list();
    return all.find((c) => c.id === id);
  }

  /** Remove a candidate by id. No-op if missing. */
  async remove(id: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.writeQueue = this.writeQueue.then(async () => {
        try {
          const env = await this.readJson<CandidatesEnvelope>(this.candidatesPath(), {
            version: ENVELOPE_VERSION,
            candidates: [],
          });
          env.version = ENVELOPE_VERSION;
          env.candidates = env.candidates.filter((c) => c.id !== id);
          await this.writeJsonAtomic(this.candidatesPath(), env);
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  /** Append a rejection fingerprint (with optional reason). */
  async recordRejection(fingerprint: string, reason?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.writeQueue = this.writeQueue.then(async () => {
        try {
          const env = await this.readJson<RejectedEnvelope>(this.rejectedPath(), {
            version: ENVELOPE_VERSION,
            rejected: [],
          });
          env.version = ENVELOPE_VERSION;
          env.rejected.push({
            fingerprint,
            reason,
            rejectedAt: new Date().toISOString(),
          });
          await this.writeJsonAtomic(this.rejectedPath(), env);
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  /** Return the set of rejected fingerprints (for dedup). */
  async loadRejected(): Promise<Set<string>> {
    const env = await this.readJson<RejectedEnvelope>(this.rejectedPath(), {
      version: ENVELOPE_VERSION,
      rejected: [],
    });
    return new Set((env.rejected ?? []).map((r) => r.fingerprint));
  }

  /** Test/reset hook: drop the in-process write queue. Disk untouched. */
  _resetForTests(): void {
    this.writeQueue = Promise.resolve();
  }
}
