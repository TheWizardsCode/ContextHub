/**
 * packages/herdr/src/downtime-worker.dispatch-filter.test.ts — the code-freeze
 * split-by-skill safety gate in the dispatch filter (parent
 * WL-0MWTAD9NV000IVK5, child WL-0MWTASS0T0037XP6 AC1/AC5).
 *
 * This suite pins the filter's own freeze rule at its exported boundary —
 * `selectCriticalFirstCandidates` — so the gate that budget relief must never
 * relax has a dedicated, direct regression pin (the integration behaviour is
 * also exercised end-to-end in `downtime-worker.critical-first.test.ts`).
 *
 * Freeze contract (fail-closed): while the code-freeze marker is `frozen` OR
 * `ambiguous`, `audit` and `implement` candidates PAUSE, while `plan` /
 * `intake` / `risk-effort` prep still passes. A `needsProducerReview` hold and
 * the non-critical exclusion are unchanged by the freeze state.
 */

import { describe, expect, it } from 'vitest';

import { classifyItemForDispatch } from './downtime-worker.gates.js';
import { selectCriticalFirstCandidates } from './downtime-worker.dispatch-filter.js';
import type { DowntimeHerdrItem } from './downtime-worker.js';

const NOW = Date.parse('2026-11-23T13:00:00.000Z');

/** A critical, open candidate at a stage that classifies to `kind`. */
function critical(overrides: Partial<DowntimeHerdrItem> & { id: string }): DowntimeHerdrItem {
  return {
    title: 'Critical candidate',
    status: 'open',
    stage: 'idea',
    priority: 'critical',
    sortIndex: 1,
    ...overrides,
  };
}

const implementReady = (id: string): DowntimeHerdrItem =>
  critical({ id, stage: 'plan_complete', risk: 'High', effort: 'S' });

describe('code-freeze split-by-skill (AC1)', () => {
  it('freezes audit/implement while plan/intake/risk-effort prep continues', () => {
    const items = [
      implementReady('C-IMPL'),
      critical({ id: 'C-PLAN', stage: 'idea' }),
      critical({ id: 'C-INTAKE', stage: 'intake_complete' }),
      critical({ id: 'C-RISK', stage: 'plan_complete', risk: 'Low', effort: 'S', riskEffortDone: false }),
    ];
    // Sanity: without the freeze every candidate is admissible.
    const unfrozen = selectCriticalFirstCandidates(items, NOW, false);
    expect(unfrozen.map((candidate) => candidate.kind)).toContain('implement');
    expect(unfrozen).toHaveLength(items.length);

    const frozen = selectCriticalFirstCandidates(items, NOW, true);
    const kinds = frozen.map((candidate) => candidate.kind);
    // The split-by-skill rule pauses only audit/implement.
    expect(kinds).not.toContain('implement');
    expect(kinds).not.toContain('audit');
    expect(kinds).toContain('plan');
    expect(kinds).toContain('intake');
  });

  it('classifies a plan_complete critical implement item as implement (fixture sanity)', () => {
    // Guards the fixture above: the frozen run only proves anything if
    // C-IMPL really classifies as implement when unfrozen.
    expect(classifyItemForDispatch(implementReady('C-IMPL'), NOW)).toBe('implement');
  });

  it('does not revive a frozen implement via relief or a non-critical item', () => {
    const frozen = selectCriticalFirstCandidates(
      [implementReady('C-IMPL'), critical({ id: 'C-HIGH', priority: 'high' })],
      NOW,
      true,
    );
    // The non-critical item is excluded by the critical-first filter, and the
    // frozen implement stays paused: nothing is dispatchable in the freeze.
    expect(frozen).toEqual([]);
  });

  it('keeps the producer-review hold regardless of the freeze state', () => {
    const held = critical({ id: 'C-NPR', stage: 'plan_complete', needsProducerReview: true });
    expect(selectCriticalFirstCandidates([held], NOW, false)).toEqual([]);
    expect(selectCriticalFirstCandidates([held], NOW, true)).toEqual([]);
  });
});
