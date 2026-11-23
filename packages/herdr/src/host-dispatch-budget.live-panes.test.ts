/**
 * packages/herdr/src/host-dispatch-budget.live-panes.test.ts — a FINISHED
 * session must not hold its dispatch-budget slot (WL-0MWJVY6NR001E0FS).
 *
 * The project never auto-closes an `implement` pane (and a terminal `audit`
 * pane is caught by the dead-agent guard), so a finished session's pane stays
 * OPEN. The union counting rule adds a live dispatcher pane that no entry
 * accounts for, and the budget surfaces used to feed every parsed pane record
 * — terminal agents included — into that projection. A finished, deliberately
 * open pane therefore kept its tier slot occupied for the whole 2 h staleness
 * window even after the reaper had released its ledger entry: the producer saw
 * `5/5` budget used with two completed panes sitting open.
 *
 * `liveBudgetPanesFromRecords` projects the FULL pane-record set onto the LIVE
 * subset (the shared `isPaneAgentLive` definition) so a session whose agent has
 * ended (`done`/`exited`) stops counting immediately — the reaper's release
 * removes the ledger entry, and this projection removes the pane half. These
 * tests pin both halves and the end-to-end admission/header consequence.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { admitHostDispatch } from './host-dispatch-budget.admission.js';
import { countLiveWork, readHostBudgetLiveWork } from './host-dispatch-budget.counting.js';
import { HOST_BUDGET_CONFIG_FILE } from './host-dispatch-budget.js';
import { readHostBudgetStatus } from './host-budget-status.js';
import { liveBudgetPanesFromRecords } from './host-dispatch-budget.live-panes.js';
import type { HerdrPaneRecord } from './pane-discovery.js';
import {
  makeBudgetEntry,
  withMachineDir,
  writeBudgetLedger,
} from './host-dispatch-budget.fixtures.js';

const NOW = Date.parse('2026-11-22T23:30:00.000Z');

const implementLabel = (itemId: string) => `Downtime triggered implement Do it - ${itemId}`;
const auditLabel = (itemId: string) => `Downtime triggered audit Audit it - ${itemId}`;

/** One `herdr pane list` record as the discovery parse reports it. */
function record(overrides: Partial<HerdrPaneRecord> & { paneId: string }): HerdrPaneRecord {
  return { agent: 'pi', agentStatus: 'working', ...overrides };
}

function writeCaps(dir: string, caps: { maxImplement?: number; maxAudit?: number }): void {
  writeFileSync(join(dir, HOST_BUDGET_CONFIG_FILE), JSON.stringify(caps, null, 2), 'utf8');
}

// ── The projection ────────────────────────────────────────────────────

describe('liveBudgetPanesFromRecords — only LIVE agents are in-flight work', () => {
  it('keeps working/idle/blank-status agents and forwards the label as the title', () => {
    const panes = liveBudgetPanesFromRecords([
      record({ paneId: 'p:work', agentStatus: 'working', label: implementLabel('WL-1') }),
      record({ paneId: 'p:idle', agentStatus: 'idle', label: implementLabel('WL-2') }),
      record({ paneId: 'p:blank', agentStatus: undefined, label: implementLabel('WL-3') }),
    ]);

    expect(panes).toEqual([
      { paneId: 'p:work', title: implementLabel('WL-1') },
      { paneId: 'p:idle', title: implementLabel('WL-2') },
      { paneId: 'p:blank', title: implementLabel('WL-3') },
    ]);
  });

  it.each(['done', 'exited', 'DONE', 'Exited'])(
    'drops a pane whose agent status is terminal (%s)',
    (agentStatus) => {
      const panes = liveBudgetPanesFromRecords([
        record({ paneId: 'p:done', agentStatus, label: implementLabel('WL-1') }),
        record({ paneId: 'p:live', agentStatus: 'working', label: implementLabel('WL-2') }),
      ]);

      expect(panes.map((p) => p.paneId)).toEqual(['p:live']);
    },
  );

  it('keeps a record with no status (fail-open — never over-admit on a quirk)', () => {
    const panes = liveBudgetPanesFromRecords([
      record({ paneId: 'p:none', agentStatus: undefined }),
    ]);

    expect(panes.map((p) => p.paneId)).toEqual(['p:none']);
  });
});

// ── The union counting rule over the projection ────────────────────────

describe('countLiveWork — a finished, open pane releases its slot (AC1)', () => {
  it('does NOT count a fresh entry whose confirmed pane has finished (done)', () => {
    const entries = [makeBudgetEntry({ itemId: 'WL-DONE', paneId: 'p:done' })];
    const panes = liveBudgetPanesFromRecords([
      record({ paneId: 'p:done', agentStatus: 'done', label: implementLabel('WL-DONE') }),
    ]);

    const work = countLiveWork(entries, panes, 'implement', NOW);

    // Neither the ledger half (no live pane ⇒ no pane-derived freshness) nor
    // the pane half counts it — the slot is freed without any pane close.
    expect(work.reserved).toBe(0);
    expect(work.unreservedPaneIds).toEqual([]);
    expect(work.live).toBe(0);
  });

  it('does NOT count a finished pane whose ledger entry was already released', () => {
    // The reaper released the entry; only the (deliberately open) pane remains.
    const panes = liveBudgetPanesFromRecords([
      record({ paneId: 'p:done', agentStatus: 'exited', label: implementLabel('WL-DONE') }),
    ]);

    expect(countLiveWork([], panes, 'implement', NOW).live).toBe(0);
  });

  it('still counts a working session (a live pane is in-flight work)', () => {
    const entries = [makeBudgetEntry({ itemId: 'WL-LIVE', paneId: 'p:live' })];
    const panes = liveBudgetPanesFromRecords([
      record({ paneId: 'p:live', agentStatus: 'working', label: implementLabel('WL-LIVE') }),
    ]);

    expect(countLiveWork(entries, panes, 'implement', NOW).live).toBe(1);
  });

  it('keeps a still-running sibling dispatch for the SAME item when one finishes', () => {
    // Two dispatches for one item: one implement pane finished, one audit pane
    // is still working. Only the finished pane's entry is gone; the sibling's
    // pane keeps its slot.
    const entries = [makeBudgetEntry({ kind: 'audit', itemId: 'WL-BOTH', paneId: 'p:audit' })];
    const panes = liveBudgetPanesFromRecords([
      record({ paneId: 'p:impl', agentStatus: 'done', label: implementLabel('WL-BOTH') }),
      record({ paneId: 'p:audit', agentStatus: 'working', label: auditLabel('WL-BOTH') }),
    ]);

    expect(countLiveWork(entries, panes, 'implement', NOW).live).toBe(0);
    expect(countLiveWork(entries, panes, 'audit', NOW).live).toBe(1);
  });
});

// ── End-to-end: admission + header admit the tier again on finish ──────

describe('admission/header — the tier is admitted again when a session finishes', () => {
  it('admits a new implement dispatch once the only in-flight pane finished', async () => {
    await withMachineDir((dir) => {
      writeCaps(dir, { maxImplement: 1 });
      // The finished pane's fresh entry is still on the ledger (the reaper has
      // not run yet); only the pane projection can free the slot right now.
      writeBudgetLedger(dir, [makeBudgetEntry({ itemId: 'WL-DONE', paneId: 'p:done' })]);
      const livePanes = liveBudgetPanesFromRecords([
        record({ paneId: 'p:done', agentStatus: 'done', label: implementLabel('WL-DONE') }),
      ]);

      const admission = admitHostDispatch(
        { kind: 'implement', itemId: 'WL-NEXT', instanceId: 'i', root: '/repo' },
        { dir, now: NOW, livePanes },
      );

      expect(admission).toMatchObject({ admitted: true, live: 0, max: 1 });
    });
  });

  it('refuses while the pane is still working (no false release)', async () => {
    await withMachineDir((dir) => {
      writeCaps(dir, { maxImplement: 1 });
      writeBudgetLedger(dir, [makeBudgetEntry({ itemId: 'WL-LIVE', paneId: 'p:live' })]);
      const livePanes = liveBudgetPanesFromRecords([
        record({ paneId: 'p:live', agentStatus: 'working', label: implementLabel('WL-LIVE') }),
      ]);

      const admission = admitHostDispatch(
        { kind: 'implement', itemId: 'WL-NEXT', instanceId: 'i', root: '/repo' },
        { dir, now: NOW, livePanes },
      );

      expect(admission).toMatchObject({
        admitted: false,
        live: 1,
        max: 1,
        reason: 'host-budget-implement',
      });
    });
  });

  it('the header figure drops for the finished pane', async () => {
    await withMachineDir((dir) => {
      writeCaps(dir, { maxImplement: 1 });
      writeBudgetLedger(dir, [makeBudgetEntry({ itemId: 'WL-DONE', paneId: 'p:done' })]);
      const livePanes = liveBudgetPanesFromRecords([
        record({ paneId: 'p:done', agentStatus: 'done', label: implementLabel('WL-DONE') }),
      ]);

      const status = readHostBudgetStatus({ dir, now: NOW, livePanes });

      expect(status?.implement.live).toBe(0);
      expect(status?.implement.max).toBe(1);
    });
  });
});

// ── Audit tier: the display/count drops on finish (AC2) ────────────────

describe('audit tier — a finished audit session frees its slot (AC2)', () => {
  it('drops a fresh audit entry whose pane has finished (no 2 h stall)', async () => {
    await withMachineDir((dir) => {
      writeCaps(dir, { maxAudit: 1 });
      writeBudgetLedger(dir, [
        makeBudgetEntry({ kind: 'audit', itemId: 'WL-AUDIT', paneId: 'p:audit' }),
      ]);
      const livePanes = liveBudgetPanesFromRecords([
        record({ paneId: 'p:audit', agentStatus: 'done', label: auditLabel('WL-AUDIT') }),
      ]);

      const work = readHostBudgetLiveWork('audit', livePanes, { dir, now: NOW });
      expect(work.ok && work.live).toBe(0);

      // The header's audit display rule (pane-aware) drops it too.
      const status = readHostBudgetStatus({ dir, now: NOW, livePanes });
      expect(status?.audit.live).toBe(0);
    });
  });

  it('keeps a working audit session counted', async () => {
    await withMachineDir((dir) => {
      writeCaps(dir, { maxAudit: 1 });
      writeBudgetLedger(dir, [
        makeBudgetEntry({ kind: 'audit', itemId: 'WL-AUDIT', paneId: 'p:audit' }),
      ]);
      const livePanes = liveBudgetPanesFromRecords([
        record({ paneId: 'p:audit', agentStatus: 'working', label: auditLabel('WL-AUDIT') }),
      ]);

      const status = readHostBudgetStatus({ dir, now: NOW, livePanes });
      expect(status?.audit.live).toBe(1);
    });
  });
});
