/**
 * Tests for whitespace-insensitive semantic-change detection in
 * WorklogDatabase (WL-0MSORD6HC005QVZX).
 *
 * `hasWorkItemChanged()` (used by `import()` and `upsertItems()`) and the
 * no-op guard in `update()` must NOT treat whitespace-only differences in
 * `title`/`description` (trailing newlines, leading/trailing whitespace,
 * blank-line runs) as semantic changes. Otherwise `wl sync` re-timestamps
 * items whose meaningful content never changed, which silently invalidates
 * audits and produces an infinite conflict-resolution loop.
 *
 * All assertions go through the public API (`create`/`import`/`update`/
 * `upsertItems`/`get`) because `hasWorkItemChanged` is private; the tests pin
 * observable behaviour: `updatedAt` is preserved for whitespace-only diffs
 * and bumped for genuine changes.
 *
 * Run: npx vitest run packages/shared/src/database.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorklogDatabase } from './database.js';
import { WorkItem } from './types.js';

const FIXED_TS = '2026-01-01T00:00:00.000Z';

/** Build a complete WorkItem with a fixed timestamp so bump assertions are unambiguous. */
function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'WI-0001',
    title: 'Fix the bug',
    description: 'A description with some detail.',
    status: 'open',
    priority: 'medium',
    sortIndex: 0,
    parentId: null,
    createdAt: FIXED_TS,
    updatedAt: FIXED_TS,
    tags: [],
    assignee: '',
    stage: 'idea',
    issueType: 'bug',
    createdBy: '',
    deletedBy: '',
    deleteReason: '',
    risk: '',
    effort: '',
    needsProducerReview: false,
    ...overrides,
  };
}

let tempDir: string;
let db: WorklogDatabase;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'wl-db-whitespace-'));
  db = new WorklogDatabase('TEST', join(tempDir, 'worklog.db'), join(tempDir, 'data.jsonl'), true);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('import() updatedAt preservation for whitespace-only diffs (WL-0MSORD6HC005QVZX)', () => {
  it('preserves updatedAt when only description differs by a trailing newline', () => {
    const original = makeItem();
    db.import([original]);
    expect(db.get(original.id)?.updatedAt).toBe(FIXED_TS);

    db.import([{ ...original, description: original.description + '\n' }]);
    expect(db.get(original.id)?.updatedAt).toBe(FIXED_TS);
  });

  it('preserves updatedAt when only description differs by leading/trailing whitespace', () => {
    const original = makeItem();
    db.import([original]);
    db.import([{ ...original, description: `  ${original.description} \t` }]);
    expect(db.get(original.id)?.updatedAt).toBe(FIXED_TS);
  });

  it('preserves updatedAt when only description differs by blank-line runs (multiple trailing newlines)', () => {
    const original = makeItem();
    db.import([original]);
    db.import([{ ...original, description: original.description + '\n\n\n' }]);
    expect(db.get(original.id)?.updatedAt).toBe(FIXED_TS);
  });

  it('preserves updatedAt when only title differs by leading/trailing whitespace', () => {
    const original = makeItem();
    db.import([original]);
    db.import([{ ...original, title: `  ${original.title}  ` }]);
    expect(db.get(original.id)?.updatedAt).toBe(FIXED_TS);
  });

  it('preserves updatedAt when BOTH title and description differ by whitespace only', () => {
    const original = makeItem();
    db.import([original]);
    db.import([{ ...original, title: original.title + '\n', description: original.description + '\n\n' }]);
    expect(db.get(original.id)?.updatedAt).toBe(FIXED_TS);
  });

  it('still persists the incoming (whitespace-differing) description content when the only diff is whitespace', () => {
    const original = makeItem();
    db.import([original]);
    db.import([{ ...original, description: original.description + '\n' }]);
    const stored = db.get(original.id);
    expect(stored?.updatedAt).toBe(FIXED_TS);
    expect(stored?.description).toBe(original.description + '\n');
  });

  it('bumps updatedAt on a genuine description content change', () => {
    const original = makeItem();
    db.import([original]);
    db.import([{ ...original, description: 'completely different content' }]);
    const stored = db.get(original.id);
    expect(stored?.description).toBe('completely different content');
    expect(stored?.updatedAt).not.toBe(FIXED_TS);
  });

  it('bumps updatedAt on a genuine title content change', () => {
    const original = makeItem();
    db.import([original]);
    db.import([{ ...original, title: 'A genuinely new title' }]);
    const stored = db.get(original.id);
    expect(stored?.title).toBe('A genuinely new title');
    expect(stored?.updatedAt).not.toBe(FIXED_TS);
  });

  it('detects non-whitespace changes in other fields (status, priority, tags, parentId)', () => {
    const cases: Array<{ id: string; patch: Partial<WorkItem> }> = [
      { id: 'WI-0001', patch: { status: 'completed' } },
      { id: 'WI-0002', patch: { priority: 'critical' } },
      { id: 'WI-0003', patch: { tags: ['sync', 'updatedAt'] } },
      { id: 'WI-0004', patch: { parentId: 'WI-0000' } },
    ];
    for (const { id, patch } of cases) {
      const original = makeItem({ id });
      db.import([original]);
      expect(db.get(id)?.updatedAt).toBe(FIXED_TS);
      db.import([{ ...original, ...patch }]);
      expect(db.get(id)?.updatedAt).not.toBe(FIXED_TS);
    }
  });
});

describe('update() no-op guard (WL-0MSORD6HC005QVZX)', () => {
  // Seed via import() with a FIXED_TS so a wrongly-bumped timestamp is
  // unambiguous even when create()+update() land in the same millisecond.
  function seed(): WorkItem {
    const item = makeItem({ id: 'WI-UPD1', title: 'My item', description: 'the description' });
    db.import([item]);
    return item;
  }

  it('preserves updatedAt when only description differs by trailing whitespace', () => {
    const seeded = seed();
    const updated = db.update(seeded.id, { description: 'the description\n' });
    expect(updated?.updatedAt).toBe(FIXED_TS);
    expect(db.get(seeded.id)?.updatedAt).toBe(FIXED_TS);
  });

  it('preserves updatedAt when only title differs by leading/trailing whitespace', () => {
    const seeded = seed();
    const updated = db.update(seeded.id, { title: '  My item  ' });
    expect(updated?.updatedAt).toBe(FIXED_TS);
    expect(db.get(seeded.id)?.updatedAt).toBe(FIXED_TS);
  });

  it('bumps updatedAt on a genuine description change', () => {
    const seeded = seed();
    const updated = db.update(seeded.id, { description: 'brand new description' });
    expect(updated?.description).toBe('brand new description');
    expect(updated?.updatedAt).not.toBe(FIXED_TS);
  });

  it('bumps updatedAt on a genuine status change', () => {
    const seeded = seed();
    const updated = db.update(seeded.id, { status: 'completed' });
    expect(updated?.status).toBe('completed');
    expect(updated?.updatedAt).not.toBe(FIXED_TS);
  });
});

describe('updateIfMatches() CAS claim (RCA WL-0MSRBFFLN005W3VT design point 1)', () => {
  function seed(status: string = 'open', stage: string = 'intake_complete'): WorkItem {
    const item = makeItem({ id: 'WI-CAS1', status: status as WorkItem['status'], stage });
    db.import([item]);
    return item;
  }

  it('applies the update when status and stage both match', () => {
    const seeded = seed('open', 'intake_complete');
    const result = db.updateIfMatches(seeded.id, { status: 'in-progress', assignee: 'Map' }, {
      status: 'open',
      stage: 'intake_complete',
    });
    expect(result.ok).toBe(true);
    expect(result.item?.status).toBe('in-progress');
    expect(result.item?.assignee).toBe('Map');
  });

  it('fails stale (no write) when the status no longer matches', () => {
    const seeded = seed('completed', 'in_review');
    // Another pane already claimed it: the guard expects completed, but the
    // stored status is in-progress.
    db.update(seeded.id, { status: 'in-progress' });
    const result = db.updateIfMatches(seeded.id, { status: 'in-progress', assignee: 'Map' }, {
      status: 'completed',
      stage: 'in_review',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('stale');
    // No write happened: the item is unchanged (still the other pane's claim).
    expect(db.get(seeded.id)?.assignee).not.toBe('Map');
  });

  it('fails stale when the stage no longer matches', () => {
    const seeded = seed('open', 'intake_complete');
    db.update(seeded.id, { stage: 'plan_complete' });
    const result = db.updateIfMatches(seeded.id, { status: 'in-progress' }, {
      status: 'open',
      stage: 'intake_complete',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('stale');
    expect(db.get(seeded.id)?.status).toBe('open'); // unchanged
  });

  it('normalizes status spelling (in_progress matches stored in-progress)', () => {
    const seeded = seed('open', 'idea');
    const result = db.updateIfMatches(seeded.id, { status: 'in-progress' }, { status: 'open' });
    expect(result.ok).toBe(true);
    // And the guard itself is spelling-insensitive on the stored value too.
    const r2 = db.updateIfMatches(seeded.id, { assignee: 'Map' }, { status: 'in_progress' });
    expect(r2.ok).toBe(true);
  });

  it('fails not-found for an unknown id', () => {
    const result = db.updateIfMatches('WI-NOPE', { status: 'in-progress' }, { status: 'open' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not-found');
  });

  it('applies without a guard when no expected state is given', () => {
    const seeded = seed('open', 'idea');
    const result = db.updateIfMatches(seeded.id, { status: 'in-progress' });
    expect(result.ok).toBe(true);
    expect(result.item?.status).toBe('in-progress');
  });
});

describe('upsertItems() no-op guard (WL-0MSORD6HC005QVZX)', () => {
  it('preserves updatedAt when only description differs by a trailing newline', () => {
    const original = makeItem();
    db.import([original]);
    db.upsertItems([{ ...original, description: original.description + '\n' }]);
    expect(db.get(original.id)?.updatedAt).toBe(FIXED_TS);
  });

  it('bumps updatedAt on a genuine description change', () => {
    const original = makeItem();
    db.import([original]);
    db.upsertItems([{ ...original, description: 'new content' }]);
    const stored = db.get(original.id);
    expect(stored?.description).toBe('new content');
    expect(stored?.updatedAt).not.toBe(FIXED_TS);
  });
});
