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

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  admitHostDispatch,
  confirmHostDispatch,
  HOST_BUDGET_AUDIT_REFUSAL,
  HOST_BUDGET_AUDIT_SATURATED_REFUSAL,
  HOST_BUDGET_CORRUPT_REFUSAL,
  HOST_BUDGET_IMPLEMENT_REFUSAL,
  HOST_BUDGET_UNKNOWN_REFUSAL,
  readAuditBudgetState,
  type AuditBudgetLogEvent,
} from './host-dispatch-budget.admission.js';
import {
  AUDIT_BUDGET_SATURATED_REASON,
  AUDIT_BUDGET_UNKNOWN_REASON,
} from './downtime-worker.audit-availability.contract.js';
import { repairBudgetLedgerFromPanes } from './host-dispatch-budget.repair.js';
import type { AuditAvailabilityOutcome } from './downtime-worker.audit-availability.js';
import type { AuditLeaseAcquireOutcome } from './downtime-worker.audit-lease.js';
import { auditLeaseSessionId } from './downtime-worker.audit-lease.js';

/** A held proxy-lease acquire outcome for the admission-admitting cases. */
const LEASE_OK = (itemId: string): AuditLeaseAcquireOutcome => ({
  status: 'ok',
  lease: { sessionId: `herdr-audit-${itemId}` },
});
import { AUDIT_BUDGET_DIVERGENCE_REASON } from './downtime-log-budget.js';
import { readCoordinationLogEntries } from './downtime-log.js';
import {
  HOST_BUDGET_CONFIG_FILE,
  HOST_BUDGET_STALE_WINDOW_MS,
  budgetConfigPath,
  clampHostBudget,
  computeOverQuota,
  liveCount,
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
  type FakeBudgetEntry,
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
import { createDowntimeDeps } from './index.js';

/** Deterministic clock: 2026-11-03T12:00:00.000Z. */
const T0 = Date.parse('2026-11-03T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const CLEAN_ENV: Readonly<Record<string, string | undefined>> = {};
/**
 * The one-release legacy audit env (WL-0MWAMSK9H005BOHD AC3): the AC3/AC4/AC5
 * audit cases below pin the PRE-CHANGE `budget.json` + local-ledger decision,
 * which is now reached only through this flag.
 */
const LEGACY_AUDIT_ENV: Readonly<Record<string, string | undefined>> = {
  HERDR_AUDIT_LOCAL_BUDGET: '1',
};

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

/**
 * A live pane owned by `itemId` (the dispatcher's pane-title convention, which
 * names the tier — the in-flight counting rule reads it, WL-0MWFJDD8R005F5BV).
 */
function livePane(
  paneId: string,
  itemId: string,
  kind: 'implement' | 'audit' = 'implement',
): HostBudgetLivePane {
  return { paneId, title: `Downtime triggered ${kind} - ${itemId}` };
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
    env?: Readonly<Record<string, string | undefined>>;
    auditAvailability?: AuditAvailabilityOutcome;
    auditLease?: AuditLeaseAcquireOutcome;
    onAuditBudgetEvent?: (event: AuditBudgetLogEvent) => void;
  } = {},
): Pick<DowntimeWorkerDeps, 'admitHostDispatch' | 'confirmHostDispatch' | 'releaseHostDispatch'> {
  const now = opts.now ?? T0;
  const livePanes = opts.livePanes ?? [];
  const instanceId = opts.instanceId ?? 'instance-a';
  const env = opts.env ?? CLEAN_ENV;
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
          {
            dir,
            livePanes,
            now,
            env,
            ...(opts.auditAvailability !== undefined
              ? { auditAvailability: opts.auditAvailability }
              : {}),
            ...(opts.auditLease !== undefined ? { auditLease: opts.auditLease } : {}),
            ...(opts.onAuditBudgetEvent !== undefined
              ? { onAuditBudgetEvent: opts.onAuditBudgetEvent }
              : {}),
          },
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
    releaseHostDispatch: vi.fn(
      async (itemId: string, _cwd: string, identity?: { kind?: string; paneId?: string; attemptId?: string }) => {
        release(
          {
            itemId,
            ...(identity?.kind === 'implement' || identity?.kind === 'audit'
              ? { kind: identity.kind }
              : {}),
            ...(identity?.paneId !== undefined ? { paneId: identity.paneId } : {}),
            ...(identity?.attemptId !== undefined ? { attemptId: identity.attemptId } : {}),
          },
          { dir, now, env: CLEAN_ENV },
        );
      },
    ),
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
    // The tick's budget-reconcile pass reads the trusted pane list
    // (WL-0MWFJDEY5002FBRE). Resolved lazily so a test that pushes a freshly
    // confirmed pane is describing the same world the ledger holds.
    getRunningDowntimePanes: vi.fn(async () => ({
      ok: true,
      count: opts.livePanes.length,
      paneIds: opts.livePanes.map((pane) => pane.paneId),
      records: opts.livePanes.map((pane) => ({
        paneId: pane.paneId,
        ...(pane.title !== undefined ? { label: pane.title } : {}),
      })),
    })),
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
      readLivePanes: async () =>
        opts.livePanes === undefined
          ? { ok: false as const }
          : { ok: true as const, panes: opts.livePanes },
      root: INSTANCE_A_ROOT,
      instanceId: 'instance-a',
      budget: { dir, now: opts.now ?? T0, env: CLEAN_ENV },
    },
  };
}

/**
 * The stored attempt token for one entry — the identity a release must prove
 * (WL-0MWFJD5T4003OM91). Throws when the test's reservation is missing, so a
 * silently-absent entry can never make a release assertion vacuous.
 */
function attemptOf(
  dir: string,
  itemId: string,
  kind: 'implement' | 'audit' = 'implement',
): string {
  const read = readBudget({ dir, now: T0, env: CLEAN_ENV });
  const entry = read.ok
    ? read.ledger.entries.find(
        (candidate) => candidate.itemId === itemId && candidate.kind === kind,
      )
    : undefined;
  if (entry?.attemptId === undefined) {
    throw new Error(`no attemptId stored for ${kind}:${itemId}`);
  }
  return entry.attemptId;
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

      // Release is keyed by the reserved attempt's identity and idempotent —
      // the one seam every pane-close / dispatch-failure / failed-claim path
      // calls (AC5, WL-0MWFJD5T4003OM91).
      const identity = {
        itemId: 'WL-1',
        kind: 'implement' as const,
        attemptId: attemptOf(dir, 'WL-1'),
      };
      expect(release(identity, { dir, now: T0, env: CLEAN_ENV })).toMatchObject({
        ok: true,
        removed: true,
      });
      expect(release(identity, { dir, now: T0, env: CLEAN_ENV })).toMatchObject({
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
        ...budgetSeams(dir, { instanceId: 'instance-a', livePanes: [], env: LEGACY_AUDIT_ENV }),
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
      release(
        { itemId: 'WL-AUD', kind: 'audit', attemptId: attemptOf(dir, 'WL-AUD', 'audit') },
        { dir, now: T0, env: CLEAN_ENV },
      );
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
          ...budgetSeams(dir, { instanceId: 'instance-a', livePanes: [], env: LEGACY_AUDIT_ENV }),
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
        ...budgetSeams(dir, { instanceId: 'instance-a', livePanes: [], env: LEGACY_AUDIT_ENV }),
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
          { dir, livePanes: [], now: T0, env: LEGACY_AUDIT_ENV },
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
      expect(
        release(
          { itemId: 'WL-NEW', kind: 'audit', attemptId: attemptOf(dir, 'WL-NEW', 'audit') },
          { dir, now: T0, env: CLEAN_ENV },
        ),
      ).toMatchObject({ ok: true });
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
      // The seeded entry's identity is its pane (it was written raw, so it
      // carries no attempt token).
      release(
        { itemId: 'WL-OTHER', kind: 'implement', paneId: 'pane-1' },
        { dir, now: T0, env: CLEAN_ENV },
      );
      // The pane has closed too, so the union count no longer sees it
      // (WL-0MWFJDD8R005F5BV).
      panes.length = 0;
      await worker.tick();
      expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    });
  });
});

// ── AC9 — corrupt ledger in both fail directions ─────────────────────

describe('AC9 — a corrupt ledger fails closed for the dispatcher, open for a human', () => {
  it('AC9 (WL-0MWFJD8ZO000J1R8): the dispatcher refuses with host-budget-corrupt and NEVER rewrites the ledger', async () => {
    await withMachineDir(async (dir) => {
      writeCaps(dir, { maxImplement: 2 });
      const corrupt = '{ this is not json';
      writeRawBudgetLedger(dir, corrupt);
      const panes = [livePane('pane-1', 'WL-LIVE')];

      const deps = makeDeps({
        getNextImplementCandidate: vi.fn().mockResolvedValue(IMPLEMENT_CANDIDATE),
        // The tick's budget-reconcile pass reads the trusted pane list: the
        // worker tests must describe the same world the ledger seeding does
        // (WL-0MWFJDEY5002FBRE).
        getRunningDowntimePanes: vi.fn().mockResolvedValue({
          ok: true,
          count: panes.length,
          paneIds: panes.map((pane) => pane.paneId),
          records: panes.map((pane) => ({
            paneId: pane.paneId,
            ...(pane.title !== undefined ? { label: pane.title } : {}),
          })),
        }),
        ...budgetSeams(dir, { instanceId: 'instance-a', livePanes: panes }),
      });

      const refused = await dispatchDowntimeWork(deps, { model: 'plan', cwd: INSTANCE_A_ROOT });
      expect(refused).toMatchObject({
        dispatched: false,
        // The decision log names the corruption, not a generic unknown.
        reason: HOST_BUDGET_CORRUPT_REFUSAL,
      });
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
      // No self-heal: an admission read must leave the bytes alone.
      expect(readFileSync(budgetLedgerPath(dir), 'utf8')).toBe(corrupt);

      // The EXPLICIT operator repair is the recovery path.
      const repaired = repairBudgetLedgerFromPanes(panes, {
        instanceId: 'operator',
        root: INSTANCE_A_ROOT,
      });
      expect(repaired.ok).toBe(true);

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
      // All three panes are live, so every surface (including the pane-aware
      // audit display) quotes the same ledger state.
      const panes = [
        livePane('pane-1', 'WL-IMP-1'),
        livePane('pane-2', 'WL-IMP-2'),
        livePane('pane-3', 'WL-AUD-1', 'audit'),
      ];
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
        { dir: null, livePanes: [], env: LEGACY_AUDIT_ENV },
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

// ── Proxy-derived audit admission (WL-0MWAMSK9H005BOHD) ──────────────
//
// End-to-end proof through the real dispatch pipeline + REAL admission reader:
// the proxy's audit verdict decides (never the per-host cap), the local ledger
// is observability only, and a divergence is logged with both sides' evidence.
describe('proxy-derived audit admission (WL-0MWAMSK9H005BOHD)', () => {
  it('the proxy decides end to end: a saturated proxy refuses despite a permissive local cap', async () => {
    await withMachineDir(async (dir) => {
      // Deliberately permissive local cap: if the local ledger decided, the
      // (empty-ledger) audit would be admitted.
      writeCaps(dir, { maxAudit: 5 });
      const deps = makeDeps({
        getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: AUDIT_CANDIDATE }),
        ...budgetSeams(dir, {
          instanceId: 'instance-a',
          livePanes: [],
          auditAvailability: {
            status: 'ok',
            availability: { cap: 5, live: 5, available: false },
          },
        }),
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: INSTANCE_A_ROOT });
      expect(outcome).toMatchObject({
        dispatched: false,
        reason: AUDIT_BUDGET_SATURATED_REASON,
        budget: { live: 5, max: 5 },
      });
      // The proxy's vocabulary, never the legacy local token (parent AC2).
      expect(outcome.reason).not.toBe(HOST_BUDGET_AUDIT_SATURATED_REFUSAL);
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
      // A refusal reserves nothing locally.
      expect(readBudgetLedger(dir)).toBeNull();
    });
  });

  it('a proxy admission beats a local ledger at its cap (an audit entry alone can never refuse)', async () => {
    await withMachineDir(async (dir) => {
      writeCaps(dir, { maxAudit: 1 });
      // The local ledger is already at its cap — observability only.
      writeBudgetLedger(dir, [
        makeBudgetEntry({
          kind: 'audit',
          itemId: 'WL-LOCAL',
          heartbeatAt: new Date(T0).toISOString(),
        }),
      ]);
      const deps = makeDeps({
        getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: AUDIT_CANDIDATE }),
        ...budgetSeams(dir, {
          instanceId: 'instance-a',
          livePanes: [],
          auditAvailability: {
            status: 'ok',
            availability: { cap: 1, live: 0, available: true },
          },
          // The lease is THE admission gate (WL-0MWFJH3NW006F5GN AC2): this
          // end-to-end case holds one so the proxy admission proceeds.
          auditLease: LEASE_OK(AUDIT_CANDIDATE.id),
        }),
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: INSTANCE_A_ROOT });
      expect(outcome.dispatched).toBe(true);
      expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
      // The admitted audit is still reserved so the header/release paths work.
      expect(readBudgetLedger(dir)?.entries.map((entry) => entry.itemId).sort()).toEqual([
        'WL-AUD',
        'WL-LOCAL',
      ]);
    });
  });

  it('an unreachable proxy fails closed end to end as audit-budget-unknown', async () => {
    await withMachineDir(async (dir) => {
      writeCaps(dir, { maxAudit: 5 });
      const deps = makeDeps({
        getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: AUDIT_CANDIDATE }),
        ...budgetSeams(dir, {
          instanceId: 'instance-a',
          livePanes: [],
          auditAvailability: { status: 'unreachable', reason: 'timeout' },
        }),
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: INSTANCE_A_ROOT });
      expect(outcome).toMatchObject({ dispatched: false, reason: AUDIT_BUDGET_UNKNOWN_REASON });
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    });
  });

  it('a divergence during a dispatch writes exactly one decision entry with both sides’ evidence', async () => {
    await withMachineDir(async (dir) => {
      writeCaps(dir, { maxAudit: 1 });
      writeBudgetLedger(dir, [
        makeBudgetEntry({
          kind: 'audit',
          itemId: 'WL-LOCAL',
          heartbeatAt: new Date(T0).toISOString(),
        }),
      ]);
      const events: AuditBudgetLogEvent[] = [];
      const deps = makeDeps({
        getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: AUDIT_CANDIDATE }),
        ...budgetSeams(dir, {
          instanceId: 'instance-a',
          livePanes: [],
          auditAvailability: {
            status: 'ok',
            availability: { cap: 1, live: 0, available: true },
          },
          onAuditBudgetEvent: (event) => events.push(event),
          // The lease is THE admission gate (WL-0MWFJH3NW006F5GN AC2): this
          // divergence case holds one so the proxy admission proceeds.
          auditLease: LEASE_OK(AUDIT_CANDIDATE.id),
        }),
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: INSTANCE_A_ROOT });
      expect(outcome.dispatched).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event: 'divergence',
        divergence: {
          proxy: { live: 0, cap: 1, available: true },
          local: { live: 1, maxAudit: 1 },
        },
      });
    });
  });
});

// ── Pre-check / admission agreement (WL-0MWAMSK9H005BOHD AC2) ─────────
describe('audit pre-check and admission agree (WL-0MWAMSK9H005BOHD AC2)', () => {
  it('the REAL getActiveAudit and admitHostDispatch give the same answer and refusal token', async () => {
    await withMachineDir(async (dir) => {
      writeCaps(dir, { maxAudit: 5 });
      // The real production pre-check; only the availability seam is injected.
      const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'dispatcher');

      const states: AuditAvailabilityOutcome[] = [
        { status: 'ok', availability: { cap: 5, live: 0, available: true } },
        { status: 'ok', availability: { cap: 5, live: 5, available: false } },
        { status: 'unreachable', reason: 'timeout' },
        { status: 'endpoint-absent', reason: 'http-404' },
      ];

      for (const availability of states) {
        deps.readAuditAvailability = async () => availability;
        const preCheck = await deps.getActiveAudit(INSTANCE_A_ROOT);
        const admission = admitHostDispatch(
          { kind: 'audit', itemId: 'WL-AGREE', instanceId: 'instance-a', root: INSTANCE_A_ROOT },
          {
            dir,
            livePanes: [],
            now: T0,
            env: CLEAN_ENV,
            auditAvailability: availability,
            // Lease gate (WL-0MWFJH3NW006F5GN AC2): a held lease accompanies an
            // admitting pre-check so the agreement assertion stays about the
            // availability path; a refused availability never reaches it.
            auditLease:
              availability.status === 'ok' && availability.availability.available
                ? LEASE_OK('WL-AGREE')
                : undefined,
          },
        );

        expect(preCheck.ok).toBe(true);
        if (!preCheck.ok) continue;
        // `getActiveAudit.active` refuses; admission `admitted` admits.
        expect(admission.admitted).toBe(!preCheck.active);
        if (preCheck.active) {
          expect(admission.reason).toBe(preCheck.reason);
          // The same proxy figures ride on both sides.
          expect(admission.live).toBe(preCheck.budget?.live ?? 0);
          expect(admission.max).toBe(preCheck.budget?.max ?? 0);
        }
      }
    });
  });
});

describe('audit divergence logged by the real pre-check (WL-0MWAMSK9H005BOHD AC2)', () => {
  it('records the INVERSE divergence (proxy refuses, local below cap) exactly once', async () => {
    await withMachineDir(async (dir) => {
      writeCaps(dir, { maxAudit: 5 });
      // The worklog root IS the temp dir, so the real coordination-log append
      // lands somewhere observable.
      const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'dispatcher');
      deps.readAuditAvailability = async () => ({
        status: 'ok',
        availability: { cap: 5, live: 5, available: false },
      });

      const preCheck = await deps.getActiveAudit(dir);
      expect(preCheck).toMatchObject({
        ok: true,
        active: true,
        source: 'proxy',
        reason: AUDIT_BUDGET_SATURATED_REASON,
        budget: { live: 5, max: 5 },
      });

      // The append is fire-and-forget — wait for the file to carry it.
      await vi.waitFor(async () => {
        const entries = await readCoordinationLogEntries(dir);
        const divergences = entries.filter(
          (entry) => entry.reason === AUDIT_BUDGET_DIVERGENCE_REASON,
        );
        expect(divergences).toHaveLength(1);
        expect(divergences[0].auditBudget).toEqual({
          proxy: { live: 5, cap: 5, available: false },
          local: { live: 0, maxAudit: 5 },
        });
      });
    });
  });
});

// ── Proxy audit-LEASE release at pane close (WL-0MWFJH3NW006F5GN AC3) ──

describe('audit lease released at audit pane close (WL-0MWFJH3NW006F5GN AC3)', () => {
  it('the real recordPaneClose seam releases the proxy lease for a closed audit pane', async () => {
    await withMachineDir(async (dir) => {
      const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'dispatcher');
      const released: string[] = [];
      deps.auditLeaseClient = {
        acquire: async () => ({ status: 'ok', lease: { sessionId: 'x', expiresAt: 0 } }),
        renew: async () => ({ status: 'ok', lease: { sessionId: 'x', expiresAt: 0 } }),
        release: vi.fn(async (sessionId: string) => {
          released.push(sessionId);
          return { status: 'ok' } as const;
        }),
      } as unknown as NonNullable<DowntimeWorkerDeps['auditLeaseClient']>;

      // An AUDIT pane closing is the terminal path of an admitted audit: the
      // shared GPU must be given back, re-deriving the session id from the
      // item (nothing threaded).
      await deps.recordPaneClose(
        { itemId: 'WL-CLOSED', kind: 'audit', paneId: 'w9:p9' },
        dir,
      );
      expect(released).toEqual([auditLeaseSessionId('WL-CLOSED')]);

      // A NON-audit pane close never touches the lease.
      await deps.recordPaneClose(
        { itemId: 'WL-CLOSED', kind: 'implement', paneId: 'w9:p9' },
        dir,
      );
      expect(released).toEqual([auditLeaseSessionId('WL-CLOSED')]);
    });
  });

  it('an unwired lease client is a non-event (the pane-close record still lands)', async () => {
    await withMachineDir(async (dir) => {
      const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'dispatcher');
      deps.auditLeaseClient = undefined;
      // The close path runs to completion with no lease client and no throw.
      await expect(
        deps.recordPaneClose({ itemId: 'WL-C', kind: 'audit', paneId: 'p:1' }, dir),
      ).resolves.toBeUndefined();
    });
  });
});

// ── WL-0MW9VQ08W000SN63 — pane-derived freshness for stale-but-live
// ── implement entries (the >2 h under-count fix) ───────────────────────

describe('pane-derived freshness: stale-but-live implement entries (WL-0MW9VQ08W000SN63)', () => {
  /** An implement ledger entry heartbeated `ageMs` before T0. */
  function implementEntry(itemId: string, paneId: string, ageMs: number): FakeBudgetEntry {
    return makeBudgetEntry({
      kind: 'implement',
      itemId,
      paneId,
      heartbeatAt: new Date(T0 - ageMs).toISOString(),
    });
  }

  it('AC4: admission (liveCount) and display (readHostBudgetStatus) agree on stale-but-live entries', async () => {
    await withMachineDir((dir) => {
      writeCaps(dir, { maxImplement: 8, maxAudit: 1 });
      const panes = Array.from({ length: 4 }, (_, i) => livePane(`pane-${i + 1}`, `WL-IMP-${i + 1}`));
      writeBudgetLedger(dir, [
        // One fresh entry and three stale-but-live entries (5 h old heartbeats).
        implementEntry('WL-IMP-1', 'pane-1', HOUR),
        implementEntry('WL-IMP-2', 'pane-2', 5 * HOUR),
        implementEntry('WL-IMP-3', 'pane-3', 5 * HOUR),
        implementEntry('WL-IMP-4', 'pane-4', 5 * HOUR),
      ]);

      // One shared rule: the admission read and the display reader count the
      // same 4 — the stale-but-live three must NOT be silently dropped.
      const admission = liveCount('implement', panes, { dir, now: T0, env: CLEAN_ENV });
      expect(admission.ok).toBe(true);
      if (!admission.ok) return;
      expect(admission.count).toBe(4);

      const display = readHostBudgetStatus({ dir, livePanes: panes, now: T0, env: CLEAN_ENV });
      expect(display?.implement.live).toBe(4);
      expect(hostBudgetStatusText(display)).toBe('[budget: implement 4/8 · audit 0/1]');
    });
  });

  it('AC6: 3 fresh + 5 stale-but-live implement panes → counter reads 8, not 3 (regression)', async () => {
    await withMachineDir((dir) => {
      writeCaps(dir, { maxImplement: 8, maxAudit: 1 });
      const panes = Array.from({ length: 8 }, (_, i) => livePane(`pane-${i + 1}`, `WL-IMP-${i + 1}`));
      writeBudgetLedger(dir, [
        // 3 fresh entries (1 h old) …
        ...panes.slice(0, 3).map((pane, i) => implementEntry(`WL-IMP-${i + 1}`, pane.paneId, HOUR)),
        // … and 5 panes heartbeated 5 h ago whose panes are still live.
        ...panes.slice(3).map((pane, i) =>
          implementEntry(`WL-IMP-${i + 4}`, pane.paneId, 5 * HOUR),
        ),
      ]);

      // The observed scenario: every stale-but-live pane was dropped from the
      // counter (reading 3); pane-derived freshness must count all 8.
      const display = readHostBudgetStatus({ dir, livePanes: panes, now: T0, env: CLEAN_ENV });
      expect(display?.implement.live).toBe(8);
      expect(hostBudgetStatusText(display)).toBe('[budget: implement 8/8 · audit 0/1]');

      // Admission agrees: at 8/8 the host is saturated — a ninth implement is
      // refused with 8/8 evidence (no silent over-admission).
      const ninth = admitHostDispatch(
        { kind: 'implement', itemId: 'WL-IMP-9', instanceId: 'instance-a', root: INSTANCE_A_ROOT },
        { dir, livePanes: panes, now: T0, env: CLEAN_ENV },
      );
      expect(ninth).toEqual({
        admitted: false,
        live: 8,
        max: 8,
        reason: HOST_BUDGET_IMPLEMENT_REFUSAL,
      });
    });
  });

  it('AC5: stale + pane-not-live implement entries are still reaped/uncounted', async () => {
    await withMachineDir((dir) => {
      writeCaps(dir, { maxImplement: 8, maxAudit: 1 });
      // Panes 1–2 live (one fresh, one stale-but-live); pane-3 is closed.
      const panes = [livePane('pane-1', 'WL-IMP-1'), livePane('pane-2', 'WL-IMP-2')];
      writeBudgetLedger(dir, [
        implementEntry('WL-IMP-1', 'pane-1', HOUR),
        implementEntry('WL-IMP-2', 'pane-2', 5 * HOUR),
        implementEntry('WL-IMP-3', 'pane-3', 5 * HOUR), // stale + pane gone
      ]);

      const display = readHostBudgetStatus({ dir, livePanes: panes, now: T0, env: CLEAN_ENV });
      expect(display?.implement.live).toBe(2);

      // The stale, pane-less entry is reaped by the admission read, exactly as
      // before the fix — best-effort cleanup of a crashed/closed pane.
      const admission = liveCount('implement', panes, { dir, now: T0, env: CLEAN_ENV });
      expect(admission.ok).toBe(true);
      if (!admission.ok) return;
      expect(admission.count).toBe(2);
      expect(readBudgetLedger(dir)?.entries.map((entry) => entry.itemId)).toEqual([
        'WL-IMP-1',
        'WL-IMP-2',
      ]);
    });
  });
});
