/**
 * Tests for leader visibility in the shared coordination file
 * (WL-0MW1VINII003IL7R).
 *
 * Incident (2026-11-04): the only instance permitted to dispatch (the elected
 * leader) had NO entry in `downtime-coordination.json`, because a check-in with
 * no candidate removes its own entry ("no dead offers"). The file showed five
 * healthy-looking offers while nothing dispatched anywhere for eight hours, and
 * the refusals existed only in one project's per-root log.
 *
 * Contract under test (option A — additive `leader` block, `entries` stay
 * offers-only):
 *  1. The elected leader is identifiable (instance + worklog root) even with an
 *     empty window.
 *  2. The block carries the leader's most recent dispatch-decision outcome.
 *  3. It is NEVER an offer: `hasPeerOffer`, offer selection and the own-backlog
 *     fallback ignore it entirely.
 *  4. Fail-safe: unreadable/corrupt file degrades to "no leader known"; the
 *     existing entry semantics are untouched.
 *  5. Cross-version: a legacy file without the block reads fine; a legacy
 *     reader ignores the extra key.
 *  6. A stale block (crashed leader) is not reported as a live leader.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readCoordinationFile,
  writeCoordinationFile,
  upsertEntry,
  upsertLeader,
  getLeader,
  removeLeader,
  removeEntry,
  hasPeerOffer,
  COORDINATION_FILE,
  COORDINATION_FILE_VERSION,
  DEFAULT_LEADER_BLOCK_STALE_MS,
  type CoordinationEntry,
  type CoordinationLeader,
} from './coordination.js';

let testDir: string;
let savedCoordDir: string | undefined;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'herdr-leader-'));
  savedCoordDir = process.env.HERDR_COORDINATION_DIR;
  process.env.HERDR_COORDINATION_DIR = testDir;
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  if (savedCoordDir !== undefined) process.env.HERDR_COORDINATION_DIR = savedCoordDir;
  else delete process.env.HERDR_COORDINATION_DIR;
});

function coordPath(): string {
  return join(testDir, COORDINATION_FILE);
}

function makeEntry(instanceId: string, workItemId: string, root = '/repo/a'): CoordinationEntry {
  // `lastUpdated` is FRESH (now) so liveness-aware `hasPeerOffer` sees the
  // entry as live (WL-0MVR8GDJ3008WY3Y AC7). Leader-block semantics — the
  // concern of this suite — are independent of entry liveness.
  const now = new Date().toISOString();
  return {
    instanceId,
    workItemId,
    directory: root,
    worklogRoot: root,
    assignedAt: now,
    lastUpdated: now,
  };
}

function makeLeader(instanceId: string, overrides: Partial<CoordinationLeader> = {}): CoordinationLeader {
  return {
    instanceId,
    worklogRoot: '/repo/leader',
    lastDecisionReason: null,
    lastDecisionAt: null,
    lastUpdated: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. The leader is identifiable even with an empty window
// ---------------------------------------------------------------------------

describe('upsertLeader / getLeader', () => {
  it('records the leader with no offers present (the incident shape)', () => {
    // The leader's own check-in removed its entry (empty window), and no peer
    // has an offer: the file must still name the dispatcher.
    writeCoordinationFile(testDir, { version: COORDINATION_FILE_VERSION, entries: [] });

    const wrote = upsertLeader(testDir, makeLeader('leader-1', {
      lastDecisionReason: 'slots-unavailable',
      lastDecisionAt: '2026-11-04T00:16:13.729Z',
    }));

    expect(wrote).toBe(true);
    const leader = getLeader(testDir);
    expect(leader).not.toBeNull();
    expect(leader!.instanceId).toBe('leader-1');
    expect(leader!.worklogRoot).toBe('/repo/leader');
    expect(leader!.lastDecisionReason).toBe('slots-unavailable');
    expect(leader!.lastDecisionAt).toBe('2026-11-04T00:16:13.729Z');
    // ... and it did not fabricate an offer.
    expect(readCoordinationFile(testDir)!.entries).toEqual([]);
  });

  it('creates the file when it does not exist yet', () => {
    expect(getLeader(testDir)).toBeNull();
    expect(upsertLeader(testDir, makeLeader('leader-1'))).toBe(true);
    expect(getLeader(testDir)!.instanceId).toBe('leader-1');
  });

  it('replaces the previous leader block (one leader per machine)', () => {
    upsertLeader(testDir, makeLeader('leader-1'));
    upsertLeader(testDir, makeLeader('leader-2', { worklogRoot: '/repo/b' }));

    const data = readCoordinationFile(testDir)!;
    expect(data.leader!.instanceId).toBe('leader-2');
    expect(getLeader(testDir)!.worklogRoot).toBe('/repo/b');
  });

  it('removes the block on release', () => {
    upsertLeader(testDir, makeLeader('leader-1'));
    expect(removeLeader(testDir)).toBe(true);
    expect(getLeader(testDir)).toBeNull();
  });

  it('removeLeader is idempotent and fail-safe with no file', () => {
    expect(removeLeader(testDir)).toBe(false);
    upsertLeader(testDir, makeLeader('leader-1'));
    expect(removeLeader(testDir)).toBe(true);
    expect(removeLeader(testDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Staleness: a crashed leader is not reported as live
// ---------------------------------------------------------------------------

describe('leader freshness', () => {
  it('reports a fresh block', () => {
    const now = Date.parse('2026-11-04T08:00:00.000Z');
    upsertLeader(testDir, makeLeader('leader-1', { lastUpdated: '2026-11-04T07:59:00.000Z' }));
    expect(getLeader(testDir, { nowMs: now })!.instanceId).toBe('leader-1');
  });

  it('suppresses a block older than the stale window', () => {
    const now = Date.parse('2026-11-04T08:00:00.000Z');
    upsertLeader(testDir, makeLeader('leader-1', { lastUpdated: '2026-11-04T07:00:00.000Z' }));
    expect(getLeader(testDir, { nowMs: now })).toBeNull();
  });

  it('honours an explicit stale window', () => {
    const now = Date.parse('2026-11-04T08:00:00.000Z');
    upsertLeader(testDir, makeLeader('leader-1', { lastUpdated: '2026-11-04T07:00:00.000Z' }));
    expect(getLeader(testDir, { nowMs: now, staleMs: 2 * 60 * 60 * 1000 })!.instanceId).toBe('leader-1');
    expect(getLeader(testDir, { nowMs: now, staleMs: 60 * 1000 })).toBeNull();
  });

  it('defaults the stale window to two lease generations', () => {
    // One missed leader check-in (240 s cadence) must not read as dead, and a
    // dead leader must not survive more than two 300 s lease generations.
    expect(DEFAULT_LEADER_BLOCK_STALE_MS).toBe(600_000);
    expect(DEFAULT_LEADER_BLOCK_STALE_MS).toBeGreaterThan(240_000);
  });

  it('treats an unparseable timestamp as stale rather than live', () => {
    const now = Date.parse('2026-11-04T08:00:00.000Z');
    upsertLeader(testDir, makeLeader('leader-1', { lastUpdated: 'not-a-date' }));
    expect(getLeader(testDir, { nowMs: now })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. The leader block is NEVER an offer
// ---------------------------------------------------------------------------

describe('the leader block is never an offer', () => {
  it('hasPeerOffer ignores a leader block with no entries', () => {
    upsertLeader(testDir, makeLeader('leader-1'));
    const data = readCoordinationFile(testDir)!;
    expect(data.entries).toEqual([]);
    // The leader's own view: no peer offer exists, so no-candidate may arm.
    expect(hasPeerOffer(data.entries, 'leader-1')).toBe(false);
    expect(hasPeerOffer(data.entries, 'someone-else')).toBe(false);
  });

  it('hasPeerOffer still sees real peer offers alongside a leader block', () => {
    upsertLeader(testDir, makeLeader('leader-1'));
    upsertEntry(testDir, makeEntry('worker-2', 'WL-ABC', '/repo/b'));
    const data = readCoordinationFile(testDir)!;
    expect(hasPeerOffer(data.entries, 'leader-1')).toBe(true);
    // Exactly one offer, and it is the worker's — not the leader's.
    expect(data.entries.length).toBe(1);
    expect(data.entries[0].instanceId).toBe('worker-2');
  });

  it('the leader may also hold an offer, and both survive independently', () => {
    upsertLeader(testDir, makeLeader('leader-1'));
    upsertEntry(testDir, makeEntry('leader-1', 'WL-OWN', '/repo/leader'));
    const data = readCoordinationFile(testDir)!;
    expect(data.entries.length).toBe(1);
    expect(data.entries[0].workItemId).toBe('WL-OWN');
    expect(data.leader!.instanceId).toBe('leader-1');
  });
});

// ---------------------------------------------------------------------------
// 4. The block never disturbs entry semantics (no dead offers)
// ---------------------------------------------------------------------------

describe('entry semantics are preserved', () => {
  it('a leader-block write does not resurrect a removed offer', () => {
    upsertEntry(testDir, makeEntry('leader-1', 'WL-OWN', '/repo/leader'));
    // The leader dispatched it → its own entry is removed.
    expect(removeEntry(testDir, 'leader-1')).not.toBeNull();
    // The heartbeat still refreshes the leader block ...
    upsertLeader(testDir, makeLeader('leader-1'));
    // ... without re-creating the dead offer.
    expect(readCoordinationFile(testDir)!.entries).toEqual([]);
  });

  it('an entry write does not drop the leader block', () => {
    upsertLeader(testDir, makeLeader('leader-1'));
    upsertEntry(testDir, makeEntry('worker-2', 'WL-ABC', '/repo/b'));
    expect(getLeader(testDir)!.instanceId).toBe('leader-1');
  });

  it('removing another instance entry does not drop the leader block', () => {
    upsertLeader(testDir, makeLeader('leader-1'));
    upsertEntry(testDir, makeEntry('worker-2', 'WL-ABC', '/repo/b'));
    expect(removeEntry(testDir, 'worker-2')).not.toBeNull();
    expect(getLeader(testDir)!.instanceId).toBe('leader-1');
  });
});

// ---------------------------------------------------------------------------
// 5. Cross-version compatibility
// ---------------------------------------------------------------------------

describe('cross-version compatibility', () => {
  it('reads a legacy file with no leader block', () => {
    writeFileSync(
      coordPath(),
      JSON.stringify({
        version: COORDINATION_FILE_VERSION,
        entries: [makeEntry('worker-1', 'WL-LEGACY', '/repo/a')],
      }),
      'utf-8',
    );
    expect(getLeader(testDir)).toBeNull();
    const data = readCoordinationFile(testDir)!;
    expect(data.entries.length).toBe(1);
    expect(data.leader).toBeUndefined();
  });

  it('a legacy-shaped read still works when the block is present', () => {
    upsertLeader(testDir, makeLeader('leader-1'));
    upsertEntry(testDir, makeEntry('worker-2', 'WL-ABC', '/repo/b'));
    // A pre-feature reader reads `version`/`entries` and ignores `leader`.
    const raw = JSON.parse(readFileSync(coordPath(), 'utf-8'));
    expect(raw.version).toBe(COORDINATION_FILE_VERSION);
    expect(raw.entries.length).toBe(1);
    expect(raw.leader.instanceId).toBe('leader-1');
  });

  it('a malformed leader block is ignored, not fatal', () => {
    writeFileSync(
      coordPath(),
      JSON.stringify({
        version: COORDINATION_FILE_VERSION,
        entries: [makeEntry('worker-1', 'WL-OK', '/repo/a')],
        leader: { instanceId: 42, worklogRoot: null },
      }),
      'utf-8',
    );
    expect(getLeader(testDir)).toBeNull();
    // The entries are still readable — a bad block never costs an offer.
    expect(readCoordinationFile(testDir)!.entries.length).toBe(1);
  });

  it('preserves the block across an unrelated read/write cycle', () => {
    upsertLeader(testDir, makeLeader('leader-1', { lastDecisionReason: 'proxy-contention' }));
    const data = readCoordinationFile(testDir)!;
    writeCoordinationFile(testDir, { ...data });
    const after = getLeader(testDir)!;
    expect(after.lastDecisionReason).toBe('proxy-contention');
  });
});

// ---------------------------------------------------------------------------
// 6. Fail-safe behaviour
// ---------------------------------------------------------------------------

describe('fail-safe', () => {
  it('getLeader returns null for a corrupt file', () => {
    writeFileSync(coordPath(), '{not json', 'utf-8');
    expect(getLeader(testDir)).toBeNull();
  });

  it('upsertLeader fails open when the file is corrupt in a way that blocks writes', () => {
    // A directory where the file should be is unwritable → false, never throws.
    rmSync(testDir, { recursive: true, force: true });
    expect(() => upsertLeader(testDir, makeLeader('leader-1'))).not.toThrow();
  });
});
