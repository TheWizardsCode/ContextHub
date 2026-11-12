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
  removeOffer,
  getEntry,
  pruneStaleEntries,
  mergeEntries,
  tryAcquireCoordLock,
  hasPeerOffer,
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

// ── pruning (retired: WL-0MTMPIQBE001J41P) ──────────────────────────
// Entries do NOT expire by age — pruneStaleEntries is a no-op (compat).

describe('pruneStaleEntries (no-op, WL-0MTMPIQBE001J41P)', () => {
  it('does not remove entries older than the former lease bound', () => {
    const now = 1_000_000;
    const old = new Date(now - 400_000).toISOString(); // > 5 min, formerly stale
    const fresh = new Date(now - 60_000).toISOString();
    upsertEntry(testDir, makeEntry('stale', 'WL-STALE', { lastUpdated: old }));
    upsertEntry(testDir, makeEntry('fresh', 'WL-FRESH', { lastUpdated: fresh }));
    const removed = pruneStaleEntries(testDir, 300_000, now);
    expect(removed).toBe(0);
    expect(getEntry(testDir, 'stale')).not.toBe(null);
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
import { DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS } from './downtime-worker.constants.js';

// ── hasPeerOffer liveness-aware staleness (WL-0MVR8GDJ3008WY3Y AC7) ──

/** Build a peer entry with a controlled `lastUpdated` timestamp. */
function makePeerEntry(
  instanceId: string,
  workItemId: string,
  lastUpdated: string,
): CoordinationEntry {
  return {
    instanceId,
    workItemId,
    directory: testDir,
    worklogRoot: testDir,
    assignedAt: lastUpdated,
    lastUpdated,
  };
}

describe('hasPeerOffer liveness-aware staleness (AC7)', () => {
  const now = 1_700_000_000_000; // fixed epoch ms for deterministic tests
  const staleWindow = DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS;
  const freshTs = new Date(now - 10_000).toISOString();     // 10 s ago
  const staleTs = new Date(now - staleWindow - 1_000).toISOString(); // > 24 h ago

  it('returns true when a fresh peer entry holds a workItemId', () => {
    const entries = [makePeerEntry('peer-1', 'WL-ABC', freshTs)];
    expect(hasPeerOffer(entries, 'other', { nowMs: now })).toBe(true);
  });

  it('returns false when a peer entry is older than the stale window', () => {
    const entries = [makePeerEntry('peer-1', 'WL-ABC', staleTs)];
    expect(hasPeerOffer(entries, 'other', { nowMs: now })).toBe(false);
  });

  it('returns true when a fresh peer is present alongside a stale peer', () => {
    const entries = [
      makePeerEntry('stale-peer', 'WL-STALE', staleTs),
      makePeerEntry('fresh-peer', 'WL-FRESH', freshTs),
    ];
    expect(hasPeerOffer(entries, 'other', { nowMs: now })).toBe(true);
  });

  it('returns false when only stale peers are present', () => {
    const entries = [
      makePeerEntry('stale-1', 'WL-A', staleTs),
      makePeerEntry('stale-2', 'WL-B', staleTs),
    ];
    expect(hasPeerOffer(entries, 'other', { nowMs: now })).toBe(false);
  });

  it('excludes the instance\'s OWN entry from peer consideration', () => {
    const entries = [makePeerEntry('me', 'WL-MINE', freshTs)];
    expect(hasPeerOffer(entries, 'me', { nowMs: now })).toBe(false);
  });

  it('treats an entry without workItemId as no offer', () => {
    const entries = [
      { ...makePeerEntry('peer', '', freshTs), workItemId: '' },
    ];
    expect(hasPeerOffer(entries, 'other', { nowMs: now })).toBe(false);
  });

  it('uses the default stale window when opts is omitted', () => {
    const entries = [makePeerEntry('peer', 'WL-ABC', staleTs)];
    // No opts → default 24 h window → stale
    expect(hasPeerOffer(entries, 'other')).toBe(false);
  });

  it('honours a custom staleWindowMs', () => {
    const entries = [makePeerEntry('peer', 'WL-ABC', staleTs)];
    const shortWindow = 1; // 1 ms — everything stale
    expect(hasPeerOffer(entries, 'other', { nowMs: now, staleWindowMs: shortWindow })).toBe(false);
  });

  it('treats an unparseable lastUpdated as not live', () => {
    const entries = [
      { ...makePeerEntry('peer', 'WL-BAD', freshTs), lastUpdated: 'not-a-date' },
    ];
    expect(hasPeerOffer(entries, 'other', { nowMs: now })).toBe(false);
  });

  it('an empty entry array returns false', () => {
    expect(hasPeerOffer([], 'any', { nowMs: now })).toBe(false);
  });
});

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

// ── v2 schema contract: bounded offers, duplicate collapse, v1 migration-read (parent WL-0MWDDHQON0015T3P AC1/AC9, test-first slice WL-0MWDVMK48002NIHO) ──
//
// Tier-aware offers (parent AC1): `CoordinationEntry` carries a bounded
// `offers` array — one nominee per bucket (`implement` / `audit` / `prep`,
// the classifier outputs with plan/intake/risk-effort unioning to `prep`),
// at most three offers total, and duplicate `(kind, workItemId)` pairs
// collapse. `COORDINATION_FILE_VERSION` becomes `2`; a v1 file (single
// top-level `workItemId`, no `offers`) is read as a one-offer entry whose
// kind is derived by the classifier, and is rewritten as v2 on the next
// check-in — no v1 file is ever dropped by the upgrade. Legacy
// `removeEntry` semantics are preserved (parent AC9).
//
// GREEN (F1, WL-0MWDVMVX50012RSU): the v2 surface landed — `CoordinationEntry`
// carries the bounded `offers` payload, `readCoordinationFile` parses it and
// migration-reads v1 files, and `COORDINATION_FILE_VERSION` is 2.

import { classifyItemForDispatch } from './downtime-worker.gates.js';
import {
  LEGACY_V1_ENTRY,
  LEGACY_V1_INSTANCE_ID,
  LEGACY_V1_ITEM,
  LEGACY_V1_WORK_ITEM_ID,
} from './__fixtures__/coordination-v1-entry.js';
import {
  CANONICAL_V2_OFFERS,
  DUPLICATE_V2_OFFERS,
  OVER_BUCKET_V2_OFFERS,
  OVER_CAP_V2_OFFERS,
  type CoordOfferWitness,
} from './__fixtures__/coordination-v2-offers.js';

/** The v2 per-bucket offer payload F1 introduces (at most one per bucket). */
type V2EntryWitness = Omit<CoordinationEntry, 'workItemId'> & {
  offers: CoordOfferWitness[];
};

/** Build a v2-shaped entry (offers payload, NO top-level `workItemId`). */
function v2EntryWitness(instanceId: string, offers: CoordOfferWitness[]): CoordinationEntry {
  const now = new Date().toISOString();
  return {
    instanceId,
    directory: testDir,
    worklogRoot: testDir,
    assignedAt: now,
    lastUpdated: now,
    offers,
  } as unknown as CoordinationEntry;
}

/** Map a classifier output to its v2 bucket (parent AC1: plan/intake/risk-effort → prep). */
function toBucket(kind: string | null): 'implement' | 'audit' | 'prep' | null {
  if (kind === 'implement' || kind === 'audit') return kind;
  if (kind === 'plan' || kind === 'intake' || kind === 'risk-effort') return 'prep';
  return null;
}

/** Read the persisted raw JSON (the on-disk contract, not the parsed view). */
function rawFile(): { version: number; entries: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(COORD_PATH(), 'utf-8')) as {
    version: number;
    entries: Array<Record<string, unknown>>;
  };
}

describe('v2 schema: bounded offers array (parent AC1)', () => {
  it('COORDINATION_FILE_VERSION is bumped to 2 for the tier-aware offer contract', () => {
    expect(COORDINATION_FILE_VERSION).toBe(2);
  });

  it('duplicate (kind, workItemId) pairs collapse to one offer on every write seam', () => {
    // upsertEntry (per-check-in upsert) ...
    expect(upsertEntry(testDir, v2EntryWitness('inst-1', DUPLICATE_V2_OFFERS))).toBe(true);
    // ... and mergeEntries (the batch check-in write seam) collapse the same way.
    expect(mergeEntries(testDir, [v2EntryWitness('inst-2', DUPLICATE_V2_OFFERS)])).toBe(1);

    const data = readCoordinationFile(testDir)!;
    expect(data.entries).toHaveLength(2);
    const offersOf = (entry: CoordinationEntry): CoordOfferWitness[] =>
      (entry as unknown as V2EntryWitness).offers;
    // The exact duplicate pair is written ONCE — the array never inflates.
    for (const entry of data.entries) {
      expect(offersOf(entry)).toEqual(CANONICAL_V2_OFFERS);
    }
    // On disk too: the persisted JSON carries the collapsed arrays.
    const raw = rawFile();
    for (const entry of raw.entries) {
      expect(entry.offers as CoordOfferWitness[]).toEqual(CANONICAL_V2_OFFERS);
    }
  });

  it('an offers array exceeding one-per-bucket or three-offer bounds is not persisted', () => {
    // Two implements in one bucket — the write must keep at most the FIRST
    // (the canonical first item of the bucket; no second ranking).
    expect(upsertEntry(testDir, v2EntryWitness('inst-bucket', OVER_BUCKET_V2_OFFERS))).toBe(true);
    // Four offers (implement twice + audit + prep) — the write must stop at
    // three total, one per bucket.
    expect(upsertEntry(testDir, v2EntryWitness('inst-cap', OVER_CAP_V2_OFFERS))).toBe(true);

    const data = readCoordinationFile(testDir)!;
    const offersOf = (entry: CoordinationEntry): CoordOfferWitness[] =>
      (entry as unknown as V2EntryWitness).offers;
    expect(offersOf(data.entries[0])).toEqual([{ kind: 'implement', workItemId: 'WL-IMP-A' }]);
    expect(offersOf(data.entries[1])).toEqual(CANONICAL_V2_OFFERS);
    // On disk the bounded invariant holds too — an over-bounds array is never
    // persisted.
    const raw = rawFile();
    expect(raw.entries[0].offers as CoordOfferWitness[]).toHaveLength(1);
    expect(raw.entries[1].offers as CoordOfferWitness[]).toHaveLength(3);
  });
});

describe('v1 migration-read and rewrite (parent AC1)', () => {
  it('a v1 file (single workItemId, no offers) is read as a one-offer entry whose kind is derived by the classifier', () => {
    writeFileSync(COORD_PATH(), JSON.stringify({ version: 1, entries: [LEGACY_V1_ENTRY] }), 'utf-8');
    const data = readCoordinationFile(testDir);
    expect(data).not.toBe(null);
    // No v1 file is dropped by the upgrade — the entry survives the read.
    expect(data!.entries).toHaveLength(1);
    const entry = data!.entries[0] as unknown as V2EntryWitness;
    expect(entry.instanceId).toBe(LEGACY_V1_INSTANCE_ID);
    // The single v1 offer becomes exactly one `offers` entry...
    expect(entry.offers).toHaveLength(1);
    // ...carrying the v1 workItemId...
    expect(entry.offers[0].workItemId).toBe(LEGACY_V1_WORK_ITEM_ID);
    // ...and the classifier-derived kind (plan_complete / Low / S → implement).
    expect(toBucket(classifyItemForDispatch(LEGACY_V1_ITEM))).toBe('implement');
    expect(entry.offers[0].kind).toBe('implement');
  });

  it('a v1 file is rewritten as v2 on the next check-in and never dropped', () => {
    writeFileSync(COORD_PATH(), JSON.stringify({ version: 1, entries: [LEGACY_V1_ENTRY] }), 'utf-8');
    // The owner's next check-in recomputes its tier-aware offers and upserts
    // the same instance's entry (the migrated one-offer shape).
    const migrated = v2EntryWitness(LEGACY_V1_INSTANCE_ID, [
      { kind: 'implement', workItemId: LEGACY_V1_WORK_ITEM_ID },
    ]);
    expect(upsertEntry(testDir, migrated)).toBe(true);

    const data = readCoordinationFile(testDir)!;
    // The write path persists the CURRENT format version (2) — never the
    // legacy one read back from disk.
    expect(data.version).toBe(2);
    // The v1 entry survived the upgrade as a one-offer v2 entry.
    expect(data.entries).toHaveLength(1);
    const offers = (data.entries[0] as unknown as V2EntryWitness).offers;
    expect(offers).toEqual([{ kind: 'implement', workItemId: LEGACY_V1_WORK_ITEM_ID }]);
  });
});

describe('removeEntry v1 semantics preserved (parent AC9, GREEN today)', () => {
  it('removes a legacy v1 entry by instanceId and returns it; an absent instance yields null', () => {
    writeFileSync(COORD_PATH(), JSON.stringify({ version: 1, entries: [LEGACY_V1_ENTRY] }), 'utf-8');
    expect(getEntry(testDir, LEGACY_V1_INSTANCE_ID)).not.toBe(null);

    const removed = removeEntry(testDir, LEGACY_V1_INSTANCE_ID);
    expect(removed).not.toBe(null);
    expect(removed!.instanceId).toBe(LEGACY_V1_INSTANCE_ID);
    expect(removed!.workItemId).toBe(LEGACY_V1_WORK_ITEM_ID);
    // The entry is gone; the file remains (empty) for the owner's next check-in.
    expect(getEntry(testDir, LEGACY_V1_INSTANCE_ID)).toBe(null);
    expect(existsSync(COORD_PATH())).toBe(true);
    expect(removeEntry(testDir, LEGACY_V1_INSTANCE_ID)).toBe(null);
  });
});
// ── Partial removal: only the dispatched offer goes (parent WL-0MWDDHQON0015T3P AC6) ──
//
// The leader dispatches one nominated bucket at a time, so the coordination
// file must lose exactly that offer: the entry survives with its remaining
// nominees and its owner metadata (`lastUpdated` / `assignedAt`) untouched, so
// the next tick can dispatch the next tier WITHOUT waiting for the owner's
// check-in cadence. `removeOffer` is the primitive that owns that rule; the
// entry is dropped only when it has no offers left (v1 semantics).

describe('removeOffer — partial removal (parent AC6)', () => {
  it('removes only the dispatched offer and leaves the rest of the entry, including lastUpdated, untouched', () => {
    const entry = v2EntryWitness('inst-1', CANONICAL_V2_OFFERS);
    expect(upsertEntry(testDir, entry)).toBe(true);

    const result = removeOffer(testDir, 'inst-1', 'WL-AUD');

    expect(result).toEqual({ offerRemoved: true, entryRemoved: false });
    const after = getEntry(testDir, 'inst-1');
    expect(after).not.toBe(null);
    // Exactly the dispatched offer is gone; the others keep their order.
    expect((after as unknown as V2EntryWitness).offers).toEqual([
      { kind: 'implement', workItemId: 'WL-IMP' },
      { kind: 'prep', workItemId: 'WL-PREP' },
    ]);
    // A v1-era leader keeps reading a coherent first offer.
    expect(after!.workItemId).toBe('WL-IMP');
    // Owner metadata is never rewritten by a dispatch.
    expect(after!.lastUpdated).toBe(entry.lastUpdated);
    expect(after!.assignedAt).toBe(entry.assignedAt);
  });

  it('re-points workItemId at the surviving first offer when the FIRST offer dispatched', () => {
    expect(upsertEntry(testDir, v2EntryWitness('inst-1', CANONICAL_V2_OFFERS))).toBe(true);

    expect(removeOffer(testDir, 'inst-1', 'WL-IMP')).toEqual({
      offerRemoved: true,
      entryRemoved: false,
    });

    const after = getEntry(testDir, 'inst-1')!;
    expect(after.workItemId).toBe('WL-AUD');
    expect((after as unknown as V2EntryWitness).offers).toEqual([
      { kind: 'audit', workItemId: 'WL-AUD' },
      { kind: 'prep', workItemId: 'WL-PREP' },
    ]);
  });

  it('removes the whole entry once its LAST offer is removed', () => {
    expect(upsertEntry(testDir, v2EntryWitness('inst-1', CANONICAL_V2_OFFERS))).toBe(true);
    removeOffer(testDir, 'inst-1', 'WL-IMP');
    removeOffer(testDir, 'inst-1', 'WL-AUD');

    expect(removeOffer(testDir, 'inst-1', 'WL-PREP')).toEqual({
      offerRemoved: true,
      entryRemoved: true,
    });
    expect(getEntry(testDir, 'inst-1')).toBe(null);
    // The file remains (empty) so the owner re-offers at its next check-in.
    expect(existsSync(COORD_PATH())).toBe(true);
  });

  it('drops a legacy v1-shaped entry whole (its single offer IS the entry)', () => {
    writeFileSync(COORD_PATH(), JSON.stringify({ version: 1, entries: [LEGACY_V1_ENTRY] }), 'utf-8');

    expect(removeOffer(testDir, LEGACY_V1_INSTANCE_ID, LEGACY_V1_WORK_ITEM_ID)).toEqual({
      offerRemoved: true,
      entryRemoved: true,
    });
    expect(getEntry(testDir, LEGACY_V1_INSTANCE_ID)).toBe(null);
  });

  it('is a no-op for an unknown offer or an unknown instance', () => {
    expect(upsertEntry(testDir, v2EntryWitness('inst-1', CANONICAL_V2_OFFERS))).toBe(true);

    // An offer this entry never advertised: nothing is removed, nothing is
    // rewritten.
    const before = getEntry(testDir, 'inst-1')!;
    expect(removeOffer(testDir, 'inst-1', 'WL-OTHER')).toEqual({
      offerRemoved: false,
      entryRemoved: false,
    });
    expect(getEntry(testDir, 'inst-1')!.lastUpdated).toBe(before.lastUpdated);
    expect((getEntry(testDir, 'inst-1') as unknown as V2EntryWitness).offers).toEqual(
      CANONICAL_V2_OFFERS,
    );

    expect(removeOffer(testDir, 'nobody', 'WL-IMP')).toEqual({
      offerRemoved: false,
      entryRemoved: false,
    });
  });
});
