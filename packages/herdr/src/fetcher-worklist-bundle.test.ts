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
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorklogDatabase } from '@worklog/shared';
import {
  fetchNextItems,
  fetchChildrenForItem,
  fetchReviewQueueState,
  fetchItemsByStage,
  fetchItemsByPriority,
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

// ── Critical-child parent substitution (WL-0MVN4WESM007T4XI) ─────────────
//
// The top level may only contain ROOT items (the critical exception to the
// root filter was removed by WL-0MVSSAKAU001RC2Z). Hiding a critical child
// must not make release-blocking work invisible, so the fetcher substitutes
// the child's ROOT ancestor: the child never renders at the top level, its
// root does (mandatory, kept in its OWN priority group, no badge/marker),
// and an unresolvable root means the child is simply not shown (fail-open).
//
// IMPLEMENTED BY WL-0MVSSANRK000V00S (WL-0MVN4WESM007T4XI-F4): every spec
// below asserts post-substitution behaviour and was committed RED (`it.fails`)
// by the test-first feature WL-0MVSSAM5H001VMQN, which F4 then flipped to a
// plain `it` (same test-first convention as
// WL-0MVSSAIO5004ERW3 / WL-0MVFE0T0M009ZCPM). The filtered-view spec is a
// plain `it`: it guards the *absence* of substitution in explicit filters
// and must stay green throughout.

/**
 * Substitution fixtures, deliberately NOT part of the shared DB state above
 * so the existing consolidated-read specs keep their exact spawn counts.
 *
 *   N-CRIT-KID      critical open CHILD of N-CRIT-ROOT (critical subset only)
 *   N-CRIT-KID-2    second critical child of the SAME root (memo coverage)
 *   N-CRIT-ROOT     medium open ROOT, in NO payload — resolved by lookup
 *   N-ORPHAN-KID    critical child of a parent that exists nowhere
 */
const substitutionItems = {
  critKid: item('N-CRIT-KID', { priority: 'critical', stage: 'idea', parentId: 'N-CRIT-ROOT' }),
  critKid2: item('N-CRIT-KID-2', { priority: 'critical', stage: 'idea', parentId: 'N-CRIT-ROOT' }),
  critRoot: item('N-CRIT-ROOT', { priority: 'medium', stage: 'idea' }),
  orphanKid: item('N-ORPHAN-KID', { priority: 'critical', stage: 'idea', parentId: 'N-MISSING-PARENT' }),
};

/** The command token of a `wl` invocation (a `--worklog-dir` prefix may precede it). */
function commandOf(args: string[]): string | undefined {
  return args.find((arg, index) =>
    ['worklist', 'show', 'next', 'list', 'update'].includes(arg) && args[index - 1] !== '--worklog-dir',
  );
}

/** The argument following `token` in a `wl` invocation. */
function argAfter(args: string[], token: string): string | undefined {
  const index = args.indexOf(token);
  return index >= 0 ? args[index + 1] : undefined;
}

/**
 * The `wl worklist` payload for the substitution fixtures: the standard DB
 * state above plus a critical child in the critical subset whose root is not
 * otherwise part of the merge.
 */
function substitutionWorklistPayload(
  browseLimit?: number,
  options: {
    criticalChildren?: Record<string, unknown>[];
    rootInBrowse?: boolean;
    rootChildCount?: number;
  } = {},
): Record<string, unknown> {
  const { criticalChildren = [substitutionItems.critKid], rootInBrowse = false, rootChildCount } = options;
  const browse = [
    entry(browseItems.crit, 'critical'),
    entry(browseItems.review, 'in review'),
    entry(browseItems.active, 'active'),
    entry(browseItems.blocked, 'blocked'),
    entry(browseItems.other, 'browse'),
    entry(browseItems.child, 'browse child'),
    // A browse-sourced substituted root carries the CLI's enriched
    // childCount (only when the caller models it) — the pre-fix bug was the
    // window-pressure case where NO enriched copy exists.
    ...(rootInBrowse
      ? [entry({ ...substitutionItems.critRoot, ...(rootChildCount !== undefined ? { childCount: rootChildCount } : {}) }, 'browse')]
      : []),
  ];
  return {
    success: true,
    worklogDir: '/tmp/worklog/.worklog',
    requestedCount: 20,
    subsets: {
      critical: [browseItems.crit, ...criticalChildren],
      reviewQueue: [reviewRich, browseItems.active],
      inProgressRoots: [browseItems.active],
      blockedRoots: [browseItems.blocked],
      browse: browseLimit === undefined ? browse : browse.slice(0, browseLimit),
    },
  };
}

/**
 * Mock responder for the substitution fixtures, covering BOTH fetch paths and
 * the `wl show` parent-resolution fallback:
 *
 *   - `worklist` → the bundle payload (or an "unknown command" failure when
 *     `bundleUnavailable`, forcing the per-subset path);
 *   - `show <id>` → a resolvable root, else a not-found failure;
 *   - `list --priority critical` → the child-inclusive critical subset
 *     (unchanged CLI semantics); everything else falls through to
 *     {@link legacyRespond}.
 */
function substitutionRespond(
  options: {
    bundleUnavailable?: boolean;
    criticalChildren?: Record<string, unknown>[];
    resolvableRoots?: Record<string, Record<string, unknown>>;
    rootInBrowse?: boolean;
    rootChildCount?: number;
  } = {},
) {
  const {
    bundleUnavailable = false,
    criticalChildren = [substitutionItems.critKid],
    resolvableRoots = { 'N-CRIT-ROOT': substitutionItems.critRoot },
    rootInBrowse = false,
    rootChildCount,
  } = options;

  return (args: string[]): unknown => {
    const command = commandOf(args);
    if (command === 'worklist') {
      if (bundleUnavailable) {
        const err = new Error("error: unknown command 'worklist'") as Error & { code?: number };
        err.code = 1;
        throw err;
      }
      return substitutionWorklistPayload(requestedBrowseCount(args), {
        criticalChildren,
        rootInBrowse,
        rootChildCount,
      });
    }
    if (command === 'show') {
      const id = argAfter(args, 'show') ?? '';
      const resolved = resolvableRoots[id];
      if (resolved) return { success: true, workItem: resolved };
      const err = new Error(`Work item not found: ${id}`) as Error & { code?: number };
      err.code = 1;
      throw err;
    }
    if (command === 'list' && args.join(' ').includes('--priority critical')) {
      const workItems = [browseItems.crit, ...criticalChildren];
      return { success: true, count: workItems.length, workItems };
    }
    return legacyRespond(args);
  };
}

/** Temp worklog roots seeded by the in-process resolution spec. */
const seededDirs: string[] = [];

/**
 * Seed a REAL worklog database whose critical child has a resolvable root, so
 * the in-process SQLite fast path (not a `wl show` spawn) performs the parent
 * lookup.
 */
function seedSubstitutionDb(): { worklogDir: string; rootId: string; childId: string } {
  const rootDir = mkdtempSync(join(tmpdir(), 'herdr-substitution-'));
  seededDirs.push(rootDir);
  const worklogDir = join(rootDir, '.worklog');
  mkdirSync(worklogDir, { recursive: true });
  const db = new WorklogDatabase(
    'WL',
    join(worklogDir, 'worklog.db'),
    join(worklogDir, 'worklog-data.jsonl'),
    true,
    false,
  );
  const root = db.create({ title: 'Substitution root', priority: 'medium', stage: 'idea' });
  const child = db.create({
    title: 'Substitution critical child',
    priority: 'critical',
    stage: 'idea',
    parentId: root.id,
  });
  db.close();
  return { worklogDir, rootId: root.id, childId: child.id };
}

beforeEach(() => {
  resetExecFileAsync();
  clearFetchMemo();
});

afterEach(() => {
  resetExecFileAsync();
  resetWorklogDir();
  clearFetchMemo();
  for (const dir of seededDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
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

describe('fetchNextItems: critical-child parent substitution (WL-0MVN4WESM007T4XI)', () => {
  it('bundle path: replaces a critical child with its root ancestor at the top level', async () => {
    mockWl(substitutionRespond());

    const items = await fetchNextItems(20);
    const shown = ids(items);

    // The child is never a top-level row; its root stands in for it.
    expect(shown).not.toContain('N-CRIT-KID');
    expect(shown).toContain('N-CRIT-ROOT');
    // Defence in depth for the root-only invariant: no rendered row is a child.
    expect(items.filter((i) => i.parentId)).toHaveLength(0);
    // Non-critical children stay hidden exactly as before (no regression).
    expect(shown).not.toContain('N-CHILD');
    expect(shown).toContain('N-OTHER');
  });

  it('bundle path: shows the substituted root even when browseItemCount would cut it', async () => {
    mockWl(substitutionRespond());

    const items = await fetchNextItems(1);

    // Mandatory, not a browse-window candidate: the tightest count still shows it.
    expect(ids(items)).toContain('N-CRIT-ROOT');
    expect(ids(items)).not.toContain('N-CRIT-KID');
  });

  it('bundle path: shows a root that is already browsable exactly once', async () => {
    mockWl(substitutionRespond({ rootInBrowse: true }));

    const items = await fetchNextItems(20);

    // Already in the selected set → substituted once, never duplicated.
    expect(items.filter((i) => i.id === 'N-CRIT-ROOT')).toHaveLength(1);
    expect(ids(items)).not.toContain('N-CRIT-KID');
  });

  it('bundle path: keeps the substituted root in its own priority group with no critical marker', async () => {
    mockWl(substitutionRespond());

    const items = await fetchNextItems(20);
    const root = items.find((i) => i.id === 'N-CRIT-ROOT');

    // Its OWN priority/stage — substitution never rewrites stored fields.
    expect(root?.priority).toBe('medium');
    expect(root?.status).toBe('open');
    expect(root?.stage).toBe('idea');
    // Sorted by its own group, not promoted into a Critical group (Q3: no badge).
    expect(root?.groupLabel).toBe('Idea');
    expect(root?.groupLabel?.startsWith('Critical')).toBe(false);
    // No marker/indicator field is attached to the substituted row.
    for (const marker of [
      'criticalChild',
      'criticalChildCount',
      'substituted',
      'substitutedFor',
      'badge',
      'marker',
      'indicator',
    ]) {
      expect((root as Record<string, unknown> | undefined)?.[marker]).toBeUndefined();
    }
  });

  it('bundle path: promotes the TOP-MOST ancestor for a nested critical child', async () => {
    // A critical grandchild must promote the ROOT, never the intermediate
    // parent: the top level may only contain root items.
    const grandchild = item('N-DEEP-KID', {
      priority: 'critical',
      stage: 'idea',
      parentId: 'N-MID-PARENT',
    });
    const intermediate = item('N-MID-PARENT', {
      priority: 'medium',
      stage: 'idea',
      parentId: 'N-TOP-ROOT',
    });
    const topRoot = item('N-TOP-ROOT', { priority: 'low', stage: 'idea' });
    mockWl(
      substitutionRespond({
        criticalChildren: [grandchild],
        resolvableRoots: { 'N-MID-PARENT': intermediate, 'N-TOP-ROOT': topRoot },
      }),
    );

    const items = await fetchNextItems(20);
    const shown = ids(items);

    expect(shown).not.toContain('N-DEEP-KID');
    // The intermediate parent is itself a child — never rendered at top level.
    expect(shown).not.toContain('N-MID-PARENT');
    expect(shown).toContain('N-TOP-ROOT');
    expect(items.filter((i) => i.parentId)).toHaveLength(0);
  });

  it('bundle path: resolves the parent in-process with no wl show spawn', async () => {
    const seeded = seedSubstitutionDb();
    setWorklogDir(seeded.worklogDir);
    const criticalChild = item(seeded.childId, { priority: 'critical', parentId: seeded.rootId });
    const calls = mockWl(
      substitutionRespond({ criticalChildren: [criticalChild], resolvableRoots: {} }),
    );

    const items = await fetchNextItems(20);

    expect(ids(items)).toContain(seeded.rootId);
    expect(ids(items)).not.toContain(seeded.childId);
    // In-process fast path: the ONLY spawn is the consolidated worklist read.
    expect(calls).toHaveLength(1);
    expect(calls.some((c) => c.args.includes('show'))).toBe(false);
  });

  it('bundle path: falls back to wl show and memoises the parent lookup', async () => {
    const calls = mockWl(
      substitutionRespond({
        criticalChildren: [substitutionItems.critKid, substitutionItems.critKid2],
      }),
    );

    const items = await fetchNextItems(20);

    // Two critical children, one substituted root.
    expect(ids(items)).not.toContain('N-CRIT-KID');
    expect(ids(items)).not.toContain('N-CRIT-KID-2');
    expect(items.filter((i) => i.id === 'N-CRIT-ROOT')).toHaveLength(1);
    // The per-refresh memo collapses the shared root into ONE `wl show`.
    const rootLookups = calls.filter(
      (c) => c.args.includes('show') && c.args.includes('N-CRIT-ROOT'),
    );
    expect(rootLookups).toHaveLength(1);
  });

  it('bundle path: fails open when the parent cannot be resolved', async () => {
    const calls = mockWl(
      substitutionRespond({
        criticalChildren: [substitutionItems.orphanKid],
        resolvableRoots: {},
      }),
    );

    // Unresolvable parent: the refresh still succeeds, the child is not shown
    // and nothing is rendered in its place (no fallback to the child row).
    const items = await fetchNextItems(20);
    const shown = ids(items);
    expect(shown).not.toContain('N-ORPHAN-KID');
    expect(shown).not.toContain('N-MISSING-PARENT');
    expect(shown).toContain('N-CRIT');
    // The documented fail-open fallback was attempted for the missing parent.
    expect(
      calls.some((c) => c.args.includes('show') && c.args.includes('N-MISSING-PARENT')),
    ).toBe(true);
  });

  it('per-subset fallback: applies the same parent substitution', async () => {
    mockWl(substitutionRespond({ bundleUnavailable: true }));

    const items = await fetchNextItems(20);
    const shown = ids(items);

    expect(shown).not.toContain('N-CRIT-KID');
    expect(shown).toContain('N-CRIT-ROOT');
    // Non-critical children stay hidden on the fallback path too.
    expect(shown).not.toContain('N-CHILD');
    expect(items.filter((i) => i.parentId)).toHaveLength(0);
  });

  it('per-subset fallback: the substituted root stays mandatory under a tight count', async () => {
    mockWl(substitutionRespond({ bundleUnavailable: true }));

    const items = await fetchNextItems(1);

    expect(ids(items)).toContain('N-CRIT-ROOT');
    expect(ids(items)).not.toContain('N-CRIT-KID');
  });

  it('does not synthesise rows in the stage- and priority-filtered views', async () => {
    const calls = mockWl((args) => {
      const joined = args.join(' ');
      if (commandOf(args) === 'list' && joined.includes('--stage in_review')) {
        return { success: true, count: 1, workItems: [browseItems.review] };
      }
      if (commandOf(args) === 'list' && joined.includes('--priority critical')) {
        return { success: true, count: 1, workItems: [browseItems.crit] };
      }
      throw new Error(`unexpected wl invocation: ${args.join(' ')}`);
    });

    const byStage = await fetchItemsByStage('in_review');
    const byPriority = await fetchItemsByPriority('critical');

    // Explicit filters stay strictly root-only: no parent lookup, no synthetic
    // row substituted in, whatever the default view does.
    expect(ids(byStage)).toEqual(['N-REVIEW']);
    expect(ids(byPriority)).toEqual(['N-CRIT']);
    expect([...ids(byStage), ...ids(byPriority)]).not.toContain('N-CRIT-ROOT');
    expect(calls.every((c) => commandOf(c.args) === 'list')).toBe(true);
  });

  // ── Substituted-root `childCount` (WL-0MWDDAQ0L009FLEF)` ──────────────
  //
  // The worklist's expand affordance is gated on `childCount > 0` (arrow,
  // Tab toggle and the on-demand child fetch are ALL behind it). The ancestor
  // resolution paths (`db.get` fast path and the `wl show` fallback) carry no
  // childCount — only the `wl list`/`wl next`/`wl worklist` enrichments do —
  // so a SUBSTITUTED root resolved outside the browse window used to render
  // without an expand arrow, making its critical child unreachable. The fix
  // enriches substituted roots with the same in-process `getChildCounts` pass
  // the child read uses (fail-open: arrow absent if the read fails — today's
  // behaviour, never a crash).

  it('window pressure (othersLimit 0): in-process-resolved substituted root carries childCount (WL-0MWDDAQ0L009FLEF AC1/AC3a)', async () => {
    const seeded = seedSubstitutionDb();
    setWorklogDir(seeded.worklogDir);
    const criticalChild = item(seeded.childId, { priority: 'critical', parentId: seeded.rootId });
    const calls = mockWl(
      substitutionRespond({ criticalChildren: [criticalChild], resolvableRoots: {} }),
    );

    // count 1: the mandatory subsets alone fill the window (othersLimit === 0)
    // and the root is NOT in the browse feed — the pre-fix shape that lost its
    // childCount because no enriched copy existed to keep in the merge.
    const items = await fetchNextItems(1);
    const root = items.find((i) => i.id === seeded.rootId);

    expect(ids(items)).not.toContain(seeded.childId);
    expect(ids(items)).toContain(seeded.rootId);
    // The seeded root has exactly ONE direct child (the critical child), and
    // getChildCounts is computed over ALL items (deleted included) exactly
    // like the CLI's enrichment / readChildrenInProcess.
    expect(root?.childCount).toBe(1);
    // The whole refresh is the ONE consolidated read: the ancestor plus its
    // childCount resolved in-process (no `wl show`, no `wl list`).
    expect(calls).toHaveLength(1);
  });

  it('keeps the browse-sourced root childCount (no double-count, no clobber) (WL-0MWDDAQ0L009FLEF AC3b)', async () => {
    // The root IS in the browse window this time, carrying the enriched
    // `wl list`-style childCount. Substitution must not overwrite it:
    // first-occurrence merge keeps the enriched copy, and the enrichment
    // pass must only fill UNDEFINED counts.
    mockWl(substitutionRespond({ rootInBrowse: true, rootChildCount: 9 }));

    const items = await fetchNextItems(20);
    const root = items.find((i) => i.id === 'N-CRIT-ROOT');

    expect(items.filter((i) => i.id === 'N-CRIT-ROOT')).toHaveLength(1);
    expect(root?.childCount).toBe(9);
  });

  it('children of the substituted root are reachable on demand (Tab/Enter fetch path) (WL-0MWDDAQ0L009FLEF AC2)', async () => {
    const seeded = seedSubstitutionDb();
    setWorklogDir(seeded.worklogDir);
    const criticalChild = item(seeded.childId, { priority: 'critical', parentId: seeded.rootId });
    const calls = mockWl(
      substitutionRespond({ criticalChildren: [criticalChild], resolvableRoots: {} }),
    );

    const items = await fetchNextItems(25);
    const root = items.find((i) => i.id === seeded.rootId);
    expect(root?.childCount).toBe(1);

    // The worklist's expand handler fetches children on demand via
    // fetchChildrenForItem (the ONLY child-fetch entry, gated on
    // childCount > 0) — the same call the substituted root's arrow unlocks.
    const children = await fetchChildrenForItem(seeded.rootId);
    expect(ids(children)).toContain(seeded.childId);
    // No extra spawns: both the ancestor/childCount resolution and the
    // children read are in-process.
    expect(calls.some((c) => c.args.includes('show'))).toBe(false);
    expect(calls.some((c) => c.args.includes('list'))).toBe(false);
  });

  it('enriches a wl show-resolved root (chain through a browsed middle node) with childCount (WL-0MWDDAQ0L009FLEF robustness)', async () => {
    // The critical child's DIRECT parent is in the browse feed (so the
    // in-process pre-walk is skipped), but the true root sits ABOVE it and is
    // resolved via `wl show`. The post-walk pass must still give the root its
    // childCount from the store.
    const seeded = seedSubstitutionDb();
    setWorklogDir(seeded.worklogDir);
    const middle = item('N-MID-KNOWN', { priority: 'low', stage: 'idea', parentId: seeded.rootId });
    const criticalChild = item('N-KID-VIA-SHOW', {
      priority: 'critical',
      stage: 'idea',
      parentId: 'N-MID-KNOWN',
    });
    const calls = mockWl((args) => {
      const command = commandOf(args);
      if (command === 'worklist') {
        const payload = substitutionWorklistPayload(requestedBrowseCount(args), {
          criticalChildren: [criticalChild],
        });
        const subsets = payload.subsets as {
          browse: unknown[];
          critical: unknown[];
          reviewQueue: unknown[];
          inProgressRoots: unknown[];
          blockedRoots: unknown[];
        };
        // The middle node rides in the browse feed; the root does not.
        subsets.browse = [...subsets.browse, entry(middle, 'browse')];
        return payload;
      }
      if (command === 'show') {
        const id = argAfter(args, 'show') ?? '';
        if (id === seeded.rootId) {
          return { success: true, workItem: item(seeded.rootId, { priority: 'low' }) };
        }
        const err = new Error(`Work item not found: ${id}`) as Error & { code?: number };
        err.code = 1;
        throw err;
      }
      return legacyRespond(args);
    });

    const items = await fetchNextItems(25);
    const root = items.find((i) => i.id === seeded.rootId);

    // The root was resolved via `wl show` (no in-process ancestor read for
    // this chain because the middle node covered the first hop)…
    expect(calls.some((c) => c.args.includes('show') && c.args.includes(seeded.rootId))).toBe(true);
    // …yet it still carries the store's childCount for the expand affordance.
    expect(root?.childCount).toBe(1);
    expect(ids(items)).not.toContain('N-KID-VIA-SHOW');
  });
});

// ── Blockers of visible blocked items are pinned (WL-0MW7YJYS5009H7WC) ────
//
// RED WITNESS (test-first child WL-0MWDOL08L000L3ZG). The selection child
// (WL-0MWDOL9J4008K3YR) adds a blocker-pin pass to the default-worklist
// selection tail: every ACTIVE blocker of a visible blocked item joins the
// selected set (the blocker itself when it is a root, its ROOT ancestor when
// it is a child — the same parent substitution the critical-child path uses).
// The specs that assert post-implementation behaviour are committed with
// `it.fails` so the suite stays GREEN while they are RED; the selection child
// flips each `it.fails` to `it` as it lands. Guards that must hold BEFORE and
// AFTER (no-op, read cost, no-duplicates) are plain `it`.

/**
 * Seed a REAL worklog DB reproducing the measured defect shape: 20 root
 * completed/in_review items, 4 blocked roots, open root blockers and one
 * child-of-self blocker (the `LP-0MVMHNUAR006SRZT` shape) — with
 * `browseItemCount = 20` the review queue saturates the window and every
 * open blocker is cut (othersLimit 0).
 */
function seedReproductionDb(withEdges = true): {
  worklogDir: string;
  reviews: string[];
  blocked: string[];
  rootBlockers: string[];
  childBlocker: string;
} {
  const rootDir = mkdtempSync(join(tmpdir(), 'herdr-blocker-pin-'));
  seededDirs.push(rootDir);
  const worklogDir = join(rootDir, '.worklog');
  mkdirSync(worklogDir, { recursive: true });
  const db = new WorklogDatabase(
    'WL',
    join(worklogDir, 'worklog.db'),
    join(worklogDir, 'worklog-data.jsonl'),
    true,
    false,
  );
  // 20 root completed/in_review items (the mandatory review queue).
  const reviews = Array.from({ length: 20 }, (_, index) =>
    db.create({ title: `Review ${index + 1}`, status: 'completed', stage: 'in_review', priority: 'medium' }).id,
  );
  // 4 blocked roots (status=blocked, always shown).
  const blockedA = db.create({ title: 'Blocked A', status: 'blocked', stage: 'intake_complete', priority: 'high' });
  const blockedB = db.create({ title: 'Blocked B', status: 'blocked', stage: 'intake_complete', priority: 'high' });
  const blockedC = db.create({ title: 'Blocked C', status: 'blocked', stage: 'plan_complete', priority: 'high' });
  const blockedD = db.create({ title: 'Blocked D', status: 'blocked', stage: 'idea', priority: 'high' });
  // Open root blockers (hidden by the window today — the reported defect).
  const blockerA1 = db.create({ title: 'Blocker A1', status: 'open', stage: 'idea', priority: 'medium' });
  const blockerA2 = db.create({ title: 'Blocker A2', status: 'open', stage: 'idea', priority: 'medium' });
  const blockerB1 = db.create({ title: 'Blocker B1', status: 'open', stage: 'idea', priority: 'medium' });
  const blockerB2 = db.create({ title: 'Blocker B2', status: 'open', stage: 'idea', priority: 'medium' });
  // A CHILD blocker whose root IS the blocked item it blocks (the
  // `LP-0MVMHNUAR006SRZT` shape): substitution collapses to the already
  // visible blocked item — nothing is added, the child stays reachable via
  // expand.
  const childBlocker = db.create({
    title: 'Child blocker of C',
    status: 'open',
    stage: 'intake_complete',
    priority: 'medium',
    parentId: blockedC.id,
  });
  if (withEdges) {
    db.addDependencyEdge(blockedA.id, blockerA1.id);
    db.addDependencyEdge(blockedA.id, blockerA2.id);
    db.addDependencyEdge(blockedB.id, blockerB1.id);
    db.addDependencyEdge(blockedB.id, blockerB2.id);
    db.addDependencyEdge(blockedC.id, childBlocker.id);
    // Blocked D is blocked by Blocked B, which is already visible — no pin.
    db.addDependencyEdge(blockedD.id, blockedB.id);
  }
  db.close();
  return {
    worklogDir,
    reviews,
    blocked: [blockedA.id, blockedB.id, blockedC.id, blockedD.id],
    rootBlockers: [blockerA1.id, blockerA2.id, blockerB1.id, blockerB2.id],
    childBlocker: childBlocker.id,
  };
}

/** The `wl worklist` payload for the reproduction shape (blockers excluded). */
function reproductionPayload(
  seeded: ReturnType<typeof seedReproductionDb>,
  browseLimit?: number,
): Record<string, unknown> {
  const reviewEntries = seeded.reviews.map((id) =>
    entry(item(id, { status: 'completed', stage: 'in_review', priority: 'medium' }), 'in review'),
  );
  const blockedRoots = [
    item(seeded.blocked[0], { status: 'blocked', stage: 'intake_complete', priority: 'high' }),
    item(seeded.blocked[1], { status: 'blocked', stage: 'intake_complete', priority: 'high' }),
    item(seeded.blocked[2], { status: 'blocked', stage: 'plan_complete', priority: 'high' }),
    item(seeded.blocked[3], { status: 'blocked', stage: 'idea', priority: 'high' }),
  ];
  return {
    success: true,
    worklogDir: seeded.worklogDir,
    requestedCount: 20,
    subsets: {
      critical: [],
      reviewQueue: reviewEntries.map((e) => e.workItem),
      inProgressRoots: [],
      blockedRoots,
      browse: browseLimit === undefined ? reviewEntries : reviewEntries.slice(0, browseLimit),
    },
  };
}

describe('fetchNextItems: blockers of visible blocked items are pinned (WL-0MW7YJYS5009H7WC)', () => {
  it.fails('AC1: reproduces the defect shape and pins EVERY root blocker into the selection', async () => {
    const seeded = seedReproductionDb();
    setWorklogDir(seeded.worklogDir);
    const calls = mockWl((args) =>
      commandOf(args) === 'worklist'
        ? reproductionPayload(seeded, requestedBrowseCount(args))
        : legacyRespond(args),
    );

    // browseItemCount = 20 with 20 review roots + 4 blocked roots: the whole
    // window is consumed by the mandatory set (othersLimit 0), exactly the
    // measured defect shape.
    const items = await fetchNextItems(20);
    const shown = ids(items);

    // The 4 blocked roots and all 20 reviews are visible…
    for (const id of [...seeded.blocked, ...seeded.reviews]) {
      expect(shown).toContain(id);
    }
    // …and each ROOT blocker is now selected — not merely "not dropped by the
    // count window", but present in the returned selection.
    for (const blockerId of seeded.rootBlockers) {
      expect(shown).toContain(blockerId);
    }
    // AC8: adding the pinned blockers costs NO extra wl spawn — the whole
    // refresh stays ONE consolidated worklist read on the default path.
    expect(calls).toHaveLength(1);
    expect(calls.every((c) => c.args.includes('worklist'))).toBe(true);
  });

  it('AC4: pinning never duplicates ids and never hides an item visible today', async () => {
    const seeded = seedReproductionDb();
    setWorklogDir(seeded.worklogDir);
    mockWl((args) =>
      commandOf(args) === 'worklist'
        ? reproductionPayload(seeded, requestedBrowseCount(args))
        : legacyRespond(args),
    );

    const items = await fetchNextItems(20);
    const shown = ids(items);

    // No duplicate ids.
    expect(new Set(shown).size).toBe(shown.length);
    // Every item that is visible today (the 24 mandatory rows) stays visible.
    for (const id of [...seeded.blocked, ...seeded.reviews]) {
      expect(shown.filter((x) => x === id)).toHaveLength(1);
    }
  });

  it('AC5: with no active blocker the selection is byte-identical to today (no-op regression)', async () => {
    // Same reproduction shape, but NO dependency edges: no visible blocked
    // item has an active blocker, so the pin pass must leave the output
    // byte-identical to today's — the 24 mandatory rows, nothing more.
    const seeded = seedReproductionDb(/* withEdges */ false);
    setWorklogDir(seeded.worklogDir);
    const calls = mockWl((args) =>
      commandOf(args) === 'worklist'
        ? reproductionPayload(seeded, requestedBrowseCount(args))
        : legacyRespond(args),
    );

    const items = await fetchNextItems(20);
    const shown = ids(items);

    // Exactly today's selection: the mandatory set, no additions, no
    // duplicates, in exactly today's order (deterministic content grouping).
    expect(new Set(shown).size).toBe(shown.length);
    expect(shown.length).toBe(24);
    for (const id of [...seeded.blocked, ...seeded.reviews]) {
      expect(shown).toContain(id);
    }
    // No pins → still exactly one consolidated read.
    expect(calls).toHaveLength(1);
  });

  it('AC8: the pinned read reuses the in-process dependency read — zero dep/show spawns', async () => {
    const seeded = seedReproductionDb();
    setWorklogDir(seeded.worklogDir);
    const calls = mockWl((args) =>
      commandOf(args) === 'worklist'
        ? reproductionPayload(seeded, requestedBrowseCount(args))
        : legacyRespond(args),
    );

    await fetchNextItems(20);

    // The pin read is in-process (batched fetchOutboundDepsForItems over the
    // selected blocked ids): no `wl dep list`, no per-blocker `wl show`, no
    // extra `wl next` — the ONLY spawned command is the consolidated worklist.
    expect(calls).toHaveLength(1);
    expect(calls[0].args.some((a) => a === 'dep' || a === 'show' || a === 'next')).toBe(false);
    expect(calls[0].args).toContain('worklist');
  });
});

describe('fetchNextItems: ancestor substitution for CHILD blockers (WL-0MW7YJYS5009H7WC AC6)', () => {
  /**
   * Seed ONE blocked root whose active blocker is a CHILD, then serve a
   * `wl worklist` payload containing ONLY the blocked root (the child and
   * any ancestors are hidden). Returns the seeded ids so each AC6 case can
   * assert what the pin pass must add/keep.
   */
  async function seedChildBlockerCase(kind: 'third-party' | 'self' | 'nested'): Promise<{
    worklogDir: string;
    blocked: string;
    child: string;
    root: string;
  }> {
    const rootDir = mkdtempSync(join(tmpdir(), 'herdr-child-blocker-'));
    seededDirs.push(rootDir);
    const worklogDir = join(rootDir, '.worklog');
    mkdirSync(worklogDir, { recursive: true });
    const db = new WorklogDatabase(
      'WL',
      join(worklogDir, 'worklog.db'),
      join(worklogDir, 'worklog-data.jsonl'),
      true,
      false,
    );
    const blocked = db.create({ title: 'Blocked', status: 'blocked', stage: 'plan_complete', priority: 'high' });

    let childParentId = blocked.id;
    let root = blocked.id;
    if (kind === 'third-party') {
      // Child blocker hangs under a THIRD-PARTY root: the ROOT is pinned.
      root = db.create({ title: 'Third-party parent', status: 'open', stage: 'idea', priority: 'medium' }).id;
      childParentId = root;
    } else if (kind === 'nested') {
      // Nested chain: child → middle → top-most root.
      const top = db.create({ title: 'Top-most root', status: 'open', stage: 'idea', priority: 'medium' });
      const middle = db.create({ title: 'Middle parent', status: 'open', stage: 'idea', priority: 'medium', parentId: top.id });
      root = top.id;
      childParentId = middle.id;
    }
    const child = db.create({
      title: 'Child blocker',
      status: 'open',
      stage: 'intake_complete',
      priority: 'medium',
      parentId: childParentId,
    });
    db.addDependencyEdge(blocked.id, child.id);
    db.close();

    setWorklogDir(worklogDir);
    const blockedRow = item(blocked.id, { status: 'blocked', stage: 'plan_complete', priority: 'high' });
    mockWl((args) => {
      if (commandOf(args) === 'worklist') {
        return {
          success: true,
          worklogDir,
          requestedCount: 20,
          subsets: {
            critical: [],
            reviewQueue: [],
            inProgressRoots: [],
            blockedRoots: [blockedRow],
            browse: [entry(blockedRow, 'blocked')],
          },
        };
      }
      return legacyRespond(args);
    });
    return { worklogDir, blocked: blocked.id, child: child.id, root };
  }

  it.fails('pins the ROOT ancestor when a child blocker hangs under a third-party parent (AC6a)', async () => {
    const seeded = await seedChildBlockerCase('third-party');

    const items = await fetchNextItems(20);
    const shown = ids(items);

    // The child never renders at the top level…
    expect(shown).not.toContain(seeded.child);
    // …its ROOT ancestor is pinned instead.
    expect(shown).toContain(seeded.root);
    // No leftover parentId item appears in the selected list (generalisation
    // of the root-only invariant).
    expect(items.filter((i) => i.parentId)).toHaveLength(0);
    // The blocked root itself stays visible.
    expect(shown).toContain(seeded.blocked);
  });

  it('adds NO row when the child blocker\'s root IS the blocked item — child stays reachable via expand (AC6b)', async () => {
    const seeded = await seedChildBlockerCase('self');

    const items = await fetchNextItems(20);
    const shown = ids(items);

    // The blocked item appears exactly once (never duplicated by the pin)…
    expect(shown).toContain(seeded.blocked);
    expect(items.filter((i) => i.id === seeded.blocked)).toHaveLength(1);
    // …the child is NOT a top-level row…
    expect(shown).not.toContain(seeded.child);
    expect(items.filter((i) => i.parentId)).toHaveLength(0);
    // …and it stays reachable via expand of the parent it blocks.
    const children = await fetchChildrenForItem(seeded.blocked);
    expect(ids(children)).toContain(seeded.child);
  });

  it.fails('pins the TOP-MOST ancestor for a NESTED child blocker (AC6c)', async () => {
    const seeded = await seedChildBlockerCase('nested');

    const items = await fetchNextItems(20);
    const shown = ids(items);

    // Top-most ancestor is pinned; the intermediate parent and the child
    // itself never render at top level (mirrors the nested critical-child
    // rule).
    expect(shown).toContain(seeded.root);
    expect(shown).not.toContain(seeded.child);
    expect(items.filter((i) => i.parentId)).toHaveLength(0);
    expect(shown).toContain(seeded.blocked);
  });
});

