/**
 * Unit tests for coordination.ts — shared downtime coordination file
 * (WL-0MSXH9UT6008151F, parent WL-0MST3OJ8S0001ROL).
 *
 * Tests cover:
 *  - File format (version + per-instance entries)
 *  - Entry upsert / update / removal
 *  - Exclusive-lock serialization (concurrent write contention)
 *  - Stale-entry pruning (5-minute lease bound)
 *  - Fail-safe behavior (missing / corrupt file, lock contention)
 *  - Atomic write (tmp+rename — no partial JSON)
 *  - Machine-wide shared file (WL-0MTII3YH20044XYL): different worklog roots share one machine file
 *  - worklogRoot compat: directory/worklogRoot alias, backward compat, normalization
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readCoordinationFile,
  writeCoordinationFile,
  upsertEntry,
  removeEntry,
  getEntry,
  pruneStaleEntries,
  mergeEntries,
  tryAcquireCoordLock,
  COORDINATION_FILE,
  COORDINATION_LOCK_FILE,
  COORDINATION_FILE_VERSION,
  type CoordinationEntry,
  type CoordinationData,
} from './coordination.js';

// ── Test fixtures ──────────────────────────────────────────────────────

let testDir: string;
let savedCoordDir: string | undefined;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'herdr-coordination-'));
  // F2 (WL-0MTII3YH20044XYL): coordination lives in the machine dir
  // (`~/.herdr/downtime` or `HERDR_COORDINATION_DIR`). Point the machine
  // dir at the isolated temp dir so each test gets a fresh file without
  // leaking into the real home or across concurrent tests.
  savedCoordDir = process.env.HERDR_COORDINATION_DIR;
  process.env.HERDR_COORDINATION_DIR = testDir;
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  if (savedCoordDir !== undefined) process.env.HERDR_COORDINATION_DIR = savedCoordDir;
  else delete process.env.HERDR_COORDINATION_DIR;
});

/** Build a valid entry for the test directory (F2: populates both `directory` and `worklogRoot` for compat). */
function makeEntry(
  instanceId: string,
  workItemId: string,
  opts?: Partial<CoordinationEntry>,
): CoordinationEntry {
  const now = new Date().toISOString();
  return {
    instanceId,
    workItemId,
    directory: testDir,
    worklogRoot: testDir,
    assignedAt: opts?.assignedAt ?? now,
    lastUpdated: opts?.lastUpdated ?? now,
  };
}

const COORD_PATH = () => join(testDir, COORDINATION_FILE);

// ── read/write ─────────────────────────────────────────────────────────

describe('readCoordinationFile / writeCoordinationFile', () => {
  it('returns null when the file does not exist', () => {
    expect(readCoordinationFile(testDir)).toBe(null);
  });

  it('round-trips a written file', () => {
    const data: CoordinationData = {
      version: COORDINATION_FILE_VERSION,
      entries: [makeEntry('inst-1', 'WL-ABC')],
    };
    expect(writeCoordinationFile(testDir, data)).toBe(true);
    expect(readCoordinationFile(testDir)).toEqual(data);
  });

  it('returns null for corrupt JSON (fail-safe)', () => {
    writeFileSync(COORD_PATH(), '{ not valid json !!!', 'utf-8');
    expect(readCoordinationFile(testDir)).toBe(null);
  });

  it('returns null for an empty file (fail-safe)', () => {
    writeFileSync(COORD_PATH(), '', 'utf-8');
    expect(readCoordinationFile(testDir)).toBe(null);
  });

  it('returns null when entries is not an array (fail-safe)', () => {
    writeFileSync(COORD_PATH(), JSON.stringify({ version: 1, entries: 'oops' }), 'utf-8');
    expect(readCoordinationFile(testDir)).toBe(null);
  });

  it('drops malformed entries but keeps valid ones (fail-safe)', () => {
    writeFileSync(
      COORD_PATH(),
      JSON.stringify({
        version: 1,
        entries: [
          'garbage',
          { noInstanceId: true },
          makeEntry('inst-ok', 'WL-OK'),
        ],
      }),
      'utf-8',
    );
    const data = readCoordinationFile(testDir);
    expect(data).not.toBe(null);
    expect(data!.entries).toHaveLength(1);
    expect(data!.entries[0].instanceId).toBe('inst-ok');
  });
});

// ── upsert / get / remove ──────────────────────────────────────────────

describe('upsertEntry / getEntry / removeEntry', () => {
  it('adds a new entry on first write', () => {
    expect(upsertEntry(testDir, makeEntry('inst-1', 'WL-ONE'))).toBe(true);
    const entry = getEntry(testDir, 'inst-1');
    expect(entry).not.toBe(null);
    expect(entry!.workItemId).toBe('WL-ONE');
    expect(entry!.directory).toBe(testDir);
  });

  it('updates an existing entry in place (changed most-important item)', () => {
    upsertEntry(testDir, makeEntry('inst-1', 'WL-ONE'));
    upsertEntry(testDir, makeEntry('inst-1', 'WL-TWO', { lastUpdated: new Date().toISOString() }));
    const data = readCoordinationFile(testDir);
    expect(data!.entries).toHaveLength(1); // replaced, not duplicated
    expect(data!.entries[0].workItemId).toBe('WL-TWO');
  });

  it('keeps multiple instances distinct', () => {
    upsertEntry(testDir, makeEntry('inst-1', 'WL-ONE'));
    upsertEntry(testDir, makeEntry('inst-2', 'WL-TWO'));
    const data = readCoordinationFile(testDir);
    expect(data!.entries).toHaveLength(2);
    expect(getEntry(testDir, 'inst-1')!.workItemId).toBe('WL-ONE');
    expect(getEntry(testDir, 'inst-2')!.workItemId).toBe('WL-TWO');
  });

  it('removes an entry and returns it', () => {
    upsertEntry(testDir, makeEntry('inst-1', 'WL-ONE'));
    const removed = removeEntry(testDir, 'inst-1');
    expect(removed?.workItemId).toBe('WL-ONE');
    expect(getEntry(testDir, 'inst-1')).toBe(null);
    expect(existsSync(COORD_PATH())).toBe(true); // file remains (empty), owner re-checkins
  });

  it('returns null when removing an absent instance', () => {
    expect(removeEntry(testDir, 'nobody')).toBe(null);
  });

  it('rejects an empty instanceId', () => {
    expect(upsertEntry(testDir, makeEntry('', 'WL-NOPE'))).toBe(false);
  });
});

// ── pruning ────────────────────────────────────────────────────────────

describe('pruneStaleEntries', () => {
  it('removes only entries older than the lease bound', () => {
    const now = 1_000_000;
    const old = new Date(now - 400_000).toISOString(); // > 5 min stale
    const fresh = new Date(now - 60_000).toISOString(); // < 5 min
    upsertEntry(testDir, makeEntry('stale', 'WL-STALE', { lastUpdated: old }));
    upsertEntry(testDir, makeEntry('fresh', 'WL-FRESH', { lastUpdated: fresh }));
    const removed = pruneStaleEntries(testDir, 300_000, now);
    expect(removed).toBe(1);
    expect(getEntry(testDir, 'stale')).toBe(null);
    expect(getEntry(testDir, 'fresh')).not.toBe(null);
  });

  it('returns 0 when nothing is stale', () => {
    upsertEntry(testDir, makeEntry('inst-1', 'WL-ONE'));
    expect(pruneStaleEntries(testDir, 300_000, Date.now())).toBe(0);
  });

  it('returns 0 when the file is missing (fail-safe)', () => {
    expect(pruneStaleEntries(testDir, 300_000)).toBe(0);
  });
});

// ── mergeEntries (batch check-in) ──────────────────────────────────────

describe('mergeEntries', () => {
  it('writes a batch of entries', () => {
    const n = mergeEntries(testDir, [
      makeEntry('inst-1', 'WL-A'),
      makeEntry('inst-2', 'WL-B'),
    ]);
    expect(n).toBe(2);
    expect(readCoordinationFile(testDir)!.entries).toHaveLength(2);
  });

  it('overwrites existing entries for the same instance', () => {
    upsertEntry(testDir, makeEntry('inst-1', 'WL-OLD'));
    mergeEntries(testDir, [makeEntry('inst-1', 'WL-NEW')]);
    expect(readCoordinationFile(testDir)!.entries).toHaveLength(1);
    expect(getEntry(testDir, 'inst-1')!.workItemId).toBe('WL-NEW');
  });

  it('returns 0 for an empty batch', () => {
    expect(mergeEntries(testDir, [])).toBe(0);
  });
});

// ── exclusive lock (flock-equivalent) ─────────────────────────────────

describe('tryAcquireCoordLock', () => {
  it('serializes concurrent writers: second holder is refused until release', () => {
    const release = tryAcquireCoordLock(testDir);
    expect(release).not.toBe(null);

    // Second concurrent writer cannot acquire while the first holds it
    expect(tryAcquireCoordLock(testDir)).toBe(null);
    // Its upsert fails open (skipped this cycle)
    expect(upsertEntry(testDir, makeEntry('inst-2', 'WL-TWO'))).toBe(false);

    release!();
    // After release, a new writer can proceed (no lock held by us now)
    expect(upsertEntry(testDir, makeEntry('inst-2', 'WL-TWO'))).toBe(true);
  });

  it('cleans up the lock file on release', () => {
    const release = tryAcquireCoordLock(testDir);
    expect(existsSync(join(testDir, COORDINATION_LOCK_FILE))).toBe(true);
    release!();
    expect(existsSync(join(testDir, COORDINATION_LOCK_FILE))).toBe(false);
  });
});

// ── atomicity ──────────────────────────────────────────────────────────

describe('atomic write', () => {
  it('never leaves a tmp file behind after a successful write', () => {
    upsertEntry(testDir, makeEntry('inst-1', 'WL-ONE'));
    const leftovers = readFileSync(COORD_PATH(), 'utf-8');
    expect(leftovers).toContain('WL-ONE'); // real content, not a tmp artifact
    // tmp file cleaned up by rename (the atomic swap)
    const tmpPath = `${join(testDir, COORDINATION_FILE)}.tmp`;
    expect(existsSync(tmpPath)).toBe(false);
  });
});

// ── machine-wide shared file (F2: AC1) ─────────────────────────────────

describe('machine-wide shared file (AC1)', () => {
  it('second instance on a *different* worklog root joins the SAME machine file with distinct worklogRoots', () => {
    const otherRoot = join(testDir, 'other-root');
    // Null-safe: coordination.test.ts sets HERDR_COORDINATION_DIR = testDir
    // so machine-file sharing applies regardless of whether the passed
    // worklogDir looks like a tmp dir. Prove that production-like roots
    // (non-tmp) would also share via the machine dir: write with one cwd,
    // read with another.
    expect(getMachineCoordinationDirForTest).not.toBe(undefined); // sanity
    upsertEntry(testDir, makeEntry('inst-A', 'WL-A'));
    const otherEntry: CoordinationEntry = {
      instanceId: 'inst-B',
      workItemId: 'WL-B',
      directory: otherRoot,
      worklogRoot: otherRoot,
      assignedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    };
    // Same machine file regardless of passed worklogDir — both land in testDir's file
    upsertEntry(otherRoot, otherEntry);
    const data = readCoordinationFile(testDir);
    expect(data).not.toBe(null);
    expect(data!.entries).toHaveLength(2);
    const roots = new Set(data!.entries.map((e) => e.worklogRoot ?? e.directory));
    expect(roots.has(testDir)).toBe(true);
    expect(roots.has(otherRoot)).toBe(true);
    // Reading with *either* root's dir returns the same shared data
    expect(readCoordinationFile(otherRoot)!.entries).toHaveLength(2);
  });
});

// Sanity helper so the linter/tests don't accidentally import a stale local.
// The actual machine dir used above is `process.env.HERDR_COORDINATION_DIR`;
// this import just proves the symbol is reachable from this test module.
import { getMachineCoordinationDir as getMachineCoordinationDirForTest } from './machine-coordination.js';

// ── worklogRoot compat ───────────────────────────────────────────────────

describe('worklogRoot / directory compat', () => {
  it('reader accepts legacy entry that only has directory (no worklogRoot) — populates both', () => {
    writeFileSync(
      COORD_PATH(),
      JSON.stringify({
        version: 1,
        entries: [
          {
            instanceId: 'legacy-inst',
            workItemId: 'WL-LEGACY',
            directory: '/tmp/legacy-root',
            assignedAt: new Date(0).toISOString(),
            lastUpdated: new Date(0).toISOString(),
          },
        ],
      }),
      'utf-8',
    );
    const data = readCoordinationFile(testDir);
    expect(data!.entries).toHaveLength(1);
    expect(data!.entries[0].directory).toBe('/tmp/legacy-root');
    expect(data!.entries[0].worklogRoot).toBe('/tmp/legacy-root');
  });

  it('reader prefers worklogRoot over directory when both are present', () => {
    writeFileSync(
      COORD_PATH(),
      JSON.stringify({
        version: 1,
        entries: [
          {
            instanceId: 'both-inst',
            workItemId: 'WL-BOTH',
            directory: '/tmp/old',
            worklogRoot: '/tmp/new',
            assignedAt: new Date(0).toISOString(),
            lastUpdated: new Date(0).toISOString(),
          },
        ],
      }),
      'utf-8',
    );
    const data = readCoordinationFile(testDir);
    expect(data!.entries[0].directory).toBe('/tmp/new');
    expect(data!.entries[0].worklogRoot).toBe('/tmp/new');
  });

  it('writer normalizes entries so the persisted JSON has BOTH directory and worklogRoot', () => {
    // Entry constructed with only `directory` — writer must persist both fields.
    const legacy: CoordinationEntry = {
      instanceId: 'norm-inst',
      workItemId: 'WL-NORM',
      directory: '/tmp/norm-root',
      assignedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    };
    upsertEntry(testDir, legacy);
    const raw = JSON.parse(readFileSync(COORD_PATH(), 'utf-8')) as { entries: Array<Record<string, string>> };
    expect(raw.entries[0].directory).toBe('/tmp/norm-root');
    expect(raw.entries[0].worklogRoot).toBe('/tmp/norm-root');
  });

  it('mergeEntries also normalizes directory/worklogRoot', () => {
    const e: CoordinationEntry = {
      instanceId: 'merge-norm',
      workItemId: 'WL-MN',
      directory: '/tmp/merge-root',
      assignedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    };
    mergeEntries(testDir, [e]);
    const raw = JSON.parse(readFileSync(COORD_PATH(), 'utf-8')) as { entries: Array<Record<string, string>> };
    expect(raw.entries[0].directory).toBe('/tmp/merge-root');
    expect(raw.entries[0].worklogRoot).toBe('/tmp/merge-root');
  });
});