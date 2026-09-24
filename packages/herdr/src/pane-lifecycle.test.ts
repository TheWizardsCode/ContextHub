/**
 * Unit tests for pane-lifecycle.ts — the pure pane-lifecycle classifier and
 * rolling-log collectors for the downtime worker's auto-close monitor
 * (WL-0MU308WSF0002JWN, child WL-0MU4URK4H006OFCE).
 *
 * These tests pin the decision contract: which outcomes are produced, which
 * kinds are auto-closed (everything except `implement` — AC6), and the
 * idempotency keys that stop duplicate log entries.
 */

import { describe, it, expect } from 'vitest';
import {
  shouldAutoClosePane,
  collectDispatchedPanes,
  loggedPaneLifecycleKeys,
  paneLifecycleKey,
  classifyPaneLifecycle,
  type DispatchedPane,
  type PaneItemState,
} from './pane-lifecycle.js';
import type { DowntimeLogEntry } from './downtime-log.js';

function pane(overrides: Partial<DispatchedPane> = {}): DispatchedPane {
  return {
    itemId: 'WL-1',
    itemTitle: 'Test item',
    paneId: 'w1:p1',
    kind: 'plan',
    dispatchedAt: '2026-01-01T00:00:00.000Z',
    stage: 'intake_complete',
    ...overrides,
  };
}

function item(overrides: Partial<PaneItemState> = {}): PaneItemState {
  return { id: 'WL-1', title: 'Test item', stage: 'intake_complete', ...overrides };
}

describe('shouldAutoClosePane (AC6 — implement is never auto-closed)', () => {
  it('excludes implement and includes every other dispatch kind', () => {
    expect(shouldAutoClosePane('implement')).toBe(false);
    expect(shouldAutoClosePane('plan')).toBe(true);
    expect(shouldAutoClosePane('intake')).toBe(true);
    expect(shouldAutoClosePane('audit')).toBe(true);
    expect(shouldAutoClosePane('risk-effort')).toBe(true);
  });
});

describe('collectDispatchedPanes', () => {
  it('reconstructs panes from enrichment entries carrying a resolved paneId', () => {
    const entries: DowntimeLogEntry[] = [
      { itemId: 'WL-1', kind: 'plan', title: 'Plan me', dispatchedAt: '2026-01-01T00:00:00.000Z', stage: 'intake_complete' },
      { itemId: 'WL-1', kind: 'plan', title: 'Plan me', dispatchedAt: '2026-01-01T00:00:00.000Z', stage: 'intake_complete', paneId: 'w1:p1', enrichment: true },
    ];
    const panes = collectDispatchedPanes(entries);
    expect(panes).toHaveLength(1);
    expect(panes[0]).toMatchObject({ itemId: 'WL-1', paneId: 'w1:p1', kind: 'plan', itemTitle: 'Plan me' });
  });

  it('ignores entries without a paneId, without an itemId, of an unmanaged kind, or spawn-failed', () => {
    const entries: DowntimeLogEntry[] = [
      { itemId: 'WL-1', kind: 'plan' }, // no paneId → not closeable
      { kind: 'plan', paneId: 'w1:p2' }, // no itemId
      { itemId: 'WL-3', kind: 'scheduled', paneId: 'w1:p3' }, // unmanaged kind
      { itemId: 'WL-4', kind: 'audit', paneId: 'w1:p4', outcome: 'spawn-failed' }, // never appeared
      { entryType: 'pane-close', paneId: 'w1:p5', itemId: 'WL-5' }, // lifecycle entry, not a dispatch
    ];
    expect(collectDispatchedPanes(entries)).toEqual([]);
  });

  it('keeps the most recent entry per pane id', () => {
    const entries: DowntimeLogEntry[] = [
      { itemId: 'WL-1', kind: 'plan', title: 'old', paneId: 'w1:p1', dispatchedAt: '2026-01-01T00:00:00.000Z' },
      { itemId: 'WL-1', kind: 'plan', title: 'new', paneId: 'w1:p1', dispatchedAt: '2026-01-02T00:00:00.000Z' },
    ];
    const panes = collectDispatchedPanes(entries);
    expect(panes).toHaveLength(1);
    expect(panes[0].itemTitle).toBe('new');
    expect(panes[0].dispatchedAt).toBe('2026-01-02T00:00:00.000Z');
  });
});

describe('loggedPaneLifecycleKeys / paneLifecycleKey', () => {
  it('collects the pane+outcome+reasonCode keys already recorded', () => {
    const entries: DowntimeLogEntry[] = [
      { entryType: 'pane-close', paneId: 'w1:p1', outcome: 'closed-as-plan-complete', reasonCode: 'none' },
      { entryType: 'pane-close', paneId: 'w1:p2', outcome: 'requires-attention' }, // missing reasonCode → 'none'
      { itemId: 'WL-1', kind: 'plan', paneId: 'w1:p3' }, // not a pane-close entry
    ];
    const keys = loggedPaneLifecycleKeys(entries);
    expect(keys.has(paneLifecycleKey('w1:p1', 'closed-as-plan-complete', 'none'))).toBe(true);
    expect(keys.has(paneLifecycleKey('w1:p2', 'requires-attention', 'none'))).toBe(true);
    expect(keys.size).toBe(2);
  });
});

describe('classifyPaneLifecycle — terminal close outcomes (AC2)', () => {
  it('intake pane at intake_complete → closed-as-intake-complete (close)', () => {
    const d = classifyPaneLifecycle(pane({ kind: 'intake' }), item({ stage: 'intake_complete' }), false);
    expect(d).toMatchObject({ outcome: 'closed-as-intake-complete', close: true });
  });

  it('plan pane at plan_complete → closed-as-plan-complete (close)', () => {
    const d = classifyPaneLifecycle(pane({ kind: 'plan' }), item({ stage: 'plan_complete' }), false);
    expect(d).toMatchObject({ outcome: 'closed-as-plan-complete', close: true });
  });

  it('an intake pane whose item skipped ahead to plan_complete is still closed as intake-complete', () => {
    const d = classifyPaneLifecycle(pane({ kind: 'intake' }), item({ stage: 'plan_complete' }), false);
    expect(d).toMatchObject({ outcome: 'closed-as-intake-complete', close: true });
  });

  it('risk-effort pane at plan_complete with risk+effort populated → closed-as-plan-complete (close)', () => {
    const d = classifyPaneLifecycle(
      pane({ kind: 'risk-effort' }),
      item({ stage: 'plan_complete', risk: 'Low', effort: 'Small' }),
      false,
    );
    expect(d).toMatchObject({ outcome: 'closed-as-plan-complete', close: true });
  });

  it('risk-effort pane at plan_complete WITHOUT risk/effort stays open while the agent runs', () => {
    expect(
      classifyPaneLifecycle(pane({ kind: 'risk-effort' }), item({ stage: 'plan_complete' }), false),
    ).toBeNull();
  });
});

describe('classifyPaneLifecycle — audit outcomes (AC5)', () => {
  it('audit recorded + passed → audit-passed (close)', () => {
    const d = classifyPaneLifecycle(
      pane({ kind: 'audit' }),
      item({ stage: 'in_review', auditedAt: '2026-01-02T00:00:00.000Z', auditResult: true }),
      false,
    );
    expect(d).toMatchObject({ outcome: 'audit-passed', close: true });
  });

  it('audit recorded + failed → audit-failed (close)', () => {
    const d = classifyPaneLifecycle(
      pane({ kind: 'audit' }),
      item({ stage: 'in_review', auditedAt: '2026-01-02T00:00:00.000Z', auditResult: false }),
      false,
    );
    expect(d).toMatchObject({ outcome: 'audit-failed', close: true });
  });

  it('audit recorded with no explicit verdict defaults to passed', () => {
    const d = classifyPaneLifecycle(
      pane({ kind: 'audit' }),
      item({ stage: 'in_review', auditedAt: '2026-01-02T00:00:00.000Z' }),
      false,
    );
    expect(d).toMatchObject({ outcome: 'audit-passed', close: true });
  });

  it('audit pane whose agent ended without a result → requires-attention (close)', () => {
    const d = classifyPaneLifecycle(pane({ kind: 'audit' }), item({ stage: 'in_review' }), true);
    expect(d).toMatchObject({ outcome: 'requires-attention', reasonCode: 'audit-ended-no-result', close: true });
  });

  it('audit pane still in flight → null', () => {
    expect(classifyPaneLifecycle(pane({ kind: 'audit' }), item({ stage: 'in_review' }), false)).toBeNull();
  });
});

describe('classifyPaneLifecycle — implement is logged but never closed (AC4/AC6)', () => {
  it('implement pane at in_review → requires-attention, close:false', () => {
    const d = classifyPaneLifecycle(pane({ kind: 'implement' }), item({ stage: 'in_review' }), false);
    expect(d).toMatchObject({ outcome: 'requires-attention', reasonCode: 'reached-in-review', close: false });
  });

  it('implement pane whose agent ended before in_review → requires-attention, close:false', () => {
    const d = classifyPaneLifecycle(pane({ kind: 'implement' }), item({ stage: 'plan_complete' }), true);
    expect(d).toMatchObject({ outcome: 'requires-attention', reasonCode: 'agent-ended-no-terminal', close: false });
  });

  it('implement pane still running → null', () => {
    expect(classifyPaneLifecycle(pane({ kind: 'implement' }), item({ stage: 'plan_complete' }), false)).toBeNull();
  });
});

describe('classifyPaneLifecycle — requires-attention (AC3)', () => {
  it('an item awaiting producer review → requires-attention (close)', () => {
    const d = classifyPaneLifecycle(
      pane({ kind: 'plan' }),
      item({ stage: 'intake_complete', needsProducerReview: true }),
      false,
    );
    expect(d).toMatchObject({ outcome: 'requires-attention', reasonCode: 'producer-review', close: true });
  });

  it('a plan agent that ended without reaching plan_complete → requires-attention (close)', () => {
    const d = classifyPaneLifecycle(pane({ kind: 'plan' }), item({ stage: 'intake_complete' }), true);
    expect(d).toMatchObject({ outcome: 'requires-attention', reasonCode: 'agent-ended-no-terminal', close: true });
  });

  it('a risk-effort agent that ended without populating risk/effort → requires-attention (close)', () => {
    const d = classifyPaneLifecycle(pane({ kind: 'risk-effort' }), item({ stage: 'plan_complete' }), true);
    expect(d).toMatchObject({ outcome: 'requires-attention', reasonCode: 'risk-effort-incomplete', close: true });
  });

  it('a still-working pane with no terminal → null (no action)', () => {
    expect(classifyPaneLifecycle(pane({ kind: 'plan' }), item({ stage: 'intake_complete' }), false)).toBeNull();
  });

  it('a missing item is tolerated (agent done → requires-attention, never a throw)', () => {
    const d = classifyPaneLifecycle(pane({ kind: 'plan' }), null, true);
    expect(d).toMatchObject({ outcome: 'requires-attention', close: true });
    expect(classifyPaneLifecycle(pane({ kind: 'plan' }), null, false)).toBeNull();
  });
});
