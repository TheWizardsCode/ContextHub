/**
 * packages/herdr/src/downtime-worker.audit-availability-single-read.test.ts —
 * ONE availability observation per audit dispatch attempt
 * (WL-0MWJE9IEH001R3P1, implements parent WL-0MWJ7QYX0001KAQX AC2).
 *
 * The defect: an audit dispatch read the proxy TWICE — once in `getActiveAudit`
 * for the pre-check (mapped through `decideAuditAvailability`) and again moments
 * later inside `admitHostDispatch`, which re-mapped the second read. Two GETs
 * and two maps per candidate, with the second able to race the first.
 *
 * The fix pinned here:
 *
 *  - AC1 — the pre-check's RAW typed outcome is threaded through the dispatch
 *    attempt into admission (`DowntimeActiveAuditResult.availability` →
 *    `dispatchClaimedTier(opts.auditAvailability)` →
 *    `DowntimeHostBudgetAdmissionInput.auditAvailability`).
 *  - AC2 — admission no longer issues a second `readAuditAvailability()` GET
 *    for a candidate whose pre-check already read it (and no second derivation
 *    from a different observation).
 *  - AC3 — a counting stub seam asserts EXACTLY ONE read per audit candidate
 *    dispatch attempt, on both the live head-scan filter path and the legacy
 *    tier chain.
 *  - AC4 — every fail-closed mapping (`audit-budget-saturated` /
 *    `audit-budget-unknown`) is unchanged when the outcome is threaded.
 *  - AC5 — the lease acquire is still attempted ONLY when the pre-check admits,
 *    so a refused threaded availability never churns a lease.
 *  - AC6 — paths with no pre-check keep admission's single fail-closed
 *    fallback read (no behaviour change there).
 */

import { describe, it, expect, vi } from 'vitest';

import { createDowntimeDeps } from './index.js';
import { DISPATCHER_ASSIGNEE } from './index.claim.js';
import {
  AUDIT_BUDGET_SATURATED_REASON,
  AUDIT_BUDGET_UNKNOWN_REASON,
} from './downtime-worker.audit-availability.contract.js';
import type { AuditAvailabilityOutcome } from './downtime-worker.audit-availability.js';
import {
  auditLeaseSessionId,
  type AuditLeaseClient,
} from './downtime-worker.audit-lease.js';
import { dispatchClaimedTier } from './downtime-worker.dispatch-claims.js';
import { dispatchFromHerdrList } from './downtime-worker.dispatch-filter.js';
import { makeDeps } from './downtime-worker.fixtures.js';
import {
  dispatchDowntimeWork,
  type DowntimeCandidate,
  type DowntimeHerdrItem,
  type DowntimeWorkerDeps,
} from './downtime-worker.js';

// ── Fixtures ──────────────────────────────────────────────────────────

/** An audit candidate the claim pipeline can select. */
const AUDIT_CANDIDATE: DowntimeCandidate = {
  id: 'WL-AUD-ONE',
  title: 'Audit me once',
  stage: 'audit',
};

/** A Herdr-head audit item (completed/in_review, recent, unaudited). */
function auditHeadItem(): DowntimeHerdrItem {
  return {
    id: AUDIT_CANDIDATE.id,
    title: AUDIT_CANDIDATE.title,
    status: 'completed',
    stage: 'in_review',
    priority: 'high',
    updatedAt: new Date().toISOString(),
    sortIndex: 1,
  };
}

/** An availability read that ADMITS. */
const AVAILABLE: AuditAvailabilityOutcome = {
  status: 'ok',
  availability: { cap: 1, live: 0, available: true },
};

/** An availability read the proxy SATURATES (a fail-closed refusal). */
const SATURATED: AuditAvailabilityOutcome = {
  status: 'ok',
  availability: { cap: 1, live: 1, available: false },
};

/** A lease client that always grants `ok`, recording every acquire. */
function leaseClient(): { client: AuditLeaseClient; acquire: ReturnType<typeof vi.fn> } {
  const acquire = vi.fn(async (sessionId: string) => ({
    status: 'ok' as const,
    lease: { sessionId },
  }));
  return {
    acquire,
    client: {
      acquire,
      renew: vi.fn(async (sessionId: string) => ({
        status: 'ok' as const,
        lease: { sessionId },
      })),
      release: vi.fn(async () => ({ status: 'ok' as const })),
    },
  };
}

/**
 * The REAL production seams from `createDowntimeDeps` — the pre-check
 * (`getActiveAudit`) and admission (`admitHostDispatch`) — over an injected
 * counting availability client. The pane resolver is pinned to an UNKNOWN read
 * so no herdr subprocess runs; the audit branch admits on the proxy + lease.
 */
function realAuditSeams(read: ReturnType<typeof vi.fn>): {
  getActiveAudit: DowntimeWorkerDeps['getActiveAudit'];
  admitHostDispatch: NonNullable<DowntimeWorkerDeps['admitHostDispatch']>;
  acquire: ReturnType<typeof vi.fn>;
} {
  const lease = leaseClient();
  const deps = createDowntimeDeps(
    '/path/to/send-to-pi.sh',
    DISPATCHER_ASSIGNEE,
    undefined,
    undefined,
    async () => ({ ok: false }),
  );
  deps.readAuditAvailability = read;
  deps.auditLeaseClient = lease.client;
  return {
    getActiveAudit: deps.getActiveAudit.bind(deps),
    // `admitHostDispatch` reads `this.readAuditAvailability` / the lease
    // client, so bind it to the deps object it was defined on.
    admitHostDispatch: deps.admitHostDispatch.bind(deps),
    acquire: lease.acquire,
  };
}

// ── AC1/AC2: the threaded seam is honoured by admission ───────────────

describe('admission consumes the threaded availability outcome (AC1/AC2)', () => {
  it('never reads the proxy when the attempt threads the observation', async () => {
    const read = vi.fn(async () => SATURATED);
    const seams = realAuditSeams(read);

    const admission = await seams.admitHostDispatch({
      itemId: AUDIT_CANDIDATE.id,
      kind: 'audit',
      cwd: '/repo',
      auditAvailability: SATURATED,
    });

    // AC2: no second GET — the threaded outcome answered the whole attempt.
    expect(read).not.toHaveBeenCalled();
    // AC4: the fail-closed mapping is unchanged.
    expect(admission).toMatchObject({
      admitted: false,
      reason: AUDIT_BUDGET_SATURATED_REASON,
      live: 1,
      max: 1,
    });
    // AC5: a refused pre-check never churns a lease.
    expect(seams.acquire).not.toHaveBeenCalled();
  });

  it('carries a fail-closed unknown read through unchanged (AC4)', async () => {
    const read = vi.fn(async () => SATURATED);
    const seams = realAuditSeams(read);

    const admission = await seams.admitHostDispatch({
      itemId: AUDIT_CANDIDATE.id,
      kind: 'audit',
      cwd: '/repo',
      auditAvailability: { status: 'unreachable', reason: 'timeout' },
    });

    expect(read).not.toHaveBeenCalled();
    expect(admission).toMatchObject({
      admitted: false,
      reason: AUDIT_BUDGET_UNKNOWN_REASON,
      detail: 'timeout',
    });
    expect(seams.acquire).not.toHaveBeenCalled();
  });

  it('keeps ONE fallback read for a path with no pre-check (AC6)', async () => {
    const read = vi.fn(async () => AVAILABLE);
    const seams = realAuditSeams(read);

    const admission = await seams.admitHostDispatch({
      itemId: AUDIT_CANDIDATE.id,
      kind: 'audit',
      cwd: '/repo',
    });

    // No threaded outcome → admission takes its single fallback read.
    expect(read).toHaveBeenCalledTimes(1);
    expect(admission).toMatchObject({ admitted: true });
    expect(seams.acquire).toHaveBeenCalledTimes(1);
    expect(seams.acquire).toHaveBeenCalledWith(auditLeaseSessionId(AUDIT_CANDIDATE.id));
  });

  it('forwards the threaded outcome from dispatchClaimedTier into admission (AC1)', async () => {
    const admitHostDispatch = vi.fn(async () => ({ admitted: true, live: 0, max: 1 }));
    const deps = makeDeps({ admitHostDispatch });

    await dispatchClaimedTier(deps, 'audit', AUDIT_CANDIDATE, {
      model: 'plan',
      cwd: '/repo',
      auditAvailability: AVAILABLE,
    });

    expect(admitHostDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: AUDIT_CANDIDATE.id,
        kind: 'audit',
        auditAvailability: AVAILABLE,
      }),
    );
  });
});

// ── AC3: exactly one read per audit candidate dispatch attempt ────────

type ListCtx = Parameters<typeof dispatchFromHerdrList>[2];
type ListFlags = Parameters<typeof dispatchFromHerdrList>[3];

function listCtx(): ListCtx {
  return {
    cwd: '/repo',
    model: 'plan',
    frozen: false,
    cpuSaturated: false,
    panesEligible: true,
    auditSlotBudget: undefined,
    reviewGate: null,
    markerStaleWindowMs: 2 * 60 * 60 * 1000,
    nonTerminalCooldownMs: 30 * 60 * 1000,
    maxAttempts: 3,
    inFlight: { available: true, itemIds: new Set<string>() },
  };
}

function listFlags(): ListFlags {
  return {
    auditInFlight: false,
    auditCheckFailed: false,
    freshnessSkip: false,
    reviewHeld: false,
    cooldownHeld: false,
    budgetExhausted: false,
    cpuHeld: false,
    auditHostSaturated: false,
  };
}

describe('exactly one availability read per audit candidate attempt (AC3)', () => {
  it('live head-scan path: the pre-check read answers admission too', async () => {
    const read = vi.fn(async (): Promise<AuditAvailabilityOutcome> => AVAILABLE);
    const seams = realAuditSeams(read);
    const deps = makeDeps({
      getActiveAudit: seams.getActiveAudit,
      admitHostDispatch: seams.admitHostDispatch,
    });

    const outcome = await dispatchFromHerdrList(deps, [auditHeadItem()], listCtx(), listFlags());

    expect(outcome).toMatchObject({ dispatched: true, kind: 'audit' });
    // AC3: ONE proxy GET answers the pre-check AND admission.
    expect(read).toHaveBeenCalledTimes(1);
    expect(seams.acquire).toHaveBeenCalledTimes(1);
  });

  it('legacy tier chain: the pre-check read answers admission too', async () => {
    const read = vi.fn(async (): Promise<AuditAvailabilityOutcome> => AVAILABLE);
    const seams = realAuditSeams(read);
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: AUDIT_CANDIDATE }),
      getActiveAudit: seams.getActiveAudit,
      admitHostDispatch: seams.admitHostDispatch,
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome).toMatchObject({ dispatched: true, kind: 'audit' });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('a refused pre-check stops before admission and still reads once', async () => {
    const read = vi.fn(async (): Promise<AuditAvailabilityOutcome> => SATURATED);
    const seams = realAuditSeams(read);
    const deps = makeDeps({
      getActiveAudit: seams.getActiveAudit,
      admitHostDispatch: seams.admitHostDispatch,
    });

    const outcome = await dispatchFromHerdrList(deps, [auditHeadItem()], listCtx(), listFlags());

    // The audit tier is skipped on the pre-check refusal (no dispatch, no
    // cooldown) and the proxy was read once — admission never ran.
    expect(outcome).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    expect(seams.acquire).not.toHaveBeenCalled();
  });
});
