/**
 * packages/herdr/src/downtime-worker.parse.test.ts — parse helpers, clamp
 * functions, dispatch-log provenance, and per-slot owner-lease gate tests
 *
 * Split out of the monolithic `downtime-worker.test.ts`
 * (WL-0MV28X3SL005R5KX / WL-0MV4VOH5R004XLD8) to keep each test file focused
 * on one concern.
 *
 * Covers the parsing and clamping surface, plus the related per-slot
 * owner-lease gate:
 *   - `parseLlamaStatus` contention fields and per-slot owner parsing,
 *   - `parseLlamaStatus` `local_owner_session_id` array/legacy
 *     normalisation (WL-0MU88086A0089US4),
 *   - `clampDowntimeMarkerStaleWindowMs`,
 *   - the dispatch-log selection path/reason + pane-id enrichment
 *     (WL-0MUBVL251006JAQ0 / F6), and
 *   - the per-slot owner-lease gate in `tick()` (WL-0MU8807BI008C9ME).
 *
 * Shared scaffolding (`makeDeps`, `jsonResponseFixture`, etc.) is imported
 * from `downtime-worker.fixtures.ts`; no setup logic is re-implemented here.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi } from 'vitest';
import {
  parseLlamaStatus,
  reportedIdleSeconds,
  dispatchDowntimeWork,
  createDowntimePoller,
  createDowntimeWorker,
  clampDowntimeMarkerStaleWindowMs,
  DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS,
  type LlamaStatus,
  type DowntimeHerdrItem,
} from './downtime-worker.js';
import {
  jsonResponseFixture,
  makeDeps,
  prefillIdleUncalibrated,
  prefillPacingStatus,
} from './downtime-worker.fixtures.js';
import {
  appendDowntimeLogEntry,
  readDowntimeLogEntries,
} from './downtime-log.js';

// ── Owner lease + contention + pane liveness (parent WL-0MTYZXSLN008HZOW,
//    pane bound removed by WL-0MU2EP6JL006A1U3) ──────────────────────
//
// Regression suite for single-slot over-dispatch. The dispatcher must honour
// the Local Proxy owner lease, exclude owned slots from the free count, and
// back off on proxy contention. The RUNNING-PANE BOUND that was added
// alongside these is deliberately GONE (WL-0MU2EP6JL006A1U3): dispatched
// panes stay open until an operator closes them, so a live-pane count can
// never be the concurrency limiter — the LLM idle check is.

describe('parseLlamaStatus: contention + per-slot owner (AC5/AC6)', () => {
  const base = {
    llama_server_running: true,
    local_active_query: false,
    model_switch_in_progress: false,
    local_lease_active: false,
    available_slots: 1,
    total_slots: 1,
  };

  it('parses contention_queue_depth (the live gate signal) when served', () => {
    const status = parseLlamaStatus({ ...base, contention_queue_depth: 4 });
    expect(status).not.toBeNull();
    expect(status!.contention_queue_depth).toBe(4);
  });

  it('leaves contention_queue_depth undefined when absent (backward compatible)', () => {
    const status = parseLlamaStatus(base);
    expect(status).not.toBeNull();
    expect(status!.contention_queue_depth).toBeUndefined();
  });

  it('treats a negative or non-finite contention_queue_depth as ambiguous → busy', () => {
    expect(parseLlamaStatus({ ...base, contention_queue_depth: -1 })).toBeNull();
    expect(parseLlamaStatus({ ...base, contention_queue_depth: Number.NaN })).toBeNull();
    expect(parseLlamaStatus({ ...base, contention_queue_depth: 'many' })).toBeNull();
  });

  it('parses the cumulative contention_queued_count as telemetry (not a gate)', () => {
    const status = parseLlamaStatus({ ...base, contention_queued_count: 13 });
    expect(status).not.toBeNull();
    expect(status!.contention_queued_count).toBe(13);
  });

  it('leaves contention_queued_count undefined when absent (backward compatible)', () => {
    const status = parseLlamaStatus(base);
    expect(status).not.toBeNull();
    expect(status!.contention_queued_count).toBeUndefined();
  });

  it('treats a negative or non-finite contention_queued_count as ambiguous → busy', () => {
    expect(parseLlamaStatus({ ...base, contention_queued_count: -1 })).toBeNull();
    expect(parseLlamaStatus({ ...base, contention_queued_count: Number.NaN })).toBeNull();
    expect(parseLlamaStatus({ ...base, contention_queued_count: 'many' })).toBeNull();
  });

  it('keeps the live depth distinct from the cumulative count', () => {
    const status = parseLlamaStatus({
      ...base,
      contention_queue_depth: 0,
      contention_queued_count: 13,
    });
    expect(status).not.toBeNull();
    expect(status!.contention_queue_depth).toBe(0);
    expect(status!.contention_queued_count).toBe(13);
  });

  it('parses a per-slot owner_session_id', () => {
    const status = parseLlamaStatus({
      ...base,
      slots: [{ slot_id: 'slot-1', is_processing: false, owner_session_id: 'sess-1' }],
    });
    expect(status).not.toBeNull();
    expect(status!.slots![0].owner_session_id).toBe('sess-1');
  });

  it('omits owner_session_id from the slot shape when absent (backward compatible)', () => {
    const status = parseLlamaStatus({
      ...base,
      slots: [{ slot_id: 'slot-1', is_processing: false }],
    });
    expect(status).not.toBeNull();
    expect(status!.slots![0]).toEqual({ slot_id: 'slot-1', is_processing: false });
  });
});

// ── clampDowntimeMarkerStaleWindowMs (WL-0MU6UL0RJ008IHGT AC3) ────────

describe('clampDowntimeMarkerStaleWindowMs', () => {
  it('defaults on non-finite/negative input', () => {
    expect(clampDowntimeMarkerStaleWindowMs(NaN)).toBe(DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS);
    expect(clampDowntimeMarkerStaleWindowMs(-1)).toBe(DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS);
    expect(clampDowntimeMarkerStaleWindowMs(0)).toBe(60 * 60 * 1000); // clamped to 1h floor
  });

  it('clamps into the documented [1h, 7d] range', () => {
    expect(clampDowntimeMarkerStaleWindowMs(30 * 60 * 1000)).toBe(60 * 60 * 1000); // below floor
    expect(clampDowntimeMarkerStaleWindowMs(8 * 24 * 60 * 60 * 1000)).toBe(7 * 24 * 60 * 60 * 1000); // above ceiling
    const mid = 6 * 60 * 60 * 1000;
    expect(clampDowntimeMarkerStaleWindowMs(mid)).toBe(mid);
  });
});

// ── Dispatch-log selection provenance + pane enrichment (F6) ───────────
// WL-0MUBVL251006JAQ0 (parent WL-0MUBEZ6PE002WLP4, AC6.1–AC6.3).

describe('dispatch log: selection path/reason + pane id enrichment (WL-0MUBVL251006JAQ0 / F6)', () => {
  const critical = (): DowntimeHerdrItem => ({
    id: 'CR-SEL', title: 'Crit sel', status: 'open', stage: 'plan_complete',
    risk: 'Low', effort: 'S', priority: 'critical', sortIndex: 10,
  });
  const nonCritical = (): DowntimeHerdrItem => ({
    id: 'IMP-SEL', title: 'Impl sel', status: 'open', stage: 'plan_complete',
    risk: 'Low', effort: 'S', priority: 'high', sortIndex: 100,
  });

  it('AC6.1: a critical-first dispatch records selectionPath/selectionReason', async () => {
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [critical()] }),
      recordDispatch: vi.fn().mockResolvedValue(true),
    });

    await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    // Observable contract: recordDispatch boundary dep — selectionPath/selectionReason payload is the observable audit-log contract
    expect(deps.recordDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'CR-SEL',
        selectionPath: 'critical-first',
        selectionReason: 'no-live-pane',
      }),
    );
  });

  it('AC6.1: a normal-scan dispatch records selectionPath/selectionReason', async () => {
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [nonCritical()] }),
      recordDispatch: vi.fn().mockResolvedValue(true),
    });

    await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    // Observable contract: recordDispatch boundary dep — selectionPath/selectionReason payload is the observable audit-log contract
    expect(deps.recordDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'IMP-SEL',
        selectionPath: 'normal-scan',
        selectionReason: 'non-critical',
      }),
    );
  });

  it('AC6.2/AC6.3: a successful dispatch appends an enrichment entry with the resolved paneId, preserving marker fields', async () => {
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [critical()] }),
      recordDispatch: vi.fn().mockResolvedValue(true),
      recordDispatchEnrichment: vi.fn().mockResolvedValue(undefined),
      // 1st call (pre-spawn in-flight guard): no pane. 2nd call (post-spawn
      // enrichment resolver): the pane is live.
      getRunningDowntimePanes: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, count: 0, paneIds: [], records: [] })
        .mockResolvedValue({
          ok: true, count: 1, paneIds: ['w1:p1'],
          records: [{ paneId: 'w1:p1', label: 'Downtime triggered implement Crit sel - CR-SEL', agent: 'pi', agentStatus: 'working' }],
        }),
    });

    await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    const markerCall = (deps.recordDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const enrichCall = (deps.recordDispatchEnrichment as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(enrichCall).toMatchObject({
      itemId: markerCall.itemId,
      kind: markerCall.kind,
      stage: markerCall.stage,
      dispatchedAt: markerCall.dispatchedAt,
      paneId: 'w1:p1',
      enrichment: true,
      noItemComment: true,
    });
  });

  it('AC6.3: an unresolved pane id is recorded as null, and the dispatch still succeeds', async () => {
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [critical()] }),
      recordDispatch: vi.fn().mockResolvedValue(true),
      recordDispatchEnrichment: vi.fn().mockResolvedValue(undefined),
      getRunningDowntimePanes: vi.fn().mockResolvedValue({ ok: true, count: 0, paneIds: [], records: [] }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect((deps.recordDispatchEnrichment as ReturnType<typeof vi.fn>).mock.calls[0][0].paneId).toBeNull();
  });

  it('AC6.3: a throwing enrichment dep never affects the dispatch outcome (fail-open)', async () => {
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [critical()] }),
      recordDispatch: vi.fn().mockResolvedValue(true),
      recordDispatchEnrichment: vi.fn().mockRejectedValue(new Error('boom')),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });

  it('AC6.3: an absent enrichment dep is a no-op (legacy callers unchanged)', async () => {
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [critical()] }),
      recordDispatch: vi.fn().mockResolvedValue(true),
    });
    // makeDeps omits recordDispatchEnrichment by default.
    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });
    expect(outcome.dispatched).toBe(true);
  });
});
// ── AC Tests: per-slot owner-lease gate (WL-0MU8807BI008C9ME) ──────────

// ── parseLlamaStatus: array local_owner_session_id (blocking dep fix) ──

describe('parseLlamaStatus: array local_owner_session_id (WL-0MU88086A0089US4)', () => {
  function makeBase(): Record<string, unknown> {
    return {
      llama_server_running: true,
      local_active_query: false,
      model_switch_in_progress: false,
      local_lease_active: false,
      available_slots: 3,
      total_slots: 3,
      contention_queue_depth: 0,
      contention_queued_count: 0,
    };
  }

  it('AC1: legacy string payload preserves the owner (WL-0MU88086A0089US4)', () => {
    const raw = {
      ...makeBase(),
      local_owner_session_id: 'herdr-1789775322-722064-10708',
    };
    const result = parseLlamaStatus(raw);
    expect(result).not.toBeNull();
    expect(result!.local_owner_session_id).toBe('herdr-1789775322-722064-10708');
  });

  it('AC2: current 2-element array payload parses; URL element ignored, session recovered', () => {
    const raw = {
      ...makeBase(),
      local_lease_active: undefined, // omit so it derives from array/lease_seconds
      local_owner_session_id: ['http://localhost:8080', 'herdr-1789775322-722064-10708'],
      local_owner_lease_remaining_seconds: 30,
    };
    const result = parseLlamaStatus(raw);
    expect(result).not.toBeNull();
    // The session ID (2nd element) is extracted; the URL (1st element) is dropped.
    expect(result!.local_owner_session_id).toBe('herdr-1789775322-722064-10708');
    // local_lease_active derives from lease_seconds > 0.
    expect(result!.local_lease_active).toBe(true);
  });

  it('AC3: malformed owner (number) → fail-closed (busy / undefined), no throw', () => {
    const raw = {
      ...makeBase(),
      local_owner_session_id: 42,
    };
    const result = parseLlamaStatus(raw);
    // A non-string, non-array number is ambiguous → undefined for this field.
    expect(result).not.toBeNull();
    expect(result!.local_owner_session_id).toBeUndefined();
  });

  it('AC3b: malformed owner (object) → fail-closed', () => {
    const raw = {
      ...makeBase(),
      local_owner_session_id: { id: 'bad' },
    };
    const result = parseLlamaStatus(raw);
    expect(result).not.toBeNull();
    expect(result!.local_owner_session_id).toBeUndefined();
  });

  it('AC3c: malformed owner (empty array) → fail-closed', () => {
    const raw = {
      ...makeBase(),
      local_owner_session_id: [],
    };
    const result = parseLlamaStatus(raw);
    expect(result).not.toBeNull();
    expect(result!.local_owner_session_id).toBeUndefined();
  });

  it('AC4: contract test pins exact array shape [url, session]', () => {
    // Reproduces the exact live-proxy shape observed on 2026-09-19.
    const raw = {
      ...makeBase(),
      local_owner_session_id: ['http://localhost:8080', 'herdr-1789776793-744802-10480'],
      local_owner_lease_remaining_seconds: 29.99,
    };
    const result = parseLlamaStatus(raw);
    expect(result).not.toBeNull();
    expect(result!.local_owner_session_id).toBe('herdr-1789776793-744802-10480');
  });

  it('AC5: fetchLocalStatus never throws on array shape', async () => {
    const arrayPayload = {
      ...makeBase(),
      local_owner_session_id: ['http://localhost:8080', 'herdr-test'],
    };
    const poller = createDowntimePoller(
      'http://proxy:8000',
      vi.fn().mockResolvedValue(jsonResponseFixture(arrayPayload)),
    );
    const worker = createDowntimeWorker({
      poller,
      deps: makeDeps(),
      config: () => ({
        enabled: true,
        thresholdMs: 0,
        requiredFreeSlots: 0,
        model: 'plan',
        cwd: '/repo',
        noCandidateCooldownMs: 3_600_000,
      }),
    });
    // Should not throw — poller must handle the array shape.
    const result = await worker.tick();
    expect(result).toBeDefined();
  });
});

describe('parseLlamaStatus: local_owner_session_ids normalization (WL-0MU88086A0089US4)', () => {
  function makeBase(): Record<string, unknown> {
    return {
      llama_server_running: true,
      local_active_query: false,
      model_switch_in_progress: false,
      local_lease_active: false,
      available_slots: 3,
      total_slots: 3,
      contention_queue_depth: 0,
      contention_queued_count: 0,
    };
  }

  it('captures every session in the array and drops the proxy URL element', () => {
    const result = parseLlamaStatus({
      ...makeBase(),
      local_owner_session_id: ['http://localhost:8080', 'session-a', 'session-b'],
    });
    expect(result).not.toBeNull();
    expect(result!.local_owner_session_ids).toEqual(['session-a', 'session-b']);
    expect(result!.local_owner_session_id).toBe('session-a');
  });

  it('normalises a legacy string owner to a single-element array', () => {
    const result = parseLlamaStatus({
      ...makeBase(),
      local_owner_session_id: 'legacy-session',
    });
    expect(result).not.toBeNull();
    expect(result!.local_owner_session_ids).toEqual(['legacy-session']);
    expect(result!.local_owner_session_id).toBe('legacy-session');
  });

  it('yields an empty owner list for malformed input (fail-closed, no throw)', () => {
    const malformedInputs: unknown[] = [
      42,
      { id: 'bad' },
      [],
      ['http://localhost:8080'],
      [42],
      ['http://localhost:8080', 42],
    ];
    for (const malformed of malformedInputs) {
      const result = parseLlamaStatus({
        ...makeBase(),
        local_owner_session_id: malformed,
      });
      expect(result).not.toBeNull();
      expect(result!.local_owner_session_ids).toEqual([]);
      expect(result!.local_owner_session_id).toBeUndefined();
    }
  });

  it('marks local_lease_active from a multi-session array even without lease seconds', () => {
    const result = parseLlamaStatus({
      ...makeBase(),
      local_lease_active: undefined,
      local_owner_session_id: ['http://localhost:8080', 'session-a', 'session-b'],
    });
    expect(result).not.toBeNull();
    expect(result!.local_lease_active).toBe(true);
  });
});

// ── Per-slot owner-lease gate in tick() (WL-0MU8807BI008C9ME AC1-AC4) ──

describe('tick(): owner-lease gate must be per-slot (WL-0MU8807BI008C9ME)', () => {
  function makePerSlotWorker(opts: {
    status: LlamaStatus;
    runningPanes: () => { ok: true; count: number } | { ok: false; error?: string };
    requiredFreeSlots?: number;
  }) {
    const cfg = {
      enabled: true,
      thresholdMs: 1_000,
      requiredFreeSlots: opts.requiredFreeSlots ?? 2,
      model: 'plan',
      cwd: '/repo',
      noCandidateCooldownMs: 3_600_000,
      browseItemCount: 20,
    };
    const poller = createDowntimePoller(
      'http://proxy:8000',
      vi.fn().mockResolvedValue(jsonResponseFixture(opts.status)),
    );
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
      }),
      getRunningDowntimePanes: vi.fn().mockImplementation(async () => opts.runningPanes()),
    });
    const worker = createDowntimeWorker({ poller, deps, config: () => ({ ...cfg }) });
    return { worker, deps };
  }

  it('AC1: per-slot 3-slots: 1 owned+busy, 2 free unowned, held lease + runningPanes → dispatch proceeds (RCA regression)', async () => {
    // Regression for the overnight stall: cheap mode (3 slots), one slot
    // owned by a dispatched agent, 2 free unowned → dispatch MUST fire.
    vi.useFakeTimers();
    try {
      const ownedSlot = 'http://localhost:8080';
      const status: LlamaStatus = {
        llama_server_running: true,
        local_active_query: false,
        model_switch_in_progress: false,
        local_lease_active: true,
        available_slots: 2,
        total_slots: 3,
        local_owner_session_id: ownedSlot,
        local_owner_lease_remaining_seconds: 120,
        slots: [
          { slot_id: 'slot-1', is_processing: true, owner_session_id: ownedSlot },
          { slot_id: 'slot-2', is_processing: false },
          { slot_id: 'slot-3', is_processing: false },
        ],
        contention_queue_depth: 0,
        contention_queued_count: 0,
      };
      const { worker, deps } = makePerSlotWorker({
        status,
        runningPanes: () => ({ ok: true, count: 1 }),
        requiredFreeSlots: 2,
      });
      const start = 1_000_000;
      vi.setSystemTime(start);
      await worker.tick(); // first tick — establish idle baseline
      vi.setSystemTime(start + 5_000);
      const outcome = await worker.tick();
      // THE FIX: dispatch MUST proceed because 2 free unowned slots exist.
      expect(outcome.dispatched).toBe(true);
      expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('AC2: count-based status (no slots), owner lease held, runningPanes > 0 → dispatch refused (single-slot protection preserved)', async () => {
    vi.useFakeTimers();
    try {
      const status: LlamaStatus = {
        llama_server_running: true,
        local_active_query: false,
        model_switch_in_progress: false,
        local_lease_active: true,
        available_slots: 1,
        total_slots: 1,
        local_owner_session_id: 'session-live',
        local_owner_lease_remaining_seconds: 120,
      };
      // No `slots` array → count-based mode.
      const { worker, deps } = makePerSlotWorker({
        status,
        runningPanes: () => ({ ok: true, count: 1 }),
      });
      const start = 1_000_000;
      vi.setSystemTime(start);
      await worker.tick();
      vi.setSystemTime(start + 5_000);
      const blocked = await worker.tick();
      expect(blocked.dispatched).toBe(false);
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('AC3: per-slot status where every slot is owned → dispatch refused', async () => {
    vi.useFakeTimers();
    try {
      const ownerA = 'http://localhost:8080';
      const ownerB = 'http://localhost:8081';
      const ownerC = 'http://localhost:8082';
      const status: LlamaStatus = {
        llama_server_running: true,
        local_active_query: false,
        model_switch_in_progress: false,
        local_lease_active: true,
        available_slots: 0,
        total_slots: 3,
        local_owner_session_id: ownerA,
        local_owner_lease_remaining_seconds: 60,
        // AC3: EVERY slot carries a live owner lease, including slot-3 which
        // is idle by `is_processing` but owned. countFreeUnownedSlots === 0
        // is the per-slot gate signal — the worker must refuse.
        slots: [
          { slot_id: 'slot-1', is_processing: true, owner_session_id: ownerA },
          { slot_id: 'slot-2', is_processing: true, owner_session_id: ownerB },
          { slot_id: 'slot-3', is_processing: false, owner_session_id: ownerC },
        ],
        contention_queue_depth: 0,
        contention_queued_count: 0,
      };
      const { worker, deps } = makePerSlotWorker({
        status,
        runningPanes: () => ({ ok: true, count: 1 }),
        requiredFreeSlots: 2,
      });
      const start = 1_000_000;
      vi.setSystemTime(start);
      await worker.tick();
      vi.setSystemTime(start + 5_000);
      const blocked = await worker.tick();
      expect(blocked.dispatched).toBe(false);
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('AC4: audit-tier minimum (DOWNTIME_AUDIT_MIN_FREE_SLOTS = 2) evaluated against per-slot unowned-free count', async () => {
    vi.useFakeTimers();
    try {
      // Only 1 free unowned slot — below audit-tier minimum of 2.
      const status: LlamaStatus = {
        llama_server_running: true,
        local_active_query: false,
        model_switch_in_progress: false,
        local_lease_active: true,
        available_slots: 1,
        total_slots: 3,
        local_owner_session_id: 'http://localhost:8080',
        local_owner_lease_remaining_seconds: 60,
        slots: [
          { slot_id: 'slot-1', is_processing: true, owner_session_id: 'http://localhost:8080' },
          { slot_id: 'slot-2', is_processing: true }, // processing, not free
          { slot_id: 'slot-3', is_processing: false }, // free unowned
        ],
        contention_queue_depth: 0,
        contention_queued_count: 0,
      };
      const { worker, deps } = makePerSlotWorker({
        status,
        runningPanes: () => ({ ok: true, count: 0 }),
        requiredFreeSlots: 2, // audit minimum
      });
      const start = 1_000_000;
      vi.setSystemTime(start);
      await worker.tick();
      vi.setSystemTime(start + 5_000);
      const blocked = await worker.tick();
      // 1 free unowned < requiredFreeSlots=2 → blocked.
      expect(blocked.dispatched).toBe(false);
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('AC1b: per-slot with 0 runningPanes but lease held → dispatch proceeds (operator lease on spare slots)', async () => {
    // When the worker has NO running panes, even a held lease doesn't block.
    vi.useFakeTimers();
    try {
      const status: LlamaStatus = {
        llama_server_running: true,
        local_active_query: false,
        model_switch_in_progress: false,
        local_lease_active: true,
        available_slots: 2,
        total_slots: 3,
        local_owner_session_id: 'http://localhost:8080',
        local_owner_lease_remaining_seconds: 60,
        slots: [
          { slot_id: 'slot-1', is_processing: true, owner_session_id: 'http://localhost:8080' },
          { slot_id: 'slot-2', is_processing: false },
          { slot_id: 'slot-3', is_processing: false },
        ],
        contention_queue_depth: 0,
        contention_queued_count: 0,
      };
      const { worker, deps } = makePerSlotWorker({
        status,
        runningPanes: () => ({ ok: true, count: 0 }),
        requiredFreeSlots: 2,
      });
      const start = 1_000_000;
      vi.setSystemTime(start);
      await worker.tick();
      vi.setSystemTime(start + 5_000);
      const result = await worker.tick();
      expect(result.dispatched).toBe(true);
      expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('AC5: cheap-mode dispatch is recorded in downtime-dispatches.log while a previously dispatched agent is still working', async () => {
    // Integration evidence for the RCA (WL-0MU8807BI008C9ME): with a
    // previously dispatched agent STILL alive (`runningPanes > 0`) and
    // holding the shared owner lease, the per-slot gate must still dispatch
    // into the 2 free unowned slots AND record the dispatch in the rolling
    // log at <cwd>/.worklog/downtime-dispatches.log — the observable
    // behaviour the RCA said never happened.
    const root = mkdtempSync(join(tmpdir(), 'herdr-perslot-log-'));
    vi.useFakeTimers();
    try {
      const status: LlamaStatus = {
        llama_server_running: true,
        local_active_query: false,
        model_switch_in_progress: false,
        local_lease_active: true,
        available_slots: 2,
        total_slots: 3,
        // Array form served by the live proxy: [url, session].
        local_owner_session_id: ['http://localhost:8080', 'dispatched-pane-session'],
        local_owner_lease_remaining_seconds: 90,
        slots: [
          { slot_id: 'slot-1', is_processing: true, owner_session_id: 'dispatched-pane-session' },
          { slot_id: 'slot-2', is_processing: false },
          { slot_id: 'slot-3', is_processing: false },
        ],
        contention_queue_depth: 0,
        contention_queued_count: 0,
      };
      const cfg = {
        enabled: true,
        thresholdMs: 1_000,
        requiredFreeSlots: 2,
        model: 'plan',
        cwd: root,
        noCandidateCooldownMs: 3_600_000,
        browseItemCount: 20,
      };
      const poller = createDowntimePoller(
        'http://proxy:8000',
        vi.fn().mockResolvedValue(jsonResponseFixture(status)),
      );
      const deps = makeDeps({
        getNextItem: vi.fn().mockResolvedValue({
          ok: true,
          candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
        }),
        // A previously dispatched agent is STILL working.
        getRunningDowntimePanes: vi.fn().mockResolvedValue({ ok: true, count: 1 }),
        // Real rolling-log write (the plugin's recordDispatch contract):
        // the dispatch marker must land in downtime-dispatches.log.
        recordDispatch: vi.fn(async (event) => {
          await appendDowntimeLogEntry(event.cwd, JSON.stringify(event));
          return true;
        }),
      });
      const worker = createDowntimeWorker({ poller, deps, config: () => ({ ...cfg }) });

      const start = 1_000_000;
      vi.setSystemTime(start);
      await worker.tick(); // baseline poll — start the per-slot timer
      vi.setSystemTime(start + 5_000);
      const outcome = await worker.tick();

      expect(outcome.dispatched).toBe(true);
      const entries = await readDowntimeLogEntries(root);
      const marker = entries.find((e) => e.kind === 'plan' && e.itemId === 'WL-ABC');
      expect(marker).toBeDefined();
      expect(marker!.dispatchedAt).toBeDefined();
    } finally {
      vi.useRealTimers();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── Truthful capacity schema v2 (LP-0MVGDUVGE0024YAI) ────────────────
//
// The llama-proxy now publishes `status_schema_version: 2` with additive
// per-slot lease/phase/ETA detail and a top-level `capacity_hint`. The herdr
// consumer must parse the fields strictly: availability-affecting values are
// fail-closed when malformed, advisory values degrade to undefined, and a
// pre-v2 payload keeps today's behaviour exactly.

describe('parseLlamaStatus: truthful capacity schema v2 (LP-0MVGDUVGE0024YAI)', () => {
  const v2 = {
    llama_server_running: true,
    local_active_query: false,
    model_switch_in_progress: false,
    local_lease_active: true,
    available_slots: 0,
    total_slots: 2,
    status_schema_version: 2,
    capacity_hint: 'idle',
    prefill_budget_seconds: 120,
    slots: [
      {
        slot_id: 0,
        is_processing: false,
        owner_session_id: 'sess-1',
        lease_state: 'idle_leased',
        phase: null,
        context_tokens: null,
        prefill_eta_seconds: null,
      },
      {
        slot_id: 1,
        is_processing: true,
        lease_state: 'generating',
        phase: 'prefill',
        context_tokens: 102345,
        prefill_eta_seconds: 187.5,
      },
    ],
  };

  it('parses the additive schema-v2 fields', () => {
    const status = parseLlamaStatus(v2);
    expect(status).not.toBeNull();
    expect(status!.status_schema_version).toBe(2);
    expect(status!.capacity_hint).toBe('idle');
    expect(status!.prefill_budget_seconds).toBe(120);
    expect(status!.slots!).toHaveLength(2);
    expect(status!.slots![0].lease_state).toBe('idle_leased');
    expect(status!.slots![0].phase).toBeNull();
    expect(status!.slots![0].context_tokens).toBeNull();
    expect(status!.slots![0].prefill_eta_seconds).toBeNull();
    expect(status!.slots![1].lease_state).toBe('generating');
    expect(status!.slots![1].phase).toBe('prefill');
    expect(status!.slots![1].context_tokens).toBe(102345);
    expect(status!.slots![1].prefill_eta_seconds).toBe(187.5);
  });

  it('leaves every schema-v2 field undefined on a pre-v2 payload', () => {
    const status = parseLlamaStatus({
      llama_server_running: true,
      local_active_query: false,
      model_switch_in_progress: false,
      local_lease_active: false,
      available_slots: 1,
      total_slots: 1,
      slots: [{ slot_id: 'slot-1', is_processing: false }],
    });
    expect(status).not.toBeNull();
    expect(status!.status_schema_version).toBeUndefined();
    expect(status!.capacity_hint).toBeUndefined();
    expect(status!.prefill_budget_seconds).toBeUndefined();
    expect(status!.slots![0].lease_state).toBeUndefined();
    expect(status!.slots![0].phase).toBeUndefined();
    expect(status!.slots![0].context_tokens).toBeUndefined();
    expect(status!.slots![0].prefill_eta_seconds).toBeUndefined();
  });

  it('treats a malformed or unknown capacity_hint as ambiguous → busy', () => {
    expect(parseLlamaStatus({ ...v2, capacity_hint: 'hot' })).toBeNull();
    expect(parseLlamaStatus({ ...v2, capacity_hint: 2 })).toBeNull();
  });

  it('treats a malformed or unknown lease_state as ambiguous → busy', () => {
    for (const lease_state of ['busy', '', 1, true]) {
      const raw = {
        ...v2,
        slots: [{ slot_id: 0, is_processing: false, lease_state }],
      };
      expect(parseLlamaStatus(raw)).toBeNull();
    }
  });

  it('treats a malformed status_schema_version as absent (no v2 behaviour)', () => {
    expect(parseLlamaStatus({ ...v2, status_schema_version: 'two' })!.status_schema_version).toBeUndefined();
    expect(parseLlamaStatus({ ...v2, status_schema_version: -1 })!.status_schema_version).toBeUndefined();
    expect(parseLlamaStatus({ ...v2, status_schema_version: 1.5 })!.status_schema_version).toBeUndefined();
  });

  it('ignores malformed advisory fields instead of rejecting the poll', () => {
    const status = parseLlamaStatus({
      ...v2,
      prefill_budget_seconds: 'lots',
      slots: [
        {
          slot_id: 0,
          is_processing: false,
          lease_state: 'free',
          phase: 'warming',
          context_tokens: -5,
          prefill_eta_seconds: Number.NaN,
        },
      ],
    });
    expect(status).not.toBeNull();
    expect(status!.prefill_budget_seconds).toBeUndefined();
    expect(status!.slots![0].phase).toBeUndefined();
    expect(status!.slots![0].context_tokens).toBeUndefined();
    expect(status!.slots![0].prefill_eta_seconds).toBeUndefined();
  });
});

// ── Proxy-authoritative local idle age (WL-0MVHSZR9C0012NQY) ──────────
//
// The llama-proxy publishes the authoritative monotonic local idle age
// (`local_idle_seconds`, plus `local_last_activity_at` /
// `local_last_activity_source`, LP-0MVGD9Z8Z0055Y5J). All three are
// optional/backward compatible: a pre-feature payload parses exactly as
// before, and malformed values degrade to `undefined` without throwing —
// they must never reject an otherwise usable poll.

describe('parseLlamaStatus: proxy-authoritative local idle age (WL-0MVHSZR9C0012NQY)', () => {
  const base = {
    llama_server_running: true,
    local_active_query: false,
    model_switch_in_progress: false,
    local_lease_active: false,
    available_slots: 2,
    total_slots: 2,
    slots: [
      { slot_id: 'slot-1', is_processing: false },
      { slot_id: 'slot-2', is_processing: false },
    ],
  };

  it('AC1: reads local_idle_seconds, local_last_activity_at and local_last_activity_source', () => {
    const status = parseLlamaStatus({
      ...base,
      local_idle_seconds: 7_200,
      local_last_activity_at: '2026-10-21T10:00:00.000Z',
      local_last_activity_source: 'finish',
    });
    expect(status).not.toBeNull();
    expect(status!.local_idle_seconds).toBe(7_200);
    expect(status!.local_last_activity_at).toBe('2026-10-21T10:00:00.000Z');
    expect(status!.local_last_activity_source).toBe('finish');
  });

  it('AC1: a fractional idle age is preserved', () => {
    const status = parseLlamaStatus({ ...base, local_idle_seconds: 12.5 });
    expect(status!.local_idle_seconds).toBe(12.5);
  });

  it('AC1: absent idle-age fields preserve a pre-feature payload unchanged', () => {
    const status = parseLlamaStatus(base);
    expect(status).not.toBeNull();
    expect(status!.local_idle_seconds).toBeUndefined();
    expect(status!.local_last_activity_at).toBeUndefined();
    expect(status!.local_last_activity_source).toBeUndefined();
  });

  it('AC1: malformed idle-age values degrade to undefined without throwing', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5, '60', true, {}, null]) {
      const status = parseLlamaStatus({ ...base, local_idle_seconds: bad });
      expect(status).not.toBeNull();
      expect(status!.local_idle_seconds).toBeUndefined();
    }
    // reportedIdleSeconds mirrors the same fail-closed contract at the gate:
    // a non-finite/negative age reads as "no authoritative signal", never as
    // "idle forever".
    expect(reportedIdleSeconds({ ...(parseLlamaStatus(base)!), local_idle_seconds: Number.NaN })).toBeNull();
    expect(reportedIdleSeconds({ ...(parseLlamaStatus(base)!), local_idle_seconds: -1 })).toBeNull();
    expect(reportedIdleSeconds(parseLlamaStatus({ ...base, local_idle_seconds: 30 })!)).toBe(30);
    expect(reportedIdleSeconds(parseLlamaStatus(base)!)).toBeNull();
  });

  it('AC1: malformed activity evidence degrades to undefined without throwing', () => {
    for (const at of ['not-a-date', '', 123, null]) {
      const status = parseLlamaStatus({ ...base, local_last_activity_at: at });
      expect(status).not.toBeNull();
      expect(status!.local_last_activity_at).toBeUndefined();
    }
    for (const source of ['', 42, null, true]) {
      const status = parseLlamaStatus({ ...base, local_last_activity_source: source });
      expect(status).not.toBeNull();
      expect(status!.local_last_activity_source).toBeUndefined();
    }
  });
});

// ── Prefill serialisation gate (LP-0MVGDUUV3001XFRJ, WL-0MVHSZRZQ00482QX) ─
//
// The llama-proxy serialises local prefills and publishes the gate state:
// `local_prefills_in_flight`, `local_max_concurrent_prefills` and
// `prefill_gate_waiters` (the live contention-queue depth for the gate) plus
// the prefill-ETA guard's `queue_eta_seconds` / `prefill_budget_seconds`.
// The parser contract mirrors the contention fields: the three counters are
// availability-affecting (a malformed value fails closed → null/busy), while
// the ETA figures are advisory and degrade to undefined.
describe('parseLlamaStatus: prefill serialisation gate (WL-0MVHSZRZQ00482QX)', () => {
  const prefillBase = {
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

  it('AC1: reads the prefill-gate counters and ETA fields when served', () => {
    const status = parseLlamaStatus({
      ...prefillBase,
      local_prefills_in_flight: 1,
      local_max_concurrent_prefills: 1,
      prefill_gate_waiters: 2,
      queue_eta_seconds: 300,
      prefill_budget_seconds: 120,
    });
    expect(status).not.toBeNull();
    expect(status!.local_prefills_in_flight).toBe(1);
    expect(status!.local_max_concurrent_prefills).toBe(1);
    expect(status!.prefill_gate_waiters).toBe(2);
    expect(status!.queue_eta_seconds).toBe(300);
    expect(status!.prefill_budget_seconds).toBe(120);
  });

  it('AC1: leaves every prefill field undefined on a pre-feature payload', () => {
    const status = parseLlamaStatus(prefillBase);
    expect(status).not.toBeNull();
    expect(status!.local_prefills_in_flight).toBeUndefined();
    expect(status!.local_max_concurrent_prefills).toBeUndefined();
    expect(status!.prefill_gate_waiters).toBeUndefined();
    expect(status!.queue_eta_seconds).toBeUndefined();
    expect(status!.prefill_budget_seconds).toBeUndefined();
  });

  it('AC1: malformed prefill-gate counters fail closed → busy (null)', () => {
    for (const field of [
      'local_prefills_in_flight',
      'local_max_concurrent_prefills',
      'prefill_gate_waiters',
    ] as const) {
      for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, '2', true, {}]) {
        expect(parseLlamaStatus({ ...prefillBase, [field]: bad })).toBeNull();
      }
    }
  });

  it('AC1: queue_eta_seconds is advisory — a malformed value degrades, never rejects', () => {
    for (const bad of [Number.NaN, -5, '300', true, {}]) {
      const status = parseLlamaStatus({ ...prefillBase, queue_eta_seconds: bad });
      expect(status).not.toBeNull();
      expect(status!.queue_eta_seconds).toBeUndefined();
    }
    const nullEta = parseLlamaStatus({ ...prefillBase, queue_eta_seconds: null });
    expect(nullEta).not.toBeNull();
    expect(nullEta!.queue_eta_seconds).toBeNull();
  });
});

// ── Prefill-ETA occupancy/calibration advisory fields ─────────────────
//
// Parent WL-0MVPRZU0A000TSWD: the proxy's `status_estimate()`
// (`prefill_eta.py`, LP-0MVGDUV5E005UWBQ) publishes, alongside
// `queue_eta_seconds` (own prefill + occupancy), the SPLIT terms
// `queue_eta_occupancy_seconds` (wait behind OTHER prefills) and
// `queue_eta_busy_slots` (slots occupied by them), plus
// `prefill_eta_calibrated` (enough samples for the estimate to be
// actionable — false below the proxy's `MIN_CALIBRATION_SAMPLES`).
//
// Herdr's parser must consume all three as ADVISORY fields, exactly like
// `queue_eta_seconds`: absent → `undefined` (legacy proxy, today's shape),
// malformed → `undefined` (a bad advisory value must NEVER reject an
// otherwise usable poll). Contrast the availability-affecting gate counters
// (`local_prefills_in_flight`, `local_max_concurrent_prefills`,
// `prefill_gate_waiters`), which keep failing closed — pinned below so the
// advisory relaxation can never silently widen to the gates.
//
// RED WITNESS: the present-field specs were `it.fails` until the fields
// moved onto `LlamaStatus` (WL-0MVPUE4SE004QYUT), which made the local
// mirror interface and the cast redundant; the witnesses are now plain
// `it` specs asserting the real `LlamaStatus` shape.
describe('parseLlamaStatus: prefill-ETA occupancy/calibration advisories (WL-0MVPUDZ7P008UZGD)', () => {
  const prefillBase = {
    llama_server_running: true,
    local_active_query: false,
    model_switch_in_progress: false,
    local_lease_active: false,
    available_slots: 2,
    total_slots: 2,
    local_prefills_in_flight: 0,
    local_max_concurrent_prefills: 1,
    prefill_gate_waiters: 0,
    prefill_budget_seconds: 60,
    queue_eta_seconds: 97.5,
    slots: [
      { slot_id: 'slot-1', is_processing: false, lease_state: 'free' },
      { slot_id: 'slot-2', is_processing: false, lease_state: 'free' },
    ],
  };

  it('AC1: parses the three new fields when the proxy serves them', () => {
    // The incident pool's own shape: an idle, uncalibrated proxy whose
    // whole 97.5 s ETA is the newcomer's own prefill (zero occupancy).
    const status = parseLlamaStatus({
      ...prefillBase,
      queue_eta_occupancy_seconds: 0,
      queue_eta_busy_slots: 0,
      prefill_eta_calibrated: false,
    });
    expect(status).not.toBeNull();
    expect(status!.queue_eta_occupancy_seconds).toBe(0);
    expect(status!.queue_eta_busy_slots).toBe(0);
    expect(status!.prefill_eta_calibrated).toBe(false);
  });

  it('AC1: parses occupancy terms and a calibrated flag when served', () => {
    const status = parseLlamaStatus({
      ...prefillBase,
      queue_eta_occupancy_seconds: 300,
      queue_eta_busy_slots: 1,
      prefill_eta_calibrated: true,
    });
    expect(status).not.toBeNull();
    expect(status!.queue_eta_occupancy_seconds).toBe(300);
    expect(status!.queue_eta_busy_slots).toBe(1);
    expect(status!.prefill_eta_calibrated).toBe(true);
  });

  it('AC2: absent fields yield undefined (legacy proxy stays usable)', () => {
    const status = parseLlamaStatus(prefillBase);
    expect(status).not.toBeNull();
    expect(status!.queue_eta_occupancy_seconds).toBeUndefined();
    expect(status!.queue_eta_busy_slots).toBeUndefined();
    expect(status!.prefill_eta_calibrated).toBeUndefined();
    // The pre-existing ETA/budget contract is untouched by their absence.
    expect(status!.queue_eta_seconds).toBe(97.5);
    expect(status!.prefill_budget_seconds).toBe(60);
  });

  it('AC2: an explicit null ("not computable") is preserved, mirroring queue_eta_seconds', () => {
    for (const field of ['queue_eta_occupancy_seconds', 'queue_eta_busy_slots'] as const) {
      const status = parseLlamaStatus({ ...prefillBase, [field]: null });
      expect(status).not.toBeNull();
      expect(status![field]).toBeNull();
    }
    const status = parseLlamaStatus({ ...prefillBase, prefill_eta_calibrated: null });
    expect(status).not.toBeNull();
    expect(status!.prefill_eta_calibrated).toBeNull();
  });

  it('AC3: malformed occupancy numbers degrade to undefined, never reject the poll', () => {
    for (const field of ['queue_eta_occupancy_seconds', 'queue_eta_busy_slots'] as const) {
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5, '300', true, {}]) {
        const status = parseLlamaStatus({ ...prefillBase, [field]: bad });
        expect(status).not.toBeNull();
        expect(status![field]).toBeUndefined();
      }
    }
  });

  it('AC3: a non-boolean calibration flag degrades to undefined, never rejects the poll', () => {
    for (const bad of ['yes', 'false', 1, 0, {}, []]) {
      const status = parseLlamaStatus({ ...prefillBase, prefill_eta_calibrated: bad });
      expect(status).not.toBeNull();
      expect(status!.prefill_eta_calibrated).toBeUndefined();
    }
  });

  it('AC3: a malformed advisory field never masks a fail-closed gate counter', () => {
    // Same malformed advisory values, but a gate counter is also malformed:
    // the poll must STILL be rejected (ambiguous → busy, fail-closed). The
    // advisory relaxation covers only the new fields, never the gates.
    for (const field of [
      'local_prefills_in_flight',
      'local_max_concurrent_prefills',
      'prefill_gate_waiters',
    ] as const) {
      expect(
        parseLlamaStatus({
          ...prefillBase,
          queue_eta_occupancy_seconds: Number.NaN,
          queue_eta_busy_slots: 'many',
          prefill_eta_calibrated: 'yes',
          [field]: '2',
        }),
      ).toBeNull();
    }
  });

  it('AC3: valid advisory fields leave the poll usable', () => {
    // Present-and-valid is the common case; guard against an over-eager
    // implementation that rejects instead of degrading on the new fields.
    const status = parseLlamaStatus({
      ...prefillBase,
      queue_eta_occupancy_seconds: 12.5,
      queue_eta_busy_slots: 1,
      prefill_eta_calibrated: true,
    });
    expect(status).not.toBeNull();
    expect(status!.llama_server_running).toBe(true);
    expect(status!.available_slots).toBe(2);
  });

  it('AC4: the incident fixture parses end-to-end with its advisory terms', () => {
    // `prefillIdleUncalibrated` (from `downtime-worker.fixtures.ts`) is built
    // through the `prefillPacingStatus` factory, so this pins BOTH the
    // factory surfacing (AC4) and the parser round-trip: the reconstructed
    // 97.5 s idle-uncalibrated incident pool keeps its three advisory terms.
    const status = parseLlamaStatus(prefillIdleUncalibrated);
    expect(status).not.toBeNull();
    expect(status!.queue_eta_seconds).toBe(97.5);
    expect(status!.queue_eta_occupancy_seconds).toBe(0);
    expect(status!.queue_eta_busy_slots).toBe(0);
    expect(status!.prefill_eta_calibrated).toBe(false);
  });

  it('AC4: a fixture built without the advisory terms stays shape-identical to a legacy poll', () => {
    // The factory injects the advisory fields ONLY when supplied, so a poll
    // built without them must parse exactly like a legacy proxy: the new
    // keys are absent, not present-and-undefined.
    const status = parseLlamaStatus(prefillPacingStatus());
    expect(status).not.toBeNull();
    expect(status!.queue_eta_occupancy_seconds).toBeUndefined();
    expect(status!.queue_eta_busy_slots).toBeUndefined();
    expect(status!.prefill_eta_calibrated).toBeUndefined();
  });
});
