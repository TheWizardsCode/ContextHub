/**
 * packages/herdr/src/downtime-worker.dispatch-budget-identity.test.ts —
 * a still-running dispatch's budget entry survives every abort path of another
 * attempt (WL-0MWFJD5T4003OM91 AC2, parent WL-0MWFJD1RV008FCCR).
 *
 * The 2026-11-13 evidence: `anchor-unavailable` aborts fired 211 times and six
 * confirmed, live-pane implement entries had no ledger entry left. Every abort
 * path released by ITEM ID, so an attempt that never spawned deleted whichever
 * entry happened to share the item — including a running dispatch's.
 *
 * These tests drive the real pipeline (`dispatchDowntimeWork`) with the REAL
 * ledger via the production admission/release seams, against an isolated
 * machine coordination dir seeded with a second, live entry for the same work
 * item. Each of the four abort paths must leave that entry untouched while
 * removing only its own reservation.
 *
 * The four paths, in pipeline order: admission refusal, marker-write failure,
 * spawn failure and `anchor-unavailable`.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  admitHostDispatch,
  releaseHostDispatch,
  type HostBudgetAdmissionOptions,
} from './host-dispatch-budget.admission.js';
import { readBudget, type HostBudgetEntry } from './host-dispatch-budget.js';
import { makeBudgetEntry, withMachineDir, writeBudgetLedger } from './host-dispatch-budget.fixtures.js';
import { dispatchDowntimeWork } from './downtime-worker.js';
import { makeDeps } from './downtime-worker.fixtures.js';

const ITEM = 'WL-SHARED';
const SIBLING_ITEM = 'WL-SHARED';

const IMPLEMENT_CANDIDATE = {
  id: ITEM,
  title: 'Shared item',
  stage: 'plan_complete' as const,
  status: 'open',
};

/** The sibling entry's pane: a live pane the seeded entry is confirmed on. */
const SIBLING_PANE = 'p:sibling';

/**
 * Seed the machine ledger with another attempt's confirmed, live-pane entry for
 * the SAME work item — the slot that must survive every abort below.
 *
 * The sibling is a DIFFERENT tier by default (an `audit` entry for the item),
 * which is the collision the RCA evidence shows: an implement dispatch and an
 * audit dispatch of one item. Two concurrent dispatches of the SAME tier for
 * one item are already impossible (the CAS claim is single-flight), and a
 * same-key reservation deliberately transfers the slot to the new attempt
 * rather than duplicating it.
 *
 * It is written raw (not via `reserve`) so the test owns its identity: the
 * production writer would mint a token the abort under test must NOT present.
 */
function seedSiblingEntry(dir: string, kind: 'implement' | 'audit' = 'audit'): void {
  writeBudgetLedger(dir, [
    makeBudgetEntry({
      kind,
      itemId: SIBLING_ITEM,
      attemptId: 'att-the-running-dispatch',
      instanceId: 'instance-running',
      paneId: SIBLING_PANE,
      root: '/repo',
    }),
  ]);
}

/** The stored entries for `dir`. */
function entries(dir: string): HostBudgetEntry[] {
  const read = readBudget({ dir });
  if (!read.ok) throw new Error(`ledger unreadable: ${read.reason}`);
  return read.ledger.entries;
}

/** Production seams bound to the isolated machine dir (pinned by env). */
function budgetSeams(admission: Partial<HostBudgetAdmissionOptions> = {}) {
  return {
    admitHostDispatch: vi.fn(async (input: { itemId: string; kind: string; cwd: string }) =>
      admitHostDispatch(
        {
          kind: input.kind === 'audit' ? 'audit' : 'implement',
          itemId: input.itemId,
          instanceId: 'instance-test',
          root: input.cwd,
        },
        // An authoritative EMPTY pane list: the sibling's pane is not live for
        // THIS admission, so the tier has a free slot and reserves.
        { livePanes: [], ...admission },
      ),
    ),
    releaseHostDispatch: vi.fn(async (itemId: string, _cwd: string, release) => {
      releaseHostDispatch({
        itemId,
        ...(release?.kind === 'implement' || release?.kind === 'audit'
          ? { kind: release.kind }
          : {}),
        ...(release?.paneId !== undefined ? { paneId: release.paneId } : {}),
        ...(release?.attemptId !== undefined ? { attemptId: release.attemptId } : {}),
      });
    }),
  };
}

/** Assert the seeded sibling entry is still there, and still confirmed. */
function expectSiblingSurvives(dir: string): void {
  const remaining = entries(dir);
  const sibling = remaining.find((entry) => entry.attemptId === 'att-the-running-dispatch');
  expect(sibling).toBeDefined();
  expect(sibling?.paneId).toBe(SIBLING_PANE);
}

describe('abort paths release only their own bounded entry', () => {
  it('AC2 — admission refusal: the sibling entry survives, nothing else is touched', async () => {
    await withMachineDir(async (dir) => {
      seedSiblingEntry(dir);
      const deps = makeDeps({
        getNextImplementCandidate: vi.fn().mockResolvedValue(IMPLEMENT_CANDIDATE),
        ...budgetSeams(),
        // A refusal carries no attempt token, so the release has no identity and
        // must be refused by the ledger rather than deleting the sibling.
        admitHostDispatch: vi.fn().mockResolvedValue({
          admitted: false,
          live: 2,
          max: 2,
          reason: 'host-budget-implement',
        }),
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.reason).toBe('host-budget-implement');
      expectSiblingSurvives(dir);
      expect(entries(dir)).toHaveLength(1);
    });
  });

  it('AC2 — marker-write failure: the sibling survives, the attempt’s own entry is released', async () => {
    await withMachineDir(async (dir) => {
      seedSiblingEntry(dir);
      const seams = budgetSeams();
      const deps = makeDeps({
        getNextImplementCandidate: vi.fn().mockResolvedValue(IMPLEMENT_CANDIDATE),
        recordDispatch: vi.fn().mockResolvedValue(false),
        ...seams,
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.reason).toBe('claim-rolled-back');
      // The admission really reserved (so there WAS an entry to remove)…
      expect(seams.admitHostDispatch).toHaveBeenCalledTimes(1);
      // …and the release carried the attempt token, leaving only the sibling.
      expect(seams.releaseHostDispatch).toHaveBeenCalledWith(
        ITEM,
        '/repo',
        expect.objectContaining({ kind: 'implement', reason: 'marker-write-failed' }),
      );
      const identity = seams.releaseHostDispatch.mock.calls[0][2] as { attemptId?: string };
      expect(typeof identity.attemptId).toBe('string');
      expectSiblingSurvives(dir);
      expect(entries(dir)).toHaveLength(1);
    });
  });

  it('AC2 — spawn failure: the sibling survives, the attempt’s own entry is released', async () => {
    await withMachineDir(async (dir) => {
      seedSiblingEntry(dir);
      const seams = budgetSeams();
      const deps = makeDeps({
        getNextImplementCandidate: vi.fn().mockResolvedValue(IMPLEMENT_CANDIDATE),
        spawnAgentPane: vi.fn().mockResolvedValue({ ok: false, error: 'boom' }),
        ...seams,
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.reason).toBe('spawn-failed');
      expectSiblingSurvives(dir);
      expect(entries(dir)).toHaveLength(1);
    });
  });

  it('AC2 — anchor-unavailable: the sibling survives, the attempt’s own entry is released', async () => {
    await withMachineDir(async (dir) => {
      seedSiblingEntry(dir);
      const seams = budgetSeams();
      const deps = makeDeps({
        getNextImplementCandidate: vi.fn().mockResolvedValue(IMPLEMENT_CANDIDATE),
        resolveProjectWorkspace: vi
          .fn()
          .mockResolvedValue({ paneId: 'wC:pB', workspaceId: 'wC', tabId: 'wC:tPlugin' }),
        getItemTabAnchor: vi.fn().mockResolvedValue(null),
        ...seams,
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.reason).toBe('anchor-unavailable');
      expect(seams.releaseHostDispatch).toHaveBeenCalledWith(
        ITEM,
        '/repo',
        expect.objectContaining({ kind: 'implement', reason: 'anchor-unavailable' }),
      );
      expectSiblingSurvives(dir);
      expect(entries(dir)).toHaveLength(1);
    });
  });

  it('AC4 — an implement abort never touches the same item’s audit entry', async () => {
    await withMachineDir(async (dir) => {
      seedSiblingEntry(dir, 'audit');
      const seams = budgetSeams();
      const deps = makeDeps({
        getNextImplementCandidate: vi.fn().mockResolvedValue(IMPLEMENT_CANDIDATE),
        spawnAgentPane: vi.fn().mockResolvedValue({ ok: false, error: 'boom' }),
        ...seams,
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.reason).toBe('spawn-failed');
      const remaining = entries(dir);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].kind).toBe('audit');
      expect(remaining[0].attemptId).toBe('att-the-running-dispatch');
    });
  });
});
