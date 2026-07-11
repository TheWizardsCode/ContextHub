import { describe, it, expect } from 'vitest';
import { validateDependencyEdges } from '../src/doctor/dependency-check.js';
import type { DependencyEdge, WorkItem } from '../src/types.js';

const baseItem = (id: string): WorkItem => ({
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
});

const edge = (fromId: string, toId: string, createdAt?: string): DependencyEdge => ({
  fromId,
  toId,
  createdAt: createdAt ?? '2026-02-01T01:00:00.000Z',
});

describe('doctor dependency validation', () => {
  it('returns no findings when all endpoints exist', () => {
    const items = [baseItem('WL-ONE'), baseItem('WL-TWO')];
    const findings = validateDependencyEdges(items, [edge('WL-ONE', 'WL-TWO')]);
    expect(findings.length).toBe(0);
  });

  it('flags missing fromId', () => {
    const items = [baseItem('WL-TWO')];
    const findings = validateDependencyEdges(items, [edge('WL-ONE', 'WL-TWO')]);
    expect(findings.length).toBe(1);
    expect(findings[0].type).toBe('missing-dependency-endpoint');
    expect(findings[0].severity).toBe('error');
    expect(findings[0].context).toMatchObject({
      fromId: 'WL-ONE',
      toId: 'WL-TWO',
      missingFrom: true,
      missingTo: false,
    });
  });

  it('flags missing toId', () => {
    const items = [baseItem('WL-ONE')];
    const findings = validateDependencyEdges(items, [edge('WL-ONE', 'WL-TWO')]);
    expect(findings.length).toBe(1);
    expect(findings[0].type).toBe('missing-dependency-endpoint');
    expect(findings[0].severity).toBe('error');
    expect(findings[0].context).toMatchObject({
      fromId: 'WL-ONE',
      toId: 'WL-TWO',
      missingFrom: false,
      missingTo: true,
    });
  });

  it('flags missing fromId and toId', () => {
    const items = [baseItem('WL-THREE')];
    const findings = validateDependencyEdges(items, [edge('WL-ONE', 'WL-TWO')]);
    expect(findings.length).toBe(1);
    expect(findings[0].context).toMatchObject({
      missingFrom: true,
      missingTo: true,
    });
  });
});
