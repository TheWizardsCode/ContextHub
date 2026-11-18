/**
 * `startOn` persistence round-trip — JSONL export/import, legacy back-fill and
 * two-way sync merge (WL-0MWMGEPY2004EDZ8, parent WL-0MWM0FDZK007BAD0).
 *
 * Covers the sync half of AC6: the field survives `export → import` byte for
 * byte, a legacy record without the field imports as `createdAt` (back-compat
 * is the default, never "blocked"), cross-project dependency edges are
 * unaffected, and the merge never resurrects a stale scheduling instant.
 *
 * The merge assertions use explicit instants from the frozen clock, so a run
 * can never straddle a scheduling boundary.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { WorklogDatabase } from '../../src/database.js';
import type { WorkItem } from '../../src/types.js';
import { exportToJsonl, importFromJsonlContent } from '../../src/jsonl.js';
import { mergeWorkItems } from '../../src/sync.js';
import { createFrozenClock } from '../helpers/frozen-clock.js';
import {
  createTempDir,
  cleanupTempDir,
  createTempJsonlPath,
  createTempDbPath,
} from '../test-utils.js';

const clock = createFrozenClock();

/** A complete stored work item, so a merge has every field to compare. */
function makeItem(overrides: Partial<WorkItem> & { id: string }): WorkItem {
  return {
    id: overrides.id,
    title: `Item ${overrides.id}`,
    description: '',
    status: 'open',
    priority: 'medium',
    sortIndex: 0,
    parentId: null,
    createdAt: clock.isoAt(-7 * 24 * 60 * 60 * 1000),
    updatedAt: clock.nowIso(),
    tags: [],
    assignee: '',
    stage: 'idea',
    issueType: '',
    createdBy: '',
    deletedBy: '',
    deleteReason: '',
    risk: '',
    effort: '',
    startOn: clock.nowIso(),
    ...overrides,
  };
}

/** Parse an exported JSONL file into its `workitem` records. */
function readExportedItems(filePath: string): WorkItem[] {
  return fs
    .readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
    .filter((record) => record.type === 'workitem')
    .map((record) => record.data as WorkItem);
}

describe('startOn JSONL export/import', () => {
  let tempDir: string;
  let dbPath: string;
  let jsonlPath: string;
  let db: WorklogDatabase;

  beforeEach(() => {
    tempDir = createTempDir();
    dbPath = createTempDbPath(tempDir);
    jsonlPath = createTempJsonlPath(tempDir);
    db = new WorklogDatabase('TEST', dbPath, jsonlPath, false, false);
  });

  afterEach(() => {
    db.close();
    cleanupTempDir(tempDir);
  });

  it('exports startOn for every item, including one that only has the createdAt default', () => {
    const scheduled = db.create({ title: 'Scheduled', startOn: '2026-11-19T10:25:00Z' });
    const unscheduled = db.create({ title: 'Unscheduled' });
    const exportPath = createTempJsonlPath(tempDir);

    exportToJsonl(db.getAll(), [], exportPath, db.getAllDependencyEdges());
    const exported = readExportedItems(exportPath);

    expect(exported).toHaveLength(2);
    expect(exported.find((item) => item.id === scheduled.id)?.startOn).toBe(
      '2026-11-19T10:25:00.000Z',
    );
    // The defaulted item exports its effective instant, never an absent field.
    expect(exported.find((item) => item.id === unscheduled.id)?.startOn).toBe(
      unscheduled.createdAt,
    );
  });

  it('round-trips startOn unchanged through export and import', () => {
    const scheduled = db.create({ title: 'Scheduled', startOn: '2026-11-19T10:25:00Z' });
    const unscheduled = db.create({ title: 'Unscheduled' });
    const exportPath = createTempJsonlPath(tempDir);

    exportToJsonl(db.getAll(), [], exportPath, db.getAllDependencyEdges());
    const { items } = importFromJsonlContent(fs.readFileSync(exportPath, 'utf-8'));

    expect(items.find((item) => item.id === scheduled.id)?.startOn).toBe(
      '2026-11-19T10:25:00.000Z',
    );
    expect(items.find((item) => item.id === unscheduled.id)?.startOn).toBe(
      unscheduled.createdAt,
    );
  });

  it('back-fills a legacy record that has no startOn with its createdAt', () => {
    const legacy = makeItem({ id: 'TEST-LEGACY' });
    delete (legacy as Partial<WorkItem>).startOn;
    const content = `${JSON.stringify({ type: 'workitem', data: legacy })}\n`;

    const { items } = importFromJsonlContent(content);

    expect(items).toHaveLength(1);
    expect(items[0].startOn).toBe(legacy.createdAt);
  });

  it('back-fills a legacy unprefixed record (old format) with its createdAt', () => {
    const legacy = makeItem({ id: 'TEST-OLD' });
    delete (legacy as Partial<WorkItem>).startOn;
    const content = `${JSON.stringify(legacy)}\n`;

    // The legacy path warns on stderr; silence it for the assertion.
    const warn = console.warn;
    console.warn = () => {};
    try {
      const { items } = importFromJsonlContent(content);
      expect(items[0].startOn).toBe(legacy.createdAt);
    } finally {
      console.warn = warn;
    }
  });

  it('leaves a cross-project dependency edge untouched while back-filling startOn', () => {
    const legacy = makeItem({
      id: 'TEST-LOCAL',
      dependencies: [{ from: 'TEST-LOCAL', to: 'OTHER-1' }],
    });
    delete (legacy as Partial<WorkItem>).startOn;
    const content = `${JSON.stringify({ type: 'workitem', data: legacy })}\n`;

    const { items, dependencyEdges } = importFromJsonlContent(content);

    expect(items[0].startOn).toBe(legacy.createdAt);
    // A foreign (cross-project) target is preserved verbatim — no local row is
    // required, and the scheduling back-fill must not affect the edge.
    expect(dependencyEdges).toEqual([
      { fromId: 'TEST-LOCAL', toId: 'OTHER-1', createdAt: expect.any(String) },
    ]);
  });

  it('does not churn updatedAt when re-importing a legacy row whose startOn was back-filled', () => {
    const created = db.create({ title: 'Back-filled row' });
    // Simulate the post-migration state: the stored column now holds createdAt.
    const stored = db.get(created.id)!;
    const legacyRecord: WorkItem = { ...stored, updatedAt: stored.updatedAt };
    delete (legacyRecord as Partial<WorkItem>).startOn;

    db.import([legacyRecord]);

    expect(db.get(created.id)?.updatedAt).toBe(stored.updatedAt);
  });
});

describe('startOn two-way sync merge', () => {
  it('keeps the newer local startOn instead of resurrecting an older remote value', () => {
    const scheduledLocal = clock.isoAt(2 * 60 * 60 * 1000);
    const staleRemote = clock.isoAt(60 * 60 * 1000);
    const local = makeItem({
      id: 'TEST-SYNC',
      startOn: scheduledLocal,
      updatedAt: clock.nowIso(),
    });
    const remote = makeItem({
      id: 'TEST-SYNC',
      startOn: staleRemote,
      updatedAt: clock.isoAt(-60 * 60 * 1000),
    });

    const { merged } = mergeWorkItems([local], [remote]);

    expect(merged).toHaveLength(1);
    expect(merged[0].startOn).toBe(scheduledLocal);
    expect(merged[0].updatedAt).toBe(local.updatedAt);
  });

  it('adopts a newer remote startOn', () => {
    const rescheduledRemote = clock.isoAt(3 * 60 * 60 * 1000);
    const local = makeItem({
      id: 'TEST-SYNC',
      startOn: clock.isoAt(60 * 60 * 1000),
      updatedAt: clock.isoAt(-60 * 60 * 1000),
    });
    const remote = makeItem({
      id: 'TEST-SYNC',
      startOn: rescheduledRemote,
      updatedAt: clock.nowIso(),
    });

    const { merged } = mergeWorkItems([local], [remote]);

    expect(merged[0].startOn).toBe(rescheduledRemote);
    expect(merged[0].updatedAt).toBe(remote.updatedAt);
  });

  it('never lets an absent (default) remote startOn override an explicit local schedule', () => {
    const scheduledLocal = clock.isoAt(2 * 60 * 60 * 1000);
    const local = makeItem({
      id: 'TEST-SYNC',
      startOn: scheduledLocal,
      updatedAt: clock.isoAt(-60 * 60 * 1000),
    });
    // A legacy/remote copy with no scheduling value and an EARLIER timestamp:
    // its effective instant is its createdAt, which is the default.
    const remote = makeItem({
      id: 'TEST-SYNC',
      startOn: undefined,
      updatedAt: clock.isoAt(-30 * 60 * 1000),
    });

    const { merged } = mergeWorkItems([local], [remote]);

    expect(merged[0].startOn).toBe(scheduledLocal);
  });

  it('resolves same-timestamp divergence deterministically without losing the field', () => {
    // Identical `updatedAt` but different scheduling instants: the configured
    // strategy decides, so the merged item is never left without a value.
    const local = makeItem({ id: 'TEST-TIE', startOn: clock.isoAt(60 * 60 * 1000) });
    const remote = makeItem({ id: 'TEST-TIE', startOn: clock.isoAt(2 * 60 * 60 * 1000) });

    const localWins = mergeWorkItems([local], [remote], { sameTimestampStrategy: 'local' });
    expect(localWins.merged[0].startOn).toBe(local.startOn);

    const remoteWins = mergeWorkItems([local], [remote], { sameTimestampStrategy: 'remote' });
    expect(remoteWins.merged[0].startOn).toBe(remote.startOn);
  });

  it('propagates a startOn-only change through export → merge → import', () => {
    const scheduled = clock.isoAt(4 * 60 * 60 * 1000);
    const local = makeItem({ id: 'TEST-ROUND', startOn: scheduled, updatedAt: clock.nowIso() });
    const remote = makeItem({
      id: 'TEST-ROUND',
      startOn: undefined,
      updatedAt: clock.isoAt(-60 * 60 * 1000),
    });

    const { merged } = mergeWorkItems([local], [remote]);
    const serialised = `${JSON.stringify({ type: 'workitem', data: merged[0] })}\n`;
    const { items } = importFromJsonlContent(serialised);

    expect(merged[0].startOn).toBe(scheduled);
    expect(items[0].startOn).toBe(scheduled);
  });
});
