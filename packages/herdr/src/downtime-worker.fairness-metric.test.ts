/**
 * packages/herdr/src/downtime-worker.fairness-metric.test.ts — the per-project
 * fairness metric recorded on every dispatch decision.
 *
 * Parent: WL-0MWKE9VF800101V9 (dispatcher seems to unevenly distribute work).
 * Work item: WL-0MWKY141H002LULI (record a per-project fairness metric on
 * dispatch decisions, parent AC3).
 *
 * Pins the additive decision-log schema and its producers:
 *
 *  1. a successful dispatch records `selectedRoot`, `dispatchingRoot`,
 *     `consecutiveRunLength` and `outcome: 'dispatched'`;
 *  2. a `no-dispatch` decision records `selectedRoot` + `outcome: 'no-dispatch'`
 *     and NO `dispatchingRoot`;
 *  3. the run length is recorded to (and read from) the machine-scoped run
 *     ledger (leadership-independent, the fix for WL-0MWT3Z9M9002Z9BF) and
 *     increments/resets across ticks;
 *  4. a registered-root SWEEP dispatch records the same evidence as an
 *     offer-path dispatch;
 *  5. an auditor can reconstruct a multi-tick per-root distribution from the
 *     decision log alone;
 *  6. an unreadable run-length source degrades to `1` and the dispatch still
 *     happens (fail-open);
 *  7. the on-disk `downtime-round-robin-by-root.json` format is unchanged (the
 *     run state lives in a SEPARATE `downtime-run-by-root.json` record).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createDowntimeWorker,
  createDowntimePoller,
  dispatchFromCoordination,
  type DowntimeHerdrItem,
  type DowntimeItemInfo,
  type DowntimeWorkerDeps,
} from './downtime-worker.js';
import {
  appendCoordinationLogEntry,
  readCoordinationLogEntries,
  type CoordinationLogEntry,
} from './downtime-log-coordination.js';
import {
  dispatchDecisionFairness,
} from './downtime-worker.fairness.js';
import {
  RUN_LEDGER_FILE_NAME,
  readCurrentDispatchRun,
  writeDispatchRunLocked,
} from './downtime-run-ledger.js';
import {
  recordDecision,
  type OrchestratorContext,
} from './downtime-worker.orchestrator-dispatch.js';
import {
  ROUND_ROBIN_BY_ROOT_FILE_NAME,
  type RoundRobinByRootData,
} from './downtime-round-robin-by-root.js';
import {
  withCoordLock,
  writeCoordinationFile,
  type CoordinationEntry,
} from './coordination.js';

// ── Fixtures ──────────────────────────────────────────────────────────

let root: string;
let coordinationDir: string;
let leaderCwd: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'herdr-fairness-metric-'));
  coordinationDir = join(root, 'coord');
  leaderCwd = join(root, 'leader');
  mkdirSync(coordinationDir, { recursive: true });
  mkdirSync(join(leaderCwd, '.worklog'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function itemInfo(overrides: Partial<DowntimeItemInfo> & { id: string }): DowntimeItemInfo {
  return {
    id: overrides.id,
    title: overrides.title ?? `Item ${overrides.id}`,
    status: overrides.status ?? 'open',
    stage: overrides.stage ?? 'idea',
    priority: overrides.priority,
    risk: overrides.risk,
    effort: overrides.effort,
    auditedAt: overrides.auditedAt,
    updatedAt: overrides.updatedAt,
    sortIndex: overrides.sortIndex,
    needsProducerReview: overrides.needsProducerReview,
    assignee: overrides.assignee,
    deletedBy: overrides.deletedBy,
  };
}

/** A dispatchable prep (`plan`) candidate. */
function planItem(id: string): DowntimeItemInfo {
  return itemInfo({ id, status: 'open', stage: 'intake_complete' });
}

/** One v1-shape offer entry pinned to a worklog root. */
function makeEntry(instanceId: string, workItemId: string, worklogRoot: string): CoordinationEntry {
  const at = new Date().toISOString();
  return {
    instanceId,
    workItemId,
    directory: worklogRoot,
    worklogRoot,
    assignedAt: at,
    lastUpdated: at,
  };
}

/** Seed a run the way the production charge does (under the coordination lock). */
function seedDispatchRun(runRoot: string, now: number): void {
  const written = withCoordLock(coordinationDir, () =>
    writeDispatchRunLocked(coordinationDir, runRoot, now),
  );
  if (written === null) throw new Error('coordination lock unavailable in test');
}

/** Seed the round-robin cursor file. */
function seedCursor(data: RoundRobinByRootData): void {
  writeFileSync(join(coordinationDir, ROUND_ROBIN_BY_ROOT_FILE_NAME), JSON.stringify(data), 'utf-8');
}

function makeDeps(overrides: Partial<DowntimeWorkerDeps> = {}): DowntimeWorkerDeps {
  return {
    getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    getAuditCandidateScope: vi.fn().mockResolvedValue({ ok: true, scope: 'parent' }),
    getNextImplementCandidate: vi.fn().mockResolvedValue(null),
    getNextCriticalCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [] }),
    fetchItem: vi.fn().mockResolvedValue({ ok: true, info: planItem('WL-X') }),
    claimItem: vi.fn().mockResolvedValue({ ok: true }),
    spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
    recordDispatch: vi.fn().mockResolvedValue(true),
    recordDispatchFailure: vi.fn().mockResolvedValue(undefined),
    rollbackClaim: vi.fn().mockResolvedValue(true),
    recordError: vi.fn().mockResolvedValue(undefined),
    getDueScheduledPrompt: vi.fn().mockResolvedValue(null),
    recordScheduledPromptTrigger: vi.fn().mockResolvedValue(true),
    readCodeFreezeStatus: vi.fn().mockReturnValue('not-frozen'),
    getActiveAudit: vi.fn().mockResolvedValue({ ok: true, active: false }),
    getReviewQueueCount: vi.fn().mockResolvedValue(0),
    getRunningDowntimePanes: vi.fn().mockResolvedValue({
      ok: true,
      count: 0,
      paneIds: [],
      records: [],
    }),
    ...overrides,
  } as DowntimeWorkerDeps;
}

/** Dispatch one offer-path tick against the temp leader root. */
function dispatchTick(deps: DowntimeWorkerDeps, entries: CoordinationEntry[]) {
  return dispatchFromCoordination(deps, entries, {
    model: 'plan',
    cwd: leaderCwd,
    coordinationDir,
    browseItemCount: 20,
  });
}

/**
 * Persist a decision entry exactly as `performDispatch` does — the same
 * fairness evidence the orchestrator composes. Used to build a multi-tick
 * decision history without running a full worker. Returns the written entry so
 * a test can assert the derived run length.
 */
async function recordOutcomeDecision(
  outcome: Awaited<ReturnType<typeof dispatchFromCoordination>>,
  tickSelectedRoot: string | null,
): Promise<CoordinationLogEntry> {
  const fairness = await dispatchDecisionFairness({
    coordinationDir,
    countingCwd: leaderCwd,
    tickSelectedRoot,
    selectedRootOverride: outcome.selectedRoot,
    dispatchingRoot: outcome.attemptedRoot,
    dispatched: outcome.dispatched,
  });
  const entry = {
    kind: 'decision',
    operation: outcome.dispatched ? 'dispatch' : 'no-dispatch',
    outcome: outcome.dispatched ? 'dispatched' : 'no-dispatch',
    instanceId: 'inst-a',
    reason: outcome.dispatched ? 'dispatched' : outcome.reason,
    ...fairness,
    at: new Date().toISOString(),
  } as CoordinationLogEntry;
  await appendCoordinationLogEntry(leaderCwd, entry);
  return entry;
}

// ── 1. Successful dispatch evidence ────────────────────────────────────

describe('successful dispatch fairness evidence', () => {
  it('records selectedRoot, dispatchingRoot and a run length of 1 on the first dispatch', async () => {
    seedCursor({});
    const deps = makeDeps();
    const entries = [makeEntry('inst-a', 'WL-A', '/repo/a')];

    const outcome = await dispatchTick(deps, entries);

    expect(outcome.dispatched).toBe(true);
    expect(outcome.attemptedRoot).toBe('/repo/a');
    const entry = await recordOutcomeDecision(outcome, '/repo/a');
    expect(entry).toMatchObject({
      operation: 'dispatch',
      outcome: 'dispatched',
      selectedRoot: '/repo/a',
      dispatchingRoot: '/repo/a',
      consecutiveRunLength: 1,
    });
  });

  it('increments the run for repeated dispatches to one root and resets on a root change', async () => {
    seedCursor({});

    let outcome = await dispatchTick(makeDeps(), [makeEntry('inst-a', 'WL-A', '/repo/a')]);
    let entry = await recordOutcomeDecision(outcome, '/repo/a');
    expect(entry.consecutiveRunLength).toBe(1);

    outcome = await dispatchTick(makeDeps(), [makeEntry('inst-a', 'WL-A', '/repo/a')]);
    entry = await recordOutcomeDecision(outcome, '/repo/a');
    expect(entry.consecutiveRunLength).toBe(2);

    outcome = await dispatchTick(makeDeps(), [makeEntry('inst-a', 'WL-A', '/repo/a')]);
    entry = await recordOutcomeDecision(outcome, '/repo/a');
    expect(entry.consecutiveRunLength).toBe(3);

    // A dispatch to a DIFFERENT root starts a fresh run.
    outcome = await dispatchTick(makeDeps(), [makeEntry('inst-b', 'WL-B', '/repo/b')]);
    expect(outcome.attemptedRoot).toBe('/repo/b');
    entry = await recordOutcomeDecision(outcome, '/repo/b');
    expect(entry).toMatchObject({
      selectedRoot: '/repo/b',
      dispatchingRoot: '/repo/b',
      consecutiveRunLength: 1,
    });
  });

  it('lets an auditor reconstruct the per-root distribution from the decision log alone', async () => {
    seedCursor({});
    let outcome = await dispatchTick(makeDeps(), [makeEntry('inst-a', 'WL-A', '/repo/a')]);
    await recordOutcomeDecision(outcome, '/repo/a');
    outcome = await dispatchTick(makeDeps(), [makeEntry('inst-a', 'WL-A', '/repo/a')]);
    await recordOutcomeDecision(outcome, '/repo/a');
    outcome = await dispatchTick(makeDeps(), [makeEntry('inst-b', 'WL-B', '/repo/b')]);
    await recordOutcomeDecision(outcome, '/repo/b');

    // No dispatcher replay: read the log and tally the recorded dispatching
    // roots. Every dispatch entry names its root and carries its outcome.
    const log = await readCoordinationLogEntries(leaderCwd);
    const dispatched = log.filter((entry) => entry.outcome === 'dispatched');
    expect(dispatched).toHaveLength(3);
    const distribution = new Map<string, number>();
    for (const entry of dispatched) {
      expect(typeof entry.dispatchingRoot).toBe('string');
      distribution.set(entry.dispatchingRoot!, (distribution.get(entry.dispatchingRoot!) ?? 0) + 1);
    }
    expect(Object.fromEntries(distribution)).toEqual({ '/repo/a': 2, '/repo/b': 1 });
    // The run lengths are on the entries, so a consecutive-run audit needs no
    // second source: a, a(2), b(1).
    expect(dispatched.map((entry) => entry.consecutiveRunLength)).toEqual([1, 2, 1]);
  });
});

// ── 2. No-dispatch evidence ────────────────────────────────────────────

describe('no-dispatch fairness evidence', () => {
  it('records selectedRoot and the tick outcome but never a fabricated dispatchingRoot', async () => {
    seedCursor({});
    // The only offer is held by the producer sentinel, so nothing dispatches.
    const deps = makeDeps({
      fetchItem: vi.fn().mockResolvedValue({
        ok: true,
        info: itemInfo({
          id: 'WL-HELD',
          status: 'open',
          stage: 'plan_complete',
          risk: 'Low',
          effort: 'S',
          assignee: 'Map',
        }),
      }),
    });

    const outcome = await dispatchTick(deps, [makeEntry('inst-a', 'WL-HELD', '/repo/a')]);

    expect(outcome.dispatched).toBe(false);
    expect(outcome.attemptedRoot).toBeUndefined();

    const entry = await recordOutcomeDecision(outcome, '/repo/a');
    expect(entry.operation).toBe('no-dispatch');
    expect(entry.outcome).toBe('no-dispatch');
    expect(entry.selectedRoot).toBe('/repo/a');
    expect(entry.dispatchingRoot).toBeUndefined();
  });
});

// ── 3. Registered-root sweep parity ────────────────────────────────────

describe('registered-root sweep fairness evidence', () => {
  function headItem(overrides: Partial<DowntimeHerdrItem> & { id: string }): DowntimeHerdrItem {
    return {
      id: overrides.id,
      title: overrides.title ?? `Head ${overrides.id}`,
      status: overrides.status ?? 'open',
      stage: overrides.stage ?? 'plan_complete',
      priority: overrides.priority,
      risk: overrides.risk ?? 'Low',
      effort: overrides.effort ?? 'S',
      auditedAt: overrides.auditedAt,
      updatedAt: overrides.updatedAt,
      sortIndex: overrides.sortIndex,
      needsProducerReview: overrides.needsProducerReview,
      assignee: overrides.assignee,
      deletedBy: overrides.deletedBy,
    };
  }

  it('records the same fairness fields as an offer-path dispatch', async () => {
    const sweptRoot = join(root, 'registered-a');
    mkdirSync(join(sweptRoot, '.worklog'), { recursive: true });
    seedCursor({});
    const deps = makeDeps({
      getHerdrListHead: vi.fn(async (cwd: string) =>
        cwd === sweptRoot
          ? { ok: true as const, items: [headItem({ id: 'WL-SWEPT' })] }
          : { ok: true as const, items: [] },
      ),
    });

    const outcome = await dispatchFromCoordination(deps, [], {
      model: 'plan',
      cwd: leaderCwd,
      coordinationDir,
      browseItemCount: 20,
      registeredRoots: [sweptRoot],
    });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.attemptedRoot).toBe(sweptRoot);
    expect(outcome.selectedRoot).toBe(sweptRoot);
    const entry = await recordOutcomeDecision(outcome, sweptRoot);
    expect(entry).toMatchObject({
      selectedRoot: sweptRoot,
      dispatchingRoot: sweptRoot,
      consecutiveRunLength: 1,
    });
  });
});

// ── 4. Run-length source ───────────────────────────────────────────────

// The run length is recorded to, and read from, the MACHINE-scoped run ledger
// (WL-0MWT3Z9M9002Z9BF): the leader's own decision-log tail is no longer the
// source, so a leadership hand-off to another root cannot reset a live run.
describe('run length is recorded to the machine-scoped run ledger', () => {
  it('extends a run for the same root and resets it on a root change', async () => {
    // Seed the ledger as a previous leader would have, then dispatch through
    // the leader (the round-robin charge is the single ledger write path).
    seedDispatchRun('/repo/a', 1_000);
    seedDispatchRun('/repo/a', 2_000);
    expect(readCurrentDispatchRun(coordinationDir)).toEqual({ root: '/repo/a', length: 2 });

    seedCursor({});
    let outcome = await dispatchTick(makeDeps(), [makeEntry('inst-a', 'WL-A', '/repo/a')]);
    let entry = await recordOutcomeDecision(outcome, '/repo/a');
    expect(entry.consecutiveRunLength).toBe(3);

    outcome = await dispatchTick(makeDeps(), [makeEntry('inst-b', 'WL-B', '/repo/b')]);
    entry = await recordOutcomeDecision(outcome, '/repo/b');
    expect(entry.consecutiveRunLength).toBe(1);
    expect(readCurrentDispatchRun(coordinationDir)).toEqual({ root: '/repo/b', length: 1 });
  });

  it('records a no-dispatch decision without advancing the run ledger', async () => {
    seedDispatchRun('/repo/a', 1_000);
    // A held offer dispatches nothing, so the run ledger must be untouched.
    const deps = makeDeps({
      fetchItem: vi.fn().mockResolvedValue({
        ok: true,
        info: itemInfo({
          id: 'WL-HELD',
          status: 'open',
          stage: 'plan_complete',
          risk: 'Low',
          effort: 'S',
          assignee: 'Map',
        }),
      }),
    });
    const outcome = await dispatchTick(deps, [makeEntry('inst-a', 'WL-HELD', '/repo/a')]);
    expect(outcome.dispatched).toBe(false);
    const entry = await recordOutcomeDecision(outcome, '/repo/a');
    expect(entry.dispatchingRoot).toBeUndefined();
    expect(entry.consecutiveRunLength).toBeUndefined();
    // Untouched: still the seeded run.
    expect(readCurrentDispatchRun(coordinationDir)).toEqual({ root: '/repo/a', length: 1 });
  });

  it('degrades to 1 when the run ledger is corrupt (fail-open) and still dispatches', async () => {
    // A directory where the ledger file should be makes the read fail.
    mkdirSync(join(coordinationDir, RUN_LEDGER_FILE_NAME), { recursive: true });
    expect(readCurrentDispatchRun(coordinationDir)).toBeNull();

    seedCursor({});
    const outcome = await dispatchTick(makeDeps(), [makeEntry('inst-a', 'WL-A', '/repo/a')]);
    expect(outcome.dispatched).toBe(true);
    const entry = await recordOutcomeDecision(outcome, '/repo/a');
    expect(entry.consecutiveRunLength).toBe(1);
  });

  it('keys the ledger on the same worklogRoot identity as the round-robin cursor', async () => {
    seedCursor({});
    const outcome = await dispatchTick(makeDeps(), [makeEntry('inst-a', 'WL-A', '/repo/a')]);
    expect(outcome.dispatched).toBe(true);
    await recordOutcomeDecision(outcome, '/repo/a');

    const cursor = JSON.parse(
      readFileSync(join(coordinationDir, ROUND_ROBIN_BY_ROOT_FILE_NAME), 'utf-8'),
    ) as Record<string, string>;
    expect(Object.keys(cursor)).toEqual(['/repo/a']);
    expect(readCurrentDispatchRun(coordinationDir)).toEqual({ root: '/repo/a', length: 1 });
    // The ledger key IS the cursor key (the `worklogRoot` project identity).
    expect(readCurrentDispatchRun(coordinationDir)!.root).toBe(Object.keys(cursor)[0]);
  });
});

// ── 4b. Fail-open fallback chain (WL-0MWT54AR8005LMKN AC4) ──────────────
//
// The recorded `consecutiveRunLength` must be derived from the SAME source as
// the bound: the ledger first, then the leader's own rotated decision log, then
// `1`. A missing ledger therefore cannot cause a hard failure or a blocked
// dispatch.
describe('recorded run length — decision-log fallback chain', () => {
  async function appendDispatchDecision(runRoot: string, runLength: number): Promise<void> {
    await appendCoordinationLogEntry(leaderCwd, {
      kind: 'decision',
      operation: 'dispatch',
      outcome: 'dispatched',
      instanceId: 'inst-a',
      reason: 'dispatched',
      dispatchingRoot: runRoot,
      consecutiveRunLength: runLength,
      at: new Date().toISOString(),
    } as CoordinationLogEntry);
  }

  async function compose() {
    return dispatchDecisionFairness({
      coordinationDir,
      countingCwd: leaderCwd,
      tickSelectedRoot: '/repo/a',
      dispatchingRoot: '/repo/a',
      dispatched: true,
    });
  }

  it('falls back to the leader\'s rotated decision log when the ledger is missing', async () => {
    await appendDispatchDecision('/repo/a', 1);
    await appendDispatchDecision('/repo/a', 2);
    expect(readCurrentDispatchRun(coordinationDir)).toBeNull();
    await expect(compose()).resolves.toMatchObject({ consecutiveRunLength: 3 });
  });

  it('falls back to the decision log when the ledger is corrupt', async () => {
    writeFileSync(join(coordinationDir, RUN_LEDGER_FILE_NAME), 'not-json{{{\n', 'utf-8');
    await appendDispatchDecision('/repo/a', 2);
    await expect(compose()).resolves.toMatchObject({ consecutiveRunLength: 3 });
  });

  it('resolves 1 when neither the ledger nor the decision log has history', async () => {
    await expect(compose()).resolves.toMatchObject({ consecutiveRunLength: 1 });
  });

  it('prefers the ledger over the decision log (the ledger is the single source)', async () => {
    seedDispatchRun('/repo/a', 1_000); // ledger says run = 1
    await appendDispatchDecision('/repo/a', 5); // log says 5: must be ignored
    await expect(compose()).resolves.toMatchObject({ consecutiveRunLength: 1 });
  });
});

// ── 5. Unchanged on-disk cursor format ─────────────────────────────────

describe('round-robin cursor format is unchanged', () => {
  it('still writes a flat { root: ISO-8601 } map; run state lives in a separate record', async () => {
    seedCursor({ '/repo/a': '2026-01-01T00:00:00.000Z' });
    const outcome = await dispatchTick(makeDeps(), [makeEntry('inst-a', 'WL-A', '/repo/a')]);
    expect(outcome.dispatched).toBe(true);
    // Compose (and record) the dispatch decision so the machine ledger is written.
    await recordOutcomeDecision(outcome, '/repo/a');

    const raw = readFileSync(join(coordinationDir, ROUND_ROBIN_BY_ROOT_FILE_NAME), 'utf-8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    for (const [key, value] of Object.entries(data)) {
      expect(typeof key).toBe('string');
      expect(typeof value).toBe('string');
      expect(Number.isNaN(Date.parse(value as string))).toBe(false);
    }
    // The cursor file stays a flat { root: ISO-8601 } map — no run state in it.
    expect(Object.keys(data)).toEqual(['/repo/a']);
    // The run state is a SEPARATE single record, never mixed into the cursor.
    expect(existsSync(join(coordinationDir, RUN_LEDGER_FILE_NAME))).toBe(true);
    const ledger = JSON.parse(
      readFileSync(join(coordinationDir, RUN_LEDGER_FILE_NAME), 'utf-8'),
    ) as Record<string, unknown>;
    expect(Object.keys(ledger).sort()).toEqual(['at', 'root', 'runLength']);
    expect(readdirSync(coordinationDir).sort()).toEqual(
      [ROUND_ROBIN_BY_ROOT_FILE_NAME, RUN_LEDGER_FILE_NAME].sort(),
    );
  });
});

// ── 6. Orchestrator writer + rate limiting ─────────────────────────────

describe('dispatch decision writer', () => {
  function makeCtx(recorded: CoordinationLogEntry[]): OrchestratorContext {
    return {
      opts: {
        deps: {
          recordDecision: async (entry: CoordinationLogEntry) => {
            recorded.push(entry);
          },
        },
        config: () => ({}),
      },
      starvationTracker: { observe: vi.fn().mockReturnValue(null) },
      leaderState: false,
      lastDecisionReason: null,
      lastDecisionAt: 0,
      blockReason: null,
      instanceId: 'inst-a',
    } as unknown as OrchestratorContext;
  }

  it('writes a `dispatch`/`dispatched` entry carrying the fairness fields and is never rate-limited', async () => {
    const recorded: CoordinationLogEntry[] = [];
    const ctx = makeCtx(recorded);
    const fields = {
      freeSlots: 1,
      totalSlots: 4,
      ownerPresent: false,
      runningPanes: 0,
      contentionDepth: 0,
      selectedRoot: '/repo/a' as string | null,
      dispatchingRoot: '/repo/a',
      consecutiveRunLength: 2,
    };

    vi.useFakeTimers();
    vi.setSystemTime(10_000_000);
    try {
      await recordDecision(ctx, leaderCwd, 'dispatched', fields, {
        blocking: false,
        rateLimit: false,
        operation: 'dispatch',
      });
      await recordDecision(ctx, leaderCwd, 'dispatched', fields, {
        blocking: false,
        rateLimit: false,
        operation: 'dispatch',
      });
    } finally {
      vi.useRealTimers();
    }

    // Two dispatches inside the rate-limit window are BOTH recorded.
    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toMatchObject({
      kind: 'decision',
      operation: 'dispatch',
      outcome: 'dispatched',
      reason: 'dispatched',
      selectedRoot: '/repo/a',
      dispatchingRoot: '/repo/a',
      consecutiveRunLength: 2,
    });
    // A dispatch is an observation: the header blocking token is untouched.
    expect(ctx.blockReason).toBeNull();
  });

  it('still rate-limits identical refusals', async () => {
    const recorded: CoordinationLogEntry[] = [];
    const ctx = makeCtx(recorded);
    const fields = {
      freeSlots: 0,
      totalSlots: 4,
      ownerPresent: false,
      runningPanes: 0,
      contentionDepth: 0,
      selectedRoot: null as string | null,
    };

    vi.useFakeTimers();
    vi.setSystemTime(10_000_000);
    try {
      await recordDecision(ctx, leaderCwd, 'no-candidate', fields);
      await recordDecision(ctx, leaderCwd, 'no-candidate', fields);
    } finally {
      vi.useRealTimers();
    }

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      operation: 'no-dispatch',
      outcome: 'no-dispatch',
      reason: 'no-candidate',
      selectedRoot: null,
    });
  });
});

// ── 7. Worker integration: the dispatch decision is written end-to-end ──

describe('worker integration', () => {
  function statusPayload(): Record<string, unknown> {
    return {
      llama_server_running: true,
      local_active_query: false,
      model_switch_in_progress: false,
      local_lease_active: false,
      available_slots: 4,
      total_slots: 4,
      slots: [
        { slot_id: 'slot-1', is_processing: false },
        { slot_id: 'slot-2', is_processing: false },
        { slot_id: 'slot-3', is_processing: false },
        { slot_id: 'slot-4', is_processing: false },
      ],
    };
  }

  it('records the fairness fields on the coordination decision entry of a real dispatch', async () => {
    const coordDir = join(root, 'worker-coord');
    mkdirSync(coordDir, { recursive: true });
    writeCoordinationFile(coordDir, {
      version: 1,
      entries: [makeEntry('inst-peer', 'WL-PEER', '/repo/peer')],
    });

    const recordDecisionSpy = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      recordDecision: recordDecisionSpy,
      fetchItem: vi.fn().mockResolvedValue({ ok: true, info: planItem('WL-PEER') }),
    });
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => statusPayload(),
    }));
    const worker = createDowntimeWorker({
      coordinationDir: coordDir,
      instanceId: 'inst-a',
      poller: createDowntimePoller('http://localhost:8000', fetcher as never, 5000),
      deps,
      config: () => ({
        enabled: true,
        thresholdMs: 60_000,
        requiredFreeSlots: 1,
        model: 'plan',
        cwd: leaderCwd,
        noCandidateCooldownMs: 3_600_000,
      }),
      leaseTtlSeconds: 300,
      checkInIntervalMs: 30 * 60 * 1000,
      leaderCheckInIntervalMs: 4 * 60 * 1000,
    });

    vi.useFakeTimers();
    vi.setSystemTime(10_000_000);
    try {
      await worker.tick();
      vi.setSystemTime(10_000_000 + 60_001);
      const result = await worker.tick();
      expect(result.dispatched).toBe(true);
    } finally {
      vi.useRealTimers();
    }

    const entries = recordDecisionSpy.mock.calls.map(
      (call) => (call as [CoordinationLogEntry])[0],
    );
    const dispatchEntry = entries.find((entry) => entry.operation === 'dispatch');
    expect(dispatchEntry).toBeDefined();
    expect(dispatchEntry).toMatchObject({
      kind: 'decision',
      operation: 'dispatch',
      outcome: 'dispatched',
      reason: 'dispatched',
      selectedRoot: '/repo/peer',
      dispatchingRoot: '/repo/peer',
      consecutiveRunLength: 1,
    });
  });
});
