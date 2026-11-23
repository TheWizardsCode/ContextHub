/**
 * Unit tests for `src/doctor/parent-check.ts` — orphan detection and the
 * grouped-by-lost-parent summary (R3 / R3b, WL-0MWGRKLLG0035PLG).
 *
 * The end-to-end contract is pinned by `tests/cli/orphan-guard-reporting.test.ts`;
 * this file pins the module seams directly: soft-deleted parents are
 * unresolvable, soft-deleted children are not re-reported as orphans, and the
 * grouped summary carries the lost-parent id, child count and child ids.
 */

import { describe, it, expect } from 'vitest';
import {
  validateParentReferences,
  groupOrphanFindings,
  groupOrphansByLostParent,
} from '../src/doctor/parent-check.js';
import type { WorkItem } from '../src/types.js';

const baseItem = (id: string, overrides: Partial<WorkItem> = {}): WorkItem => ({
  id,
  title: `Item ${id}`,
  description: '',
  status: 'open',
  priority: 'medium',
  sortIndex: 0,
  parentId: null,
  createdAt: '2026-02-01T00:00:00.000Z',
  updatedAt: '2026-02-01T00:00:00.000Z',
  tags: [],
  assignee: '',
  stage: '',
  issueType: 'task',
  createdBy: '',
  deletedBy: '',
  deleteReason: '',
  risk: '',
  effort: '',
  ...overrides,
});

describe('doctor parent validation', () => {
  it('returns no findings when the parent resolves to a live item', () => {
    const items = [
      baseItem('TEST-PARENT'),
      baseItem('TEST-CHILD', { parentId: 'TEST-PARENT' }),
    ];
    expect(validateParentReferences(items)).toEqual([]);
  });

  it('flags children of a hard-deleted (missing) parent, naming the lost parent (R3)', () => {
    const items = [
      baseItem('TEST-CHILD', { parentId: 'TEST-GONEPAR' }),
    ];
    const findings = validateParentReferences(items);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      checkId: 'parent.missing-endpoint',
      type: 'missing-parent',
      itemId: 'TEST-CHILD',
      context: { parentId: 'TEST-GONEPAR' },
    });
  });

  it('treats a soft-deleted parent as unresolvable so its live child is reported (R3b)', () => {
    const items = [
      baseItem('TEST-SOFTPAR', { status: 'deleted', deletedBy: 'someone' }),
      baseItem('TEST-SOFTKID', { parentId: 'TEST-SOFTPAR' }),
    ];
    const findings = validateParentReferences(items);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      type: 'missing-parent',
      itemId: 'TEST-SOFTKID',
      context: { parentId: 'TEST-SOFTPAR' },
    });
  });

  it('does not re-report a soft-deleted child as an orphan', () => {
    // A recursively deleted subtree keeps parentId on the tombstoned
    // descendants; those rows are retired, not live orphans.
    const items = [
      baseItem('TEST-GONEPAR'),
      baseItem('TEST-DELETEDKID', { parentId: 'TEST-GONEPAR', status: 'deleted' }),
    ];
    expect(validateParentReferences(items)).toEqual([]);
  });

  it('groups orphan findings by lost-parent id with count and child ids (R3)', () => {
    const items = [
      baseItem('TEST-GONEKID1', { parentId: 'TEST-GONEPAR' }),
      baseItem('TEST-GONEKID2', { parentId: 'TEST-GONEPAR' }),
      baseItem('TEST-SOFTKID', { parentId: 'TEST-SOFTPAR' }),
      baseItem('TEST-SOFTPAR', { status: 'deleted' }),
    ];
    const groups = groupOrphansByLostParent(items);

    expect(groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          parentId: 'TEST-GONEPAR',
          count: 2,
          childIds: expect.arrayContaining(['TEST-GONEKID1', 'TEST-GONEKID2']),
        }),
        expect.objectContaining({
          parentId: 'TEST-SOFTPAR',
          count: 1,
          childIds: ['TEST-SOFTKID'],
        }),
      ]),
    );
  });

  it('ignores findings that are not missing-parent findings', () => {
    const groups = groupOrphanFindings([
      {
        checkId: 'priority.invalid',
        type: 'invalid-priority',
        severity: 'warning',
        itemId: 'TEST-BADPRIORITY',
        message: 'invalid priority',
        proposedFix: null,
        safe: false,
        context: { parentId: 'NOT-A-PARENT' },
      },
    ]);
    expect(groups).toEqual([]);
  });
});
