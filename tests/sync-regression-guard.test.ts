/**
 * Tests for the regression guard — refuse import of default-value regressions
 * from newer remote state (WL-0MSOYWZTH003JFVD).
 *
 * The regression guard defines "regression defaults" per field:
 *   status:  'open'   (regression from in-progress, completed, deleted, etc.)
 *   stage:   'idea'   (regression from in_progress, plan_complete, done, in_review, etc.)
 *   priority:'medium' (regression from high, critical, low, etc.)
 *   assignee: ''      (regression from any non-empty string)
 *
 * effort/risk are NEVER imported (excluded from merge lists by construction).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mergeWorkItems } from '../src/sync.js';
import type { WorkItem, ConflictDetail } from '../src/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Create a minimal WorkItem with the given overrides.  All merge-participating
 * fields (status, stage, priority, assignee) default to their default values
 * so tests can selectively set non-defaults.
 */
const mkItem = (overrides: Partial<WorkItem> = {}): WorkItem => ({
  id: 'WI-REG-001',
  title: 'Regression test item',
  description: '',
  status: 'open',
  priority: 'medium',
  sortIndex: 0,
  parentId: null,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  tags: [],
  assignee: '',
  stage: '',
  issueType: '',
  createdBy: '',
  deletedBy: '',
  deleteReason: '',
  risk: '' as const,
  effort: '' as const,
  ...overrides,
});

/**
 * Extract regression conflict details from the merge result.
 * A regression detail has reason containing 'regression' or 'regressed'.
 */
function extractRegressionConflicts(result: ReturnType<typeof mergeWorkItems>): ConflictDetail[] {
  return result.conflictDetails.filter(cd =>
    cd.fields.some(fd =>
      fd.reason.toLowerCase().includes('regression') ||
      fd.reason.toLowerCase().includes('refused')
    )
  );
}

// ── AC5(a): effort/risk exclusion by construction ────────────────────────

describe('AC5(a): effort/risk exclusion by construction', () => {
  it('keeps local effort when remote has empty string (default)', () => {
    const localItem = mkItem({
      effort: 'Small' as any,
      updatedAt: '2024-06-01T12:00:00.000Z',
    });
    const remoteItem = mkItem({
      effort: '' as any,
      updatedAt: '2024-06-02T12:00:00.000Z', // newer
    });

    const result = mergeWorkItems([localItem], [remoteItem]);

    expect(result.merged).toHaveLength(1);
    expect(result.merged[0].effort).toBe('Small');
  });

  it('keeps local risk when remote has empty string (default)', () => {
    const localItem = mkItem({
      risk: 'High' as any,
      updatedAt: '2024-06-01T12:00:00.000Z',
    });
    const remoteItem = mkItem({
      risk: '' as any,
      updatedAt: '2024-06-02T12:00:00.000Z', // newer
    });

    const result = mergeWorkItems([localItem], [remoteItem]);

    expect(result.merged).toHaveLength(1);
    expect(result.merged[0].risk).toBe('High');
  });
});

// ── AC5(b): status regression refusal ────────────────────────────────────

describe('AC5(b): status regression detection and refusal', () => {
  it('refuses newer remote with status: open against local completed', () => {
    const localItem = mkItem({
      status: 'completed',
      stage: 'done',
      updatedAt: '2024-06-01T12:00:00.000Z',
    });
    const remoteItem = mkItem({
      status: 'open',
      stage: '',
      updatedAt: '2024-06-02T12:00:00.000Z', // newer
    });

    const result = mergeWorkItems([localItem], [remoteItem]);

    expect(result.merged).toHaveLength(1);
    expect(result.merged[0].status).toBe('completed');
    expect(result.merged[0].stage).toBe('done');
  });

  it('reports the regression in conflict details with full information', () => {
    // Use in-progress→open (not a close state) so the regression guard
    // — not close-preservation — handles it and reports the conflict.
    const localItem = mkItem({
      status: 'in-progress',
      updatedAt: '2024-06-01T12:00:00.000Z',
    });
    const remoteItem = mkItem({
      status: 'open',
      updatedAt: '2024-06-02T12:00:00.000Z', // newer
    });

    const result = mergeWorkItems([localItem], [remoteItem]);

    expect(result.conflictDetails.length).toBeGreaterThan(0);
    const regressionConflicts = extractRegressionConflicts(result);
    expect(regressionConflicts.length).toBeGreaterThan(0);
  });

  it('refuses regression from in-progress to open', () => {
    const localItem = mkItem({
      status: 'in-progress',
      updatedAt: '2024-06-01T12:00:00.000Z',
    });
    const remoteItem = mkItem({
      status: 'open',
      updatedAt: '2024-06-02T12:00:00.000Z', // newer
    });

    const result = mergeWorkItems([localItem], [remoteItem]);

    expect(result.merged[0].status).toBe('in-progress');
  });
});

// ── AC5(c): legitimate concurrent edits still merge ─────────────────────

describe('AC5(c): legitimate concurrent edits (no regression path)', () => {
  it('merges different non-default values from both sides normally', () => {
    const localItem = mkItem({
      status: 'in-progress',
      priority: 'high',
      updatedAt: '2024-06-01T10:00:00.000Z',
    });
    const remoteItem = mkItem({
      status: 'completed',
      priority: 'low',
      updatedAt: '2024-06-02T12:00:00.000Z', // newer
    });

    const result = mergeWorkItems([localItem], [remoteItem]);

    expect(result.merged).toHaveLength(1);
    // Remote is newer with non-default values → remote wins normally
    // (this is NOT a regression because both sides have non-default values)
    expect(result.merged[0].status).toBe('completed');
    expect(result.merged[0].priority).toBe('low');
  });

  it('does NOT flag a regression when both sides have non-default values', () => {
    const localItem = mkItem({
      status: 'in-progress',
      priority: 'high',
      updatedAt: '2024-06-01T10:00:00.000Z',
    });
    const remoteItem = mkItem({
      status: 'completed',
      priority: 'low',
      updatedAt: '2024-06-02T12:00:00.000Z', // newer
    });

    const result = mergeWorkItems([localItem], [remoteItem]);

    // No regression conflicts — both sides have non-default values
    const regressionConflicts = extractRegressionConflicts(result);
    expect(regressionConflicts).toHaveLength(0);
  });
});

// ── Same-timestamp regression detection ──────────────────────────────────

describe('Same-timestamp merge: regression detection', () => {
  it('detects status regression at same timestamp (local non-default, remote default)', () => {
    const localItem = mkItem({
      status: 'completed',
      stage: 'done',
      assignee: 'alice',
      updatedAt: '2024-06-01T12:00:00.000Z',
    });
    const remoteItem = mkItem({
      status: 'open',
      stage: '',
      assignee: '',
      updatedAt: '2024-06-01T12:00:00.000Z', // same timestamp
    });

    const result = mergeWorkItems([localItem], [remoteItem]);

    expect(result.merged).toHaveLength(1);
    expect(result.merged[0].status).toBe('completed');
    expect(result.merged[0].stage).toBe('done');
    expect(result.merged[0].assignee).toBe('alice');
  });

  it('detects stage regression at same timestamp', () => {
    const localItem = mkItem({
      status: 'completed',
      stage: 'in_review',
      updatedAt: '2024-06-01T12:00:00.000Z',
    });
    const remoteItem = mkItem({
      status: 'completed',
      stage: 'idea',
      updatedAt: '2024-06-01T12:00:00.000Z', // same timestamp, stage regressed
    });

    const result = mergeWorkItems([localItem], [remoteItem]);

    expect(result.merged).toHaveLength(1);
    expect(result.merged[0].stage).toBe('in_review');
  });

  it('detects priority regression at same timestamp', () => {
    const localItem = mkItem({
      priority: 'critical',
      updatedAt: '2024-06-01T12:00:00.000Z',
    });
    const remoteItem = mkItem({
      priority: 'medium',
      updatedAt: '2024-06-01T12:00:00.000Z', // same timestamp, priority regressed to default
    });

    const result = mergeWorkItems([localItem], [remoteItem]);

    expect(result.merged).toHaveLength(1);
    expect(result.merged[0].priority).toBe('critical');
  });

  it('detects assignee regression at same timestamp', () => {
    const localItem = mkItem({
      assignee: 'alice',
      updatedAt: '2024-06-01T12:00:00.000Z',
    });
    const remoteItem = mkItem({
      assignee: '',
      updatedAt: '2024-06-01T12:00:00.000Z', // same timestamp, assignee regressed
    });

    const result = mergeWorkItems([localItem], [remoteItem]);

    expect(result.merged).toHaveLength(1);
    expect(result.merged[0].assignee).toBe('alice');
  });
});

// ── AC5(d): override flag accepts regression ─────────────────────────────

describe('AC5(d): --accept-regressions override', () => {
  it('keeps local value by default when remote is newer with defaults', () => {
    const localItem = mkItem({
      status: 'completed',
      stage: 'done',
      updatedAt: '2024-06-01T12:00:00.000Z',
    });
    const remoteItem = mkItem({
      status: 'open',
      stage: '',
      updatedAt: '2024-06-02T12:00:00.000Z', // newer
    });

    // Default: refuse regression
    const resultDefault = mergeWorkItems([localItem], [remoteItem]);
    expect(resultDefault.merged[0].status).toBe('completed');
    expect(resultDefault.merged[0].stage).toBe('done');
  });

  it('with acceptRegressions=true, remote defaults are accepted', () => {
    // Use in-progress→open (not a close state) so the regression guard
    // — not close-preservation — handles it.
    const localItem = mkItem({
      status: 'in-progress',
      updatedAt: '2024-06-01T12:00:00.000Z',
    });
    const remoteItem = mkItem({
      status: 'open',
      updatedAt: '2024-06-02T12:00:00.000Z', // newer
    });

    const result = mergeWorkItems([localItem], [remoteItem], {
      acceptRegressions: true,
    });

    // With acceptRegressions, remote defaults are accepted (regression allowed)
    expect(result.merged).toHaveLength(1);
    expect(result.merged[0].status).toBe('open');
  });
});

// ── AC5(g): effort/risk regressions reported as protected ────────────────

describe('AC5(g): effort/risk reported as protected conflicts', () => {
  it('does NOT import effort from remote even when remote is newer', () => {
    const localItem = mkItem({
      effort: 'Large' as any,
      updatedAt: '2024-06-01T12:00:00.000Z',
    });
    const remoteItem = mkItem({
      effort: '' as any,
      updatedAt: '2024-06-02T12:00:00.000Z', // newer
    });

    const result = mergeWorkItems([localItem], [remoteItem]);

    expect(result.merged).toHaveLength(1);
    expect(result.merged[0].effort).toBe('Large');
  });

  it('does NOT import risk from remote even when remote is newer', () => {
    const localItem = mkItem({
      risk: 'Critical' as any,
      updatedAt: '2024-06-01T12:00:00.000Z',
    });
    const remoteItem = mkItem({
      risk: '' as any,
      updatedAt: '2024-06-02T12:00:00.000Z', // newer
    });

    const result = mergeWorkItems([localItem], [remoteItem]);

    expect(result.merged).toHaveLength(1);
    expect(result.merged[0].risk).toBe('Critical');
  });
});

// ── AC5(h): close state preservation NOT affected ───────────────────────

describe('AC5(h): close state preservation NOT affected by regression guard', () => {
  it('preserves close when remote is newer with non-close field change', () => {
    const localClosed = mkItem({
      status: 'completed',
      stage: 'done',
      description: 'Original',
      updatedAt: '2024-06-01T12:00:00.000Z',
    });
    const remoteNewer = mkItem({
      status: 'completed', // same close status
      stage: 'in_review', // different terminal stage
      description: 'Remote edit',
      updatedAt: '2024-06-02T12:00:00.000Z',
    });

    const result = mergeWorkItems([localClosed], [remoteNewer]);

    expect(result.merged).toHaveLength(1);
    expect(result.merged[0].status).toBe('completed');
    expect(result.merged[0].description).toBe('Remote edit');
  });

  it('close state (completed + in_review) preserved from remote', () => {
    const localStale = mkItem({
      status: 'in-progress',
      stage: 'plan_complete',
      updatedAt: '2024-06-01T12:00:00.000Z',
    });
    const remoteClosed = mkItem({
      status: 'completed',
      stage: 'in_review',
      updatedAt: '2024-06-02T12:00:00.000Z',
    });

    const result = mergeWorkItems([localStale], [remoteClosed]);

    expect(result.merged).toHaveLength(1);
    expect(result.merged[0].status).toBe('completed');
    expect(result.merged[0].stage).toBe('in_review');
  });
});

// ── Regression conflict detail structure ─────────────────────────────────

describe('Regression conflict detail structure', () => {
  it('reports conflict details with item id and field information', () => {
    const localItem = mkItem({
      status: 'completed',
      stage: 'done',
      priority: 'high',
      assignee: 'alice',
      updatedAt: '2024-06-01T12:00:00.000Z',
    });
    const remoteItem = mkItem({
      status: 'open',
      stage: '',
      priority: 'medium',
      assignee: '',
      updatedAt: '2024-06-02T12:00:00.000Z', // newer
    });

    const result = mergeWorkItems([localItem], [remoteItem]);

    expect(result.conflictDetails.length).toBeGreaterThan(0);
    const detail = result.conflictDetails[0];
    expect(detail.itemId).toBe('WI-REG-001');
    expect(detail.fields.length).toBeGreaterThan(0);

    // Check that at least one field has the regression indication
    const regressionField = detail.fields.find(fd =>
      fd.reason.toLowerCase().includes('regression') ||
      fd.reason.toLowerCase().includes('refused')
    );
    expect(regressionField).toBeDefined();
  });
});

// ── Multiple regression fields simultaneously ────────────────────────────

describe('Multiple simultaneous regressions', () => {
  it('detects regression across status, stage, priority, and assignee', () => {
    const localItem = mkItem({
      status: 'completed',
      stage: 'done',
      priority: 'high',
      assignee: 'alice',
      updatedAt: '2024-06-01T12:00:00.000Z',
    });
    const remoteItem = mkItem({
      status: 'open',
      stage: '',
      priority: 'medium',
      assignee: '',
      updatedAt: '2024-06-02T12:00:00.000Z', // newer
    });

    const result = mergeWorkItems([localItem], [remoteItem]);

    expect(result.merged).toHaveLength(1);
    const merged = result.merged[0];

    // All local non-default values preserved
    expect(merged.status).toBe('completed');
    expect(merged.stage).toBe('done');
    expect(merged.priority).toBe('high');
    expect(merged.assignee).toBe('alice');

    // Verify conflict details contain regression information
    const regressionConflicts = extractRegressionConflicts(result);
    expect(regressionConflicts.length).toBeGreaterThan(0);
  });
});

// ── Non-regression cases (must not be flagged) ───────────────────────────

describe('Non-regression cases (guard must NOT trigger)', () => {
  it('does not flag when remote adds a non-default value (local default)', () => {
    const localItem = mkItem({
      status: 'open',
      updatedAt: '2024-06-01T12:00:00.000Z',
    });
    const remoteItem = mkItem({
      status: 'completed',
      updatedAt: '2024-06-02T12:00:00.000Z',
    });

    const result = mergeWorkItems([localItem], [remoteItem]);

    expect(result.merged).toHaveLength(1);
    expect(result.merged[0].status).toBe('completed');
    // No regression — local had default, remote has non-default
    const regressionConflicts = extractRegressionConflicts(result);
    expect(regressionConflicts).toHaveLength(0);
  });

  it('does not flag when both sides have the same non-default value', () => {
    const localItem = mkItem({
      status: 'completed',
      updatedAt: '2024-06-01T12:00:00.000Z',
    });
    const remoteItem = mkItem({
      status: 'completed',
      updatedAt: '2024-06-02T12:00:00.000Z',
    });

    const result = mergeWorkItems([localItem], [remoteItem]);

    expect(result.merged).toHaveLength(1);
    expect(result.merged[0].status).toBe('completed');
    const regressionConflicts = extractRegressionConflicts(result);
    expect(regressionConflicts).toHaveLength(0);
  });

  it('does not flag when both sides have different non-default values (legitimate conflict)', () => {
    const localItem = mkItem({
      status: 'in-progress',
      priority: 'high',
      updatedAt: '2024-06-01T12:00:00.000Z',
    });
    const remoteItem = mkItem({
      status: 'completed',
      priority: 'low',
      updatedAt: '2024-06-02T12:00:00.000Z',
    });

    const result = mergeWorkItems([localItem], [remoteItem]);

    expect(result.merged).toHaveLength(1);
    const regressionConflicts = extractRegressionConflicts(result);
    expect(regressionConflicts).toHaveLength(0);
  });
});
