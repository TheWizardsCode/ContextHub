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
 *   - `fetchReviewQueueState` reuses the identical query already issued by
 *     `fetchMandatorySubsets` (one spawn, not two).
 *   - Any failure to read in-process falls back to the `wl` spawn path, and
 *     an audited child (stored fingerprint) falls back so the CLI's
 *     `currentFingerprint` enrichment is preserved.
 *
 * Run: npx vitest run packages/herdr/src/fetcher-inprocess.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorklogDatabase } from '@worklog/shared';
import {
  fetchNextItems,
  fetchActionableCount,
  fetchReviewQueueState,
  fetchChildrenForItems,
  setExecFileAsync,
  resetExecFileAsync,
  setWorklogDir,
  resetWorklogDir,
} from './fetcher.js';

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

  it('deduplicates the review-queue query into a single spawn across a consolidated refresh', async () => {
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

    // Only `wl next` + the four mandatory-subset `wl list` queries spawn
    // (critical, in_review review queue, actively-worked in-progress, and
    // status=blocked root items — WL-0MV6KV22S004NYIU / WL-0MV71WBHB007D8ZE);
    // the review query is shared with the banner and the count/children reads
    // are in-process. Exactly one query carries `--stage` (the review subset;
    // the critical, active and blocked subsets are stage-agnostic).
    expect(spawns).toHaveLength(5);
    expect(spawns.some((s) => s.includes('next'))).toBe(true);
    expect(spawns.some((s) => s.includes('--priority') && s.includes('critical'))).toBe(true);
    expect(spawns.filter((s) => s.includes('--stage')).length).toBe(1);
    expect(spawns.some((s) => s.includes('--parent'))).toBe(false);
    // The actively-worked in-progress subset is fetched explicitly.
    expect(spawns.some((s) => s.includes('--status') && s.includes('in-progress'))).toBe(true);
    // The blocked subset is fetched explicitly so a low-ranked blocked item
    // is never cut by the -n window (WL-0MV71WBHB007D8ZE).
    expect(spawns.some((s) => s.includes('--status') && s.includes('blocked'))).toBe(true);
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
