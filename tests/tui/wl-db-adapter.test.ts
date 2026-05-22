import { describe, it, expect, vi, beforeEach } from 'vitest';

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawnSync: spawnSyncMock,
}));

import { createWlDbAdapter } from '../../src/tui/wl-db-adapter.js';

const baseWorkItem = {
  id: 'WL-TEST-1',
  title: 'Adapter test item',
  description: 'Adapter test description',
  status: 'open',
  priority: 'high',
  sortIndex: 12,
  parentId: null,
  createdAt: '2026-05-22T00:00:00.000Z',
  updatedAt: '2026-05-22T00:00:00.000Z',
  tags: ['tui', 'adapter'],
  assignee: 'Map',
  stage: 'idea',
  issueType: 'bug',
  createdBy: 'Map',
  deletedBy: '',
  deleteReason: '',
  risk: 'Low',
  effort: 'S',
  needsProducerReview: true,
};

beforeEach(() => {
  spawnSyncMock.mockReset();
  spawnSyncMock.mockImplementation((command: string, args: readonly string[] = []) => {
    const argv = Array.from(args);
    const subcommand = argv[0];

    if (command !== 'wl') {
      return { status: 1, stdout: '', stderr: `unexpected command: ${command}` };
    }

    if (subcommand === 'list') {
      return {
        status: 0,
        stdout: JSON.stringify({
          success: true,
          count: 1,
          workItems: [baseWorkItem],
        }),
        stderr: '',
      };
    }

    if (subcommand === 'show') {
      return {
        status: 0,
        stdout: JSON.stringify({
          success: true,
          workItem: baseWorkItem,
          comments: [
            {
              id: 'WL-C1',
              workItemId: baseWorkItem.id,
              comment: 'First comment',
              author: 'Map',
              createdAt: '2026-05-22T00:10:00.000Z',
            },
          ],
        }),
        stderr: '',
      };
    }

    if (subcommand === 'create') {
      return {
        status: 0,
        stdout: JSON.stringify({
          success: true,
          workItem: { ...baseWorkItem, id: 'WL-TEST-2', title: 'Created item' },
        }),
        stderr: '',
      };
    }

    if (subcommand === 'update') {
      return {
        status: 0,
        stdout: JSON.stringify({
          success: true,
          workItem: { ...baseWorkItem, status: 'in-progress', assignee: 'Map' },
        }),
        stderr: '',
      };
    }

    if (subcommand === 'comment' && argv[1] === 'list') {
      return {
        status: 0,
        stdout: JSON.stringify({
          success: true,
          count: 1,
          workItemId: argv[2],
          comments: [
            {
              id: 'WL-C1',
              workItemId: argv[2],
              comment: 'First comment',
              author: 'Map',
              createdAt: '2026-05-22T00:10:00.000Z',
            },
          ],
        }),
        stderr: '',
      };
    }

    if (subcommand === 'comment' && argv[1] === 'add') {
      return {
        status: 0,
        stdout: JSON.stringify({
          success: true,
          comment: {
            id: 'WL-C2',
            workItemId: argv[2],
            comment: 'New comment',
            author: 'Map',
            createdAt: '2026-05-22T00:11:00.000Z',
          },
        }),
        stderr: '',
      };
    }

    return { status: 1, stdout: '', stderr: `unexpected args: ${argv.join(' ')}` };
  });
});

describe('createWlDbAdapter', () => {
  it('uses wl subcommands and unwraps list/show/create/update envelopes', () => {
    const db = createWlDbAdapter();

    expect(db.list({ status: ['open'], assignee: 'Map' })).toEqual([baseWorkItem]);
    expect(db.get('WL-TEST-1')).toEqual(baseWorkItem);
    expect(db.create({ title: 'Created item', description: 'Created description' })).toEqual({
      ...baseWorkItem,
      id: 'WL-TEST-2',
      title: 'Created item',
    });
    expect(db.update('WL-TEST-1', { status: 'in-progress', assignee: 'Map' })).toEqual({
      ...baseWorkItem,
      status: 'in-progress',
      assignee: 'Map',
    });

    expect(spawnSyncMock.mock.calls.map(call => call[1][0])).toEqual([
      'list',
      'show',
      'create',
      'update',
    ]);
    expect(spawnSyncMock.mock.calls[0][2]).toMatchObject({ maxBuffer: 20 * 1024 * 1024 });
  });

  it('parses wrapped comment payloads for list and add', () => {
    const db = createWlDbAdapter();

    expect(db.getCommentsForWorkItem('WL-TEST-1')).toEqual([
      {
        id: 'WL-C1',
        workItemId: 'WL-TEST-1',
        comment: 'First comment',
        author: 'Map',
        createdAt: '2026-05-22T00:10:00.000Z',
      },
    ]);

    expect(db.createComment({ workItemId: 'WL-TEST-1', comment: 'New comment', author: 'Map' })).toEqual({
      id: 'WL-C2',
      workItemId: 'WL-TEST-1',
      comment: 'New comment',
      author: 'Map',
      createdAt: '2026-05-22T00:11:00.000Z',
    });

    expect(spawnSyncMock.mock.calls.map(call => call[1][0])).toEqual([
      'comment',
      'comment',
    ]);
    expect(spawnSyncMock.mock.calls[0][1]).toContain('list');
    expect(spawnSyncMock.mock.calls[1][1]).toContain('add');
  });

  it('returns arrays from wrapped list payloads for getAll and getChildren', () => {
    const db = createWlDbAdapter();

    expect(db.getAll()).toEqual([baseWorkItem]);
    expect(db.getChildren('WL-PARENT')).toEqual([baseWorkItem]);
  });
});
