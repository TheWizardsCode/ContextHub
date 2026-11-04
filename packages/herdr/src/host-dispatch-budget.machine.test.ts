/**
 * packages/herdr/src/host-dispatch-budget.machine.test.ts — machine tests for
 * the host-wide admission of BOTH budgeted tiers (implement: F3
 * WL-0MVXY0YG7009JMHI; audit: F2 WL-0MVXY0XPF006YUHA; parent
 * WL-0MVXWQFGV000D2AB).
 *
 * These are MACHINE tests in the `slot-budget-machine.test.ts` style: two fake
 * herdr instances share ONE temporary machine coordination directory (the F0
 * harness, `host-dispatch-budget.fixtures.ts`), and the assertions are made
 * through the production admission module (`host-dispatch-budget.admission.ts`)
 * against the REAL ledger file — no in-memory ledger double. That is what
 * proves the budget is machine-scoped rather than per-instance:
 *
 *  - AC7: with `maxImplement: 2`, two in-flight implements block a third
 *    dispatch from EITHER instance.
 *  - AC8: a seeded crash-leader entry (stale heartbeat, pane gone) is reaped
 *    and dispatch resumes.
 *  - AC6: an unreadable ledger fails closed with `host-budget-unknown`, is
 *    rewritten from the live pane list, and a later tick dispatches.
 *  - AC4: `maxImplement: 0` disables the tier host-wide (refused `0/0`).
 *  - Parent AC11: an unresolvable coordination dir degrades to no ledger.
 *
 *  - F2 AC1/AC3: the audit matrix — `maxAudit` 0/1/2, `maxAudit: 1` keeping the
 *    retired marker's single-flight token, `maxAudit: 2` admitting two and
 *    refusing the third with `host-budget-audit`.
 *  - F2 AC2: a non-stale legacy `active-audit` marker counts as ONE synthetic
 *    audit entry; a stale one is ignored and the file is never removed.
 *  - F2 AC5: every release point (pane close / dispatch failure / claim
 *    rollback — all `releaseHostDispatch`) frees the audit slot, and a stale
 *    entry is reaped by the 2 h rule.
 *  - F2 AC6: an unreadable ledger fails closed for the audit tier too and is
 *    rewritten from the live audit panes.
 *
 * The ledger/config contract itself (read/reserve/release/reap, clamps) is
 * covered by `host-dispatch-budget.test.ts` (F1) and is not re-tested here.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  admitHostDispatch,
  confirmHostDispatch,
  HOST_BUDGET_AUDIT_REFUSAL,
  HOST_BUDGET_AUDIT_SATURATED_REFUSAL,
  HOST_BUDGET_IMPLEMENT_REFUSAL,
  HOST_BUDGET_UNKNOWN_REFUSAL,
  readAuditBudgetState,
  releaseHostDispatch,
  type HostBudgetAdmission,
} from './host-dispatch-budget.admission.js';
import { HOST_BUDGET_CONFIG_FILE } from './host-dispatch-budget.js';
import {
  DOWNTIME_HOST_AUDIT_MARKER_FILE,
  readActiveAuditMarker,
} from './machine-coordination.js';
import {
  makeBudgetEntry,
  makeLivePaneList,
  readBudgetLedger,
  seedBudgetLedger,
  withMachineDir,
  writeBudgetLedger,
  writeRawBudgetLedger,
} from './host-dispatch-budget.fixtures.js';

/** Two fake instances sharing one machine dir (the F0 isolation contract). */
const INSTANCE_A = 'instance-a';
const INSTANCE_B = 'instance-b';

/** Write `<dir>/budget.json` with the given per-tier caps. */
function writeBudgetConfig(dir: string, config: { maxImplement: number; maxAudit?: number }): void {
  writeFileSync(
    join(dir, HOST_BUDGET_CONFIG_FILE),
    JSON.stringify({ maxAudit: 1, ...config }, null, 2) + '\n',
    'utf8',
  );
}

function admit(
  instanceId: string,
  itemId: string,
  livePanes: Parameters<typeof admitHostDispatch>[1]['livePanes'],
): HostBudgetAdmission {
  return admitHostDispatch(
    { kind: 'implement', itemId, instanceId, root: '/repo/test' },
    { livePanes },
  );
}

/**
 * Confirm a just-admitted reservation with its pane id — the production
 * "reserve → dispatch → confirm" step (`confirmHostDispatch`). Without it the
 * entry has no pane id and the ledger's fresh-pane liveness rule does not
 * count it (the spawn window).
 */
function confirm(instanceId: string, itemId: string, paneId: string): void {
  confirmHostDispatch({
    kind: 'implement',
    itemId,
    instanceId,
    root: '/repo/test',
    paneId,
  });
}

describe('host dispatch budget — machine admission (F3)', () => {
  it('AC7: two in-flight implements block a third dispatch from EITHER instance', () =>
    withMachineDir((dir) => {
      writeBudgetConfig(dir, { maxImplement: 2 });

      // Instance A reserves WL-A with pane-1 live; instance B reserves WL-B
      // with pane-2 live. Each admission counts the OTHER's entry too.
      const first = admit(INSTANCE_A, 'WL-A', makeLivePaneList(['WL-A']));
      expect(first).toMatchObject({ admitted: true, live: 0, max: 2 });
      confirm(INSTANCE_A, 'WL-A', 'pane-1');

      const second = admit(
        INSTANCE_B,
        'WL-B',
        makeLivePaneList([{ paneId: 'pane-1', itemId: 'WL-A' }, 'WL-B']),
      );
      expect(second).toMatchObject({ admitted: true, live: 1, max: 2 });
      confirm(INSTANCE_B, 'WL-B', 'pane-2');

      const bothLive = makeLivePaneList([
        { paneId: 'pane-1', itemId: 'WL-A' },
        { paneId: 'pane-2', itemId: 'WL-B' },
      ]);
      const fromA = admit(INSTANCE_A, 'WL-C', bothLive);
      const fromB = admit(INSTANCE_B, 'WL-C', bothLive);

      expect(fromA).toMatchObject({
        admitted: false,
        live: 2,
        max: 2,
        reason: HOST_BUDGET_IMPLEMENT_REFUSAL,
      });
      expect(fromB).toEqual(fromA);
      // Neither refusal reserved anything: the ledger still holds exactly the
      // two in-flight dispatches.
      expect(readBudgetLedger(dir)?.entries.map((entry) => entry.itemId).sort()).toEqual([
        'WL-A',
        'WL-B',
      ]);
    }));

  it('AC8: a crashed leader entry (stale heartbeat, pane gone) is reaped and dispatch resumes', () =>
    withMachineDir((dir) => {
      writeBudgetConfig(dir, { maxImplement: 2 });
      // A crash-leader entry: fresh enough to have been written, but its
      // heartbeat is stale (older than the 2 h convention) and its pane is no
      // longer in the live list.
      seedBudgetLedger(dir, [
        makeBudgetEntry({
          kind: 'implement',
          itemId: 'WL-CRASHED',
          instanceId: 'crashed-leader',
          paneId: 'pane-dead',
          heartbeatAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        }),
        makeBudgetEntry({
          kind: 'implement',
          itemId: 'WL-LIVE',
          instanceId: INSTANCE_A,
          paneId: 'pane-live',
        }),
      ]);

      const admission = admit(
        INSTANCE_A,
        'WL-NEW',
        makeLivePaneList([{ paneId: 'pane-live', itemId: 'WL-LIVE' }]),
      );

      // Only the live entry counted → the new dispatch is admitted (the crash
      // never wedged the host), and the stale entry was reaped on read.
      expect(admission).toMatchObject({ admitted: true, live: 1, max: 2 });
      expect(readBudgetLedger(dir)?.entries.map((entry) => entry.itemId).sort()).toEqual([
        'WL-LIVE',
        'WL-NEW',
      ]);
    }));

  it('AC6: an unreadable ledger fails closed, is repaired from live panes, then dispatch resumes', () =>
    withMachineDir((dir) => {
      writeBudgetConfig(dir, { maxImplement: 2 });
      writeRawBudgetLedger(dir, '{ this is not json');

      const livePanes = makeLivePaneList(['WL-RUNNING']);
      const refused = admit(INSTANCE_A, 'WL-NEW', livePanes);

      expect(refused).toMatchObject({
        admitted: false,
        live: 0,
        max: 2,
        reason: HOST_BUDGET_UNKNOWN_REFUSAL,
        repaired: true,
      });
      // The ledger was rewritten from live state: the running pane is now an
      // entry (never a silent zero, which would under-count).
      const repaired = readBudgetLedger(dir);
      expect(repaired?.entries.map((entry) => entry.itemId)).toEqual(['WL-RUNNING']);
      expect(repaired?.entries[0]).toMatchObject({ kind: 'implement', paneId: 'pane-1' });

      // A subsequent tick against the healed ledger dispatches normally.
      const healed = admit(INSTANCE_A, 'WL-NEW', livePanes);
      expect(healed).toMatchObject({ admitted: true, live: 1, max: 2 });
      expect(readBudgetLedger(dir)?.entries.map((entry) => entry.itemId).sort()).toEqual([
        'WL-NEW',
        'WL-RUNNING',
      ]);
    }));

  it('AC4: maxImplement=0 disables the implement tier host-wide with 0/0 evidence', () =>
    withMachineDir((dir) => {
      writeBudgetConfig(dir, { maxImplement: 0 });

      const admission = admit(INSTANCE_A, 'WL-A', makeLivePaneList(['WL-OTHER']));

      expect(admission).toEqual({
        admitted: false,
        live: 0,
        max: 0,
        reason: HOST_BUDGET_IMPLEMENT_REFUSAL,
      });
      // A disabled tier never reserves (the ledger is not even created).
      expect(readBudgetLedger(dir)).toBeNull();
    }));

  it('parent AC11: an unresolvable coordination dir degrades to no ledger (admitted)', () => {
    const admission = admitHostDispatch(
      { kind: 'implement', itemId: 'WL-A', instanceId: INSTANCE_A, root: '/repo/test' },
      { livePanes: makeLivePaneList(['WL-OTHER']), dir: null },
    );
    expect(admission).toEqual({ admitted: true, live: 0, max: 2 });
  });

  it('honours an operator-written budget.json and counts only fresh, live-pane entries', () =>
    withMachineDir((dir) => {
      writeBudgetConfig(dir, { maxImplement: 1 });
      writeBudgetLedger(dir, [
        makeBudgetEntry({
          kind: 'implement',
          itemId: 'WL-ONE',
          instanceId: INSTANCE_A,
          paneId: 'pane-1',
        }),
      ]);

      const refused = admit(INSTANCE_A, 'WL-TWO', makeLivePaneList(['WL-ONE']));
      expect(refused).toMatchObject({
        admitted: false,
        live: 1,
        max: 1,
        reason: HOST_BUDGET_IMPLEMENT_REFUSAL,
      });
    }));
});

// ── Audit tier (WL-0MVXY0XPF006YUHA F2) ────────────────────────────────

/** The dispatcher-created pane title convention for an audit pane. */
function auditPane(paneId: string, itemId: string) {
  return { paneId, title: `Downtime triggered audit Audit ${itemId} - ${itemId}` };
}

/** One audit asking the machine-scoped ledger for a slot. */
function auditAdmit(
  itemId: string,
  livePanes: Parameters<typeof admitHostDispatch>[1]['livePanes'],
  instanceId: string = INSTANCE_A,
): HostBudgetAdmission {
  return admitHostDispatch(
    { kind: 'audit', itemId, instanceId, root: '/repo/test' },
    { livePanes },
  );
}

/** Write the legacy `active-audit` marker file verbatim. */
function writeLegacyMarker(dir: string, dispatchedAt: string): void {
  writeFileSync(
    join(dir, DOWNTIME_HOST_AUDIT_MARKER_FILE),
    JSON.stringify({ instanceId: 'older-instance', dispatchedAt }),
  );
}

describe('host dispatch budget — audit tier (F2)', () => {
  it('AC1: maxAudit=1 reproduces the single-flight exactly — second audit refused with the legacy token', () =>
    withMachineDir((dir) => {
      writeBudgetConfig(dir, { maxImplement: 2, maxAudit: 1 });
      const panes = makeLivePaneList([auditPane('pane-1', 'WL-A')]);

      // The first audit reserves the slot. No pane confirmation is needed: the
      // audit tier counts a fresh reservation immediately (marker semantics).
      expect(auditAdmit('WL-A', panes)).toEqual({ admitted: true, live: 0, max: 1 });

      // The second audit is refused at the cap, with the retired marker's reason
      // token (existing consumers keep working) and the observed evidence.
      expect(auditAdmit('WL-B', panes)).toEqual({
        admitted: false,
        live: 1,
        max: 1,
        reason: HOST_BUDGET_AUDIT_SATURATED_REFUSAL,
      });
      // A refusal never reserves.
      expect(readBudgetLedger(dir)?.entries.map((entry) => entry.itemId)).toEqual(['WL-A']);
    }));

  it('AC3: maxAudit=2 permits two concurrent audits and refuses the third with host-budget-audit', () =>
    withMachineDir((dir) => {
      writeBudgetConfig(dir, { maxImplement: 2, maxAudit: 2 });
      const panes = makeLivePaneList([
        auditPane('pane-1', 'WL-A'),
        auditPane('pane-2', 'WL-B'),
      ]);

      expect(auditAdmit('WL-A', panes)).toEqual({ admitted: true, live: 0, max: 2 });
      expect(auditAdmit('WL-B', panes)).toEqual({ admitted: true, live: 1, max: 2 });
      expect(auditAdmit('WL-C', panes)).toEqual({
        admitted: false,
        live: 2,
        max: 2,
        reason: HOST_BUDGET_AUDIT_REFUSAL,
      });
      expect(readBudgetLedger(dir)?.entries.map((entry) => entry.itemId).sort()).toEqual([
        'WL-A',
        'WL-B',
      ]);
    }));

  it('AC3: maxAudit=0 refuses every audit with host-budget-audit and 0/0 evidence', () =>
    withMachineDir((dir) => {
      writeBudgetConfig(dir, { maxImplement: 2, maxAudit: 0 });

      expect(auditAdmit('WL-A', makeLivePaneList([]))).toEqual({
        admitted: false,
        live: 0,
        max: 0,
        reason: HOST_BUDGET_AUDIT_REFUSAL,
      });
      // The pre-check agrees with admission, so the dispatcher skips before any
      // claim: live/max are the same 0/0.
      expect(readAuditBudgetState({ livePanes: [] })).toEqual({
        atCap: true,
        live: 0,
        max: 0,
        reason: HOST_BUDGET_AUDIT_REFUSAL,
      });
      // A disabled tier never reserves (the ledger is not even created).
      expect(readBudgetLedger(dir)).toBeNull();
    }));

  it('AC2: a non-stale legacy marker counts as ONE synthetic audit entry', () =>
    withMachineDir((dir) => {
      writeBudgetConfig(dir, { maxImplement: 2, maxAudit: 1 });
      writeLegacyMarker(dir, new Date().toISOString());

      // A mixed-version host: an older instance still runs the marker-based
      // single-flight, so this instance must not dispatch a second audit.
      expect(readAuditBudgetState({ livePanes: [] })).toEqual({
        atCap: true,
        live: 1,
        max: 1,
        reason: HOST_BUDGET_AUDIT_SATURATED_REFUSAL,
      });
      expect(auditAdmit('WL-NEW', [])).toMatchObject({
        admitted: false,
        live: 1,
        max: 1,
        reason: HOST_BUDGET_AUDIT_SATURATED_REFUSAL,
      });
      // Counting a legacy marker never writes a ledger entry for it.
      expect(readBudgetLedger(dir)).toBeNull();
    }));

  it('AC2: a stale legacy marker is ignored and the file is left in place', () =>
    withMachineDir((dir) => {
      writeBudgetConfig(dir, { maxImplement: 2, maxAudit: 1 });
      writeLegacyMarker(
        dir,
        new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      );

      expect(readAuditBudgetState({ livePanes: [] })).toMatchObject({ atCap: false, live: 0 });
      expect(auditAdmit('WL-NEW', [])).toEqual({ admitted: true, live: 0, max: 1 });
      expect(readBudgetLedger(dir)?.entries.map((entry) => entry.itemId)).toEqual(['WL-NEW']);
      // Retirement: the stale file is neither counted nor deleted (an operator
      // or the older instance owns it).
      expect(readActiveAuditMarker(dir)).not.toBeNull();
    }));

  it('AC5: every release point (pane close, dispatch failure, claim rollback) frees the slot by item id', () =>
    withMachineDir((dir) => {
      writeBudgetConfig(dir, { maxImplement: 2, maxAudit: 1 });

      // All three abort paths in the claim pipeline call the same release seam
      // (`releaseHostDispatch` / `releaseHostBudgetForFailure`), so a
      // release-by-item-id assertion covers each of them; the per-path CALL
      // SITES are asserted individually in `downtime-worker.dispatch.test.ts`
      // (marker-write failure, spawn failure, admission refusal) and
      // `index.test.ts` (pane close).
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(auditAdmit('WL-AUD', [])).toEqual({ admitted: true, live: 0, max: 1 });
        expect(releaseHostDispatch('WL-AUD')).toBe(true);
        expect(readAuditBudgetState({ livePanes: [] })).toMatchObject({ atCap: false, live: 0 });
        // Idempotent: a second release for the same dispatch is a no-op success.
        expect(releaseHostDispatch('WL-AUD')).toBe(true);
      }
    }));

  it('AC1/AC5: a stale audit entry is reaped on read, releasing the slot', () =>
    withMachineDir((dir) => {
      writeBudgetConfig(dir, { maxImplement: 2, maxAudit: 1 });
      writeBudgetLedger(dir, [
        makeBudgetEntry({
          kind: 'audit',
          itemId: 'WL-CRASHED',
          paneId: 'pane-dead',
          heartbeatAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        }),
      ]);

      expect(readAuditBudgetState({ livePanes: [] })).toMatchObject({ atCap: false, live: 0 });
      // The stale entry was released from disk by the 2 h rule.
      expect(readBudgetLedger(dir)?.entries).toEqual([]);
    }));

  it('AC6: an unreadable ledger fails closed and is repaired from the live audit panes', () =>
    withMachineDir((dir) => {
      writeBudgetConfig(dir, { maxImplement: 2, maxAudit: 1 });
      writeRawBudgetLedger(dir, '{ this is not json');
      const livePanes = makeLivePaneList([auditPane('pane-1', 'WL-RUNNING')]);

      expect(readAuditBudgetState({ livePanes })).toEqual({
        atCap: true,
        live: 0,
        max: 1,
        reason: HOST_BUDGET_UNKNOWN_REFUSAL,
        repaired: true,
      });
      // Self-healing: the running audit pane is now a ledger entry (a silent
      // zero would under-count and admit a second audit).
      const repaired = readBudgetLedger(dir);
      expect(repaired?.entries.map((entry) => entry.itemId)).toEqual(['WL-RUNNING']);
      expect(repaired?.entries[0]).toMatchObject({ kind: 'audit', paneId: 'pane-1' });

      // The next tick reads the healed ledger: still at cap, now with the real
      // single-flight token.
      expect(readAuditBudgetState({ livePanes })).toMatchObject({
        atCap: true,
        live: 1,
        max: 1,
        reason: HOST_BUDGET_AUDIT_SATURATED_REFUSAL,
      });
    }));
});
