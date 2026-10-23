/**
 * packages/herdr/src/fetcher-worklist-bundle.test.ts — consolidated default-view
 * read (WL-0MVI0IT4S0070G78, parent WL-0MVGYLU0S004WZUS).
 *
 * The default-view refresh used to spawn five `wl` processes per tick (four
 * mandatory `wl list` subsets + the `wl next` browse feed). It now issues ONE
 * `wl worklist --json` read that returns all five subsets, with:
 *
 *   - the mandatory guarantees preserved (critical / review queue /
 *     in-progress roots / blocked roots always shown, whatever the count);
 *   - the review-queue banner state derived from the same read (no second
 *     spawn);
 *   - the richer `wl list` audit fields winning for shared items
 *     (WL-0MUWDW0N6003KF6G);
 *   - output identical to the per-subset path for the same DB state;
 *   - fail-open fallback to the per-subset spawns when the consolidated read
 *     is unavailable (older `wl`, non-zero exit, malformed payload).
 *
 * Run: npx vitest run packages/herdr/src/fetcher-worklist-bundle.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  fetchNextItems,
  fetchReviewQueueState,
  claimWorkItem,
  clearFetchMemo,
  setExecFileAsync,
  resetExecFileAsync,
  setWorklogDir,
  resetWorklogDir,
  type WorkItem,
} from './fetcher.js';

interface Call {
  binary: string;
  args: string[];
}

/** Install a mock `execFileAsync` that records every spawn and dispatches by argv. */
function mockWl(respond: (args: string[]) => unknown): Call[] {
  const calls: Call[] = [];
  setExecFileAsync((async (binary: string, args: string[]) => {
    calls.push({ binary, args });
    const payload = respond(args);
    if (payload instanceof Error) throw payload;
    return { stdout: JSON.stringify(payload), stderr: '' };
  }) as never);
  return calls;
}

const now = '2026-10-27T10:00:00.000Z';

function item(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `Item ${id}`,
    status: 'open',
    priority: 'medium',
    stage: 'idea',
    parentId: null,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

function entry(workItem: Record<string, unknown>, reason = 'selected'): Record<string, unknown> {
  return { workItem, reason };
}

/**
 * A representative DB state:
 *   N-CRIT   critical open root          (browse + critical subset)
 *   N-REVIEW completed/in_review root    (browse + review subset, richer audit in the subset)
 *   N-ACTIVE in-progress root            (browse + review + in-progress subsets)
 *   N-BLOCK  blocked root                (browse + blocked subset)
 *   N-OTHER  open medium root            (browse only)
 *   N-CHILD  open child of N-OTHER       (browse only; must be filtered by root-only)
 */
const browseItems = {
  crit: item('N-CRIT', { priority: 'critical' }),
  review: item('N-REVIEW', {
    status: 'completed',
    stage: 'in_review',
    priority: 'high',
    auditResult: null,
    auditedAt: null,
  }),
  active: item('N-ACTIVE', { status: 'in-progress', stage: 'plan_complete', priority: 'high' }),
  blocked: item('N-BLOCK', { status: 'blocked', priority: 'high' }),
  other: item('N-OTHER', { priority: 'low' }),
  child: item('N-CHILD', { priority: 'low', parentId: 'N-OTHER' }),
};

/** The richer `wl list` representation of the shared review item. */
const reviewRich = {
  ...browseItems.review,
  auditResult: true,
  // A freshly recorded audit: auditedAt == updatedAt (atomic audit write), so
  // `isAuditFresh` reports the item as audited regardless of the fingerprint
  // gate.
  auditedAt: now,
  fingerprint: 'fp-match',
  currentFingerprint: 'fp-match',
  childCount: 0,
};

function worklistPayload(browseLimit?: number): Record<string, unknown> {
  const browse = [
    entry(browseItems.crit, 'critical'),
    entry(browseItems.review, 'in review'),
    entry(browseItems.active, 'active'),
    entry(browseItems.blocked, 'blocked'),
    entry(browseItems.other, 'browse'),
    entry(browseItems.child, 'browse child'),
  ];
  return {
    success: true,
    worklogDir: '/tmp/worklog/.worklog',
    requestedCount: 20,
    subsets: {
      critical: [browseItems.crit],
      reviewQueue: [reviewRich, browseItems.active],
      inProgressRoots: [browseItems.active],
      blockedRoots: [browseItems.blocked],
      browse: browseLimit === undefined ? browse : browse.slice(0, browseLimit),
    },
  };
}

/** The `-n <count>` requested by a worklist invocation (default: the CLI's 20). */
function requestedBrowseCount(args: string[]): number {
  const index = args.indexOf('-n');
  if (index < 0) return 20;
  const parsed = parseInt(args[index + 1] ?? '', 10);
  return Number.isNaN(parsed) ? 20 : parsed;
}

/** The per-subset (legacy) responses for the same DB state. */
function legacyRespond(args: string[]): unknown {
  const command = args[0];
  if (command === 'next') {
    const browse = (worklistPayload().subsets as any).browse as unknown[];
    const limit = requestedBrowseCount(args);
    return { success: true, count: Math.min(limit, browse.length), results: browse.slice(0, limit) };
  }
  if (command === 'list') {
    const joined = args.join(' ');
    if (joined.includes('--priority critical')) {
      return { success: true, count: 1, workItems: [browseItems.crit] };
    }
    if (joined.includes('--stage in_review')) {
      return { success: true, count: 2, workItems: [reviewRich, browseItems.active] };
    }
    if (joined.includes('--status in-progress')) {
      return { success: true, count: 1, workItems: [browseItems.active] };
    }
    if (joined.includes('--status blocked')) {
      return { success: true, count: 1, workItems: [browseItems.blocked] };
    }
  }
  throw new Error(`unexpected wl invocation: ${args.join(' ')}`);
}

function ids(items: WorkItem[]): string[] {
  return items.map((i) => i.id);
}

beforeEach(() => {
  resetExecFileAsync();
  clearFetchMemo();
});

afterEach(() => {
  resetExecFileAsync();
  resetWorklogDir();
  clearFetchMemo();
});

describe('fetchNextItems: consolidated worklist read', () => {
  it('issues exactly one wl spawn (worklist) for a default-view refresh', async () => {
    const calls = mockWl((args) => worklistPayload(requestedBrowseCount(args)));

    const items = await fetchNextItems(20);

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain('worklist');
    expect(calls[0].args).toContain('-n');
    expect(calls[0].args).toContain('20');
    // No per-subset spawns on the bundle path.
    expect(calls.some((c) => c.args.includes('next') || c.args.includes('list'))).toBe(false);
    expect(items.length).toBeGreaterThan(0);
  });

  it('always includes the mandatory subsets, regardless of the browse window', async () => {
    mockWl((args) => worklistPayload(requestedBrowseCount(args)));

    const items = await fetchNextItems(1);
    const shown = ids(items);

    // Mandatory: critical, completed/in_review, in-progress root, blocked root.
    expect(shown).toContain('N-CRIT');
    expect(shown).toContain('N-REVIEW');
    expect(shown).toContain('N-ACTIVE');
    expect(shown).toContain('N-BLOCK');
    // The count window only limits "other" items.
    expect(shown).not.toContain('N-OTHER');
  });

  it('prefers the richer wl list audit fields for items shared with a mandatory subset', async () => {
    mockWl((args) => worklistPayload(requestedBrowseCount(args)));

    const items = await fetchNextItems(20);
    const review = items.find((i) => i.id === 'N-REVIEW');

    expect(review).toBeDefined();
    expect(review?.auditResult).toBe(true);
    expect(review?.auditedAt).toBe(now);
    expect(review?.fingerprint).toBe('fp-match');
    expect(review?.currentFingerprint).toBe('fp-match');
  });

  it('returns the browse feed unchanged for a count-less call', async () => {
    const calls = mockWl((args) => worklistPayload(requestedBrowseCount(args)));

    const items = await fetchNextItems();

    expect(calls).toHaveLength(1);
    // `wl next` without -n defaults to one item; the bundle mirrors that.
    expect(calls[0].args).toContain('1');
    expect(ids(items)).toEqual(['N-CRIT']);
  });

  it('passes --worklog-dir through to the consolidated read', async () => {
    const calls = mockWl((args) => worklistPayload(requestedBrowseCount(args)));
    setWorklogDir('/tmp/worklog/.worklog');

    await fetchNextItems(5);

    expect(calls[0].args).toEqual(['--worklog-dir', '/tmp/worklog/.worklog', 'worklist', '-n', '5', '--json']);
  });

  it('produces output identical to the per-subset path for the same DB state', async () => {
    mockWl((args) => worklistPayload(requestedBrowseCount(args)));
    const fromBundle = await fetchNextItems(4);

    // Same DB state, per-subset path: clear the memo/snapshot so the bundle is
    // not reused, and make `worklist` unavailable.
    clearFetchMemo();
    resetExecFileAsync();
    const calls = mockWl((args) => {
      if (args[0] === 'worklist') throw new Error('unknown command worklist');
      return legacyRespond(args);
    });
    const fromSubsets = await fetchNextItems(4);

    expect(calls.some((c) => c.args[0] === 'worklist')).toBe(true); // bundle attempted
    expect(calls.some((c) => c.args[0] === 'next')).toBe(true); // then fell back
    expect(fromBundle).toEqual(fromSubsets);
  });

  it('falls back to the per-subset spawns when wl worklist is unavailable', async () => {
    const calls = mockWl((args) => {
      if (args[0] === 'worklist') {
        const err: any = new Error('error: unknown command \'worklist\'');
        err.code = 1;
        throw err;
      }
      return legacyRespond(args);
    });

    const items = await fetchNextItems(20);

    const listSpawns = calls.filter((c) => c.args[0] === 'list');
    expect(listSpawns).toHaveLength(4);
    expect(calls.filter((c) => c.args[0] === 'next')).toHaveLength(1);
    expect(ids(items)).toContain('N-CRIT');
    expect(ids(items)).toContain('N-REVIEW');
  });

  it.each([
    ['a missing subsets object', { success: true }],
    ['a missing subset key', { success: true, subsets: { critical: [], reviewQueue: [], inProgressRoots: [], blockedRoots: [] } }],
    ['a non-array subset', { success: true, subsets: { critical: {}, reviewQueue: [], inProgressRoots: [], blockedRoots: [], browse: [] } }],
  ])('falls back when the payload has %s', async (_label, payload) => {
    const calls = mockWl((args) => (args[0] === 'worklist' ? payload : legacyRespond(args)));

    const items = await fetchNextItems(20);

    expect(calls.some((c) => c.args[0] === 'next')).toBe(true);
    expect(ids(items)).toContain('N-CRIT');
  });
});

describe('fetchReviewQueueState: derived from the consolidated read', () => {
  it('uses the bundle review-queue subset without a second spawn', async () => {
    const calls = mockWl((args) => worklistPayload(requestedBrowseCount(args)));

    await fetchNextItems(20);
    const state = await fetchReviewQueueState();

    // One spawn for the whole refresh: the banner state came from the bundle.
    expect(calls).toHaveLength(1);
    // Only completed items count; N-REVIEW has a fresh (fingerprint-matching)
    // audit, so nothing is outstanding.
    expect(state).toEqual({ count: 1, auditsOutstanding: false });
  });

  it('flags an outstanding audit when a completed item has none', async () => {
    const payload = worklistPayload();
    (payload.subsets as any).reviewQueue = [browseItems.review]; // no stored audit
    mockWl(() => payload);

    await fetchNextItems(20);
    const state = await fetchReviewQueueState();

    expect(state).toEqual({ count: 1, auditsOutstanding: true });
  });

  it('falls back to the standalone query when no bundle was read this refresh', async () => {
    const calls = mockWl((args) => {
      if (args[0] === 'list') {
        return { success: true, count: 1, workItems: [reviewRich] };
      }
      throw new Error(`unexpected invocation ${args.join(' ')}`);
    });

    const state = await fetchReviewQueueState();

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain('list');
    expect(state).toEqual({ count: 1, auditsOutstanding: false });
  });

  it('does not reuse a bundle after a write', async () => {
    const calls = mockWl((args) => {
      if (args[0] === 'worklist') return worklistPayload(requestedBrowseCount(args));
      if (args[0] === 'list') return { success: true, count: 1, workItems: [reviewRich] };
      if (args[0] === 'update') return { success: true };
      throw new Error(`unexpected invocation ${args.join(' ')}`);
    });

    await fetchNextItems(20);
    // A write goes through runWl (non-memoizable) and drops the snapshot.
    const claimed = await claimWorkItem('N-REVIEW', 'agent');
    expect(claimed.success).toBe(true);
    const state = await fetchReviewQueueState();

    expect(calls.some((c) => c.args[0] === 'list')).toBe(true);
    expect(state).toEqual({ count: 1, auditsOutstanding: false });
  });
});
