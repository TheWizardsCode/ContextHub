import { describe, it, expect } from 'vitest';
import { validateStatusStageItems } from '../src/doctor/status-stage-check.js';
import type { StatusStageRules } from '../src/status-stage-rules.js';
import type { WorkItem } from '../src/types.js';

const rules: StatusStageRules = {
  statuses: [
    { value: 'open', label: 'Open' },
    { value: 'in-progress', label: 'In Progress' },
    { value: 'blocked', label: 'Blocked' },
    { value: 'completed', label: 'Completed' },
    { value: 'deleted', label: 'Deleted' },
  ],
  stages: [
    { value: '', label: 'Undefined' },
    { value: 'idea', label: 'Idea' },
    { value: 'intake_complete', label: 'Intake Complete' },
    { value: 'plan_complete', label: 'Plan Complete' },
    { value: 'in_progress', label: 'In Progress' },
    { value: 'in_review', label: 'In Review' },
    { value: 'done', label: 'Done' },
  ],
  statusStageCompatibility: {
    open: ['', 'idea', 'intake_complete', 'plan_complete', 'in_progress'],
    'in-progress': ['in_progress'],
    blocked: ['', 'idea', 'intake_complete', 'plan_complete', 'in_progress'],
    completed: ['in_review', 'done'],
    deleted: [''],
  },
  stageStatusCompatibility: {
    '': ['open', 'blocked', 'deleted'],
    idea: ['open', 'blocked'],
    intake_complete: ['open', 'blocked'],
    plan_complete: ['open', 'blocked'],
    in_progress: ['open', 'in-progress', 'blocked'],
    in_review: ['completed'],
    done: ['completed'],
  },
  statusLabels: {},
  stageLabels: {},
  statusValues: ['open', 'in-progress', 'blocked', 'completed', 'deleted'],
  stageValues: ['', 'idea', 'intake_complete', 'plan_complete', 'in_progress', 'in_review', 'done'],
  statusValuesByLabel: {},
  stageValuesByLabel: {},
};

const baseItem = (overrides: Partial<WorkItem>): WorkItem => ({
  id: 'WL-TEST-1',
  title: 'Test item',
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

describe('doctor status/stage validation', () => {
  it('returns no findings for valid combinations', () => {
    const items = [
      baseItem({ id: 'WL-VALID-1', status: 'open', stage: 'idea' }),
      baseItem({ id: 'WL-VALID-2', status: 'in-progress', stage: 'in_progress' }),
      baseItem({ id: 'WL-VALID-3', status: 'completed', stage: 'done' }),
    ];
    const findings = validateStatusStageItems(items, rules);
    expect(findings.length).toBe(0);
  });

  it('flags invalid status values', () => {
    const items = [baseItem({ id: 'WL-BAD-STATUS', status: 'invalid' as any, stage: 'idea' })];
    const findings = validateStatusStageItems(items, rules);
    expect(findings.some(f => f.checkId === 'status-stage.invalid-status')).toBe(true);
    const statusFinding = findings.find(f => f.checkId === 'status-stage.invalid-status');
    expect(statusFinding?.type).toBe('invalid-status');
    expect(statusFinding?.severity).toBe('warning');
  });

  it('flags invalid stage values', () => {
    const items = [baseItem({ id: 'WL-BAD-STAGE', status: 'open', stage: 'blocked' })];
    const findings = validateStatusStageItems(items, rules);
    expect(findings.some(f => f.checkId === 'status-stage.invalid-stage')).toBe(true);
    const stageFinding = findings.find(f => f.checkId === 'status-stage.invalid-stage');
    expect(stageFinding?.type).toBe('invalid-stage');
    expect(stageFinding?.severity).toBe('warning');
  });

  it('flags incompatible status/stage combinations', () => {
    const items = [baseItem({ id: 'WL-BAD-COMBINATION', status: 'completed', stage: 'idea' })];
    const findings = validateStatusStageItems(items, rules);
    expect(findings.some(f => f.checkId === 'status-stage.incompatible')).toBe(true);
    const incompatibleFinding = findings.find(f => f.checkId === 'status-stage.incompatible');
    expect(incompatibleFinding?.type).toBe('incompatible-status-stage');
    expect(incompatibleFinding?.severity).toBe('warning');
  });

  it('accepts normalized legacy values as fix suggestions', () => {
    const items = [baseItem({ id: 'WL-NORMALIZE', status: 'in_progress' as any, stage: 'in-progress' })];
    const findings = validateStatusStageItems(items, rules);
    const statusFinding = findings.find(f => f.checkId === 'status-stage.invalid-status');
    const stageFinding = findings.find(f => f.checkId === 'status-stage.invalid-stage');
    expect(statusFinding?.safe).toBe(true);
    expect(stageFinding?.safe).toBe(true);
  });
});
