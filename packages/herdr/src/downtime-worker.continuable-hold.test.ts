/**
 * packages/herdr/src/downtime-worker.continuable-hold.test.ts — the
 * continuable-hold rule for head scans (WL-0MWBT76WY00298AY).
 *
 * Parent: WL-0MW9X7EJ6009EL6E ("host-budget refusal early-returns from head
 * scans, starving plan/intake behind an implement candidate").
 *
 * Pinned here, per acceptance criterion:
 *
 *  AC1 — ONE allow-list predicate: `isContinuableHoldOutcome` is true for
 *        exactly the lost-claim and host-budget refusal tokens, false for
 *        every strike-worthy outcome.
 *  AC2/AC4/AC6 — `dispatchFromOwnHead` records the FIRST budget refusal on
 *        `HeadScanHolds.hostBudget` (reason + `{live, max}`) and steps to the
 *        next candidate; the audit-batch continuation records the hold and
 *        ends the batch (no hop).
 *  AC3 — `dispatchFromHerdrList` records the hold in `flags` and continues in
 *        BOTH the critical-first and the normal loop.
 *  AC5 — the leader composes the neutral terminal reason from
 *        `ownHeadHolds.hostBudget`, with the documented precedence.
 *  AC7 — every other terminal outcome still returns immediately, pinned per
 *        scan path, and the lost-claim semantics are unchanged.
 *
 * The cross-tick end-to-end starvation replay lives in the dependent item
 * WL-0MWCAMU2M007Y3PC; this file stays at the unit/dispatch-entry level.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  dispatchDowntimeWork,
  dispatchFromCoordination,
  type DowntimeHerdrItem,
  type DowntimeWorkerDeps,
} from './downtime-worker.js';
import {
  AUDIT_BUDGET_HOLD_REASONS,
  HOST_BUDGET_HOLD_REASONS,
  LOST_CLAIM_REASONS,
  isAuditBudgetHoldOutcome,
  isAuditBudgetHoldReason,
  isContinuableHoldOutcome,
  isHostBudgetHoldReason,
} from './downtime-worker.dispatch-contract.js';
import { dispatchFromHerdrList } from './downtime-worker.dispatch-filter.js';
import { dispatchFromOwnHead, type HeadScanContext, type HeadScanHolds } from './downtime-worker.head-scan.js';
import { makeDeps, makeTempDir } from './downtime-worker.fixtures.js';

// ── Fixtures ──────────────────────────────────────────────────────────

const MARKER_STALE_WINDOW_MS = 2 * 60 * 60 * 1000;
const COOLDOWN_MS = 30 * 60 * 1000;
const MAX_ATTEMPTS = 3;

/** A dispatchable `implement` head item (open, plan_complete, within caps). */
function implementItem(id: string, overrides: Partial<DowntimeHerdrItem> = {}): DowntimeHerdrItem {
  return {
    id,
    title: `Implement ${id}`,
    status: 'open',
    stage: 'plan_complete',
    priority: 'high',
    risk: 'Low',
    effort: 'S',
    sortIndex: 1,
    ...overrides,
  };
}

/** A dispatchable `plan` head item (open, intake_complete). */
function planItem(id: string, overrides: Partial<DowntimeHerdrItem> = {}): DowntimeHerdrItem {
  return {
    id,
    title: `Plan ${id}`,
    status: 'open',
    stage: 'intake_complete',
    priority: 'high',
    sortIndex: 2,
    ...overrides,
  };
}

/** A dispatchable `intake` head item (open, idea). */
function intakeItem(id: string, overrides: Partial<DowntimeHerdrItem> = {}): DowntimeHerdrItem {
  return {
    id,
    title: `Intake ${id}`,
    status: 'open',
    stage: 'idea',
    priority: 'high',
    sortIndex: 3,
    ...overrides,
  };
}

/** A dispatchable `audit` head item (completed/in_review, recent, unaudited). */
function auditItem(id: string, overrides: Partial<DowntimeHerdrItem> = {}): DowntimeHerdrItem {
  return {
    id,
    title: `Audit ${id}`,
    status: 'completed',
    stage: 'in_review',
    priority: 'high',
    updatedAt: new Date().toISOString(),
    sortIndex: 4,
    ...overrides,
  };
}

/** An in-view item that no scan will dispatch (producer-review gate). */
function filteredItem(id: string): DowntimeHerdrItem {
  return implementItem(id, { needsProducerReview: true });
}

/** Refuse only the given budgeted kind; admit everything else. */
function budgetRefusal(
  kind: 'implement' | 'audit',
  reason: string,
  live = 2,
  max = 2,
  detail?: string,
) {
  return vi.fn(async (input: { kind: string }) =>
    input.kind === kind
      ? { admitted: false as const, live, max, reason, ...(detail !== undefined ? { detail } : {}) }
      : { admitted: true as const, live: 0, max },
  );
}

// ── AC1: the shared allow-list predicate ──────────────────────────────

describe('continuable-hold predicate (WL-0MWBT76WY00298AY AC1)', () => {
  it('is true for exactly the lost-claim and host-budget refusal tokens', () => {
    for (const reason of LOST_CLAIM_REASONS) {
      expect(isContinuableHoldOutcome({ reason })).toBe(true);
    }
    for (const reason of HOST_BUDGET_HOLD_REASONS) {
      expect(isContinuableHoldOutcome({ reason })).toBe(true);
    }
    // The allow-list is the union of the two documented families.
    expect(LOST_CLAIM_REASONS.size + HOST_BUDGET_HOLD_REASONS.size).toBe(8);
    expect([...HOST_BUDGET_HOLD_REASONS]).toEqual([
      'host-budget-implement',
      'host-budget-audit',
      'host-budget-unknown',
      'audit-budget-saturated',
      'audit-budget-unknown',
      'audit-host-saturated',
    ]);
  });

  it('splits the budget holds into the AUDIT rung and the implement/host rung (WL-0MWDDHVF2004PTYX AC2)', () => {
    // The audit rung: proxy-derived audit tokens plus the legacy audit tokens.
    expect([...AUDIT_BUDGET_HOLD_REASONS]).toEqual([
      'audit-budget-saturated',
      'audit-budget-unknown',
      'host-budget-audit',
      'audit-host-saturated',
    ]);
    for (const reason of AUDIT_BUDGET_HOLD_REASONS) {
      expect(isAuditBudgetHoldReason(reason)).toBe(true);
      expect(isAuditBudgetHoldOutcome({ reason, kind: 'audit' })).toBe(true);
      // The audit tier is refused regardless of the outcome's recorded kind.
      expect(isAuditBudgetHoldOutcome({ reason, kind: 'implement' })).toBe(true);
    }
    // The implement rung: `host-budget-implement` is never an audit hold,
    // and the tier-ambiguous `host-budget-unknown` is decided by kind.
    expect(isAuditBudgetHoldReason('host-budget-implement')).toBe(false);
    expect(isAuditBudgetHoldOutcome({ reason: 'host-budget-implement', kind: 'implement' })).toBe(false);
    expect(isAuditBudgetHoldOutcome({ reason: 'host-budget-unknown', kind: 'audit' })).toBe(true);
    expect(isAuditBudgetHoldOutcome({ reason: 'host-budget-unknown', kind: 'implement' })).toBe(false);
    expect(isAuditBudgetHoldOutcome({ reason: 'host-budget-unknown' })).toBe(false);
    // No other outcome family is an audit-budget hold.
    expect(isAuditBudgetHoldReason('no-candidate')).toBe(false);
    expect(isAuditBudgetHoldOutcome({ reason: 'wl-error', kind: 'audit' })).toBe(false);
  });

  it('is false for every strike-worthy or unknown outcome (allow-list, not deny-list)', () => {
    const terminal = [
      'wl-error',
      'spawn-failed',
      'marker-write-failed',
      'anchor-unavailable',
      'no-candidate',
      'code-freeze',
      'audit-in-flight',
      'invented-future-refusal',
      undefined,
    ];
    for (const reason of terminal) {
      expect(isContinuableHoldOutcome({ reason })).toBe(false);
      expect(isHostBudgetHoldReason(reason)).toBe(false);
      expect(isAuditBudgetHoldReason(reason)).toBe(false);
    }
  });
});

// ── AC2/AC4/AC6/AC7: dispatchFromOwnHead (fallback + sweep + batch) ───

function ownHeadCtx(
  window: { head: DowntimeHerdrItem[]; tail: DowntimeHerdrItem[] },
  overrides: Partial<HeadScanContext> = {},
): HeadScanContext {
  const holds: HeadScanHolds = {
    budget: false,
    cooldown: false,
    inFlight: false,
    review: false,
    cpu: false,
  };
  return {
    root: '/repo',
    window,
    frozen: false,
    kinds: null,
    excludeIds: new Set<string>(),
    selectionPath: 'test-scan',
    selectionReason: 'test',
    skipOnLostClaim: true,
    includeHead: true,
    cpuSaturated: false,
    auditSlotBudget: undefined,
    panesEligible: true,
    pinnedAuditItemId: undefined,
    markerStaleWindowMs: MARKER_STALE_WINDOW_MS,
    maxAttempts: MAX_ATTEMPTS,
    cooldownMs: COOLDOWN_MS,
    cooldownEntriesForRoot: async () => [],
    inFlightForRoot: async () => ({ available: true, itemIds: new Set<string>() }),
    reviewGateForRoot: async () => null,
    holds,
    flaggedForBudget: new Set<string>(),
    ...overrides,
  };
}

describe('dispatchFromOwnHead — continuable host-budget hold (AC2/AC4/AC6)', () => {
  it('AC2/AC4: records the first refusal on holds.hostBudget and dispatches the plan behind it', async () => {
    const admitHostDispatch = budgetRefusal('implement', 'host-budget-implement', 2, 2);
    const deps = makeDeps({ admitHostDispatch });
    const ctx = ownHeadCtx({ head: [], tail: [implementItem('WL-IMP'), planItem('WL-PLAN')] });

    const outcome = await dispatchFromOwnHead(deps, { model: 'plan', cwd: '/repo' }, ctx, Date.now());

    expect(outcome?.dispatched).toBe(true);
    expect(outcome?.kind).toBe('plan');
    expect(outcome?.candidate?.id).toBe('WL-PLAN');
    // The refusal is recorded as its own dedicated hold — never conflated with
    // the attempt budget or the CPU gate — with its {live, max} evidence.
    expect(ctx.holds.hostBudget).toEqual({
      reason: 'host-budget-implement',
      budget: { live: 2, max: 2 },
    });
    expect(ctx.holds.budget).toBe(false);
    expect(ctx.holds.cpu).toBe(false);
    // The prep candidate is not budget-gated: it was never refused.
    expect(admitHostDispatch).toHaveBeenCalledTimes(1);
  });

  it('AC2: an audit refusal steps on to a trailing intake candidate', async () => {
    const admitHostDispatch = budgetRefusal('audit', 'audit-budget-saturated', 1, 1, 'http-404');
    const deps = makeDeps({ admitHostDispatch });
    const ctx = ownHeadCtx({ head: [], tail: [auditItem('WL-AUD'), intakeItem('WL-INT')] });

    const outcome = await dispatchFromOwnHead(deps, { model: 'plan', cwd: '/repo' }, ctx, Date.now());

    expect(outcome?.dispatched).toBe(true);
    expect(outcome?.kind).toBe('intake');
    // An AUDIT refusal is recorded on its OWN rung (with the failing exchange
    // on `detail`) — never conflated with the implement/host hold.
    expect(ctx.holds.auditBudget).toEqual({
      reason: 'audit-budget-saturated',
      budget: { live: 1, max: 1 },
      detail: 'http-404',
    });
    expect(ctx.holds.hostBudget).toBeUndefined();
  });

  it('AC4: keeps the neutral refusal when nothing else dispatches', async () => {
    const admitHostDispatch = budgetRefusal('implement', 'host-budget-implement', 2, 2);
    const deps = makeDeps({ admitHostDispatch });
    const ctx = ownHeadCtx({ head: [], tail: [implementItem('WL-IMP')] });

    const outcome = await dispatchFromOwnHead(deps, { model: 'plan', cwd: '/repo' }, ctx, Date.now());

    // No dispatch: the caller (leader) composes the terminal reason from the
    // recorded hold, so the tick never reports 'no-candidate'.
    expect(outcome).toBeNull();
    expect(ctx.holds.hostBudget).toEqual({
      reason: 'host-budget-implement',
      budget: { live: 2, max: 2 },
    });
  });

  it('AC6: the batch continuation records the hold and ends the batch (no hop)', async () => {
    const admitHostDispatch = budgetRefusal('audit', 'host-budget-audit', 1, 1);
    const deps = makeDeps({ admitHostDispatch });
    const ctx = ownHeadCtx(
      { head: [], tail: [auditItem('WL-AUD-1'), auditItem('WL-AUD-2')] },
      { kinds: ['audit'], skipOnLostClaim: false },
    );

    const outcome = await dispatchFromOwnHead(deps, { model: 'plan', cwd: '/repo' }, ctx, Date.now());

    // The refusal is returned to the caller (neutral terminal reason) …
    expect(outcome).toMatchObject({
      dispatched: false,
      reason: 'host-budget-audit',
      budget: { live: 1, max: 1 },
    });
    // … the AUDIT hold is still recorded (on its own rung) …
    expect(ctx.holds.auditBudget?.reason).toBe('host-budget-audit');
    expect(ctx.holds.hostBudget).toBeUndefined();
    // … and the batch never hops to the second audit target.
    expect(admitHostDispatch).toHaveBeenCalledTimes(1);
  });

  it('AC7: a lost claim continues to the next candidate when skipOnLostClaim is set', async () => {
    const claimItem = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'stale' })
      .mockResolvedValue({ ok: true });
    const deps = makeDeps({ claimItem });
    const ctx = ownHeadCtx({ head: [], tail: [planItem('WL-LOST'), planItem('WL-NEXT')] });

    const outcome = await dispatchFromOwnHead(deps, { model: 'plan', cwd: '/repo' }, ctx, Date.now());

    // skipOnLostClaim: true — step to the next candidate (unchanged).
    expect(outcome?.candidate?.id).toBe('WL-NEXT');
  });

  it('AC7: the batch continuation ends on a lost claim (skipOnLostClaim false)', async () => {
    const claimItem = vi.fn().mockResolvedValue({ ok: false, reason: 'stale' });
    const deps = makeDeps({ claimItem });
    const ctx = ownHeadCtx(
      { head: [], tail: [planItem('WL-LOST'), planItem('WL-NEXT')] },
      { skipOnLostClaim: false },
    );

    const continuation = await dispatchFromOwnHead(
      deps,
      { model: 'plan', cwd: '/repo' },
      ctx,
      Date.now(),
    );

    expect(continuation).toMatchObject({ dispatched: false, reason: 'claim-failed' });
    expect(claimItem).toHaveBeenCalledTimes(1);
    expect(ctx.holds.hostBudget).toBeUndefined();
  });

  // AC7 — every strike-worthy outcome still returns immediately on this path.
  it('AC7: wl-error returns immediately (the next candidate is never attempted)', async () => {
    const claimItem = vi.fn().mockResolvedValue({ ok: false, error: 'wl exploded' });
    const deps = makeDeps({ claimItem });
    const ctx = ownHeadCtx({ head: [], tail: [planItem('WL-FAIL'), planItem('WL-NEXT')] });

    const outcome = await dispatchFromOwnHead(deps, { model: 'plan', cwd: '/repo' }, ctx, Date.now());

    expect(outcome).toMatchObject({ dispatched: false, reason: 'wl-error' });
    expect(claimItem).toHaveBeenCalledTimes(1);
    expect(ctx.holds.hostBudget).toBeUndefined();
  });

  it('AC7: spawn-failed returns immediately', async () => {
    const spawnAgentPane = vi.fn().mockResolvedValue({ ok: false, error: 'no pane' });
    const deps = makeDeps({ spawnAgentPane });
    const ctx = ownHeadCtx({ head: [], tail: [planItem('WL-FAIL'), planItem('WL-NEXT')] });

    const outcome = await dispatchFromOwnHead(deps, { model: 'plan', cwd: '/repo' }, ctx, Date.now());

    expect(outcome).toMatchObject({ dispatched: false, reason: 'spawn-failed' });
    expect(deps.claimItem).toHaveBeenCalledTimes(1);
    expect(ctx.holds.hostBudget).toBeUndefined();
  });

  it('AC7: marker-write-failed returns immediately', async () => {
    const recordDispatch = vi.fn().mockResolvedValue(false);
    const rollbackClaim = vi.fn().mockResolvedValue(false);
    const deps = makeDeps({ recordDispatch, rollbackClaim });
    const ctx = ownHeadCtx({ head: [], tail: [planItem('WL-FAIL'), planItem('WL-NEXT')] });

    const outcome = await dispatchFromOwnHead(deps, { model: 'plan', cwd: '/repo' }, ctx, Date.now());

    expect(outcome).toMatchObject({ dispatched: false, reason: 'marker-write-failed' });
    expect(deps.claimItem).toHaveBeenCalledTimes(1);
    expect(ctx.holds.hostBudget).toBeUndefined();
  });

  it('AC7: anchor-unavailable returns immediately', async () => {
    const deps = makeDeps({
      resolveProjectWorkspace: vi
        .fn()
        .mockResolvedValue({ paneId: 'wC:pB', workspaceId: 'wC', tabId: 'wC:tPlugin' }),
      getItemTabAnchor: vi.fn().mockResolvedValue(null),
    });
    const ctx = ownHeadCtx({ head: [], tail: [planItem('WL-FAIL'), planItem('WL-NEXT')] });

    const outcome = await dispatchFromOwnHead(deps, { model: 'plan', cwd: '/repo' }, ctx, Date.now());

    expect(outcome).toMatchObject({ dispatched: false, reason: 'anchor-unavailable' });
    expect(deps.claimItem).toHaveBeenCalledTimes(1);
    expect(ctx.holds.hostBudget).toBeUndefined();
  });
});

// ── AC3/AC7: dispatchFromHerdrList (both loops) ───────────────────────

type ListCtx = Parameters<typeof dispatchFromHerdrList>[2];
type ListFlags = Parameters<typeof dispatchFromHerdrList>[3];

function listCtx(overrides: Partial<ListCtx> = {}): ListCtx {
  return {
    cwd: '/repo',
    model: 'plan',
    frozen: false,
    cpuSaturated: false,
    panesEligible: true,
    auditSlotBudget: undefined,
    reviewGate: null,
    markerStaleWindowMs: MARKER_STALE_WINDOW_MS,
    nonTerminalCooldownMs: COOLDOWN_MS,
    maxAttempts: MAX_ATTEMPTS,
    inFlight: { available: true, itemIds: new Set<string>() },
    ...overrides,
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

describe('dispatchFromHerdrList — continuable host-budget hold (AC3/AC7)', () => {
  it('AC3 (normal scan): records the hold and dispatches the plan behind a refused implement', async () => {
    const admitHostDispatch = budgetRefusal('implement', 'host-budget-implement', 2, 2);
    const deps = makeDeps({ admitHostDispatch });
    const flags = listFlags();

    const outcome = await dispatchFromHerdrList(
      deps,
      [implementItem('WL-IMP'), planItem('WL-PLAN')],
      listCtx(),
      flags,
    );

    expect(outcome?.dispatched).toBe(true);
    expect(outcome?.kind).toBe('plan');
    expect(outcome?.candidate?.id).toBe('WL-PLAN');
    expect(flags.hostBudgetReason).toBe('host-budget-implement');
    expect(flags.hostBudget).toEqual({ live: 2, max: 2 });
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });

  it('AC3 (normal scan): an audit refusal steps on to the trailing intake', async () => {
    const admitHostDispatch = budgetRefusal('audit', 'audit-budget-unknown', 0, 0);
    const deps = makeDeps({ admitHostDispatch });
    const flags = listFlags();

    const outcome = await dispatchFromHerdrList(
      deps,
      [auditItem('WL-AUD'), intakeItem('WL-INT')],
      listCtx(),
      flags,
    );

    expect(outcome?.dispatched).toBe(true);
    expect(outcome?.kind).toBe('intake');
    expect(flags.hostBudgetReason).toBe('audit-budget-unknown');
    expect(flags.hostBudget).toEqual({ live: 0, max: 0 });
  });

  it('AC3 (critical-first scan): a refused critical implement still lets the critical plan dispatch', async () => {
    const admitHostDispatch = budgetRefusal('implement', 'host-budget-implement', 2, 2);
    const deps = makeDeps({ admitHostDispatch });
    const flags = listFlags();

    const outcome = await dispatchFromHerdrList(
      deps,
      [
        implementItem('WL-CRIT-IMP', { priority: 'critical', sortIndex: 1 }),
        planItem('WL-CRIT-PLAN', { priority: 'critical', sortIndex: 2 }),
      ],
      listCtx(),
      flags,
    );

    expect(outcome?.dispatched).toBe(true);
    expect(outcome?.candidate?.id).toBe('WL-CRIT-PLAN');
    expect(deps.recordDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'WL-CRIT-PLAN', selectionPath: 'critical-first' }),
    );
    expect(flags.hostBudgetReason).toBe('host-budget-implement');
  });

  it('AC3/AC4: records the neutral refusal when nothing else dispatches', async () => {
    const admitHostDispatch = budgetRefusal('implement', 'host-budget-implement', 2, 2);
    const deps = makeDeps({ admitHostDispatch });
    const flags = listFlags();

    const outcome = await dispatchFromHerdrList(deps, [implementItem('WL-IMP')], listCtx(), flags);

    expect(outcome).toBeNull();
    expect(flags.hostBudgetReason).toBe('host-budget-implement');
    expect(flags.hostBudget).toEqual({ live: 2, max: 2 });
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('AC7: wl-error returns immediately (no second candidate)', async () => {
    const claimItem = vi.fn().mockResolvedValue({ ok: false, error: 'wl exploded' });
    const deps = makeDeps({ claimItem });
    const flags = listFlags();

    const outcome = await dispatchFromHerdrList(
      deps,
      [planItem('WL-FAIL'), planItem('WL-NEXT')],
      listCtx(),
      flags,
    );

    expect(outcome).toMatchObject({ dispatched: false, reason: 'wl-error' });
    expect(claimItem).toHaveBeenCalledTimes(1);
    expect(flags.hostBudgetReason).toBeUndefined();
  });

  it('AC7: spawn-failed returns immediately', async () => {
    const spawnAgentPane = vi.fn().mockResolvedValue({ ok: false, error: 'no pane' });
    const deps = makeDeps({ spawnAgentPane });
    const flags = listFlags();

    const outcome = await dispatchFromHerdrList(
      deps,
      [planItem('WL-FAIL'), planItem('WL-NEXT')],
      listCtx(),
      flags,
    );

    expect(outcome).toMatchObject({ dispatched: false, reason: 'spawn-failed' });
    expect(deps.claimItem).toHaveBeenCalledTimes(1);
    expect(flags.hostBudgetReason).toBeUndefined();
  });

  it('AC7: marker-write-failed returns immediately', async () => {
    const recordDispatch = vi.fn().mockResolvedValue(false);
    const rollbackClaim = vi.fn().mockResolvedValue(false);
    const deps = makeDeps({ recordDispatch, rollbackClaim });
    const flags = listFlags();

    const outcome = await dispatchFromHerdrList(
      deps,
      [planItem('WL-FAIL'), planItem('WL-NEXT')],
      listCtx(),
      flags,
    );

    expect(outcome).toMatchObject({ dispatched: false, reason: 'marker-write-failed' });
    expect(deps.claimItem).toHaveBeenCalledTimes(1);
    expect(flags.hostBudgetReason).toBeUndefined();
  });

  it('AC7: anchor-unavailable returns immediately', async () => {
    const deps = makeDeps({
      resolveProjectWorkspace: vi
        .fn()
        .mockResolvedValue({ paneId: 'wC:pB', workspaceId: 'wC', tabId: 'wC:tPlugin' }),
      getItemTabAnchor: vi.fn().mockResolvedValue(null),
    });
    const flags = listFlags();

    const outcome = await dispatchFromHerdrList(
      deps,
      [planItem('WL-FAIL'), planItem('WL-NEXT')],
      listCtx(),
      flags,
    );

    expect(outcome).toMatchObject({ dispatched: false, reason: 'anchor-unavailable' });
    expect(deps.claimItem).toHaveBeenCalledTimes(1);
    expect(flags.hostBudgetReason).toBeUndefined();
  });

  it('AC7 (critical-first scan): spawn-failed still ends the scan immediately', async () => {
    const spawnAgentPane = vi.fn().mockResolvedValue({ ok: false, error: 'no pane' });
    const deps = makeDeps({ spawnAgentPane });
    const flags = listFlags();

    const outcome = await dispatchFromHerdrList(
      deps,
      [
        implementItem('WL-CRIT-FAIL', { priority: 'critical', sortIndex: 1 }),
        planItem('WL-CRIT-NEXT', { priority: 'critical', sortIndex: 2 }),
      ],
      listCtx(),
      flags,
    );

    expect(outcome).toMatchObject({ dispatched: false, reason: 'spawn-failed' });
    expect(deps.claimItem).toHaveBeenCalledTimes(1);
    expect(flags.hostBudgetReason).toBeUndefined();
  });

  it('AC7: claim-failed/claim-rolled-back still continue to the next candidate', async () => {
    const claimItem = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'stale' })
      .mockResolvedValueOnce({ ok: true });
    const deps = makeDeps({ claimItem });
    const flags = listFlags();

    const outcome = await dispatchFromHerdrList(
      deps,
      [planItem('WL-LOST'), planItem('WL-NEXT')],
      listCtx(),
      flags,
    );

    expect(outcome?.candidate?.id).toBe('WL-NEXT');
    expect(flags.hostBudgetReason).toBeUndefined();
  });
});

// ── AC5: leader terminal-reason composition ───────────────────────────

const SPRINT = 2;

/** Own-root canonical ranking: the in-view head, plus `tail` beyond it. */
function rankedOwnHead(head: DowntimeHerdrItem[], tail: DowntimeHerdrItem[]) {
  return vi.fn(async (_cwd: string, limit = SPRINT) => ({
    ok: true as const,
    items: limit <= SPRINT ? head : [...head, ...tail],
  }));
}

function leaderDeps(overrides: Partial<DowntimeWorkerDeps> = {}): DowntimeWorkerDeps {
  return makeDeps({
    // Zero offers in these cases; the leader still requires the seam.
    fetchItem: vi.fn().mockResolvedValue({ ok: true, info: { id: 'WL-X', status: 'open', stage: 'idea' } }),
    ...overrides,
  });
}

function dispatchLeader(deps: DowntimeWorkerDeps, coordinationDir: string, extra = {}) {
  return dispatchFromCoordination(deps, [], {
    model: 'plan',
    cwd: '/leader-root',
    coordinationDir,
    browseItemCount: SPRINT,
    ...extra,
  });
}

describe('leader terminal reason — host-budget hold (AC5)', () => {
  it('reports the neutral refusal with {live, max} instead of no-candidate', async () => {
    const admitHostDispatch = budgetRefusal('implement', 'host-budget-implement', 2, 2);
    const deps = leaderDeps({
      getHerdrListHead: rankedOwnHead([filteredItem('WL-VIEW-1'), filteredItem('WL-VIEW-2')], [
        implementItem('WL-IMP'),
      ]),
      admitHostDispatch,
    });
    const coordinationDir = makeTempDir('herdr-hold-leader-');

    const outcome = await dispatchLeader(deps, coordinationDir);

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('host-budget-implement');
    expect(outcome.budget).toEqual({ live: 2, max: 2 });
    // Neutral: never the empty-backlog token (no cooldown) and no spawn.
    expect(outcome.reason).not.toBe('no-candidate');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('a leaf-audit pin keeps precedence over the host-budget hold (documented chain)', async () => {
    const admitHostDispatch = budgetRefusal('audit', 'host-budget-audit', 1, 1);
    const deps = leaderDeps({
      getHerdrListHead: rankedOwnHead([filteredItem('WL-VIEW-1'), filteredItem('WL-VIEW-2')], [
        auditItem('WL-AUD-PIN'),
      ]),
      admitHostDispatch,
    });
    const coordinationDir = makeTempDir('herdr-hold-precedence-');

    const outcome = await dispatchLeader(deps, coordinationDir, {
      pinnedAuditItemId: 'WL-AUD-PIN',
      // Batch off so the continuation does not end the tick on the refusal
      // before the leader composes its terminal reason.
      auditBatchMax: 1,
    });

    // Precedence: leaf-audit pin → audit budget → host budget (budget LAST).
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('leaf-audit-pin-hold');
    expect(admitHostDispatch).toHaveBeenCalledTimes(1);
  });

  it('AC2: an audit refusal OUTRANKS an implement refusal in the same tick (never masked)', async () => {
    // One tick whose own-head window offers BOTH a refused audit and a
    // refused implement: the audit-budget rung must win the terminal reason.
    const admitHostDispatch = vi.fn(async (input: { kind: string }) =>
      input.kind === 'audit'
        ? {
            admitted: false as const,
            live: 1,
            max: 1,
            reason: 'audit-budget-unknown',
            detail: 'http-404',
          }
        : { admitted: false as const, live: 2, max: 2, reason: 'host-budget-implement' },
    );
    const deps = leaderDeps({
      getHerdrListHead: rankedOwnHead([filteredItem('WL-VIEW-1'), filteredItem('WL-VIEW-2')], [
        auditItem('WL-AUD'),
        implementItem('WL-IMP'),
      ]),
      admitHostDispatch,
    });
    const coordinationDir = makeTempDir('herdr-hold-precedence-');

    const outcome = await dispatchLeader(deps, coordinationDir, { auditBatchMax: 1 });

    // The audit rung (broken proxy contract, `detail: 'http-404'`) beats the
    // ambient implement-cap statement — never `host-budget-implement`.
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('audit-budget-unknown');
    expect(outcome.budget).toEqual({ live: 1, max: 1 });
    expect(outcome.detail).toBe('http-404');
    expect(admitHostDispatch).toHaveBeenCalledTimes(2);
  });
});

// ── AC2: the registered-root sweep crosses a budget-refused root ──────

describe('registered-root sweep — budget refusal crosses to the next root (AC2)', () => {
  it('dispatches a plan from the second root when the first root only refuses', async () => {
    const firstRoot = makeTempDir('herdr-hold-root-a-');
    const secondRoot = makeTempDir('herdr-hold-root-b-');
    const admitHostDispatch = budgetRefusal('implement', 'host-budget-implement', 2, 2);
    const getHerdrListHead = vi.fn(async (cwd: string) => ({
      ok: true as const,
      items:
        cwd === firstRoot
          ? [implementItem('WL-REFUSED')]
          : cwd === secondRoot
            ? [planItem('WL-PLAN-B')]
            : [],
    }));
    const deps = leaderDeps({ getHerdrListHead, admitHostDispatch });
    const coordinationDir = makeTempDir('herdr-hold-sweep-');

    const outcome = await dispatchLeader(deps, coordinationDir, {
      registeredRoots: [firstRoot, secondRoot],
    });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
    expect(outcome.candidate?.id).toBe('WL-PLAN-B');
    expect(deps.claimItem).toHaveBeenCalledWith('WL-PLAN-B', expect.anything(), secondRoot);
  });
});

// ── AC3: the direct dispatch entry keeps the neutral terminal reason ──

describe('dispatchDowntimeWork — continued refusal keeps the neutral reason (AC3)', () => {
  it('reports host-budget-implement with evidence, never no-candidate', async () => {
    const admitHostDispatch = budgetRefusal('implement', 'host-budget-implement', 2, 2);
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [implementItem('WL-IMP')] }),
      admitHostDispatch,
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('host-budget-implement');
    expect(outcome.budget).toEqual({ live: 2, max: 2 });
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('AC3: an audit-budget-unknown refusal carries the failing exchange as detail (direct path)', async () => {
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [auditItem('WL-AUD')] }),
      // The Herdr-head scan consults the active-audit pre-check first.
      getActiveAudit: vi.fn().mockResolvedValue({
        ok: true,
        active: true,
        source: 'proxy',
        reason: 'audit-budget-unknown',
        detail: 'timeout',
      }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    // The direct path already reports the audit reason (never drops the
    // refusal, AC6); the failing exchange now reaches the outcome too (AC3).
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('audit-budget-unknown');
    expect(outcome.detail).toBe('timeout');
    expect(outcome.budget).toBeUndefined(); // fail-closed read: no 0/0 fabrication
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });
});
