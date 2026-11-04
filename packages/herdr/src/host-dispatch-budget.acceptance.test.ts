/**
 * packages/herdr/src/host-dispatch-budget.acceptance.test.ts — the epic-level
 * ACCEPTANCE MATRIX for the host-wide dispatch budget (WL-0MVXY11IL0032S07 F7,
 * parent epic WL-0MVXWQFGV000D2AB).
 *
 * The per-feature suites (F1–F6) prove each module in isolation. This file is
 * the cross-cutting acceptance gate the producer closes the epic on: every
 * parent acceptance criterion is driven through a PUBLIC surface (the worker
 * dispatch pipeline, the production admission/ledger modules, the interactive
 * gate, the dialog, the observability reader) against ONE shared, isolated
 * machine coordination dir. A green per-feature suite can therefore never hide
 * an integration gap between two features.
 *
 * Mapping to the parent epic's acceptance criteria (WL-0MVXWQFGV000D2AB), kept
 * in the test names so coverage is navigable:
 *
 *   AC1  ledger module: documented read/reserve/release/reap semantics, pure
 *        decision helpers separated from fs I/O.
 *   AC2  two herdr instances share one budget; two in-flight implements block
 *        a third dispatch from EITHER instance.
 *   AC3  `maxAudit` replaces the hard-coded 1 (0/1/2, legacy single-flight
 *        token preserved at 1).
 *   AC4  `maxImplement: 0` / `maxAudit: 0` disable that tier host-wide.
 *   AC5  every release path frees the slot: pane close / dispatch failure /
 *        failed claim (all the release-by-item-id seam) plus stale reaping.
 *   AC6  user-fired shortcuts (pane AND headless) ask at cap; cancel leaves NO
 *        claim, NO pane and NO ledger entry.
 *   AC7  the overshoot figure and the dialog's live/max are correct.
 *   AC8  dispatcher-fired over-quota ticks never prompt, never claim, and do
 *        not enter the no-candidate cooldown.
 *   AC9  corrupt ledger in both fail directions: dispatcher fails closed
 *        (`host-budget-unknown`) and rewrites from live panes; the interactive
 *        path fails open with a visible notice.
 *   AC10 the decision log, header token, stderr skip line and worklist counter
 *        all quote the SAME counts from one reader.
 *   AC11 an unresolvable coordination dir degrades exactly as today (no
 *        ledger, no new failure mode, no counter chrome).
 *
 * AC12 (docs) is delivered by F6 and verified by the audit; AC13 (full suite
 * green + audit passes) is the run recorded on the work item. Neither is a
 * behaviour this matrix could assert without grepping source, so both are
 * recorded on the item rather than faked as tests here.
 *
 * Run: npx vitest run packages/herdr/src/host-dispatch-budget.acceptance.test.ts
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  admitHostDispatch,
  confirmHostDispatch,
  HOST_BUDGET_AUDIT_REFUSAL,
  HOST_BUDGET_AUDIT_SATURATED_REFUSAL,
  HOST_BUDGET_IMPLEMENT_REFUSAL,
  HOST_BUDGET_UNKNOWN_REFUSAL,
  readAuditBudgetState,
} from './host-dispatch-budget.admission.js';
import {
  HOST_BUDGET_CONFIG_FILE,
  HOST_BUDGET_STALE_WINDOW_MS,
  budgetConfigPath,
  clampHostBudget,
  computeOverQuota,
  readBudget,
  release,
  reap,
  reserve,
  type HostBudgetLivePane,
} from './host-dispatch-budget.js';
import {
  budgetLedgerPath,
  makeBudgetEntry,
  makeLivePaneList,
  readBudgetLedger,
  seedBudgetLedger,
  withMachineDir,
  writeBudgetLedger,
  writeRawBudgetLedger,
} from './host-dispatch-budget.fixtures.js';
import {
  HOST_BUDGET_UNREADABLE_NOTICE,
  prepareInteractiveAgentDispatch,
  type InteractiveAgentDispatchDeps,
} from './host-dispatch-budget.interactive.js';
import {
  HostBudgetDialogState,
  formatHostBudgetDialog,
  formatHostBudgetHeadline,
} from './host-budget-dialog.js';
import {
  hostBudgetSkipLine,
  hostBudgetStatusText,
  readHostBudgetStatus,
} from './host-budget-status.js';
import {
  createDowntimePoller,
  createDowntimeWorker,
  decisionHeaderToken,
  dispatchDowntimeWork,
  type DowntimeWorkerDeps,
} from './downtime-worker.js';
import {
  idleAllSlotsFree,
  jsonResponseFixture,
  makeDeps,
} from './downtime-worker.fixtures.js';

/** Deterministic clock: 2026-11-03T12:00:00.000Z. */
const T0 = Date.parse('2026-11-03T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const CLEAN_ENV: Readonly<Record<string, string | undefined>> = {};

/** A worklog root per fake instance (never touched on disk). */
const INSTANCE_A_ROOT = '/repo/a';
const INSTANCE_B_ROOT = '/repo/b';

const IMPLEMENT_CANDIDATE = {
  id: 'WL-IMP',
  title: 'Implement me',
  stage: 'plan_complete' as const,
  status: 'open',
};

const AUDIT_CANDIDATE = {
  id: 'WL-AUD',
  title: 'Audit me',
  stage: 'audit' as const,
};

/** Write `<dir>/budget.json` with the given per-tier caps. */
function writeCaps(dir: string, caps: { maxImplement?: number; maxAudit?: number }): void {
  writeFileSync(budgetConfigPath(dir), JSON.stringify(caps) + '\n', 'utf8');
}

/** A live pane owned by `itemId` (the dispatcher's pane-title convention). */
function livePane(paneId: string, itemId: string): HostBudgetLivePane {
  return { paneId, title: `Downtime triggered - ${itemId}` };
}

/**
 * The production admission/confirm/release seams pointed at ONE isolated
 * machine dir and ONE machine-wide live-pane list. This is exactly how
 * `index.ts` wires them; only the dir/clock are injected.
 */
function budgetSeams(
  dir: string,
  opts: {
    instanceId?: string;
    livePanes?: readonly HostBudgetLivePane[];
    now?: number;
  } = {},
): Pick<DowntimeWorkerDeps, 'admitHostDispatch' | 'confirmHostDispatch' | 'releaseHostDispatch'> {
  const now = opts.now ?? T0;
  const livePanes = opts.livePanes ?? [];
  const instanceId = opts.instanceId ?? 'instance-a';
  return {
    admitHostDispatch: vi.fn(
      async (input: { itemId: string; kind: string; cwd: string }) =>
        admitHostDispatch(
          {
            kind: input.kind === 'audit' ? 'audit' : 'implement',
            itemId: input.itemId,
            instanceId,
            root: input.cwd,
          },
          { dir, livePanes, now, env: CLEAN_ENV },
        ),
    ),
    confirmHostDispatch: vi.fn(
      async (itemId: string, kind: string, paneId: string, cwd: string) => {
        confirmHostDispatch(
          {
            kind: kind === 'audit' ? 'audit' : 'implement',
            itemId,
            instanceId,
            root: cwd,
            paneId,
          },
          { dir, now, env: CLEAN_ENV },
        );
      },
    ),
    releaseHostDispatch: vi.fn(async (itemId: string) => {
      release(itemId, { dir, now, env: CLEAN_ENV });
    }),
  };
}

/** The audit tier's production pre-check (`index.ts` `getActiveAudit`). */
function auditStateSeam(dir: string, now = T0): DowntimeWorkerDeps['getActiveAudit'] {
  return vi.fn(async () => {
    const state = readAuditBudgetState({ dir, now, env: CLEAN_ENV });
    return state.atCap
      ? {
          ok: true as const,
          active: true,
          source: 'host-wide' as const,
          ...(state.reason !== undefined ? { reason: state.reason } : {}),
          budget: { live: state.live, max: state.max },
        }
      : { ok: true as const, active: false, source: 'host-wide' as const };
  });
}

/**
 * A real worker over the isolated machine dir with the REAL admission reader.
 * Each call is one "tick" of a fake herdr instance.
 */
function makeWorkerInstance(opts: {
  dir: string;
  cwd: string;
  instanceId: string;
  livePanes: readonly HostBudgetLivePane[];
  candidate: typeof IMPLEMENT_CANDIDATE | null;
  now?: number;
  recordDecision: ReturnType<typeof vi.fn>;
}): { worker: ReturnType<typeof createDowntimeWorker>; deps: DowntimeWorkerDeps } {
  const now = opts.now ?? T0;
  const deps = makeDeps({
    getNextImplementCandidate: vi.fn().mockResolvedValue(opts.candidate),
    recordDecision: opts.recordDecision,
    ...budgetSeams(opts.dir, {
      instanceId: opts.instanceId,
      livePanes: opts.livePanes,
      now,
    }),
  });
  const worker = createDowntimeWorker({
    poller: createDowntimePoller('http://proxy:8000', async () =>
      jsonResponseFixture(idleAllSlotsFree),
    ),
    deps,
    config: () => ({
      enabled: true,
      thresholdMs: 0,
      requiredFreeSlots: 0,
      model: 'plan',
      cwd: opts.cwd,
      noCandidateCooldownMs: 3_600_000,
      browseItemCount: 20,
    }),
  });
  return { worker, deps };
}

/** Drain the `void recordDecision(...)` microtask chain after a tick. */
async function flushDecisionLog(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** The interactive gate's deps over an isolated dir (pane and headless share it). */
function interactiveDeps(
  dir: string | null,
  opts: {
    confirm?: InteractiveAgentDispatchDeps['confirm'];
    livePanes?: readonly HostBudgetLivePane[];
    now?: number;
  } = {},
): {
  deps: InteractiveAgentDispatchDeps;
  confirm: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  claim: ReturnType<typeof vi.fn>;
} {
  const confirm = vi.fn(opts.confirm ?? (async () => 'cancel' as const));
  const notify = vi.fn();
  const claim = vi.fn(async () => {});
  return {
    confirm,
    notify,
    claim,
    deps: {
      confirm,
      notify,
      claim,
      readLivePanes: async () => opts.livePanes ?? [],
      root: INSTANCE_A_ROOT,
      instanceId: 'instance-a',
      budget: { dir, now: opts.now ?? T0, env: CLEAN_ENV },
    },
  };
}

const IMPLEMENT_CMD = '/skill:implement WL-0000000000000001';
const AUDIT_CMD = '/skill:audit WL-0000000000000001';

afterEach(() => {
  vi.useRealTimers();
});

// ── AC1 — the ledger module's documented semantics ────────────────────

describe('AC1 — machine-scoped ledger: read/reserve/release/reap + pure helpers', () => {
  it('AC1: reserve → read → release → reap round-trips through one ledger file', () =>
    withMachineDir((dir) => {
      // An absent ledger is a valid EMPTY ledger (not an error).
      expect(readBudget({ dir, env: CLEAN_ENV })).toMatchObject({
        ok: true,
        ledger: { version: 1, entries: [] },
      });

      const reserved = reserve(
        { kind: 'implement', itemId: 'WL-1', instanceId: 'i-a', root: INSTANCE_A_ROOT },
        { dir, now: T0, env: CLEAN_ENV },
      );
      expect(reserved).toMatchObject({ ok: true, entry: { itemId: 'WL-1', kind: 'implement' } });

      const read = readBudget({ dir, now: T0, env: CLEAN_ENV });
      expect(read.ok && read.ledger.entries.map((entry) => entry.itemId)).toEqual(['WL-1']);

      // Release is keyed by item id and idempotent — the one seam every
      // pane-close / dispatch-failure / failed-claim path calls (AC5).
      expect(release('WL-1', { dir, now: T0, env: CLEAN_ENV })).toMatchObject({
        ok: true,
        removed: true,
      });
      expect(release('WL-1', { dir, now: T0, env: CLEAN_ENV })).toMatchObject({
        ok: true,
        removed: false,
      });

      // Reap drops a stale, pane-less entry and leaves the fresh one alone.
      seedBudgetLedger(dir, [
        makeBudgetEntry({
          itemId: 'WL-STALE',
          paneId: 'pane-gone',
          heartbeatAt: new Date(T0 - HOST_BUDGET_STALE_WINDOW_MS - HOUR).toISOString(),
        }),
        makeBudgetEntry({ itemId: 'WL-FRESH', paneId: 'pane-live', heartbeatAt: new Date(T0).toISOString() }),
      ]);
      expect(reap([], { dir, now: T0, env: CLEAN_ENV })).toMatchObject({ ok: true, reaped: 1 });
      const after = readBudget({ dir, now: T0, env: CLEAN_ENV });
      expect(after.ok && after.ledger.entries.map((entry) => entry.itemId)).toEqual(['WL-FRESH']);
    }));

  it('AC1: decision helpers are pure (no fs I/O) and encode the documented arithmetic', () => {
    // Garbage never silently changes a cap (it keeps the fallback).
    expect(clampHostBudget('garbage', 2)).toBe(2);
    expect(clampHostBudget(-1, 2)).toBe(2);
    expect(clampHostBudget(0, 2)).toBe(0); // the kill switch is a valid cap
    expect(computeOverQuota(2, 2)).toBe(1); // at cap ⇒ over by 1
    expect(computeOverQuota(4, 2)).toBe(3); // already 2 over ⇒ over by 3
    // An unresolvable dir is a distinct, non-"unknown" outcome (AC11).
    expect(readBudget({ dir: null, env: CLEAN_ENV })).toMatchObject({
      ok: false,
      unknown: false,
      reason: 'no-coordination-dir',
    });
  });
});

// ── AC2 — one budget shared by two instances ─────────────────────────

describe('AC2 — two instances share one host budget', () => {
  it('AC2: maxImplement=2 — two in-flight implements block a third dispatch from EITHER instance', async () => {
    await withMachineDir(async (dir) => {
      writeCaps(dir, { maxImplement: 2 });
      const panes: HostBudgetLivePane[] = [];
      const recordDecision = vi.fn().mockResolvedValue(undefined);

      vi.useFakeTimers();
      vi.setSystemTime(T0);

      // Instance A dispatches WL-A and its pane goes live (confirmed).
      const a1 = makeWorkerInstance({
        dir,
        cwd: INSTANCE_A_ROOT,
        instanceId: 'instance-a',
        livePanes: panes,
        candidate: { ...IMPLEMENT_CANDIDATE, id: 'WL-A' },
        recordDecision,
      });
      await a1.worker.tick();
      expect(a1.deps.spawnAgentPane).toHaveBeenCalledTimes(1);
      confirmHostDispatch(
        { kind: 'implement', itemId: 'WL-A', instanceId: 'instance-a', root: INSTANCE_A_ROOT, paneId: 'pane-a' },
        { dir, now: T0, env: CLEAN_ENV },
      );
      panes.push(livePane('pane-a', 'WL-A'));

      // Instance B dispatches WL-B: it counts A's entry — still 1 < 2.
      const b1 = makeWorkerInstance({
        dir,
        cwd: INSTANCE_B_ROOT,
        instanceId: 'instance-b',
        livePanes: panes,
        candidate: { ...IMPLEMENT_CANDIDATE, id: 'WL-B' },
        recordDecision,
      });
      await b1.worker.tick();
      expect(b1.deps.spawnAgentPane).toHaveBeenCalledTimes(1);
      confirmHostDispatch(
        { kind: 'implement', itemId: 'WL-B', instanceId: 'instance-b', root: INSTANCE_B_ROOT, paneId: 'pane-b' },
        { dir, now: T0, env: CLEAN_ENV },
      );
      panes.push(livePane('pane-b', 'WL-B'));

      // A third dispatch is refused from EITHER instance, with 2/2 evidence.
      for (const [cwd, instanceId] of [
        [INSTANCE_A_ROOT, 'instance-a'],
        [INSTANCE_B_ROOT, 'instance-b'],
      ] as const) {
        const third = makeWorkerInstance({
          dir,
          cwd,
          instanceId,
          livePanes: panes,
          candidate: { ...IMPLEMENT_CANDIDATE, id: 'WL-C' },
          recordDecision,
        });
        await third.worker.tick();
        expect(third.deps.spawnAgentPane).not.toHaveBeenCalled();
        expect(third.deps.admitHostDispatch).toHaveBeenCalledTimes(1);
        expect(third.deps.admitHostDispatch).toHaveResolvedWith({
          admitted: false,
          live: 2,
          max: 2,
          reason: HOST_BUDGET_IMPLEMENT_REFUSAL,
        });
      }
      await flushDecisionLog();
    });
  });
});

// ── AC3 — the audit tier 0/1/2 ───────────────────────────────────────

describe('AC3 — maxAudit replaces the hard-coded single-flight', () => {
  it('AC3: maxAudit=1 reproduces the legacy single-flight token and release point', async () => {
    await withMachineDir(async (dir) => {
      writeCaps(dir, { maxAudit: 1 });
      const deps = makeDeps({
        getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: AUDIT_CANDIDATE }),
        getActiveAudit: auditStateSeam(dir),
        ...budgetSeams(dir, { instanceId: 'instance-a', livePanes: [] }),
      });

      const first = await dispatchDowntimeWork(deps, { model: 'plan', cwd: INSTANCE_A_ROOT });
      expect(first.dispatched).toBe(true);
      expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);

      // Second audit: the legacy token every existing consumer keys on.
      const second = await dispatchDowntimeWork(deps, { model: 'plan', cwd: INSTANCE_A_ROOT });
      expect(second).toMatchObject({
        dispatched: false,
        reason: HOST_BUDGET_AUDIT_SATURATED_REFUSAL,
        budget: { live: 1, max: 1 },
      });
      expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);

      // The shared release point frees the slot again.
      release('WL-AUD', { dir, now: T0, env: CLEAN_ENV });
      const third = await dispatchDowntimeWork(deps, { model: 'plan', cwd: INSTANCE_A_ROOT });
      expect(third.dispatched).toBe(true);
    });
  });

  it('AC3: maxAudit=2 admits two concurrent audits and refuses the third with host-budget-audit', async () => {
    await withMachineDir(async (dir) => {
      writeCaps(dir, { maxAudit: 2 });
      const run = async (id: string) => {
        const deps = makeDeps({
          getNextAuditCandidate: vi
            .fn()
            .mockResolvedValue({ ok: true, candidate: { ...AUDIT_CANDIDATE, id } }),
          getActiveAudit: auditStateSeam(dir),
          ...budgetSeams(dir, { instanceId: 'instance-a', livePanes: [] }),
        });
        return dispatchDowntimeWork(deps, { model: 'plan', cwd: INSTANCE_A_ROOT });
      };

      expect((await run('WL-AUD-1')).dispatched).toBe(true);
      expect((await run('WL-AUD-2')).dispatched).toBe(true);
      expect(await run('WL-AUD-3')).toMatchObject({
        dispatched: false,
        reason: HOST_BUDGET_AUDIT_REFUSAL,
        budget: { live: 2, max: 2 },
      });
    });
  });
});

// ── AC4 — the per-tier kill switch ───────────────────────────────────

describe('AC4 — maxImplement=0 / maxAudit=0 disable the tier host-wide', () => {
  it('AC4: maxImplement=0 refuses every implement with 0/0 and writes no ledger entry', async () => {
    await withMachineDir(async (dir) => {
      writeCaps(dir, { maxImplement: 0 });
      const deps = makeDeps({
        getNextImplementCandidate: vi.fn().mockResolvedValue(IMPLEMENT_CANDIDATE),
        ...budgetSeams(dir, { instanceId: 'instance-a', livePanes: [] }),
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: INSTANCE_A_ROOT });
      expect(outcome).toMatchObject({
        dispatched: false,
        reason: HOST_BUDGET_IMPLEMENT_REFUSAL,
        budget: { live: 0, max: 0 },
      });
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
      // A disabled tier never reserves: the ledger is never created.
      expect(readBudgetLedger(dir)).toBeNull();
    });
  });

  it('AC4: maxAudit=0 refuses every audit with 0/0 evidence', async () => {
    await withMachineDir(async (dir) => {
      writeCaps(dir, { maxAudit: 0 });
      const deps = makeDeps({
        getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: AUDIT_CANDIDATE }),
        getActiveAudit: auditStateSeam(dir),
        ...budgetSeams(dir, { instanceId: 'instance-a', livePanes: [] }),
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: INSTANCE_A_ROOT });
      expect(outcome).toMatchObject({
        dispatched: false,
        reason: HOST_BUDGET_AUDIT_REFUSAL,
        budget: { live: 0, max: 0 },
      });
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    });
  });
});

// ── AC5 — every release path frees the slot ──────────────────────────

describe('AC5 — every release path gives the slot back', () => {
  it('AC5: a failed marker write and a failed spawn both release the reservation', async () => {
    await withMachineDir(async (dir) => {
      writeCaps(dir, { maxImplement: 2 });
      const panes = [livePane('pane-1', 'WL-OTHER')];
      seedBudgetLedger(dir, [
        makeBudgetEntry({
          itemId: 'WL-OTHER',
          paneId: 'pane-1',
          heartbeatAt: new Date(T0).toISOString(),
        }),
      ]);

      // Marker-write failure (a claimed-but-unmarked dispatch never spawns).
      const markerFailed = makeDeps({
        getNextImplementCandidate: vi.fn().mockResolvedValue(IMPLEMENT_CANDIDATE),
        recordDispatch: vi.fn().mockResolvedValue(false),
        ...budgetSeams(dir, { instanceId: 'instance-a', livePanes: panes }),
      });
      const markerOutcome = await dispatchDowntimeWork(markerFailed, {
        model: 'plan',
        cwd: INSTANCE_A_ROOT,
      });
      expect(markerOutcome.reason).toBe('claim-rolled-back');
      expect(
        readBudgetLedger(dir)?.entries.some((entry) => entry.itemId === IMPLEMENT_CANDIDATE.id),
      ).toBe(false);

      // Spawn failure (the pane never appeared).
      const spawnFailed = makeDeps({
        getNextImplementCandidate: vi.fn().mockResolvedValue(IMPLEMENT_CANDIDATE),
        spawnAgentPane: vi.fn().mockResolvedValue({ ok: false, error: 'boom' }),
        ...budgetSeams(dir, { instanceId: 'instance-a', livePanes: panes }),
      });
      const spawnOutcome = await dispatchDowntimeWork(spawnFailed, {
        model: 'plan',
        cwd: INSTANCE_A_ROOT,
      });
      expect(spawnOutcome.reason).toBe('spawn-failed');
      expect(
        readBudgetLedger(dir)?.entries.some((entry) => entry.itemId === IMPLEMENT_CANDIDATE.id),
      ).toBe(false);
    });
  });

  it('AC5: pane close / failed claim (the shared release seam) and stale reaping free the slot', () =>
    withMachineDir((dir) => {
      writeCaps(dir, { maxAudit: 1 });
      const auditAdmit = () =>
        admitHostDispatch(
          { kind: 'audit', itemId: 'WL-NEW', instanceId: 'instance-a', root: INSTANCE_A_ROOT },
          { dir, livePanes: [], now: T0, env: CLEAN_ENV },
        );

      // Reserve, then release by item id — exactly what the pane-close handler,
      // the dispatch-failure path and the failed-claim path all call.
      expect(auditAdmit()).toMatchObject({ admitted: true, live: 0, max: 1 });
      expect(auditAdmit()).toMatchObject({
        admitted: false,
        live: 1,
        max: 1,
        reason: HOST_BUDGET_AUDIT_SATURATED_REFUSAL,
      });
      expect(release('WL-NEW', { dir, now: T0, env: CLEAN_ENV })).toMatchObject({ ok: true });
      expect(auditAdmit()).toMatchObject({ admitted: true, live: 0, max: 1 });

      // A killed leader's stale entry is reaped on read and dispatch resumes.
      writeBudgetLedger(dir, [
        makeBudgetEntry({
          kind: 'audit',
          itemId: 'WL-CRASHED',
          heartbeatAt: new Date(T0 - HOST_BUDGET_STALE_WINDOW_MS - HOUR).toISOString(),
        }),
      ]);
      expect(auditAdmit()).toMatchObject({ admitted: true, live: 0, max: 1 });
      expect(readBudgetLedger(dir)?.entries.map((entry) => entry.itemId)).toEqual(['WL-NEW']);
    }));
});

// ── AC6 — user-fired pane AND headless paths ─────────────────────────

describe.each([
  { branch: 'interactive pane', openPane: true },
  { branch: 'headless (open_pane: false)', openPane: false },
])('AC6 — user-fired $branch', ({ openPane }) => {
  /**
   * Replicates `index.ts`: the budget gate runs ONCE inside `route === 'agent'`
   * before the pane/headless split, so both branches consume the same verdict.
   */
  async function dispatch(
    deps: InteractiveAgentDispatchDeps,
    spawn: ReturnType<typeof vi.fn>,
  ): Promise<{ spawned: boolean; openPane: boolean }> {
    const preparation = await prepareInteractiveAgentDispatch(IMPLEMENT_CMD, deps);
    if (!preparation.proceed) return { spawned: false, openPane };
    spawn({ openPane, override: preparation.override });
    return { spawned: true, openPane };
  }

  it('AC6: at cap + cancel ⇒ no claim, no spawn, no ledger entry', async () => {
    await withMachineDir(async (dir) => {
      writeCaps(dir, { maxImplement: 1 });
      seedBudgetLedger(dir, [makeBudgetEntry({ itemId: 'WL-OTHER', paneId: 'pane-1' })]);
      const { deps, confirm, claim } = interactiveDeps(dir, {
        livePanes: makeLivePaneList(['WL-OTHER']),
        confirm: async () => 'cancel',
      });
      const spawn = vi.fn();

      expect(await dispatch(deps, spawn)).toEqual({ spawned: false, openPane });
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(spawn).not.toHaveBeenCalled();
      expect(claim).not.toHaveBeenCalled();
      // The ledger is byte-for-byte the seeded state: no reservation.
      expect(readBudgetLedger(dir)?.entries.map((entry) => entry.itemId)).toEqual(['WL-OTHER']);
    });
  });

  it('AC6: at cap + proceed ⇒ dispatches and records the deliberate user override', async () => {
    await withMachineDir(async (dir) => {
      writeCaps(dir, { maxImplement: 1 });
      seedBudgetLedger(dir, [makeBudgetEntry({ itemId: 'WL-OTHER', paneId: 'pane-1' })]);
      const { deps, claim } = interactiveDeps(dir, {
        livePanes: makeLivePaneList(['WL-OTHER']),
        confirm: async () => 'proceed',
      });
      const spawn = vi.fn();

      expect(await dispatch(deps, spawn)).toEqual({ spawned: true, openPane });
      expect(claim).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledWith({ openPane, override: { by: 'user' } });
      const entry = readBudgetLedger(dir)?.entries.find(
        (candidate) => candidate.itemId === 'WL-0000000000000001',
      );
      expect(entry?.override).toEqual({ by: 'user' });
    });
  });
});

// ── AC7 — overshoot and live/max figures ─────────────────────────────

describe('AC7 — the overshoot figure and the dialog figures are correct', () => {
  it('AC7: at cap ⇒ "over by 1"; already n over ⇒ "over by n+1"; live/max are quoted', () => {
    expect(formatHostBudgetHeadline({ kind: 'implement', live: 2, max: 2 })).toContain(
      '(2 running, max 2) — over by 1.',
    );
    expect(formatHostBudgetHeadline({ kind: 'audit', live: 4, max: 2 })).toContain(
      '(4 running, max 2) — over by 3.',
    );

    const dialog = formatHostBudgetDialog(80, { kind: 'implement', live: 3, max: 2 });
    expect(dialog).toContain('(3 running, max 2) — over by 2.');
  });

  it('AC7: cancel is the state on open, and only an explicit proceed key overrides it', () => {
    const onProceed = vi.fn();
    const onCancel = vi.fn();
    const state = new HostBudgetDialogState(
      { kind: 'implement', live: 2, max: 2 },
      onProceed,
      onCancel,
    );

    expect(state.choice).toBe('cancel');
    expect(state.handleInput('\x1b')).toBe('cancel');
    expect(onCancel).toHaveBeenCalledTimes(1);

    const proceed = new HostBudgetDialogState(
      { kind: 'implement', live: 2, max: 2 },
      vi.fn(),
      vi.fn(),
    );
    expect(proceed.handleInput('y')).toBe('proceed');
  });
});

// ── AC8 — the dispatcher never prompts and never cools down ───────────

describe('AC8 — dispatcher-fired over-quota ticks are neutral skips', () => {
  it('AC8: an over-quota tick spawns nothing, records the reason, and the next tick re-checks', async () => {
    await withMachineDir(async (dir) => {
      writeCaps(dir, { maxImplement: 1 });
      const panes = [livePane('pane-1', 'WL-OTHER')];
      seedBudgetLedger(dir, [
        makeBudgetEntry({ itemId: 'WL-OTHER', paneId: 'pane-1', heartbeatAt: new Date(T0).toISOString() }),
      ]);
      const recordDecision = vi.fn().mockResolvedValue(undefined);

      vi.useFakeTimers();
      vi.setSystemTime(T0);

      const { worker, deps } = makeWorkerInstance({
        dir,
        cwd: INSTANCE_A_ROOT,
        instanceId: 'instance-a',
        livePanes: panes,
        candidate: IMPLEMENT_CANDIDATE,
        recordDecision,
      });

      // The refusal is a neutral skip: no prompt (there is no confirm seam on
      // the dispatcher path), no spawn, and the budget reason is logged.
      await worker.tick();
      await flushDecisionLog();
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
      expect(
        recordDecision.mock.calls.some(
          ([entry]) => (entry as { reason?: string }).reason === HOST_BUDGET_IMPLEMENT_REFUSAL,
        ),
      ).toBe(true);

      // No cooldown was entered: freeing the slot lets the VERY NEXT tick
      // dispatch (a `no-candidate` cooldown would have suppressed it).
      release('WL-OTHER', { dir, now: T0, env: CLEAN_ENV });
      await worker.tick();
      expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    });
  });
});

// ── AC9 — corrupt ledger in both fail directions ─────────────────────

describe('AC9 — a corrupt ledger fails closed for the dispatcher, open for a human', () => {
  it('AC9: the dispatcher refuses with host-budget-unknown and rewrites the ledger from live panes', async () => {
    await withMachineDir(async (dir) => {
      writeCaps(dir, { maxImplement: 2 });
      writeRawBudgetLedger(dir, '{ this is not json');
      const panes = [livePane('pane-1', 'WL-LIVE')];

      const deps = makeDeps({
        getNextImplementCandidate: vi.fn().mockResolvedValue(IMPLEMENT_CANDIDATE),
        ...budgetSeams(dir, { instanceId: 'instance-a', livePanes: panes }),
      });

      const refused = await dispatchDowntimeWork(deps, { model: 'plan', cwd: INSTANCE_A_ROOT });
      expect(refused).toMatchObject({
        dispatched: false,
        reason: HOST_BUDGET_UNKNOWN_REFUSAL,
      });
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();

      // Self-healing: the unreadable document is rewritten from the live pane
      // list, so a later tick can dispatch normally.
      const repaired = readBudgetLedger(dir);
      expect(repaired).not.toBeNull();
      expect(repaired?.entries.map((entry) => entry.itemId)).toEqual(['WL-LIVE']);

      const healed = await dispatchDowntimeWork(deps, { model: 'plan', cwd: INSTANCE_A_ROOT });
      expect(healed.dispatched).toBe(true);
    });
  });

  it('AC9: the interactive path fails OPEN with a visible notice and still claims', async () => {
    await withMachineDir(async (dir) => {
      writeCaps(dir, { maxImplement: 2 });
      writeRawBudgetLedger(dir, '{ this is not json');
      const { deps, notify, claim } = interactiveDeps(dir);

      const result = await prepareInteractiveAgentDispatch(IMPLEMENT_CMD, deps);
      expect(result).toMatchObject({
        proceed: true,
        reserved: false,
        notice: HOST_BUDGET_UNREADABLE_NOTICE,
      });
      expect(notify).toHaveBeenCalledWith(HOST_BUDGET_UNREADABLE_NOTICE);
      expect(claim).toHaveBeenCalledTimes(1);
      // The corrupt document is never rewritten by the interactive path.
      expect(readBudgetLedger(dir)).toBeNull();
    });
  });
});

// ── AC10 — observability convergence ─────────────────────────────────

describe('AC10 — the four observability surfaces quote one ledger state', () => {
  it('AC10: decision log, header token, stderr line and worklist counter agree', async () => {
    await withMachineDir(async (dir) => {
      writeCaps(dir, { maxImplement: 2, maxAudit: 1 });
      const panes = [livePane('pane-1', 'WL-IMP-1'), livePane('pane-2', 'WL-IMP-2')];
      writeBudgetLedger(dir, [
        makeBudgetEntry({ kind: 'implement', itemId: 'WL-IMP-1', paneId: 'pane-1', heartbeatAt: new Date(T0).toISOString() }),
        makeBudgetEntry({ kind: 'implement', itemId: 'WL-IMP-2', paneId: 'pane-2', heartbeatAt: new Date(T0).toISOString() }),
        makeBudgetEntry({ kind: 'audit', itemId: 'WL-AUD-1', paneId: 'pane-3', heartbeatAt: new Date(T0).toISOString() }),
      ]);
      const recordDecision = vi.fn().mockResolvedValue(undefined);
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      try {
        vi.useFakeTimers();
        vi.setSystemTime(T0);
        const { worker, deps } = makeWorkerInstance({
          dir,
          cwd: INSTANCE_A_ROOT,
          instanceId: 'instance-a',
          livePanes: panes,
          candidate: IMPLEMENT_CANDIDATE,
          recordDecision,
        });

        await worker.tick();
        await flushDecisionLog();
        expect(deps.spawnAgentPane).not.toHaveBeenCalled();

        // Surface 1: the decision log entry carries the refusal and evidence.
        const entry = recordDecision.mock.calls
          .map((call) => call[0] as { reason?: string; budget?: { live: number; max: number } })
          .find((candidate) => candidate.reason === HOST_BUDGET_IMPLEMENT_REFUSAL);
        expect(entry?.budget).toEqual({ live: 2, max: 2 });

        // Surface 2: the header token.
        expect(decisionHeaderToken(entry?.reason as string)).toBe('budget-implement');

        // Surface 3: the stderr skip line the worker actually wrote quotes
        // the same figures.
        const skipLine = hostBudgetSkipLine(entry?.reason as string, entry?.budget);
        expect(skipLine).toBe(
          '[worklog-plugin] Downtime implement tier skipped: host-budget-implement (live=2, max=2)',
        );
        expect(stderrSpy).toHaveBeenCalledWith(`${skipLine}\n`);

        // Surface 4: the worklist counter, from the ONE read-only reader.
        const status = readHostBudgetStatus({ dir, livePanes: panes, now: T0, env: CLEAN_ENV });
        expect(status).toEqual({
          implement: { live: 2, max: 2 },
          audit: { live: 1, max: 1 },
        });
        expect(hostBudgetStatusText(status)).toBe('[budget: implement 2/2 · audit 1/1]');
      } finally {
        stderrSpy.mockRestore();
      }
    });
  });
});

// ── AC11 — unresolvable coordination dir degrades as today ────────────

describe('AC11 — an unresolvable coordination dir changes nothing', () => {
  it('AC11: admission admits, the interactive path proceeds silently, and no counter renders', async () => {
    // No machine dir ⇒ no ledger, no new failure mode: implement and audit are
    // admitted, exactly as before the epic.
    expect(
      admitHostDispatch(
        { kind: 'implement', itemId: 'WL-A', instanceId: 'instance-a', root: INSTANCE_A_ROOT },
        { dir: null, livePanes: [], env: CLEAN_ENV },
      ),
    ).toEqual({ admitted: true, live: 0, max: 2 });
    expect(
      admitHostDispatch(
        { kind: 'audit', itemId: 'WL-B', instanceId: 'instance-a', root: INSTANCE_A_ROOT },
        { dir: null, livePanes: [], env: CLEAN_ENV },
      ),
    ).toEqual({ admitted: true, live: 0, max: 1 });

    // The human path proceeds with no prompt, no notice and no reservation.
    const { deps, confirm, notify, claim } = interactiveDeps(null);
    const result = await prepareInteractiveAgentDispatch(IMPLEMENT_CMD, deps);
    expect(result).toMatchObject({ proceed: true, reserved: false });
    expect(result.notice).toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(claim).toHaveBeenCalledTimes(1);

    // The worklist adds no chrome (no counter) when the budget is unavailable.
    expect(readHostBudgetStatus({ dir: null, env: CLEAN_ENV })).toBeNull();
    expect(hostBudgetStatusText(null)).toBeNull();
  });
});
