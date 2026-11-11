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
 *  3. widening the candidate universe never weakens a budget or safety gate;
 *  4. the TUI sprint-view window is untouched — `browseItemCount` bounds only
 *     what the worklist renders, and the widened reach is nothing more than a
 *     larger limit on the same `fetchNextItems` seam (AC6).
 *
 * Scaffolding is imported from `downtime-worker.fixtures.ts`; no setup logic is
 * re-implemented here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  computeMostImportantItem,
  dispatchDowntimeWork,
  fetchExtendedHerdrItems,
  type DowntimeHerdrItem,
} from './downtime-worker.js';
import { makeDeps } from './downtime-worker.fixtures.js';
import { selectWorkItems } from './smart-selection.js';
import {
  clearFetchMemo,
  fetchNextItems,
  resetExecFileAsync,
  resetWorklogDir,
  setExecFileAsync,
  type WorkItem,
} from './fetcher.js';

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

// ── AC6 — the TUI sprint-view window is unchanged ─────────────────────

/**
 * One row of the ranked backlog, shaped like a `wl worklist` payload item.
 * The extra fields `selectWorkItems`/`regroupWorkItems` read are the ones the
 * consolidated read emits; no TUI state is involved.
 */
const workItemRow = (id: string, overrides: Record<string, unknown> = {}): WorkItem =>
  ({
    id,
    title: `Item ${id}`,
    status: 'open',
    stage: 'idea',
    priority: 'medium',
    parentId: null,
    createdAt: '2026-11-10T00:00:00.000Z',
    updatedAt: '2026-11-10T00:00:00.000Z',
    ...overrides,
  }) as unknown as WorkItem;

/**
 * A five-item ranked backlog. `A-CRIT` (critical) and `B-REVIEW`
 * (completed/in_review) are mandatory — always rendered whatever the count;
 * `C`-`E` are ordinary ranked work the count window may cut.
 */
const sprintBacklog = (): WorkItem[] => [
  workItemRow('A-CRIT', { priority: 'critical' }),
  workItemRow('B-REVIEW', { status: 'completed', stage: 'in_review', priority: 'high' }),
  workItemRow('C-OTHER-1'),
  workItemRow('D-OTHER-2'),
  workItemRow('E-OTHER-3'),
];

/**
 * The set the worklist renders for `browseItemCount = 3`: the two mandatory
 * legs plus one "other" slot, in the documented placement order (critical,
 * then review, then capped others).
 */
const SPRINT_VIEW_AT_3 = ['A-CRIT', 'B-REVIEW', 'C-OTHER-1'];

/**
 * Install a mock `wl` that answers the consolidated `worklist` read with the
 * sprint backlog, windowing the browse feed by the requested `-n` exactly as
 * the real command does. Any other command is an unexpected spawn (an extra
 * ranking query would violate AC7), so it throws instead of silently passing.
 * Returns the recorded argv so the count handed to `wl` can be asserted.
 */
function mockWorklistRead(): string[][] {
  const calls: string[][] = [];
  setExecFileAsync((async (_binary: string, args: string[]) => {
    calls.push(args);
    if (!args.includes('worklist')) {
      throw new Error(`unexpected wl spawn: ${args.join(' ')}`);
    }
    const nIndex = args.indexOf('-n');
    const count = nIndex >= 0 ? Number(args[nIndex + 1]) : 1;
    const backlog = sprintBacklog();
    const payload = {
      success: true,
      requestedCount: count,
      subsets: {
        // Browse entries carry the `wl next` `{ workItem, reason }` shape.
        browse: backlog
          .slice(0, count)
          .map((item) => ({ workItem: item, reason: 'selected' })),
        critical: backlog.filter((item) => item.priority === 'critical'),
        reviewQueue: backlog.filter(
          (item) => item.status === 'completed' && item.stage === 'in_review',
        ),
        inProgressRoots: backlog.filter((item) => item.status === 'in-progress'),
        blockedRoots: backlog.filter((item) => item.status === 'blocked'),
      },
    };
    return { stdout: JSON.stringify(payload), stderr: '' };
  }) as never);
  return calls;
}

/** The `-n <count>` pair the fetched read was invoked with. */
function requestedCount(args: string[]): string | undefined {
  const nIndex = args.indexOf('-n');
  return nIndex >= 0 ? args[nIndex + 1] : undefined;
}

describe('whole-backlog dispatch: the TUI sprint-view window is unchanged (WL-0MW9XS0XR007K1TH AC6)', () => {
  beforeEach(() => {
    clearFetchMemo();
    resetExecFileAsync();
    resetWorklogDir();
  });

  afterEach(() => {
    clearFetchMemo();
    resetExecFileAsync();
    resetWorklogDir();
  });

  it('selectWorkItems returns exactly the sprint-view set for the same count', () => {
    const selected = selectWorkItems(sprintBacklog(), 3).map((item) => item.id);

    // Exactly the sprint view — not a widened set, and not the whole backlog.
    expect(selected).toEqual(SPRINT_VIEW_AT_3);
  });

  it('fetchNextItems(count) renders exactly the sprint-view set for that count', async () => {
    const calls = mockWorklistRead();

    const rendered = await fetchNextItems(3);

    expect(rendered.map((item) => item.id).sort()).toEqual([...SPRINT_VIEW_AT_3].sort());
    // One consolidated read, still windowed by the TUI's count.
    expect(calls).toHaveLength(1);
    expect(requestedCount(calls[0])).toBe('3');
  });

  it('a wider dispatcher limit is only a wider window on the same seam — no second ranking', async () => {
    const calls = mockWorklistRead();

    const rendered = await fetchNextItems(20);

    // The identical read returns the whole ranked backlog: the dispatcher's
    // widening is a limit argument, not a new selection path.
    expect(rendered.map((item) => item.id).sort()).toEqual(
      sprintBacklog()
        .map((item) => item.id)
        .sort(),
    );
    expect(calls).toHaveLength(1);
    expect(requestedCount(calls[0])).toBe('20');
  });
});
