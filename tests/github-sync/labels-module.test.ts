/**
 * tests/github-sync/labels-module.test.ts — the extraction contract of
 * `src/github-sync/labels.ts`.
 *
 * The label-resolution declarations moved out of `src/github-sync.ts`
 * (WL-0MW0JF7QN007E1JU, child 4 of 8). Their resolution *behaviour* is already
 * pinned by the unchanged `github-label-resolution` and
 * `github-import-label-resolution` suites, so this file asserts only what the
 * move itself must guarantee:
 *
 * | Property | Why it matters |
 * |---|---|
 * | the barrel re-exports the very same functions | a copy would silently diverge from the label module |
 * | the module's runtime surface is the three names | the `FieldChange` re-export must stay erased at runtime |
 * | the category table drives resolution end-to-end | a wrong suffix would stop that field ever resolving |
 * | every table field reaches `resolvedFields` | the import flow iterates the table to apply values |
 */

import { describe, it, expect } from 'vitest';
import type { WorkItem } from '../../src/types.js';
import type { LabelEvent } from '../../src/github.js';
import {
  LABEL_FIELD_CATEGORIES,
  resolveAllLabelFields,
  resolveLabelField,
} from '../../src/github-sync/labels.js';
import * as barrel from '../../src/github-sync.js';

const LABEL_PREFIX = 'wl:';
const LOCAL_TIME = '2025-01-01T00:00:00.000Z';

/** The six single-value categories, in the order the module resolves them. */
const EXPECTED_CATEGORIES = [
  { field: 'stage', category: 'stage:' },
  { field: 'priority', category: 'priority:' },
  { field: 'status', category: 'status:' },
  { field: 'issueType', category: 'type:' },
  { field: 'risk', category: 'risk:' },
  { field: 'effort', category: 'effort:' },
];

const LOCAL_VALUES: Record<string, string> = {
  stage: 'idea',
  priority: 'low',
  status: 'open',
  issueType: 'bug',
  risk: 'Low',
  effort: 'M',
};

const REMOTE_VALUES: Record<string, string> = {
  stage: 'done',
  priority: 'critical',
  status: 'in-progress',
  issueType: 'feature',
  risk: 'High',
  effort: 'L',
};

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'WL-LABELS1',
    title: 'Labels',
    description: '',
    status: LOCAL_VALUES.status,
    priority: LOCAL_VALUES.priority,
    sortIndex: 0,
    parentId: null,
    createdAt: LOCAL_TIME,
    updatedAt: LOCAL_TIME,
    tags: [],
    assignee: '',
    stage: LOCAL_VALUES.stage,
    issueType: LOCAL_VALUES.issueType,
    createdBy: '',
    deletedBy: '',
    deleteReason: '',
    risk: LOCAL_VALUES.risk,
    effort: LOCAL_VALUES.effort,
    ...overrides,
  };
}

/** One `labeled` event per category, labelled with the table's own suffix. */
function newerEventPerCategory(): LabelEvent[] {
  return LABEL_FIELD_CATEGORIES.map(({ field, category }, index) => ({
    label: `${LABEL_PREFIX}${category}${REMOTE_VALUES[field]}`,
    action: 'labeled' as const,
    // Every event is newer than the local updatedAt, later ones last.
    createdAt: `2025-02-0${index + 1}T00:00:00.000Z`,
  }));
}

describe('src/github-sync/labels.ts — extraction contract', () => {
  it('is the single implementation the barrel re-exports', () => {
    // Identity, not just presence: a duplicated copy in `github-sync.ts` would
    // pass a "is exported" check yet drift from the module under change.
    expect(barrel.resolveLabelField).toBe(resolveLabelField);
    expect(barrel.resolveAllLabelFields).toBe(resolveAllLabelFields);
  });

  it('exposes three runtime names, so the FieldChange re-export stays erased', async () => {
    const mod = await import('../../src/github-sync/labels.js');
    expect(Object.keys(mod).sort()).toEqual([
      'LABEL_FIELD_CATEGORIES',
      'resolveAllLabelFields',
      'resolveLabelField',
    ]);
  });

  it('records the six single-value categories with their label suffixes', () => {
    expect(LABEL_FIELD_CATEGORIES).toEqual(EXPECTED_CATEGORIES);
  });

  it('resolves each category end-to-end from the suffix recorded in the table', () => {
    const { resolvedFields, fieldChanges } = resolveAllLabelFields(
      makeItem(),
      {
        stage: REMOTE_VALUES.stage,
        priority: REMOTE_VALUES.priority,
        status: REMOTE_VALUES.status,
        issueType: REMOTE_VALUES.issueType,
        risk: REMOTE_VALUES.risk,
        effort: REMOTE_VALUES.effort,
      },
      newerEventPerCategory(),
      LABEL_PREFIX,
      LOCAL_TIME,
    );

    // A wrong suffix in the table would leave that field on its local value.
    for (const { field } of LABEL_FIELD_CATEGORIES) {
      expect(resolvedFields[field]).toBe(REMOTE_VALUES[field]);
    }
    expect(fieldChanges.map((change) => change.field).sort()).toEqual(
      EXPECTED_CATEGORIES.map(({ field }) => field).sort(),
    );
  });

  it('hands the import flow exactly one resolved value per table field', () => {
    const { resolvedFields } = resolveAllLabelFields(
      makeItem(),
      {
        stage: '',
        priority: '',
        status: '',
        issueType: '',
        risk: '',
        effort: '',
      },
      [],
      LABEL_PREFIX,
      LOCAL_TIME,
    );

    // The import flow iterates the table to copy `resolvedFields` back onto the
    // item, so a field missing here would silently stop being applied.
    expect(Object.keys(resolvedFields)).toEqual(LABEL_FIELD_CATEGORIES.map(({ field }) => field));
    for (const { field } of LABEL_FIELD_CATEGORIES) {
      expect(resolvedFields[field]).toBe(LOCAL_VALUES[field]);
    }
  });
});
