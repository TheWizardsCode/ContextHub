/**
 * Unit tests for packages/herdr/src/fetcher.ts — the fetch paths that feed
 * the worklist. Covers the priority-first regroup wiring (WL-0MSOPHLD1000EWNN,
 * parent WL-0MSI1LVTJ001M9EY AC4): stage-filtered views and expanded child
 * lists must apply the same priority-first ordering as the default worklist.
 *
 * Run: npx vitest run packages/herdr/src/fetcher.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  fetchItemsByStage,
  fetchChildrenForItem,
  setExecFileAsync,
  resetExecFileAsync,
  type WorkItem,
} from './fetcher.js';

type MockExec = (bin: string, args: string[], opts?: unknown) => Promise<{ stdout: string; stderr: string }>;

/**
 * Install a mock wl CLI that returns a given JSON payload for any invocation.
 */
function mockWlReturning(payload: unknown): MockExec {
  const mock: MockExec = async () => ({ stdout: JSON.stringify(payload), stderr: '' });
  setExecFileAsync(mock as any);
  return mock;
}

/** A minimal raw wl item. */
function rawItem(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, title: `Item ${id}`, status: 'open', ...overrides };
}

describe('fetchItemsByStage — priority-first regroup (WL-0MSOPHLD1000EWNN)', () => {
  beforeEach(() => resetExecFileAsync());
  afterEach(() => resetExecFileAsync());

  it('regroups the wl list --stage result into priority-bucket order', async () => {
    // wl list returns CLI order (sortIndex/priority-date): the medium
    // plan_complete item comes FIRST and the high-priority in_progress item
    // trails it — the same misordering the default list used to show. The
    // fetched stage list must be regrouped to priority-first.
    mockWlReturning({
      workItems: [
        rawItem('WL-MED', { priority: 'medium', stage: 'idea' }),
        rawItem('WL-HIGH', { priority: 'high', stage: 'idea' }),
        rawItem('WL-CRIT', { priority: 'critical', stage: 'idea' }),
      ],
    });

    const items: WorkItem[] = await fetchItemsByStage('idea');

    // Priority-first: Critical → High → Medium buckets.
    expect(items.map(i => i.id)).toEqual(['WL-CRIT', 'WL-HIGH', 'WL-MED']);
    const byId = new Map(items.map(i => [i.id, i]));
    expect(byId.get('WL-CRIT')!.groupLabel).toBe('Critical');
    expect(byId.get('WL-CRIT')!.group).toBe(1);
    expect(byId.get('WL-HIGH')!.groupLabel).toBe('High');
    expect(byId.get('WL-HIGH')!.group).toBe(2);
    expect(byId.get('WL-MED')!.groupLabel).toBe('Medium');
    expect(byId.get('WL-MED')!.group).toBe(3);
  });

  it('sorts by stage workflow order then id within the same priority bucket', async () => {
    mockWlReturning({
      workItems: [
        rawItem('WL-B', { priority: 'high', stage: 'in_review' }),
        rawItem('WL-A', { priority: 'high', stage: 'idea' }),
        rawItem('WL-C', { priority: 'high', stage: 'done' }),
      ],
    });

    const items = await fetchItemsByStage('high');
    // idea → in_review → done within the High bucket.
    expect(items.map(i => i.id)).toEqual(['WL-A', 'WL-B', 'WL-C']);
  });
});

describe('fetchChildrenForItem — priority-first regroup (WL-0MSOPHLD1000EWNN)', () => {
  beforeEach(() => resetExecFileAsync());
  afterEach(() => resetExecFileAsync());

  it('regroups expanded children into priority-bucket order, preserving depth', async () => {
    mockWlReturning({
      workItems: [
        rawItem('WL-LOW', { priority: 'low', stage: 'idea', parentId: 'WL-PARENT' }),
        rawItem('WL-CRIT', { priority: 'critical', stage: 'plan_complete', parentId: 'WL-PARENT' }),
        rawItem('WL-HIGH', { priority: 'high', stage: 'in_progress', parentId: 'WL-PARENT' }),
      ],
    });

    const items = await fetchChildrenForItem('WL-PARENT');

    // Priority-first: Critical → High → Low.
    expect(items.map(i => i.id)).toEqual(['WL-CRIT', 'WL-HIGH', 'WL-LOW']);
    const byId = new Map(items.map(i => [i.id, i]));
    expect(byId.get('WL-CRIT')!.groupLabel).toBe('Critical');
    expect(byId.get('WL-HIGH')!.groupLabel).toBe('High');
    expect(byId.get('WL-LOW')!.groupLabel).toBe('Low');
    // Every child retains depth=1 for hierarchical display.
    for (const item of items) {
      expect(item.depth).toBe(1);
    }
  });
});
