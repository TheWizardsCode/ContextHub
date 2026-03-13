import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { displayItemTree, displayItemTreeWithFormat } from '../../src/commands/helpers.js';
import type { WorkItem, WorkItemPriority, WorkItemStatus } from '../../src/types.js';
import { WorklogDatabase } from '../../src/database.js';
import { createTempDbPath, createTempDir, createTempJsonlPath, cleanupTempDir } from '../test-utils.js';

type WorkItemOverrides = Partial<WorkItem> & { id: string; title: string };

const baseWorkItem = (overrides: WorkItemOverrides): WorkItem => {
  const now = '2024-01-01T00:00:00.000Z';
  return {
    id: overrides.id,
    title: overrides.title,
    description: overrides.description ?? '',
    status: (overrides.status ?? 'open') as WorkItemStatus,
    priority: (overrides.priority ?? 'medium') as WorkItemPriority,
    sortIndex: overrides.sortIndex ?? 0,
    parentId: overrides.parentId ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    tags: overrides.tags ?? [],
    assignee: overrides.assignee ?? '',
    stage: overrides.stage ?? '',
    issueType: overrides.issueType ?? 'task',
    createdBy: overrides.createdBy ?? '',
    deletedBy: overrides.deletedBy ?? '',
    deleteReason: overrides.deleteReason ?? '',
    risk: overrides.risk ?? '',
    effort: overrides.effort ?? ''
  };
};

const captureConsole = () => {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(arg => String(arg)).join(' '));
  });
  return { lines, spy };
};

const stripAnsi = (value: string) => value.replace(/\u001b\[[0-9;]*m/g, '');

describe('tree rendering helpers', () => {
  let tempDir: string;
  let dbPath: string;
  let jsonlPath: string;
  let db: WorklogDatabase;

  beforeEach(() => {
    tempDir = createTempDir();
    dbPath = createTempDbPath(tempDir);
    jsonlPath = createTempJsonlPath(tempDir);
    db = new WorklogDatabase('TEST', dbPath, jsonlPath, false, true);
  });

  afterEach(() => {
    db.close();
    cleanupTempDir(tempDir);
  });

  it('orders roots and children for displayItemTree', () => {
    const items = [
      baseWorkItem({ id: 'TEST-ROOT-2', title: 'Root 2', priority: 'low', createdAt: '2024-01-02T00:00:00.000Z' }),
      baseWorkItem({ id: 'TEST-ROOT-1', title: 'Root 1', priority: 'high', createdAt: '2024-01-01T00:00:00.000Z' }),
      baseWorkItem({ id: 'TEST-CHILD-B', title: 'Child B', parentId: 'TEST-ROOT-1', priority: 'low', createdAt: '2024-01-03T00:00:00.000Z' }),
      baseWorkItem({ id: 'TEST-CHILD-A', title: 'Child A', parentId: 'TEST-ROOT-1', priority: 'low', createdAt: '2024-01-02T00:00:00.000Z' })
    ];

    const { lines, spy } = captureConsole();
    displayItemTree(items);
    spy.mockRestore();

    const normalized = lines.map(stripAnsi);
    const root1Index = normalized.findIndex(line => line.includes('Root 1'));
    const root2Index = normalized.findIndex(line => line.includes('Root 2'));
    const childAIndex = normalized.findIndex(line => line.includes('Child A'));
    const childBIndex = normalized.findIndex(line => line.includes('Child B'));

    expect(root1Index).toBeGreaterThanOrEqual(0);
    expect(root2Index).toBeGreaterThanOrEqual(0);
    expect(root1Index).toBeLessThan(root2Index);
    expect(childAIndex).toBeGreaterThanOrEqual(0);
    expect(childBIndex).toBeGreaterThanOrEqual(0);
    expect(childAIndex).toBeLessThan(childBIndex);
  });

  it('renders tree output using sortIndex ordering when db is provided', () => {
    const parent = db.create({ title: 'Parent' });
    const childA = db.create({ title: 'Child A', parentId: parent.id, sortIndex: 200 });
    const childB = db.create({ title: 'Child B', parentId: parent.id, sortIndex: 100 });

    const items = [parent, childA, childB];

    const { lines, spy } = captureConsole();
    displayItemTreeWithFormat(items, db, 'concise');
    spy.mockRestore();

    const normalized = lines.map(stripAnsi);
    const parentIndex = normalized.findIndex(line => line.includes('Parent'));
    const childAIndex = normalized.findIndex(line => line.includes('Child A'));
    const childBIndex = normalized.findIndex(line => line.includes('Child B'));

    expect(parentIndex).toBeGreaterThanOrEqual(0);
    expect(childAIndex).toBeGreaterThanOrEqual(0);
    expect(childBIndex).toBeGreaterThanOrEqual(0);
    expect(childBIndex).toBeLessThan(childAIndex);
  });

  it('shows Risk and Effort placeholders when fields are empty', () => {
    const item = baseWorkItem({ id: 'TEST-RISK-1', title: 'Risk Test', risk: '', effort: '' });

    const { lines, spy } = captureConsole();
    displayItemTree([item]);
    spy.mockRestore();

    const normalized = lines.map(stripAnsi);
    expect(normalized.some(line => line.includes('Risk: —'))).toBe(true);
    expect(normalized.some(line => line.includes('Effort: —'))).toBe(true);
  });

  it('shows Risk and Effort values when set', () => {
    const item = baseWorkItem({ id: 'TEST-RISK-2', title: 'Risk Set', risk: 'High', effort: 'M' });

    const { lines, spy } = captureConsole();
    displayItemTree([item]);
    spy.mockRestore();

    const normalized = lines.map(stripAnsi);
    expect(normalized.some(line => line.includes('Risk: High'))).toBe(true);
    expect(normalized.some(line => line.includes('Effort: M'))).toBe(true);
  });

  it('shows Risk and Effort in concise format output', () => {
    const item = baseWorkItem({ id: 'TEST-RISK-3', title: 'Concise Test', risk: 'Low', effort: 'XS' });
    const items = [item];

    const { lines, spy } = captureConsole();
    displayItemTreeWithFormat(items, null, 'concise');
    spy.mockRestore();

    const normalized = lines.map(stripAnsi).join('\n');
    expect(normalized).toContain('Risk: Low');
    expect(normalized).toContain('Effort: XS');
  });

  it('shows Risk and Effort placeholders in normal format when fields are empty', () => {
    const item = baseWorkItem({ id: 'TEST-RISK-4', title: 'Normal Test', risk: '', effort: '' });
    const items = [item];

    const { lines, spy } = captureConsole();
    displayItemTreeWithFormat(items, null, 'normal');
    spy.mockRestore();

    const normalized = lines.map(stripAnsi).join('\n');
    expect(normalized).toContain('Risk: —');
    expect(normalized).toContain('Effort: —');
  });
});
