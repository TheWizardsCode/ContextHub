/**
 * packages/herdr/src/downtime-worker.dispatch-audit-lease.test.ts — the
 * dispatch-pipeline lease gate and release discipline
 * (WL-0MWFJH3NW006F5GN AC2/AC3/AC4/AC5).
 *
 * The admission seam (`index.ts`/harness) acquires a proxy lease once the
 * availability pre-check admits and hands the typed outcome to admission;
 * `dispatchClaimedTier` proceeds only on a held lease and RELEASES it on every
 * terminal path after admission (marker-write failure, spawn failure,
 * anchor-unavailable) via the `releaseAuditLease` seam. This suite drives the
 * REAL admission mapping and the REAL pipeline with injected acquire/release
 * seams, proving:
 *
 *   - a 429 acquire refuses the dispatch with the shared saturated token,
 *     the proxy's `retry_after_s` honoured as the cooldown, a rolled-back
 *     claim and no pane (and no lease release — nothing was held);
 *   - a missing lease seam on the proxy path FAILS CLOSED as
 *     `audit-budget-unknown`/`lease-seam-absent` — the demotion pin: an
 *     admitting availability read alone can never dispatch;
 *   - a 503 acquire refuses with `audit-budget-unavailable`;
 *   - a held lease dispatches, and a spawn failure / marker-write failure
 *     RELEASES the lease with the item-derived session id and a named reason;
 *   - the release is idempotent and best-effort (an unwired seam changes
 *     nothing).
 */

import { describe, expect, it, vi } from 'vitest';

import {
  admitHostDispatch,
  type AuditBudgetLogEvent,
} from './host-dispatch-budget.admission.js';
import {
  AUDIT_BUDGET_SATURATED_REASON,
  AUDIT_BUDGET_UNKNOWN_REASON,
  AUDIT_BUDGET_UNAVAILABLE_REASON,
} from './downtime-worker.audit-availability.contract.js';
import type { AuditAvailabilityOutcome } from './downtime-worker.audit-availability.js';
import {
  auditLeaseSessionId,
  type AuditLeaseAcquireOutcome,
} from './downtime-worker.audit-lease.js';
import { dispatchDowntimeWork, type DowntimeCandidate, type DowntimeWorkerDeps } from './downtime-worker.js';
import { makeDeps } from './downtime-worker.fixtures.js';
import { withMachineDir } from './host-dispatch-budget.fixtures.js';

/** An audit candidate the pipeline can select. */
const AUDIT_CANDIDATE: DowntimeCandidate = {
  id: 'WL-LEASE-CAND',
  title: 'Audit me',
  stage: 'audit',
};

/** An availability read that ADMITS (the pre-check that can never suffice). */
const AVAILABLE: AuditAvailabilityOutcome = {
  status: 'ok',
  availability: { cap: 1, live: 0, available: true },
};

/** The 429 acquire outcome with the proxy's bounded cooldown pinned. */
const SATURATED_LEASE: AuditLeaseAcquireOutcome = {
  status: 'saturated',
  reason: AUDIT_BUDGET_SATURATED_REASON,
  retryAfterS: 30,
};

/** The 503 acquirce outcome pinned to the documented registry token. */
const REGISTRY_FAIL_LEASE: AuditLeaseAcquireOutcome = {
  status: 'unavailable',
  reason: AUDIT_BUDGET_UNAVAILABLE_REASON,
};

/** A held lease for the candidate's item-derived session. */
const HELD_LEASE: AuditLeaseAcquireOutcome = {
  status: 'ok',
  lease: { sessionId: auditLeaseSessionId(AUDIT_CANDIDATE.id) },
};

/**
 * Build the production-shaped audit dispatch deps over a machine dir: the
 * REAL availability+lease admission mapping (the seam index.ts wires), the
 * REAL pipeline, and a release seam that records every released session.
 */
function auditLeaseDeps(
  dir: string,
  opts: { auditLease?: AuditLeaseAcquireOutcome; recordDispatch?: boolean },
): {
  deps: DowntimeWorkerDeps;
  released: Array<{ itemId: string; reason?: string }>;
} {
  const released: Array<{ itemId: string; reason?: string }> = [];
  const deps = makeDeps({
    getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: AUDIT_CANDIDATE }),
    admitHostDispatch: vi.fn(async (input: { itemId: string; kind: string; cwd: string }) =>
      admitHostDispatch(
        {
          kind: input.kind === 'audit' ? 'audit' : 'implement',
          itemId: input.itemId,
          instanceId: 'instance-test',
          root: input.cwd,
        },
        {
          dir,
          livePanes: [],
          env: {},
          // The seam hands admission BOTH the pre-check read and the acquire
          // outcome, mirroring index.ts (WL-0MWFJH3NW006F5GN AC2).
          auditAvailability: AVAILABLE,
          ...(opts.auditLease !== undefined ? { auditLease: opts.auditLease } : {}),
          onAuditBudgetEvent: (_event: AuditBudgetLogEvent) => undefined,
        },
      ),
    ),
    releaseAuditLease: vi.fn(async (itemId: string, _cwd: string, release) => {
      released.push({ itemId, ...(release?.reason !== undefined ? { reason: release.reason } : {}) });
    }),
    ...(opts.recordDispatch === false ? { recordDispatch: vi.fn().mockResolvedValue(false) } : {}),
  });
  return { deps, released };
}

describe('audit-lease gate in the dispatch pipeline (WL-0MWFJH3NW006F5GN)', () => {
  it('AC2: a 429 acquire refuses the dispatch with saturated + retry_after_s, rolls the claim back, and spawns nothing', async () => {
    await withMachineDir(async (dir) => {
      const { deps, released } = auditLeaseDeps(dir, { auditLease: SATURATED_LEASE });
      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome).toMatchObject({
        dispatched: false,
        reason: AUDIT_BUDGET_SATURATED_REASON,
        // The proxy's bounded deferral advice IS the cooldown carried out.
        retryAfterS: 30,
      });
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
      // Nothing was held (a refusal acquires nothing) — no release churn.
      expect(released).toEqual([]);
    });
  });

  it('AC4: an admitting availability read with NO lease seam fails CLOSED as lease-seam-absent — the availability read can never admit', async () => {
    await withMachineDir(async (dir) => {
      // The seam wired only the availability read (the pre-change shape).
      const { deps, released } = auditLeaseDeps(dir, {});
      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome).toMatchObject({
        dispatched: false,
        reason: AUDIT_BUDGET_UNKNOWN_REASON,
        detail: 'lease-seam-absent',
      });
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
      expect(released).toEqual([]);
    });
  });

  it('AC2: a 503 acquire refuses with audit-budget-unavailable (bounded-wait fallback: next tick re-checks)', async () => {
    await withMachineDir(async (dir) => {
      const { deps, released } = auditLeaseDeps(dir, { auditLease: REGISTRY_FAIL_LEASE });
      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome).toMatchObject({
        dispatched: false,
        reason: AUDIT_BUDGET_UNAVAILABLE_REASON,
      });
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
      expect(released).toEqual([]);
    });
  });

  it('AC2/AC4: a held lease (200) ADMITS the dispatch — the lease is the decision, not the availability read', async () => {
    await withMachineDir(async (dir) => {
      const { deps } = auditLeaseDeps(dir, { auditLease: HELD_LEASE });
      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome).toMatchObject({ dispatched: true, kind: 'audit' });
      expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    });
  });

  it('AC3: a spawn failure after a held lease RELEASES the proxy lease with the item-derived session id', async () => {
    await withMachineDir(async (dir) => {
      const base = auditLeaseDeps(dir, { auditLease: HELD_LEASE });
      base.deps.spawnAgentPane = vi.fn().mockResolvedValue({ ok: false, error: 'boom', exitCode: 1 } as never);
      const outcome = await dispatchDowntimeWork(base.deps, { model: 'plan', cwd: '/repo' });

      expect(outcome).toMatchObject({ dispatched: false, reason: 'spawn-failed' });
      // The terminal path released the lease, naming why.
      expect(base.released).toEqual([
        { itemId: AUDIT_CANDIDATE.id, reason: 'spawn-failed' },
      ]);
      // The id is the STABLE item-derived session — no state threaded.
      expect(auditLeaseSessionId(AUDIT_CANDIDATE.id)).toBe('herdr-audit-WL-LEASE-CAND');
    });
  });

  it('AC3: a marker-write failure after a held lease RELEASES the proxy lease', async () => {
    await withMachineDir(async (dir) => {
      const { deps, released } = auditLeaseDeps(dir, {
        auditLease: HELD_LEASE,
        recordDispatch: false,
      });
      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome).toMatchObject({ dispatched: false });
      // marker-write-failed (claim-rolled-back) — the lease did not outlive it.
      expect(released).toEqual([
        { itemId: AUDIT_CANDIDATE.id, reason: 'marker-write-failed' },
      ]);
    });
  });

  it('AC3: an unwired release seam is a non-event — the dispatch outcome is unchanged (best-effort release)', async () => {
    await withMachineDir(async (dir) => {
      const { deps } = auditLeaseDeps(dir, { auditLease: HELD_LEASE });
      // No releaseAuditLease seam at all (legacy/test caller): the release is
      // skipped, and a leaked lease is bounded by the proxy's own expiry.
      delete (deps as Partial<DowntimeWorkerDeps>).releaseAuditLease;
      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });
      expect(outcome).toMatchObject({ dispatched: true, kind: 'audit' });
    });
  });
});
