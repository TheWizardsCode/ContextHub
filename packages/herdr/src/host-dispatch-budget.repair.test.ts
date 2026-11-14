/**
 * packages/herdr/src/host-dispatch-budget.repair.test.ts — explicit, complete
 * ledger repair (WL-0MWFJD8ZO000J1R8, parent WL-0MWFJD1RV008FCCR).
 *
 * The defect: admission answered an unreadable ledger by rewriting the WHOLE
 * document from the live pane list, but reconstruction only kept panes whose
 * title started with `Downtime` — so herdr's `⚠️`/`🚫`-decorated panes and
 * `Manually triggered` panes (6 of the 10 running implements on 2026-11-13)
 * were silently dropped.
 *
 * This suite pins the replacement contract:
 *
 *  - an admission read NEVER rewrites the ledger, and a corrupt ledger stays
 *    byte-identical while the decision carries `host-budget-corrupt`;
 *  - repair is an explicit action whose pane decoding accepts every dispatcher
 *    label form, decoration included, and derives the tier conservatively
 *    (unknown ⇒ implement);
 *  - a repair refuses to write while any live dispatcher pane cannot be
 *    accounted for, and reports the set it reconstructed.
 */

import { existsSync, readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  admitHostDispatch,
  HOST_BUDGET_CORRUPT_REFUSAL,
  readAuditBudgetState,
} from './host-dispatch-budget.admission.js';
import {
  decodeBudgetPaneLabel,
  planBudgetRepair,
  repairBudgetLedgerFromPanes,
} from './host-dispatch-budget.repair.js';
import { budgetLedgerPath } from './host-dispatch-budget.js';
import {
  makeBudgetEntry,
  makeLivePaneList,
  withMachineDir,
  writeRawBudgetLedger,
  writeBudgetLedger,
  readBudgetLedger,
} from './host-dispatch-budget.fixtures.js';

const INSTANCE = { instanceId: 'instance-repair', root: '/repo/repair' };

// ── Label decoding (AC2/AC3) ──────────────────────────────────────────

describe('decodeBudgetPaneLabel', () => {
  it('decodes the plain dispatcher forms', () => {
    expect(decodeBudgetPaneLabel('Downtime triggered implement Do the thing - WL-1')).toMatchObject({
      form: 'downtime',
      kind: 'implement',
      kindKnown: true,
      itemId: 'WL-1',
    });
    expect(decodeBudgetPaneLabel('Downtime triggered audit Check it - WL-2')).toMatchObject({
      form: 'downtime',
      kind: 'audit',
      kindKnown: true,
      itemId: 'WL-2',
    });
    // The short form (`Downtime <kind> …`) produced by a manually named pane.
    expect(decodeBudgetPaneLabel('Downtime implement Short form - WL-3')).toMatchObject({
      form: 'downtime',
      kind: 'implement',
      itemId: 'WL-3',
    });
  });

  it('decodes decorated labels — herdr prefixes status markers (AC2)', () => {
    for (const label of [
      '⚠️ Downtime triggered implement Do the thing - WL-1',
      '🚫 Downtime triggered implement Do the thing - WL-1',
      '  ⚠️   Downtime triggered implement Do the thing - WL-1',
      '● Downtime triggered audit Check it - WL-2',
    ]) {
      const decoded = decodeBudgetPaneLabel(label);
      expect(decoded.form).toBe('downtime');
      expect(decoded.kind).not.toBeNull();
      expect(decoded.itemId).toBe(label.endsWith('WL-2') ? 'WL-2' : 'WL-1');
    }
  });

  it('decodes `Manually triggered` dispatcher labels (AC2)', () => {
    expect(decodeBudgetPaneLabel('Manually triggered implement Do it - WL-9')).toMatchObject({
      form: 'manual',
      kind: 'implement',
      itemId: 'WL-9',
    });
    expect(decodeBudgetPaneLabel('⚠️ Manually triggered audit Audit it - WL-8')).toMatchObject({
      form: 'manual',
      kind: 'audit',
      itemId: 'WL-8',
    });
  });

  it('treats an unknown tier conservatively as implement (AC3)', () => {
    const decoded = decodeBudgetPaneLabel('Downtime triggered mystery Skill - WL-X');
    // Over-counting refuses a dispatch; under-counting would admit capped work.
    expect(decoded).toMatchObject({ kind: 'implement', kindKnown: false, itemId: 'WL-X' });
  });

  it('does not mistake an unbudgeted tier or a non-dispatcher pane for dispatch evidence', () => {
    expect(decodeBudgetPaneLabel('Downtime triggered plan Plan it - WL-P').kind).toBeNull();
    expect(decodeBudgetPaneLabel('Manually triggered prompt write tests').kind).toBeNull();
    expect(decodeBudgetPaneLabel('rgardler@host: ~/projects/x').kind).toBeNull();
    expect(decodeBudgetPaneLabel(undefined).kind).toBeNull();
    expect(decodeBudgetPaneLabel('').form).toBe('other');
  });
});

// ── Repair planning (AC4) ─────────────────────────────────────────────

describe('planBudgetRepair', () => {
  it('reconstructs decorated, manual and plain panes as one entry each', () => {
    const plan = planBudgetRepair(
      makeLivePaneList([
        {
          paneId: 'w50:p65',
          title: '⚠️ Downtime triggered implement Implement it - WL-1',
        },
        { paneId: 'w50:p5B', title: 'Manually triggered implement Manual - WL-2' },
        { paneId: 'w50:p5N', title: 'Downtime triggered audit Audit it - WL-3' },
        // Not a budgeted dispatch: ignored, never "unaccounted".
        { paneId: 'w50:p1', title: 'rgardler@host: ~/projects/x' },
        { paneId: 'w50:p2', title: 'Downtime triggered plan Plan it - WL-4' },
      ]),
      INSTANCE,
    );

    expect(plan.complete).toBe(true);
    expect(plan.unaccounted).toEqual([]);
    expect(plan.entries.map((entry) => `${entry.kind}:${entry.itemId}`).sort()).toEqual([
      'audit:WL-3',
      'implement:WL-1',
      'implement:WL-2',
    ]);
    expect(plan.accountedPaneIds.sort()).toEqual(['w50:p5B', 'w50:p5N', 'w50:p65']);
  });

  it('refuses (incomplete) when a live dispatcher pane carries no work-item id (AC4)', () => {
    const plan = planBudgetRepair(
      makeLivePaneList([
        { paneId: 'w1:p1', title: 'Downtime triggered implement Item one - WL-1' },
        { paneId: 'w1:p2', title: '⚠️ Downtime triggered implement no id here' },
      ]),
      INSTANCE,
    );

    expect(plan.complete).toBe(false);
    expect(plan.unaccounted).toEqual([
      { paneId: 'w1:p2', label: '⚠️ Downtime triggered implement no id here', reason: 'no-work-item-id' },
    ]);
    // The rest is still reported — the refusal is about the write, not the plan.
    expect(plan.entries).toHaveLength(1);
  });

  it('counts one entry per (tier, item) when two panes claim the same pair', () => {
    const plan = planBudgetRepair(
      makeLivePaneList([
        { paneId: 'w1:p1', title: 'Downtime triggered implement Item one - WL-1' },
        { paneId: 'w1:p2', title: 'Manually triggered implement Item one - WL-1' },
      ]),
      INSTANCE,
    );
    expect(plan.entries).toHaveLength(1);
    // Nothing is dropped silently: both panes are accounted for.
    expect(plan.accountedPaneIds.sort()).toEqual(['w1:p1', 'w1:p2']);
  });
});

// ── Repair writes (AC4) ───────────────────────────────────────────────

describe('repairBudgetLedgerFromPanes', () => {
  it('rewrites a corrupt ledger from the live panes and reports the set', async () => {
    await withMachineDir((dir) => {
      writeRawBudgetLedger(dir, '{ "version": 1, "entries": [ garbage');

      const result = repairBudgetLedgerFromPanes(
        makeLivePaneList([
          { paneId: 'p:1', title: '⚠️ Downtime triggered implement One - WL-1' },
          { paneId: 'p:2', title: 'Manually triggered audit Two - WL-2' },
        ]),
        { ...INSTANCE, now: Date.parse('2026-11-13T22:00:00.000Z') },
        { dir },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.count).toBe(2);
      expect(result.accountedPaneIds.sort()).toEqual(['p:1', 'p:2']);
      expect(readBudgetLedger(dir)?.entries.map((entry) => `${entry.kind}:${entry.itemId}`).sort()).toEqual([
        'audit:WL-2',
        'implement:WL-1',
      ]);
    });
  });

  it('REFUSES to write while a live dispatcher pane is unaccounted for (AC4)', async () => {
    await withMachineDir((dir) => {
      const corrupt = '{ "version": 1, "entries": [ garbage';
      writeRawBudgetLedger(dir, corrupt);

      const result = repairBudgetLedgerFromPanes(
        makeLivePaneList([
          { paneId: 'p:1', title: 'Downtime triggered implement One - WL-1' },
          { paneId: 'p:2', title: '🚫 Downtime triggered implement no id' },
        ]),
        INSTANCE,
        { dir },
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('incomplete');
      expect(result.unaccounted?.map((pane) => pane.paneId)).toEqual(['p:2']);
      // A partial reconstruction is exactly the silent loss this replaces.
      expect(readFileSync(budgetLedgerPath(dir), 'utf8')).toBe(corrupt);
    });
  });

  it('reports a write failure instead of throwing', async () => {
    await withMachineDir((dir) => {
      // The coordination dir is a FILE, so the ledger cannot be created.
      const blocked = join(dir, 'blocked');
      writeFileSync(blocked, 'x', 'utf8');
      const result = repairBudgetLedgerFromPanes(
        makeLivePaneList([{ paneId: 'p:1', title: 'Downtime triggered implement One - WL-1' }]),
        INSTANCE,
        { dir: join(blocked, 'nested') },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(['write-failed', 'no-coordination-dir']).toContain(result.reason);
    });
  });
});

// ── Admission never repairs (AC1) ─────────────────────────────────────

describe('an admission read never rewrites the ledger (AC1)', () => {
  const corrupt = '{"version":1,"entries":[{"kind":"bogus"}]}';

  it('implement tier: fails closed with host-budget-corrupt and leaves the bytes identical', async () => {
    await withMachineDir((dir) => {
      writeRawBudgetLedger(dir, corrupt);

      const admission = admitHostDispatch(
        { kind: 'implement', itemId: 'WL-1', instanceId: 'i', root: '/repo' },
        { dir, livePanes: makeLivePaneList(['WL-LIVE']) },
      );

      expect(admission).toMatchObject({
        admitted: false,
        reason: HOST_BUDGET_CORRUPT_REFUSAL,
      });
      expect(HOST_BUDGET_CORRUPT_REFUSAL).toBe('host-budget-corrupt');
      // Byte-identical: the read did not "self-heal" the document.
      expect(readFileSync(budgetLedgerPath(dir), 'utf8')).toBe(corrupt);
    });
  });

  it('audit pre-check: reports host-budget-corrupt and leaves the bytes identical', async () => {
    await withMachineDir((dir) => {
      writeRawBudgetLedger(dir, corrupt);

      const state = readAuditBudgetState({
        dir,
        livePanes: makeLivePaneList(['WL-LIVE']),
        env: { HERDR_AUDIT_LOCAL_BUDGET: '1' },
      });

      expect(state).toMatchObject({ atCap: true, reason: HOST_BUDGET_CORRUPT_REFUSAL });
      expect(readFileSync(budgetLedgerPath(dir), 'utf8')).toBe(corrupt);
    });
  });

  it('never creates a ledger from live panes when the ledger is simply missing', async () => {
    await withMachineDir((dir) => {
      const admission = admitHostDispatch(
        { kind: 'implement', itemId: 'WL-1', instanceId: 'i', root: '/repo' },
        { dir, livePanes: makeLivePaneList(['WL-LIVE']) },
      );
      // A missing ledger is an EMPTY ledger: admission reserves only its own
      // entry and never reconstructs the rest from panes.
      expect(admission.admitted).toBe(true);
      expect(existsSync(budgetLedgerPath(dir))).toBe(true);
      expect(readBudgetLedger(dir)?.entries.map((entry) => entry.itemId)).toEqual(['WL-1']);
    });
  });

  it('a valid ledger is untouched by a refusing admission read', async () => {
    await withMachineDir((dir) => {
      writeBudgetLedger(dir, [makeBudgetEntry({ itemId: 'WL-LIVE', paneId: 'p:1' })]);
      const before = readFileSync(budgetLedgerPath(dir), 'utf8');

      // Refused at the cap (`maxImplement: 1` vs one live entry): a refusal
      // writes nothing, so the bytes must be identical.
      const admission = admitHostDispatch(
        { kind: 'implement', itemId: 'WL-NEW', instanceId: 'i', root: '/repo' },
        {
          dir,
          livePanes: makeLivePaneList([{ paneId: 'p:1', itemId: 'WL-LIVE' }]),
          env: { HERDR_HOST_MAX_IMPLEMENT: '1' },
        },
      );
      expect(admission).toMatchObject({ admitted: false, reason: 'host-budget-implement' });
      expect(readFileSync(budgetLedgerPath(dir), 'utf8')).toBe(before);
    });
  });
});
