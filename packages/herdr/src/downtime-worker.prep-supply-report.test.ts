/**
 * packages/herdr/src/downtime-worker.prep-supply-report.test.ts — the
 * per-root prep-supply REPORT (WL-0MWTBJ7G1004Y29B, child 2 of
 * WL-0MWTAD1KM0081UUD).
 *
 * The pure classifier is pinned by `downtime-worker.prep-supply.test.ts`
 * (child 1). This file pins the layer above it: the merge of the consolidated
 * `wl worklist --json` read with the full per-root fallback read, the
 * deterministic assembly of the per-root report, and the two renderings
 * (machine JSON + human table).
 *
 * Every input is inline JSON and every I/O seam is a fake, so no live worklog,
 * no `wl` subprocess and no filesystem state is touched. The fixtures are
 * frozen before use, so an accidental mutation throws instead of quietly
 * changing the measurement.
 *
 * The read-only contract is asserted LAST: running the report must leave the
 * dispatcher's own `classifyItemForDispatchDetail` decisions byte-identical,
 * and the report module must import only pure siblings (no I/O, no spawn).
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  PREP_SUPPLY_REPORT_SCHEMA_VERSION,
  buildPrepSupplyReport,
  collectPrepSupplyReport,
  mergePrepSupplySources,
  renderPrepSupplyReportJson,
  renderPrepSupplyReportTable,
  type PrepSupplyReport,
  type PrepSupplyReportDeps,
  type PrepSupplyRootInputs,
} from './downtime-worker.prep-supply-report.js';
import { PREP_SUPPLY_BUCKETS } from './downtime-worker.prep-supply.js';
import { classifyItemForDispatchDetail } from './downtime-worker.gates.js';
import type { DowntimeLogEntry } from './downtime-log-entries.js';
import type { PrepSupplyItem } from './downtime-worker.prep-supply.js';

// ── Fixture plumbing (inline JSON only) ───────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Frozen evaluation instant for every fixture: 2026-11-23T10:15:00Z. */
const NOW = Date.parse('2026-11-23T10:15:00.000Z');
const ROOT_A = '/home/x/projects/ContextHub';
const ROOT_B = '/home/x/projects/AI_Hell';

const BASE_ITEM = {
  status: 'open',
  assignee: '',
  createdAt: '2026-11-20T00:00:00.000Z',
  startOn: '2026-11-20T00:00:00.000Z',
} as const;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    const record = value as unknown as Record<string, unknown>;
    for (const key of Object.keys(record)) deepFreeze(record[key]);
    Object.freeze(value);
  }
  return value;
}

/** The full per-root read for ROOT_A: one item per bucket plus exclusions. */
const ITEMS_A: PrepSupplyItem[] = [
  { ...BASE_ITEM, id: 'WL-A-BUDGET', stage: 'idea' },
  { ...BASE_ITEM, id: 'WL-A-COOLDOWN', stage: 'intake_complete' },
  { ...BASE_ITEM, id: 'WL-A-COMPLETED', stage: 'in_review', status: 'completed' },
  {
    ...BASE_ITEM,
    id: 'WL-A-DEPENDENCY',
    stage: 'idea',
    status: 'blocked',
    dependencies: [{ from: 'WL-A-DEPENDENCY', to: 'WL-A-BLOCKER-OPEN' }],
  },
  { ...BASE_ITEM, id: 'WL-A-MARKER', stage: 'intake_complete' },
  { ...BASE_ITEM, id: 'WL-A-OFFERABLE-1', stage: 'idea' },
  { ...BASE_ITEM, id: 'WL-A-OFFERABLE-2', stage: 'intake_complete' },
  { ...BASE_ITEM, id: 'WL-A-OTHER-GATED', stage: 'intake_complete', status: 'in-progress' },
  { ...BASE_ITEM, id: 'WL-A-PLAN-COMPLETE', stage: 'plan_complete', risk: 'Medium', effort: 'S' },
  { ...BASE_ITEM, id: 'WL-A-PRODUCER-REVIEW', stage: 'idea', needsProducerReview: true },
  { ...BASE_ITEM, id: 'WL-A-SOFT-DELETED', stage: 'idea', deletedBy: 'producer' },
  { ...BASE_ITEM, id: 'WL-A-STARTON', stage: 'idea', startOn: '2026-12-01T00:00:00.000Z' },
  { ...BASE_ITEM, id: 'WL-A-ASSIGNEE', stage: 'idea', assignee: 'Map' },
];

const LOG_A: DowntimeLogEntry[] = [
  {
    itemId: 'WL-A-MARKER',
    kind: 'plan',
    stage: 'intake_complete',
    dispatchedAt: '2026-11-23T09:00:00.000Z',
  },
  // Three attempts at the current stage, all older than the 24 h staleness
  // window: the markers released, the attempt cap still holds.
  { itemId: 'WL-A-BUDGET', kind: 'intake', stage: 'idea', dispatchedAt: '2026-11-20T09:00:00.000Z' },
  { itemId: 'WL-A-BUDGET', kind: 'intake', stage: 'idea', dispatchedAt: '2026-11-20T10:00:00.000Z' },
  { itemId: 'WL-A-BUDGET', kind: 'intake', stage: 'idea', dispatchedAt: '2026-11-20T11:00:00.000Z' },
  // Young non-terminal pane close → cooldown.
  {
    entryType: 'pane-close',
    itemId: 'WL-A-COOLDOWN',
    kind: 'plan',
    stage: 'intake_complete',
    timestamp: '2026-11-23T10:10:00.000Z',
    reasonCode: 'pane-died',
  } as DowntimeLogEntry,
];

const BLOCKERS_A = {
  'WL-A-BLOCKER-OPEN': 'open',
};

/** ROOT_B has a single offerable prep item and nothing else. */
const ITEMS_B: PrepSupplyItem[] = [{ ...BASE_ITEM, id: 'WL-B-OFFERABLE', stage: 'idea' }];

/** The consolidated worklist read covers a SUBSET of ROOT_A's items. */
const WORKLIST_A: PrepSupplyItem[] = [
  // Worklist wins on item fields (title here is authoritative).
  { ...BASE_ITEM, id: 'WL-A-OFFERABLE-1', stage: 'idea', title: 'from worklist' },
  { ...BASE_ITEM, id: 'WL-A-PRODUCER-REVIEW', stage: 'idea', needsProducerReview: true },
  // Present ONLY in the worklist read (e.g. a critical prep item far down the
  // full list): the merge must keep it.
  { ...BASE_ITEM, id: 'WL-A-WORKLIST-ONLY', stage: 'idea' },
  // Not prep supply: included in the merged set so the exclusion is counted.
  { ...BASE_ITEM, id: 'WL-A-PLAN-COMPLETE', stage: 'plan_complete', title: 'from worklist' },
];

function frozenItems(): PrepSupplyItem[] {
  return deepFreeze(structuredClone(ITEMS_A));
}

function rootAInputs(overrides: Partial<PrepSupplyRootInputs> = {}): PrepSupplyRootInputs {
  return {
    root: ROOT_A,
    worklist: deepFreeze(structuredClone(WORKLIST_A)),
    full: {
      items: frozenItems(),
      blockerStatusById: deepFreeze({ ...BLOCKERS_A }),
    },
    logEntries: deepFreeze(structuredClone(LOG_A)),
    ...overrides,
  };
}

function rootBInputs(): PrepSupplyRootInputs {
  return {
    root: ROOT_B,
    worklist: [],
    full: { items: deepFreeze(structuredClone(ITEMS_B)) },
    logEntries: [],
  };
}

function report(): PrepSupplyReport {
  // Deliberately passed in NON-sorted order: the report must sort by root.
  return buildPrepSupplyReport([rootBInputs(), rootAInputs()], { now: NOW });
}

function rootOf(result: PrepSupplyReport, root: string) {
  const found = result.roots.find((candidate) => candidate.root === root);
  if (found === undefined) throw new Error(`root ${root} missing from report`);
  return found;
}

/** Fabricated I/O seam for `collectPrepSupplyReport` — reads only. */
function fakeDeps(overrides: Partial<PrepSupplyReportDeps> = {}): PrepSupplyReportDeps {
  return {
    readWorklist: async (root: string) => ({
      items: root === ROOT_A ? (rootAInputs().worklist as PrepSupplyItem[]) : [],
    }),
    readFull: async (root: string) =>
      root === ROOT_A
        ? { items: frozenItems(), blockerStatusById: { ...BLOCKERS_A } }
        : { items: deepFreeze(structuredClone(ITEMS_B)) },
    readLogEntries: async (root: string) =>
      root === ROOT_A ? (deepFreeze(structuredClone(LOG_A)) as DowntimeLogEntry[]) : [],
    ...overrides,
  };
}

// ── Per-root bucket counts and offerable ids ──────────────────────────

describe('prep-supply report buckets', () => {
  it('reports one bucket count per documented bucket for every root', () => {
    const result = report();
    expect(result.schemaVersion).toBe(PREP_SUPPLY_REPORT_SCHEMA_VERSION);
    expect(result.now).toBe('2026-11-23T10:15:00.000Z');
    // Lexicographic by path: AI_Hell sorts before ContextHub.
    expect(result.roots.map((root) => root.root)).toEqual([ROOT_B, ROOT_A]);

    const a = rootOf(result, ROOT_A);
    expect(a.counts).toEqual({
      'attempt-budget': 1,
      'assignee-hold': 1,
      'cooldown': 1,
      'dependency': 1,
      'dispatch-marker': 1,
      'offerable': 3,
      'other-gated': 1,
      'producer-review': 1,
      'startOn': 1,
    });
    expect(a.buckets.offerable).toEqual([
      'WL-A-OFFERABLE-1',
      'WL-A-OFFERABLE-2',
      'WL-A-WORKLIST-ONLY',
    ]);
    expect(a.offerable).toEqual(a.buckets.offerable);

    const b = rootOf(result, ROOT_B);
    expect(b.counts.offerable).toBe(1);
    expect(b.offerable).toEqual(['WL-B-OFFERABLE']);
  });

  it('lists the offerable ids per root in the top-level payload', () => {
    expect(report().offerable).toEqual([
      { root: ROOT_B, id: 'WL-B-OFFERABLE' },
      { root: ROOT_A, id: 'WL-A-OFFERABLE-1' },
      { root: ROOT_A, id: 'WL-A-OFFERABLE-2' },
      { root: ROOT_A, id: 'WL-A-WORKLIST-ONLY' },
    ]);
  });

  it('sums the buckets across roots', () => {
    const result = report();
    expect(result.totals.offerable).toBe(4);
    expect(result.totals['producer-review']).toBe(1);
    expect(result.totals['attempt-budget']).toBe(1);
  });

  it('counts out-of-scope items as exclusions instead of buckets', () => {
    const a = rootOf(report(), ROOT_A);
    expect(a.excluded).toEqual([
      { id: 'WL-A-COMPLETED', reason: 'terminal-status' },
      { id: 'WL-A-PLAN-COMPLETE', reason: 'not-prep-stage' },
      { id: 'WL-A-SOFT-DELETED', reason: 'soft-deleted' },
    ]);
  });
});

// ── The worklist gap and the full-read fallback ───────────────────────

describe('prep-supply report source merge', () => {
  it('unions the worklist read with the full per-root read and dedupes by id', () => {
    const merged = mergePrepSupplySources(rootAInputs());
    const ids = merged.items.map((item) => item.id);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
    // Fallback-only items are present ...
    expect(ids).toContain('WL-A-OFFERABLE-2');
    // ... and so is an item only the worklist read knows about.
    expect(ids).toContain('WL-A-WORKLIST-ONLY');
    expect(merged.coverage).toEqual({
      worklistItems: 4,
      fullItems: 13,
      mergedItems: 14,
      worklistOnly: 1,
      fullOnly: 10,
    });
  });

  it('prefers the worklist item fields but keeps the fallback dependency edges', () => {
    const merged = mergePrepSupplySources(rootAInputs());
    const offerable = merged.items.find((item) => item.id === 'WL-A-OFFERABLE-1');
    expect(offerable?.title).toBe('from worklist');
    const dependency = merged.items.find((item) => item.id === 'WL-A-DEPENDENCY');
    expect(dependency?.dependencies).toEqual([
      { from: 'WL-A-DEPENDENCY', to: 'WL-A-BLOCKER-OPEN' },
    ]);
    expect(merged.blockerStatusById['WL-A-BLOCKER-OPEN']).toBe('open');
  });

  it('still classifies when a root has no full read (worklist-only coverage)', () => {
    const result = buildPrepSupplyReport(
      [{ root: ROOT_A, worklist: deepFreeze(structuredClone(WORKLIST_A)) }],
      { now: NOW },
    );
    const a = rootOf(result, ROOT_A);
    expect(a.coverage.fullItems).toBe(0);
    expect(a.coverage.mergedItems).toBe(4);
    // The worklist-only item is classified, not silently dropped.
    expect(a.counts.offerable).toBe(2);
  });
});

// ── Stability and rendering ───────────────────────────────────────────

describe('prep-supply report output', () => {
  it('is byte-identical across runs and input orders', () => {
    const first = renderPrepSupplyReportJson(report());
    const second = renderPrepSupplyReportJson(
      buildPrepSupplyReport([rootAInputs(), rootBInputs()], { now: NOW }),
    );
    expect(second).toBe(first);
  });

  it('orders roots, buckets and item ids deterministically', () => {
    const result = report();
    const roots = result.roots.map((root) => root.root);
    expect(roots).toEqual([...roots].sort());
    const buckets = Object.keys(rootOf(result, ROOT_A).counts);
    // "sorted by bucket": alphabetical, independent of precedence order.
    expect(buckets).toEqual([...PREP_SUPPLY_BUCKETS].sort());
    for (const root of result.roots) {
      for (const bucket of PREP_SUPPLY_BUCKETS) {
        const ids = root.buckets[bucket];
        expect(ids).toEqual([...ids].sort());
      }
    }
  });

  it('renders a human table with a row per bucket and the offerable ids', () => {
    const table = renderPrepSupplyReportTable(report());
    expect(table).toContain('# Prep-supply report — now 2026-11-23T10:15:00.000Z — 2 root(s)');
    expect(table).toContain(`## ${ROOT_A}`);
    // One table row per bucket, alphabetical, with the offerable ids spelled out.
    expect(table).toContain('| attempt-budget | 1 | WL-A-BUDGET |');
    expect(table).toContain(
      '| offerable | 3 | WL-A-OFFERABLE-1, WL-A-OFFERABLE-2, WL-A-WORKLIST-ONLY |',
    );
    expect(table).toContain('| producer-review | 1 | WL-A-PRODUCER-REVIEW |');
    // Exclusions are reported too, so nothing silently disappears.
    expect(table).toContain('excluded: not-prep-stage 1, soft-deleted 1, terminal-status 1');
    // Totals block.
    expect(table).toContain('## Totals');
    expect(table).toContain('| offerable | 4 |');
    // Table only — the machine payload is a separate renderer.
    expect(table).not.toContain('"schemaVersion"');
  });

  it('round-trips the JSON payload', () => {
    const json = renderPrepSupplyReportJson(report());
    const parsed = JSON.parse(json) as PrepSupplyReport;
    expect(parsed.roots.map((root) => root.root)).toEqual([ROOT_B, ROOT_A]);
    expect(parsed.totals.offerable).toBe(4);
  });
});

// ── I/O collection (root isolation) ───────────────────────────────────

describe('prep-supply report collection', () => {
  it('collects every root through the read-only seam', async () => {
    const result = await collectPrepSupplyReport(fakeDeps(), [ROOT_B, ROOT_A], { now: NOW });
    // Lexicographic by path: AI_Hell sorts before ContextHub.
    expect(result.roots.map((root) => root.root)).toEqual([ROOT_B, ROOT_A]);
    expect(result.totals.offerable).toBe(4);
  });

  it('isolates a failing root: other roots still report and the error is named', async () => {
    const deps = fakeDeps({
      readFull: async (root: string) => {
        if (root === ROOT_B) throw new Error('wl list failed: boom');
        return { items: frozenItems(), blockerStatusById: { ...BLOCKERS_A } };
      },
    });
    const result = await collectPrepSupplyReport(deps, [ROOT_A, ROOT_B], { now: NOW });
    const b = rootOf(result, ROOT_B);
    expect(b.error).toBe('wl list failed: boom');
    expect(b.counts.offerable).toBe(0);
    expect(rootOf(result, ROOT_A).counts.offerable).toBe(3);
    // The failing root contributes nothing to the totals ...
    expect(result.totals.offerable).toBe(3);
  });
});

// ── Read-only contract (AC4) ─────────────────────────────────────────

describe('prep-supply report read-only contract', () => {
  it('leaves the dispatcher decision set byte-identical', () => {
    const items = frozenItems();
    const decisions = (): string =>
      JSON.stringify(items.map((item) => [item.id, classifyItemForDispatchDetail(item, NOW)]));
    const before = decisions();
    const result = report();
    const after = decisions();
    expect(after).toBe(before);
    // The report quotes the classifier instead of disagreeing with it.
    const review = rootOf(result, ROOT_A).verdicts.find((v) => v.id === 'WL-A-PRODUCER-REVIEW');
    expect(review?.classifierGate).toBe('producer-review');
    expect(review?.bucket).toBe('producer-review');
  });

  it('does not mutate its frozen inputs', () => {
    const inputs = deepFreeze([rootBInputs(), rootAInputs()]);
    const before = JSON.stringify(inputs);
    buildPrepSupplyReport(inputs, { now: NOW });
    expect(JSON.stringify(inputs)).toBe(before);
  });

  it('wraps no I/O: the report module imports pure siblings only', async () => {
    // The read-only boundary IS the import list — a write needs an I/O seam.
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(path.join(HERE, 'downtime-worker.prep-supply-report.ts'), 'utf-8'),
    );
    const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)]
      .map((match) => match[1])
      .sort();
    expect(specifiers).toEqual([
      './downtime-log-entries.js',
      './downtime-worker.prep-supply.js',
    ]);
    const codeOnly = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const token of ['child_process', 'execFile', 'spawn(', 'writeFile', 'appendFile']) {
      expect(codeOnly, `report module must not reference ${token}`).not.toContain(token);
    }
  });
});
