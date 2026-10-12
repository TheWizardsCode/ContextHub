/**
 * packages/herdr/src/downtime-worker.fixtures.ts — mock fixtures for the
 * downtime worker tests
 *
 * Covers every response class for `GET /llama/local/status` required by the
 * test contract (WL-0MSG7ZTC000163FL): idle (all slots free), busy (active
 * query / model switch / local lease / server down / not all slots free),
 * ambiguous (`total_slots` 0 or missing fields), and network error /
 * timeout / HTTP-failure responses for the poller tests (F2).
 *
 * Also hosts the shared test scaffolding (WL-0MV4V0V8Z003PBQ2): the
 * `makeDeps` mock factory, temporary-directory helpers, and downtime-log
 * writers, so every split test file imports one module instead of
 * re-implementing the same setup.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { vi } from 'vitest';

import { DOWNTIME_LOG_FILE } from './downtime-log.js';
import type { DowntimeWorkerDeps, LlamaStatus } from './downtime-worker.js';

// ── Status payloads ───────────────────────────────────────────────────

export const idleAllSlotsFree: LlamaStatus = {
  llama_server_running: true,
  local_active_query: false,
  model_switch_in_progress: false,
  local_lease_active: false,
  available_slots: 4,
  total_slots: 4,
  current_model: 'qwen3-8b',
  // Per-slot detail is the ONLY trusted availability source under the
  // fail-closed contract (WL-0MUXVPXAZ005RESW); an idle fixture therefore
  // carries a consistent all-free slot array.
  slots: [
    { slot_id: 'slot-1', is_processing: false },
    { slot_id: 'slot-2', is_processing: false },
    { slot_id: 'slot-3', is_processing: false },
    { slot_id: 'slot-4', is_processing: false },
  ],
  // Normalised owner-session list (WL-0MU88086A0089US4): always present on
  // the parsed status, empty when the proxy reports no owner.
  local_owner_session_ids: [],
};

export const busyActiveQuery: LlamaStatus = { ...idleAllSlotsFree, local_active_query: true };
export const busyModelSwitch: LlamaStatus = { ...idleAllSlotsFree, model_switch_in_progress: true };
export const busyLocalLease: LlamaStatus = { ...idleAllSlotsFree, local_lease_active: true };
export const busyServerNotRunning: LlamaStatus = { ...idleAllSlotsFree, llama_server_running: false };

/** available_slots < total_slots → busy with the default N=0 (all slots). */
export const busyNotAllSlotsFree: LlamaStatus = {
  ...idleAllSlotsFree,
  available_slots: 2,
  slots: [
    { slot_id: 'slot-1', is_processing: true },
    { slot_id: 'slot-2', is_processing: true },
    { slot_id: 'slot-3', is_processing: false },
    { slot_id: 'slot-4', is_processing: false },
  ],
};

/** `total_slots` 0 with everything else idle → ambiguous → busy. */
export const ambiguousZeroTotalSlots: LlamaStatus = {
  ...idleAllSlotsFree,
  available_slots: 0,
  total_slots: 0,
};

// ── Per-slot status payloads (WL-0MSG7P9N8009PCKG) ────────────────────

/** All 4 slots free, with per-slot identity served (LP-0MSG5TA7Y002GN39). */
export const perSlotAllFree: LlamaStatus = {
  ...idleAllSlotsFree,
  slots: [
    { slot_id: 'slot-1', is_processing: false },
    { slot_id: 'slot-2', is_processing: false },
    { slot_id: 'slot-3', is_processing: false },
    { slot_id: 'slot-4', is_processing: false },
  ],
};

/** Only 2 of 4 slots free (slot-3, slot-4 processing) with per-slot identity. */
export const perSlotTwoFree: LlamaStatus = {
  ...idleAllSlotsFree,
  available_slots: 2,
  slots: [
    { slot_id: 'slot-1', is_processing: false },
    { slot_id: 'slot-2', is_processing: false },
    { slot_id: 'slot-3', is_processing: true },
    { slot_id: 'slot-4', is_processing: true },
  ],
};

/** 3 of 4 slots free — only slot-1 processing. */
export const perSlotOneProcessing: LlamaStatus = {
  ...idleAllSlotsFree,
  available_slots: 3,
  slots: [
    { slot_id: 'slot-1', is_processing: true },
    { slot_id: 'slot-2', is_processing: false },
    { slot_id: 'slot-3', is_processing: false },
    { slot_id: 'slot-4', is_processing: false },
  ],
};

/**
 * 3 of 4 slots free — only slot-1 processing, with the GLOBAL query/lease
 * signals active (the processing slot IS the operator's active session;
 * spare-capacity dispatch must still fire into the 3 free slots).
 */
export const perSlotThreeOfFourFree: LlamaStatus = {
  ...perSlotOneProcessing,
  local_active_query: true,
  local_lease_active: true,
};

/**
 * 1 of 3 slots free (slot-3 free — the 3-slot proxy with an operator
 * session occupying a slot). Spare-capacity dispatch must NOT fire: N=2 of
 * 3 requires TWO slots continuously free (default N=2, parent AC1).
 */
export const perSlotOneOfThreeFree: LlamaStatus = {
  ...idleAllSlotsFree,
  available_slots: 1,
  total_slots: 3,
  slots: [
    { slot_id: 'slot-1', is_processing: true },
    { slot_id: 'slot-2', is_processing: true },
    { slot_id: 'slot-3', is_processing: false },
  ],
};

// ── Owner-lease / contention fixtures (WL-0MTYZXSLN008HZOW) ───────────

/**
 * A single-slot status that is IDLE but OWNED: the slot is not processing
 * yet a live Local Proxy lease is held (`owner_session_id`), so the slot
 * must NEVER be considered free for a new dispatch (AC2/AC5,
 * WL-0MTYZXSLN008HZOW).
 */
export const singleSlotIdleOwned: LlamaStatus = {
  ...idleAllSlotsFree,
  available_slots: 1,
  total_slots: 1,
  local_lease_active: true,
  local_owner_session_id: 'session-live-pane',
  local_owner_lease_remaining_seconds: 120,
  slots: [{ slot_id: 'slot-1', is_processing: false, owner_session_id: 'session-live-pane' }],
};

/**
 * Multi-slot status with an idle-but-owned slot: slot-1 is free by
 * `is_processing` but owned by a live lease, so only 2 of 3 slots are
 * genuinely free for dispatch.
 */
export const perSlotIdleOwned: LlamaStatus = {
  ...idleAllSlotsFree,
  available_slots: 3,
  total_slots: 3,
  local_lease_active: true,
  local_owner_session_id: 'session-live-pane',
  local_owner_lease_remaining_seconds: 120,
  slots: [
    { slot_id: 'slot-1', is_processing: false, owner_session_id: 'session-live-pane' },
    { slot_id: 'slot-2', is_processing: false },
    { slot_id: 'slot-3', is_processing: false },
  ],
};

/**
 * Multi-slot status where only ONE unowned slot is free: slot-1 is owned
 * (idle), slot-2 is processing, slot-3 is unowned-free. Per-slot mode with
 * N=2 must NOT be idle (only 1 genuinely free slot).
 */
export const perSlotOwnedOneUnowned: LlamaStatus = {
  ...idleAllSlotsFree,
  available_slots: 1,
  total_slots: 3,
  local_lease_active: true,
  local_owner_session_id: 'session-live-pane',
  local_owner_lease_remaining_seconds: 120,
  slots: [
    { slot_id: 'slot-1', is_processing: false, owner_session_id: 'session-live-pane' },
    { slot_id: 'slot-2', is_processing: true },
    { slot_id: 'slot-3', is_processing: false },
  ],
};

/**
 * Idle status where the proxy reports queued (contending) local requests:
 * the CURRENT queue depth (`contention_queue_depth`) is > 0, so the
 * dispatcher must back off (AC6, WL-0MTYZXSLN008HZOW).
 */
export const idleWithContention: LlamaStatus = {
  ...idleAllSlotsFree,
  contention_queue_depth: 3,
};

/**
 * The wedge regression fixture (WL-0MU1DWXO600153OI): the proxy's
 * CUMULATIVE `contention_queued_count` is > 0 (left over from past queue
 * events) while the LIVE `contention_queue_depth` is 0 (nothing queued
 * now) and the slot is free. The dispatcher must treat this as idle and
 * dispatch — the cumulative counter is telemetry only, never a gate.
 */
export const idleWithCumulativeContention: LlamaStatus = {
  ...idleAllSlotsFree,
  contention_queue_depth: 0,
  contention_queued_count: 13,
};

/** Raw `herdr pane list` output with two live downtime panes + noise. */
export const herdrPaneListRaw: string = JSON.stringify({
  id: 'cli:pane:list',
  result: {
    panes: [
      {
        pane_id: 'w1:p1',
        label: 'Downtime triggered implement Some item - WL-ABC',
        agent: 'pi',
        agent_status: 'working',
      },
      {
        pane_id: 'w1:p2',
        label: 'Downtime triggered audit Another item - WL-DEF',
        agent: 'pi',
        agent_status: 'idle',
      },
      {
        pane_id: 'w1:p3',
        label: 'Manually triggered implement Foo - WL-XYZ',
        agent: 'pi',
        agent_status: 'working',
      },
      { pane_id: 'w1:p4', label: 'Work Items', agent_status: 'unknown' },
      {
        pane_id: 'w1:p5',
        label: 'Downtime triggered plan Finished - WL-GHI',
        agent: 'pi',
        agent_status: 'done',
      },
    ],
  },
});

/** Raw (unparsed) response missing the numeric slot fields → ambiguous. */
export const ambiguousMissingFieldsRaw: Record<string, unknown> = {
  llama_server_running: true,
  current_model: 'qwen3-8b',
};

export interface LlamaStatusFixture {
  name: string;
  status: LlamaStatus;
  /** Expected classification with requiredFreeSlots = 0 (all slots). */
  expectedIdle: boolean;
  note: string;
}

/** The corpus used by the fixture-coherence test. */
export const statusFixtures: LlamaStatusFixture[] = [
  {
    name: 'idle: all slots free',
    status: idleAllSlotsFree,
    expectedIdle: true,
    note: 'server up, no query/switch/lease, all 4/4 slots free',
  },
  {
    name: 'busy: local active query',
    status: busyActiveQuery,
    expectedIdle: false,
    note: 'local_active_query true',
  },
  {
    name: 'busy: model switch in progress',
    status: busyModelSwitch,
    expectedIdle: false,
    note: 'model_switch_in_progress true',
  },
  {
    name: 'busy: local lease active',
    status: busyLocalLease,
    expectedIdle: false,
    note: 'local_lease_active true',
  },
  {
    name: 'busy: server not running',
    status: busyServerNotRunning,
    expectedIdle: false,
    note: 'llama_server_running false',
  },
  {
    name: 'busy: not all slots free',
    status: busyNotAllSlotsFree,
    expectedIdle: false,
    note: 'available 2 < total 4 → busy with N=0 (all slots)',
  },
  {
    name: 'ambiguous: total_slots 0',
    status: ambiguousZeroTotalSlots,
    expectedIdle: false,
    note: 'total_slots 0 → ambiguous → busy',
  },
];

// ── HTTP response / error fixtures (poller tests, F2) ─────────────────

/**
 * Minimal structural Response for the poller contract (the DOM `Response`
 * type is not part of this project's tsconfig lib). Node's real `Response`
 * satisfies the shape at runtime.
 */
export interface LlamaStatusHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export function jsonResponseFixture(body: unknown, status = 200): LlamaStatusHttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

export const httpErrorResponseFixture: LlamaStatusHttpResponse = jsonResponseFixture(
  { error: 'boom' },
  500,
);

/** fetch() rejecting (connection refused / DNS failure). */
export const networkErrorFixture: Error = Object.assign(new Error('fetch failed'), {
  name: 'TypeError',
});

/** fetch() aborting on timeout. */
export const timeoutErrorFixture: Error = Object.assign(
  new Error('The operation was aborted'),
  { name: 'AbortError' },
);

// ── Shared test scaffolding (WL-0MV4V0V8Z003PBQ2) ─────────────────────

// ── Per-test mock budget (WL-0MV4VSNI00002WFM) ────────────────────────
//
// The split downtime-worker suite allows at most **5** `vi.fn()` calls per
// `it()`/`test()` block. The ~20 mocks `makeDeps()` creates are shared
// infrastructure and are excluded — the budget bounds the *per-test
// overrides* a reader must hold in their head, which is where the original
// 13k-line file's 664 mocks came from.
//
// Rationale: analysis of the 718 split tests found an average of ~5.2 mocks
// per original describe block and a maximum of 6 per test. A cap of 5 keeps
// every focused test green while forcing genuinely overloaded tests to
// extract setup (the two original 6-mock tests now share a helper instead).
//
// Enforcement: `npm run test:mock-budget` (`scripts/check-mock-budget.ts`,
// Option B of the intake) parses each `downtime-worker*.test.ts` with the
// TypeScript compiler API and fails when any test exceeds the cap. The same
// check runs in the unit suite (`tests/unit/mock-budget.test.ts`), so it is
// part of the normal test gate. Extract extra setup into this module (or a
// local helper) rather than raising the cap.

/**
 * Default mocked `DowntimeWorkerDeps` for dispatch tests, with every dep
 * answering a neutral "nothing to do" result so a test only overrides the
 * dep it exercises. Merges `overrides` over the defaults (last write wins).
 */
export function makeDeps(overrides: Partial<DowntimeWorkerDeps> = {}): DowntimeWorkerDeps {
  return {
    // Herdr list head (WL-0MTK1ILM2009QYB2): empty by default so legacy tests that
    // stub per-tier lookups keep passing (the head path is inert on empty).
    getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [] }),
    getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    // Audit tier answers a GENUINELY empty tier by default ({ok:true,
    // candidate:null}); a wl/parse failure is {ok:false} (WL-0MSLWJ2KP0002SV0).
    getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    // Active-audit single-flight (WL-0MT3PHW4I002SNOV): no active audit by
    // default ({ok:true, active:false}), so the existing tier tests exercise
    // the unchanged audit tier (backward-compatible default — the audit
    // tier proceeds). The dispatcher consults this dep only after F2 lands;
    // existing tests are unaffected either way.
    getActiveAudit: vi.fn().mockResolvedValue({ ok: true, active: false }),
    getNextImplementCandidate: vi.fn().mockResolvedValue(null),
    claimItem: vi.fn().mockResolvedValue({ ok: true }),
    spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
    recordDispatch: vi.fn().mockResolvedValue(true),
    recordDispatchFailure: vi.fn().mockResolvedValue(undefined),
    // Claim rollback (WL-0MT32F908002YFFA): default success so the recovery
    // paths report 'claim-rolled-back' unless a test forces a failed rollback.
    rollbackClaim: vi.fn().mockResolvedValue(true),
    recordError: vi.fn().mockResolvedValue(undefined),
    // Scheduled-prompts tier (WL-0MSS1Q5ER007QDKX): no due prompt by
    // default, so existing tier tests exercise the unchanged backlog tiers.
    getDueScheduledPrompt: vi.fn().mockResolvedValue(null),
    recordScheduledPromptTrigger: vi.fn().mockResolvedValue(true),
    // Critical-first tier (WL-0MT3FM8VA005XBHE): no critical candidate by
    // default, so the existing tier tests exercise the unchanged backlog
    // tiers (regression guard — after F4 the critical tier must fall
    // through to implement → plan → intake when the critical tier is
    // genuinely empty).
    getNextCriticalCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    // Code-freeze gate (WL-0MSQ0RPQP00636JY): not frozen by default, so
    // existing dispatch tests exercise the unchanged audit/implement tiers.
    readCodeFreezeStatus: vi.fn().mockReturnValue('not-frozen'),
    // Interim freshness re-check (WL-0MT8KSTOE00871E7): no fresh audit by
    // default, so existing dispatch tests exercise the unchanged path.
    hasFreshAudit: vi.fn().mockResolvedValue(false),
    // Review-queue depth gate (WL-0MT2UQWOR007CYY9): empty queue by default
    // so the gate is inactive and existing tests exercise the unchanged path.
    getReviewQueueCount: vi.fn().mockResolvedValue(0),
    // Item-scoped in-flight guard (WL-0MUBEZ6PE002WLP4 / F3): an available
    // query reporting NO live panes by default, so the guard is inert and
    // existing tests escalate critical items unchanged. Tests that exercise
    // the guard override this with `records` carrying a live working pane.
    getRunningDowntimePanes: vi.fn().mockResolvedValue({ ok: true, count: 0, paneIds: [], records: [] }),
    ...overrides,
  };
}

/**
 * Create a unique temporary directory under the OS temp root, prefixed with
 * `prefix`. The caller owns cleanup; prefer `createTempDirTracker()` when a
 * describe block creates several directories.
 */
export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Registry returned by `createTempDirTracker()`. */
export interface TempDirTracker {
  /** Create, remember and return a new unique temp directory. */
  make(prefix: string): string;
  /** Remove every directory created by this tracker (idempotent). */
  cleanup(): void;
}

/**
 * Per-describe temporary-directory registry: `make()` creates a unique temp
 * directory and records it, `cleanup()` removes them all (call it from
 * `afterEach`). Centralises the `mkdtempSync` + `rmSync` boilerplate that was
 * duplicated across describe blocks.
 */
export function createTempDirTracker(): TempDirTracker {
  const dirs: string[] = [];
  return {
    make(prefix: string): string {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      dirs.push(dir);
      return dir;
    },
    cleanup(): void {
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * ISO timestamp for a moment `ms` milliseconds in the past. Dispatch paths
 * read the real `Date.now()`, so tests that seed dispatch markers use this
 * rather than a fake clock.
 */
export function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

/**
 * Write a raw string to the downtime dispatch log at
 * `<cwd>/.worklog/<DOWNTIME_LOG_FILE>`, creating the `.worklog` directory
 * when absent.
 */
export function writeRawDowntimeLog(cwd: string, raw: string): void {
  mkdirSync(join(cwd, '.worklog'), { recursive: true });
  writeFileSync(join(cwd, '.worklog', DOWNTIME_LOG_FILE), raw, 'utf8');
}

/**
 * Write `entries` to the downtime dispatch log as JSONL (one JSON object per
 * line, trailing newline), creating the `.worklog` directory when absent.
 */
export function writeDowntimeLog(cwd: string, entries: Array<Record<string, unknown>>): void {
  writeRawDowntimeLog(cwd, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
