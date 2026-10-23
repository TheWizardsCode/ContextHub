/**
 * Tests for the shared seeded-worklog fixture (WL-0MVI0HH740065Z2T).
 *
 * The consolidated `wl worklist` read (WL-0MVI0HX58009JJRF) and the fetcher
 * swap (WL-0MVI0IT4S0070G78) must expose a specific subset mix: a critical
 * root, a child under a root (so `--root-only` is provably exercised), a
 * completed/in_review root, an in-progress/in_review root, a blocked root, an
 * open non-critical root and an item carrying a stored audit result. The
 * fixture seeds that mix once, for every later slice.
 *
 * These assertions read the fixture back through the real CLI, so they prove
 * the seed is a usable worklog — not just an in-memory list.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  cliPath,
  execAsync,
  enterTempDir,
  leaveTempDir,
  seedWorklistFixture,
  type WorklistFixture,
} from './cli-helpers.js';

interface ListedItem {
  id: string;
  status: string;
  priority: string;
  stage: string;
  parentId: string | null;
  auditResult?: boolean | null;
  auditedAt?: string | null;
}

async function list(args: string): Promise<ListedItem[]> {
  const { stdout } = await execAsync(`tsx ${cliPath} --json ${args}`);
  return JSON.parse(stdout).workItems as ListedItem[];
}

describe('seedWorklistFixture', () => {
  let tempState: { tempDir: string; originalCwd: string };
  let fixture: WorklistFixture;

  beforeEach(() => {
    tempState = enterTempDir();
    fixture = seedWorklistFixture(tempState.tempDir, { prefix: 'FIX', projectName: 'Fixture Test' });
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  it('seeds the consolidated-read subset mix (verified by assertions on the seeded data)', () => {
    const { items, ids } = fixture;

    expect(items).toHaveLength(6);

    const byId = new Map(items.map((item) => [item.id, item]));

    // ≥1 critical root, status open.
    const critical = items.filter((item) => item.priority === 'critical');
    expect(critical).toHaveLength(1);
    expect(byId.get(ids.criticalRoot)?.priority).toBe('critical');
    expect(byId.get(ids.criticalRoot)?.status).toBe('open');
    expect(byId.get(ids.criticalRoot)?.parentId).toBeNull();

    // ≥1 child of that root (exercises --root-only filtering).
    const children = items.filter((item) => item.parentId !== null);
    expect(children).toHaveLength(1);
    expect(children[0].id).toBe(ids.criticalChild);
    expect(children[0].parentId).toBe(ids.criticalRoot);

    // ≥1 completed/in_review (the producer-review queue) …
    expect(byId.get(ids.reviewCompleted)?.status).toBe('completed');
    expect(byId.get(ids.reviewCompleted)?.stage).toBe('in_review');
    // … and ≥1 in-progress/in_review (re-worked after review feedback).
    expect(byId.get(ids.reviewInProgress)?.status).toBe('in-progress');
    expect(byId.get(ids.reviewInProgress)?.stage).toBe('in_review');
    expect(items.filter((item) => item.stage === 'in_review' && item.parentId === null)).toHaveLength(2);

    // ≥1 blocked root.
    const blockedRoots = items.filter((item) => item.status === 'blocked' && item.parentId === null);
    expect(blockedRoots.map((item) => item.id)).toEqual([ids.blockedRoot]);

    // ≥1 open non-critical root.
    expect(byId.get(ids.openNonCritical)?.status).toBe('open');
    expect(byId.get(ids.openNonCritical)?.priority).not.toBe('critical');
    expect(items.filter((item) => item.status === 'open' && item.priority !== 'critical' && item.parentId === null)).toHaveLength(1);
  });

  it('produces a worklog the CLI can read, with a root-only filter that excludes the child', async () => {
    const all = await list('list --status open,in-progress,blocked,completed');
    expect(all.map((item) => item.id).sort()).toEqual(fixture.items.map((item) => item.id).sort());

    const roots = await list('list --status open,in-progress,blocked,completed --root-only');
    expect(roots).toHaveLength(5);
    expect(roots.map((item) => item.id)).toContain(fixture.ids.criticalRoot);
    expect(roots.map((item) => item.id)).not.toContain(fixture.ids.criticalChild);

    const blockedRoots = await list('list --status blocked --root-only');
    expect(blockedRoots.map((item) => item.id)).toEqual([fixture.ids.blockedRoot]);
  });

  it('stores an audit result on the seeded review item', async () => {
    const reviewQueue = await list('list --status completed --stage in_review --root-only');
    const audited = reviewQueue.find((item) => item.id === fixture.ids.audited);

    expect(audited).toBeDefined();
    expect(audited?.auditResult).toBe(true);
    expect(typeof audited?.auditedAt).toBe('string');
    expect((audited?.auditedAt ?? '').length).toBeGreaterThan(0);
  });
});
