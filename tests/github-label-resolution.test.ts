/**
 * Tests for event-driven label conflict resolution in github-sync.ts
 *
 * Validates that:
 * - resolveLabelField correctly compares event timestamps to local updatedAt
 * - resolveAllLabelFields resolves all field categories and produces FieldChange records
 * - Remote-newer wins, local-newer wins, equal timestamps (local wins)
 * - Multi-label resolution selects the most-recently-added label via events
 * - Missing events gracefully fall back to issue updatedAt
 * - Empty remote values are not treated as changes
 */

import { describe, it, expect } from 'vitest';
import {
  resolveLabelField,
  resolveAllLabelFields,
  FieldChange,
} from '../src/github-sync.js';
import type { LabelEvent } from '../src/github.js';
import type { WorkItem } from '../src/types.js';

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'WL-TEST1',
    title: 'Test Item',
    description: '',
    status: 'open',
    priority: 'medium',
    sortIndex: 0,
    parentId: null,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-10T00:00:00Z',
    tags: [],
    assignee: '',
    stage: 'idea',
    issueType: 'bug',
    createdBy: '',
    deletedBy: '',
    deleteReason: '',
    risk: '',
    effort: '',
    ...overrides,
  };
}

describe('resolveLabelField', () => {
  const labelPrefix = 'wl:';

  it('returns remote value when label event is newer than local', () => {
    const events: LabelEvent[] = [
      { label: 'wl:stage:done', action: 'labeled', createdAt: '2025-01-15T00:00:00Z' },
    ];
    const result = resolveLabelField(
      'idea',                    // localValue
      '2025-01-10T00:00:00Z',   // localUpdatedAt
      'done',                    // remoteValue
      events,
      'stage:',
      labelPrefix,
      '2025-01-15T00:00:00Z'    // issueUpdatedAt
    );
    expect(result.resolvedValue).toBe('done');
    expect(result.changed).toBe(true);
    expect(result.eventTimestamp).toBe('2025-01-15T00:00:00Z');
  });

  it('returns local value when local is newer than label event', () => {
    const events: LabelEvent[] = [
      { label: 'wl:stage:done', action: 'labeled', createdAt: '2025-01-05T00:00:00Z' },
    ];
    const result = resolveLabelField(
      'idea',                    // localValue
      '2025-01-10T00:00:00Z',   // localUpdatedAt
      'done',                    // remoteValue
      events,
      'stage:',
      labelPrefix,
      '2025-01-05T00:00:00Z'    // issueUpdatedAt
    );
    expect(result.resolvedValue).toBe('idea');
    expect(result.changed).toBe(false);
    expect(result.eventTimestamp).toBe('2025-01-05T00:00:00Z');
  });

  it('returns local value when timestamps are equal (local wins on tie)', () => {
    const events: LabelEvent[] = [
      { label: 'wl:stage:done', action: 'labeled', createdAt: '2025-01-10T00:00:00Z' },
    ];
    const result = resolveLabelField(
      'idea',                    // localValue
      '2025-01-10T00:00:00Z',   // localUpdatedAt
      'done',                    // remoteValue
      events,
      'stage:',
      labelPrefix,
      '2025-01-10T00:00:00Z'    // issueUpdatedAt
    );
    expect(result.resolvedValue).toBe('idea');
    expect(result.changed).toBe(false);
  });

  it('returns local value when remote value is empty (no label present)', () => {
    const events: LabelEvent[] = [];
    const result = resolveLabelField(
      'idea',                    // localValue
      '2025-01-10T00:00:00Z',   // localUpdatedAt
      '',                        // remoteValue (empty = no label)
      events,
      'stage:',
      labelPrefix,
      '2025-01-15T00:00:00Z'
    );
    expect(result.resolvedValue).toBe('idea');
    expect(result.changed).toBe(false);
    expect(result.eventTimestamp).toBeNull();
  });

  it('returns local value when values are the same (no change needed)', () => {
    const events: LabelEvent[] = [
      { label: 'wl:stage:idea', action: 'labeled', createdAt: '2025-01-15T00:00:00Z' },
    ];
    const result = resolveLabelField(
      'idea',                    // localValue
      '2025-01-10T00:00:00Z',   // localUpdatedAt
      'idea',                    // remoteValue (same)
      events,
      'stage:',
      labelPrefix,
      '2025-01-15T00:00:00Z'
    );
    expect(result.resolvedValue).toBe('idea');
    expect(result.changed).toBe(false);
    expect(result.eventTimestamp).toBeNull();
  });

  it('falls back to issue updatedAt when no events exist for category', () => {
    // No stage events, but priority events exist (should be ignored for stage resolution)
    const events: LabelEvent[] = [
      { label: 'wl:priority:high', action: 'labeled', createdAt: '2025-01-15T00:00:00Z' },
    ];
    const result = resolveLabelField(
      'idea',                    // localValue
      '2025-01-10T00:00:00Z',   // localUpdatedAt
      'done',                    // remoteValue
      events,
      'stage:',
      labelPrefix,
      '2025-01-15T00:00:00Z'    // issueUpdatedAt (newer than local)
    );
    // Falls back to issueUpdatedAt which is newer, so remote wins
    expect(result.resolvedValue).toBe('done');
    expect(result.changed).toBe(true);
    expect(result.eventTimestamp).toBe('2025-01-15T00:00:00Z');
  });

  it('falls back to issue updatedAt when events array is empty', () => {
    const events: LabelEvent[] = [];
    const result = resolveLabelField(
      'idea',                    // localValue
      '2025-01-10T00:00:00Z',   // localUpdatedAt
      'done',                    // remoteValue
      events,
      'stage:',
      labelPrefix,
      '2025-01-05T00:00:00Z'    // issueUpdatedAt (older than local)
    );
    // Falls back to issueUpdatedAt which is older, so local wins
    expect(result.resolvedValue).toBe('idea');
    expect(result.changed).toBe(false);
  });

  it('selects most-recently-added label when multiple events exist', () => {
    // Multiple stage label events; getLatestLabelEventTimestamp returns the last one
    const events: LabelEvent[] = [
      { label: 'wl:stage:idea', action: 'labeled', createdAt: '2025-01-05T00:00:00Z' },
      { label: 'wl:stage:in_progress', action: 'labeled', createdAt: '2025-01-08T00:00:00Z' },
      { label: 'wl:stage:done', action: 'labeled', createdAt: '2025-01-15T00:00:00Z' },
    ];
    const result = resolveLabelField(
      'idea',                    // localValue
      '2025-01-10T00:00:00Z',   // localUpdatedAt
      'done',                    // remoteValue (from most recent label)
      events,
      'stage:',
      labelPrefix,
      '2025-01-15T00:00:00Z'
    );
    // Most recent event at 2025-01-15 is newer than local 2025-01-10
    expect(result.resolvedValue).toBe('done');
    expect(result.changed).toBe(true);
    expect(result.eventTimestamp).toBe('2025-01-15T00:00:00Z');
  });

  it('ignores unlabeled events when determining most recent', () => {
    const events: LabelEvent[] = [
      { label: 'wl:stage:done', action: 'labeled', createdAt: '2025-01-05T00:00:00Z' },
      { label: 'wl:stage:done', action: 'unlabeled', createdAt: '2025-01-15T00:00:00Z' },
    ];
    const result = resolveLabelField(
      'idea',                    // localValue
      '2025-01-10T00:00:00Z',   // localUpdatedAt
      'done',                    // remoteValue
      events,
      'stage:',
      labelPrefix,
      '2025-01-05T00:00:00Z'
    );
    // Only labeled event is at 2025-01-05 (older than local), so local wins
    expect(result.resolvedValue).toBe('idea');
    expect(result.changed).toBe(false);
  });
});

describe('resolveAllLabelFields', () => {
  const labelPrefix = 'wl:';

  it('resolves all fields and produces FieldChange records', () => {
    const localItem = makeItem({
      stage: 'idea',
      priority: 'medium',
      status: 'open',
      issueType: 'bug',
      risk: '',
      effort: '',
      updatedAt: '2025-01-10T00:00:00Z',
    });
    const labelFields = {
      stage: 'done',
      priority: 'high',
      status: 'in-progress',
      issueType: 'feature',
      risk: 'High',
      effort: 'L',
    };
    const events: LabelEvent[] = [
      { label: 'wl:stage:done', action: 'labeled', createdAt: '2025-01-15T00:00:00Z' },
      { label: 'wl:priority:high', action: 'labeled', createdAt: '2025-01-15T00:00:00Z' },
      { label: 'wl:status:in-progress', action: 'labeled', createdAt: '2025-01-15T00:00:00Z' },
      { label: 'wl:type:feature', action: 'labeled', createdAt: '2025-01-15T00:00:00Z' },
      { label: 'wl:risk:High', action: 'labeled', createdAt: '2025-01-15T00:00:00Z' },
      { label: 'wl:effort:L', action: 'labeled', createdAt: '2025-01-15T00:00:00Z' },
    ];
    const issueUpdatedAt = '2025-01-15T00:00:00Z';

    const { resolvedFields, fieldChanges } = resolveAllLabelFields(
      localItem, labelFields, events, labelPrefix, issueUpdatedAt
    );

    // All remote values should win (events are newer)
    expect(resolvedFields.stage).toBe('done');
    expect(resolvedFields.priority).toBe('high');
    expect(resolvedFields.status).toBe('in-progress');
    expect(resolvedFields.issueType).toBe('feature');
    expect(resolvedFields.risk).toBe('High');
    expect(resolvedFields.effort).toBe('L');

    // Should have 6 field changes (all fields changed)
    expect(fieldChanges).toHaveLength(6);
    expect(fieldChanges.every(fc => fc.source === 'github-label')).toBe(true);
    expect(fieldChanges.every(fc => fc.workItemId === 'WL-TEST1')).toBe(true);
  });

  it('preserves local values when local is newer', () => {
    const localItem = makeItem({
      stage: 'idea',
      priority: 'medium',
      updatedAt: '2025-01-20T00:00:00Z',
    });
    const labelFields = {
      stage: 'done',
      priority: 'high',
      status: 'open',
      issueType: '',
      risk: '',
      effort: '',
    };
    const events: LabelEvent[] = [
      { label: 'wl:stage:done', action: 'labeled', createdAt: '2025-01-05T00:00:00Z' },
      { label: 'wl:priority:high', action: 'labeled', createdAt: '2025-01-05T00:00:00Z' },
    ];
    const issueUpdatedAt = '2025-01-05T00:00:00Z';

    const { resolvedFields, fieldChanges } = resolveAllLabelFields(
      localItem, labelFields, events, labelPrefix, issueUpdatedAt
    );

    // Local values should win (local is newer)
    expect(resolvedFields.stage).toBe('idea');
    expect(resolvedFields.priority).toBe('medium');
    expect(fieldChanges).toHaveLength(0);
  });

  it('returns empty fieldChanges when all fields match', () => {
    const localItem = makeItem({
      stage: 'done',
      priority: 'high',
      status: 'open',
      issueType: 'bug',
    });
    const labelFields = {
      stage: 'done',
      priority: 'high',
      status: 'open',
      issueType: 'bug',
      risk: '',
      effort: '',
    };
    const events: LabelEvent[] = [];
    const issueUpdatedAt = '2025-01-15T00:00:00Z';

    const { resolvedFields, fieldChanges } = resolveAllLabelFields(
      localItem, labelFields, events, labelPrefix, issueUpdatedAt
    );

    expect(fieldChanges).toHaveLength(0);
    expect(resolvedFields.stage).toBe('done');
    expect(resolvedFields.priority).toBe('high');
  });

  it('handles mixed resolution (some fields remote-newer, some local-newer)', () => {
    const localItem = makeItem({
      stage: 'idea',
      priority: 'medium',
      updatedAt: '2025-01-10T00:00:00Z',
    });
    const labelFields = {
      stage: 'done',
      priority: 'high',
      status: 'open',
      issueType: '',
      risk: '',
      effort: '',
    };
    const events: LabelEvent[] = [
      // Stage label event is newer than local
      { label: 'wl:stage:done', action: 'labeled', createdAt: '2025-01-15T00:00:00Z' },
      // Priority label event is older than local
      { label: 'wl:priority:high', action: 'labeled', createdAt: '2025-01-05T00:00:00Z' },
    ];
    const issueUpdatedAt = '2025-01-15T00:00:00Z';

    const { resolvedFields, fieldChanges } = resolveAllLabelFields(
      localItem, labelFields, events, labelPrefix, issueUpdatedAt
    );

    // Stage should update (remote newer), priority should stay (local newer)
    expect(resolvedFields.stage).toBe('done');
    expect(resolvedFields.priority).toBe('medium');
    expect(fieldChanges).toHaveLength(1);
    expect(fieldChanges[0].field).toBe('stage');
    expect(fieldChanges[0].oldValue).toBe('idea');
    expect(fieldChanges[0].newValue).toBe('done');
  });

  it('does not modify fields where remote value is empty', () => {
    const localItem = makeItem({
      stage: 'idea',
      risk: 'Low',
      effort: 'M',
      updatedAt: '2025-01-10T00:00:00Z',
    });
    const labelFields = {
      stage: 'done',
      priority: 'medium',
      status: 'open',
      issueType: '',     // empty = no label
      risk: '',          // empty = no label
      effort: '',        // empty = no label
    };
    const events: LabelEvent[] = [
      { label: 'wl:stage:done', action: 'labeled', createdAt: '2025-01-15T00:00:00Z' },
    ];
    const issueUpdatedAt = '2025-01-15T00:00:00Z';

    const { resolvedFields, fieldChanges } = resolveAllLabelFields(
      localItem, labelFields, events, labelPrefix, issueUpdatedAt
    );

    // Empty remote fields should not change local values
    expect(resolvedFields.issueType).toBe('bug');  // kept from local
    expect(resolvedFields.risk).toBe('Low');        // kept from local (risk: 'Low' in makeItem override)
    expect(resolvedFields.effort).toBe('M');        // kept from local (effort: 'M' in makeItem override)
    // Only stage should change
    expect(fieldChanges).toHaveLength(1);
    expect(fieldChanges[0].field).toBe('stage');
  });

  it('produces FieldChange records with correct structure', () => {
    const localItem = makeItem({
      id: 'WL-AUDIT1',
      stage: 'idea',
      updatedAt: '2025-01-10T00:00:00Z',
    });
    const labelFields = {
      stage: 'done',
      priority: 'medium',
      status: 'open',
      issueType: '',
      risk: '',
      effort: '',
    };
    const events: LabelEvent[] = [
      { label: 'wl:stage:done', action: 'labeled', createdAt: '2025-01-15T00:00:00Z' },
    ];
    const issueUpdatedAt = '2025-01-15T00:00:00Z';

    const { fieldChanges } = resolveAllLabelFields(
      localItem, labelFields, events, labelPrefix, issueUpdatedAt
    );

    expect(fieldChanges).toHaveLength(1);
    const fc = fieldChanges[0];
    expect(fc.workItemId).toBe('WL-AUDIT1');
    expect(fc.field).toBe('stage');
    expect(fc.oldValue).toBe('idea');
    expect(fc.newValue).toBe('done');
    expect(fc.source).toBe('github-label');
    expect(fc.timestamp).toBe('2025-01-15T00:00:00Z');
  });

  it('handles custom label prefix', () => {
    const localItem = makeItem({
      stage: 'idea',
      updatedAt: '2025-01-10T00:00:00Z',
    });
    const labelFields = {
      stage: 'done',
      priority: 'medium',
      status: 'open',
      issueType: '',
      risk: '',
      effort: '',
    };
    const events: LabelEvent[] = [
      { label: 'myapp:stage:done', action: 'labeled', createdAt: '2025-01-15T00:00:00Z' },
    ];
    const issueUpdatedAt = '2025-01-15T00:00:00Z';

    const { resolvedFields, fieldChanges } = resolveAllLabelFields(
      localItem, labelFields, events, 'myapp:', issueUpdatedAt
    );

    expect(resolvedFields.stage).toBe('done');
    expect(fieldChanges).toHaveLength(1);
  });
});
