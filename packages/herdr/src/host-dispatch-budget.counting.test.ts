/**
 * packages/herdr/src/host-dispatch-budget.counting.test.ts — the ONE in-flight
 * counting rule (WL-0MWFJDD8R005F5BV, parent WL-0MWFJD1RV008FCCR).
 *
 * Both surfaces used to derive "how many are in flight" from the ledger alone,
 * so a live implement pane whose entry was never written (or was lost) was
 * invisible to the header AND to the cap: on 2026-11-13 the header read
 * `implement 3/6` while 10 implement dispatches were running.
 *
 * This suite pins the union rule — `ledger entries + live dispatcher panes that
 * no entry accounts for` — and the fact that the worklist header and the
 * admission decision reach exactly the same figure.
 */

import { describe, expect, it } from 'vitest';

import { admitHostDispatch } from './host-dispatch-budget.admission.js';
import { countLiveWork, readHostBudgetLiveWork } from './host-dispatch-budget.counting.js';
import { HOST_BUDGET_STALE_WINDOW_MS } from './host-dispatch-budget.js';
import { readHostBudgetStatus } from './host-budget-status.js';
import {
  makeBudgetEntry,
  makeLivePaneList,
  withMachineDir,
  writeBudgetConfig,
  writeBudgetLedger,
} from './host-dispatch-budget.fixtures.js';

const NOW = Date.parse('2026-11-13T22:00:00.000Z');
const HOUR = 60 * 60 * 1000;

/** Pane-title builders matching the dispatcher's real forms. */
const implementPane = (itemId: string, decoration = '') =>
  `${decoration}Downtime triggered implement Do it - ${itemId}`;
const auditPane = (itemId: string) => `Downtime triggered audit Audit it - ${itemId}`;

describe('countLiveWork — the union rule (AC1/AC2)', () => {
  it('counts a live pane that owns an entry ONCE (AC2)', () => {
    const entries = [makeBudgetEntry({ itemId: 'WL-1', paneId: 'p:1' })];
    const panes = makeLivePaneList([{ paneId: 'p:1', title: implementPane('WL-1') }]);

    const work = countLiveWork(entries, panes, 'implement', NOW);

    expect(work.reserved).toBe(1);
    expect(work.unreservedPaneIds).toEqual([]);
    expect(work.live).toBe(1);
  });

  it('counts entry-only work (a reserved dispatch whose pane is not yet listed)', () => {
    const entries = [
      makeBudgetEntry({ itemId: 'WL-1', paneId: 'p:1' }),
      makeBudgetEntry({ itemId: 'WL-2', paneId: 'p:2' }),
    ];
    const panes = makeLivePaneList([
      { paneId: 'p:1', title: implementPane('WL-1') },
      { paneId: 'p:2', title: implementPane('WL-2') },
    ]);

    expect(countLiveWork(entries, panes, 'implement', NOW).live).toBe(2);
  });

  it('counts pane-only work — a live dispatch with no entry at all', () => {
    const panes = makeLivePaneList([
      { paneId: 'p:1', title: implementPane('WL-1') },
      { paneId: 'p:2', title: implementPane('WL-2') },
      { paneId: 'p:3', title: '⚠️ Downtime triggered implement Decorated - WL-3' },
      { paneId: 'p:4', title: 'Manually triggered implement Hand-fired - WL-4' },
    ]);

    const work = countLiveWork([], panes, 'implement', NOW);

    expect(work.reserved).toBe(0);
    expect(work.live).toBe(4);
    expect(work.unreservedPaneIds.sort()).toEqual(['p:1', 'p:2', 'p:3', 'p:4']);
  });

  it('counts ledger + unreserved panes together, with the pane evidence', () => {
    const entries = [makeBudgetEntry({ itemId: 'WL-1', paneId: 'p:1' })];
    const panes = makeLivePaneList([
      { paneId: 'p:1', title: implementPane('WL-1') },
      { paneId: 'p:2', title: implementPane('WL-2') },
    ]);

    const work = countLiveWork(entries, panes, 'implement', NOW);

    expect(work.reserved).toBe(1);
    expect(work.unreservedPaneIds).toEqual(['p:2']);
    expect(work.live).toBe(2);
  });

  it('never counts an audit pane against the implement tier', () => {
    const panes = makeLivePaneList([
      { paneId: 'p:1', title: implementPane('WL-1') },
      { paneId: 'p:2', title: auditPane('WL-2') },
      // Not a dispatcher pane at all.
      { paneId: 'p:3', title: 'rgardler@host: ~/projects/x' },
      { paneId: 'p:4', title: 'Downtime triggered plan Plan it - WL-4' },
    ]);

    const work = countLiveWork([], panes, 'implement', NOW);
    expect(work.live).toBe(1);
    expect(work.unreservedPaneIds).toEqual(['p:1']);
  });

  it('counts an unknown-tier dispatcher pane against implement (conservative)', () => {
    const panes = makeLivePaneList([
      { paneId: 'p:1', title: 'Downtime triggered mystery Do it - WL-1' },
    ]);
    expect(countLiveWork([], panes, 'implement', NOW).live).toBe(1);
  });

  it('keeps dead-but-present entries excluded (AC5)', () => {
    const entries = [
      // Stale AND its pane is gone: dead, excluded and reapable.
      makeBudgetEntry({
        itemId: 'WL-DEAD',
        paneId: 'p:dead',
        heartbeatAt: new Date(NOW - HOST_BUDGET_STALE_WINDOW_MS - HOUR).toISOString(),
      }),
      makeBudgetEntry({ itemId: 'WL-LIVE', paneId: 'p:live' }),
    ];
    const panes = makeLivePaneList([{ paneId: 'p:live', title: implementPane('WL-LIVE') }]);

    const work = countLiveWork(entries, panes, 'implement', NOW);
    expect(work.live).toBe(1);
    expect(work.reaped).toBe(1);
  });

  it('a stale-but-live implement entry still counts (pane-derived freshness)', () => {
    const entries = [
      makeBudgetEntry({
        itemId: 'WL-OLD',
        paneId: 'p:old',
        heartbeatAt: new Date(NOW - HOST_BUDGET_STALE_WINDOW_MS - HOUR).toISOString(),
      }),
    ];
    const panes = makeLivePaneList([{ paneId: 'p:old', title: implementPane('WL-OLD') }]);
    expect(countLiveWork(entries, panes, 'implement', NOW).live).toBe(1);
  });

  it('never invents panes on an UNKNOWN pane read (AC4)', () => {
    const entries = [
      makeBudgetEntry({ itemId: 'WL-FRESH', paneId: 'p:fresh' }),
      makeBudgetEntry({
        itemId: 'WL-STALE',
        paneId: 'p:stale',
        heartbeatAt: new Date(NOW - HOST_BUDGET_STALE_WINDOW_MS - HOUR).toISOString(),
      }),
    ];

    const work = countLiveWork(entries, undefined, 'implement', NOW);

    // Freshness rule only: the fresh entry counts, the stale one does not, and
    // no pane is invented (a failed read must not report a false zero either).
    expect(work.reserved).toBe(1);
    expect(work.unreservedPaneIds).toEqual([]);
    expect(work.live).toBe(1);
  });

  it('never double counts two panes that claim the same item', () => {
    const panes = makeLivePaneList([
      { paneId: 'p:1', title: implementPane('WL-1') },
      { paneId: 'p:2', title: implementPane('WL-1') },
    ]);
    expect(countLiveWork([], panes, 'implement', NOW).live).toBe(1);
  });
});

describe('readHostBudgetLiveWork — fs-backed read', () => {
  it('reaps a dead entry while reporting the union figure', async () => {
    await withMachineDir((dir) => {
      writeBudgetLedger(dir, [
        makeBudgetEntry({
          itemId: 'WL-DEAD',
          paneId: 'p:dead',
          heartbeatAt: new Date(NOW - HOST_BUDGET_STALE_WINDOW_MS - HOUR).toISOString(),
        }),
      ]);
      const result = readHostBudgetLiveWork(
        'implement',
        makeLivePaneList([
          { paneId: 'p:live', title: implementPane('WL-LIVE') },
        ]),
        { dir, now: NOW },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.reserved).toBe(0);
      expect(result.live).toBe(1);
    });
  });
});

// ── AC3: the 2026-11-13 state ─────────────────────────────────────────

describe('AC3 — the 2026-11-13 host reads 10, not 3', () => {
  /** The replaced-panes evidence from the RCA. */
  const TEN_LIVE_IMPLEMENT_PANES = [
    { paneId: 'w50:p65', itemId: 'AH-0MW25VH540078FDK' },
    { paneId: 'w50:p5B', itemId: 'AH-0MWDBI33V003QQ3U', decoration: '🚫 ' },
    { paneId: 'w50:p5N', itemId: 'AH-0MWEVNBMM000QFO2' },
    { paneId: 'w50:p5Q', itemId: 'AH-0MVUVL2O2006W4QK', decoration: '⚠️ ' },
    { paneId: 'w50:p5Y', itemId: 'AH-0MVWZYIWX0008C55', decoration: '⚠️ ' },
    { paneId: 'w50:p50', itemId: 'AH-0MVWZYQN8007SXIG' },
    { paneId: 'w50:p62', itemId: 'AH-0MWE2V7NW002GS0J' },
    { paneId: 'w5M:p72', itemId: 'WL-0MWDD2JE6006CL7I' },
    { paneId: 'w57:pMC', itemId: 'SA-0MWE4BT63005N8OE' },
    { paneId: 'w5S:p4J', itemId: 'RISE-0MW6M69LE004Z0QG', decoration: '🚫 ' },
  ] as const;

  /** The four ledger entries the host held that day (one of them dead). */
  const LEDGER = [
    makeBudgetEntry({ itemId: 'AH-0MW0KSCU20096B02', paneId: 'w50:p64' }), // dead pane
    makeBudgetEntry({ itemId: 'AH-0MW25VH540078FDK', paneId: 'w50:p65' }),
    makeBudgetEntry({ itemId: 'SA-0MWE4BT63005N8OE', paneId: 'w57:pMC' }),
    makeBudgetEntry({ itemId: 'WL-0MWDD2JE6006CL7I', paneId: 'w5M:p72' }),
  ];

  function panes() {
    return makeLivePaneList(
      TEN_LIVE_IMPLEMENT_PANES.map((pane) => ({
        paneId: pane.paneId,
        title: implementPane(pane.itemId, 'decoration' in pane ? pane.decoration : ''),
      })),
    );
  }

  it('counts all ten live implement panes (3 ledger-confirmed + 7 unreserved)', () => {
    const work = countLiveWork(LEDGER, panes(), 'implement', NOW);
    // The header used to read 3; the panes say 10.
    expect(work.reserved).toBe(3);
    expect(work.unreservedPaneIds).toHaveLength(7);
    expect(work.live).toBe(10);
  });

  it('the header and admission agree, and the dispatcher refuses at max 6 quoting live=10', async () => {
    await withMachineDir(async (dir) => {
      writeBudgetConfig(dir, { maxImplement: 6 });
      writeBudgetLedger(dir, LEDGER);

      const status = readHostBudgetStatus({ dir, now: NOW, livePanes: panes() });
      expect(status?.implement).toEqual({ live: 10, max: 6 });

      const admission = admitHostDispatch(
        { kind: 'implement', itemId: 'WL-NEXT', instanceId: 'i', root: '/repo' },
        { dir, now: NOW, livePanes: panes() },
      );
      expect(admission).toMatchObject({
        admitted: false,
        live: 10,
        max: 6,
        reason: 'host-budget-implement',
      });
      // Exactly the evidence the skip line quotes: `live=10, max=6`.
      expect(admission.live).toBe(status?.implement.live);
    });
  });

  it('admits again once the unreserved panes close', async () => {
    await withMachineDir((dir) => {
      writeBudgetConfig(dir, { maxImplement: 6 });
      writeBudgetLedger(dir, LEDGER);

      // Only the three ledger-confirmed panes remain live.
      const remaining = panes().filter((pane) =>
        ['w50:p65', 'w57:pMC', 'w5M:p72'].includes(pane.paneId),
      );
      const admission = admitHostDispatch(
        { kind: 'implement', itemId: 'WL-NEXT', instanceId: 'i', root: '/repo' },
        { dir, now: NOW, livePanes: remaining },
      );
      expect(admission).toMatchObject({ admitted: true, live: 3, max: 6 });
    });
  });
});

describe('the header gains no new chrome (AC6)', () => {
  it('renders the same segment shape, with the union figure', async () => {
    await withMachineDir((dir) => {
      writeBudgetConfig(dir, { maxImplement: 6 });
      writeBudgetLedger(dir, [makeBudgetEntry({ itemId: 'WL-1', paneId: 'p:1' })]);
      const status = readHostBudgetStatus({
        dir,
        now: NOW,
        livePanes: makeLivePaneList([
          { paneId: 'p:1', title: implementPane('WL-1') },
          { paneId: 'p:2', title: implementPane('WL-2') },
        ]),
      });
      // Unreserved panes are folded into the existing `n/max` figure — no extra
      // chip, row or suffix (the dialog carries the detail instead).
      expect(status?.implement).toEqual({ live: 2, max: 6 });
    });
  });
});
