/**
 * packages/herdr/src/downtime-worker.prep-supply.test.ts — the fixture-driven
 * pin for the per-root prep-supply classifier (WL-0MWTBJ5N1005BNXZ, child 1 of
 * WL-0MWTAD1KM0081UUD).
 *
 * Test-first slice: the buckets, their primary-cause precedence and the
 * read-only contract are pinned HERE, before the report command
 * (WL-0MWTBJ7G1004Y29B) consumes them, so the measurement the whole
 * investigation depends on cannot silently drift.
 *
 * Every window is built from **inline JSON** — no live worklog, no `wl`
 * subprocess, no filesystem read of state, no sleeps. The fixtures are frozen
 * before use, so an accidental mutation in the classifier throws instead of
 * quietly changing the measurement.
 *
 * What the dispatcher does is NOT pinned here: the classifier predicates are
 * asserted in place, never modified (a disagreement is a finding for the
 * parent item, never a licence to change a gate).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  PREP_SUPPLY_BUCKETS,
  PREP_SUPPLY_STAGES,
  classifyPrepSupplyItem,
  classifyPrepSupplyWindow,
  prepSupplyKindForStage,
  type PrepSupplyBucket,
  type PrepSupplyContext,
  type PrepSupplyExclusion,
  type PrepSupplyItem,
  type PrepSupplyRootWindow,
} from './downtime-worker.prep-supply.js';
import { classifyItemForDispatchDetail, isAttemptBudgetExhausted } from './downtime-worker.gates.js';
import { isAssigneeHeld } from './downtime-worker.selection.js';
import {
  dispatchedItemMarkers,
  isNonTerminalCooldownActive,
  markerStillExcludes,
} from './downtime-log-markers.js';
import type { DowntimeLogEntry } from './downtime-log-entries.js';

// ── Fixture plumbing (inline JSON only) ───────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

/** Frozen evaluation instant for every fixture: 2026-11-23T10:15:00Z. */
const NOW = Date.parse('2026-11-23T10:15:00.000Z');

interface InlineWindow {
  root: string;
  items: PrepSupplyItem[];
}

/** Parse an inline JSON window — deliberately no DB/subprocess/temp files. */
function window(json: string): { root: string; items: PrepSupplyItem[] } {
  const parsed = JSON.parse(json) as InlineWindow;
  return { root: parsed.root, items: parsed.items };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    const record = value as unknown as Record<string, unknown>;
    for (const key of Object.keys(record)) deepFreeze(record[key]);
    Object.freeze(value);
  }
  return value;
}

function frozenWindow(json: string): { root: string; items: PrepSupplyItem[] } {
  return deepFreeze(window(json));
}

function frozenEntries(json: string): DowntimeLogEntry[] {
  return deepFreeze(JSON.parse(json) as DowntimeLogEntry[]);
}

/** The single reported bucket for an item (`null` when it is out of scope). */
function bucketOf(result: PrepSupplyRootWindow, id: string): PrepSupplyBucket | null {
  const verdicts = result.verdicts.filter((v) => v.id === id);
  expect(verdicts, `expected exactly one verdict for ${id}`).toHaveLength(1);
  return verdicts[0].bucket;
}

function exclusionOf(result: PrepSupplyRootWindow, id: string): PrepSupplyExclusion | undefined {
  const verdicts = result.verdicts.filter((v) => v.id === id);
  expect(verdicts, `expected exactly one verdict for ${id}`).toHaveLength(1);
  return verdicts[0].excluded;
}

function everyBucketId(result: PrepSupplyRootWindow): string[] {
  return PREP_SUPPLY_BUCKETS.flatMap((bucket) => result.buckets[bucket]);
}

const BASE_ITEM = {
  status: 'open',
  assignee: '',
  createdAt: '2026-11-20T00:00:00.000Z',
  startOn: '2026-11-20T00:00:00.000Z',
} as const;

// ── The single-cause fixture window ───────────────────────────────────
//
// One item per bucket plus one per exclusion, so a drift in ANY branch shows
// up as exactly one moved row.

const MAIN_WINDOW_JSON = JSON.stringify({
  root: '/home/rgardler/projects/ContextHub',
  items: [
    // Offerable prep (both stages), plus the dispatcher's own claim, which is
    // an agent claim and never a scheduling hold.
    { ...BASE_ITEM, id: 'WL-PREP-OFFERABLE', stage: 'intake_complete' },
    { ...BASE_ITEM, id: 'WL-PREP-IDEA-OFFERABLE', stage: 'idea' },
    { ...BASE_ITEM, id: 'WL-PREP-DISPATCHER-CLAIM', stage: 'idea', assignee: 'dispatcher' },
    // Refusals, one per bucket.
    { ...BASE_ITEM, id: 'WL-PREP-PRODUCER-REVIEW', stage: 'idea', needsProducerReview: true },
    { ...BASE_ITEM, id: 'WL-PREP-MARKER', stage: 'intake_complete' },
    { ...BASE_ITEM, id: 'WL-PREP-ASSIGNEE', stage: 'idea', assignee: 'Map' },
    {
      ...BASE_ITEM,
      id: 'WL-PREP-DEPENDENCY',
      stage: 'idea',
      status: 'blocked',
      dependencies: [{ from: 'WL-PREP-DEPENDENCY', to: 'WL-BLOCKER-OPEN' }],
    },
    // A dependency whose blocker is already terminal must NOT hold the item.
    {
      ...BASE_ITEM,
      id: 'WL-PREP-DEPENDENCY-MET',
      stage: 'idea',
      dependencies: [{ from: 'WL-PREP-DEPENDENCY-MET', to: 'WL-BLOCKER-DONE' }],
    },
    // An unresolvable blocker is fail-closed: unmet.
    {
      ...BASE_ITEM,
      id: 'WL-PREP-DEPENDENCY-UNRESOLVED',
      stage: 'idea',
      dependencies: [{ from: 'WL-PREP-DEPENDENCY-UNRESOLVED', to: 'WL-BLOCKER-MISSING' }],
    },
    { ...BASE_ITEM, id: 'WL-PREP-STARTON', stage: 'intake_complete', startOn: '2026-12-01T00:00:00.000Z' },
    { ...BASE_ITEM, id: 'WL-PREP-ATTEMPT-BUDGET', stage: 'idea' },
    // A STALE marker releases (staleness window), so this one is offerable.
    { ...BASE_ITEM, id: 'WL-PREP-STALE-MARKER', stage: 'idea' },
    // A marker recorded at the PREVIOUS stage releases on advancement.
    { ...BASE_ITEM, id: 'WL-PREP-ADVANCED-MARKER', stage: 'intake_complete' },
    { ...BASE_ITEM, id: 'WL-PREP-COOLDOWN', stage: 'intake_complete' },
    { ...BASE_ITEM, id: 'WL-PREP-OTHER-GATED', stage: 'intake_complete', status: 'in-progress' },
    // Out of prep-supply scope entirely.
    {
      ...BASE_ITEM,
      id: 'WL-PREP-PLAN-COMPLETE',
      stage: 'plan_complete',
      risk: 'Medium',
      effort: 'S',
    },
    { ...BASE_ITEM, id: 'WL-PREP-COMPLETED', stage: 'in_review', status: 'completed' },
    { ...BASE_ITEM, id: 'WL-PREP-DELETED-STATUS', stage: 'idea', status: 'deleted' },
    { ...BASE_ITEM, id: 'WL-PREP-SOFT-DELETED', stage: 'idea', deletedBy: 'producer' },
  ],
});

const MAIN_LOG_ENTRIES_JSON = JSON.stringify([
  // Fresh plan marker at the item's CURRENT stage → dispatch-marker.
  {
    itemId: 'WL-PREP-MARKER',
    kind: 'plan',
    stage: 'intake_complete',
    dispatchedAt: '2026-11-23T09:00:00.000Z',
  },
  // Three attempts at the item's current stage → attempt budget (3). The
  // markers they leave are 3 days old, i.e. past the 24 h staleness window,
  // which is exactly the real dispatcher's window: a stale marker no longer
  // excludes, the attempt cap still does.
  {
    itemId: 'WL-PREP-ATTEMPT-BUDGET',
    kind: 'intake',
    stage: 'idea',
    dispatchedAt: '2026-11-20T09:00:00.000Z',
  },
  {
    itemId: 'WL-PREP-ATTEMPT-BUDGET',
    kind: 'intake',
    stage: 'idea',
    dispatchedAt: '2026-11-20T10:00:00.000Z',
  },
  {
    itemId: 'WL-PREP-ATTEMPT-BUDGET',
    kind: 'intake',
    stage: 'idea',
    dispatchedAt: '2026-11-20T11:00:00.000Z',
  },
  // One stale marker only: released by the staleness window.
  {
    itemId: 'WL-PREP-STALE-MARKER',
    kind: 'intake',
    stage: 'idea',
    dispatchedAt: '2026-11-20T12:00:00.000Z',
  },
  // Fresh marker at the PREVIOUS stage: released by stage advancement.
  {
    itemId: 'WL-PREP-ADVANCED-MARKER',
    kind: 'intake',
    stage: 'idea',
    dispatchedAt: '2026-11-23T09:30:00.000Z',
  },
  // Young non-terminal pane close → cooldown.
  {
    entryType: 'pane-close',
    itemId: 'WL-PREP-COOLDOWN',
    kind: 'plan',
    stage: 'intake_complete',
    timestamp: '2026-11-23T10:10:00.000Z',
    reasonCode: 'pane-died',
  },
]);

const mainContext = (): PrepSupplyContext => ({
  now: NOW,
  logEntries: frozenEntries(MAIN_LOG_ENTRIES_JSON),
  blockerStatusById: {
    'WL-BLOCKER-OPEN': 'open',
    'WL-BLOCKER-DONE': 'completed',
    // 'WL-BLOCKER-MISSING' is deliberately absent.
  },
});

function mainWindow(): PrepSupplyRootWindow {
  const fixture = frozenWindow(MAIN_WINDOW_JSON);
  return classifyPrepSupplyWindow(fixture.root, fixture.items, mainContext());
}

// ── Vocabulary and the documented table ───────────────────────────────

describe('prep-supply vocabulary', () => {
  it('maps only the two prep stages, and maps them to the classifier kinds', () => {
    expect([...PREP_SUPPLY_STAGES]).toEqual(['idea', 'intake_complete']);
    expect(prepSupplyKindForStage('idea')).toBe('intake');
    expect(prepSupplyKindForStage('intake_complete')).toBe('plan');
    for (const stage of ['plan_complete', 'in_review', 'done', '', undefined, null]) {
      expect(prepSupplyKindForStage(stage)).toBeNull();
    }
  });

  it('matches the documented bucket table in docs/dev/downtime-dispatcher.md', () => {
    // One source of truth in two places: the exported constant and the table.
    // Drift in EITHER fails here — a rename cannot land in only one of them.
    const doc = fs.readFileSync(
      path.join(REPO_ROOT, 'docs/dev/downtime-dispatcher.md'),
      'utf-8',
    );
    const heading = '### Prep-supply buckets';
    const start = doc.indexOf(heading);
    expect(start, `docs/dev/downtime-dispatcher.md has no "${heading}" section`).toBeGreaterThan(-1);
    const rest = doc.slice(start + heading.length);
    const end = rest.indexOf('\n### ');
    const section = end === -1 ? rest : rest.slice(0, end);

    expect(section).toContain('PREP_SUPPLY_BUCKETS');
    expect(section).toContain('downtime-worker.prep-supply.test.ts');
    for (const stage of PREP_SUPPLY_STAGES) expect(section).toContain(`\`${stage}\``);

    // The numbered rows of the bucket table, in document order.
    const rows = section
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^\|\s*\d+\s*\|/.test(line));
    expect(rows.length, 'the documented bucket table has no numbered rows').toBe(
      PREP_SUPPLY_BUCKETS.length,
    );
    const documented = rows.map((row) => row.split('|')[2].trim().replace(/`/g, ''));
    expect(documented).toEqual([...PREP_SUPPLY_BUCKETS]);

    // Every row explains WHY, and the exclusions are spelled out too.
    for (const row of rows) {
      const cells = row.split('|').slice(1, -1).map((cell) => cell.trim());
      expect(cells.length, `bucket row is not a 4-column table row: ${row}`).toBe(4);
      expect(cells[1].length).toBeGreaterThan(0);
      expect(cells[2].length).toBeGreaterThan(0);
      expect(cells[3].length).toBeGreaterThan(0);
    }
    for (const exclusion of ['soft-deleted', 'terminal-status', 'not-prep-stage']) {
      expect(section).toContain(`\`${exclusion}\``);
    }
    expect(section).toContain('`plan_complete` is an implement candidate');
  });
});

// ── One bucket per cause ──────────────────────────────────────────────

describe('prep-supply buckets — single cause per item', () => {
  it('classifies every documented bucket from the fixture window', () => {
    const result = mainWindow();
    expect(result.root).toBe('/home/rgardler/projects/ContextHub');

    const expected: Record<string, PrepSupplyBucket> = {
      'WL-PREP-OFFERABLE': 'offerable',
      'WL-PREP-IDEA-OFFERABLE': 'offerable',
      'WL-PREP-DISPATCHER-CLAIM': 'offerable',
      'WL-PREP-PRODUCER-REVIEW': 'producer-review',
      'WL-PREP-MARKER': 'dispatch-marker',
      'WL-PREP-ASSIGNEE': 'assignee-hold',
      'WL-PREP-DEPENDENCY': 'dependency',
      'WL-PREP-DEPENDENCY-MET': 'offerable',
      'WL-PREP-DEPENDENCY-UNRESOLVED': 'dependency',
      'WL-PREP-STARTON': 'startOn',
      'WL-PREP-ATTEMPT-BUDGET': 'attempt-budget',
      'WL-PREP-STALE-MARKER': 'offerable',
      'WL-PREP-ADVANCED-MARKER': 'offerable',
      'WL-PREP-COOLDOWN': 'cooldown',
      'WL-PREP-OTHER-GATED': 'other-gated',
    };
    for (const [id, bucket] of Object.entries(expected)) {
      expect(bucketOf(result, id), `${id} bucket`).toBe(bucket);
    }

    // Every bucket in the documented vocabulary is exercised by this window.
    for (const bucket of PREP_SUPPLY_BUCKETS) {
      expect(result.counts[bucket], `bucket ${bucket} is never exercised`).toBeGreaterThan(0);
    }
  });

  it('reports the classifier gate token for every classifier-attributed refusal', () => {
    const result = mainWindow();
    const gateOf = (id: string) => result.verdicts.find((v) => v.id === id)?.classifierGate;
    expect(gateOf('WL-PREP-PRODUCER-REVIEW')).toBe('producer-review');
    expect(gateOf('WL-PREP-ASSIGNEE')).toBe('assignee-hold');
    expect(gateOf('WL-PREP-STARTON')).toBe('startOnNotReached');
    expect(gateOf('WL-PREP-OTHER-GATED')).toBe('not-dispatchable');
    // Dispatching-side gates have no classifier token: they are not classifier predicates.
    expect(gateOf('WL-PREP-ATTEMPT-BUDGET')).toBeUndefined();
    expect(gateOf('WL-PREP-COOLDOWN')).toBeUndefined();
  });

  it('names the offerable set and agrees with the classifier kind', () => {
    const result = mainWindow();
    expect(result.offerable).toEqual([
      'WL-PREP-ADVANCED-MARKER',
      'WL-PREP-DEPENDENCY-MET',
      'WL-PREP-DISPATCHER-CLAIM',
      'WL-PREP-IDEA-OFFERABLE',
      'WL-PREP-OFFERABLE',
      'WL-PREP-STALE-MARKER',
    ]);
    const items = window(MAIN_WINDOW_JSON).items;
    for (const id of result.offerable) {
      const item = items.find((candidate) => candidate.id === id);
      expect(item, `offerable id ${id} is not in the window`).toBeDefined();
      const detail = classifyItemForDispatchDetail(item as PrepSupplyItem, NOW);
      const verdict = result.verdicts.find((v) => v.id === id);
      // `risk-effort` is not prep supply; every prep offerable item is
      // plan/intake, exactly what the classifier says.
      expect(detail.kind).toBe(verdict?.kind);
      expect(verdict?.kind === 'plan' || verdict?.kind === 'intake').toBe(true);
    }
  });

  it('keeps every item in exactly one place and every count derivable', () => {
    const fixture = window(MAIN_WINDOW_JSON);
    const result = mainWindow();
    const bucketIds = everyBucketId(result);
    const excludedIds = result.excluded.map((entry) => entry.id);

    // No item is double-counted, and nothing is silently dropped.
    expect(new Set(bucketIds).size).toBe(bucketIds.length);
    expect(new Set(excludedIds).size).toBe(excludedIds.length);
    expect([...bucketIds, ...excludedIds].sort()).toEqual(
      fixture.items.map((item) => item.id).sort(),
    );
    for (const bucket of PREP_SUPPLY_BUCKETS) {
      expect(result.counts[bucket]).toBe(result.buckets[bucket].length);
      expect(result.buckets[bucket]).toEqual([...result.buckets[bucket]].sort());
    }
    expect(result.counts.offerable).toBe(result.offerable.length);
    expect(result.verdicts.map((verdict) => verdict.id)).toEqual(
      fixture.items.map((item) => item.id).sort(),
    );
  });
});

// ── Precedence: one primary cause when several apply ──────────────────

describe('prep-supply bucket precedence', () => {
  // Each item carries MULTIPLE simultaneous causes; the expected bucket is
  // the highest-ranked one. The adjacent pairs below chain into the full
  // documented order (producer-review → dispatch-marker → holds →
  // attempt-budget → cooldown → offerable).
  const PRECEDENCE_WINDOW_JSON = JSON.stringify({
    root: '/home/rgardler/projects/AI_Hell',
    items: [
      {
        ...BASE_ITEM,
        id: 'WL-MULTI-ALL',
        stage: 'idea',
        needsProducerReview: true,
        assignee: 'Map',
        startOn: '2026-12-01T00:00:00.000Z',
        dependencies: [{ from: 'WL-MULTI-ALL', to: 'WL-BLOCKER-OPEN' }],
      },
      {
        ...BASE_ITEM,
        id: 'WL-MULTI-MARKER-HOLD',
        stage: 'idea',
        assignee: 'Map',
        dependencies: [{ from: 'WL-MULTI-MARKER-HOLD', to: 'WL-BLOCKER-OPEN' }],
      },
      {
        ...BASE_ITEM,
        id: 'WL-MULTI-ASSIGNEE-DEP-STARTON',
        stage: 'idea',
        assignee: 'Map',
        startOn: '2026-12-01T00:00:00.000Z',
        dependencies: [{ from: 'WL-MULTI-ASSIGNEE-DEP-STARTON', to: 'WL-BLOCKER-OPEN' }],
      },
      {
        ...BASE_ITEM,
        id: 'WL-MULTI-DEP-STARTON',
        stage: 'idea',
        startOn: '2026-12-01T00:00:00.000Z',
        dependencies: [{ from: 'WL-MULTI-DEP-STARTON', to: 'WL-BLOCKER-OPEN' }],
      },
      {
        ...BASE_ITEM,
        id: 'WL-MULTI-STARTON-BUDGET',
        stage: 'idea',
        startOn: '2026-12-01T00:00:00.000Z',
      },
      { ...BASE_ITEM, id: 'WL-MULTI-BUDGET-COOLDOWN', stage: 'idea' },
    ],
  });

  const PRECEDENCE_LOG_ENTRIES_JSON = JSON.stringify([
    // WL-MULTI-ALL: fresh marker + young close on top of every hold.
    {
      itemId: 'WL-MULTI-ALL',
      kind: 'intake',
      stage: 'idea',
      dispatchedAt: '2026-11-23T09:45:00.000Z',
    },
    {
      entryType: 'pane-close',
      itemId: 'WL-MULTI-ALL',
      kind: 'intake',
      stage: 'idea',
      timestamp: '2026-11-23T10:12:00.000Z',
      reasonCode: 'pane-died',
    },
    // A fresh marker at the current stage, on top of an assignee + dependency.
    {
      itemId: 'WL-MULTI-MARKER-HOLD',
      kind: 'intake',
      stage: 'idea',
      dispatchedAt: '2026-11-23T09:45:00.000Z',
    },
    // Stale attempts: the marker is released, the attempt cap is not.
    ...[
      ['09:00:00', '10:00:00', '11:00:00'].map((time, index) => ({
        itemId: 'WL-MULTI-STARTON-BUDGET',
        kind: 'intake',
        stage: 'idea',
        dispatchedAt: `2026-11-20T${time}.000Z`,
        title: `stale attempt ${index}`,
      })),
      [
        '09:00:00',
        '10:00:00',
        '11:00:00',
      ].map((time, index) => ({
        itemId: 'WL-MULTI-BUDGET-COOLDOWN',
        kind: 'intake',
        stage: 'idea',
        dispatchedAt: `2026-11-20T${time}.000Z`,
        title: `stale attempt ${index}`,
      })),
    ].flat(),
    {
      entryType: 'pane-close',
      itemId: 'WL-MULTI-BUDGET-COOLDOWN',
      kind: 'intake',
      stage: 'idea',
      timestamp: '2026-11-23T10:05:00.000Z',
      reasonCode: 'pane-died',
    },
  ]);

  const context = (): PrepSupplyContext => ({
    now: NOW,
    logEntries: frozenEntries(PRECEDENCE_LOG_ENTRIES_JSON),
    blockerStatusById: { 'WL-BLOCKER-OPEN': 'open' },
  });

  function precedenceWindow(): PrepSupplyRootWindow {
    const fixture = frozenWindow(PRECEDENCE_WINDOW_JSON);
    return classifyPrepSupplyWindow(fixture.root, fixture.items, context());
  }

  const items = () => window(PRECEDENCE_WINDOW_JSON).items;
  const itemOf = (id: string): PrepSupplyItem =>
    items().find((item) => item.id === id) as PrepSupplyItem;
  const entries = () => context().logEntries ?? [];

  it('producer-review outranks every other simultaneous cause', () => {
    const item = itemOf('WL-MULTI-ALL');
    // Prove the causes really are simultaneous before asserting the winner.
    expect(item.needsProducerReview).toBe(true);
    expect(isAssigneeHeld(item)).toBe(true);
    expect(item.dependencies?.length).toBe(1);
    expect(Date.parse(item.startOn as string)).toBeGreaterThan(NOW);
    const marker = dispatchedItemMarkers([...entries()], 'intake').get(item.id);
    expect(marker).toBeDefined();
    expect(markerStillExcludes(marker!, item.stage, NOW, 24 * 60 * 60 * 1000, 'stage-guard')).toBe(true);

    expect(bucketOf(precedenceWindow(), 'WL-MULTI-ALL')).toBe('producer-review');
  });

  it('an outstanding dispatch marker outranks a scheduling hold', () => {
    const item = itemOf('WL-MULTI-MARKER-HOLD');
    const marker = dispatchedItemMarkers([...entries()], 'intake').get(item.id);
    expect(isAssigneeHeld(item)).toBe(true);
    expect(markerStillExcludes(marker!, item.stage, NOW, 24 * 60 * 60 * 1000, 'stage-guard')).toBe(true);

    expect(bucketOf(precedenceWindow(), 'WL-MULTI-MARKER-HOLD')).toBe('dispatch-marker');
  });

  it('assignee-hold outranks a dependency and a future startOn', () => {
    const item = itemOf('WL-MULTI-ASSIGNEE-DEP-STARTON');
    expect(isAssigneeHeld(item)).toBe(true);
    expect(item.dependencies?.length).toBe(1);
    expect(Date.parse(item.startOn as string)).toBeGreaterThan(NOW);

    expect(bucketOf(precedenceWindow(), 'WL-MULTI-ASSIGNEE-DEP-STARTON')).toBe('assignee-hold');
  });

  it('a dependency outranks a future startOn', () => {
    const item = itemOf('WL-MULTI-DEP-STARTON');
    expect(item.dependencies?.length).toBe(1);
    expect(Date.parse(item.startOn as string)).toBeGreaterThan(NOW);

    expect(bucketOf(precedenceWindow(), 'WL-MULTI-DEP-STARTON')).toBe('dependency');
  });

  it('a future startOn outranks attempt-budget exhaustion', () => {
    const item = itemOf('WL-MULTI-STARTON-BUDGET');
    expect(Date.parse(item.startOn as string)).toBeGreaterThan(NOW);
    expect(
      isAttemptBudgetExhausted([...entries()], item.id, 'intake', item.stage, 3),
    ).toBe(true);
    // The stale attempts released their markers, so ONLY the budget still holds.
    const marker = dispatchedItemMarkers([...entries()], 'intake').get(item.id);
    expect(markerStillExcludes(marker!, item.stage, NOW, 24 * 60 * 60 * 1000, 'stage-guard')).toBe(false);

    expect(bucketOf(precedenceWindow(), 'WL-MULTI-STARTON-BUDGET')).toBe('startOn');
  });

  it('attempt-budget exhaustion outranks a non-terminal cooldown', () => {
    const item = itemOf('WL-MULTI-BUDGET-COOLDOWN');
    expect(
      isAttemptBudgetExhausted([...entries()], item.id, 'intake', item.stage, 3),
    ).toBe(true);
    expect(
      isNonTerminalCooldownActive(
        [...entries()],
        item.id,
        'intake',
        item.stage,
        30 * 60 * 1000,
        NOW,
      ),
    ).toBe(true);

    expect(bucketOf(precedenceWindow(), 'WL-MULTI-BUDGET-COOLDOWN')).toBe('attempt-budget');
  });

  it('reports exactly one primary cause per multi-cause item', () => {
    const result = precedenceWindow();
    // Every multi-cause item lands in exactly one bucket and none is offered:
    // each of these fixtures has at least one genuine refusal cause.
    const allIds = everyBucketId(result);
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(result.counts.offerable).toBe(0);
    expect(result.excluded).toEqual([]);
    for (const item of items()) expect(bucketOf(result, item.id)).not.toBeNull();
  });
});

// ── Negative scope: what is never prep supply ─────────────────────────

describe('prep-supply scope exclusions', () => {
  it('never counts a plan_complete item as prep supply', () => {
    const result = mainWindow();
    expect(bucketOf(result, 'WL-PREP-PLAN-COMPLETE')).toBeNull();
    expect(exclusionOf(result, 'WL-PREP-PLAN-COMPLETE')).toBe('not-prep-stage');
    expect(everyBucketId(result)).not.toContain('WL-PREP-PLAN-COMPLETE');
    // Sanity: it IS an implement candidate for the dispatcher, so the exclusion
    // is a prep-supply scoping decision and not a classifier refusal.
    const item = window(MAIN_WINDOW_JSON).items.find((i) => i.id === 'WL-PREP-PLAN-COMPLETE');
    expect(classifyItemForDispatchDetail(item as PrepSupplyItem, NOW).kind).toBe('implement');
  });

  it('never puts completed / in_review / deleted items in any bucket', () => {
    const result = mainWindow();
    const neverSupply = [
      'WL-PREP-COMPLETED',
      'WL-PREP-DELETED-STATUS',
      'WL-PREP-SOFT-DELETED',
    ];
    for (const id of neverSupply) {
      expect(bucketOf(result, id)).toBeNull();
      expect(everyBucketId(result)).not.toContain(id);
    }
    expect(exclusionOf(result, 'WL-PREP-COMPLETED')).toBe('terminal-status');
    expect(exclusionOf(result, 'WL-PREP-DELETED-STATUS')).toBe('terminal-status');
    expect(exclusionOf(result, 'WL-PREP-SOFT-DELETED')).toBe('soft-deleted');
  });

  it('classifies a single item with the same rules as a window', () => {
    const items = window(MAIN_WINDOW_JSON).items;
    const ctx = mainContext();
    const result = mainWindow();
    for (const item of items) {
      const single = classifyPrepSupplyItem(item, ctx);
      expect(single).toEqual(result.verdicts.find((verdict) => verdict.id === item.id));
    }
  });
});

// ── Read-only contract ────────────────────────────────────────────────

describe('prep-supply read-only contract', () => {
  const modulePath = path.join(HERE, 'downtime-worker.prep-supply.ts');
  const moduleSource = fs.readFileSync(modulePath, 'utf-8');
  const codeOnly = moduleSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('imports no I/O, no subprocess and no wl CLI seam', () => {
    // The only way a pure module can write is through what it imports, so the
    // import list is the read-only boundary: sibling pure predicates only.
    const specifiers = [...moduleSource.matchAll(/from\s+'([^']+)'/g)]
      .map((match) => match[1])
      .sort();
    expect(specifiers).toEqual([
      './downtime-log-entries.js',
      './downtime-log-markers.js',
      './downtime-worker.constants.js',
      './downtime-worker.gates.js',
      './downtime-worker.offer-attribution.js',
      './downtime-worker.selection.js',
      './downtime-worker.types.js',
    ]);
    for (const forbidden of ['node:fs', 'node:child_process', './fetcher.js', './cli-spawn.js']) {
      expect(specifiers).not.toContain(forbidden);
    }
    for (const token of ['child_process', 'execFile', 'spawn(', 'writeFile', 'appendFile']) {
      expect(codeOnly, `report module must not reference ${token}`).not.toContain(token);
    }
  });

  it('declares no module-scope mutable state (so it cannot change a dispatch)', () => {
    expect(codeOnly).not.toMatch(/^(let|var)\s/m);
  });

  it('leaves the dispatcher classification byte-identical', () => {
    const items = window(MAIN_WINDOW_JSON).items;
    const before = items.map((item) => classifyItemForDispatchDetail(item, NOW));
    // Run the report over the same window ...
    const result = mainWindow();
    // ... and the dispatcher's own decisions must be untouched.
    const after = items.map((item) => classifyItemForDispatchDetail(item, NOW));
    expect(after).toEqual(before);
    // For every bucket with a classifier-attributed refusal, the report quotes
    // the classifier rather than disagreeing with it.
    for (const verdict of result.verdicts) {
      if (verdict.bucket === null || verdict.classifierGate === undefined) continue;
      const item = items.find((candidate) => candidate.id === verdict.id) as PrepSupplyItem;
      expect(classifyItemForDispatchDetail(item, NOW).gate).toBe(verdict.classifierGate);
    }
  });

  it('does not mutate the frozen fixture input', () => {
    const fixture = frozenWindow(MAIN_WINDOW_JSON);
    const entries = frozenEntries(MAIN_LOG_ENTRIES_JSON);
    const before = JSON.stringify({ items: fixture.items, entries });
    // Frozen objects throw on assignment in strict mode: a mutation would fail
    // this call rather than pass silently.
    const result = classifyPrepSupplyWindow(fixture.root, fixture.items, {
      ...mainContext(),
      logEntries: entries,
    });
    expect(result.counts.offerable).toBeGreaterThan(0);
    expect(JSON.stringify({ items: fixture.items, entries })).toBe(before);
  });
});
