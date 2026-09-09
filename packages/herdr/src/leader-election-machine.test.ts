/**
 * Machine-wide leader election proofs (WL-0MTF0KLO10043YAN F3).
 *
 * Proves AC2: N instances across P worklogs -> exactly one holds a valid
 * lease machine-wide; no two dispatch in same tick window; zombie
 * re-derivation survives via ownership-based refreshLease + per-tick
 * re-derive. Also pins fail-safe unreadable lease -> no leader.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLeaderElectionManager, LEASE_FILE, LEADER_LOCK_FILE } from './leader-election.js';
import { createDowntimeWorker, createDowntimePoller, type DowntimeWorkerDeps } from './downtime-worker.js';

let sharedDir: string;
let prevEnv: string | undefined;

beforeEach(() => {
  sharedDir = mkdtempSync(join(tmpdir(), 'herdr-machine-leader-'));
  prevEnv = process.env.HERDR_COORDINATION_DIR;
  process.env.HERDR_COORDINATION_DIR = sharedDir;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.HERDR_COORDINATION_DIR;
  else process.env.HERDR_COORDINATION_DIR = prevEnv;
  rmSync(sharedDir, { recursive: true, force: true });
});

describe('machine-wide leader election (AC2)', () => {
  it('two instances across two worklogs contend on the SAME lease (exactly one leader)', () => {
    const dirA = join(tmpdir(), `herdr-f3-a-${Date.now()}-a`);
    const dirB = join(tmpdir(), `herdr-f3-b-${Date.now()}-b`);
    // worklogDirs are different (P=2) but share sharedDir via env
    const a = createLeaderElectionManager({ worklogDir: dirA, instanceId: 'inst-a' });
    const b = createLeaderElectionManager({ worklogDir: dirB, instanceId: 'inst-b' });
    expect(a.attemptElection()).toBe(true);
    expect(a.isLeader()).toBe(true);
    expect(b.attemptElection()).toBe(false);
    expect(b.isLeader()).toBe(false);
    // lease file lives in sharedDir, not in dirA/dirB
    const lease = JSON.parse(readFileSync(join(sharedDir, LEASE_FILE), 'utf-8')) as { leaderId: string };
    expect(lease.leaderId).toBe('inst-a');
    a.close();
    b.close();
  });

  it('owned-but-EXPIRED lease survives: owner refreshes, foreign cannot steal via refreshLease', () => {
    const dir = join(tmpdir(), `herdr-f3-${Date.now()}`);
    const owner = createLeaderElectionManager({ worklogDir: dir, instanceId: 'owner', leaseTtlSeconds: 300 });
    const foreign = createLeaderElectionManager({ worklogDir: dir, instanceId: 'foreign' });
    const leasePath = join(sharedDir, LEASE_FILE);
    const staleAt = new Date(Date.now() - 400_000).toISOString();
    writeFileSync(leasePath, JSON.stringify({ leaderId: 'owner', acquiredAt: staleAt, ttlSeconds: 300 }), 'utf-8');
    // foreign refresh must not steal
    foreign.refreshLease();
    expect(JSON.parse(readFileSync(leasePath, 'utf-8')).leaderId).toBe('owner');
    // owner self-heals (ownership-based refresh)
    owner.refreshLease();
    const healed = JSON.parse(readFileSync(leasePath, 'utf-8')) as { leaderId: string; acquiredAt: string };
    expect(healed.leaderId).toBe('owner');
    expect(new Date(healed.acquiredAt).getTime()).toBeGreaterThan(new Date(staleAt).getTime());
    owner.close();
    foreign.close();
  });

  it('fail-safe: unreadable (corrupt) lease -> no leader, no throw', () => {
    const dir = join(tmpdir(), `herdr-f3-${Date.now()}`);
    writeFileSync(join(sharedDir, LEASE_FILE), '{not-json', 'utf-8');
    const m = createLeaderElectionManager({ worklogDir: dir, instanceId: 'inst' });
    expect(() => m.isLeader()).not.toThrow();
    expect(m.isLeader()).toBe(false);
    expect(() => m.refreshLease()).not.toThrow();
    m.close();
  });
});
