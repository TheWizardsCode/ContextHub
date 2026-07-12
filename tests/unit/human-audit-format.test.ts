import { describe, it, expect, vi } from 'vitest';
import { humanFormatWorkItem } from '../../src/commands/helpers.js';

// Minimal WorkItem-like shape used for formatting tests
const baseItem: any = {
  id: 'TEST-1',
  title: 'Audit formatting test',
  status: 'open',
  priority: 'medium',
  sortIndex: 100,
  stage: 'in_progress',
  createdAt: '2026-03-26T00:00:00Z',
  updatedAt: '2026-03-26T00:00:00Z',
  tags: [],
  assignee: 'alice',
  description: 'A test item for audit formatting',
  parentId: undefined,
  risk: undefined,
  effort: undefined,
  issueType: 'task'
};

// Mock database that returns audit results from the audit_results table
function createMockDb(auditResult: any = null) {
  return {
    getAuditResult: vi.fn().mockReturnValue(auditResult),
    getCommentsForWorkItem: vi.fn().mockReturnValue([]),
    getDescendants: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue(null),
  } as any;
}

describe('humanFormatWorkItem audit formatting', () => {
  it('renders concise/normal/full outputs with audit present (snapshots)', () => {
    const item = Object.assign({}, baseItem);
    const mockDb = createMockDb({
      workItemId: 'TEST-1',
      readyToClose: true,
      auditedAt: '2026-03-26T20:29:00Z',
      summary: 'Ready to close: Yes\nExtra details',
      rawOutput: null,
      author: 'alice',
    });

    const concise = humanFormatWorkItem(item, mockDb, 'concise');
    const normal = humanFormatWorkItem(item, mockDb, 'normal');
    const full = humanFormatWorkItem(item, mockDb, 'full');

    expect(concise).toMatchSnapshot('concise-with-audit');
    expect(normal).toMatchSnapshot('normal-with-audit');
    expect(full).toMatchSnapshot('full-with-audit');
  });

  it('renders concise/normal/full outputs without audit (snapshots)', () => {
    const item = Object.assign({}, baseItem);
    const mockDb = createMockDb(null);

    const concise = humanFormatWorkItem(item, mockDb, 'concise');
    const normal = humanFormatWorkItem(item, mockDb, 'normal');
    const full = humanFormatWorkItem(item, mockDb, 'full');

    expect(concise).toMatchSnapshot('concise-without-audit');
    expect(normal).toMatchSnapshot('normal-without-audit');
    expect(full).toMatchSnapshot('full-without-audit');
  });
});