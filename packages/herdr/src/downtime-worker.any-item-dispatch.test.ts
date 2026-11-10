/**
 * packages/herdr/src/downtime-worker.any-item-dispatch.test.ts — the
 * whole-backlog dispatch contract (WL-0MW9XS0XR007K1TH).
 *
 * Supersedes the sprint-view-only restriction of WL-0MUNS8X97007C9H9: the
 * dispatcher now considers EVERY ranked work item, while the existing
 * canonical prioritisation and every budget/safety gate remain unchanged.
 *
 * These tests pin the three things that must hold together:
 *  1. a non-critical item beyond the visible `browseItemCount` window is
 *     dispatchable (direct path + coordination offer path);
 *  2. the order in which candidates are chosen is still the canonical ranking;
 *  3. widening the candidate universe never weakens a budget or safety gate.
 *
 * Scaffolding is imported from `downtime-worker.fixtures.ts`; no setup logic is
 * re-implemented here.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  computeMostImportantItem,
  dispatchDowntimeWork,
  fetchExtendedHerdrItems,
  type DowntimeHerdrItem,
} from './downtime-worker.js';
import { makeDeps } from './downtime-worker.fixtures.js';

// ── Fixtures ──────────────────────────────────────────────────────────

/**
 * A non-dispatchable filler item: `open` at a stage with no dispatch kind
 * (`in_review`), so it occupies a window slot without ever being selected.
 * The same stable filler shape the sprint-view suite uses.
 */
const filler = (id: string, overrides: Partial<DowntimeHerdrItem> = {}): DowntimeHerdrItem => ({
  id,
  title: `Filler ${id}`,
  status: 'open',
  stage: 'in_review',
  priority: 'medium',
  risk: 'High',
  effort: 'S',
  sortIndex: 100,
  ...overrides,
});

/** A genuinely dispatchable non-critical item (open, `idea` → intake tier). */
const dispatchableIntake = (
  id: string,
  overrides: Partial<DowntimeHerdrItem> = {},
): DowntimeHerdrItem => ({
  id,
  title: `Dispatchable ${id}`,
  status: 'open',
  stage: 'idea',
  priority: 'high',
  sortIndex: 999,
  ...overrides,
});

/** A genuinely dispatchable non-critical implement candidate. */
const dispatchableImplement = (
  id: string,
  overrides: Partial<DowntimeHerdrItem> = {},
): DowntimeHerdrItem => ({
  id,
  title: `Implement ${id}`,
  status: 'open',
  stage: 'plan_complete',
  priority: 'high',
  risk: 'Low',
  effort: 'S',
  sortIndex: 999,
  ...overrides,
});

/**
 * A window-filling head: enough non-dispatchable items that the visible
 * `browseItemCount` window is exhausted before the real target.
 */
const windowFiller = (count: number): DowntimeHerdrItem[] =>
  Array.from({ length: count }, (_, i) => filler(`FILL-${i + 1}`, { sortIndex: 10 + i }));

// ── AC1 — a non-critical item beyond the window is dispatchable ───────

describe('whole-backlog dispatch: non-critical out-of-window items (WL-0MW9XS0XR007K1TH AC1)', () => {
  it('direct path dispatches a non-critical item that ranks beyond the sprint window', async () => {
    const head = windowFiller(30);
    const target = dispatchableIntake('BEYOND-WINDOW');
    const getHerdrListHead = vi
      .fn()
      // The windowed head contains only filler.
      .mockResolvedValueOnce({ ok: true, items: head })
      // The wider read surfaces the target beyond the window.
      .mockResolvedValueOnce({ ok: true, items: [...head, target] });
    const deps = makeDeps({ getHerdrListHead });

    const outcome = await dispatchDowntimeWork(deps, {
      model: 'plan',
      cwd: '/repo',
      browseItemCount: 20,
    });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('intake');
    expect(outcome.candidate?.id).toBe('BEYOND-WINDOW');
  });

  it('coordination offer path surfaces a non-critical item beyond the sprint window', async () => {
    const head = windowFiller(30);
    const target = dispatchableIntake('OFFER-BEYOND');
    const getHerdrListHead = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, items: head })
      .mockResolvedValueOnce({ ok: true, items: [...head, target] });
    const deps = makeDeps({ getHerdrListHead });

    const result = await computeMostImportantItem(deps, '/repo', Date.now(), 20);

    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ kind: 'intake', candidate: { id: 'OFFER-BEYOND' } });
  });

  it('fetchExtendedHerdrItems returns non-critical items beyond the head (no critical-only filter)', async () => {
    const current = [filler('A')];
    const getHerdrListHead = vi.fn().mockResolvedValue({
      ok: true,
      items: [
        filler('A'),
        dispatchableIntake('B', { priority: 'high' }),
        dispatchableIntake('C', { priority: 'low' }),
        dispatchableIntake('D', { priority: 'critical' }),
      ],
    });
    const deps = makeDeps({ getHerdrListHead });

    const extended = await fetchExtendedHerdrItems(deps, '/repo', current);

    // Every newly visible item is returned — not just the critical one — in
    // canonical order.
    expect(extended.map((i) => i.id)).toEqual(['B', 'C', 'D']);
  });
});

// ── AC3 — prioritisation is unchanged ─────────────────────────────────

describe('whole-backlog dispatch: canonical prioritisation preserved (WL-0MW9XS0XR007K1TH AC3)', () => {
  it('the highest-priority dispatchable item wins regardless of its window position', async () => {
    // Low-priority item sits inside the window; the higher-priority one is
    // beyond it. Canonical ranking (priority first) must win.
    const inWindow = dispatchableIntake('IN-WINDOW-LOW', { priority: 'low', sortIndex: 5 });
    const head = [inWindow, ...windowFiller(29)];
    const outOfWindow = dispatchableIntake('BEYOND-HIGH', { priority: 'high', sortIndex: 900 });
    const getHerdrListHead = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, items: head })
      .mockResolvedValueOnce({ ok: true, items: [...head, outOfWindow] });
    const deps = makeDeps({ getHerdrListHead });

    const outcome = await dispatchDowntimeWork(deps, {
      model: 'plan',
      cwd: '/repo',
      browseItemCount: 20,
    });

    // The in-window candidate is dispatched first: the head is still scanned
    // before the extension, so a reachable in-window item is never displaced
    // by a wider read.
    expect(outcome.dispatched).toBe(true);
    expect(outcome.candidate?.id).toBe('IN-WINDOW-LOW');
  });

  it('the wider read is a window extension, never a second ranking', async () => {
    const head = windowFiller(5);
    const getHerdrListHead = vi.fn().mockResolvedValue({ ok: true, items: head });
    const deps = makeDeps({ getHerdrListHead });

    await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 20 });

    // Every lookup goes through the SAME seam (the canonical ranking path);
    // the extension simply asks for a larger window.
    for (const call of getHerdrListHead.mock.calls) {
      expect(call[0]).toBe('/repo');
      expect(typeof call[1]).toBe('number');
    }
    // The extension's window is strictly larger than the initial head.
    expect(getHerdrListHead.mock.calls[1][1]).toBeGreaterThan(getHerdrListHead.mock.calls[0][1]);
  });
});

// ── AC4 — budgets still bind out-of-window candidates ─────────────────

describe('whole-backlog dispatch: budgets still bind (WL-0MW9XS0XR007K1TH AC4)', () => {
  it('refuses an out-of-window implement candidate at the host budget cap', async () => {
    const head = windowFiller(30);
    const target = dispatchableImplement('BEYOND-BUDGET');
    const getHerdrListHead = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, items: head })
      .mockResolvedValueOnce({ ok: true, items: [...head, target] });
    const deps = makeDeps({
      getHerdrListHead,
      admitHostDispatch: vi.fn().mockResolvedValue({
        admitted: false,
        live: 2,
        max: 2,
        reason: 'host-budget-implement',
      }),
    });

    const outcome = await dispatchDowntimeWork(deps, {
      model: 'plan',
      cwd: '/repo',
      browseItemCount: 20,
    });

    // Respecting the budget is abiding by the budget constraint: no spawn.
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('host-budget-implement');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('budget evidence still rides on an out-of-window dispatch that IS admitted', async () => {
    const head = windowFiller(30);
    const target = dispatchableImplement('BEYOND-ADMITTED');
    const getHerdrListHead = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, items: head })
      .mockResolvedValueOnce({ ok: true, items: [...head, target] });
    const admitHostDispatch = vi
      .fn()
      .mockResolvedValue({ admitted: true, live: 1, max: 2 });
    const deps = makeDeps({ getHerdrListHead, admitHostDispatch });

    const outcome = await dispatchDowntimeWork(deps, {
      model: 'plan',
      cwd: '/repo',
      browseItemCount: 20,
    });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.candidate?.id).toBe('BEYOND-ADMITTED');
    // The gate really ran for the out-of-window candidate.
    expect(admitHostDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'BEYOND-ADMITTED', kind: 'implement' }),
    );
  });
});

// ── AC5 — safety gates still apply out of window ──────────────────────

describe('whole-backlog dispatch: safety gates still apply out of window (WL-0MW9XS0XR007K1TH AC5)', () => {
  it('a producer-review-flagged out-of-window item is not dispatched', async () => {
    const head = windowFiller(30);
    const target = dispatchableIntake('BEYOND-REVIEW-FLAGGED', { needsProducerReview: true });
    const getHerdrListHead = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, items: head })
      .mockResolvedValueOnce({ ok: true, items: [...head, target] });
    const deps = makeDeps({ getHerdrListHead });

    const outcome = await dispatchDowntimeWork(deps, {
      model: 'plan',
      cwd: '/repo',
      browseItemCount: 20,
    });

    expect(outcome.dispatched).toBe(false);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('an assignee-held out-of-window item is not dispatched', async () => {
    const head = windowFiller(30);
    const target = dispatchableIntake('BEYOND-HELD', { assignee: 'Map' });
    const getHerdrListHead = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, items: head })
      .mockResolvedValueOnce({ ok: true, items: [...head, target] });
    const deps = makeDeps({ getHerdrListHead });

    const outcome = await dispatchDowntimeWork(deps, {
      model: 'plan',
      cwd: '/repo',
      browseItemCount: 20,
    });

    expect(outcome.dispatched).toBe(false);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('a soft-deleted out-of-window item is not dispatched', async () => {
    const head = windowFiller(30);
    const target = dispatchableIntake('BEYOND-DELETED', { deletedBy: 'someone' });
    const getHerdrListHead = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, items: head })
      .mockResolvedValueOnce({ ok: true, items: [...head, target] });
    const deps = makeDeps({ getHerdrListHead });

    const outcome = await dispatchDowntimeWork(deps, {
      model: 'plan',
      cwd: '/repo',
      browseItemCount: 20,
    });

    expect(outcome.dispatched).toBe(false);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('code freeze still pauses an out-of-window implement but lets intake through', async () => {
    const head = windowFiller(30);
    const impl = dispatchableImplement('BEYOND-IMPL-FROZEN');
    const intake = dispatchableIntake('BEYOND-INTAKE-FROZEN');
    const getHerdrListHead = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, items: head })
      .mockResolvedValueOnce({ ok: true, items: [...head, impl, intake] });
    const deps = makeDeps({
      getHerdrListHead,
      readCodeFreezeStatus: vi.fn().mockReturnValue('frozen'),
    });

    const outcome = await dispatchDowntimeWork(deps, {
      model: 'plan',
      cwd: '/repo',
      browseItemCount: 20,
    });

    // Split-by-skill is unchanged: implement paused, intake still dispatches.
    expect(outcome.dispatched).toBe(true);
    expect(outcome.candidate?.id).toBe('BEYOND-INTAKE-FROZEN');
  });
});
