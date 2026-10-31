/**
 * packages/herdr/src/downtime-worker.leaf-audit.test.ts — leaf-aware audit
 * dispatch: the scope-classification half of the test contract.
 *
 * Parent: WL-0MSORQ8Y4004YT63 (leaf-aware downtime dispatch: leaf audits
 * dispatch on fewer free slots). Work item: WL-0MVV1EYM5008CY4G (C1 — the
 * failing-first harness every later slice builds on).
 *
 * ## Scope of THIS suite
 *
 * Parent AC6 names four test obligations: leaf-vs-parent classification,
 * children-query failure → parent gate, per-slot idle tracking integration
 * (reuses the WL-0MSG7P9N8009PCKG tracker) and the race-accepting variant
 * toggle. Only the **classification** half lands here, together with the
 * shared fixtures (`makeDeps.getAuditCandidateScope` + the partial-idle
 * 3-slot pool builders) the remaining obligations reuse.
 *
 * ## The boundary this suite pins
 *
 * `classifyAuditScope` maps the *dependency result* (`getAuditCandidateScope`,
 * `wl show <id> --children --json`) to `'leaf' | 'parent'`; it never parses
 * CLI output. Everything that can make the lookup untrustworthy — a CLI
 * error, a timeout, an unparseable payload, a missing `children` field, a
 * non-root candidate — collapses to `{ ok: false }` at the dep boundary
 * (C2/`index.ts`), and `{ ok: false }` must classify as `'parent'` so the
 * conservative all-slots-style gate is restored (parent AC1/AC3,
 * fail-closed). The parse-side cases ("absent/malformed `children` payload")
 * are therefore exercised here through their dep-result shape, which is the
 * only input the classifier has; C2 owns the parse-to-`{ok:false}` mapping
 * and asserts it against the real `wl` payloads.
 *
 * ## Red → green provenance
 *
 * Written **before** `classifyAuditScope` existed: the run recorded in the
 * work item shows this suite failing (the classifier export and the new
 * fixture builders were absent), then passing once the pure classifier and
 * the fixtures landed. Production behaviour is untouched by this slice: the
 * classifier has no call site yet (C3/C4 wire it), so every existing suite
 * keeps its current behaviour byte-for-byte.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
  ago,
  jsonResponseFixture,
  perSlotOneOfThreeFree,
  perSlotTwoOfThreeFree,
  makeDeps,
  threeSlotPoolStatus,
} from './downtime-worker.fixtures.js';
import {
  auditItemEligible,
  auditPinAdmits,
  classifyAuditScope,
  isLeafAuditSlotBand,
  probeLeafAuditAdmission,
  type AuditCandidateScopeResult,
} from './downtime-worker.gates.js';
import {
  createDowntimePoller,
  createDowntimeWorker,
  dispatchDowntimeWork,
  type DowntimeCandidate,
  type DowntimeHerdrItem,
  type DowntimeWorkerDeps,
} from './downtime-worker.js';
import {
  DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
  DOWNTIME_AUDIT_MIN_FREE_SLOTS,
  DOWNTIME_LEAF_AUDIT_MIN_FREE_SLOTS,
  LEAF_AUDIT_PIN_HOLD_REASON,
} from './downtime-worker.constants.js';
import type { CoordinationLogEntry } from './downtime-log.js';

describe('classifyAuditScope — leaf vs parent classification', () => {
  it.each<[string, AuditCandidateScopeResult, 'leaf' | 'parent']>([
    ['a root with an EMPTY children array is a leaf', { ok: true, scope: 'leaf' }, 'leaf'],
    ['a root with at least one child is a parent', { ok: true, scope: 'parent' }, 'parent'],
  ])('%s', (_name, result, expected) => {
    expect(classifyAuditScope(result)).toBe(expected);
  });

  it('classifies a leaf and a parent differently from the same-shaped result', () => {
    // Guard against a classifier that ignores `scope` entirely (e.g. always
    // returning the fail-closed default would pass the parent case alone).
    const leaf = classifyAuditScope({ ok: true, scope: 'leaf' });
    const parent = classifyAuditScope({ ok: true, scope: 'parent' });
    expect(leaf).not.toBe(parent);
  });
});

describe('classifyAuditScope — fail-closed defaults (children-query failure → parent gate)', () => {
  it.each<[string, AuditCandidateScopeResult]>([
    ['a CLI error / timeout / parse failure ({ ok: false })', { ok: false }],
    ['an absent `children` payload ({ ok: true } with no scope)', { ok: true }],
  ])('treats %s as a parent', (_name, result) => {
    expect(classifyAuditScope(result)).toBe('parent');
  });

  it('treats an explicit `{ ok: false }` carrying a leaf scope as a parent', () => {
    // The lookup failed, so any scope it claims is untrustworthy.
    expect(classifyAuditScope({ ok: false, scope: 'leaf' })).toBe('parent');
  });

  it.each<[string, unknown]>([
    ['a malformed scope value', 'LEAF'],
    ['an unexpected scope token', 'child'],
  ])('treats %s as a parent', (_name, scope) => {
    expect(
      classifyAuditScope({ ok: true, scope } as unknown as AuditCandidateScopeResult),
    ).toBe('parent');
  });

  it.each<[string, null | undefined]>([
    ['null', null],
    ['undefined', undefined],
  ])('treats a %s result as a parent', (_name, result) => {
    expect(classifyAuditScope(result as AuditCandidateScopeResult | null | undefined)).toBe(
      'parent',
    );
  });
});

describe('getAuditCandidateScope dep — neutral fixture default', () => {
  it('exposes the new dep with a neutral parent default', async () => {
    const deps = makeDeps();
    const lookup = deps.getAuditCandidateScope;
    expect(lookup).toBeDefined();
    // Neutral default = today's behaviour: every existing suite keeps the
    // conservative parent gate without opting in to the new dep.
    await expect(lookup!('WL-LEAF-OR-PARENT', '/repo')).resolves.toEqual({
      ok: true,
      scope: 'parent',
    });
  });

  it('lets a suite override the scope result for its own candidate', async () => {
    const getAuditCandidateScope = vi.fn().mockResolvedValue({ ok: true, scope: 'leaf' });
    const deps = makeDeps({ getAuditCandidateScope });

    const result = await deps.getAuditCandidateScope!('WL-LEAF', '/repo');

    expect(getAuditCandidateScope).toHaveBeenCalledWith('WL-LEAF', '/repo');
    expect(classifyAuditScope(result)).toBe('leaf');
  });
});

describe('three-slot partial-idle pool fixtures', () => {
  it.each<[1 | 2]>([[1], [2]])(
    'builds a 3-slot pool with exactly %i free slot(s) in per-slot form',
    (freeSlots) => {
      const status = threeSlotPoolStatus(freeSlots);

      expect(status.total_slots).toBe(3);
      expect(status.available_slots).toBe(freeSlots);
      expect(status.slots).toHaveLength(3);
      expect(status.slots?.filter((slot) => slot.is_processing === false)).toHaveLength(freeSlots);
      expect(status.slots?.map((slot) => slot.slot_id)).toEqual(['slot-1', 'slot-2', 'slot-3']);
    },
  );

  it('derives the reused 1-free fixture without drifting from it', () => {
    // The 1-of-3 pool already existed (spare-capacity work). The builder must
    // reproduce it exactly rather than introduce a second, divergent fixture.
    expect(threeSlotPoolStatus(1)).toEqual(perSlotOneOfThreeFree);
  });

  it('exposes the 2-free pool the later slices dispatch on', () => {
    expect(perSlotTwoOfThreeFree.available_slots).toBe(2);
    expect(perSlotTwoOfThreeFree.total_slots).toBe(3);
    // The operator's session keeps slot-1; the trailing two slots are free.
    expect(perSlotTwoOfThreeFree.slots?.map((slot) => slot.is_processing)).toEqual([
      true,
      false,
      false,
    ]);
  });
});

describe('DOWNTIME_LEAF_AUDIT_MIN_FREE_SLOTS — the leaf audit slot budget', () => {
  it('requires exactly one free slot for a leaf audit and strictly fewer than a parent audit', () => {
    // A leaf audit is a single Pi session; a parent audit fans out to
    // parent + up to 2 children (AUDIT_PHASE2_PARALLELISM=1). The two budgets
    // must stay distinct, or the leaf-aware gate degrades into the parent
    // gate (or, worse, admits a parent audit on a single free slot).
    expect(DOWNTIME_LEAF_AUDIT_MIN_FREE_SLOTS).toBe(1);
    expect(DOWNTIME_LEAF_AUDIT_MIN_FREE_SLOTS).toBeLessThan(DOWNTIME_AUDIT_MIN_FREE_SLOTS);
    // A leaf audit still needs a slot — 0 would mean "dispatch with none".
    expect(DOWNTIME_LEAF_AUDIT_MIN_FREE_SLOTS).toBeGreaterThan(0);
  });
});

// ── Per-item leaf-aware audit slot minimum (C3, WL-0MVV1EZVB007M1LR) ──
//
// The audit slot minimum became a PER-CANDIDATE decision (parent
// WL-0MSORQ8Y4004YT63 AC2/AC3): at/above the parent minimum everything is
// unchanged and NO scope lookup happens; in the single-free-slot band only a
// trusted `leaf` may consume the slot, while a parent — or any untrustworthy
// `{ ok: false }` lookup — is skipped exactly as before (fail-closed). The
// same helper decides on the legacy tier chain and every Herdr-head scan, so
// the same candidate/free-slot pair can never produce two decisions.

describe('isLeafAuditSlotBand', () => {
  it.each<[number, boolean]>([
    [0, false],
    [1, true],
    [2, false],
    [3, false],
  ])('reports %i free slot(s) as in-band = %s', (freeSlots, expected) => {
    expect(isLeafAuditSlotBand(freeSlots)).toBe(expected);
  });

  it('never places an unknown slot count in the leaf band', () => {
    // Direct-API callers pass no count: fail-open, unchanged — and never a
    // "band" that would demand a scope lookup.
    expect(isLeafAuditSlotBand(undefined)).toBe(false);
  });
});

describe('auditItemEligible — per-item audit slot minimum', () => {
  const leafLookup = () => vi.fn().mockResolvedValue({ ok: true, scope: 'leaf' });

  it('is eligible at/above the PARENT minimum without any scope lookup (AC1)', async () => {
    const getAuditCandidateScope = vi.fn();

    await expect(
      auditItemEligible({ getAuditCandidateScope }, { id: 'WL-AUD' }, DOWNTIME_AUDIT_MIN_FREE_SLOTS, '/repo'),
    ).resolves.toBe(true);
    await expect(
      auditItemEligible({ getAuditCandidateScope }, { id: 'WL-AUD' }, 3, '/repo'),
    ).resolves.toBe(true);

    // Zero extra `wl` calls in the normal case — the parent minimum is the
    // ceiling and short-circuits before classification.
    expect(getAuditCandidateScope).not.toHaveBeenCalled();
  });

  it('is eligible for a direct-API caller (no slot count) without a lookup', async () => {
    const getAuditCandidateScope = vi.fn();

    await expect(
      auditItemEligible({ getAuditCandidateScope }, { id: 'WL-AUD' }, undefined, '/repo'),
    ).resolves.toBe(true);
    expect(getAuditCandidateScope).not.toHaveBeenCalled();
  });

  it('admits a trusted LEAF in the single-free-slot band', async () => {
    const getAuditCandidateScope = leafLookup();

    await expect(
      auditItemEligible({ getAuditCandidateScope }, { id: 'WL-LEAF' }, DOWNTIME_LEAF_AUDIT_MIN_FREE_SLOTS, '/repo'),
    ).resolves.toBe(true);
    expect(getAuditCandidateScope).toHaveBeenCalledWith('WL-LEAF', '/repo');
  });

  it.each<[string, AuditCandidateScopeResult]>([
    ['a parent', { ok: true, scope: 'parent' }],
    ['an untrustworthy { ok: false } lookup', { ok: false }],
    ['a lookup with no scope', { ok: true }],
  ])('skips %s in the single-free-slot band (fail-closed)', async (_name, result) => {
    const getAuditCandidateScope = vi.fn().mockResolvedValue(result);

    await expect(
      auditItemEligible({ getAuditCandidateScope }, { id: 'WL-AUD' }, 1, '/repo'),
    ).resolves.toBe(false);
  });

  it('fails closed (parent gate) when the scope lookup throws', async () => {
    const getAuditCandidateScope = vi.fn().mockRejectedValue(new Error('wl timeout'));

    await expect(
      auditItemEligible({ getAuditCandidateScope }, { id: 'WL-AUD' }, 1, '/repo'),
    ).resolves.toBe(false);
  });

  it('fails closed (parent gate) when the deps object has no scope lookup at all', async () => {
    await expect(auditItemEligible({}, { id: 'WL-AUD' }, 1, '/repo')).resolves.toBe(false);
  });

  it('is ineligible with no free slot and performs no lookup', async () => {
    const getAuditCandidateScope = leafLookup();

    await expect(
      auditItemEligible({ getAuditCandidateScope }, { id: 'WL-AUD' }, 0, '/repo'),
    ).resolves.toBe(false);
    expect(getAuditCandidateScope).not.toHaveBeenCalled();
  });
});

describe('dispatchDowntimeWork — per-item audit minimum on the legacy tier chain', () => {
  const auditCandidate: DowntimeCandidate = { id: 'WL-AUD', title: 'Audit me', stage: 'audit' };
  const planCandidate: DowntimeCandidate = {
    id: 'WL-PLAN',
    title: 'Prep task',
    stage: 'intake_complete',
    status: 'open',
  };

  it('dispatches a LEAF audit with exactly 1 free slot', async () => {
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: auditCandidate }),
      getAuditCandidateScope: vi.fn().mockResolvedValue({ ok: true, scope: 'leaf' }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', freeSlots: 1 });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('audit');
    expect(outcome.candidate?.id).toBe('WL-AUD');
    expect(deps.getAuditCandidateScope).toHaveBeenCalledWith('WL-AUD', '/repo');
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:audit WL-AUD'),
      expect.anything(),
    );
  });

  it('skips a PARENT audit with exactly 1 free slot and falls through to the plan tier', async () => {
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: auditCandidate }),
      getAuditCandidateScope: vi.fn().mockResolvedValue({ ok: true, scope: 'parent' }),
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: planCandidate }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', freeSlots: 1 });

    // Unchanged behaviour for a parent: ineligible, not a strike, no audit
    // pane — the single-pane plan tier takes the slot.
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
    expect(deps.spawnAgentPane).not.toHaveBeenCalledWith(
      expect.stringContaining('/skill:audit'),
      expect.anything(),
    );
  });

  it('skips an untrustworthy { ok: false } scope with exactly 1 free slot', async () => {
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: auditCandidate }),
      getAuditCandidateScope: vi.fn().mockResolvedValue({ ok: false }),
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: planCandidate }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', freeSlots: 1 });

    expect(outcome.kind).toBe('plan');
  });

  it('performs NO scope lookup at the parent minimum (AC1)', async () => {
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: auditCandidate }),
      getAuditCandidateScope: vi.fn().mockResolvedValue({ ok: true, scope: 'leaf' }),
    });

    const outcome = await dispatchDowntimeWork(deps, {
      model: 'plan',
      cwd: '/repo',
      freeSlots: DOWNTIME_AUDIT_MIN_FREE_SLOTS,
    });

    expect(outcome.kind).toBe('audit');
    expect(deps.getAuditCandidateScope).not.toHaveBeenCalled();
  });
});

describe('dispatchDowntimeWork — per-item audit minimum on the Herdr head filter', () => {
  /** A root completed/in_review item with no fresh audit (audit-eligible). */
  const auditHead = (id: string): DowntimeHerdrItem => ({
    id,
    title: `Audit ${id}`,
    status: 'completed',
    stage: 'in_review',
    updatedAt: ago(60_000),
    sortIndex: 10,
  });
  const planHead = (id: string): DowntimeHerdrItem => ({
    id,
    title: `Plan ${id}`,
    status: 'open',
    stage: 'intake_complete',
    sortIndex: 20,
  });

  it('dispatches a LEAF audit from the Herdr head with exactly 1 free slot', async () => {
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [auditHead('WL-AUD')] }),
      getAuditCandidateScope: vi.fn().mockResolvedValue({ ok: true, scope: 'leaf' }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', freeSlots: 1 });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('audit');
    expect(outcome.candidate?.id).toBe('WL-AUD');
    expect(deps.getAuditCandidateScope).toHaveBeenCalledWith('WL-AUD', '/repo');
  });

  it('skips a PARENT audit from the Herdr head with exactly 1 free slot', async () => {
    const deps = makeDeps({
      getHerdrListHead: vi
        .fn()
        .mockResolvedValue({ ok: true, items: [auditHead('WL-AUD'), planHead('WL-PLAN')] }),
      getAuditCandidateScope: vi.fn().mockResolvedValue({ ok: true, scope: 'parent' }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', freeSlots: 1 });

    // Unchanged for a parent: the audit head is filtered and the plan head
    // (single pane, ≥1 slot) dispatches.
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
    expect(outcome.candidate?.id).toBe('WL-PLAN');
  });

  it('performs NO scope lookup on the Herdr head at the parent minimum (AC1)', async () => {
    const deps = makeDeps({
      getHerdrListHead: vi
        .fn()
        .mockResolvedValue({ ok: true, items: [auditHead('WL-AUD'), planHead('WL-PLAN')] }),
      getAuditCandidateScope: vi.fn(),
    });

    const outcome = await dispatchDowntimeWork(deps, {
      model: 'plan',
      cwd: '/repo',
      freeSlots: DOWNTIME_AUDIT_MIN_FREE_SLOTS,
    });

    expect(outcome.kind).toBe('audit');
    expect(deps.getAuditCandidateScope).not.toHaveBeenCalled();
  });
});

describe('per-item audit minimum — the selection paths agree (AC3)', () => {
  const auditCandidate: DowntimeCandidate = { id: 'WL-AUD', title: 'Audit me', stage: 'audit' };
  const auditHead: DowntimeHerdrItem = {
    id: 'WL-AUD',
    title: 'Audit WL-AUD',
    status: 'completed',
    stage: 'in_review',
    updatedAt: ago(60_000),
    sortIndex: 10,
  };
  const planCandidate: DowntimeCandidate = {
    id: 'WL-PLAN',
    title: 'Prep task',
    stage: 'intake_complete',
    status: 'open',
  };
  const planHead: DowntimeHerdrItem = {
    id: 'WL-PLAN',
    title: 'Plan WL-PLAN',
    status: 'open',
    stage: 'intake_complete',
    sortIndex: 20,
  };

  /** Dispatch the same candidate through the legacy tier chain (empty head). */
  const viaLegacy = (scope: AuditCandidateScopeResult, freeSlots: number) =>
    dispatchDowntimeWork(
      makeDeps({
        getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: auditCandidate }),
        getAuditCandidateScope: vi.fn().mockResolvedValue(scope),
        getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: planCandidate }),
      }),
      { model: 'plan', cwd: '/repo', freeSlots },
    );

  /** Dispatch the same candidate through the Herdr head filter. */
  const viaHerdrHead = (scope: AuditCandidateScopeResult, freeSlots: number) =>
    dispatchDowntimeWork(
      makeDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [auditHead, planHead] }),
        getAuditCandidateScope: vi.fn().mockResolvedValue(scope),
      }),
      { model: 'plan', cwd: '/repo', freeSlots },
    );

  it.each<[string, AuditCandidateScopeResult, string]>([
    ['a leaf', { ok: true, scope: 'leaf' }, 'audit'],
    ['a parent', { ok: true, scope: 'parent' }, 'plan'],
    ['an untrustworthy lookup', { ok: false }, 'plan'],
  ])('takes the same decision for %s on the legacy chain and the Herdr head', async (_name, scope, expectedKind) => {
    const freeSlots = 1; // the leaf-audit band
    const legacy = await viaLegacy(scope, freeSlots);
    const herdr = await viaHerdrHead(scope, freeSlots);

    expect(legacy.kind).toBe(expectedKind);
    expect(herdr.kind).toBe(expectedKind);
  });
});

// ── Relaxed leaf-audit TICK admission (C4, WL-0MVV1F0HK009JQAP) ────────
//
// The tick normally requires `downtimeRequiredFreeSlots` (default 2 of 3)
// continuously-free slots before ANY dispatch. C4 relaxes that requirement for
// ONE positively classified LEAF audit candidate and pins the relaxed slot to
// that item. The suite below pins: the admission itself (AC1), the single-tier
// pin (AC2), every fail-closed case (AC3), the decision-log observations (AC4)
// and the same-slot identity the per-slot tracker supplies (AC5).

describe('probeLeafAuditAdmission — the leaf-band audit peek', () => {
  const evidence = { freeSlots: 1, thresholdMetCount: 1, requiredFreeSlots: 2 };
  const leafCandidate = { id: 'WL-LEAF', title: 'Leaf', stage: 'audit' as const };

  const leafDeps = (overrides: Partial<Parameters<typeof probeLeafAuditAdmission>[0]> = {}) => ({
    getActiveAudit: vi.fn().mockResolvedValue({ ok: true, active: false }),
    getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: leafCandidate }),
    getAuditCandidateScope: vi.fn().mockResolvedValue({ ok: true, scope: 'leaf' as const }),
    ...overrides,
  });

  it('admits a trusted LEAF and carries the slot/threshold evidence', async () => {
    const deps = leafDeps();

    await expect(probeLeafAuditAdmission(deps, '/repo', evidence)).resolves.toEqual({
      kind: 'admitted',
      admission: { itemId: 'WL-LEAF', ...evidence },
    });
    expect(deps.getActiveAudit).toHaveBeenCalledWith('/repo');
    expect(deps.getNextAuditCandidate).toHaveBeenCalledWith('/repo');
    expect(deps.getAuditCandidateScope).toHaveBeenCalledWith('WL-LEAF', '/repo');
  });

  it.each<[string, AuditCandidateScopeResult]>([
    ['a parent', { ok: true, scope: 'parent' }],
    ['an untrustworthy { ok: false } lookup', { ok: false }],
    ['a lookup with no scope', { ok: true }],
  ])('reports %s as non-leaf (fail-closed)', async (_name, result) => {
    const deps = leafDeps({ getAuditCandidateScope: vi.fn().mockResolvedValue(result) });

    await expect(probeLeafAuditAdmission(deps, '/repo', evidence)).resolves.toEqual({
      kind: 'non-leaf',
      itemId: 'WL-LEAF',
      scope: 'parent',
    });
  });

  it('treats a throwing or absent scope lookup as a parent', async () => {
    await expect(
      probeLeafAuditAdmission(
        leafDeps({ getAuditCandidateScope: vi.fn().mockRejectedValue(new Error('wl timeout')) }),
        '/repo',
        evidence,
      ),
    ).resolves.toEqual({ kind: 'non-leaf', itemId: 'WL-LEAF', scope: 'parent' });

    await expect(
      probeLeafAuditAdmission(
        leafDeps({ getAuditCandidateScope: undefined }),
        '/repo',
        evidence,
      ),
    ).resolves.toEqual({ kind: 'non-leaf', itemId: 'WL-LEAF', scope: 'parent' });
  });

  it('reports no candidate when the audit tier is genuinely empty', async () => {
    const deps = leafDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    });

    await expect(probeLeafAuditAdmission(deps, '/repo', evidence)).resolves.toEqual({
      kind: 'no-candidate',
    });
    // No candidate → no scope lookup, no relaxation.
    expect(deps.getAuditCandidateScope).not.toHaveBeenCalled();
  });

  it('never relaxes for a budget-exhausted (needsProducerReview) candidate', async () => {
    const deps = leafDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { ...leafCandidate, needsProducerReview: true },
      }),
    });

    await expect(probeLeafAuditAdmission(deps, '/repo', evidence)).resolves.toEqual({
      kind: 'no-candidate',
    });
  });

  it('honours the active-audit single-flight check (no candidate lookup)', async () => {
    const deps = leafDeps({
      getActiveAudit: vi.fn().mockResolvedValue({ ok: true, active: true }),
    });

    await expect(probeLeafAuditAdmission(deps, '/repo', evidence)).resolves.toEqual({
      kind: 'unavailable',
    });
    expect(deps.getNextAuditCandidate).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, unknown>]>([
    ['a failed active-audit lookup', { getActiveAudit: vi.fn().mockResolvedValue({ ok: false }) }],
    [
      'a failed candidate lookup',
      { getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: false, error: 'wl' }) },
    ],
    [
      'a throwing candidate lookup',
      { getNextAuditCandidate: vi.fn().mockRejectedValue(new Error('wl timeout')) },
    ],
  ])('fails closed on %s', async (_name, overrides) => {
    await expect(
      probeLeafAuditAdmission(leafDeps(overrides as never), '/repo', evidence),
    ).resolves.toEqual({ kind: 'unavailable' });
  });
});

describe('auditPinAdmits — the single-tier pin', () => {
  it('admits every candidate when no pin is in play', () => {
    expect(auditPinAdmits(undefined, 'WL-ANY')).toBe(true);
  });

  it('admits only the pinned candidate when a relaxed tick pinned one', () => {
    expect(auditPinAdmits('WL-LEAF', 'WL-LEAF')).toBe(true);
    expect(auditPinAdmits('WL-LEAF', 'WL-OTHER')).toBe(false);
  });
});

describe('dispatchDowntimeWork — the relaxed slot is pinned to one audit item', () => {
  const auditCandidate: DowntimeCandidate = { id: 'WL-AUD', title: 'Audit me', stage: 'audit' };
  const planCandidate: DowntimeCandidate = {
    id: 'WL-PLAN',
    title: 'Prep task',
    stage: 'intake_complete',
    status: 'open',
  };
  const planHead: DowntimeHerdrItem = {
    id: 'WL-PLAN',
    title: 'Plan WL-PLAN',
    status: 'open',
    stage: 'intake_complete',
    sortIndex: 20,
  };

  it('dispatches the pinned LEAF audit on the legacy chain with 1 free slot', async () => {
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: auditCandidate }),
      getAuditCandidateScope: vi.fn().mockResolvedValue({ ok: true, scope: 'leaf' }),
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: planCandidate }),
    });

    const outcome = await dispatchDowntimeWork(deps, {
      model: 'plan',
      cwd: '/repo',
      freeSlots: 1,
      pinnedAuditItemId: 'WL-AUD',
    });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('audit');
    expect(outcome.candidate?.id).toBe('WL-AUD');
  });

  it('never dispatches another tier under the pin — the slot stays reserved', async () => {
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planHead] }),
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: planCandidate }),
    });

    const outcome = await dispatchDowntimeWork(deps, {
      model: 'plan',
      cwd: '/repo',
      freeSlots: 1,
      pinnedAuditItemId: 'WL-AUD',
    });

    // plan/intake/implement are ineligible: the relaxed slot belongs to the
    // pinned audit item only.
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe(LEAF_AUDIT_PIN_HOLD_REASON);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(deps.getNextItem).not.toHaveBeenCalled();
  });

  it('does not dispatch a DIFFERENT audit candidate than the pinned one', async () => {
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: auditCandidate }),
      getAuditCandidateScope: vi.fn().mockResolvedValue({ ok: true, scope: 'leaf' }),
    });

    const outcome = await dispatchDowntimeWork(deps, {
      model: 'plan',
      cwd: '/repo',
      freeSlots: 1,
      pinnedAuditItemId: 'WL-SOMEONE-ELSE',
    });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe(LEAF_AUDIT_PIN_HOLD_REASON);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('leaves the unpinned behaviour byte-for-byte (plan still dispatches at 1 free slot)', async () => {
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: planCandidate }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', freeSlots: 1 });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
  });
});

describe('worker tick — leaf-aware admission with a single-tier pin (AC1/AC2)', () => {
  /** Deterministic per-slot worker over a 3-slot pool. */
  function makeLeafWorker(opts: {
    requiredFreeSlots?: number;
    thresholdMs?: number;
    status?: unknown;
    deps?: Partial<DowntimeWorkerDeps>;
    recordDecision?: (entry: CoordinationLogEntry, cwd: string) => Promise<void>;
  } = {}) {
    const cfg = {
      enabled: true,
      thresholdMs: opts.thresholdMs ?? DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
      requiredFreeSlots: opts.requiredFreeSlots ?? 2,
      model: 'plan',
      cwd: '/repo',
      noCandidateCooldownMs: 3_600_000,
      browseItemCount: 20,
    };
    const fetcher = vi
      .fn()
      .mockResolvedValue(jsonResponseFixture(opts.status ?? threeSlotPoolStatus(1)));
    const poller = createDowntimePoller('http://proxy:8000', fetcher);
    const deps = makeDeps({
      ...(opts.recordDecision ? { recordDecision: opts.recordDecision } : {}),
      ...opts.deps,
    });
    const worker = createDowntimeWorker({ poller, deps, config: () => ({ ...cfg }) });
    return { worker, deps, cfg, fetcher };
  }

  const leafCandidate = { id: 'WL-LEAF', title: 'Leaf', stage: 'audit' as const };
  const planCandidate = {
    id: 'WL-PLAN',
    title: 'Prep task',
    stage: 'intake_complete',
    status: 'open',
  };
  const leafDeps = (overrides: Partial<DowntimeWorkerDeps> = {}): Partial<DowntimeWorkerDeps> => ({
    getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: leafCandidate }),
    getAuditCandidateScope: vi.fn().mockResolvedValue({ ok: true, scope: 'leaf' }),
    getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: planCandidate }),
    ...overrides,
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('dispatches a leaf audit with only 1 of 3 slots continuously free, and nothing else', async () => {
    const { worker, deps, cfg } = makeLeafWorker({ requiredFreeSlots: 2, deps: leafDeps() });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick(); // the single free slot's run starts

    vi.setSystemTime(start + cfg.thresholdMs - 1);
    expect((await worker.tick()).dispatched).toBe(false);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();

    vi.setSystemTime(start + cfg.thresholdMs);
    const at = await worker.tick();

    expect(at.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    expect((deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(
      '/skill:audit WL-LEAF',
    );
    // The relaxed single slot was NOT offered to the plan tier.
    expect(deps.getNextItem).not.toHaveBeenCalled();
  });

  it('still requires the full threshold in the relaxed band (no early admission)', async () => {
    const { worker, deps, cfg } = makeLeafWorker({ requiredFreeSlots: 2, deps: leafDeps() });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();

    vi.setSystemTime(start + cfg.thresholdMs / 2);
    const mid = await worker.tick();

    expect(mid.dispatched).toBe(false);
    expect(mid.idle).toBe(true);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('does not relax when the per-slot band is not reached (2 slots free → unchanged path)', async () => {
    const { worker, deps, cfg } = makeLeafWorker({
      requiredFreeSlots: 2,
      // 2 of 3 free = the configured minimum, so the relaxed band is never
      // entered: no peek, and the audit dispatches on the normal path.
      status: threeSlotPoolStatus(2),
      deps: leafDeps(),
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick(); // slot-2 + slot-3 free
    vi.setSystemTime(start + cfg.thresholdMs);
    const at = await worker.tick();

    // 2 continuously-free slots already satisfy the configured minimum: the
    // relaxed band is never consulted (no peek) and the audit dispatches.
    expect(at.dispatched).toBe(true);
    expect(deps.getNextAuditCandidate).toHaveBeenCalledTimes(1); // the dispatch lookup only
    expect((deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(
      '/skill:audit WL-LEAF',
    );
  });

  it('resets only the timer of a slot that starts processing (same-slot identity, AC5)', async () => {
    const { worker, deps, cfg, fetcher } = makeLeafWorker({
      requiredFreeSlots: 2,
      deps: leafDeps(),
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick(); // slot-3 free at t0

    // slot-3 starts processing and slot-2 frees up 5 s before the threshold:
    // the free COUNT stays 1, but no single slot has been free the full run.
    const swapAt = start + cfg.thresholdMs - 5_000;
    fetcher.mockResolvedValue(
      jsonResponseFixture({
        ...threeSlotPoolStatus(1),
        slots: [
          { slot_id: 'slot-1', is_processing: true },
          { slot_id: 'slot-2', is_processing: false },
          { slot_id: 'slot-3', is_processing: true },
        ],
      }),
    );
    vi.setSystemTime(swapAt);
    await worker.tick();

    vi.setSystemTime(start + cfg.thresholdMs + 4_000);
    expect((await worker.tick()).dispatched).toBe(false);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();

    // slot-2 must now complete its OWN full run before anything dispatches.
    vi.setSystemTime(swapAt + cfg.thresholdMs);
    expect((await worker.tick()).dispatched).toBe(true);
  });

  it('records a non-blocking leaf-audit-admission observation (AC4)', async () => {
    const recordDecision = vi.fn().mockResolvedValue(undefined);
    const { worker, cfg } = makeLeafWorker({
      requiredFreeSlots: 2,
      deps: leafDeps(),
      recordDecision,
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + cfg.thresholdMs);
    await worker.tick();

    const admission = recordDecision.mock.calls
      .map((call) => call[0] as CoordinationLogEntry)
      .find((entry) => entry.reason === 'leaf-audit-admission');

    expect(admission).toMatchObject({
      reason: 'leaf-audit-admission',
      freeSlots: 1, // the live free-slot count
      thresholdMetCount: 1, // the same slot, free for the full threshold
      requiredFreeSlots: 2,
      leafAuditItemId: 'WL-LEAF',
      leafAuditScope: 'leaf',
    });
    // An observation, never a refusal: the header token is untouched.
    expect(worker.blockReason).toBeNull();
  });
});

describe('worker tick — every fail-closed case restores today\'s behaviour (AC3)', () => {
  const leafCandidate = { id: 'WL-LEAF', title: 'Leaf', stage: 'audit' as const };
  const planCandidate = {
    id: 'WL-PLAN',
    title: 'Prep task',
    stage: 'intake_complete',
    status: 'open',
  };
  const baseDeps = (overrides: Partial<DowntimeWorkerDeps> = {}): Partial<DowntimeWorkerDeps> => ({
    getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: leafCandidate }),
    getAuditCandidateScope: vi.fn().mockResolvedValue({ ok: true, scope: 'leaf' }),
    getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: planCandidate }),
    ...overrides,
  });

  /** Run the 3-slot band to the threshold and return the tick result + deps. */
  async function tickThroughBand(opts: {
    status?: unknown;
    deps?: Partial<DowntimeWorkerDeps>;
    recordDecision?: (entry: CoordinationLogEntry, cwd: string) => Promise<void>;
  }) {
    const fetcher = vi
      .fn()
      .mockResolvedValue(jsonResponseFixture(opts.status ?? threeSlotPoolStatus(1)));
    const poller = createDowntimePoller('http://proxy:8000', fetcher);
    const deps = makeDeps({
      ...(opts.recordDecision ? { recordDecision: opts.recordDecision } : {}),
      ...opts.deps,
    });
    const thresholdMs = DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS;
    const worker = createDowntimeWorker({
      poller,
      deps,
      config: () => ({
        enabled: true,
        thresholdMs,
        requiredFreeSlots: 2,
        model: 'plan',
        cwd: '/repo',
        noCandidateCooldownMs: 3_600_000,
        browseItemCount: 20,
      }),
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + thresholdMs);
    const result = await worker.tick();
    return { result, deps, worker };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('no candidate: no relaxation and no plan dispatch', async () => {
    const { result, deps } = await tickThroughBand({
      deps: baseDeps({
        getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
      }),
    });

    expect(result.dispatched).toBe(false);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(deps.getNextItem).not.toHaveBeenCalled();
  });

  it.each<[string, AuditCandidateScopeResult]>([
    ['a parent candidate', { ok: true, scope: 'parent' }],
    ['an untrustworthy scope lookup', { ok: false }],
  ])('%s: no relaxation, a plan pane never takes the slot', async (_name, scopeResult) => {
    const recordDecision = vi.fn().mockResolvedValue(undefined);
    const { result, deps } = await tickThroughBand({
      deps: baseDeps({ getAuditCandidateScope: vi.fn().mockResolvedValue(scopeResult) }),
      recordDecision,
    });

    expect(result.dispatched).toBe(false);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(deps.getNextItem).not.toHaveBeenCalled();
    // The relaxed band still reports WHY the audit tier was skipped.
    const skip = recordDecision.mock.calls
      .map((call) => call[0] as CoordinationLogEntry)
      .find((entry) => entry.reason === 'audit-tier-budget-skipped');
    expect(skip).toMatchObject({
      reason: 'audit-tier-budget-skipped',
      skippedTier: 'audit',
      freeSlots: 1,
      thresholdMetCount: 1,
      requiredFreeSlots: 2,
      leafAuditItemId: 'WL-LEAF',
      leafAuditScope: 'parent',
    });
    // ...and never claims an admission it did not make.
    expect(
      recordDecision.mock.calls
        .map((call) => call[0] as CoordinationLogEntry)
        .some((entry) => entry.reason === 'leaf-audit-admission'),
    ).toBe(false);
  });

  it('an active audit (single-flight) blocks the relaxation', async () => {
    const { result, deps } = await tickThroughBand({
      deps: baseDeps({
        getActiveAudit: vi.fn().mockResolvedValue({ ok: true, active: true }),
      }),
    });

    expect(result.dispatched).toBe(false);
    expect(deps.getNextAuditCandidate).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('live contention blocks the relaxation (never relax past a refusal)', async () => {
    const { result, deps } = await tickThroughBand({
      status: { ...threeSlotPoolStatus(1), contention_queue_depth: 1 },
      deps: baseDeps(),
    });

    expect(result.dispatched).toBe(false);
    expect(deps.getNextAuditCandidate).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('a saturated prefill gate blocks the relaxation', async () => {
    const { result, deps } = await tickThroughBand({
      status: { ...threeSlotPoolStatus(1), local_max_concurrent_prefills: 1, local_prefills_in_flight: 1 },
      deps: baseDeps(),
    });

    expect(result.dispatched).toBe(false);
    expect(deps.getNextAuditCandidate).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, unknown>]>([
    ['an empty slots array', { slots: [] }],
    ['stale slot detail', { slots_stale: true }],
    ['a saturated pool', { capacity_hint: 'saturated' }],
  ])('%s fails closed before any relaxation', async (_name, overrides) => {
    const { result, deps, worker } = await tickThroughBand({
      status: { ...threeSlotPoolStatus(1), ...overrides },
      deps: baseDeps(),
    });

    expect(result.dispatched).toBe(false);
    expect(deps.getNextAuditCandidate).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(worker.blockReason).not.toBeNull();
  });

  it('a relaxed tick whose pinned candidate disappears stays neutral (no cooldown, no strike)', async () => {
    const recordDecision = vi.fn().mockResolvedValue(undefined);
    // The peek sees the leaf; the dispatch re-selection returns a different
    // (also leaf) candidate, which the pin refuses.
    const getNextAuditCandidate = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, candidate: leafCandidate })
      .mockResolvedValueOnce({ ok: true, candidate: { ...leafCandidate, id: 'WL-OTHER' } });
    const { result, deps } = await tickThroughBand({
      deps: baseDeps({ getNextAuditCandidate }),
      recordDecision,
    });

    expect(result.dispatched).toBe(false);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    const reasons = recordDecision.mock.calls.map((call) => (call[0] as CoordinationLogEntry).reason);
    expect(reasons).toContain('leaf-audit-admission');
    expect(reasons).toContain(LEAF_AUDIT_PIN_HOLD_REASON);
    expect(reasons).not.toContain('no-candidate');
  });
});
