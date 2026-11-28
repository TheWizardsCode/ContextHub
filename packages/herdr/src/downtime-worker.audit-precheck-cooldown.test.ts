/**
 * packages/herdr/src/downtime-worker.audit-precheck-cooldown.test.ts — the
 * saturated pre-check refusal carries the derived cooldown
 * (WL-0MWJE9N7L001V6XI, parent WL-0MWJ7QYX0001KAQX AC3).
 *
 * The 429 `retry_after_s` is carried on the admission refusal
 * (`host-dispatch-budget.admission.ts`) and the orchestrator decision entry —
 * but the pre-check refuses BEFORE admission whenever the availability read
 * answers `available:false`, which is exactly the state a held foreign lease
 * produces. These tests pin that the SAME cooldown is derived from the
 * availability payload's `leases[].expiresAt` (epoch ms) and surfaced on the
 * pre-check decision, without an extra proxy call and without churning a
 * lease.
 *
 * Covers:
 *   - `deriveAuditRetryAfterS` — the pure derivation (held lease, earliest
 *     wins, rounding up, past-expiry clamp, malformed/absent degradation);
 *   - a captured-payload pre-check read (`getActiveAudit`) end to end;
 *   - the dispatch outcome + decision-entry field on the refusal;
 *   - the unchanged admission-carried `retryAfterS` surface.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  createAuditAvailabilityClient,
  dispatchDowntimeWork,
  type DowntimeActiveAuditResult,
} from './downtime-worker.js';
import { createDowntimeDeps } from './index.js';
import type { AuditAvailability } from './downtime-worker.audit-availability.contract.js';
import { makeDeps } from './downtime-worker.fixtures.js';
import { decideAuditLeaseAdmission, deriveAuditRetryAfterS } from './host-dispatch-budget.admission.js';
import { AUDIT_BUDGET_SATURATED_REASON } from './downtime-worker.audit-availability.contract.js';
import { refusalDecisionFields } from './downtime-worker.orchestrator-signals.js';
import { DISPATCHER_ASSIGNEE } from './index.claim.js';
import { makeTempDir, setupHostCpuPin, useIsolatedCoordinationDir } from './index.fixtures.js';

setupHostCpuPin();

/** A saturated availability payload holding one foreign lease. */
function heldLeaseAvailability(expiresAt: number): AuditAvailability {
  return {
    cap: 1,
    live: 1,
    available: false,
    leases: [{ id: 'foreign-session', expiresAt }],
  };
}

const NOW = 1_700_000_000_000;

describe('deriveAuditRetryAfterS — the pre-check cooldown derivation', () => {
  it('converts the held lease epoch-ms expiry into a seconds cooldown', () => {
    expect(deriveAuditRetryAfterS(heldLeaseAvailability(NOW + 30_000), NOW)).toBe(30);
  });

  it('rounds a partial second UP — a fraction of a second still means "not yet"', () => {
    expect(deriveAuditRetryAfterS(heldLeaseAvailability(NOW + 4_500), NOW)).toBe(5);
  });

  it('clamps an already-past expiry to 0 ("re-check now"), never a negative deferral', () => {
    expect(deriveAuditRetryAfterS(heldLeaseAvailability(NOW - 60_000), NOW)).toBe(0);
  });

  it('names the EARLIEST lease expiry — the first release is when the tier can next admit', () => {
    const availability: AuditAvailability = {
      cap: 2,
      live: 2,
      available: false,
      leases: [
        { expiresAt: NOW + 120_000 },
        { expiresAt: NOW + 15_000 },
        { expiresAt: NOW + 60_000 },
      ],
    };
    expect(deriveAuditRetryAfterS(availability, NOW)).toBe(15);
  });

  it('a malformed expiry degrades to "no cooldown named" and never throws', () => {
    const malformed = (expiresAt: unknown): AuditAvailability =>
      ({
        cap: 1,
        live: 1,
        available: false,
        leases: [{ expiresAt }],
      }) as unknown as AuditAvailability;

    expect(() => deriveAuditRetryAfterS(malformed(Number.NaN), NOW)).not.toThrow();
    expect(deriveAuditRetryAfterS(malformed(Number.NaN), NOW)).toBeUndefined();
    expect(deriveAuditRetryAfterS(malformed(Number.POSITIVE_INFINITY), NOW)).toBeUndefined();
    expect(deriveAuditRetryAfterS(malformed('soon'), NOW)).toBeUndefined();
    // A null lease entry at runtime is equally harmless.
    expect(
      deriveAuditRetryAfterS(
        { cap: 1, live: 1, available: false, leases: [null] } as unknown as AuditAvailability,
        NOW,
      ),
    ).toBeUndefined();
  });

  it('degrades to "no cooldown named" when the proxy serves no leases (saturated, leases: [])', () => {
    expect(
      deriveAuditRetryAfterS({ cap: 1, live: 1, available: false, leases: [] }, NOW),
    ).toBeUndefined();
    // The shipped proxy omits the array too — the same degradation.
    expect(deriveAuditRetryAfterS({ cap: 1, live: 1, available: false }, NOW)).toBeUndefined();
  });

  it('names no cooldown on a granted read, even when leases are served', () => {
    expect(
      deriveAuditRetryAfterS(
        { cap: 1, live: 0, available: true, leases: [{ expiresAt: NOW + 30_000 }] },
        NOW,
      ),
    ).toBeUndefined();
    expect(deriveAuditRetryAfterS(undefined, NOW)).toBeUndefined();
  });
});

describe('pre-check refusal carries the derived cooldown (captured payload)', () => {
  useIsolatedCoordinationDir();
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getActiveAudit derives retryAfterS from the held lease in ONE availability read', async () => {
    const expiresAt = Date.now() + 30_000;
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      // Captured shape: the proxy's own `available:false` verdict plus the
      // held lease the verdict came from.
      json: async () => ({
        cap: 1,
        live: 1,
        available: false,
        leases: [{ id: 'foreign-session', expires_at: expiresAt }],
      }),
    });
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    deps.readAuditAvailability = createAuditAvailabilityClient(
      'http://proxy:8000',
      fetcher as never,
    );

    const result = await deps.getActiveAudit(makeTempDir());

    expect(result).toMatchObject({
      ok: true,
      active: true,
      source: 'proxy',
      reason: AUDIT_BUDGET_SATURATED_REASON,
      budget: { live: 1, max: 1 },
    });
    // Derived from the held lease's epoch-ms expiry, rounded up and clamped.
    expect(result.ok && result.retryAfterS).toBeGreaterThanOrEqual(25);
    expect(result.ok && result.retryAfterS).toBeLessThanOrEqual(30);
    // NO extra proxy call: the refusal path issues exactly the one GET the
    // pre-check already needed — no lease acquire, nothing churned.
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, { method?: string }];
    expect(url).toBe('http://proxy:8000/llama/local/audit/availability');
    expect(init.method).toBe('GET');
  });

  it('a saturated payload with no leases names no cooldown (reported, not invented)', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ cap: 1, live: 1, available: false, leases: [] }),
    });
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    deps.readAuditAvailability = createAuditAvailabilityClient(
      'http://proxy:8000',
      fetcher as never,
    );

    const result = await deps.getActiveAudit(makeTempDir());

    expect(result).toMatchObject({
      ok: true,
      active: true,
      reason: AUDIT_BUDGET_SATURATED_REASON,
    });
    expect(result.ok && result.retryAfterS).toBeUndefined();
  });
});

describe('the pre-check refusal decision entry carries the cooldown', () => {
  const saturatedWithCooldown: DowntimeActiveAuditResult = {
    ok: true,
    active: true,
    source: 'proxy',
    reason: AUDIT_BUDGET_SATURATED_REASON,
    budget: { live: 1, max: 1 },
    retryAfterS: 30,
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('surfaces retryAfterS on the refusal outcome exactly like the admission 429 arm', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const deps = makeDeps({
      getActiveAudit: vi.fn().mockResolvedValue(saturatedWithCooldown),
      getNextAuditCandidate: vi.fn(),
      // Wired so the assertion proves the pre-check refusal never reached
      // admission (and thus never attempted a lease acquire).
      admitHostDispatch: vi.fn(),
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome).toMatchObject({
      dispatched: false,
      reason: AUDIT_BUDGET_SATURATED_REASON,
      budget: { live: 1, max: 1 },
      retryAfterS: 30,
    });
    // The acquire and every spawn seam stay untouched: the refusal is the
    // pre-check's, and it consumes nothing.
    expect(deps.getNextAuditCandidate).not.toHaveBeenCalled();
    expect(deps.admitHostDispatch).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();

    // The decision entry the orchestrator records is composed from the
    // outcome, so the cooldown reaches the log (same field the admission 429
    // arm populates).
    const entry = refusalDecisionFields(
      outcome,
      { freeSlots: 0, totalSlots: 2, ownerPresent: false, runningPanes: 1, contentionDepth: 0 },
      {},
      false,
    );
    expect(entry.retryAfterS).toBe(30);
  });

  it('a pre-check refusal with no usable lease records no retryAfterS field', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const deps = makeDeps({
      getActiveAudit: vi.fn().mockResolvedValue({
        ok: true,
        active: true,
        source: 'proxy',
        reason: AUDIT_BUDGET_SATURATED_REASON,
        budget: { live: 1, max: 1 },
      }),
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.reason).toBe(AUDIT_BUDGET_SATURATED_REASON);
    expect(outcome.retryAfterS).toBeUndefined();
    expect(
      refusalDecisionFields(
        outcome,
        { freeSlots: 0, totalSlots: 2, ownerPresent: false, runningPanes: 1, contentionDepth: 0 },
        {},
        false,
      ).retryAfterS,
    ).toBeUndefined();
  });
});

describe('the admission-carried retryAfterS surface is unchanged', () => {
  it('a 429 lease refusal still carries the proxy retry_after_s verbatim', () => {
    expect(
      decideAuditLeaseAdmission({
        status: 'saturated',
        reason: AUDIT_BUDGET_SATURATED_REASON,
        retryAfterS: 30,
      }),
    ).toEqual({
      admitted: false,
      reason: AUDIT_BUDGET_SATURATED_REASON,
      retryAfterS: 30,
    });
  });
});
