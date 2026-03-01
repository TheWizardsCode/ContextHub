/**
 * Integration tests for import label resolution (Feature 5).
 *
 * Validates that importIssuesToWorkItems() correctly resolves label-derived
 * fields (stage, priority, issueType) using event timestamps when label
 * values differ from local values.
 *
 * Scenarios covered:
 * - Remote-newer: GitHub label changed more recently than local updatedAt → remote wins
 * - Local-newer: Local updatedAt is more recent than label event → local preserved
 * - Multi-label: Two wl:stage:* labels on same issue, newer event wins
 * - Fallback: Events API returns empty → uses issue updated_at as event timestamp
 * - No-diff: All label fields match local → no event fetch, no field changes
 * - Audit output: fieldChanges array contains correct FieldChange records
 * - No events fetched for matching issues (no unnecessary API calls)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkItem, WorkItemStatus, WorkItemPriority } from '../src/types.js';
import type { LabelEvent, GithubConfig } from '../src/github.js';

// Hoist mock function references so vi.mock factory can access them
const { mockFetchLabelEventsAsync, mockListGithubIssues } = vi.hoisted(() => ({
  mockFetchLabelEventsAsync: vi.fn(),
  mockListGithubIssues: vi.fn(),
}));

vi.mock('../src/github.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/github.js')>();
  return {
    ...actual,
    // Override only the functions that make real API calls
    listGithubIssues: mockListGithubIssues,
    getGithubIssue: vi.fn(() => { throw new Error('not found'); }),
    getIssueHierarchy: vi.fn(() => ({ parentIssueNumber: null, childIssueNumbers: [] })),
    getIssueHierarchyAsync: vi.fn(async () => ({ parentIssueNumber: null, childIssueNumbers: [] })),
    createGithubIssue: vi.fn(),
    createGithubIssueAsync: vi.fn(),
    updateGithubIssue: vi.fn(),
    updateGithubIssueAsync: vi.fn(),
    getGithubIssueAsync: vi.fn(),
    listGithubIssueComments: vi.fn(() => []),
    listGithubIssueCommentsAsync: vi.fn(async () => []),
    createGithubIssueComment: vi.fn(),
    createGithubIssueCommentAsync: vi.fn(),
    updateGithubIssueComment: vi.fn(),
    updateGithubIssueCommentAsync: vi.fn(),
    addSubIssueLink: vi.fn(),
    addSubIssueLinkResult: vi.fn(() => ({ ok: true })),
    addSubIssueLinkResultAsync: vi.fn(async () => ({ ok: true })),
    buildWorklogCommentMarker: vi.fn(),
    // Keep real implementations for label parsing and event helpers:
    // issueToWorkItemFields, labelFieldsDiffer, getLatestLabelEventTimestamp,
    // normalizeGithubLabelPrefix, LabelEventCache, stripWorklogMarkers,
    // extractWorklogId, extractParentId, extractChildIds,
    // extractParentIssueNumber, extractChildIssueNumbers
    // Override fetchLabelEventsAsync with our mock
    fetchLabelEventsAsync: mockFetchLabelEventsAsync,
  };
});

vi.mock('../src/github-metrics.js', () => ({
  increment: vi.fn(),
  snapshot: vi.fn(() => ({})),
  diff: vi.fn(() => ({})),
}));

import { importIssuesToWorkItems, FieldChange } from '../src/github-sync.js';

const T_BASE = '2026-01-01T00:00:00.000Z';
const T_LOCAL_UPDATE = '2026-01-10T00:00:00.000Z';
const T_LABEL_OLDER = '2026-01-05T00:00:00.000Z';
const T_LABEL_NEWER = '2026-01-15T00:00:00.000Z';
const T_ISSUE_UPDATE = '2026-01-12T00:00:00.000Z';

function makeLocalItem(overrides: Partial<WorkItem> & { id: string }): WorkItem {
  return {
    title: overrides.id,
    description: '',
    status: 'open' as WorkItemStatus,
    priority: 'medium' as WorkItemPriority,
    sortIndex: 0,
    parentId: null,
    createdAt: T_BASE,
    updatedAt: T_LOCAL_UPDATE,
    tags: [],
    assignee: '',
    stage: 'idea',
    issueType: '',
    createdBy: '',
    deletedBy: '',
    deleteReason: '',
    risk: '',
    effort: '',
    ...overrides,
  } as WorkItem;
}

function makeGithubIssue(overrides: {
  number: number;
  labels?: string[];
  body?: string;
  title?: string;
  state?: string;
  updatedAt?: string;
}) {
  return {
    number: overrides.number,
    id: overrides.number * 1000,
    title: overrides.title || `Issue #${overrides.number}`,
    body: overrides.body !== undefined ? overrides.body : `<!-- worklog:id=${overrides.number === 1 ? 'WL-001' : overrides.number === 2 ? 'WL-002' : overrides.number === 3 ? 'WL-003' : `WL-${overrides.number}`} -->`,
    state: overrides.state || 'open',
    labels: overrides.labels || [],
    updatedAt: overrides.updatedAt || T_ISSUE_UPDATE,
    subIssuesSummary: { total: 0 },
    assignees: [],
    milestone: null,
  };
}

const dummyConfig: GithubConfig = {
  repo: 'test/repo',
  labelPrefix: 'wl:',
};

describe('importIssuesToWorkItems label resolution integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: fetchLabelEventsAsync returns empty (will be overridden per test)
    mockFetchLabelEventsAsync.mockResolvedValue([]);
  });

  it('updates local stage to remote when GitHub label event is newer', async () => {
    // Local item has stage=idea, updated at T_LOCAL_UPDATE
    const localItem = makeLocalItem({ id: 'WL-001', stage: 'idea' });

    // GitHub issue has wl:stage:done label, updated at T_ISSUE_UPDATE
    const issue = makeGithubIssue({
      number: 1,
      labels: ['wl:stage:done'],
      updatedAt: T_ISSUE_UPDATE,
    });

    mockListGithubIssues.mockReturnValue([issue]);

    // Label event: wl:stage:done was added AFTER local updatedAt
    mockFetchLabelEventsAsync.mockResolvedValue([
      { label: 'wl:stage:done', action: 'labeled', createdAt: T_LABEL_NEWER },
    ] as LabelEvent[]);

    const result = await importIssuesToWorkItems([localItem], dummyConfig, {
      generateId: () => 'WL-GEN',
    });

    // The merged item should have stage=done (remote won)
    const merged = result.mergedItems.find(item => item.id === 'WL-001');
    expect(merged).toBeDefined();
    expect(merged!.stage).toBe('done');

    // fieldChanges should include the stage change
    expect(result.fieldChanges.length).toBeGreaterThanOrEqual(1);
    const stageChange = result.fieldChanges.find(fc => fc.field === 'stage' && fc.workItemId === 'WL-001');
    expect(stageChange).toBeDefined();
    expect(stageChange!.oldValue).toBe('idea');
    expect(stageChange!.newValue).toBe('done');
    expect(stageChange!.source).toBe('github-label');
    expect(stageChange!.timestamp).toBe(T_LABEL_NEWER);
  });

  it('preserves local stage when local updatedAt is newer than label event', async () => {
    // Local item has stage=review, updated at T_LABEL_NEWER (very recent)
    const localItem = makeLocalItem({
      id: 'WL-001',
      stage: 'review',
      updatedAt: T_LABEL_NEWER,
    });

    // GitHub issue has wl:stage:done label
    const issue = makeGithubIssue({
      number: 1,
      labels: ['wl:stage:done'],
      updatedAt: T_ISSUE_UPDATE,
    });

    mockListGithubIssues.mockReturnValue([issue]);

    // Label event is OLDER than local updatedAt
    mockFetchLabelEventsAsync.mockResolvedValue([
      { label: 'wl:stage:done', action: 'labeled', createdAt: T_LOCAL_UPDATE },
    ] as LabelEvent[]);

    const result = await importIssuesToWorkItems([localItem], dummyConfig, {
      generateId: () => 'WL-GEN',
    });

    const merged = result.mergedItems.find(item => item.id === 'WL-001');
    expect(merged).toBeDefined();
    // Local stage should be preserved since local is newer
    expect(merged!.stage).toBe('review');

    // No stage fieldChange should be present (no actual change)
    const stageChange = result.fieldChanges.find(fc => fc.field === 'stage' && fc.workItemId === 'WL-001');
    expect(stageChange).toBeUndefined();
  });

  it('selects the most recently added label when multiple wl:stage:* labels exist', async () => {
    // Local item has stage=idea
    const localItem = makeLocalItem({ id: 'WL-001', stage: 'idea' });

    // GitHub issue has TWO stage labels
    const issue = makeGithubIssue({
      number: 1,
      labels: ['wl:stage:review', 'wl:stage:done'],
      updatedAt: T_ISSUE_UPDATE,
    });

    mockListGithubIssues.mockReturnValue([issue]);

    // Events: review added first, done added later (both newer than local)
    const olderEventTime = '2026-01-14T00:00:00.000Z';
    const newerEventTime = '2026-01-16T00:00:00.000Z';

    mockFetchLabelEventsAsync.mockResolvedValue([
      { label: 'wl:stage:review', action: 'labeled', createdAt: olderEventTime },
      { label: 'wl:stage:done', action: 'labeled', createdAt: newerEventTime },
    ] as LabelEvent[]);

    const result = await importIssuesToWorkItems([localItem], dummyConfig, {
      generateId: () => 'WL-GEN',
    });

    const merged = result.mergedItems.find(item => item.id === 'WL-001');
    expect(merged).toBeDefined();
    // The most recently added label (done) should win
    expect(merged!.stage).toBe('done');

    const stageChange = result.fieldChanges.find(fc => fc.field === 'stage');
    expect(stageChange).toBeDefined();
    expect(stageChange!.newValue).toBe('done');
  });

  it('falls back to issue updated_at when events API returns empty', async () => {
    // Local item has stage=idea, updated at T_LOCAL_UPDATE (Jan 10)
    const localItem = makeLocalItem({ id: 'WL-001', stage: 'idea' });

    // GitHub issue with wl:stage:done, updated at T_ISSUE_UPDATE (Jan 12, newer than local)
    const issue = makeGithubIssue({
      number: 1,
      labels: ['wl:stage:done'],
      updatedAt: T_ISSUE_UPDATE,
    });

    mockListGithubIssues.mockReturnValue([issue]);

    // Events API returns empty — resolution should fall back to issueUpdatedAt
    mockFetchLabelEventsAsync.mockResolvedValue([]);

    const result = await importIssuesToWorkItems([localItem], dummyConfig, {
      generateId: () => 'WL-GEN',
    });

    const merged = result.mergedItems.find(item => item.id === 'WL-001');
    expect(merged).toBeDefined();
    // With empty events, fallback uses issueUpdatedAt (Jan 12) vs local (Jan 10)
    // Remote is newer so remote value should apply
    expect(merged!.stage).toBe('done');

    const stageChange = result.fieldChanges.find(fc => fc.field === 'stage');
    expect(stageChange).toBeDefined();
    expect(stageChange!.newValue).toBe('done');
    // Timestamp should be the issue updated_at (fallback)
    expect(stageChange!.timestamp).toBe(T_ISSUE_UPDATE);
  });

  it('does not fetch events when all label fields match local values', async () => {
    // Local item already has stage=done matching the GitHub label
    const localItem = makeLocalItem({
      id: 'WL-001',
      stage: 'done',
      priority: 'high',
    });

    // GitHub issue with matching labels
    const issue = makeGithubIssue({
      number: 1,
      labels: ['wl:stage:done', 'wl:priority:high'],
      updatedAt: T_ISSUE_UPDATE,
    });

    mockListGithubIssues.mockReturnValue([issue]);

    const result = await importIssuesToWorkItems([localItem], dummyConfig, {
      generateId: () => 'WL-GEN',
    });

    // fetchLabelEventsAsync should NOT have been called (no diff detected)
    expect(mockFetchLabelEventsAsync).not.toHaveBeenCalled();

    // No field changes
    expect(result.fieldChanges).toEqual([]);
  });

  it('resolves multiple fields independently with mixed outcomes', async () => {
    // Local item: stage=idea (old), priority=high (very recent)
    const localItem = makeLocalItem({
      id: 'WL-001',
      stage: 'idea',
      priority: 'high' as WorkItemPriority,
      updatedAt: T_LOCAL_UPDATE, // Jan 10
    });

    // GitHub issue with different stage AND different priority
    const issue = makeGithubIssue({
      number: 1,
      labels: ['wl:stage:done', 'wl:priority:critical'],
      updatedAt: T_ISSUE_UPDATE,
    });

    mockListGithubIssues.mockReturnValue([issue]);

    // Stage label changed AFTER local update → remote wins for stage
    // Priority label changed BEFORE local update → local wins for priority
    mockFetchLabelEventsAsync.mockResolvedValue([
      { label: 'wl:stage:done', action: 'labeled', createdAt: T_LABEL_NEWER },
      { label: 'wl:priority:critical', action: 'labeled', createdAt: T_LABEL_OLDER },
    ] as LabelEvent[]);

    const result = await importIssuesToWorkItems([localItem], dummyConfig, {
      generateId: () => 'WL-GEN',
    });

    const merged = result.mergedItems.find(item => item.id === 'WL-001');
    expect(merged).toBeDefined();
    // Stage: remote wins (label newer)
    expect(merged!.stage).toBe('done');
    // Priority: local wins (label older)
    expect(merged!.priority).toBe('high');

    // Only stage should appear in fieldChanges (priority didn't change)
    const stageChange = result.fieldChanges.find(fc => fc.field === 'stage');
    expect(stageChange).toBeDefined();
    expect(stageChange!.newValue).toBe('done');

    const priorityChange = result.fieldChanges.find(fc => fc.field === 'priority');
    expect(priorityChange).toBeUndefined();
  });

  it('returns empty fieldChanges array when no label-derived fields differ', async () => {
    // Local item with no label-relevant differences
    const localItem = makeLocalItem({
      id: 'WL-001',
      stage: '',
      priority: 'medium',
    });

    // GitHub issue with no wl: labels — issueToWorkItemFields returns defaults
    const issue = makeGithubIssue({
      number: 1,
      labels: [],
      updatedAt: T_ISSUE_UPDATE,
    });

    mockListGithubIssues.mockReturnValue([issue]);

    const result = await importIssuesToWorkItems([localItem], dummyConfig, {
      generateId: () => 'WL-GEN',
    });

    // fieldChanges should be an empty array, not undefined or null
    expect(result.fieldChanges).toEqual([]);
    expect(Array.isArray(result.fieldChanges)).toBe(true);
  });

  it('produces FieldChange records with correct structure for audit output', async () => {
    const localItem = makeLocalItem({
      id: 'WL-001',
      stage: 'idea',
      issueType: 'task',
    });

    const issue = makeGithubIssue({
      number: 1,
      labels: ['wl:stage:done', 'wl:type:feature'],
      updatedAt: T_ISSUE_UPDATE,
    });

    mockListGithubIssues.mockReturnValue([issue]);

    mockFetchLabelEventsAsync.mockResolvedValue([
      { label: 'wl:stage:done', action: 'labeled', createdAt: T_LABEL_NEWER },
      { label: 'wl:type:feature', action: 'labeled', createdAt: T_LABEL_NEWER },
    ] as LabelEvent[]);

    const result = await importIssuesToWorkItems([localItem], dummyConfig, {
      generateId: () => 'WL-GEN',
    });

    // Verify structure of each FieldChange
    for (const fc of result.fieldChanges) {
      expect(fc).toHaveProperty('workItemId');
      expect(fc).toHaveProperty('field');
      expect(fc).toHaveProperty('oldValue');
      expect(fc).toHaveProperty('newValue');
      expect(fc).toHaveProperty('source', 'github-label');
      expect(fc).toHaveProperty('timestamp');
      expect(typeof fc.workItemId).toBe('string');
      expect(typeof fc.field).toBe('string');
      expect(typeof fc.timestamp).toBe('string');
    }

    // Should have changes for both stage and issueType
    const fields = result.fieldChanges.map(fc => fc.field);
    expect(fields).toContain('stage');
    expect(fields).toContain('issueType');

    // Verify specific values
    const stageChange = result.fieldChanges.find(fc => fc.field === 'stage')!;
    expect(stageChange.workItemId).toBe('WL-001');
    expect(stageChange.oldValue).toBe('idea');
    expect(stageChange.newValue).toBe('done');

    const typeChange = result.fieldChanges.find(fc => fc.field === 'issueType')!;
    expect(typeChange.workItemId).toBe('WL-001');
    expect(typeChange.oldValue).toBe('task');
    expect(typeChange.newValue).toBe('feature');
  });

  it('handles multiple issues with only some needing event resolution', async () => {
    // Item 1: stage differs → needs event fetch
    const item1 = makeLocalItem({ id: 'WL-001', stage: 'idea' });
    // Item 2: stage matches → no event fetch needed
    const item2 = makeLocalItem({ id: 'WL-002', stage: 'done', priority: 'medium' });

    const issue1 = makeGithubIssue({
      number: 1,
      labels: ['wl:stage:done'],
      updatedAt: T_ISSUE_UPDATE,
    });
    const issue2 = makeGithubIssue({
      number: 2,
      labels: ['wl:stage:done'],
      updatedAt: T_ISSUE_UPDATE,
    });

    mockListGithubIssues.mockReturnValue([issue1, issue2]);

    mockFetchLabelEventsAsync.mockResolvedValue([
      { label: 'wl:stage:done', action: 'labeled', createdAt: T_LABEL_NEWER },
    ] as LabelEvent[]);

    const result = await importIssuesToWorkItems([item1, item2], dummyConfig, {
      generateId: () => 'WL-GEN',
    });

    // Events should only be fetched for issue 1 (issue 2 matches local)
    expect(mockFetchLabelEventsAsync).toHaveBeenCalledTimes(1);
    expect(mockFetchLabelEventsAsync).toHaveBeenCalledWith(
      expect.anything(),
      1, // issue number 1 only
      expect.anything()
    );

    // Item 1 should have updated stage
    const merged1 = result.mergedItems.find(item => item.id === 'WL-001');
    expect(merged1!.stage).toBe('done');

    // Item 2 should retain its stage
    const merged2 = result.mergedItems.find(item => item.id === 'WL-002');
    expect(merged2!.stage).toBe('done');
  });

  it('handles new issues (no local match) without event resolution', async () => {
    // No local items — issue is brand new
    const issue = makeGithubIssue({
      number: 1,
      labels: ['wl:stage:done', 'wl:priority:high'],
      body: '', // no worklog marker
      updatedAt: T_ISSUE_UPDATE,
    });

    mockListGithubIssues.mockReturnValue([issue]);

    let genCounter = 1;
    const result = await importIssuesToWorkItems([], dummyConfig, {
      createNew: true,
      generateId: () => `WL-NEW-${genCounter++}`,
    });

    // New items should NOT trigger event fetching (no local to compare against)
    expect(mockFetchLabelEventsAsync).not.toHaveBeenCalled();

    // The created item should have label values applied directly
    expect(result.createdItems.length).toBe(1);
    const created = result.mergedItems.find(item => item.id === 'WL-NEW-1');
    expect(created).toBeDefined();
    expect(created!.stage).toBe('done');
    expect(created!.priority).toBe('high');

    // No field changes (resolution only applies to existing items)
    expect(result.fieldChanges).toEqual([]);
  });

  it('propagates status change when issue is reopened even if local updatedAt is newer than issue updatedAt', async () => {
    // Scenario: item was completed locally, then someone reopened the GitHub issue
    // Local updatedAt (Jan 10) > issue updatedAt (Jan 12 is used here but local was edited later)
    const T_LOCAL_VERY_RECENT = '2026-01-20T00:00:00.000Z';
    const T_REOPEN_EVENT = '2026-01-25T00:00:00.000Z';

    const localItem = makeLocalItem({
      id: 'WL-001',
      status: 'completed' as WorkItemStatus,
      stage: 'in_review',
      updatedAt: T_LOCAL_VERY_RECENT,
    });

    // GitHub issue is open (was reopened), with status label
    const issue = makeGithubIssue({
      number: 1,
      labels: ['wl:status:open', 'wl:stage:idea'],
      state: 'open',
      updatedAt: T_ISSUE_UPDATE, // Jan 12 — older than local
    });

    mockListGithubIssues.mockReturnValue([issue]);

    // The label events show the status/stage labels were added AFTER local updatedAt
    mockFetchLabelEventsAsync.mockResolvedValue([
      { label: 'wl:status:open', action: 'labeled', createdAt: T_REOPEN_EVENT },
      { label: 'wl:stage:idea', action: 'labeled', createdAt: T_REOPEN_EVENT },
    ] as LabelEvent[]);

    const result = await importIssuesToWorkItems([localItem], dummyConfig, {
      generateId: () => 'WL-GEN',
    });

    const merged = result.mergedItems.find(item => item.id === 'WL-001');
    expect(merged).toBeDefined();
    // Even though local updatedAt > issue updatedAt, the label event is newer
    // than local updatedAt, so label resolution should win
    expect(merged!.status).toBe('open');
    expect(merged!.stage).toBe('idea');

    // fieldChanges should include both status and stage changes
    const statusChange = result.fieldChanges.find(fc => fc.field === 'status' && fc.workItemId === 'WL-001');
    expect(statusChange).toBeDefined();
    expect(statusChange!.oldValue).toBe('completed');
    expect(statusChange!.newValue).toBe('open');

    const stageChange = result.fieldChanges.find(fc => fc.field === 'stage' && fc.workItemId === 'WL-001');
    expect(stageChange).toBeDefined();
    expect(stageChange!.oldValue).toBe('in_review');
    expect(stageChange!.newValue).toBe('idea');
  });

  it('propagates stage change when label event is newer even if same item-level timestamps', async () => {
    // Scenario: after a sync cycle both local and remote have the same updatedAt.
    // Then someone changes a label on GitHub. The label event is newer,
    // but the issue updatedAt might match local updatedAt.
    const T_SYNCED = '2026-01-10T00:00:00.000Z';
    const T_LABEL_CHANGE = '2026-01-15T00:00:00.000Z';

    const localItem = makeLocalItem({
      id: 'WL-001',
      stage: 'done',
      status: 'completed' as WorkItemStatus,
      updatedAt: T_SYNCED,
    });

    // GitHub issue updatedAt matches local (same sync cycle),
    // but now has a different stage label
    const issue = makeGithubIssue({
      number: 1,
      labels: ['wl:stage:review', 'wl:status:open'],
      state: 'open',
      updatedAt: T_SYNCED, // Same as local
    });

    mockListGithubIssues.mockReturnValue([issue]);

    // Label event is newer than the synced timestamp
    mockFetchLabelEventsAsync.mockResolvedValue([
      { label: 'wl:stage:review', action: 'labeled', createdAt: T_LABEL_CHANGE },
      { label: 'wl:status:open', action: 'labeled', createdAt: T_LABEL_CHANGE },
    ] as LabelEvent[]);

    const result = await importIssuesToWorkItems([localItem], dummyConfig, {
      generateId: () => 'WL-GEN',
    });

    const merged = result.mergedItems.find(item => item.id === 'WL-001');
    expect(merged).toBeDefined();
    // Label resolution determined remote wins; this should survive mergeWorkItems
    expect(merged!.stage).toBe('review');
    expect(merged!.status).toBe('open');

    const stageChange = result.fieldChanges.find(fc => fc.field === 'stage');
    expect(stageChange).toBeDefined();
    expect(stageChange!.newValue).toBe('review');
  });

  it('propagates status from completed to open when GitHub issue is reopened with newer label event', async () => {
    // The exact scenario from the bug report: item is completed/in_review,
    // GitHub issue is reopened with stage changed, wl gh import should update both
    const T_COMPLETED = '2026-01-10T00:00:00.000Z';
    const T_REOPEN = '2026-01-12T00:00:00.000Z';

    const localItem = makeLocalItem({
      id: 'WL-001',
      status: 'completed' as WorkItemStatus,
      stage: 'in_review',
      updatedAt: T_COMPLETED,
    });

    const issue = makeGithubIssue({
      number: 1,
      labels: ['wl:status:open', 'wl:stage:idea'],
      state: 'open',
      updatedAt: T_REOPEN,
    });

    mockListGithubIssues.mockReturnValue([issue]);

    mockFetchLabelEventsAsync.mockResolvedValue([
      { label: 'wl:status:open', action: 'labeled', createdAt: T_REOPEN },
      { label: 'wl:stage:idea', action: 'labeled', createdAt: T_REOPEN },
    ] as LabelEvent[]);

    const result = await importIssuesToWorkItems([localItem], dummyConfig, {
      generateId: () => 'WL-GEN',
    });

    const merged = result.mergedItems.find(item => item.id === 'WL-001');
    expect(merged).toBeDefined();
    expect(merged!.status).toBe('open');
    expect(merged!.stage).toBe('idea');
  });
});
