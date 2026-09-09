/**
 * tests/herdr/fetcher.test.ts — Tests for Herdr plugin data fetching
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  fetchNextItems,
  fetchItemDetails,
  fetchItemsByStage,
  fetchItemsByPriority,
  fetchChildrenForItem,
  fetchActionableCount,
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

  it('fetches mandatory subsets root-only (WL-0MS964SIA0057ABR, cae8ea8a)', async () => {
    // Mandatory subsets are fetched with mixed root-only: critical is
    // deliberately NOT root-only so child critical blockers are visible
    // (cae8ea8a — test-failure children must surface); the review queue is
    // root-only (producer reviews parent deliverables).
    const mockFn = vi.fn().mockImplementation((_bin: string, args: string[]) => {
      const stdout = JSON.stringify({ workItems: [] });
      return Promise.resolve({ stdout, stderr: '' });
    });
    setExecFileAsync(mockFn as any);

    await fetchNextItems(10);
    const calls = mockFn.mock.calls.map((c: any) => c[1]);
    const listCalls = calls.filter((args: string[]) => args[0] === 'list');
    // Two mandatory-subset queries: critical (includes children) + completed/in_review (root-only).
    expect(listCalls.length).toBeGreaterThanOrEqual(2);
    const reviewCall = listCalls.find((a: string[]) => a.includes('in_review'));
    expect(reviewCall).toContain('--root-only');
    const criticalCall = listCalls.find((a: string[]) => a.includes('critical'));
    expect(criticalCall).not.toContain('--root-only');
    // Drill-down (children) is NOT root-only — children must remain fetchable.
    expect(calls.some((args: string[]) => args.includes('--parent'))).toBe(false);
  });
});

describe('fetchActionableCount', () => {
  beforeEach(() => {
    resetExecFileAsync();
  });

  it('returns the count from wl list output', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ count: 47 }),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    const count = await fetchActionableCount();
    expect(count).toBe(47);
  });

  it('returns undefined when the count field is missing', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ workItems: [] }),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    const count = await fetchActionableCount();
    expect(count).toBeUndefined();
  });

  it('returns undefined when wl fails (graceful degradation)', async () => {
    const mockFn = vi.fn().mockRejectedValue(new Error('wl not found'));
    setExecFileAsync(mockFn as any);

    const count = await fetchActionableCount();
    expect(count).toBeUndefined();
  });

  it('queries only open/in-progress/blocked statuses', async () => {
    const mockFn = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ count: 5 }), stderr: '' });
    setExecFileAsync(mockFn as any);

    await fetchActionableCount();
    const args = mockFn.mock.calls[0][1];
    expect(args).toContain('list');
    expect(args).toContain('--status');
    expect(args).toContain('open,in-progress,blocked');
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
    // Open items only (WL-0MSDT8X1V003206G): stage-filtered worklists show
    // every open root item in the stage.
    expect(calls[0]).toEqual(['list', '--status', 'open', '--stage', 'in_progress', '--root-only', '--json']);
  });

  it('regroups results priority-first before display (WL-0MSOPHLD1000EWNN)', async () => {
    // CLI order is NOT priority-first: a low-priority plan_complete item
    // precedes a critical one. The regroup wiring must reorder to the
    // canonical bucket order (Critical Group → Group) and stamp metadata.
    const mockFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        workItems: [
          { id: 'WL-STAGE-LOW', title: 'Low plan item', stage: 'plan_complete', priority: 'low' },
          { id: 'WL-STAGE-CRIT', title: 'Critical plan item', stage: 'plan_complete', priority: 'critical' },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    const items = await fetchItemsByStage('plan_complete');
    expect(items.map((i) => i.id)).toEqual(['WL-STAGE-CRIT', 'WL-STAGE-LOW']);
    expect(items[0].groupLabel).toBe('Critical Group 1');
    expect(items[1].groupLabel).toBe('Group 1');
    expect(items[0].group).toBeLessThan(items[1].group!);
  });
});

describe('fetchItemsByPriority', () => {
  beforeEach(() => {
    resetExecFileAsync();
  });

  it('filters items by priority', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        workItems: [
          { id: 'WL-TEST001', title: 'Critical item', priority: 'critical' },
          { id: 'WL-TEST002', title: 'High item', priority: 'high' },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    const items = await fetchItemsByPriority('critical');
    expect(items).toHaveLength(2);
  });

  it('returns empty array when priority filter yields no results', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ workItems: [] }),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    const items = await fetchItemsByPriority('low');
    expect(items).toEqual([]);
  });

  it('passes --status open --priority <p> --root-only to wl list (WL-0MSKC8T46006999S)', async () => {
    const mockFn = vi.fn().mockImplementation((_bin: string, args: string[]) => {
      const stdout = JSON.stringify({ workItems: [] });
      return Promise.resolve({ stdout, stderr: '' });
    });
    setExecFileAsync(mockFn as any);

    await fetchItemsByPriority('critical');
    const calls = mockFn.mock.calls.map((c: any) => c[1]);
    expect(calls).toHaveLength(1);
    // runWl appends --json automatically.
    // Open root items only — mirrors the stage-filter semantics
    // (WL-0MSDT8X1V003206G): every open root item at that priority, no cap.
    expect(calls[0]).toEqual(['list', '--status', 'open', '--priority', 'critical', '--root-only', '--json']);
  });

  it('regroups results priority-first before display (WL-0MSOPHLD1000EWNN)', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        workItems: [
          { id: 'WL-PRIO-LOW', title: 'Low plan item', stage: 'plan_complete', priority: 'low' },
          { id: 'WL-PRIO-CRIT', title: 'Critical plan item', stage: 'plan_complete', priority: 'critical' },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    const items = await fetchItemsByPriority('critical');
    expect(items.map((i) => i.id)).toEqual(['WL-PRIO-CRIT', 'WL-PRIO-LOW']);
    expect(items[0].groupLabel).toBe('Critical Group 1');
    expect(items[1].groupLabel).toBe('Group 1');
    expect(items[0].group).toBeLessThan(items[1].group!);
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

    // Verify correct CLI args — runWl adds --json automatically and always
    // passes a bounded timeout (DEFAULT_WL_TIMEOUT_MS) so a hung wl child
    // cannot wedge the refresh path (WL-0MSJNJXX2001NMHS).
    expect(mockFn).toHaveBeenCalledWith(
      expect.any(String),
      ['list', '--parent', 'WL-001', '--json'],
      { maxBuffer: 5242880, timeout: 60_000 },
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

  it('regroups child items priority-first, preserving depth (WL-0MSOPHLD1000EWNN)', async () => {
    // CLI order is NOT priority-first: a medium in_progress child precedes a
    // critical one. The regroup wiring must reorder children to the
    // canonical bucket order while keeping the hierarchy `depth` intact.
    const mockFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        workItems: [
          { id: 'WL-001-C1', title: 'In progress child', stage: 'in_progress', priority: 'medium' },
          { id: 'WL-001-C2', title: 'Critical child', stage: 'plan_complete', priority: 'critical' },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    const children = await fetchChildrenForItem('WL-001', 1);
    expect(children.map((c) => c.id)).toEqual(['WL-001-C2', 'WL-001-C1']);
    expect(children[0].groupLabel).toBe('Critical Group 1');
    expect(children[1].groupLabel).toBe('Group 1');
    // Depth must survive regrouping — the expand hierarchy still renders.
    expect(children[0].depth).toBe(1);
    expect(children[1].depth).toBe(1);
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
