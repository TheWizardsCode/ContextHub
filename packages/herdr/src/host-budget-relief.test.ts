/**
 * packages/herdr/src/host-budget-relief.test.ts — the model-blocked predicate
 * and the effective-cap arithmetic (parent WL-0MWTAD9NV000IVK5, child
 * WL-0MWTASN6H0005KED).
 *
 * Pure unit suite: no file I/O, no `Date.now()`, an injected clock and
 * in-memory cooldown/pane fixtures. It pins the contract in
 * `host-budget-relief.ts` — detection, per-kind independence, the fixed-2x
 * ceiling, fail-closed on an unreadable signal, and relief ending when the last
 * cooldown expires.
 */

import { describe, expect, it } from 'vitest';

import type { ModelCooldownEntry } from '@worklog/shared/model-cooldown';

import {
  HOST_BUDGET_RELIEF_MULTIPLIER,
  HOST_BUDGET_RELIEF_REASON,
  HOST_BUDGET_RELIEF_UNREADABLE_REASON,
  resolveEffectiveHostBudgetCap,
  resolveModelBlockedPanes,
  type ReliefPane,
} from './host-budget-relief.js';

const NOW = Date.parse('2026-11-23T13:00:00.000Z');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** A cooldown entry with sensible defaults; override any field. */
function cooldown(overrides: Partial<ModelCooldownEntry> = {}): ModelCooldownEntry {
  return {
    paneId: 'w7D:p1',
    sessionId: 'session-1',
    itemId: 'WL-ITEM',
    kind: 'implement',
    reason: 'provider exhaustion',
    createdAt: NOW - MINUTE,
    cooldownUntil: NOW + HOUR,
    ...overrides,
  };
}

/** A live pane fixture. */
function pane(overrides: Partial<ReliefPane> = {}): ReliefPane {
  return {
    paneId: 'w7D:p1',
    title: 'Downtime triggered implement Do the thing - WL-ITEM',
    ...overrides,
  };
}

describe('resolveModelBlockedPanes — detection (AC1)', () => {
  it('marks an active entry for an implement pane as blocked', () => {
    const blocked = resolveModelBlockedPanes({
      cooldowns: [cooldown()],
      panes: [pane()],
      now: NOW,
    });
    expect(blocked.implement).toHaveLength(1);
    expect(blocked.implement[0]).toMatchObject({
      paneId: 'w7D:p1',
      kind: 'implement',
      cooldownUntil: NOW + HOUR,
    });
    expect(blocked.audit).toHaveLength(0);
    expect(blocked.unreadable).toBe(false);
  });

  it('marks an active entry for an audit pane as blocked', () => {
    const blocked = resolveModelBlockedPanes({
      cooldowns: [cooldown({ paneId: 'w7D:a1', kind: 'audit' })],
      panes: [pane({ paneId: 'w7D:a1', title: 'Downtime triggered audit Check - WL-ITEM' })],
      now: NOW,
    });
    expect(blocked.audit).toHaveLength(1);
    expect(blocked.implement).toHaveLength(0);
  });

  it('does not block an expired entry', () => {
    const blocked = resolveModelBlockedPanes({
      cooldowns: [cooldown({ cooldownUntil: NOW - 1 })],
      panes: [pane()],
      now: NOW,
    });
    expect(blocked.implement).toHaveLength(0);
  });

  it('does not block when the signal is absent ([])', () => {
    const blocked = resolveModelBlockedPanes({ cooldowns: [], panes: [pane()], now: NOW });
    expect(blocked).toEqual({ implement: [], audit: [], unreadable: false });
  });

  it('fails closed on an unreadable/corrupt signal (null)', () => {
    const blocked = resolveModelBlockedPanes({ cooldowns: null, panes: [pane()], now: NOW });
    expect(blocked.implement).toHaveLength(0);
    expect(blocked.audit).toHaveLength(0);
    expect(blocked.unreadable).toBe(true);
    expect(blocked.reason).toBe(HOST_BUDGET_RELIEF_UNREADABLE_REASON);
  });

  it('does not block an unknown/absent kind', () => {
    // Entry kind null and a label that names no capped kind.
    const blocked = resolveModelBlockedPanes({
      cooldowns: [cooldown({ kind: null, paneId: 'w7D:p1' })],
      panes: [pane({ title: 'Something else entirely' })],
      now: NOW,
    });
    expect(blocked.implement).toHaveLength(0);
    expect(blocked.audit).toHaveLength(0);
  });

  it('does not block a known non-capped kind (plan/intake/risk-effort)', () => {
    const blocked = resolveModelBlockedPanes({
      cooldowns: [cooldown({ kind: 'plan' })],
      panes: [pane({ title: 'Downtime triggered plan Plan it - WL-ITEM' })],
      now: NOW,
    });
    expect(blocked.implement).toHaveLength(0);
    expect(blocked.audit).toHaveLength(0);
  });

  it('resolves the kind from the pane label when the entry kind is null', () => {
    const blocked = resolveModelBlockedPanes({
      cooldowns: [cooldown({ kind: null })],
      panes: [pane({ title: 'Manually triggered audit Review - WL-ITEM' })],
      now: NOW,
    });
    expect(blocked.audit).toHaveLength(1);
    expect(blocked.implement).toHaveLength(0);
  });

  it('matches by paneId first, then by sessionId when the entry has no paneId', () => {
    const byPane = resolveModelBlockedPanes({
      cooldowns: [cooldown({ paneId: 'w7D:p1', sessionId: 'other' })],
      panes: [pane({ paneId: 'w7D:p1', sessionId: 'session-9' })],
      now: NOW,
    });
    expect(byPane.implement).toHaveLength(1);

    const bySession = resolveModelBlockedPanes({
      cooldowns: [cooldown({ paneId: null, sessionId: 'session-9' })],
      panes: [pane({ paneId: 'w7D:p1', sessionId: 'session-9' })],
      now: NOW,
    });
    expect(bySession.implement).toHaveLength(1);
  });

  it('a session-only entry does not match a pane with an unknown session id', () => {
    const blocked = resolveModelBlockedPanes({
      cooldowns: [cooldown({ paneId: null, sessionId: 'session-9' })],
      panes: [pane({ paneId: 'w7D:p1', sessionId: undefined })],
      now: NOW,
    });
    expect(blocked.implement).toHaveLength(0);
  });
});

describe('resolveEffectiveHostBudgetCap — per-kind fixed 2x (AC2)', () => {
  const blockedImplement = [
    { paneId: 'w7D:p1', kind: 'implement' as const, cooldownUntil: NOW + HOUR },
  ];
  const blockedAudit = [
    { paneId: 'w7D:a1', kind: 'audit' as const, cooldownUntil: NOW + 2 * HOUR },
  ];

  it('doubles the cap of the blocked kind', () => {
    const cap = resolveEffectiveHostBudgetCap({
      kind: 'implement',
      baseCap: 3,
      blockedPanes: blockedImplement,
    });
    expect(cap.baseCap).toBe(3);
    expect(cap.effectiveCap).toBe(6);
    expect(cap.relief).toMatchObject({
      kind: 'implement',
      baseCap: 3,
      effectiveCap: 6,
      blockedPaneIds: ['w7D:p1'],
      reason: HOST_BUDGET_RELIEF_REASON,
      until: NOW + HOUR,
    });
  });

  it('is per kind: a blocked implement does not raise audit', () => {
    const cap = resolveEffectiveHostBudgetCap({
      kind: 'audit',
      baseCap: 2,
      blockedPanes: blockedImplement,
    });
    expect(cap.effectiveCap).toBe(2);
    expect(cap.relief).toBeNull();
  });

  it('is per kind: a blocked audit does not raise implement', () => {
    const cap = resolveEffectiveHostBudgetCap({
      kind: 'implement',
      baseCap: 2,
      blockedPanes: blockedAudit,
    });
    expect(cap.effectiveCap).toBe(2);
    expect(cap.relief).toBeNull();
  });

  it('returns the configured cap when no blocked pane exists', () => {
    const cap = resolveEffectiveHostBudgetCap({ kind: 'implement', baseCap: 4, blockedPanes: [] });
    expect(cap.effectiveCap).toBe(4);
    expect(cap.relief).toBeNull();
  });

  it('never revives a disabled tier (baseCap 0)', () => {
    const cap = resolveEffectiveHostBudgetCap({
      kind: 'implement',
      baseCap: 0,
      blockedPanes: blockedImplement,
    });
    expect(cap.effectiveCap).toBe(0);
    expect(cap.relief).toBeNull();
  });

  it('honours the kill switch', () => {
    const cap = resolveEffectiveHostBudgetCap({
      kind: 'implement',
      baseCap: 3,
      blockedPanes: blockedImplement,
      reliefEnabled: false,
    });
    expect(cap.effectiveCap).toBe(3);
    expect(cap.relief).toBeNull();
  });

  it('fails closed on an unreadable signal and names it', () => {
    const cap = resolveEffectiveHostBudgetCap({
      kind: 'implement',
      baseCap: 3,
      blockedPanes: blockedImplement,
      unreadableReason: HOST_BUDGET_RELIEF_UNREADABLE_REASON,
    });
    expect(cap.effectiveCap).toBe(3);
    expect(cap.relief).toMatchObject({
      reason: HOST_BUDGET_RELIEF_UNREADABLE_REASON,
      effectiveCap: 3,
      blockedPaneIds: [],
    });
  });

  it('pins the multiplier at 2 and ignores settings/env-shaped overrides', () => {
    // The multiplier is a module constant; a settings-shaped object and an env
    // var are supplied and the effective cap is unchanged.
    process.env.HERDR_BUDGET_RELIEF_MULTIPLIER = '5';
    try {
      const settings = { downtimeBudgetReliefMultiplier: 9 } as unknown as Record<string, unknown>;
      expect(settings.downtimeBudgetReliefMultiplier).toBe(9);
      expect(HOST_BUDGET_RELIEF_MULTIPLIER).toBe(2);
      const cap = resolveEffectiveHostBudgetCap({
        kind: 'audit',
        baseCap: 5,
        blockedPanes: blockedAudit,
      });
      expect(cap.effectiveCap).toBe(10);
    } finally {
      delete process.env.HERDR_BUDGET_RELIEF_MULTIPLIER;
    }
  });
});

describe('clock advance (AC4)', () => {
  it('ends relief when cooldownUntil passes and reverts without a restart', () => {
    const cooldowns = [cooldown({ cooldownUntil: NOW + 5 * MINUTE })];
    const before = resolveModelBlockedPanes({ cooldowns, panes: [pane()], now: NOW });
    const capBefore = resolveEffectiveHostBudgetCap({
      kind: 'implement',
      baseCap: 2,
      blockedPanes: before.implement,
    });
    expect(capBefore.effectiveCap).toBe(4);

    // Same in-memory state, advanced clock: the entry is now expired.
    const after = resolveModelBlockedPanes({
      cooldowns,
      panes: [pane()],
      now: NOW + 5 * MINUTE + 1,
    });
    expect(after.implement).toHaveLength(0);
    const capAfter = resolveEffectiveHostBudgetCap({
      kind: 'implement',
      baseCap: 2,
      blockedPanes: after.implement,
    });
    expect(capAfter.effectiveCap).toBe(2);
    expect(capAfter.relief).toBeNull();
  });
});
