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
// RED WITNESS: the substitution step is the implementation feature
// WL-0MVSSANRK000V00S (WL-0MVN4WESM007T4XI-F4). Every spec below asserts
// post-substitution behaviour and is committed with `it.fails`; F4 flips
// each `it.fails` to `it` (same test-first convention as
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
  options: { criticalChildren?: Record<string, unknown>[]; rootInBrowse?: boolean } = {},
): Record<string, unknown> {
  const { criticalChildren = [substitutionItems.critKid], rootInBrowse = false } = options;
  const browse = [
    entry(browseItems.crit, 'critical'),
    entry(browseItems.review, 'in review'),
    entry(browseItems.active, 'active'),
    entry(browseItems.blocked, 'blocked'),
    entry(browseItems.other, 'browse'),
    entry(browseItems.child, 'browse child'),
    ...(rootInBrowse ? [entry(substitutionItems.critRoot, 'browse')] : []),
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
  } = {},
) {
  const {
    bundleUnavailable = false,
    criticalChildren = [substitutionItems.critKid],
    resolvableRoots = { 'N-CRIT-ROOT': substitutionItems.critRoot },
    rootInBrowse = false,
  } = options;

  return (args: string[]): unknown => {
    const command = commandOf(args);
    if (command === 'worklist') {
      if (bundleUnavailable) {
        const err = new Error("error: unknown command 'worklist'") as Error & { code?: number };
        err.code = 1;
        throw err;
      }
      return substitutionWorklistPayload(requestedBrowseCount(args), { criticalChildren, rootInBrowse });
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
  it.fails('bundle path: replaces a critical child with its root ancestor at the top level', async () => {
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

  it.fails('bundle path: shows the substituted root even when browseItemCount would cut it', async () => {
    mockWl(substitutionRespond());

    const items = await fetchNextItems(1);

    // Mandatory, not a browse-window candidate: the tightest count still shows it.
    expect(ids(items)).toContain('N-CRIT-ROOT');
    expect(ids(items)).not.toContain('N-CRIT-KID');
  });

  it.fails('bundle path: shows a root that is already browsable exactly once', async () => {
    mockWl(substitutionRespond({ rootInBrowse: true }));

    const items = await fetchNextItems(20);

    // Already in the selected set → substituted once, never duplicated.
    expect(items.filter((i) => i.id === 'N-CRIT-ROOT')).toHaveLength(1);
    expect(ids(items)).not.toContain('N-CRIT-KID');
  });

  it.fails('bundle path: keeps the substituted root in its own priority group with no critical marker', async () => {
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

  it.fails('bundle path: resolves the parent in-process with no wl show spawn', async () => {
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

  it.fails('bundle path: falls back to wl show and memoises the parent lookup', async () => {
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

  it.fails('bundle path: fails open when the parent cannot be resolved', async () => {
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

  it.fails('per-subset fallback: applies the same parent substitution', async () => {
    mockWl(substitutionRespond({ bundleUnavailable: true }));

    const items = await fetchNextItems(20);
    const shown = ids(items);

    expect(shown).not.toContain('N-CRIT-KID');
    expect(shown).toContain('N-CRIT-ROOT');
    // Non-critical children stay hidden on the fallback path too.
    expect(shown).not.toContain('N-CHILD');
    expect(items.filter((i) => i.parentId)).toHaveLength(0);
  });

  it.fails('per-subset fallback: the substituted root stays mandatory under a tight count', async () => {
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
});
