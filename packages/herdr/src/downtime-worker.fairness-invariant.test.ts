/**
 * packages/herdr/src/downtime-worker.fairness-invariant.test.ts — the
 * failing-first fairness INVARIANT (four roots).
 *
 * Parent: WL-0MWKE9VF800101V9 (Dispatcher seems to unevenly distribute work).
 * Work item: WL-0MWKY0ZQI004UZXR (Failing-first fairness invariant test, four
 * roots; parent AC1).
 *
 * The invariant (parent AC1): when two or more roots have ADMISSIBLE offers and
 * surplus capacity exists, no root may be dispatched more than TWICE in
 * succession.
 *
 * This started RED-pinned with `it.fails(...)` (the repo's established
 * convention, e.g. WL-0MWGRKLLG0035PLG): it drives a four-root coordination
 * file whose offers are interleaved admissible/held and asserts the bound.
 * Against the old selection path it FAILED, because only the tick's selected
 * root was rotated and a held selected root was never charged, so the earliest
 * file-order admissible root won every slot (see
 * `downtime-worker.fairness-diagnosis.test.ts`). The fix item
 * (WL-0MWKY1839000JM5O) rotates the whole admissible candidate set and flipped
 * `it.fails(` → `it(` here — the scenario is unchanged.
 *
 * The run-length source is the decision log (the fairness-metric sibling's
 * single accounting source), so the second describe below seeds it directly to
 * prove the twice-in-succession bound defers the ceiling root, and that a
 * missing/corrupt log fails open to today's ordering.
 *
 * Deterministic: no live `wl`, no real coordination directory, injected clock.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dispatchFromCoordination,
  type DowntimeWorkerDeps,
  type DowntimeItemInfo,
} from './downtime-worker.js';
import {
  ROUND_ROBIN_BY_ROOT_FILE_NAME,
  loadRoundRobinCursor,
  type RoundRobinByRootData,
} from './downtime-round-robin-by-root.js';
import { deferRunLengthCeilingRoot } from './downtime-worker.fairness.js';
import { type CoordinationEntry } from './coordination.js';

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'herdr-fairness-invariant-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
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

/** A non-critical implement candidate (eligible unless a gate holds it). */
function implementItem(id: string): DowntimeItemInfo {
  return itemInfo({ id, status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'S' });
}

/** A prep candidate (never held by the review / CPU / slot gates). */
function planItem(id: string): DowntimeItemInfo {
  return itemInfo({ id, status: 'open', stage: 'intake_complete' });
}

function makeEntry(instanceId: string, workItemId: string, root: string): CoordinationEntry {
  const now = new Date().toISOString();
  return {
    instanceId,
    workItemId,
    directory: root,
    worklogRoot: root,
    assignedAt: now,
    lastUpdated: now,
  };
}

function makeDeps(overrides: Partial<DowntimeWorkerDeps> = {}): DowntimeWorkerDeps {
  return {
    getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    getAuditCandidateScope: vi.fn().mockResolvedValue({ ok: true, scope: 'parent' }),
    getNextImplementCandidate: vi.fn().mockResolvedValue(null),
    getNextCriticalCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [] }),
    claimItem: vi.fn().mockResolvedValue({ ok: true }),
    spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
    recordDispatch: vi.fn().mockResolvedValue(true),
    recordDispatchFailure: vi.fn().mockResolvedValue(undefined),
    rollbackClaim: vi.fn().mockResolvedValue(true),
    recordError: vi.fn().mockResolvedValue(undefined),
    getDueScheduledPrompt: vi.fn().mockResolvedValue(null),
    recordScheduledPromptTrigger: vi.fn().mockResolvedValue(true),
    readCodeFreezeStatus: vi.fn().mockReturnValue('not-frozen'),
    fetchItem: vi.fn().mockResolvedValue({ ok: true, info: itemInfo({ id: 'WL-X', stage: 'idea' }) }),
    getActiveAudit: vi.fn().mockResolvedValue({ ok: true, active: false }),
    getReviewQueueCount: vi.fn().mockResolvedValue(0),
    getRunningDowntimePanes: vi.fn().mockResolvedValue({ ok: true, count: 0, paneIds: [], records: [] }),
    ...overrides,
  } as DowntimeWorkerDeps;
}

/** Longest run of the same root in a dispatch sequence. */
function maxConsecutiveRun(sequence: readonly string[]): number {
  let best = 0;
  let cur = 1;
  for (let i = 1; i < sequence.length; i += 1) {
    if (sequence[i] === sequence[i - 1]) {
      cur += 1;
    } else {
      best = Math.max(best, cur);
      cur = 1;
    }
  }
  return sequence.length === 0 ? 0 : Math.max(best, cur);
}

describe('fairness invariant — four roots (parent AC1)', () => {
  it(
    'no root is dispatched more than twice in succession while a peer has an admissible offer',
    async () => {
      // Four roots, file order [A, B, C, D]. A and B are HELD (deep review
      // queue); C and D have admissible prep offers. A is the least recently
      // served, so it is selected on every tick and (being held) never charged
      // — the residual defect. Today the fall-through lands on C, the earliest
      // file-order admissible root, on every tick.
      const seed: RoundRobinByRootData = {
        '/repo/a': '2026-01-01T00:00:00.000Z', // oldest, HELD
        '/repo/b': '2026-01-02T00:00:00.000Z', // HELD
        '/repo/c': '2026-01-03T00:00:00.000Z', // admissible
        '/repo/d': '2026-01-04T00:00:00.000Z', // admissible
      };
      writeFileSync(join(testDir, ROUND_ROBIN_BY_ROOT_FILE_NAME), JSON.stringify(seed), 'utf-8');

      const baseNow = Date.UTC(2026, 0, 10, 0, 0, 0);
      const dispatchedRoot: string[] = [];

      for (let tick = 0; tick < 6; tick += 1) {
        const deps = makeDeps({
          // A and B are deep (held); C and D are shallow (admissible).
          getReviewQueueCount: vi.fn().mockImplementation(async (root: string) =>
            root === '/repo/a' || root === '/repo/b' ? 999 : 0,
          ),
          fetchItem: vi.fn().mockImplementation(async (id: string) => {
            if (id === 'WL-A' || id === 'WL-B') return { ok: true, info: implementItem(id) };
            return { ok: true, info: planItem(id) };
          }),
        });
        const entries = [
          makeEntry('inst-a', 'WL-A', '/repo/a'),
          makeEntry('inst-b', 'WL-B', '/repo/b'),
          makeEntry('inst-c', 'WL-C', '/repo/c'),
          makeEntry('inst-d', 'WL-D', '/repo/d'),
        ];
        const outcome = await dispatchFromCoordination(
          deps,
          entries,
          {
            model: 'plan',
            cwd: '/repo',
            coordinationDir: testDir,
            browseItemCount: 20,
            // Surplus capacity: no slot gate may explain a hold.
            freeSlots: 8,
            effectiveFreeSlots: 8,
          },
          baseNow + tick * 60_000,
        );
        expect(outcome.dispatched).toBe(true);
        const prompt = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        const root = prompt.includes('WL-C') ? '/repo/c' : prompt.includes('WL-D') ? '/repo/d' : 'other';
        dispatchedRoot.push(root);
      }

      // The bound under test: no root wins more than twice in succession.
      expect(maxConsecutiveRun(dispatchedRoot)).toBeLessThanOrEqual(2);
      // Both admissible roots must get a share (no starvation).
      expect(new Set(dispatchedRoot)).toEqual(new Set(['/repo/c', '/repo/d']));
    },
  );
});

// ── Run-length bound: the decision log is the single accounting source ──
//
// Parent AC1's bound is enforced from the fairness metric's ONLY run-length
// source (the decision log), never a second durable cursor. These specs seed
// the log directly: with a twice-dispatched root due, the order defers it
// behind an admissible peer; with no/less/corrupt history, or in the
// single-slot band, ordering stays exactly as today (fail-open).

/** Write a decision log holding `length` consecutive dispatches to `root`. */
function seedDecisionRun(cwd: string, root: string, length: number): void {
  mkdirSync(join(cwd, '.worklog'), { recursive: true });
  const lines: string[] = [];
  for (let i = 1; i <= length; i += 1) {
    lines.push(
      JSON.stringify({
        kind: 'decision',
        operation: 'dispatch',
        reason: 'dispatched',
        outcome: 'dispatched',
        dispatchingRoot: root,
        consecutiveRunLength: i,
        at: `2026-01-0${i}T00:00:00.000Z`,
      }),
    );
  }
  writeFileSync(
    join(cwd, '.worklog', 'downtime-coordination.log'),
    `${lines.join('\n')}\n`,
    'utf-8',
  );
}

/** Two plan-offering roots, `A` strictly due (oldest) and `B` newer. */
function twoPlanRootEntries(): CoordinationEntry[] {
  return [
    makeEntry('inst-a', 'WL-A', '/repo/a'),
    makeEntry('inst-b', 'WL-B', '/repo/b'),
  ];
}

function twoPlanRootDeps(): DowntimeWorkerDeps {
  return makeDeps({
    fetchItem: vi.fn().mockImplementation(async (id: string) => ({
      ok: true,
      info: planItem(id),
    })),
  });
}

const BASE_NOW = Date.UTC(2026, 0, 10, 0, 0, 0);

describe('run-length bound — decision log is the only accounting source (parent AC1)', () => {
  it('defers a root that already dispatched twice in succession behind an admissible peer', async () => {
    seedCursorForDeferral();
    seedDecisionRun(testDir, '/repo/a', 2);
    const deps = twoPlanRootDeps();

    const outcome = await dispatchFromCoordination(
      deps,
      twoPlanRootEntries(),
      {
        model: 'plan',
        cwd: testDir,
        coordinationDir: testDir,
        browseItemCount: 20,
        freeSlots: 8,
        effectiveFreeSlots: 8,
      },
      BASE_NOW,
    );

    expect(outcome.dispatched).toBe(true);
    const prompt = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain('WL-B');
    expect(prompt).not.toContain('WL-A');
    // Only the dispatching peer is charged; the deferred root keeps its due time.
    const cursor = loadRoundRobinCursor(testDir);
    expect(cursor['/repo/b']).toBe(new Date(BASE_NOW).toISOString());
    expect(cursor['/repo/a']).toBe('2026-01-01T00:00:00.000Z');
  });

  it('does not defer before the ceiling: a single previous dispatch keeps the due root first', async () => {
    seedCursorForDeferral();
    seedDecisionRun(testDir, '/repo/a', 1);
    const deps = twoPlanRootDeps();

    const outcome = await dispatchFromCoordination(
      deps,
      twoPlanRootEntries(),
      {
        model: 'plan',
        cwd: testDir,
        coordinationDir: testDir,
        browseItemCount: 20,
        freeSlots: 8,
        effectiveFreeSlots: 8,
      },
      BASE_NOW,
    );

    expect(outcome.dispatched).toBe(true);
    const prompt = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain('WL-A');
  });

  it('fails open with no decision log: the due root still dispatches (today’s ordering)', async () => {
    seedCursorForDeferral();
    const deps = twoPlanRootDeps();

    const outcome = await dispatchFromCoordination(
      deps,
      twoPlanRootEntries(),
      {
        model: 'plan',
        cwd: testDir,
        coordinationDir: testDir,
        browseItemCount: 20,
        freeSlots: 8,
        effectiveFreeSlots: 8,
      },
      BASE_NOW,
    );

    expect(outcome.dispatched).toBe(true);
    const prompt = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain('WL-A');
  });

  it('fails open on a corrupt decision log: ordering degrades and the tick still dispatches', async () => {
    seedCursorForDeferral();
    mkdirSync(join(testDir, '.worklog'), { recursive: true });
    writeFileSync(
      join(testDir, '.worklog', 'downtime-coordination.log'),
      'not-json{{{\n{"kind":\n',
      'utf-8',
    );
    const deps = twoPlanRootDeps();

    const outcome = await dispatchFromCoordination(
      deps,
      twoPlanRootEntries(),
      {
        model: 'plan',
        cwd: testDir,
        coordinationDir: testDir,
        browseItemCount: 20,
        freeSlots: 8,
        effectiveFreeSlots: 8,
      },
      BASE_NOW,
    );

    expect(outcome.dispatched).toBe(true);
    const prompt = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain('WL-A');
  });

  it('applies the bound only with surplus capacity: a single free slot keeps the due root first', async () => {
    seedCursorForDeferral();
    seedDecisionRun(testDir, '/repo/a', 2);
    const deps = twoPlanRootDeps();

    const outcome = await dispatchFromCoordination(
      deps,
      twoPlanRootEntries(),
      {
        model: 'plan',
        cwd: testDir,
        coordinationDir: testDir,
        browseItemCount: 20,
        freeSlots: 1,
        effectiveFreeSlots: 1,
      },
      BASE_NOW,
    );

    expect(outcome.dispatched).toBe(true);
    const prompt = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain('WL-A');
  });

  it('selection stays a pure read: a held tick leaves the cursor file byte-identical', async () => {
    const cursorPath = join(testDir, ROUND_ROBIN_BY_ROOT_FILE_NAME);
    writeFileSync(
      cursorPath,
      JSON.stringify({
        '/repo/a': '2026-01-01T00:00:00.000Z',
        '/repo/b': '2026-01-02T00:00:00.000Z',
      }),
      'utf-8',
    );
    const before = readFileSync(cursorPath, 'utf-8');
    const deps = makeDeps({
      // Both non-critical implement offers are genuinely gate-held.
      getReviewQueueCount: vi.fn().mockResolvedValue(999),
      fetchItem: vi.fn().mockImplementation(async (id: string) => ({
        ok: true,
        info: implementItem(id),
      })),
    });

    const outcome = await dispatchFromCoordination(
      deps,
      [
        makeEntry('inst-a', 'WL-A', '/repo/a'),
        makeEntry('inst-b', 'WL-B', '/repo/b'),
      ],
      {
        model: 'plan',
        cwd: testDir,
        coordinationDir: testDir,
        browseItemCount: 20,
        freeSlots: 8,
        effectiveFreeSlots: 8,
      },
      BASE_NOW,
    );

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('review-queue-hold');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(readFileSync(cursorPath, 'utf-8')).toBe(before);
  });
});

/** Seed the cursor so `/repo/a` is due (oldest) and `/repo/b` is newer. */
function seedCursorForDeferral(): void {
  writeFileSync(
    join(testDir, ROUND_ROBIN_BY_ROOT_FILE_NAME),
    JSON.stringify({
      '/repo/a': '2026-01-01T00:00:00.000Z',
      '/repo/b': '2026-01-03T00:00:00.000Z',
    }),
    'utf-8',
  );
}

describe('deferRunLengthCeilingRoot — pure ordering rule', () => {
  const order = ['/repo/a', '/repo/b', '/repo/c'];

  it('moves the ceiling root behind every peer', () => {
    expect(deferRunLengthCeilingRoot(order, { root: '/repo/a', length: 2 }, true)).toEqual([
      '/repo/b',
      '/repo/c',
      '/repo/a',
    ]);
  });

  it('defers a ceiling root found anywhere in the order (not just first)', () => {
    expect(deferRunLengthCeilingRoot(order, { root: '/repo/b', length: 3 }, true)).toEqual([
      '/repo/a',
      '/repo/c',
      '/repo/b',
    ]);
  });

  it('leaves the order untouched below the ceiling', () => {
    expect(deferRunLengthCeilingRoot(order, { root: '/repo/a', length: 1 }, true)).toEqual(order);
  });

  it('leaves the order untouched without surplus capacity', () => {
    expect(deferRunLengthCeilingRoot(order, { root: '/repo/a', length: 2 }, false)).toEqual(order);
  });

  it('leaves the order untouched when the ceiling root is not a candidate', () => {
    expect(
      deferRunLengthCeilingRoot(order, { root: '/repo/elsewhere', length: 2 }, true),
    ).toEqual(order);
  });

  it('leaves a single-candidate order untouched', () => {
    expect(deferRunLengthCeilingRoot(['/repo/a'], { root: '/repo/a', length: 2 }, true)).toEqual([
      '/repo/a',
    ]);
  });

  it('is pure: the input array is never mutated', () => {
    const input = [...order];
    deferRunLengthCeilingRoot(input, { root: '/repo/a', length: 2 }, true);
    expect(input).toEqual(order);
  });
});
