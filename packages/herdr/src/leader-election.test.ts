/**
 * Unit tests for leader-election.ts — file-lock leader election with
 * 5-minute lease management (WL-0MSXH3UF5000HJUS, parent
 * WL-0MST3OJ8S0001ROL).
 *
 * Tests cover:
 *  - Lock acquisition (first to write wins)
 *  - Lease creation and reading
 *  - Lease expiry detection
 *  - Stale leader detection
 *  - Re-election after expiry
 *  - Graceful degradation when coordination file is missing
 *  - Leadership release
 *  - Instance ID generation
 *  - Cleanup of stale election files
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLeaderElectionManager,
  runElectionWithRetry,
  checkForStaleLeader,
  cleanupStaleElection,
  isLeaseExpired,
  isLeaseValid,
  DEFAULT_LEASE_TTL_SECONDS,
  LEADER_LOCK_FILE,
  LEASE_FILE,
} from './leader-election.js';

// ── Test fixtures ──────────────────────────────────────────────────────

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'herdr-leader-election-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

/** Helper: create a manager for the test directory. */
function makeManager(opts?: {
  instanceId?: string;
  leaseTtlSeconds?: number;
}): ReturnType<typeof createLeaderElectionManager> {
  return createLeaderElectionManager({
    worklogDir: testDir,
    instanceId: opts?.instanceId,
    leaseTtlSeconds: opts?.leaseTtlSeconds,
  });
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('createLeaderElectionManager', () => {
  it('creates a manager with a generated instance ID', () => {
    const manager = makeManager();
    expect(manager.getInstanceId()).toBeTruthy();
    expect(typeof manager.getInstanceId()).toBe('string');
    expect(manager.worklogDir).toBe(testDir);
    manager.close();
  });

  it('creates a manager with a provided instance ID', () => {
    const manager = makeManager({ instanceId: 'test-instance-1' });
    expect(manager.getInstanceId()).toBe('test-instance-1');
    manager.close();
  });
});

describe('isLeader', () => {
  it('returns false when no lease exists', () => {
    const manager = makeManager();
    expect(manager.isLeader()).toBe(false);
    manager.close();
  });

  it('returns true after successful election', async () => {
    const manager = makeManager({ instanceId: 'test-instance-1' });
    const result = await runElectionWithRetry({
      worklogDir: testDir,
      instanceId: 'test-instance-1',
    });
    expect(result.isLeader).toBe(true);
    // Check directly
    expect(manager.isLeader()).toBe(true);
    manager.close();
  });

  it('returns false when another instance is leader', async () => {
    // Instance 1 becomes leader
    const result1 = await runElectionWithRetry({
      worklogDir: testDir,
      instanceId: 'test-instance-1',
    });
    expect(result1.isLeader).toBe(true);

    // Instance 2 tries election — should fail
    const result2 = await runElectionWithRetry({
      worklogDir: testDir,
      instanceId: 'test-instance-2',
    });
    expect(result2.isLeader).toBe(false);
    expect(result2.leaderId).toBe('test-instance-1');
  });

  it('returns false after close', () => {
    const manager = makeManager();
    manager.close();
    expect(manager.isLeader()).toBe(false);
  });
});

describe('refreshLease', () => {
  it('refreshes the lease for the leader', async () => {
    const manager = makeManager({ instanceId: 'test-instance-1' });
    await runElectionWithRetry({
      worklogDir: testDir,
      instanceId: 'test-instance-1',
    });
    expect(manager.isLeader()).toBe(true);

    // Refresh
    manager.refreshLease();

    // Read the lease file directly
    const leasePath = join(testDir, LEASE_FILE);
    expect(existsSync(leasePath)).toBe(true);
    const lease = JSON.parse(readFileSync(leasePath, 'utf-8')) as { leaderId: string; acquiredAt: string };
    expect(lease.leaderId).toBe('test-instance-1');
    manager.close();
  });

  it('does nothing when not leader', () => {
    const manager = makeManager({ instanceId: 'test-instance-1' });
    manager.refreshLease(); // Should silently do nothing
    const leasePath = join(testDir, LEASE_FILE);
    expect(existsSync(leasePath)).toBe(false);
    manager.close();
  });

  // ── F4 self-heal (parent WL-0MTEZ5EK5002RXXD, child F3 red→green) ──
  // Hole A in the zombie-leader scenario: isLeader() requires > MIN_VALID_LEASE_TTL_MS
  // remaining, so an OWNED-but-EXPIRED lease makes refreshLease() no-op — the
  // lease is never renewed and the worker stays leader-cached with a dead lease.
  // F4 must treat OWNED leases as refreshable regardless of validity; F3 pins it.

  it('self-heals: renews an owned-but-EXPIRED lease instead of no-oping (F4 AC1)', () => {
    const manager = makeManager({ instanceId: 'test-instance-1', leaseTtlSeconds: 300 });
    const leasePath = join(testDir, LEASE_FILE);
    // Owned lease but expired (> 300s TTL ago). isLeader() → false on current
    // code, so the `if (!this.isLeader()) return` guard no-ops → RED.
    const staleAcquiredAt = new Date(Date.now() - 400_000).toISOString();
    writeFileSync(
      leasePath,
      JSON.stringify({ leaderId: 'test-instance-1', acquiredAt: staleAcquiredAt, ttlSeconds: 300 }),
      'utf-8',
    );

    manager.refreshLease();

    const lease = JSON.parse(readFileSync(leasePath, 'utf-8')) as {
      leaderId: string;
      acquiredAt: string;
      ttlSeconds: number;
    };
    expect(lease.leaderId).toBe('test-instance-1');
    // RED on current code: refreshLease() no-oped → acquiredAt is still stale.
    expect(new Date(lease.acquiredAt).getTime()).toBeGreaterThan(new Date(staleAcquiredAt).getTime());
    // Belt: the self-healed lease is valid again (full TTL from now).
    expect(isLeaseValid(lease)).toBe(true);
    manager.close();
  });

  it('never renews a valid lease owned by another instance (F4 AC2)', () => {
    const manager = makeManager({ instanceId: 'test-instance-1' });
    const leasePath = join(testDir, LEASE_FILE);
    const foreign = {
      leaderId: 'other-instance',
      acquiredAt: new Date(Date.now() - 60_000).toISOString(), // valid (TTL 300s)
      ttlSeconds: 300,
    };
    writeFileSync(leasePath, JSON.stringify(foreign), 'utf-8');

    manager.refreshLease();

    const lease = JSON.parse(readFileSync(leasePath, 'utf-8')) as {
      leaderId: string;
      acquiredAt: string;
    };
    expect(lease.leaderId).toBe('other-instance');
    expect(lease.acquiredAt).toBe(foreign.acquiredAt); // unchanged — never renews foreign
    manager.close();
  });

  it('does not steal leadership from an EXPIRED foreign lease (F4 AC2b)', () => {
    // Strongest anti-steal pin: even when the foreign lease has expired, the
    // takeover must go through the election path (detectStaleLeader), never
    // through refreshLease for a lease we do not own.
    const manager = makeManager({ instanceId: 'test-instance-1' });
    const leasePath = join(testDir, LEASE_FILE);
    const staleForeign = {
      leaderId: 'other-instance',
      acquiredAt: new Date(Date.now() - 400_000).toISOString(), // expired
      ttlSeconds: 300,
    };
    writeFileSync(leasePath, JSON.stringify(staleForeign), 'utf-8');

    manager.refreshLease();

    const lease = JSON.parse(readFileSync(leasePath, 'utf-8')) as {
      leaderId: string;
      acquiredAt: string;
    };
    expect(lease.leaderId).toBe('other-instance');
    expect(lease.acquiredAt).toBe(staleForeign.acquiredAt); // unchanged
    manager.close();
  });

  it('fails safe: no-ops on an unreadable (corrupt) lease file (F4 AC3)', () => {
    const manager = makeManager({ instanceId: 'test-instance-1' });
    const leasePath = join(testDir, LEASE_FILE);
    writeFileSync(leasePath, '{not-valid-json', 'utf-8');

    expect(() => manager.refreshLease()).not.toThrow();
    // Treated as missing — the corrupt file must NOT be overwritten (would
    // otherwise clobber a legitimately written lease mid-write).
    expect(readFileSync(leasePath, 'utf-8')).toBe('{not-valid-json');
    manager.close();
  });
});

describe('detectStaleLeader', () => {
  it('returns false when no lease exists', () => {
    const manager = makeManager();
    expect(manager.detectStaleLeader()).toBe(false);
    manager.close();
  });

  it('returns false when we are the leader', async () => {
    const manager = makeManager({ instanceId: 'test-instance-1' });
    await runElectionWithRetry({
      worklogDir: testDir,
      instanceId: 'test-instance-1',
    });
    expect(manager.detectStaleLeader()).toBe(false);
    manager.close();
  });

  it('returns false when another instance is leader and lease is valid', async () => {
    // Write a lease for another instance
    const leasePath = join(testDir, LEASE_FILE);
    const lease = {
      leaderId: 'other-instance',
      acquiredAt: new Date(Date.now() - 60_000).toISOString(), // 1 min ago
      ttlSeconds: 300, // 5 min TTL
    };
    writeFileSync(leasePath, JSON.stringify(lease), 'utf-8');

    const manager = makeManager();
    expect(manager.detectStaleLeader()).toBe(false);
    manager.close();
  });

  it('returns true when leader lease is expired', async () => {
    // Write a stale lease for another instance
    const leasePath = join(testDir, LEASE_FILE);
    const lease = {
      leaderId: 'other-instance',
      acquiredAt: new Date(Date.now() - 400_000).toISOString(), // 6+ min ago
      ttlSeconds: 300, // 5 min TTL
    };
    writeFileSync(leasePath, JSON.stringify(lease), 'utf-8');

    const manager = makeManager();
    expect(manager.detectStaleLeader()).toBe(true);
    manager.close();
  });
});

describe('hasLease', () => {
  it('returns false when no lease exists', () => {
    const manager = makeManager();
    expect(manager.hasLease()).toBe(false);
    manager.close();
  });

  it('returns true after a successful election', async () => {
    const manager = makeManager({ instanceId: 'inst-1' });
    await runElectionWithRetry({ worklogDir: testDir, instanceId: 'inst-1' });
    expect(manager.hasLease()).toBe(true);
    manager.close();
  });

  it('returns true for an expired lease (stale detection still sees it)', () => {
    const leasePath = join(testDir, LEASE_FILE);
    writeFileSync(leasePath, JSON.stringify({
      leaderId: 'dead',
      acquiredAt: new Date(Date.now() - 400_000).toISOString(),
      ttlSeconds: 300,
    }), 'utf-8');
    const manager = makeManager();
    expect(manager.hasLease()).toBe(true);
    expect(manager.detectStaleLeader()).toBe(true);
    manager.close();
  });
});

describe('attemptElection', () => {
  it('wins election when no one else is leader', () => {
    const manager = makeManager({ instanceId: 'test-instance-1' });
    const result = manager.attemptElection();
    expect(result).toBe(true);
    expect(manager.isLeader()).toBe(true);
    manager.close();
  });

  it('loses election when lock is held by another', () => {
    // Pre-existing lock file
    const lockPath = join(testDir, LEADER_LOCK_FILE);
    writeFileSync(lockPath, 'other-instance', 'utf-8');

    const manager = makeManager({ instanceId: 'test-instance-1' });
    const result = manager.attemptElection();
    expect(result).toBe(false);
    expect(manager.isLeader()).toBe(false);
    manager.close();
  });
});

describe('releaseLeadership', () => {
  it('releases leadership and cleans up files', async () => {
    const manager = makeManager({ instanceId: 'test-instance-1' });
    await runElectionWithRetry({
      worklogDir: testDir,
      instanceId: 'test-instance-1',
    });
    expect(manager.isLeader()).toBe(true);

    const lockPath = join(testDir, LEADER_LOCK_FILE);
    const leasePath = join(testDir, LEASE_FILE);
    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(leasePath)).toBe(true);

    manager.releaseLeadership();
    expect(manager.isLeader()).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(leasePath)).toBe(false);
  });
});

describe('runElectionWithRetry', () => {
  it('succeeds when no other instance is running', async () => {
    const result = await runElectionWithRetry({
      worklogDir: testDir,
      instanceId: 'test-instance-1',
    });
    expect(result.isLeader).toBe(true);
    expect(result.leaderId).toBe('test-instance-1');
  });

  it('fails when another instance already holds leadership', async () => {
    // First, make instance-1 the leader
    const lockPath = join(testDir, LEADER_LOCK_FILE);
    const leasePath = join(testDir, LEASE_FILE);
    writeFileSync(lockPath, 'instance-1', 'utf-8');
    writeFileSync(leasePath, JSON.stringify({
      leaderId: 'instance-1',
      acquiredAt: new Date().toISOString(),
      ttlSeconds: 300,
    }), 'utf-8');

    // Instance-2 tries election
    const result = await runElectionWithRetry({
      worklogDir: testDir,
      instanceId: 'instance-2',
    });
    expect(result.isLeader).toBe(false);
  });

  it('detects stale leader and wins re-election', async () => {
    // Write a stale lease
    const leasePath = join(testDir, LEASE_FILE);
    const lockPath = join(testDir, LEADER_LOCK_FILE);
    writeFileSync(leasePath, JSON.stringify({
      leaderId: 'stale-instance',
      acquiredAt: new Date(Date.now() - 400_000).toISOString(), // Expired
      ttlSeconds: 300,
    }), 'utf-8');
    writeFileSync(lockPath, 'stale-instance', 'utf-8');

    let staleDetected = false;
    const result = await runElectionWithRetry({
      worklogDir: testDir,
      instanceId: 'new-instance',
      onStaleDetect: () => { staleDetected = true; },
    });

    expect(result.isLeader).toBe(true);
    expect(staleDetected).toBe(true);
  });
});

describe('checkForStaleLeader', () => {
  it('returns false when no lease exists', () => {
    expect(checkForStaleLeader({ worklogDir: testDir })).toBe(false);
  });

  it('returns false when lease is valid', () => {
    const leasePath = join(testDir, LEASE_FILE);
    writeFileSync(leasePath, JSON.stringify({
      leaderId: 'current-leader',
      acquiredAt: new Date().toISOString(),
      ttlSeconds: 300,
    }), 'utf-8');

    expect(checkForStaleLeader({ worklogDir: testDir })).toBe(false);
  });

  it('returns true when lease is expired', () => {
    const leasePath = join(testDir, LEASE_FILE);
    writeFileSync(leasePath, JSON.stringify({
      leaderId: 'stale-leader',
      acquiredAt: new Date(Date.now() - 400_000).toISOString(),
      ttlSeconds: 300,
    }), 'utf-8');

    expect(checkForStaleLeader({ worklogDir: testDir })).toBe(true);
  });
});

describe('cleanupStaleElection', () => {
  it('removes orphaned lock and expired lease', () => {
    const lockPath = join(testDir, LEADER_LOCK_FILE);
    const leasePath = join(testDir, LEASE_FILE);

    writeFileSync(lockPath, 'stale-instance', 'utf-8');
    writeFileSync(leasePath, JSON.stringify({
      leaderId: 'stale-instance',
      acquiredAt: new Date(Date.now() - 400_000).toISOString(),
      ttlSeconds: 300,
    }), 'utf-8');

    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(leasePath)).toBe(true);

    cleanupStaleElection({ worklogDir: testDir });

    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(leasePath)).toBe(false);
  });

  it('does not remove active election files', () => {
    const lockPath = join(testDir, LEADER_LOCK_FILE);
    const leasePath = join(testDir, LEASE_FILE);

    writeFileSync(lockPath, 'active-instance', 'utf-8');
    writeFileSync(leasePath, JSON.stringify({
      leaderId: 'active-instance',
      acquiredAt: new Date().toISOString(),
      ttlSeconds: 300,
    }), 'utf-8');

    cleanupStaleElection({ worklogDir: testDir });

    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(leasePath)).toBe(true);
  });
});

describe('isLeaseExpired', () => {
  it('returns true for expired lease', () => {
    const lease = {
      leaderId: 'test',
      acquiredAt: new Date(Date.now() - 400_000).toISOString(), // 6+ min ago
      ttlSeconds: 300, // 5 min TTL
    };
    expect(isLeaseExpired(lease)).toBe(true);
  });

  it('returns false for valid lease', () => {
    const lease = {
      leaderId: 'test',
      acquiredAt: new Date().toISOString(),
      ttlSeconds: 300,
    };
    expect(isLeaseExpired(lease)).toBe(false);
  });
});

describe('isLeaseValid', () => {
  it('returns true for a lease with plenty of time remaining', () => {
    const lease = {
      leaderId: 'test',
      acquiredAt: new Date().toISOString(),
      ttlSeconds: 300,
    };
    expect(isLeaseValid(lease)).toBe(true);
  });

  it('returns false for an expired lease', () => {
    const lease = {
      leaderId: 'test',
      acquiredAt: new Date(Date.now() - 400_000).toISOString(),
      ttlSeconds: 300,
    };
    expect(isLeaseValid(lease)).toBe(false);
  });

  it('returns false for null lease', () => {
    expect(isLeaseValid(null as unknown as ReturnType<typeof createLeaderElectionManager> extends { isLeader(): boolean } ? any : any)).toBe(false);
  });
});

describe('graceful degradation', () => {
  it('manages work without any election files', () => {
    // Empty directory — no files
    const manager = makeManager({ instanceId: 'test-instance-1' });
    expect(manager.isLeader()).toBe(false);
    expect(manager.detectStaleLeader()).toBe(false);
    manager.close();
  });

  it('handles missing coordination file scenario', () => {
    // No lease or lock files — should not throw
    const manager = makeManager();
    expect(() => manager.isLeader()).not.toThrow();
    expect(() => manager.detectStaleLeader()).not.toThrow();
    expect(() => manager.refreshLease()).not.toThrow();
    manager.close();
  });
});
