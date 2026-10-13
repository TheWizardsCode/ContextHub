/**
 * packages/herdr/src/fetcher-include-blocked.test.ts — Herdr selection list
 * must not filter dependency-blocked items (WL-0MV6TFX0600145M2).
 *
 * `wl next` excludes dependency-blocked items by default (the shared
 * `filterCandidates` pipeline removes them unless `includeBlocked` is set).
 * The Herdr worklist selection list is populated by `fetchNextItems`, so it
 * must pass `--include-blocked` to `wl next` or blocked work silently
 * disappears from the list. The implement-tier candidate lookup
 * (`getNextImplementCandidate` in index.ts) is a SEPARATE fetch path and
 * deliberately keeps the default exclusion (pinned by
 * implement-tier-blocked-exclusion.test.ts) — this change must not touch it.
 *
 * Run: npx vitest run packages/herdr/src/fetcher-include-blocked.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  fetchNextItems,
  setExecFileAsync,
  resetExecFileAsync,
  resetWorklogDir,
} from './fetcher.js';

/** Spawn-recorded `wl` invocations, reset per test. */
let spawns: string[];

/**
 * Install a recording exec mock: `wl next` returns an open item plus a
 * dependency-blocked item (with dependency still open, as reported by the
 * real CLI when `--include-blocked` is used); the mandatory subsets are empty.
 */
function installExecMock(): void {
  spawns = [];
  setExecFileAsync((async (_bin: string, args: string[]) => {
    spawns.push(args.join(' '));
    if (args.includes('next')) {
      return {
        stdout: JSON.stringify({
          success: true,
          count: 2,
          results: [
            { workItem: { id: 'WL-OPEN', title: 'Open item', status: 'open', stage: 'idea' } },
            {
              workItem: {
                id: 'WL-BLOCKED',
                title: 'Dependency-blocked item',
                status: 'blocked',
                stage: 'idea',
              },
            },
          ],
        }),
        stderr: '',
      };
    }
    // Mandatory critical / review / actively-worked / blocked subsets — all empty.
    return { stdout: JSON.stringify({ success: true, count: 0, workItems: [] }), stderr: '' };
  }) as never);
}

/**
 * Install a recording exec mock for the low-ranked-blocked regression
 * (WL-0MV71WBHB007D8ZE): the base `wl next -n` feed does NOT include the
 * blocked item (it ranks below the window, like WL-0MTF5WO1N0088P5P at ~35
 * of 52), but the mandatory blocked subset query returns it — so the item
 * can only appear via the explicit `--status blocked` subset fetch.
 */
function installLowRankedBlockedMock(): void {
  spawns = [];
  setExecFileAsync((async (_bin: string, args: string[]) => {
    spawns.push(args.join(' '));
    if (args.includes('next')) {
      return {
        stdout: JSON.stringify({
          success: true,
          count: 2,
          results: [
            { workItem: { id: 'WL-OPEN', title: 'Open item', status: 'open', stage: 'idea' } },
            { workItem: { id: 'WL-OTHER', title: 'Other item', status: 'open', stage: 'idea' } },
          ],
        }),
        stderr: '',
      };
    }
    if (args.includes('--status') && args.includes('blocked')) {
      return {
        stdout: JSON.stringify({
          success: true,
          count: 1,
          workItems: [
            {
              id: 'WL-LOWRANK-BLOCKED',
              title: 'Low-ranked blocked review item',
              status: 'blocked',
              stage: 'in_review',
            },
          ],
        }),
        stderr: '',
      };
    }
    // Mandatory critical / review / actively-worked subsets — all empty.
    return { stdout: JSON.stringify({ success: true, count: 0, workItems: [] }), stderr: '' };
  }) as never);
}

beforeEach(() => {
  resetExecFileAsync();
  resetWorklogDir();
  installExecMock();
});

afterEach(() => {
  resetExecFileAsync();
  resetWorklogDir();
});

describe('fetchNextItems includes dependency-blocked items (WL-0MV6TFX0600145M2)', () => {
  it('passes --include-blocked to wl next', async () => {
    await fetchNextItems(10);

    const nextSpawns = spawns.filter((s) => s.startsWith('next') || s.includes(' next '));
    expect(nextSpawns.length).toBe(1);
    expect(nextSpawns[0]).toContain('--include-blocked');
    expect(nextSpawns[0]).toContain('--include-in-progress');
    expect(nextSpawns[0]).toContain('-n 10');
  });

  it('keeps a wl-next dependency-blocked item in the smart-selected list', async () => {
    const items = await fetchNextItems(10);

    const blocked = items.find((i) => i.id === 'WL-BLOCKED');
    expect(blocked).toBeDefined();
    expect(blocked?.status).toBe('blocked');
    expect(items.map((i) => i.id)).toContain('WL-OPEN');
  });

  it('does not add --include-blocked to the mandatory-subset wl list queries', async () => {
    await fetchNextItems(10);

    const listSpawns = spawns.filter((s) => s.startsWith('list') || s.includes(' list '));
    expect(listSpawns.length).toBeGreaterThan(0);
    for (const spawn of listSpawns) {
      expect(spawn).not.toContain('--include-blocked');
    }
  });
});

describe('fetchNextItems shows a low-ranked blocked item via the mandatory subset (WL-0MV71WBHB007D8ZE)', () => {
  it('fetches status=blocked root items as a mandatory subset', async () => {
    installLowRankedBlockedMock();

    await fetchNextItems(20);

    const blockedSpawn = spawns.find((s) => s.includes('--status blocked'));
    expect(blockedSpawn).toBeDefined();
    expect(blockedSpawn).toContain('--root-only');
  });

  it('keeps a blocked item that the base wl-next window never returned', async () => {
    installLowRankedBlockedMock();

    const items = await fetchNextItems(20);

    // The base feed only carried WL-OPEN/WL-OTHER; the blocked item arrives
    // solely through the mandatory `--status blocked` subset and must be
    // shown (it is release-blocking and must not be hidden by the -n window).
    expect(items.map((i) => i.id)).toContain('WL-LOWRANK-BLOCKED');
    const blocked = items.find((i) => i.id === 'WL-LOWRANK-BLOCKED');
    expect(blocked?.status).toBe('blocked');
    expect(blocked?.stage).toBe('in_review');
  });
});
