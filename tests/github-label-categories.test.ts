/**
 * Tests for worklog category label logic in github.ts
 *
 * Validates that:
 * - isSingleValueCategoryLabel correctly identifies all single-valued
 *   worklog label categories (status, priority, stage, type, risk, effort)
 * - Tag labels (wl:tag:*) are NOT treated as single-valued
 * - Labels outside the worklog prefix are not matched
 * - workItemToIssuePayload produces the expected labels for each category
 * - Legacy bare status labels (wl:open, wl:in-progress, etc.) are recognised
 */

import { describe, it, expect } from 'vitest';
import {
  isSingleValueCategoryLabel,
  normalizeGithubLabelPrefix,
  workItemToIssuePayload,
} from '../src/github.js';
import type { WorkItem } from '../src/types.js';

const defaultPrefix = 'wl:';

function makeItem(overrides: Partial<WorkItem> & { id: string }): WorkItem {
  return {
    title: overrides.id,
    description: '',
    status: 'open',
    priority: 'medium',
    sortIndex: 0,
    parentId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tags: [],
    assignee: '',
    stage: '',
    issueType: '',
    createdBy: '',
    deletedBy: '',
    deleteReason: '',
    risk: '',
    effort: '',
    ...overrides,
  } as WorkItem;
}

describe('isSingleValueCategoryLabel', () => {
  it('identifies wl:status:* labels', () => {
    expect(isSingleValueCategoryLabel('wl:status:open', defaultPrefix)).toBe(true);
    expect(isSingleValueCategoryLabel('wl:status:in-progress', defaultPrefix)).toBe(true);
    expect(isSingleValueCategoryLabel('wl:status:completed', defaultPrefix)).toBe(true);
    expect(isSingleValueCategoryLabel('wl:status:blocked', defaultPrefix)).toBe(true);
    expect(isSingleValueCategoryLabel('wl:status:deleted', defaultPrefix)).toBe(true);
  });

  it('identifies wl:priority:* labels', () => {
    expect(isSingleValueCategoryLabel('wl:priority:low', defaultPrefix)).toBe(true);
    expect(isSingleValueCategoryLabel('wl:priority:medium', defaultPrefix)).toBe(true);
    expect(isSingleValueCategoryLabel('wl:priority:high', defaultPrefix)).toBe(true);
    expect(isSingleValueCategoryLabel('wl:priority:critical', defaultPrefix)).toBe(true);
  });

  it('identifies wl:stage:* labels', () => {
    expect(isSingleValueCategoryLabel('wl:stage:idea', defaultPrefix)).toBe(true);
    expect(isSingleValueCategoryLabel('wl:stage:in_review', defaultPrefix)).toBe(true);
    expect(isSingleValueCategoryLabel('wl:stage:done', defaultPrefix)).toBe(true);
    expect(isSingleValueCategoryLabel('wl:stage:in_progress', defaultPrefix)).toBe(true);
  });

  it('identifies wl:type:* labels', () => {
    expect(isSingleValueCategoryLabel('wl:type:bug', defaultPrefix)).toBe(true);
    expect(isSingleValueCategoryLabel('wl:type:feature', defaultPrefix)).toBe(true);
    expect(isSingleValueCategoryLabel('wl:type:task', defaultPrefix)).toBe(true);
    expect(isSingleValueCategoryLabel('wl:type:epic', defaultPrefix)).toBe(true);
  });

  it('identifies wl:risk:* labels', () => {
    expect(isSingleValueCategoryLabel('wl:risk:Low', defaultPrefix)).toBe(true);
    expect(isSingleValueCategoryLabel('wl:risk:High', defaultPrefix)).toBe(true);
    expect(isSingleValueCategoryLabel('wl:risk:Severe', defaultPrefix)).toBe(true);
  });

  it('identifies wl:effort:* labels', () => {
    expect(isSingleValueCategoryLabel('wl:effort:XS', defaultPrefix)).toBe(true);
    expect(isSingleValueCategoryLabel('wl:effort:M', defaultPrefix)).toBe(true);
    expect(isSingleValueCategoryLabel('wl:effort:XL', defaultPrefix)).toBe(true);
  });

  it('identifies legacy bare status labels', () => {
    expect(isSingleValueCategoryLabel('wl:open', defaultPrefix)).toBe(true);
    expect(isSingleValueCategoryLabel('wl:in-progress', defaultPrefix)).toBe(true);
    expect(isSingleValueCategoryLabel('wl:completed', defaultPrefix)).toBe(true);
    expect(isSingleValueCategoryLabel('wl:blocked', defaultPrefix)).toBe(true);
    expect(isSingleValueCategoryLabel('wl:deleted', defaultPrefix)).toBe(true);
  });

  it('does NOT match wl:tag:* labels (tags are multi-valued)', () => {
    expect(isSingleValueCategoryLabel('wl:tag:frontend', defaultPrefix)).toBe(false);
    expect(isSingleValueCategoryLabel('wl:tag:bug-fix', defaultPrefix)).toBe(false);
  });

  it('does NOT match labels without the worklog prefix', () => {
    expect(isSingleValueCategoryLabel('bug', defaultPrefix)).toBe(false);
    expect(isSingleValueCategoryLabel('enhancement', defaultPrefix)).toBe(false);
    expect(isSingleValueCategoryLabel('status:open', defaultPrefix)).toBe(false);
  });

  it('respects custom label prefix', () => {
    const customPrefix = 'myapp:';
    expect(isSingleValueCategoryLabel('myapp:stage:idea', customPrefix)).toBe(true);
    expect(isSingleValueCategoryLabel('myapp:priority:high', customPrefix)).toBe(true);
    expect(isSingleValueCategoryLabel('wl:stage:idea', customPrefix)).toBe(false);
  });

  it('handles prefix without trailing colon', () => {
    // normalizeGithubLabelPrefix adds colon if missing
    expect(isSingleValueCategoryLabel('wl:stage:idea', 'wl')).toBe(true);
    expect(isSingleValueCategoryLabel('wl:priority:high', 'wl')).toBe(true);
  });
});

describe('stale label removal scenario', () => {
  it('correctly identifies stale stage labels for removal', () => {
    // Simulate the scenario from the bug report:
    // Issue currently has these labels on GitHub
    const currentLabels = [
      'wl:stage:idea',
      'wl:stage:in_review',
      'wl:priority:P2',
      'wl:status:open',
      'wl:type:bug',
      'wl:tag:frontend',
      'enhancement',
    ];

    // The desired labels from workItemToIssuePayload
    const desiredLabels = [
      'wl:stage:done',
      'wl:priority:medium',
      'wl:status:open',
      'wl:type:bug',
      'wl:tag:frontend',
    ];
    const desiredSet = new Set(desiredLabels);

    // Compute stale labels using isSingleValueCategoryLabel
    const staleLabels = currentLabels.filter(
      label => isSingleValueCategoryLabel(label, defaultPrefix) && !desiredSet.has(label)
    );

    // Should remove old stage and priority labels but NOT the tag or non-wl labels
    expect(staleLabels).toContain('wl:stage:idea');
    expect(staleLabels).toContain('wl:stage:in_review');
    expect(staleLabels).toContain('wl:priority:P2');
    expect(staleLabels).not.toContain('wl:status:open'); // still desired
    expect(staleLabels).not.toContain('wl:type:bug'); // still desired
    expect(staleLabels).not.toContain('wl:tag:frontend'); // tags are multi-valued
    expect(staleLabels).not.toContain('enhancement'); // not a wl label
  });

  it('does not remove labels when desired set matches current set', () => {
    const currentLabels = [
      'wl:stage:done',
      'wl:priority:medium',
      'wl:status:open',
    ];
    const desiredLabels = [
      'wl:stage:done',
      'wl:priority:medium',
      'wl:status:open',
    ];
    const desiredSet = new Set(desiredLabels);

    const staleLabels = currentLabels.filter(
      label => isSingleValueCategoryLabel(label, defaultPrefix) && !desiredSet.has(label)
    );

    expect(staleLabels).toHaveLength(0);
  });

  it('handles multiple accumulated labels of the same category', () => {
    // Three stage labels accumulated over time
    const currentLabels = [
      'wl:stage:idea',
      'wl:stage:in_review',
      'wl:stage:done',
    ];
    const desiredLabels = ['wl:stage:done'];
    const desiredSet = new Set(desiredLabels);

    const staleLabels = currentLabels.filter(
      label => isSingleValueCategoryLabel(label, defaultPrefix) && !desiredSet.has(label)
    );

    expect(staleLabels).toEqual(['wl:stage:idea', 'wl:stage:in_review']);
  });

  it('removes legacy bare status labels when not in desired set', () => {
    const currentLabels = [
      'wl:open',  // legacy bare status
      'wl:status:in-progress',  // new format
    ];
    const desiredLabels = ['wl:status:in-progress'];
    const desiredSet = new Set(desiredLabels);

    const staleLabels = currentLabels.filter(
      label => isSingleValueCategoryLabel(label, defaultPrefix) && !desiredSet.has(label)
    );

    expect(staleLabels).toEqual(['wl:open']);
  });
});

describe('workItemToIssuePayload label generation', () => {
  it('generates one label per category', () => {
    const item = makeItem({
      id: 'TEST-1',
      status: 'in-progress',
      priority: 'high',
      stage: 'in_review',
      issueType: 'bug',
      risk: 'High',
      effort: 'M',
      tags: ['frontend', 'urgent'],
    });

    const payload = workItemToIssuePayload(item, [], defaultPrefix);

    expect(payload.labels).toContain('wl:status:in-progress');
    expect(payload.labels).toContain('wl:priority:high');
    expect(payload.labels).toContain('wl:stage:in_review');
    expect(payload.labels).toContain('wl:type:bug');
    expect(payload.labels).toContain('wl:risk:High');
    expect(payload.labels).toContain('wl:effort:M');
    expect(payload.labels).toContain('wl:tag:frontend');
    expect(payload.labels).toContain('wl:tag:urgent');

    // Should have exactly one label per single-value category
    const stageLabels = payload.labels.filter(l => l.startsWith('wl:stage:'));
    const priorityLabels = payload.labels.filter(l => l.startsWith('wl:priority:'));
    const statusLabels = payload.labels.filter(l => l.startsWith('wl:status:'));
    expect(stageLabels).toHaveLength(1);
    expect(priorityLabels).toHaveLength(1);
    expect(statusLabels).toHaveLength(1);
  });

  it('omits stage label when stage is empty', () => {
    const item = makeItem({
      id: 'TEST-2',
      stage: '',
    });

    const payload = workItemToIssuePayload(item, [], defaultPrefix);

    const stageLabels = payload.labels.filter(l => l.startsWith('wl:stage:'));
    expect(stageLabels).toHaveLength(0);
  });
});
