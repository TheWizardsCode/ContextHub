import { describe, it, expect } from 'vitest';
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

describe('humanFormatWorkItem audit formatting', () => {
  it('renders concise/normal/full outputs with audit present (snapshots)', () => {
    const item = Object.assign({}, baseItem, {
      audit: { time: '2026-03-26T20:29:00Z', author: 'alice', text: 'Ready to close: Yes\nExtra details' }
    });

    const concise = humanFormatWorkItem(item, null, 'concise');
    const normal = humanFormatWorkItem(item, null, 'normal');
    const full = humanFormatWorkItem(item, null, 'full');

    expect(concise).toMatchSnapshot('concise-with-audit');
    expect(normal).toMatchSnapshot('normal-with-audit');
    expect(full).toMatchSnapshot('full-with-audit');
  });

  it('renders concise/normal/full outputs without audit (snapshots)', () => {
    const item = Object.assign({}, baseItem);

    const concise = humanFormatWorkItem(item, null, 'concise');
    const normal = humanFormatWorkItem(item, null, 'normal');
    const full = humanFormatWorkItem(item, null, 'full');

    expect(concise).toMatchSnapshot('concise-without-audit');
    expect(normal).toMatchSnapshot('normal-without-audit');
    expect(full).toMatchSnapshot('full-without-audit');
  });
});
