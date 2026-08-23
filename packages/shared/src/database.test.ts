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
import { WorkItem, Comment } from './types.js';

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

// ── WL-0MSN6ZCTN0027U2R: needsProducerReview flag flips must not bump updatedAt ──

describe('update() needsProducerReview flag-only does not bump updatedAt (WL-0MSN6ZCTN0027U2R)', () => {
  function seed(): WorkItem {
    const item = makeItem({ id: 'WI-NPR1', title: 'Flag test', description: 'has content', needsProducerReview: false });
    db.import([item]);
    return item;
  }

  it('flips needsProducerReview true but preserves updatedAt', () => {
    const seeded = seed();
    const updated = db.update(seeded.id, { needsProducerReview: true });
    expect(updated?.needsProducerReview).toBe(true);
    expect(updated?.updatedAt).toBe(FIXED_TS);
    // Verify the change is persisted to the database.
    expect(db.get(seeded.id)?.needsProducerReview).toBe(true);
    expect(db.get(seeded.id)?.updatedAt).toBe(FIXED_TS);
  });

  it('flips needsProducerReview false but preserves updatedAt', () => {
    const seeded = seed();
    // Flip to true first so we can flip back.
    db.update(seeded.id, { needsProducerReview: true });
    const updated = db.update(seeded.id, { needsProducerReview: false });
    expect(updated?.needsProducerReview).toBe(false);
    expect(updated?.updatedAt).toBe(FIXED_TS);
    expect(db.get(seeded.id)?.needsProducerReview).toBe(false);
  });

  it('content field + needsProducerReview flag bumps updatedAt (combined update)', () => {
    const seeded = seed();
    const updated = db.update(seeded.id, { title: 'Updated title', needsProducerReview: true });
    expect(updated?.title).toBe('Updated title');
    expect(updated?.needsProducerReview).toBe(true);
    expect(updated?.updatedAt).not.toBe(FIXED_TS);
    expect(db.get(seeded.id)?.updatedAt).not.toBe(FIXED_TS);
  });

  it('no-op update (needsProducerReview already true) preserves updatedAt', () => {
    const seeded = seed();
    db.update(seeded.id, { needsProducerReview: true });
    const updated = db.update(seeded.id, { needsProducerReview: true });
    expect(updated?.updatedAt).toBe(FIXED_TS);
  });

  it('no-op update (needsProducerReview already false) preserves updatedAt', () => {
    const seeded = seed();
    const updated = db.update(seeded.id, { needsProducerReview: false });
    expect(updated?.updatedAt).toBe(FIXED_TS);
  });

  it('content-only update still bumps updatedAt (regression)', () => {
    const seeded = seed();
    const updated = db.update(seeded.id, { title: 'New title' });
    expect(updated?.title).toBe('New title');
    expect(updated?.updatedAt).not.toBe(FIXED_TS);
  });
});

// ── WL-0MT3FLZJ20076X9B: riskOrdinal / effortOrdinal verbose matching ──

describe('riskOrdinal handles verbose agent-produced descriptions (WL-0MT3FLZJ20076X9B)', () => {
  // Access private method via any-cast (consistent with the test file's pattern).
  // db is (re)initialized per-test in the top-level beforeEach; grab it lazily.
  function ordinal(): any {
    return (db as any).riskOrdinal.bind(db);
  }

  it('recognises plain risk levels', () => {
    const o = ordinal();
    expect(o('low')).toBe(1);
    expect(o('medium')).toBe(2);
    expect(o('high')).toBe(3);
    expect(o('severe')).toBe(4);
    expect(o('critical')).toBe(4);
  });

  it('recognises verbose risk descriptions with em-dash', () => {
    const o = ordinal();
    expect(o('Medium — NVIDIA driver changes can affect GPU functionality')).toBe(2);
    expect(o('High — Critical security vulnerability in authentication module')).toBe(3);
    expect(o('Low — Minor cosmetic issue in settings page')).toBe(1);
  });

  it('recognises verbose risk with en-dash and colon', () => {
    const o = ordinal();
    expect(o('Severe — System stability impact')).toBe(4);
    expect(o('Critical: Data loss possible')).toBe(4);
  });

  it('handles case-insensitive matching', () => {
    const o = ordinal();
    expect(o('MEDIUM')).toBe(2);
    expect(o('Medium — test')).toBe(2);
    expect(o(' mEdIuM ')).toBe(2);
  });

  it('returns null for unknown / unset values (fail-closed)', () => {
    const o = ordinal();
    expect(o(null)).toBe(null);
    expect(o(undefined)).toBe(null);
    expect(o('')).toBe(null);
    expect(o('unknown')).toBe(null);
    expect(o('Medium — ')).toBe(2); // keyword still extracted
  });
});

describe('effortOrdinal handles verbose agent-produced descriptions (WL-0MT3FLZJ20076X9B)', () => {
  function ordinal(): any {
    return (db as any).effortOrdinal.bind(db);
  }

  it('recognises plain effort levels and short spellings', () => {
    const o = ordinal();
    expect(o('xs')).toBe(1);
    expect(o('s')).toBe(2);
    expect(o('m')).toBe(3);
    expect(o('l')).toBe(4);
    expect(o('xl')).toBe(5);
    expect(o('extra small')).toBe(1);
    expect(o('small')).toBe(2);
    expect(o('medium')).toBe(3);
    expect(o('large')).toBe(4);
    expect(o('extra large')).toBe(5);
  });

  it('recognises verbose effort descriptions with word-boundary fallback', () => {
    const o = ordinal();
    expect(o('1–4 hours — Small. Diagnostic investigation')).toBe(2);
    expect(o('2–6 hours — Medium. Refactoring needed')).toBe(3);
    expect(o('1–2 days — Large. Major rewrite')).toBe(4);
    expect(o('2–6 hours — Small. Diagnostic')).toBe(2);
  });

  it('short spellings work in verbose strings', () => {
    const o = ordinal();
    expect(o('1–4 hours — S. Small task')).toBe(2);
    expect(o('Quick — M. Medium complexity')).toBe(3);
  });

  it('long forms still work (regression)', () => {
    const o = ordinal();
    expect(o('Extra Small')).toBe(1);
    expect(o('extra small')).toBe(1);
    expect(o('Extra Large')).toBe(5);
    expect(o('extra large')).toBe(5);
  });

  it('handles case-insensitive matching', () => {
    const o = ordinal();
    expect(o('MEDIUM')).toBe(3);
    expect(o('Small — test')).toBe(2);
    expect(o(' XL ')).toBe(5);
  });

  it('returns null for unknown / unset values (fail-closed)', () => {
    const o = ordinal();
    expect(o(null)).toBe(null);
    expect(o(undefined)).toBe(null);
    expect(o('')).toBe(null);
    expect(o('unknown')).toBe(null);
  });
});

describe('matchesRiskEffort filters correctly with verbose descriptions (WL-0MT3FLZJ20076X9B)', () => {
  function matches(): any {
    return (db as any).matchesRiskEffort.bind(db);
  }
  function item(overrides: Partial<WorkItem> = {}): WorkItem {
    return makeFactoryItem(overrides);
  }

  it('at-most medium risk filter accepts plain medium and verbose medium', () => {
    const m = matches();
    expect(m(item({ risk: 'medium' }), 'medium', undefined)).toBe(true);
    expect(m(item({ risk: 'Medium — something' }), 'medium', undefined)).toBe(true);
    expect(m(item({ risk: 'low' }), 'medium', undefined)).toBe(true);
  });

  it('at-most medium risk filter rejects high / severe risk', () => {
    const m = matches();
    expect(m(item({ risk: 'high' }), 'medium', undefined)).toBe(false);
    expect(m(item({ risk: 'Severe — stability' }), 'medium', undefined)).toBe(false);
    expect(m(item({ risk: 'Critical: data loss' }), 'medium', undefined)).toBe(false);
  });

  it('at-most medium effort filter accepts plain small and verbose small', () => {
    const m = matches();
    expect(m(item({ effort: 'small' }), undefined, 'medium')).toBe(true);
    expect(m(item({ effort: '1–4 hours — Small. Investigation' }), undefined, 'medium')).toBe(true);
    expect(m(item({ effort: 'extra small' }), undefined, 'medium')).toBe(true);
  });

  it('at-most small effort filter rejects medium / large effort', () => {
    const m = matches();
    expect(m(item({ effort: 'medium' }), undefined, 'small')).toBe(false);
    expect(m(item({ effort: 'Large. Major rewrite' }), undefined, 'small')).toBe(false);
  });

  it('both filters applied together work correctly', () => {
    const m = matches();
    expect(m(item({ risk: 'Medium — something', effort: 'Small — quick fix' }), 'medium', 'medium')).toBe(true);
    expect(m(item({ risk: 'High', effort: 'Small' }), 'medium', 'medium')).toBe(false);
    expect(m(item({ risk: 'Medium', effort: 'Large' }), 'medium', 'medium')).toBe(false);
  });

  it('unknown risk / effort on item causes fail-closed', () => {
    const m = matches();
    expect(m(item({ risk: 'unknown', effort: 'medium' }), 'medium', 'medium')).toBe(false);
    expect(m(item({ risk: 'medium', effort: 'unknown' }), 'medium', 'medium')).toBe(false);
  });
});

// Helper to build items for matchesRiskEffort tests (avoids circular dependency with makeItem).
function makeFactoryItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'WI-0001',
    title: 'Test item',
    description: 'Test description',
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

// ── WL-0MT2KYCNB000CYWV: delta pull persists COMMENTS non-destructively ──

describe('upsertComments() non-destructive merge (WL-0MT2KYCNB000CYWV)', () => {
  function makeComment(id: string, itemId: string, text: string): Comment {
    return {
      id,
      workItemId: itemId,
      author: 'test@example.com',
      comment: text,
      createdAt: FIXED_TS,
      references: [],
    };
  }

  it('keeps local comments absent from the incoming delta and adds new ones', () => {
    // Comments carry a FOREIGN KEY to a work item — seed both items first.
    db.import([makeItem({ id: 'WI-0001' }), makeItem({ id: 'WI-0002' })]);
    const localComment = makeComment('C-1', 'WI-0001', 'local comment');
    db.importComments([localComment]);

    // A delta arrives containing an overlap (C-1 updated) and a brand-new
    // comment for a different item—but NOT a comment the local store has.
    db.upsertComments([
      { ...localComment, comment: 'local comment updated by remote' },
      makeComment('C-3', 'WI-0002', 'new remote comment'),
    ]);

    const all = db.getAllComments();
    // Non-destructive: C-1 kept (converged to the remote value); C-3 added.
    expect(all.some(c => c.id === 'C-1' && c.comment === 'local comment updated by remote')).toBe(true);
    expect(all.some(c => c.id === 'C-3' && c.workItemId === 'WI-0002')).toBe(true);
    // No duplicates after the overlap upsert (INSERT OR REPLACE by id).
    expect(all.filter(c => c.id === 'C-1').length).toBe(1);
    expect(all.some(c => c.id === 'C-2')).toBe(false);
  });
});
