/**
 * packages/herdr/src/long-running-panes.test.ts — unit tests for the pure
 * long-running pane detector (WL-0MVKNC2N50025HXE AC2).
 *
 * The detector flags a live-agent pane whose non-terminal item has had no
 * observable progress for the configured window — INCLUDING while the agent
 * is `working` (the exact case every other recovery mechanism deliberately
 * skips). It is OBSERVATION ONLY: nothing can resume, prompt or close a
 * pane, so surfacing a flag can never interrupt legitimate long work.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyLongRunningPane,
  scanLongRunningPanes,
  clampDowntimeLongRunningThresholdMs,
  DEFAULT_DOWNTIME_LONG_RUNNING_THRESHOLD_MS,
  DOWNTIME_LONG_RUNNING_THRESHOLD_FLOOR_MS,
  DOWNTIME_LONG_RUNNING_THRESHOLD_MAX_MS,
  type LongRunningScanDeps,
  type LongRunningScanOptions,
  type LongRunningPaneObservation,
} from './long-running-panes.js';
import type { DowntimeItemInfo, HerdrPaneRecord } from './downtime-worker.js';
import type { DowntimeLogEntry } from './downtime-log.js';

const NOW = Date.parse('2026-10-08T12:00:00.000Z');
const THRESHOLD = 3 * 60 * 60 * 1000;
const ITEM_ID = 'WL-0ABCDEF123456789';

function pane(overrides: Partial<HerdrPaneRecord> = {}): HerdrPaneRecord {
  return {
    paneId: 'pane-1',
    label: `Manually triggered implement Fix the widget - ${ITEM_ID}`,
    agent: 'pi',
    agentStatus: 'working',
    ...overrides,
  };
}

function item(overrides: Partial<DowntimeItemInfo> = {}): DowntimeItemInfo {
  return {
    id: ITEM_ID,
    status: 'open',
    stage: 'plan_complete',
    risk: 'low',
    effort: 'small',
    // Default: the item has not progressed for 4 hours → past the 3 h window.
    updatedAt: new Date(NOW - 4 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function classify(
  p: HerdrPaneRecord = pane(),
  i: DowntimeItemInfo = item(),
  entries: DowntimeLogEntry[] = [],
) {
  return classifyLongRunningPane(p, i, { entries }, NOW, THRESHOLD);
}

describe('clampDowntimeLongRunningThresholdMs', () => {
  it('clamps to the supported [1 h, 48 h] range', () => {
    expect(clampDowntimeLongRunningThresholdMs(1000)).toBe(DOWNTIME_LONG_RUNNING_THRESHOLD_FLOOR_MS);
    expect(clampDowntimeLongRunningThresholdMs(100 * 60 * 60 * 1000)).toBe(
      DOWNTIME_LONG_RUNNING_THRESHOLD_MAX_MS,
    );
    expect(clampDowntimeLongRunningThresholdMs(6 * 60 * 60 * 1000)).toBe(6 * 60 * 60 * 1000);
  });

  it('falls back to the default on non-finite/invalid values', () => {
    expect(clampDowntimeLongRunningThresholdMs(Number.NaN)).toBe(
      DEFAULT_DOWNTIME_LONG_RUNNING_THRESHOLD_MS,
    );
  });
});

describe('classifyLongRunningPane (WL-0MVKNC2N50025HXE AC2)', () => {
  it('flags a WORKING agent whose item has not progressed past the window', () => {
    // The headline regression: `agent_status: working` does NOT exclude the
    // pane — that is precisely what the detector exists for.
    expect(classify()).toEqual({
      longRunning: true,
      itemId: ITEM_ID,
      kind: 'implement',
      lastActivityAt: Date.parse(item().updatedAt as string),
      stalledForMs: 4 * 60 * 60 * 1000,
      agentStatus: 'working',
      stage: 'plan_complete',
    });
  });

  it('does not flag when the item progressed within the window', () => {
    const i = item({ updatedAt: new Date(NOW - 60 * 1000).toISOString() });
    expect(classify(pane(), i)).toEqual({ longRunning: false, reason: 'progress-recent' });
  });

  it('flags at exactly the threshold boundary (>= threshold semantics)', () => {
    // "no progress for AT LEAST the window" — the boundary itself is flagged.
    const atBoundary = item({ updatedAt: new Date(NOW - THRESHOLD).toISOString() });
    expect(classify(pane(), atBoundary)).toMatchObject({ longRunning: true, stalledForMs: THRESHOLD });
    // One millisecond short of the window is still fresh.
    const justShort = item({ updatedAt: new Date(NOW - THRESHOLD + 1).toISOString() });
    expect(classify(pane(), justShort)).toEqual({ longRunning: false, reason: 'progress-recent' });
  });

  it('reports the flag for every dispatch kind', () => {
    // Each kind is paired with an ACTIVE stage it has not advanced past.
    const stages: Record<string, string> = {
      intake: 'idea',
      plan: 'intake_complete',
      implement: 'plan_complete',
      'risk-effort': 'plan_complete',
      audit: 'plan_complete',
    };
    for (const [kind, stage] of Object.entries(stages)) {
      const p = pane({
        label: `Downtime triggered ${kind} Some task - ${ITEM_ID}`,
        agentStatus: 'running',
      });
      const decision = classify(p, item({ stage }));
      expect(decision).toMatchObject({ longRunning: true, kind, agentStatus: 'running' });
    }
  });

  it('extends the progress anchor with the most recent dispatch marker for the kind', () => {
    // Item last updated 4 h ago, but the pane was (re)dispatched 1 min ago:
    // progress is recent — the pane must NOT be flagged.
    const entries: DowntimeLogEntry[] = [
      {
        itemId: ITEM_ID,
        kind: 'implement',
        cwd: '/repo',
        dispatchedAt: new Date(NOW - 60 * 1000).toISOString(),
      },
    ];
    expect(classify(pane(), item(), entries)).toEqual({
      longRunning: false,
      reason: 'progress-recent',
    });
    // An older standalone marker (2 h) does not reach the 3 h window either.
    const older: DowntimeLogEntry[] = [
      {
        itemId: ITEM_ID,
        kind: 'implement',
        cwd: '/repo',
        dispatchedAt: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
      },
    ];
    expect(classify(pane(), item(), older)).toEqual({
      longRunning: false,
      reason: 'progress-recent',
    });
    // Spawn-failed and enrichment entries never extend the anchor.
    const staleOnly: DowntimeLogEntry[] = [
      {
        itemId: ITEM_ID,
        kind: 'implement',
        cwd: '/repo',
        dispatchedAt: new Date(NOW - 60 * 1000).toISOString(),
        outcome: 'spawn-failed',
      },
      {
        itemId: ITEM_ID,
        kind: 'implement',
        cwd: '/repo',
        dispatchedAt: new Date(NOW - 60 * 1000).toISOString(),
        enrichment: true,
      },
    ];
    expect(classify(pane(), item(), staleOnly).longRunning).toBe(true);
  });

  it('skips panes without a live agent, an item id or a kind', () => {
    expect(classify(pane({ agent: undefined }))).toEqual({ longRunning: false, reason: 'no-agent' });
    expect(
      classify(pane({ label: 'Manually triggered implement Fix the widget' })),
    ).toEqual({ longRunning: false, reason: 'no-item-id' });
    expect(
      classify(pane({ label: `Manually triggered prompt hello - ${ITEM_ID}` })),
    ).toEqual({ longRunning: false, reason: 'kind-unknown' });
  });

  it('skips terminal items and items that already advanced past the pane kind', () => {
    expect(classify(pane(), item({ status: 'completed', stage: 'in_review' }))).toEqual({
      longRunning: false,
      reason: 'item-terminal',
    });
    // An intake pane on an item now at intake_complete: the item moved on —
    // the pane is finishing up, not stuck (still an ACTIVE item).
    expect(
      classify(
        pane({ label: `Downtime triggered intake Some task - ${ITEM_ID}` }),
        item({ stage: 'intake_complete' }),
      ),
    ).toEqual({ longRunning: false, reason: 'kind-stale' });
  });

  it('fails safe (never reports) when no progress anchor exists', () => {
    expect(classify(pane(), item({ updatedAt: undefined }))).toEqual({
      longRunning: false,
      reason: 'last-activity-unknown',
    });
  });
});

// ── Scan ──────────────────────────────────────────────────────────────

function makeDeps(overrides: Partial<LongRunningScanDeps> = {}): LongRunningScanDeps {
  return {
    listPanes: async () => [pane()],
    fetchItem: async (_id: string, _cwd: string) => ({
      ok: true,
      info: item(),
    }),
    readEntries: async () => [],
    resolveRoot: (p) => p.cwd ?? '/repo',
    ...overrides,
  };
}

function scanOpts(overrides: Partial<LongRunningScanOptions> = {}): LongRunningScanOptions {
  return { thresholdMs: THRESHOLD, now: NOW, ...overrides };
}

describe('scanLongRunningPanes (WL-0MVKNC2N50025HXE AC2)', () => {
  it('returns the flagged pane with its own root, ordered by stalledForMs DESC', async () => {
    const deps = makeDeps({
      listPanes: async () => [
        pane({ paneId: 'p-1', label: `Downtime triggered implement A - ${ITEM_ID}` }),
        pane({
          paneId: 'p-2',
          label: `Downtime triggered audit B - ${'WL-0ZZZZZZZZZZZZZZ9'}`,
          cwd: '/other-root',
        }),
      ],
      fetchItem: async (id, _cwd) => ({
        ok: true,
        info: id === 'WL-0ZZZZZZZZZZZZZZ9'
          ? item({ id: id, updatedAt: new Date(NOW - 20 * 60 * 60 * 1000).toISOString() })
          : item(),
      }),
    });
    const observations = await scanLongRunningPanes(deps, '/fallback', scanOpts());
    expect(observations.map((o) => o.paneId)).toEqual(['p-2', 'p-1']);
    expect(observations[0]).toMatchObject({
      itemId: 'WL-0ZZZZZZZZZZZZZZ9',
      cwd: '/other-root',
      kind: 'audit',
      stalledForMs: 20 * 60 * 60 * 1000,
    });
  });

  it('is fail-safe: an unreadable pane list, unresolvable roots and failed fetches yield []', async () => {
    expect(await scanLongRunningPanes(makeDeps({ listPanes: async () => null }), '/f', scanOpts()))
      .toEqual([]);
    expect(await scanLongRunningPanes(makeDeps({ listPanes: async () => [] }), '/f', scanOpts()))
      .toEqual([]);
    expect(
      await scanLongRunningPanes(
        makeDeps({
          listPanes: async () => [pane({ cwd: '/a' })],
          resolveRoot: () => null,
        }),
        '/f',
        scanOpts(),
      ),
    ).toEqual([]);
    expect(
      await scanLongRunningPanes(
        makeDeps({
          listPanes: async () => [pane()],
          fetchItem: async () => ({ ok: false }),
        }),
        '/f',
        scanOpts(),
      ),
    ).toEqual([]);
    // A throwing scan must never throw out of the dispatcher path either.
    await expect(
      scanLongRunningPanes(
        makeDeps({ listPanes: async () => { throw new Error('boom'); } }),
        '/f',
        scanOpts(),
      ),
    ).resolves.toEqual([]);
  });

  it('skips panes that are not long-running while keeping the rest', async () => {
    const deps = makeDeps({
      listPanes: async () => [
        pane({ paneId: 'p-stuck' }),
        pane({ paneId: 'p-fresh', label: `Downtime triggered implement Fresh - ${ITEM_ID}` }),
      ],
      fetchItem: async (_id, cwd) => ({
        ok: true,
        info: cwd === '/fresh'
          ? item({ updatedAt: new Date(NOW - 60 * 1000).toISOString() })
          : item(),
      }),
      resolveRoot: (p) => (p.paneId === 'p-fresh' ? '/fresh' : '/stuck'),
    });
    const observations = await scanLongRunningPanes(deps, '/fallback', scanOpts());
    expect(observations.map((o) => o.paneId)).toEqual(['p-stuck']);
  });

  it('bounds the returned observations and still includes the worst offenders', async () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      pane({ paneId: `p-${i}`, label: `Downtime triggered implement T${i} - ${ITEM_ID}` }),
    );
    // Each pane resolves to its own root; the fetch keys on that root so the
    // stall durations spread deterministically (p-0 → 6h … p-4 → 10h).
    const deps: LongRunningScanDeps = {
      listPanes: async () => many,
      fetchItem: async (_id: string, cwd: string) => ({
        ok: true,
        info: item({
          updatedAt: new Date(
            NOW - (6 + Number(cwd.replace('/p-', ''))) * 60 * 60 * 1000,
          ).toISOString(),
        }),
      }),
      readEntries: async () => [],
      resolveRoot: (p) => `/${p.paneId}`,
    };
    const observations = await scanLongRunningPanes(deps, '/f', scanOpts({ maxObservations: 2 }));
    expect(observations.length).toBe(2);
    // Descending stalledForMs = most stalled first.
    expect(observations[0].stalledForMs).toBeGreaterThan(observations[1].stalledForMs);
    expect(observations.map((o) => o.paneId)).toEqual(['p-4', 'p-3']);
  });

  it('attaches the item title when present', async () => {
    const deps = makeDeps({
      fetchItem: async () => ({ ok: true, info: item({ title: 'A stuck widget' }) }),
    });
    const observations = await scanLongRunningPanes(deps, '/f', scanOpts());
    expect(observations[0]?.title).toBe('A stuck widget');
  });
});
