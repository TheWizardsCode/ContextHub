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

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  repairBudgetLedgerFromPanes,
} from './host-dispatch-budget.repair.js';
import {
  admitHostDispatch,
  confirmHostDispatch,
  decideAuditAvailability,
  decideAuditLeaseAdmission,
  HOST_BUDGET_AUDIT_REFUSAL,
  HOST_BUDGET_AUDIT_SATURATED_REFUSAL,
  HOST_BUDGET_CORRUPT_REFUSAL,
  HOST_BUDGET_IMPLEMENT_REFUSAL,
  HOST_BUDGET_UNKNOWN_REFUSAL,
  readAuditBudgetState,
  releaseHostDispatch,
  type AuditBudgetLogEvent,
  type HostBudgetAdmission,
} from './host-dispatch-budget.admission.js';
import {
  AUDIT_BUDGET_SATURATED_REASON,
  AUDIT_BUDGET_UNKNOWN_REASON,
  AUDIT_BUDGET_UNAVAILABLE_REASON,
} from './downtime-worker.audit-availability.contract.js';
import type { AuditAvailabilityOutcome } from './downtime-worker.audit-availability.js';
import type { AuditLeaseAcquireOutcome } from './downtime-worker.audit-lease.js';
import { AUDIT_BUDGET_DIVERGENCE_REASON, AUDIT_BUDGET_LEGACY_REASON } from './downtime-log-budget.js';
import { HOST_BUDGET_CONFIG_FILE, isLegacyAuditBudgetEnabled } from './host-dispatch-budget.js';
import {
  DOWNTIME_HOST_AUDIT_MARKER_FILE,
  readActiveAuditMarker,
} from './machine-coordination.js';
import {
  budgetLedgerPath,
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

      // Instance A reserves WL-A; pane-1 then goes live. Instance B reserves
      // WL-B, whose pane does not exist yet — so the list it counts holds only
      // A's dispatch (WL-0MWFJDD8R005F5BV counts LIVE panes, and a dispatch
      // that has not spawned has none).
      const first = admit(INSTANCE_A, 'WL-A', makeLivePaneList([]));
      expect(first).toMatchObject({ admitted: true, live: 0, max: 2 });
      confirm(INSTANCE_A, 'WL-A', 'pane-1');

      const second = admit(
        INSTANCE_B,
        'WL-B',
        makeLivePaneList([{ paneId: 'pane-1', itemId: 'WL-A' }]),
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

  it('AC6 (WL-0MWFJD8ZO000J1R8): an unreadable ledger fails closed and is NEVER rewritten by a read', () =>
    withMachineDir((dir) => {
      writeBudgetConfig(dir, { maxImplement: 2 });
      const corrupt = '{ this is not json';
      writeRawBudgetLedger(dir, corrupt);

      const livePanes = makeLivePaneList(['WL-RUNNING']);
      const refused = admit(INSTANCE_A, 'WL-NEW', livePanes);

      expect(refused).toMatchObject({
        admitted: false,
        live: 0,
        max: 2,
        reason: HOST_BUDGET_CORRUPT_REFUSAL,
      });
      // The bytes are untouched: an admission read never repairs. The old
      // automatic repair reconstructed only `Downtime …` panes, silently
      // dropping decorated and manually-triggered ones.
      expect(readFileSync(budgetLedgerPath(dir), 'utf8')).toBe(corrupt);
      expect(readBudgetLedger(dir)).toBeNull();

      // A second tick is refused identically — still no rewrite, still corrupt.
      expect(admit(INSTANCE_A, 'WL-NEW', livePanes)).toMatchObject({
        admitted: false,
        reason: HOST_BUDGET_CORRUPT_REFUSAL,
      });
      expect(readFileSync(budgetLedgerPath(dir), 'utf8')).toBe(corrupt);

      // The EXPLICIT operator repair is the recovery, and dispatch resumes.
      const repaired = repairBudgetLedgerFromPanes(livePanes, {
        instanceId: 'operator',
        root: INSTANCE_A,
      });
      expect(repaired.ok).toBe(true);
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
    expect(admission).toMatchObject({ admitted: true, live: 0, max: 2 });
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

/**
 * The one-release legacy audit env (WL-0MWAMSK9H005BOHD): these F2 cases pin
 * the PRE-CHANGE `budget.json` + local-ledger decision, which is now reached
 * only through `HERDR_AUDIT_LOCAL_BUDGET=1`.
 */
const LEGACY_AUDIT_ENV: Readonly<Record<string, string | undefined>> = {
  HERDR_AUDIT_LOCAL_BUDGET: '1',
};

/** One audit asking the machine-scoped ledger for a slot (legacy local path). */
function auditAdmit(
  itemId: string,
  livePanes: Parameters<typeof admitHostDispatch>[1]['livePanes'],
  instanceId: string = INSTANCE_A,
): HostBudgetAdmission {
  return admitHostDispatch(
    { kind: 'audit', itemId, instanceId, root: '/repo/test' },
    { livePanes, env: LEGACY_AUDIT_ENV },
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
      expect(auditAdmit('WL-A', panes)).toMatchObject({ admitted: true, live: 0, max: 1 });

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

      expect(auditAdmit('WL-A', panes)).toMatchObject({ admitted: true, live: 0, max: 2 });
      expect(auditAdmit('WL-B', panes)).toMatchObject({ admitted: true, live: 1, max: 2 });
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
      expect(auditAdmit('WL-NEW', [])).toMatchObject({ admitted: true, live: 0, max: 1 });
      expect(readBudgetLedger(dir)?.entries.map((entry) => entry.itemId)).toEqual(['WL-NEW']);
      // Retirement: the stale file is neither counted nor deleted (an operator
      // or the older instance owns it).
      expect(readActiveAuditMarker(dir)).not.toBeNull();
    }));

  it('AC5: every release point (pane close, dispatch failure, claim rollback) frees the slot by identity', () =>
    withMachineDir((dir) => {
      writeBudgetConfig(dir, { maxImplement: 2, maxAudit: 1 });

      // All three abort paths in the claim pipeline call the same release seam
      // (`releaseHostDispatch` / `releaseHostBudgetForFailure`), so one release
      // assertion covers each of them; the per-path CALL SITES are asserted
      // individually in `downtime-worker.dispatch.test.ts` (marker-write
      // failure, spawn failure, admission refusal) and `index.test.ts` (pane
      // close). Since WL-0MWFJD5T4003OM91 the identity is the attempt token the
      // admission returned, never the item id alone.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const admission = auditAdmit('WL-AUD', []);
        expect(admission).toMatchObject({ admitted: true, live: 0, max: 1 });
        expect(typeof admission.attemptId).toBe('string');
        expect(
          releaseHostDispatch({
            itemId: 'WL-AUD',
            kind: 'audit',
            attemptId: admission.attemptId,
          }),
        ).toBe(true);
        expect(readAuditBudgetState({ livePanes: [] })).toMatchObject({ atCap: false, live: 0 });
        // Idempotent: a second release for the same dispatch is a no-op success.
        expect(
          releaseHostDispatch({
            itemId: 'WL-AUD',
            kind: 'audit',
            attemptId: admission.attemptId,
          }),
        ).toBe(true);
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

  it('AC6 (WL-0MWFJD8ZO000J1R8): an unreadable ledger fails closed and the pre-check NEVER rewrites it', () =>
    withMachineDir((dir) => {
      writeBudgetConfig(dir, { maxImplement: 2, maxAudit: 1 });
      const corrupt = '{ this is not json';
      writeRawBudgetLedger(dir, corrupt);
      const livePanes = makeLivePaneList([auditPane('pane-1', 'WL-RUNNING')]);

      expect(readAuditBudgetState({ livePanes })).toMatchObject({
        atCap: true,
        live: 0,
        max: 1,
        reason: HOST_BUDGET_CORRUPT_REFUSAL,
      });
      // An admission read never repairs: the bytes are untouched, so a repair
      // is always a deliberate, reported operator action.
      expect(readFileSync(budgetLedgerPath(dir), 'utf8')).toBe(corrupt);
      expect(readBudgetLedger(dir)).toBeNull();

      // The explicit repair is the recovery: the running audit pane becomes an
      // entry and the pre-check reports the real single-flight token.
      const repaired = repairBudgetLedgerFromPanes(livePanes, {
        instanceId: 'operator',
        root: '/repo/test',
      });
      expect(repaired.ok).toBe(true);
      expect(readAuditBudgetState({ livePanes })).toMatchObject({
        atCap: true,
        live: 1,
        max: 1,
        reason: HOST_BUDGET_AUDIT_SATURATED_REFUSAL,
      });
    }));
});

// ── Proxy-derived audit admission (WL-0MWAMSK9H005BOHD) ───────────────
//
// The audit tier's capacity decision is the proxy's shared verdict, NOT the
// per-host `budget.json` `maxAudit` cap. The local ledger stays as
// observability only: it is reserved/confirmed/released as before, but an
// entry can never refuse an audit, and a proxy/local disagreement is logged
// with both sides' evidence. `HERDR_AUDIT_LOCAL_BUDGET=1` restores the
// pre-change local decision for one release.

/** A permissive proxy outcome the audit tier should ADMIT. */
const proxyAdmits = (cap: number, live = 0): AuditAvailabilityOutcome => ({
  status: 'ok',
  availability: { cap, live, available: true },
});

/** A saturated proxy outcome the audit tier should REFUSE. */
const proxySaturated = (cap: number, live = cap): AuditAvailabilityOutcome => ({
  status: 'ok',
  availability: { cap, live, available: false },
});

/** A held-proxy-lease acquire outcome the helper defaults to (AC2). */
const LEASE_OK = (itemId: string): AuditLeaseAcquireOutcome => ({
  status: 'ok',
  lease: { sessionId: `herdr-audit-${itemId}` },
});

/** One audit asking the PROXY-derived path for a slot. */
function proxyAuditAdmit(
  itemId: string,
  availability: AuditAvailabilityOutcome | undefined,
  onAuditBudgetEvent?: (event: AuditBudgetLogEvent) => void,
  auditLease?: AuditLeaseAcquireOutcome,
): HostBudgetAdmission {
  return admitHostDispatch(
    { kind: 'audit', itemId, instanceId: INSTANCE_A, root: '/repo/test' },
    {
      livePanes: [],
      env: {},
      ...(availability !== undefined ? { auditAvailability: availability } : {}),
      ...(onAuditBudgetEvent !== undefined ? { onAuditBudgetEvent } : {}),
      // Lease discipline (WL-0MWFJH3NW006F5GN AC2): admission only admits an
      // AUDIT on a 200 acquire, so the pre-change helper defaults to a held
      // lease — a refused availability never reaches the lease gate, so the
      // existing saturation/unknown assertions are untouched, while AVOIDING
      // the fail-closed `lease-seam-absent` refusal that availability-only
      // admission now correctly produces.
      ...(auditLease !== undefined
        ? { auditLease }
        : { auditLease: LEASE_OK(itemId) }),
    },
  );
}

describe('host dispatch budget — proxy-derived audit admission (WL-0MWAMSK9H005BOHD)', () => {
  it('AC1: a permissive budget.json + permissive proxy admits; a saturated proxy refuses and the proxy decides', () =>
    withMachineDir((dir) => {
      // A deliberately PERMISSIVE local cap: if the local ledger decided, the
      // second audit (local live 1 < maxAudit 5) would be admitted.
      writeBudgetConfig(dir, { maxImplement: 2, maxAudit: 5 });

      expect(proxyAuditAdmit('WL-AUD-1', proxyAdmits(5))).toMatchObject({
        admitted: true,
        live: 0,
        max: 5,
      });
      // The admitted audit is still reserved locally (observability only).
      expect(readBudgetLedger(dir)?.entries.map((entry) => entry.itemId)).toEqual(['WL-AUD-1']);

      // The proxy now refuses while the local ledger is BELOW the local cap:
      // the proxy's verdict wins, with the proxy's own token and figures.
      expect(proxyAuditAdmit('WL-AUD-2', proxySaturated(5, 5))).toEqual({
        admitted: false,
        live: 5,
        max: 5,
        reason: AUDIT_BUDGET_SATURATED_REASON,
      });
      // A refusal reserves nothing.
      expect(readBudgetLedger(dir)?.entries.map((entry) => entry.itemId)).toEqual(['WL-AUD-1']);
    }));

  it('AC1: a proxy refusal is never overridden by a permissive local cap', () =>
    withMachineDir((dir) => {
      writeBudgetConfig(dir, { maxImplement: 2, maxAudit: 9 });
      expect(proxyAuditAdmit('WL-AUD', proxySaturated(1, 1))).toMatchObject({
        admitted: false,
        reason: AUDIT_BUDGET_SATURATED_REASON,
      });
      // Nothing was reserved for a refused dispatch.
      expect(readBudgetLedger(dir)).toBeNull();
    }));

  it('AC2: the pre-check helper and admission agree on the answer and the refusal token', () =>
    withMachineDir((dir) => {
      writeBudgetConfig(dir, { maxImplement: 2, maxAudit: 5 });
      const states: Array<AuditAvailabilityOutcome | undefined> = [
        proxyAdmits(5, 0),
        proxySaturated(5, 5),
        { status: 'endpoint-absent', reason: 'http-404' },
        { status: 'unreachable', reason: 'timeout' },
        { status: 'unparsable', reason: 'bad-body' },
        undefined,
      ];
      for (const [index, outcome] of states.entries()) {
        // `getActiveAudit` maps through this helper; admission must agree.
        const decision = decideAuditAvailability(outcome);
        const admission = proxyAuditAdmit(`WL-AGREE-${index}`, outcome);
        expect(admission.admitted).toBe(!decision.active);
        expect(admission.reason).toBe(decision.reason);
      }
    }));

  it('AC2: a divergence writes exactly ONE decision entry with both sides’ evidence', () =>
    withMachineDir((dir) => {
      writeBudgetConfig(dir, { maxImplement: 2, maxAudit: 1 });
      const events: AuditBudgetLogEvent[] = [];
      const sink = (event: AuditBudgetLogEvent): void => {
        events.push(event);
      };

      // Proxy ADMITS while the local ledger is at its cap → divergence.
      writeBudgetLedger(dir, [
        makeBudgetEntry({ kind: 'audit', itemId: 'WL-LOCAL', heartbeatAt: new Date().toISOString() }),
      ]);
      expect(proxyAuditAdmit('WL-PROXY-OK', proxyAdmits(1, 0), sink).admitted).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event: 'divergence',
        reason: AUDIT_BUDGET_DIVERGENCE_REASON,
        divergence: {
          proxy: { live: 0, cap: 1, available: true },
          local: { live: 1, maxAudit: 1 },
        },
      });

      // Inverse: proxy REFUSES while the local ledger is below the cap → one
      // more divergence, naming the other direction.
      events.length = 0;
      writeBudgetLedger(dir, []);
      expect(proxyAuditAdmit('WL-PROXY-NO', proxySaturated(1, 1), sink).admitted).toBe(false);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event: 'divergence',
        divergence: {
          proxy: { live: 1, cap: 1, available: false },
          local: { live: 0, maxAudit: 1 },
        },
      });
    }));

  it('AC2: an agreeing state writes NO decision entry (no log noise)', () =>
    withMachineDir((dir) => {
      writeBudgetConfig(dir, { maxImplement: 2, maxAudit: 1 });
      const events: AuditBudgetLogEvent[] = [];
      const sink = (event: AuditBudgetLogEvent): void => {
        events.push(event);
      };

      // Both agree there IS capacity: local empty, proxy admits.
      writeBudgetLedger(dir, []);
      expect(proxyAuditAdmit('WL-OK', proxyAdmits(1, 0), sink).admitted).toBe(true);
      expect(events).toEqual([]);

      // Both agree there is NO capacity: local at cap, proxy refuses.
      writeBudgetLedger(dir, [
        makeBudgetEntry({ kind: 'audit', itemId: 'WL-LOCAL', heartbeatAt: new Date().toISOString() }),
      ]);
      expect(proxyAuditAdmit('WL-NO', proxySaturated(1, 1), sink).admitted).toBe(false);
      expect(events).toEqual([]);
    }));

  it('AC3: an unreachable or absent proxy fails CLOSED as audit-budget-unknown', () =>
    withMachineDir((dir) => {
      writeBudgetConfig(dir, { maxImplement: 2, maxAudit: 9 });
      for (const outcome of [
        { status: 'unreachable', reason: 'timeout' } as const,
        { status: 'endpoint-absent', reason: 'http-404' } as const,
        { status: 'unparsable', reason: 'bad-body' } as const,
        undefined,
      ]) {
        const admission = proxyAuditAdmit('WL-UNKNOWN', outcome);
        expect(admission.admitted).toBe(false);
        expect(admission.reason).toBe(AUDIT_BUDGET_UNKNOWN_REASON);
      }
    }));

  it('AC3: HERDR_AUDIT_LOCAL_BUDGET=1 restores the local decision, ignores the proxy, and logs a legacy warning', () =>
    withMachineDir((dir) => {
      writeBudgetConfig(dir, { maxImplement: 2, maxAudit: 1 });
      const events: AuditBudgetLogEvent[] = [];
      const sink = (event: AuditBudgetLogEvent): void => {
        events.push(event);
      };
      const legacyAdmit = (
        itemId: string,
        availability: AuditAvailabilityOutcome,
      ): HostBudgetAdmission =>
        admitHostDispatch(
          { kind: 'audit', itemId, instanceId: INSTANCE_A, root: '/repo/test' },
          { livePanes: [], env: LEGACY_AUDIT_ENV, auditAvailability: availability, onAuditBudgetEvent: sink },
        );

      // Local at cap: the LEGACY token and the local figures decide, even
      // though the proxy would admit (the proxy is not consulted).
      writeBudgetLedger(dir, [
        makeBudgetEntry({ kind: 'audit', itemId: 'WL-RUN', heartbeatAt: new Date().toISOString() }),
      ]);
      expect(legacyAdmit('WL-B', proxyAdmits(9))).toMatchObject({
        admitted: false,
        live: 1,
        max: 1,
        reason: HOST_BUDGET_AUDIT_SATURATED_REFUSAL,
      });
      // The legacy path is marked in the decision log; no divergence entry.
      expect(events).toEqual([
        expect.objectContaining({ event: 'legacy', reason: AUDIT_BUDGET_LEGACY_REASON }),
      ]);

      // Local below cap + a SATURATED proxy: the local ledger admits (the proxy
      // is ignored), proving the legacy path never reads the proxy verdict.
      events.length = 0;
      writeBudgetLedger(dir, []);
      expect(legacyAdmit('WL-C', proxySaturated(1, 1))).toMatchObject({
        admitted: true,
        live: 0,
        max: 1,
      });
    }));

  it('AC: an audit entry is reserved on admit, absent on refuse, and can NEVER cause a refusal', () =>
    withMachineDir((dir) => {
      writeBudgetConfig(dir, { maxImplement: 2, maxAudit: 1 });

      // Local ledger AT CAP while the proxy admits: the entry is observability
      // only, so the audit is admitted (and its own entry reserved).
      writeBudgetLedger(dir, [
        makeBudgetEntry({ kind: 'audit', itemId: 'WL-LOCAL', heartbeatAt: new Date().toISOString() }),
      ]);
      expect(proxyAuditAdmit('WL-ADMITTED', proxyAdmits(3, 0)).admitted).toBe(true);
      expect(
        readBudgetLedger(dir)?.entries.map((entry) => entry.itemId).sort(),
      ).toEqual(['WL-ADMITTED', 'WL-LOCAL']);

      // Refusal path: no reservation.
      writeBudgetLedger(dir, []);
      expect(proxyAuditAdmit('WL-REFUSED', proxySaturated(1, 1)).admitted).toBe(false);
      expect(readBudgetLedger(dir)?.entries).toEqual([]);
    }));

  it('AC: the implement tier never reads the proxy (a saturated audit verdict is ignored)', () =>
    withMachineDir((dir) => {
      writeBudgetConfig(dir, { maxImplement: 2, maxAudit: 0 });
      const events: AuditBudgetLogEvent[] = [];
      const admission = admitHostDispatch(
        { kind: 'implement', itemId: 'WL-IMPL', instanceId: INSTANCE_A, root: '/repo/test' },
        {
          livePanes: [],
          env: {},
          auditAvailability: proxySaturated(0, 99),
          onAuditBudgetEvent: (event) => {
            events.push(event);
          },
        },
      );
      // The implement branch is byte-for-byte unchanged: it admits on
      // maxImplement and never looks at the audit availability or the sink.
      expect(admission).toMatchObject({ admitted: true, live: 0, max: 2 });
      expect(events).toEqual([]);
    }));

  it('isLegacyAuditBudgetEnabled reads the flag narrowly (only "1" enables it)', () => {
    expect(isLegacyAuditBudgetEnabled({})).toBe(false);
    expect(isLegacyAuditBudgetEnabled({ HERDR_AUDIT_LOCAL_BUDGET: '0' })).toBe(false);
    expect(isLegacyAuditBudgetEnabled({ HERDR_AUDIT_LOCAL_BUDGET: 'true' })).toBe(false);
    expect(isLegacyAuditBudgetEnabled({ HERDR_AUDIT_LOCAL_BUDGET: ' 1 ' })).toBe(true);
  });
});

// ── Unknown pane state (WL-0MW9VQX5T001GCUP) ──────────────────────────
//
// The admission layer receives the tri-state pane read: `undefined` means the
// pane list is UNKNOWN (a failed/unparseable read), which must never be
// conflated with an authoritative empty list. On unknown the implement tier
// counts by the freshness rule (over-count, never delete), the audit repair
// path skips the rewrite, and the unreadable-ledger repair is skipped — AC1(c)
// pins BOTH repair sites (audit `readAuditBudgetState`, implement
// `admitHostDispatch`).

describe('unknown pane state in admission (WL-0MW9VQX5T001GCUP)', () => {
  it('AC1(c) implement repair: an unreadable ledger plus an unknown pane read is NOT rewritten as empty', () =>
    withMachineDir((dir) => {
      writeBudgetConfig(dir, { maxImplement: 2 });
      writeRawBudgetLedger(dir, '{ this is not json');
      const before = readFileSync(budgetLedgerPath(dir), 'utf8');

      // `livePanes: undefined` = failed pane read: the repair must be skipped
      // (an unknown read can never rewrite a ledger from nothing).
      const refused = admitHostDispatch(
        { kind: 'implement', itemId: 'WL-NEW', instanceId: INSTANCE_A, root: '/repo/test' },
        { livePanes: undefined },
      );
      expect(refused).toMatchObject({
        admitted: false,
        live: 0,
        max: 2,
        // The corruption is named (WL-0MWFJD8ZO000J1R8) and nothing is
        // rewritten — a read never repairs, whatever the pane state.
        reason: HOST_BUDGET_CORRUPT_REFUSAL,
      });
      expect(readFileSync(budgetLedgerPath(dir), 'utf8')).toBe(before);
    }));

  it('AC1(a): the dispatcher admission read never deletes on an unknown pane read (freshness count)', () =>
    withMachineDir((dir) => {
      // max 1: the freshness fallback counts the fresh entry, so admission is
      // at cap and must REFUSE — if unknown were folded into an empty list the
      // read would report zero and over-admit.
      writeBudgetConfig(dir, { maxImplement: 1 });
      writeBudgetLedger(dir, [
        makeBudgetEntry({
          kind: 'implement',
          itemId: 'WL-LIVE',
          paneId: 'pane-1',
        }),
        // Stale and pane-less: would be reaped by a trusted empty read; must
        // survive an unknown one, and must not be written away.
        makeBudgetEntry({
          kind: 'implement',
          itemId: 'WL-CRASHED',
          paneId: 'pane-gone',
          heartbeatAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        }),
      ]);
      const before = readFileSync(budgetLedgerPath(dir), 'utf8');

      const admission = admitHostDispatch(
        { kind: 'implement', itemId: 'WL-NEW', instanceId: INSTANCE_A, root: '/repo/test' },
        { livePanes: undefined },
      );
      expect(admission).toMatchObject({ admitted: false, live: 1, max: 1 });
      expect(readFileSync(budgetLedgerPath(dir), 'utf8')).toBe(before);
    }));

  it('AC1(c) audit repair: an unreadable ledger plus an unknown pane read is NOT rewritten from nothing', () =>
    withMachineDir((dir) => {
      writeBudgetConfig(dir, { maxImplement: 2, maxAudit: 1 });
      writeRawBudgetLedger(dir, '{ this is not json');
      const before = readFileSync(budgetLedgerPath(dir), 'utf8');

      // `livePanes` absent/undefined already means "cannot repair now" on the
      // audit pre-check; a failed pane read must select exactly that arm.
      expect(readAuditBudgetState({ livePanes: undefined })).toMatchObject({
        atCap: true,
        live: 0,
        max: 1,
        reason: HOST_BUDGET_CORRUPT_REFUSAL,
      });
      expect(readFileSync(budgetLedgerPath(dir), 'utf8')).toBe(before);
    }));
});

// ── Audit-LEASE admission (WL-0MWFJH3NW006F5GN AC2) ────────────────────
//
// The availability read is the PRE-CHECK: its result alone can never admit.
// The admission decision is the proxy's atomic lease acquire — only a `200`
// admits, and every refusal maps to the shared token with the proxy's
// `retry_after_s` honoured as the cooldown.

describe('audit-lease admission (WL-0MWFJH3NW006F5GN)', () => {
  it('a held lease (200) admits and carries the session for the release discipline', () => {
    expect(
      decideAuditLeaseAdmission({
        status: 'ok',
        lease: { sessionId: 's-1', expiresAt: Date.now() + 60_000 },
      }),
    ).toEqual({
      admitted: true,
      lease: { sessionId: 's-1', expiresAt: expect.any(Number) },
    });
  });

  it('a 429 maps to audit-budget-saturated and carries the proxy retry_after_s as the cooldown', () => {
    expect(decideAuditLeaseAdmission({ status: 'saturated', reason: 'audit-budget-saturated', retryAfterS: 30 })).toEqual({
      admitted: false,
      reason: AUDIT_BUDGET_SATURATED_REASON,
      retryAfterS: 30,
    });
    // A payload without retry_after_s still refuses (429 is saturation by
    // status) — it simply carries no deferral advice.
    expect(decideAuditLeaseAdmission({ status: 'saturated', reason: 'audit-budget-saturated' })).toEqual({
      admitted: false,
      reason: AUDIT_BUDGET_SATURATED_REASON,
    });
  });

  it('a 503 maps to audit-budget-unavailable (proxy registry fault), NOT the local unknown token', () => {
    expect(
      decideAuditLeaseAdmission({ status: 'unavailable', reason: 'audit-budget-unavailable' }),
    ).toEqual({
      admitted: false,
      reason: AUDIT_BUDGET_UNAVAILABLE_REASON,
    });
  });

  it('a transport failure fails CLOSED as audit-budget-unknown with the failing exchange', () => {
    expect(decideAuditLeaseAdmission({ status: 'endpoint-absent', reason: 'http-404' })).toEqual({
      admitted: false,
      reason: AUDIT_BUDGET_UNKNOWN_REASON,
      detail: 'http-404',
    });
    expect(decideAuditLeaseAdmission({ status: 'unreachable', reason: 'timeout' })).toEqual({
      admitted: false,
      reason: AUDIT_BUDGET_UNKNOWN_REASON,
      detail: 'timeout',
    });
    expect(decideAuditLeaseAdmission({ status: 'unreachable', reason: 'network' })).toEqual({
      admitted: false,
      reason: AUDIT_BUDGET_UNKNOWN_REASON,
      detail: 'network',
    });
  });

  it('a missing lease seam fails CLOSED as audit-budget-unknown/lease-seam-absent — availability alone can never admit', () => {
    expect(decideAuditLeaseAdmission(undefined)).toEqual({
      admitted: false,
      reason: AUDIT_BUDGET_UNKNOWN_REASON,
      detail: 'lease-seam-absent',
    });
    // The demotion pin (AC4): even a fully ADMITTING availability read cannot
    // admit through admission without a lease hold.
    const availabilityAdmitting = {
      status: 'ok',
      availability: { cap: 1, live: 0, available: true },
    } as const;
    expect(decideAuditAvailability(availabilityAdmitting)).toEqual({
      active: false,
      budget: { live: 0, max: 1 },
    });
    const admission = admitHostDispatch(
      { kind: 'audit', itemId: 'WL-DEMOTED', instanceId: INSTANCE_A, root: '/repo/test' },
      { livePanes: [], env: {}, auditAvailability: availabilityAdmitting },
    );
    expect(admission).toEqual({
      admitted: false,
      live: 0,
      max: 1,
      reason: AUDIT_BUDGET_UNKNOWN_REASON,
      detail: 'lease-seam-absent',
    });
  });

  it('admission passes both gates: availability pre-check AND the lease 200', () =>
    withMachineDir((dir) => {
      writeBudgetConfig(dir, { maxImplement: 2, maxAudit: 1 });
      const admission = admitHostDispatch(
        { kind: 'audit', itemId: 'WL-BOTH', instanceId: INSTANCE_A, root: '/repo/test' },
        {
          livePanes: [],
          env: {},
          auditAvailability: {
            status: 'ok',
            availability: { cap: 1, live: 0, available: true },
          },
          auditLease: { status: 'ok', lease: { sessionId: 'herdr-audit-WL-BOTH' } },
        },
      );
      expect(admission).toMatchObject({
        admitted: true,
        live: 0,
        max: 1,
        lease: { sessionId: 'herdr-audit-WL-BOTH' },
      });
    }));
});
