/**
 * packages/herdr/src/fetcher-blockers.test.ts — Active dependency blockers
 * for the Herdr metadata panel (WL-0MV8EZRDJ001TDA8).
 *
 * `fetchBlockersForItem(id)` runs `wl dep list <id> --json`, keeps only the
 * outbound `depends-on` edges that still block via the shared
 * `isActiveBlocker` predicate (`completed`/`deleted` status, or stage
 * `in_review`/`done`), and returns `{ id, title, status? }` rows — the
 * edge's `status` is passed through so the metadata panel can render it
 * (WL-0MVBMLY2Z0032CYR). It is fail-open: a failed/unparseable lookup
 * yields `[]` and never throws.
 *
 * Stages are not part of a `wl dep list` edge, so each non-terminal edge is
 * enriched via `wl show` before classification (mirroring the hydrator's
 * `listOutboundDeps`).
 *
 * Run: npx vitest run packages/herdr/src/fetcher-blockers.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  fetchBlockersForItem,
  setExecFileAsync,
  resetExecFileAsync,
  resetWorklogDir,
} from './fetcher.js';
import { isActiveBlocker } from './fetcher.blockers.js';

/** Spawn-recorded `wl` invocations, reset per test. */
let spawns: string[];

/**
 * Install an exec mock: `wl dep list <id> --json` returns the supplied
 * outbound edges; `wl show <id> --json` returns the supplied stage for that
 * id (or an empty workItem when the id is not in `stages`).
 */
function installExecMock(
  outbound: unknown[],
  stages: Record<string, string> = {},
): void {
  spawns = [];
  setExecFileAsync((async (_bin: string, args: string[]) => {
    spawns.push(args.join(' '));
    if (args.includes('dep')) {
      return {
        stdout: JSON.stringify({ success: true, item: 'WL-X', inbound: [], outbound }),
        stderr: '',
      };
    }
    if (args.includes('show')) {
      const id = args[1];
      const stage = stages[id];
      return {
        stdout: JSON.stringify(
          stage !== undefined
            ? { success: true, workItem: { id, title: `Item ${id}`, stage } }
            : { success: true, count: 0, workItems: [] },
        ),
        stderr: '',
      };
    }
    return { stdout: JSON.stringify({ success: true }), stderr: '' };
  }) as never);
}

beforeEach(() => {
  resetExecFileAsync();
  resetWorklogDir();
});

afterEach(() => {
  resetExecFileAsync();
  resetWorklogDir();
});

describe('fetchBlockersForItem — active blockers (WL-0MV8EZRDJ001TDA8)', () => {
  it('returns one { id, title, status } per active outbound depends-on edge', async () => {
    installExecMock([
      { id: 'WL-B1', title: 'First blocker', status: 'open', direction: 'depends-on' },
      { id: 'WL-B2', title: 'Second blocker', status: 'in-progress', direction: 'depends-on' },
    ]);

    const blockers = await fetchBlockersForItem('WL-X');

    expect(blockers).toEqual([
      { id: 'WL-B1', title: 'First blocker', status: 'open' },
      { id: 'WL-B2', title: 'Second blocker', status: 'in-progress' },
    ]);
  });

  it('passes the edge status through to the blocker ref (no extra lookups)', async () => {
    installExecMock([
      { id: 'WL-B1', title: 'First blocker', status: 'blocked', direction: 'depends-on' },
    ]);

    const blockers = await fetchBlockersForItem('WL-X');

    expect(blockers).toEqual([{ id: 'WL-B1', title: 'First blocker', status: 'blocked' }]);
    // The stage enrichment still ran (one wl show), but the status came from
    // the `dep list` edge itself — no per-blocker `wl show` for status.
    const depSpawns = spawns.filter((s) => s.startsWith('dep list'));
    expect(depSpawns).toHaveLength(1);
  });

  it('omits the status field when the edge carries none', async () => {
    installExecMock([
      { id: 'WL-B1', title: 'No status ref', direction: 'depends-on' },
    ]);

    const blockers = await fetchBlockersForItem('WL-X');

    expect(blockers).toEqual([{ id: 'WL-B1', title: 'No status ref' }]);
  });

  it('queries wl dep list for the requested item', async () => {
    installExecMock([
      { id: 'WL-B1', title: 'First blocker', status: 'open', direction: 'depends-on' },
    ]);

    await fetchBlockersForItem('WL-X');

    expect(spawns.some((s) => s.startsWith('dep list WL-X'))).toBe(true);
  });

  it('filters out terminal-by-status edges (completed, deleted)', async () => {
    installExecMock([
      { id: 'WL-DONE', title: 'Done', status: 'completed', direction: 'depends-on' },
      { id: 'WL-DEL', title: 'Deleted', status: 'deleted', direction: 'depends-on' },
      { id: 'WL-OPEN', title: 'Still blocking', status: 'blocked', direction: 'depends-on' },
    ]);

    const blockers = await fetchBlockersForItem('WL-X');

    expect(blockers).toEqual([{ id: 'WL-OPEN', title: 'Still blocking', status: 'blocked' }]);
  });

  it('filters out non-terminal edges whose target is at a terminal stage', async () => {
    installExecMock(
      [
        { id: 'WL-REVIEW', title: 'In review', status: 'in-progress', direction: 'depends-on' },
        { id: 'WL-DONESTAGE', title: 'Done stage', status: 'open', direction: 'depends-on' },
        { id: 'WL-ACTIVE', title: 'Active', status: 'in-progress', direction: 'depends-on' },
      ],
      { 'WL-REVIEW': 'in_review', 'WL-DONESTAGE': 'done', 'WL-ACTIVE': 'plan_complete' },
    );

    const blockers = await fetchBlockersForItem('WL-X');

    expect(blockers).toEqual([{ id: 'WL-ACTIVE', title: 'Active', status: 'in-progress' }]);
  });

  it('ignores inbound (depended-on-by) edges', async () => {
    installExecMock([
      { id: 'WL-UPSTREAM', title: 'Depends on us', status: 'open', direction: 'depended-on-by' },
      { id: 'WL-DOWN', title: 'Blocks us', status: 'open', direction: 'depends-on' },
    ]);

    const blockers = await fetchBlockersForItem('WL-X');

    expect(blockers).toEqual([{ id: 'WL-DOWN', title: 'Blocks us', status: 'open' }]);
  });

  it('returns an empty array when there are no outbound edges', async () => {
    installExecMock([]);

    await expect(fetchBlockersForItem('WL-X')).resolves.toEqual([]);
  });
});

describe('isActiveBlocker — the ONE pin predicate (WL-0MW7YJYS5009H7WC AC7)', () => {
  // The blocker-pin pass (selection child WL-0MWDOL9J4008K3YR) filters
  // through the SAME shared predicate as the metadata panel's `Blocked By`
  // rows, so the pinned set can never disagree with what the panel renders.
  // This pins every terminal case:
  //   - status `completed` / `deleted` → not an active blocker;
  //   - stage `in_review` / `done` → not an active blocker (whatever the
  //     status);
  //   - anything else (open / in-progress / blocked at an actionable stage)
  //     → still an active blocker and therefore a pin candidate.

  it('never pins a target whose status is completed or deleted', () => {
    expect(isActiveBlocker({ id: 'WL-X', status: 'completed', stage: 'done' })).toBe(false);
    expect(isActiveBlocker({ id: 'WL-X', status: 'deleted', stage: 'intake_complete' })).toBe(false);
    expect(isActiveBlocker({ id: 'WL-X', status: 'completed' })).toBe(false);
    expect(isActiveBlocker({ id: 'WL-X', status: 'deleted' })).toBe(false);
  });

  it('never pins a target at a terminal stage (in_review or done)', () => {
    expect(isActiveBlocker({ id: 'WL-X', status: 'open', stage: 'in_review' })).toBe(false);
    expect(isActiveBlocker({ id: 'WL-X', status: 'in-progress', stage: 'in_review' })).toBe(false);
    expect(isActiveBlocker({ id: 'WL-X', status: 'blocked', stage: 'in_review' })).toBe(false);
    expect(isActiveBlocker({ id: 'WL-X', status: 'open', stage: 'done' })).toBe(false);
    expect(isActiveBlocker({ id: 'WL-X', status: 'in-progress', stage: 'done' })).toBe(false);
  });

  it('keeps an open / in-progress / blocked target at an actionable stage pinable', () => {
    expect(isActiveBlocker({ id: 'WL-X', status: 'open', stage: 'idea' })).toBe(true);
    expect(isActiveBlocker({ id: 'WL-X', status: 'open', stage: 'intake_complete' })).toBe(true);
    expect(isActiveBlocker({ id: 'WL-X', status: 'in-progress', stage: 'plan_complete' })).toBe(true);
    expect(isActiveBlocker({ id: 'WL-X', status: 'blocked', stage: 'idea' })).toBe(true);
    // A status-only edge (no stage known from `wl dep list`) stays pinable.
    expect(isActiveBlocker({ id: 'WL-X', status: 'open' })).toBe(true);
  });
});

describe('fetchBlockersForItem — fail-open (WL-0MV8EZRDJ001TDA8)', () => {
  it('returns [] when wl dep list rejects', async () => {
    setExecFileAsync((async () => {
      throw new Error('wl exploded');
    }) as never);

    await expect(fetchBlockersForItem('WL-X')).resolves.toEqual([]);
  });

  it('returns [] when wl dep list output is unparseable', async () => {
    setExecFileAsync((async () => ({ stdout: 'not json at all', stderr: '' })) as never);

    await expect(fetchBlockersForItem('WL-X')).resolves.toEqual([]);
  });

  it('returns [] when the payload has no outbound array', async () => {
    setExecFileAsync((async () => ({
      stdout: JSON.stringify({ success: true, inbound: [] }),
      stderr: '',
    })) as never);

    await expect(fetchBlockersForItem('WL-X')).resolves.toEqual([]);
  });
});
