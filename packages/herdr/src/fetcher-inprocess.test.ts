/**
 * packages/herdr/src/fetcher-inprocess.test.ts — In-process SQLite fast path
 * for the default-view auxiliary reads (WL-0MV5CBQ6L005SPAG).
 *
 * A cold default-view refresh used to spawn ~one `wl` process per query:
 * `wl next`, two mandatory subsets, the actionable count, the review-queue
 * state and one child fetch per expanded parent (≈25 spawns at 20 parents).
 * These tests pin the consolidated behaviour:
 *
 *   - `fetchActionableCount` counts in-process (no spawn).
 *   - `fetchChildrenForItems` reads all expanded parents' children in one
 *     in-process read (no `wl list --parent` spawn), preserving parentId,
 *     depth, childCount and deleted-item exclusion.
 *   - the default view is served by ONE consolidated `wl worklist` read
 *     (WL-0MVI0IT4S0070G78): the browse feed and the four mandatory subsets
 *     arrive together, and `fetchReviewQueueState` derives from that same
 *     read instead of spawning the review query a second time.
 *   - Any failure to read in-process falls back to the `wl` spawn path, and
 *     an audited child (stored fingerprint) falls back so the CLI's
 *     `currentFingerprint` enrichment is preserved.
 *   - A refresh-scoped connection (WL-0MV6C6SLB005HX7B) shares ONE
 *     `WorklogDatabase` open across the `fetchActionableCount` +
 *     `fetchChildrenForItems` reads of a refresh (open count drops 2 → 1),
 *     and the shared connection is closed when the refresh scope is
 *     released — never reused across a refresh boundary.
 *
 * Run: npx vitest run packages/herdr/src/fetcher-inprocess.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorklogDatabase } from '@worklog/shared';
import {
  fetchNextItems,
  fetchActionableCount,
  fetchReviewQueueState,
  fetchChildrenForItems,
  createInProcessRefreshScope,
  setExecFileAsync,
  resetExecFileAsync,
  setWorklogDir,
  resetWorklogDir,
} from './fetcher.js';

/**
 * Instrumented `@worklog/shared` for the open-count assertion (AC-3 of
 * WL-0MV6C6SLB005HX7B): every `WorklogDatabase` constructed (by seeding AND
 * by the in-process fast path) increments `opens`; every `close()` increments
 * `closed`. The mock is scoped to THIS test file only (vitest per-file module
 * registry), so other suites keep the real module. `vi.hoisted` makes the
 * counter visible to the hoisted mock factory and to the test bodies.
 */
const inProcessState = vi.hoisted(() => ({ opens: 0, closed: 0 }));

vi.mock('@worklog/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@worklog/shared')>();
  return {
    ...actual,
    WorklogDatabase: class extends actual.WorklogDatabase {
      constructor(...args: any[]) {
        super(...args);
        inProcessState.opens += 1;
      }
      close(): void {
        inProcessState.closed += 1;
        super.close();
      }
    },
  };
});

interface Seeded {
  rootDir: string;
  worklogDir: string;
  parentA: string;
  parentB: string;
  childA1: string;
  childA2: string;
  grandchild: string;
  actionable: number;
}

function seedWorklog(): Seeded {
  const rootDir = mkdtempSync(join(tmpdir(), 'herdr-fetcher-inproc-'));
  const worklogDir = join(rootDir, '.worklog');
  mkdirSync(worklogDir, { recursive: true });

  const db = new WorklogDatabase(
    'WL',
    join(worklogDir, 'worklog.db'),
    join(worklogDir, 'worklog-data.jsonl'),
    true,
    false,
  );

  let actionable = 0;
  const open = (title: string, extra: Record<string, unknown> = {}) => {
    actionable += 1;
    return db.create({ title, description: `${title} description`, ...extra });
  };

  open('Root one');
  open('Root two');
  open('Critical root', { priority: 'critical' });
  open('Blocked root', { status: 'blocked' });
  // Not actionable (completed) and not actionable (deleted).
  db.create({ title: 'Review root', status: 'completed', stage: 'in_review' });
  db.create({ title: 'Deleted root', status: 'deleted' });

  const parentA = open('Parent A');
  const parentB = open('Parent B');
  const childA1 = open('Child A.1', { parentId: parentA.id });
  const childA2 = open('Child A.2', { parentId: parentA.id });
  const grandchild = open('Grandchild A.1.a', { parentId: childA1.id });
  open('Child B.1', { parentId: parentB.id });
  db.create({ title: 'Deleted child A', parentId: parentA.id, status: 'deleted' });

  db.close();

  return {
    rootDir,
    worklogDir,
    parentA: parentA.id,
    parentB: parentB.id,
    childA1: childA1.id,
    childA2: childA2.id,
    grandchild: grandchild.id,
    actionable,
  };
}

/** Spawn-recorded `wl` invocations, reset per test. */
let spawns: string[];

/** Install a counting exec mock that answers the consolidated refresh path. */
function installExecMock(): void {
  spawns = [];
  setExecFileAsync((async (_bin: string, args: string[]) => {
    spawns.push(args.join(' '));
    if (args.includes('worklist')) {
      // The consolidated read (WL-0MVI0IT4S0070G78): one payload with every
      // subset the default view needs.
      return {
        stdout: JSON.stringify({
          success: true,
          worklogDir: seeded.worklogDir,
          requestedCount: 30,
          subsets: {
            critical: [],
            reviewQueue: [],
            inProgressRoots: [],
            blockedRoots: [],
            browse: [{ workItem: { id: 'WL-NEXT', title: 'Next', status: 'open' }, reason: 'next' }],
          },
        }),
        stderr: '',
      };
    }
    if (args.includes('next')) {
      return {
        stdout: JSON.stringify({
          success: true,
          count: 1,
          workItems: [{ id: 'WL-NEXT', title: 'Next', status: 'open' }],
        }),
        stderr: '',
      };
    }
    // Mandatory critical subset.
    if (args.includes('list') && args.includes('--priority')) {
      return { stdout: JSON.stringify({ success: true, count: 0, workItems: [] }), stderr: '' };
    }
    // Review queue / in_review subset.
    if (args.includes('list') && args.includes('--stage')) {
      return { stdout: JSON.stringify({ success: true, count: 0, workItems: [] }), stderr: '' };
    }
    // Actionable-count fallback query.
    if (args.includes('list')) {
      return { stdout: JSON.stringify({ success: true, count: 7, workItems: [] }), stderr: '' };
    }
    return { stdout: JSON.stringify({ success: true, count: 0, workItems: [] }), stderr: '' };
  }) as never);
}

let seeded: Seeded;

beforeEach(() => {
  seeded = seedWorklog();
  installExecMock();
  // Clear the instrumented counter AFTER seeding: the AC-3 open-count
  // assertion must measure only the fetcher's own in-process opens.
  inProcessState.opens = 0;
  inProcessState.closed = 0;
});

afterEach(() => {
  resetExecFileAsync();
  resetWorklogDir();
  rmSync(seeded.rootDir, { recursive: true, force: true });
});

describe('in-process default-view reads (WL-0MV5CBQ6L005SPAG)', () => {
  it('counts actionable items in-process without spawning wl', async () => {
    setWorklogDir(seeded.worklogDir);
    const count = await fetchActionableCount();
    expect(count).toBe(seeded.actionable);
    expect(spawns).toEqual([]);
  });

  it('fetches all expanded parents\u2019 children in one in-process read', async () => {
    setWorklogDir(seeded.worklogDir);
    const depthByParent = new Map([
      [seeded.parentA, 2],
      [seeded.parentB, 2],
    ]);

    const children = await fetchChildrenForItems([seeded.parentA, seeded.parentB], depthByParent);

    // No `wl list --parent` spawns.
    expect(spawns).toEqual([]);

    const a = children.get(seeded.parentA) ?? [];
    const b = children.get(seeded.parentB) ?? [];
    // Deleted child A is excluded, matching `wl list --parent`.
    expect(a.map((i) => i.id).sort()).toEqual([seeded.childA1, seeded.childA2].sort());
    expect(b).toHaveLength(1);
    // parentId + depth preserved, and childCount reflects the child's OWN
    // children (child A.1 has a grandchild) — the CLI `childCount` enrichment.
    const a1 = a.find((i) => i.id === seeded.childA1);
    expect(a1?.parentId).toBe(seeded.parentA);
    expect(a1?.depth).toBe(2);
    expect(a1?.childCount).toBe(1);
    expect(a.find((i) => i.id === seeded.childA2)?.depth).toBe(2);
  });

  it('serves the whole default view from ONE consolidated worklist read', async () => {
    setWorklogDir(seeded.worklogDir);

    const [items, children, review, actionable] = await Promise.all([
      fetchNextItems(30),
      fetchChildrenForItems([seeded.parentA]),
      fetchReviewQueueState(),
      fetchActionableCount(),
    ]);

    expect(items.map((i) => i.id)).toContain('WL-NEXT');
    expect(children.get(seeded.parentA)).toHaveLength(2);
    expect(review).toEqual({ count: 0, auditsOutstanding: false });
    expect(actionable).toBe(seeded.actionable);

    // ONE `wl worklist` spawn replaces `wl next` + the four mandatory-subset
    // `wl list` queries (critical, in_review review queue, actively-worked
    // in-progress, status=blocked roots — WL-0MV6KV22S004NYIU /
    // WL-0MV71WBHB007D8ZE). The review-queue banner state and the count /
    // children reads add no spawn: the banner derives from the same bundle
    // (in flight or freshly settled) and the rest are in-process.
    expect(spawns).toHaveLength(1);
    const commandTokens = spawns.flatMap((s) => s.split(' '));
    expect(commandTokens).toContain('worklist');
    expect(commandTokens).not.toContain('next');
    expect(commandTokens).not.toContain('list');
    expect(spawns.some((s) => s.includes('--parent'))).toBe(false);
  });

  it('falls back to spawning wl when no worklog dir is resolved', async () => {
    resetWorklogDir();
    const count = await fetchActionableCount();
    expect(count).toBe(7);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toContain('list');
  });

  it('falls back to wl for an audited child so currentFingerprint enrichment is preserved', async () => {
    const db = new WorklogDatabase(
      'WL',
      join(seeded.worklogDir, 'worklog.db'),
      join(seeded.worklogDir, 'worklog-data.jsonl'),
      true,
      false,
    );
    db.importAuditResults([
      {
        workItemId: seeded.childA1,
        readyToClose: true,
        auditedAt: '2026-10-01T00:00:00.000Z',
        summary: null,
        rawOutput: null,
        author: 'audit',
        fingerprint: 'fp-stored',
      },
    ]);
    db.close();

    // Re-install the mock to answer the `--parent` fallback with the child.
    spawns = [];
    setExecFileAsync((async (_bin: string, args: string[]) => {
      spawns.push(args.join(' '));
      if (args.includes('list') && args.includes('--parent')) {
        return {
          stdout: JSON.stringify({
            success: true,
            count: 1,
            workItems: [
              {
                id: seeded.childA1,
                title: 'Child A.1',
                status: 'open',
                parentId: seeded.parentA,
                auditedAt: '2026-10-01T00:00:00.000Z',
                auditResult: true,
                fingerprint: 'fp-stored',
                currentFingerprint: 'fp-stored',
              },
            ],
          }),
          stderr: '',
        };
      }
      return { stdout: JSON.stringify({ success: true, count: 0, workItems: [] }), stderr: '' };
    }) as never);

    setWorklogDir(seeded.worklogDir);
    const children = await fetchChildrenForItems([seeded.parentA]);

    expect(spawns.some((s) => s.includes('--parent'))).toBe(true);
    const a1 = (children.get(seeded.parentA) ?? []).find((i) => i.id === seeded.childA1);
    // The CLI-enriched currentFingerprint is preserved on the fallback path.
    expect(a1?.currentFingerprint).toBe('fp-stored');
  });
});

describe('refresh-scoped shared in-process connection (WL-0MV6C6SLB005HX7B)', () => {
  it('opens exactly ONE in-process connection for a refresh sharing children + actionable reads (AC3)', async () => {
    setWorklogDir(seeded.worklogDir);
    const depthByParent = new Map([
      [seeded.parentA, 2],
      [seeded.parentB, 2],
    ]);

    // A refresh cycle exercising BOTH in-process readers through the shared
    // scope must open the connection once (was twice: one per helper).
    const scope = createInProcessRefreshScope();
    try {
      const children = await fetchChildrenForItems(
        [seeded.parentA, seeded.parentB],
        depthByParent,
        scope,
      );
      const actionable = await fetchActionableCount(scope);

      expect(actionable).toBe(seeded.actionable);
      expect(children.get(seeded.parentA)).toHaveLength(2);
      expect(children.get(seeded.parentB)).toHaveLength(1);
      expect(inProcessState.opens).toBe(1);
      // Both reads served in-process — no `wl` spawns on the shared fast path.
      expect(spawns).toEqual([]);
    } finally {
      scope.close();
    }

    // Releasing the scope closes the shared connection: never reused across
    // a refresh boundary (no-stale-cache invariant, WL-0MV5CBQ6L005SPAG).
    expect(inProcessState.closed).toBe(1);

    // A scope-less caller still opens a FRESH connection (unchanged behaviour
    // for non-refresh callers).
    const again = await fetchActionableCount();
    expect(again).toBe(seeded.actionable);
    expect(inProcessState.opens).toBe(2);
  });

  it('defers the shared-connection close until a fire-and-forget read settles', async () => {
    setWorklogDir(seeded.worklogDir);

    const scope = createInProcessRefreshScope();
    const children = await fetchChildrenForItems([seeded.parentA], undefined, scope);
    expect(children.get(seeded.parentA)).toHaveLength(2);

    // doRefresh runs the actionable-count read FIRE-AND-FORGET, so close()
    // can be requested while that read is still pending. The pending read
    // must still run against the OPEN shared connection, and the release is
    // deferred until it settles (the scope must never reopen for it).
    const pending = fetchActionableCount(scope);
    scope.close();

    expect(await pending).toBe(seeded.actionable);
    expect(inProcessState.opens).toBe(1);
    expect(inProcessState.closed).toBe(1);
  });
});
