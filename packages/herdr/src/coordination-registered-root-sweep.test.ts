/**
 * packages/herdr/src/coordination-registered-root-sweep.test.ts — test-first
 * contract for the leader's REGISTERED-ROOT SWEEP.
 *
 * Parent: WL-0MVR8GDJ3008WY3Y ("the downtime leader cannot see a worklog root
 * with no running herdr instance"). Test item: WL-0MW4ZODX6008FZZB.
 * Implementation child: WL-0MW4ZOSD6004SAVD.
 *
 * ## The contract pinned here
 *
 * The leader's candidate universe becomes
 *
 *     offers ∪ sweep(registeredRoots) ∪ ownBacklog(opts.cwd)
 *
 * where `opts.registeredRoots` is the resolved `downtimeWorklogRoots` registry
 * (WL-0MW4ZNYSV002LJDZ / WL-0MW4ZOIJE001ROA4 — WORKLOG ROOT paths, i.e. the
 * parent of `.worklog/`, matching `opts.cwd` / `worklogRoot` semantics).
 * Frozen rules:
 *
 *  1. **Offers win.** The sweep is only reached when the offer list yielded no
 *     dispatchable candidate, so an offer dispatch never reads a registered
 *     root (parent AC1/AC6).
 *  2. **One canonical ranking.** Each swept root is read through
 *     `getHerdrListHead(root, sprintView)` plus, at most, the SAME bounded
 *     extension (`DOWNTIME_DISPATCH_EXTEND_MAX`) the own-backlog fallback
 *     uses. The first eligible item in that canonical order wins — a sweep is
 *     a bounded WINDOW over roots, never a second ranking (parent AC3).
 *  3. **Round-robin fairness.** Roots are swept in least-recently-served order
 *     using the existing per-root cursor (`downtime-round-robin-by-root.ts`),
 *     and the cursor advances on dispatch, so two busy roots are served
 *     alternately and no root monopolises the leader. A root with nothing
 *     dispatchable never consumes the tick — the sweep continues to the next
 *     root — and the sweep is served BEFORE the leader's own out-of-view
 *     backlog, so a busy leader root cannot starve the registry (parent AC4).
 *  4. **No gate bypass.** A swept candidate passes the FULL sequential filter
 *     chain (classify: producer review / assignee hold / effort cap → code
 *     freeze → slot minimums → review-queue hold → in-flight critical guard)
 *     against ITS OWN root's state, exactly as an offer does. A gate that
 *     holds the only swept candidate keeps its NEUTRAL terminal reason (never
 *     `no-candidate`, which would arm the no-candidate cooldown) (parent AC2).
 *  5. **Fail-open.** A registered root whose head read throws or resolves
 *     `{ok:false}` (missing/unreadable root) is skipped without a strike and
 *     never crashes the tick; when every registered root fails, the terminal
 *     reason is unchanged (parent AC5).
 *  6. A swept dispatch is recorded with `selectionPath:
 *     'registered-root-sweep'` and does NOT raise `ownBacklogDispatch`: the
 *     leader is serving a registered root, not its own backlog, so it must not
 *     hand off leadership (that would flap the machine-wide election on every
 *     sweep).
 *
 * ## GREEN AFTER THE SWEEP LANDED
 *
 * Committed RED as `it.fails(...)` (the repo's documented TDD pattern; see
 * `coordination-cross-root.test.ts` and `downtime-worker.clamps.test.ts`)
 * while `registeredRoots` was ignored. Implementation child
 * WL-0MW4ZOSD6004SAVD landed the sweep in `downtime-worker.head-scan.ts` and
 * flipped every target spec to plain `it(...)`: this whole file now pins live
 * behaviour. The two specs that already held before the change (offer
 * precedence, the unchanged terminal reason when every root fails) remain
 * regression guards.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DOWNTIME_DISPATCH_EXTEND_MAX,
  dispatchFromCoordination,
  type DowntimeHerdrItem,
  type DowntimeWorkerDeps,
} from './downtime-worker.js';
import {
  ROUND_ROBIN_BY_ROOT_FILE_NAME,
  loadRoundRobinCursor,
  saveRoundRobinCursor,
} from './downtime-round-robin-by-root.js';
import type { CoordinationEntry } from './coordination.js';

// ── Fixtures ──────────────────────────────────────────────────────────

/** The live sprint-view window every case dispatches with. */
const SPRINT = 5;

/** The leader's own root (never a registered root in these cases). */
const LEADER_ROOT = '/leader-root';

/**
 * The opts surface I3 must accept. Reached through an intersection so this
 * file compiles (and the suite stays green) before `registeredRoots` exists —
 * the same device T1 used in `coordination-cross-root.test.ts`.
 */
type SweepOpts = Parameters<typeof dispatchFromCoordination>[2] & {
  registeredRoots?: readonly string[];
};

/** A mocked `vi.fn()` (narrow view for reading recorded calls). */
type AnyMock = ReturnType<typeof vi.fn>;

let coordinationDir: string;
let tempRoots: string[];

beforeEach(() => {
  coordinationDir = mkdtempSync(join(tmpdir(), 'herdr-sweep-coord-'));
  tempRoots = [];
});

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  rmSync(coordinationDir, { recursive: true, force: true });
});

/**
 * A real temporary WORKLOG ROOT — the parent of `.worklog/`, which is exactly
 * what the registry holds. The `.worklog/` directory exists so the root's
 * dispatch-log / cooldown reads resolve to "empty" rather than "missing".
 */
function makeRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `herdr-sweep-${label}-`));
  mkdirSync(join(root, '.worklog'), { recursive: true });
  tempRoots.push(root);
  return root;
}

/** Build a Herdr selection-list head item (fetcher → smart-selection shape). */
function headItem(overrides: Partial<DowntimeHerdrItem> & { id: string }): DowntimeHerdrItem {
  return {
    id: overrides.id,
    title: overrides.title ?? `Head ${overrides.id}`,
    status: overrides.status ?? 'open',
    // Default shape is a dispatchable `implement` candidate (open +
    // plan_complete + populated risk/effort within the effort cap).
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

/** Minimal deps mock for the coordination dispatch path. */
function makeDeps(overrides: Partial<DowntimeWorkerDeps> = {}): DowntimeWorkerDeps {
  return {
    getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    getAuditCandidateScope: vi.fn().mockResolvedValue({ ok: true, scope: 'parent' }),
    getNextImplementCandidate: vi.fn().mockResolvedValue(null),
    getNextCriticalCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    // Canonical ranking seam. Default: every root is genuinely empty.
    getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [] }),
    fetchItem: vi.fn().mockResolvedValue({
      ok: true,
      info: { id: 'WL-X', status: 'open', stage: 'idea' },
    }),
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

/** What a root's canonical-ranking read resolves to. */
type HeadSpec = DowntimeHerdrItem[] | 'unreadable' | 'missing';

/**
 * A root-aware `getHerdrListHead` mock modelling the canonical ranking:
 * a read at/below the sprint view returns the in-view head; a larger read
 * returns that head followed by the root's ranked extension.
 *
 * `'unreadable'` models a root whose worklog cannot be read (the CLI fails or
 * throws); `'missing'`/absent models a root with no worklog database — the
 * real seam resolves `{ok:false}` for both.
 */
function rankedHeads(
  spec: Record<string, HeadSpec>,
  extension: Record<string, DowntimeHerdrItem[]> = {},
) {
  return vi.fn(async (cwd: string, limit = SPRINT) => {
    const entry = spec[cwd];
    if (entry === 'unreadable') throw new Error(`unreadable worklog root: ${cwd}`);
    if (entry === 'missing' || entry === undefined) {
      return { ok: false as const, error: `no worklog at ${cwd}` };
    }
    const items = limit <= SPRINT ? entry : [...entry, ...(extension[cwd] ?? [])];
    return { ok: true as const, items };
  });
}

/** Dispatch one tick through the leader path with a registered-root registry. */
function dispatch(
  deps: DowntimeWorkerDeps,
  registeredRoots: readonly string[],
  entries: CoordinationEntry[] = [],
  extra: Partial<SweepOpts> = {},
) {
  const opts = {
    model: 'plan',
    cwd: LEADER_ROOT,
    coordinationDir,
    browseItemCount: SPRINT,
    registeredRoots,
    ...extra,
  } as SweepOpts;
  return dispatchFromCoordination(deps, entries, opts);
}

/** The `cwd` the first spawned pane was placed in. */
function spawnCwd(deps: DowntimeWorkerDeps): string | undefined {
  const calls = (deps.spawnAgentPane as unknown as AnyMock).mock.calls;
  return (calls[0]?.[1] as { cwd?: string } | undefined)?.cwd;
}

/** A coordination OFFER entry from a peer instance in `worklogRoot`. */
function offer(instanceId: string, workItemId: string, worklogRoot: string): CoordinationEntry {
  const now = new Date().toISOString();
  return {
    instanceId,
    workItemId,
    directory: worklogRoot,
    worklogRoot,
    assignedAt: now,
    lastUpdated: now,
  };
}

// ── Reachability + canonical ranking (parent AC1/AC3) ─────────────────

describe('registered-root sweep — reachability and canonical ranking (parent AC1/AC3)', () => {
  it(
    'AC1: dispatches the head of a registered root that has no running herdr instance (zero offers)',
    async () => {
      const root = makeRoot('alpha');
      const deps = makeDeps({
        getHerdrListHead: rankedHeads({
          [LEADER_ROOT]: [],
          [root]: [headItem({ id: 'WL-SWEEP-1', title: 'Reachable' })],
        }),
      });

      const outcome = await dispatch(deps, [root]);

      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('implement');
      expect(outcome.candidate?.id).toBe('WL-SWEEP-1');
      // The claim, the marker and the pane all land in the REGISTERED root.
      expect(deps.claimItem).toHaveBeenCalledWith('WL-SWEEP-1', expect.anything(), root);
      expect(deps.spawnAgentPane).toHaveBeenCalledWith(
        expect.stringContaining('/skill:implement WL-SWEEP-1'),
        expect.objectContaining({ cwd: root }),
      );
      expect(deps.recordDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          itemId: 'WL-SWEEP-1',
          cwd: root,
          selectionPath: 'registered-root-sweep',
        }),
      );
      // A registered root is NOT the leader's own backlog: no leadership
      // hand-off (that would flap the machine-wide election on every sweep).
      expect((outcome as { ownBacklogDispatch?: boolean }).ownBacklogDispatch).not.toBe(true);
    },
  );

  it(
    'AC3: the swept candidate is the first item in the root canonical order — never a second ranking',
    async () => {
      const root = makeRoot('canonical');
      // The canonical (head) order puts WL-HEAD-Z first even though every
      // plausible SECOND ranking key would prefer WL-HEAD-A (critical, lower
      // risk, smaller effort, lower sort index).
      const deps = makeDeps({
        getHerdrListHead: rankedHeads({
          [LEADER_ROOT]: [],
          [root]: [
            headItem({
              id: 'WL-HEAD-Z',
              priority: 'low',
              risk: 'High',
              effort: 'M',
              sortIndex: 9999,
            }),
            headItem({
              id: 'WL-HEAD-A',
              priority: 'critical',
              risk: 'Low',
              effort: 'S',
              sortIndex: 1,
            }),
          ],
        }),
      });

      const outcome = await dispatch(deps, [root]);

      expect(outcome.dispatched).toBe(true);
      expect(outcome.candidate?.id).toBe('WL-HEAD-Z');
      expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    },
  );

  it(
    'AC3: the swept root is read through the same bounded window (sprint view, never an unbounded read)',
    async () => {
      const root = makeRoot('window');
      const getHerdrListHead = rankedHeads({
        [LEADER_ROOT]: [],
        [root]: [headItem({ id: 'WL-WINDOW' })],
      });
      const deps = makeDeps({ getHerdrListHead });

      const outcome = await dispatch(deps, [root]);

      expect(outcome.dispatched).toBe(true);
      const limits = (getHerdrListHead as unknown as AnyMock).mock.calls
        .filter((call) => call[0] === root)
        .map((call) => call[1] as number);
      // The canonical ranking is read with the LIVE sprint view first ...
      expect(limits.length).toBeGreaterThan(0);
      expect(limits[0]).toBe(SPRINT);
      // ... and never with an unbounded window.
      expect(Math.max(...limits)).toBeLessThanOrEqual(SPRINT + DOWNTIME_DISPATCH_EXTEND_MAX);
    },
  );

  it(
    'AC1/AC6: an eligible offer takes precedence — a registered root is never read while an offer dispatches',
    async () => {
      const root = makeRoot('offer-precedence');
      const getHerdrListHead = rankedHeads({ [root]: [headItem({ id: 'WL-SWEEP-NOT-NOW' })] });
      const deps = makeDeps({
        getHerdrListHead,
        fetchItem: vi.fn().mockResolvedValue({
          ok: true,
          info: { id: 'WL-OFFER', status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'S' },
        }),
      });

      const outcome = await dispatch(deps, [root], [offer('peer-1', 'WL-OFFER', '/peer-root')]);

      expect(outcome.dispatched).toBe(true);
      expect(spawnCwd(deps)).toBe('/peer-root');
      // The sweep never ran: the offer consumed the tick.
      expect(getHerdrListHead).not.toHaveBeenCalledWith(root, expect.any(Number));
    },
  );
});

// ── Fail-safe: no registry (parent AC6) ──────────────────────────────

describe('registered-root sweep — fail-safe without a registry (parent AC6)', () => {
  it(
    'AC6: an empty registry never reads a registered root and never touches the round-robin cursor',
    async () => {
      const root = makeRoot('unregistered');
      const getHerdrListHead = rankedHeads({ [LEADER_ROOT]: [], [root]: [headItem({ id: 'WL-NOT-SWEPT' })] });
      const deps = makeDeps({ getHerdrListHead });

      const outcome = await dispatch(deps, []);

      // Nothing dispatchable: the sweep is a no-op, not an error.
      expect(outcome.dispatched).toBe(false);
      expect(outcome.reason).toBe('no-candidate');
      expect(getHerdrListHead).not.toHaveBeenCalledWith(root, expect.any(Number));
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
      // No cursor read/write: today's behaviour is byte-for-byte unchanged.
      expect(existsSync(join(coordinationDir, ROUND_ROBIN_BY_ROOT_FILE_NAME))).toBe(false);
    },
  );

  it(
    'AC6: an ABSENT registry leaves the own-backlog fallback unchanged (its hand-off flag still raised)',
    async () => {
      const deps = makeDeps({
        getHerdrListHead: rankedHeads(
          { [LEADER_ROOT]: [] },
          { [LEADER_ROOT]: [headItem({ id: 'WL-OWN-ONLY' })] },
        ),
      });

      const outcome = await dispatch(deps, [], [], { registeredRoots: undefined });

      expect(outcome.dispatched).toBe(true);
      expect(outcome.candidate?.id).toBe('WL-OWN-ONLY');
      // The own-backlog fallback (not the sweep) served it: leadership hand-off
      // semantics must be identical to the pre-sweep behaviour.
      expect((outcome as { ownBacklogDispatch?: boolean }).ownBacklogDispatch).toBe(true);
      expect(spawnCwd(deps)).toBe(LEADER_ROOT);
    },
  );
});

// ── Round-robin fairness (parent AC4) ────────────────────────────────

describe('registered-root sweep — round-robin fairness (parent AC4)', () => {
  it(
    'AC4: two registered roots each holding dispatchable work are served alternately, never monopolised',
    async () => {
      const rootA = makeRoot('fair-a');
      const rootB = makeRoot('fair-b');
      // rootA was served longer ago, so the cursor must serve it first.
      saveRoundRobinCursor(coordinationDir, {
        [rootA]: '2026-01-01T00:00:00.000Z',
        [rootB]: '2026-01-02T00:00:00.000Z',
      });
      const heads = {
        [LEADER_ROOT]: [],
        [rootA]: [headItem({ id: 'WL-A-HEAD' })],
        [rootB]: [headItem({ id: 'WL-B-HEAD' })],
      };

      const firstDeps = makeDeps({ getHerdrListHead: rankedHeads(heads) });
      const first = await dispatch(firstDeps, [rootA, rootB]);
      expect(first.dispatched).toBe(true);
      expect(spawnCwd(firstDeps)).toBe(rootA);

      // The cursor is advanced on dispatch: rootA is now the most recently
      // served root, so the next tick must serve rootB.
      const afterFirst = loadRoundRobinCursor(coordinationDir);
      expect(Date.parse(afterFirst[rootA] ?? '')).toBeGreaterThan(
        Date.parse('2026-01-02T00:00:00.000Z'),
      );

      const secondDeps = makeDeps({ getHerdrListHead: rankedHeads(heads) });
      const second = await dispatch(secondDeps, [rootA, rootB]);
      expect(second.dispatched).toBe(true);
      expect(spawnCwd(secondDeps)).toBe(rootB);
    },
  );

  it(
    'AC4: the leader own backlog never starves a registered root — the sweep is served first',
    async () => {
      const root = makeRoot('not-starved');
      // The leader's OWN root has dispatchable work beyond the sprint view
      // (the own-backlog fallback would dispatch it) while a registered root
      // also holds dispatchable work. Fairness demands the registered root is
      // not starved by the leader's own backlog (parent formula order:
      // offers ∪ sweep(registeredRoots) ∪ ownBacklog(cwd)).
      const deps = makeDeps({
        getHerdrListHead: rankedHeads(
          { [LEADER_ROOT]: [], [root]: [headItem({ id: 'WL-REGISTERED-WINS' })] },
          { [LEADER_ROOT]: [headItem({ id: 'WL-OWN-BACKLOG' })] },
        ),
      });

      const outcome = await dispatch(deps, [root]);

      expect(outcome.dispatched).toBe(true);
      expect(outcome.candidate?.id).toBe('WL-REGISTERED-WINS');
      expect(spawnCwd(deps)).toBe(root);
    },
  );

  it(
    'AC4: a registered root with nothing dispatchable never consumes the tick — the sweep continues to the next root',
    async () => {
      const rootEmpty = makeRoot('empty');
      const rootBusy = makeRoot('busy');
      saveRoundRobinCursor(coordinationDir, {
        [rootEmpty]: '2026-01-01T00:00:00.000Z',
        [rootBusy]: '2026-01-02T00:00:00.000Z',
      });
      const deps = makeDeps({
        getHerdrListHead: rankedHeads({
          [LEADER_ROOT]: [],
          [rootEmpty]: [],
          [rootBusy]: [headItem({ id: 'WL-BUSY' })],
        }),
      });

      const outcome = await dispatch(deps, [rootEmpty, rootBusy]);

      expect(outcome.dispatched).toBe(true);
      expect(spawnCwd(deps)).toBe(rootBusy);
    },
  );
});

// ── Fail-open (parent AC5) ───────────────────────────────────────────

describe('registered-root sweep — fail-open (parent AC5)', () => {
  it(
    'AC5: an unreadable registered root is skipped without a strike and the next root dispatches',
    async () => {
      const rootBroken = makeRoot('broken');
      const rootBusy = makeRoot('busy-after-broken');
      const deps = makeDeps({
        getHerdrListHead: rankedHeads({
          [LEADER_ROOT]: [],
          [rootBroken]: 'unreadable',
          [rootBusy]: [headItem({ id: 'WL-AFTER-BROKEN' })],
        }),
      });

      const outcome = await dispatch(deps, [rootBroken, rootBusy]);

      expect(outcome.dispatched).toBe(true);
      // A broken root is a SKIP, never a strike.
      expect(outcome.reason).not.toBe('wl-error');
      expect(spawnCwd(deps)).toBe(rootBusy);
    },
  );

  it(
    'AC5: a missing registered root is skipped without a strike and the next root dispatches',
    async () => {
      const missing = join(tmpdir(), 'herdr-sweep-root-that-does-not-exist');
      const rootBusy = makeRoot('busy-after-missing');
      const deps = makeDeps({
        getHerdrListHead: rankedHeads({
          [LEADER_ROOT]: [],
          [missing]: 'missing',
          [rootBusy]: [headItem({ id: 'WL-AFTER-MISSING' })],
        }),
      });

      const outcome = await dispatch(deps, [missing, rootBusy]);

      expect(outcome.dispatched).toBe(true);
      expect(outcome.reason).not.toBe('wl-error');
      expect(spawnCwd(deps)).toBe(rootBusy);
    },
  );

  it(
    'AC5: when every registered root is unreadable the tick ends on the unchanged no-candidate reason (never wl-error)',
    async () => {
      const rootDead = makeRoot('dead');
      const rootMissing = makeRoot('missing');
      const deps = makeDeps({
        getHerdrListHead: rankedHeads({
          [LEADER_ROOT]: [],
          [rootDead]: 'unreadable',
          [rootMissing]: 'missing',
        }),
      });

      const outcome = await dispatch(deps, [rootDead, rootMissing]);

      expect(outcome.dispatched).toBe(false);
      expect(outcome.reason).toBe('no-candidate');
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    },
  );
});

// ── No gate bypass (parent AC2) ──────────────────────────────────────

describe('registered-root sweep — no gate bypass (parent AC2)', () => {
  it(
    'AC2: a swept candidate held for producer review is skipped and the next eligible in the same root dispatches',
    async () => {
      const root = makeRoot('producer-review');
      const deps = makeDeps({
        getHerdrListHead: rankedHeads({
          [LEADER_ROOT]: [],
          [root]: [
            headItem({ id: 'WL-HELD-REVIEW', needsProducerReview: true }),
            headItem({ id: 'WL-ELIGIBLE-AFTER-REVIEW' }),
          ],
        }),
      });

      const outcome = await dispatch(deps, [root]);

      expect(outcome.dispatched).toBe(true);
      expect(outcome.candidate?.id).toBe('WL-ELIGIBLE-AFTER-REVIEW');
      expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    },
  );

  it(
    'AC2: a swept candidate held by an assignee is skipped and the next eligible in the same root dispatches',
    async () => {
      const root = makeRoot('assignee-hold');
      const deps = makeDeps({
        getHerdrListHead: rankedHeads({
          [LEADER_ROOT]: [],
          [root]: [
            headItem({ id: 'WL-HELD-ASSIGNEE', assignee: 'Map' }),
            headItem({ id: 'WL-ELIGIBLE-AFTER-HOLD' }),
          ],
        }),
      });

      const outcome = await dispatch(deps, [root]);

      expect(outcome.dispatched).toBe(true);
      expect(outcome.candidate?.id).toBe('WL-ELIGIBLE-AFTER-HOLD');
    },
  );

  it(
    'AC2: an implement candidate above the effort cap is skipped and the next eligible in the same root dispatches',
    async () => {
      const root = makeRoot('effort-cap');
      const deps = makeDeps({
        getHerdrListHead: rankedHeads({
          [LEADER_ROOT]: [],
          [root]: [
            // effort L (ordinal 4) is above the implement cap (≤ Medium).
            headItem({ id: 'WL-CAPPED-EFFORT', effort: 'L' }),
            headItem({ id: 'WL-ELIGIBLE-AFTER-CAP' }),
          ],
        }),
      });

      const outcome = await dispatch(deps, [root]);

      expect(outcome.dispatched).toBe(true);
      expect(outcome.candidate?.id).toBe('WL-ELIGIBLE-AFTER-CAP');
    },
  );

  it(
    'AC2: a swept audit candidate still needs the audit slot minimum — a single free slot goes to the plan tier instead',
    async () => {
      const root = makeRoot('audit-slot-min');
      const deps = makeDeps({
        getHerdrListHead: rankedHeads({
          [LEADER_ROOT]: [],
          [root]: [
            // completed/in_review with no fresh audit → the audit tier, which
            // needs TWO free slots (parent + Phase 2 child).
            headItem({
              id: 'WL-AUDIT-NEEDS-TWO',
              status: 'completed',
              stage: 'in_review',
              updatedAt: new Date().toISOString(),
            }),
            // A single-pane tier that fits the one free slot.
            headItem({ id: 'WL-PLAN-FITS', stage: 'intake_complete' }),
          ],
        }),
      });

      const outcome = await dispatch(deps, [root], [], { freeSlots: 1 });

      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('plan');
      expect(outcome.candidate?.id).toBe('WL-PLAN-FITS');
    },
  );

  it(
    'AC2: code-freeze pauses implement in a swept root while plan still dispatches from it',
    async () => {
      const root = makeRoot('code-freeze');
      const deps = makeDeps({
        getHerdrListHead: rankedHeads({
          [LEADER_ROOT]: [],
          [root]: [
            headItem({ id: 'WL-FROZEN-IMPLEMENT' }), // implement
            headItem({ id: 'WL-FROZEN-PLAN', stage: 'intake_complete' }), // plan
          ],
        }),
        readCodeFreezeStatus: vi.fn().mockReturnValue('frozen'),
      });

      const outcome = await dispatch(deps, [root]);

      // The sweep reached the root, but the freeze held its implement
      // candidate: the split-by-skill plan item dispatched instead.
      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('plan');
      expect(outcome.candidate?.id).toBe('WL-FROZEN-PLAN');
      expect(spawnCwd(deps)).toBe(root);
    },
  );

  it(
    'AC2: a deep review queue in the swept root holds a non-critical implement and reports review-queue-hold',
    async () => {
      const root = makeRoot('review-queue');
      const deps = makeDeps({
        getHerdrListHead: rankedHeads({
          [LEADER_ROOT]: [],
          [root]: [headItem({ id: 'WL-QUEUE-DEEP' })],
        }),
        // Only the swept root's queue is deep (>= the sprint-view threshold).
        getReviewQueueCount: vi
          .fn()
          .mockImplementation(async (cwd: string) => (cwd === root ? SPRINT : 0)),
      });

      const outcome = await dispatch(deps, [root]);

      expect(outcome.dispatched).toBe(false);
      // A gate hold must never masquerade as an empty backlog: the neutral
      // hold reason keeps the no-candidate cooldown disarmed.
      expect(outcome.reason).toBe('review-queue-hold');
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    },
  );

  it(
    'AC2: a critical swept candidate with a live pane in its own root is not dispatched (in-flight hold)',
    async () => {
      const root = makeRoot('in-flight');
      const deps = makeDeps({
        getHerdrListHead: rankedHeads({
          [LEADER_ROOT]: [],
          [root]: [headItem({ id: 'WL-CRIT-RUNNING', priority: 'critical' })],
        }),
        getRunningDowntimePanes: vi.fn().mockImplementation(async (cwd: string) => ({
          ok: true,
          count: cwd === root ? 1 : 0,
          paneIds: [],
          records:
            cwd === root
              ? [
                  {
                    paneId: 'w1:p9',
                    label: 'Downtime triggered implement Running crit - WL-CRIT-RUNNING',
                    agent: 'pi',
                    agentStatus: 'working',
                    cwd: root,
                  },
                ]
              : [],
        })),
      });

      const outcome = await dispatch(deps, [root]);

      expect(outcome.dispatched).toBe(false);
      expect(outcome.reason).toBe('in-flight-pane');
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    },
  );

  it(
    'AC2: the leader own freeze does not block a swept root — each root freeze marker is read on its own',
    async () => {
      const root = makeRoot('own-marker');
      const deps = makeDeps({
        getHerdrListHead: rankedHeads({
          [LEADER_ROOT]: [],
          [root]: [headItem({ id: 'WL-SWEPT-UNFROZEN' })],
        }),
        // A release is in progress in the LEADER's root only.
        readCodeFreezeStatus: vi
          .fn()
          .mockImplementation((cwd: string) => (cwd === LEADER_ROOT ? 'frozen' : 'not-frozen')),
      });

      const outcome = await dispatch(deps, [root]);

      // The sweep reached the root, whose own marker is clear, so its
      // implement candidate dispatches even though the leader is frozen.
      expect(outcome.dispatched).toBe(true);
      expect(outcome.candidate?.id).toBe('WL-SWEPT-UNFROZEN');
      expect(spawnCwd(deps)).toBe(root);
    },
  );
});
