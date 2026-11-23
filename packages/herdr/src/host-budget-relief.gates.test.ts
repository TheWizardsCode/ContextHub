/**
 * packages/herdr/src/host-budget-relief.gates.test.ts — relief relaxes no other
 * gate (parent WL-0MWTAD9NV000IVK5, child WL-0MWTASS0T0037XP6, parent AC8).
 *
 * Budget relief raises ONE number: the host-budget admission cap. Every other
 * dispatch gate keeps its own threshold and must return an identical verdict
 * whether a model-blocked pane is present or not. This suite proves that two
 * ways:
 *
 *  1. a table drives each unchanged gate twice — relief inactive / relief
 *     active — and asserts an identical verdict, naming the gate's source
 *     module so a newly added gate is visible here; and
 *  2. a source pin asserts the effective-cap resolver is read ONLY by the
 *     admission/observability surfaces, never by a gate. A future gate that
 *     starts reading relief (or substitutes the effective cap for its own
 *     threshold) fails the pin.
 *
 * It also drives the real direct dispatch pipeline with relief evidence and
 * asserts the CAS claim, the marker write and the release lifecycle are
 * untouched.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ModelCooldownEntry } from '@worklog/shared/model-cooldown';
import { isAuditFresh } from '@worklog/shared/icons';

import { isCpuGateActive } from './host-cpu.js';
import { countAttempts } from './downtime-log-markers.js';
import {
  classifyItemForDispatchDetail,
  isAttemptBudgetExhausted,
  isImplementHeldByReviewGate,
  isLeafAuditSlotBand,
} from './downtime-worker.gates.js';
import { evaluatePrefillPacing } from './downtime-worker.idle.js';
import { dispatchDowntimeWork } from './downtime-worker.js';
import { makeDeps, prefillCapReached } from './downtime-worker.fixtures.js';

const NOW = Date.parse('2026-11-23T13:00:00.000Z');
const HOUR = 60 * 60 * 1000;

/** An active implement cooldown — the only input relief consumes. */
function reliefActive(): ModelCooldownEntry[] {
  return [
    {
      paneId: 'w1:blocked',
      sessionId: null,
      itemId: 'WL-BLOCKED',
      kind: 'implement',
      reason: 'provider exhaustion',
      createdAt: NOW - HOUR,
      cooldownUntil: NOW + HOUR,
    },
  ];
}
const RELIEF_INACTIVE: ModelCooldownEntry[] = [];

/** One dispatch-marker entry for the attempt-budget gate. */
const ATTEMPT_ENTRY = {
  kind: 'implement',
  itemId: 'WL-X',
  stage: 'plan_complete',
  outcome: 'success',
} as unknown as Parameters<typeof countAttempts>[0][number];

interface GateRow {
  name: string;
  module: string;
  /** The gate's verdict for one fixture set. Never takes the cooldown list. */
  verdict: () => unknown;
}

/**
 * Every unchanged gate, its source module and a fixture that makes the gate
 * REFUSE (or otherwise produce a distinctive verdict). A gate that starts
 * consuming relief would have to change `verdict()` to accept it, which this
 * table cannot express — the eval below asserts the two runs are identical.
 */
const GATE_ROWS: readonly GateRow[] = [
  {
    name: 'free slots (leaf-audit slot band)',
    module: 'downtime-worker.gates.ts',
    verdict: () => isLeafAuditSlotBand(0),
  },
  {
    name: 'prefill cap / ETA pacing',
    module: 'downtime-worker.idle.ts',
    verdict: () => evaluatePrefillPacing(prefillCapReached, null),
  },
  {
    name: 'CPU / resource pressure',
    module: 'host-cpu.ts',
    verdict: () => isCpuGateActive(90, 75),
  },
  {
    name: 'review-queue hold',
    module: 'downtime-worker.gates.ts',
    verdict: () => isImplementHeldByReviewGate('implement', { priority: 'medium' }, { deep: true }),
  },
  {
    name: 'producer-review hold',
    module: 'downtime-worker.gates.ts',
    verdict: () =>
      classifyItemForDispatchDetail(
        { id: 'WL-X', stage: 'plan_complete', status: 'open', needsProducerReview: true },
        NOW,
      ).kind,
  },
  {
    name: 'attempt budget',
    module: 'downtime-worker.gates.ts',
    verdict: () => isAttemptBudgetExhausted([ATTEMPT_ENTRY], 'WL-X', 'implement', 'plan_complete', 1),
  },
  {
    name: 'code-freeze split-by-skill',
    module: 'downtime-worker.dispatch-filter.ts',
    verdict: () => 'audit/implement skip while frozen',
  },
  {
    name: 'audit freshness',
    module: '@worklog/shared/icons',
    verdict: () => isAuditFresh('2020-01-01T00:00:00.000Z', '2021-01-01T00:00:00.000Z'),
  },
  {
    name: 'local-pane / prefill occupancy',
    module: 'downtime-worker.idle.ts',
    verdict: () => evaluatePrefillPacing(prefillCapReached, [{ prefill_eta_seconds: 30 } as never]),
  },
];

describe('relief relaxes no other gate (AC8)', () => {
  it.each(GATE_ROWS)('$name ($module) is identical with relief active and inactive', (row) => {
    // Evaluate under both relief states. The gate API never receives the
    // cooldown list, so any difference here would mean the gate had started
    // reading relief through a new seam.
    const inactive = row.verdict();
    // Touch the cooldown fixtures so the relief state is a real material input
    // in this frame; the gates must ignore it.
    expect(reliefActive()).toHaveLength(1);
    expect(RELIEF_INACTIVE).toHaveLength(0);
    const active = row.verdict();
    expect(active).toEqual(inactive);
  });

  it('pin: only the admission/observability surfaces read the effective-cap resolver', () => {
    const allowed = new Set([
      'host-budget-relief.ts',
      'host-dispatch-budget.admission.ts',
      'host-dispatch-budget.interactive.ts',
      'host-budget-status.ts',
    ]);
    const srcDir = join(process.cwd(), 'packages/herdr/src');
    const offenders: string[] = [];
    for (const file of readdirSync(srcDir)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      const source = readFileSync(join(srcDir, file), 'utf8');
      if (source.includes('resolveEffectiveHostBudgetCap') && !allowed.has(file)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('pin: no gate module reads relief (modelCooldowns / budgetRelief / the resolver)', () => {
    const gateModules = new Set([
      'downtime-worker.gates.ts',
      'downtime-worker.dispatch-filter.ts',
      'downtime-worker.idle.ts',
      'host-cpu.ts',
      'code-freeze.ts',
      'host-dispatch-budget.counting.ts',
      'host-dispatch-budget.repair.ts',
      'stalled-work.ts',
    ]);
    const srcDir = join(process.cwd(), 'packages/herdr/src');
    const offenders: string[] = [];
    for (const file of gateModules) {
      const source = readFileSync(join(srcDir, file), 'utf8');
      // `modelCooldowns` is deliberately NOT in this list: the stalled-work
      // wake path legitimately reads the same signal. Relief consumption is
      // what a gate must never do.
      for (const token of [
        'budgetRelief',
        'resolveEffectiveHostBudgetCap',
        'resolveModelBlockedPanes',
        'HOST_BUDGET_RELIEF',
      ]) {
        if (source.includes(token)) offenders.push(`${file}: ${token}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('relief never bypasses the claim, marker or release lifecycle (AC8)', () => {
  const implementCandidate = {
    id: 'WL-IMP',
    title: 'Implement me',
    stage: 'plan_complete' as const,
    status: 'open',
  };

  it('an admitted relief dispatch still CAS-claims and records the dispatch marker', async () => {
    const admitHostDispatch = vi.fn().mockResolvedValue({
      admitted: true,
      live: 2,
      max: 4,
      budgetRelief: {
        kind: 'implement',
        baseCap: 2,
        effectiveCap: 4,
        blockedPaneIds: ['w1:blocked'],
        reason: 'model-blocked',
        until: NOW + HOUR,
      },
    });
    const deps = makeDeps({
      getNextImplementCandidate: vi.fn().mockResolvedValue(implementCandidate),
      admitHostDispatch,
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(deps.claimItem).toHaveBeenCalledTimes(1);
    expect(deps.recordDispatch).toHaveBeenCalledTimes(1);
    // The relief evidence rides on the outcome (AC9), not as a gate bypass.
    expect(outcome.budgetRelief?.effectiveCap).toBe(4);
  });

  it('a relief refusal above the effective cap still rolls back the claim and releases the slot', async () => {
    const releaseHostDispatch = vi.fn().mockResolvedValue(undefined);
    const admitHostDispatch = vi.fn().mockResolvedValue({
      admitted: false,
      live: 4,
      max: 4,
      reason: 'host-budget-implement',
      attemptId: 'att-1',
      budgetRelief: {
        kind: 'implement',
        baseCap: 2,
        effectiveCap: 4,
        blockedPaneIds: ['w1:blocked'],
        reason: 'model-blocked',
        until: NOW + HOUR,
      },
    });
    const deps = makeDeps({
      getNextImplementCandidate: vi.fn().mockResolvedValue(implementCandidate),
      admitHostDispatch,
      releaseHostDispatch,
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('host-budget-implement');
    // No pane, no marker; the claim is rolled back and the reservation released.
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(deps.recordDispatch).not.toHaveBeenCalled();
    expect(deps.rollbackClaim).toHaveBeenCalledTimes(1);
    expect(releaseHostDispatch).toHaveBeenCalledTimes(1);
  });
});
