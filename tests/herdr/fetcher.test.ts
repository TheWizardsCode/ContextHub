/**
 * tests/herdr/fetcher.test.ts — Tests for Herdr plugin data fetching
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  fetchNextItems,
  fetchItemDetails,
  fetchItemsByStage,
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
