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
 * This is RED-pinned with `it.fails(...)` (the repo's established convention,
 * e.g. WL-0MWGRKLLG0035PLG): it drives a four-root coordination file whose
 * offers are interleaved admissible/held and asserts the bound. Against the
 * current selection path it FAILS, because only the tick's selected root is
 * rotated and a held selected root is never charged, so the earliest
 * file-order admissible root wins every slot (see
 * `downtime-worker.fairness-diagnosis.test.ts`). The fix item
 * (WL-0MWKY1839000JM5O) rotates the whole admissible candidate set and flips
 * `it.fails(` → `it(` here — do NOT delete the scenario.
 *
 * Deterministic: no live `wl`, no real coordination directory, injected clock.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dispatchFromCoordination,
  type DowntimeWorkerDeps,
  type DowntimeItemInfo,
} from './downtime-worker.js';
import {
  ROUND_ROBIN_BY_ROOT_FILE_NAME,
  type RoundRobinByRootData,
} from './downtime-round-robin-by-root.js';
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
  // RED-pinned: fails on the current selection path; the fix item flips it.
  it.fails(
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
