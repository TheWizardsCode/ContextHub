/**
 * tests/herdr/fetcher.test.ts — Tests for Herdr plugin data fetching
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  fetchNextItems,
  fetchItemDetails,
  fetchItemsByStage,
  fetchChildrenForItem,
  checkWlAvailable,
  setExecFileAsync,
  resetExecFileAsync,
} from '../../packages/herdr/src/fetcher.js';

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Create a promisified-like mock that calls the callback directly.
 * The mockExecFile receives arguments as (binary, args, opts, callback).
 */
function makeMock(cb: (...args: any[]) => void): any {
  return (...args: any[]) => {
    return new Promise<void>((resolve, reject) => {
      // Find the callback (last arg if it's a function)
      const lastIdx = args.length - 1;
      const callback = typeof args[lastIdx] === 'function'
        ? args[lastIdx]
        : typeof args[lastIdx - 1] === 'function'
          ? args[lastIdx - 1]
          : null;

      if (callback) {
        try {
          cb(args[0], args[1], args[2], (err: any, result: any) => {
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
            // Also call the original callback for the Node-style pattern
            callback(err, result);
          });
        } catch (err) {
          callback(err, null);
          reject(err);
        }
      } else {
        reject(new Error('No callback found'));
      }
    });
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('fetchNextItems', () => {
  beforeEach(() => {
    resetExecFileAsync();
  });

  it('returns parsed work items from wl next', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        results: [
          {
            workItem: {
              id: 'WL-TEST001',
              title: 'Test item',
              status: 'open',
              priority: 'high',
              stage: 'plan_complete',
              description: 'A test work item',
            },
            group: 0,
          },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    const items = await fetchNextItems();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('WL-TEST001');
    expect(items[0].title).toBe('Test item');
    expect(items[0].status).toBe('open');
    expect(items[0].priority).toBe('high');
  });

  it('throws when wl is not installed', async () => {
    const mockFn = vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    setExecFileAsync(mockFn as any);

    await expect(fetchNextItems()).rejects.toThrow();
  });

  it('returns empty array when no results', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ results: [] }),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    const items = await fetchNextItems();
    expect(items).toEqual([]);
  });

  it('handles items with missing fields gracefully', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        results: [
          { workItem: { id: 'WL-TEST001' } },
          { workItem: { id: 'WL-TEST002', title: 'Has title' } },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    const items = await fetchNextItems();
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('Untitled');
    expect(items[0].status).toBe('unknown');
    expect(items[1].title).toBe('Has title');
  });

  it('fetches mandatory subsets root-only (WL-0MS964SIA0057ABR)', async () => {
    // Both mandatory-subset `wl list` queries must pass --root-only so child
    // items never appear in the top-level worklist.
    const mockFn = vi.fn().mockImplementation((_bin: string, args: string[]) => {
      const stdout = JSON.stringify({ workItems: [] });
      return Promise.resolve({ stdout, stderr: '' });
    });
    setExecFileAsync(mockFn as any);

    await fetchNextItems(10);
    const calls = mockFn.mock.calls.map((c: any) => c[1]);
    const listCalls = calls.filter((args: string[]) => args[0] === 'list');
    // Two mandatory-subset queries: critical + completed/in_review.
    expect(listCalls.length).toBeGreaterThanOrEqual(2);
    for (const args of listCalls) {
      expect(args).toContain('--root-only');
    }
    // Drill-down (children) is NOT root-only — children must remain fetchable.
    expect(calls.some((args: string[]) => args.includes('--parent'))).toBe(false);
  });
});

describe('fetchItemDetails', () => {
  beforeEach(() => {
    resetExecFileAsync();
  });

  it('fetches and returns work item details by ID', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        id: 'WL-TEST001',
        title: 'Test item',
        status: 'open',
        priority: 'high',
        stage: 'plan_complete',
        description: 'Detailed description\nwith multiple lines',
        tags: ['frontend', 'bug'],
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-02T00:00:00.000Z',
      }),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    const detail = await fetchItemDetails('WL-TEST001');
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe('WL-TEST001');
    expect(detail!.description).toBe('Detailed description\nwith multiple lines');
    expect(detail!.tags).toEqual(['frontend', 'bug']);
  });

  it('returns null for missing item', async () => {
    const mockFn = vi.fn().mockRejectedValue(new Error('Not found'));
    setExecFileAsync(mockFn as any);

    const detail = await fetchItemDetails('WL-NONEXISTENT');
    expect(detail).toBeNull();
  });
});

describe('fetchItemsByStage', () => {
  beforeEach(() => {
    resetExecFileAsync();
  });

  it('filters items by stage', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        workItems: [
          { id: 'WL-TEST001', title: 'Planning item', stage: 'plan_complete' },
          { id: 'WL-TEST002', title: 'In progress item', stage: 'in_progress' },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    const items = await fetchItemsByStage('plan_complete');
    expect(items).toHaveLength(2);
  });

  it('returns empty array when stage filter yields no results', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ workItems: [] }),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    const items = await fetchItemsByStage('done');
    expect(items).toEqual([]);
  });

  it('passes --root-only to wl list for stage queries (WL-0MS964SIA0057ABR)', async () => {
    const mockFn = vi.fn().mockImplementation((_bin: string, args: string[]) => {
      const stdout = JSON.stringify({ workItems: [] });
      return Promise.resolve({ stdout, stderr: '' });
    });
    setExecFileAsync(mockFn as any);

    await fetchItemsByStage('in_progress');
    const calls = mockFn.mock.calls.map((c: any) => c[1]);
    expect(calls).toHaveLength(1);
    // runWl appends --json automatically.
    expect(calls[0]).toEqual(['list', '--stage', 'in_progress', '--root-only', '--json']);
  });
});

describe('fetchChildrenForItem', () => {
  beforeEach(() => {
    resetExecFileAsync();
  });

  it('fetches and returns child items for a parent ID', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        workItems: [
          { id: 'WL-001-C1', title: 'Child 1', status: 'open', childCount: 0 },
          { id: 'WL-001-C2', title: 'Child 2', status: 'open', childCount: 0 },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    const children = await fetchChildrenForItem('WL-001');
    expect(children).toHaveLength(2);
    expect(children[0].id).toBe('WL-001-C1');
    expect(children[0].depth).toBe(1);
    expect(children[1].id).toBe('WL-001-C2');
    expect(children[1].depth).toBe(1);

    // Verify correct CLI args — runWl adds --json automatically
    expect(mockFn).toHaveBeenCalledWith(
      expect.any(String),
      ['list', '--parent', 'WL-001', '--json'],
      { maxBuffer: 5242880 },
    );
  });

  it('returns empty array when parent has no children', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ workItems: [] }),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    const children = await fetchChildrenForItem('WL-NOCHILDREN');
    expect(children).toEqual([]);
  });

  it('throws when wl CLI fails', async () => {
    const mockFn = vi.fn().mockRejectedValue(new Error('WL error'));
    setExecFileAsync(mockFn as any);

    await expect(fetchChildrenForItem('WL-001')).rejects.toThrow();
  });
});

describe('checkWlAvailable', () => {
  beforeEach(() => {
    resetExecFileAsync();
  });

  it('returns true when wl is available', async () => {
    const mockFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    setExecFileAsync(mockFn as any);

    const available = await checkWlAvailable();
    expect(available).toBe(true);
  });

  it('returns false when wl is not found', async () => {
    const mockFn = vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    setExecFileAsync(mockFn as any);

    const available = await checkWlAvailable();
    expect(available).toBe(false);
  });
});
