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

import { describe, expect, it, vi } from 'vitest';

import {
  ago,
  perSlotOneOfThreeFree,
  perSlotTwoOfThreeFree,
  makeDeps,
  threeSlotPoolStatus,
} from './downtime-worker.fixtures.js';
import {
  auditItemEligible,
  classifyAuditScope,
  isLeafAuditSlotBand,
  type AuditCandidateScopeResult,
} from './downtime-worker.gates.js';
import {
  dispatchDowntimeWork,
  type DowntimeCandidate,
  type DowntimeHerdrItem,
} from './downtime-worker.js';
import {
  DOWNTIME_AUDIT_MIN_FREE_SLOTS,
  DOWNTIME_LEAF_AUDIT_MIN_FREE_SLOTS,
} from './downtime-worker.constants.js';

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
