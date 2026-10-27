/**
 * packages/herdr/src/downtime-worker.idle.test.ts — idle-detection tests
 *
 * Split out of the monolithic `downtime-worker.test.ts`
 * (WL-0MV28X3SL005R5KX / WL-0MV4V2H4O004U8M9) to keep each test file focused
 * on one concern.
 *
 * Covers the idle-detection contract:
 *   - `isIdleStatus` classification (global gate),
 *   - idle-duration threshold timing (`createIdleTracker`),
 *   - runtime idle evaluation (`evaluateIdle`) in global and per-slot mode,
 *   - the per-slot idle tracker (`createPerSlotIdleTracker`), and
 *   - spare-capacity dispatch: relaxed global gate, the
 *     `DEFAULT_DOWNTIME_REQUIRED_FREE_SLOTS` default, pre-fix-proxy
 *     fail-closed behaviour, and ambiguous payloads,
 *   - slot-ownership helpers (`isSlotOwned`, `countFreeUnownedSlots`).
 *
 * Shared scaffolding (`makeDeps`, idle fixtures, etc.) is imported from
 * `downtime-worker.fixtures.ts`; no setup logic is re-implemented here.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  isIdleStatus,
  evaluateIdle,
  createIdleTracker,
  createPerSlotIdleTracker,
  createDowntimePoller,
  createDowntimeWorker,
  countFreeUnownedSlots,
  isSlotOwned,
  isSlotAvailableForDispatch,
  evaluatePrefillPacing,
  DEFAULT_DOWNTIME_POLL_INTERVAL_MS,
  DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
  DEFAULT_DOWNTIME_REQUIRED_FREE_SLOTS,
  type LlamaStatus,
  type LlamaSlot,
} from './downtime-worker.js';
import {
  jsonResponseFixture,
  makeDeps,
  singleSlotIdleOwned,
  perSlotIdleOwned,
  perSlotOwnedOneUnowned,
  prefillPacingStatus,
  prefillIdleUncalibrated,
  prefillIdleZeroOccupancy,
  prefillBusyOccupancy,
} from './downtime-worker.fixtures.js';
import type { CoordinationLogEntry } from './downtime-log.js';

// ── Idle detection (AC2) ──────────────────────────────────────────────

describe('idle detection (isIdleStatus)', () => {
  const idle: LlamaStatus = {
    llama_server_running: true,
    local_active_query: false,
    model_switch_in_progress: false,
    local_lease_active: false,
    available_slots: 4,
    total_slots: 4,
  };

  it('is idle when the server is up, nothing active, and all slots free', () => {
    expect(isIdleStatus(idle, 0)).toBe(true);
  });

  it('is busy when llama-server is not running', () => {
    expect(isIdleStatus({ ...idle, llama_server_running: false }, 0)).toBe(false);
  });

  it('is busy when local_active_query=true (a local query is in flight)', () => {
    expect(isIdleStatus({ ...idle, local_active_query: true }, 0)).toBe(false);
  });

  it('is busy when local_active_query is absent (fail-closed on pre-fix proxy)', () => {
    // A payload without local_active_query (pre-fix proxy) fails closed:
    // the worker must never dispatch on an unverifiable busy signal.
    const partial: LlamaStatus = {
      llama_server_running: true,
      model_switch_in_progress: false,
      local_lease_active: false,
      available_slots: 4,
      total_slots: 4,
    };
    expect(isIdleStatus(partial, 0)).toBe(false);
  });

  it('is idle during remote-only traffic when local_active_query=false', () => {
    // Remote provider streams keep the global query signal true while the
    // local model is idle with free slots; the proxy's local_active_query is
    // the local-only signal (LP-0MSL2ZLLS009RVKR) and must not block dispatch.
    expect(isIdleStatus({ ...idle, local_active_query: false }, 0)).toBe(true);
  });

  it('is busy while a model switch is in progress', () => {
    expect(isIdleStatus({ ...idle, model_switch_in_progress: true }, 0)).toBe(false);
  });

  it('is busy while a local lease is active', () => {
    expect(isIdleStatus({ ...idle, local_lease_active: true }, 0)).toBe(false);
  });

  it('N=0 (default) requires ALL slots free', () => {
    expect(isIdleStatus({ ...idle, available_slots: 3 }, 0)).toBe(false);
    expect(isIdleStatus({ ...idle, available_slots: 4 }, 0)).toBe(true);
  });

  it('a positive N requires at least N slots free', () => {
    expect(isIdleStatus({ ...idle, available_slots: 2 }, 2)).toBe(true);
    expect(isIdleStatus({ ...idle, available_slots: 1 }, 2)).toBe(false);
  });

  it('N > total_slots can never be idle (never dispatches)', () => {
    expect(isIdleStatus({ ...idle, available_slots: 4 }, 5)).toBe(false);
  });

  it('ambiguous responses (total_slots 0 or missing fields) are busy', () => {
    expect(isIdleStatus({ ...idle, total_slots: 0, available_slots: 0 }, 0)).toBe(false);
    expect(isIdleStatus({ llama_server_running: true } as LlamaStatus, 0)).toBe(false);
  });

  it('non-finite or negative slot counts are busy', () => {
    expect(isIdleStatus({ ...idle, total_slots: Number.NaN }, 0)).toBe(false);
    expect(isIdleStatus({ ...idle, available_slots: -1 }, 0)).toBe(false);
  });
});

// ── Threshold timing (AC1/AC3) ────────────────────────────────────────

describe('threshold timing (idle-duration tracker)', () => {
  const thresholdMs = DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS;

  it('dispatches only after idle has lasted the full threshold continuously', () => {
    const tracker = createIdleTracker();
    const start = 1_000_000;

    tracker.record(true, start);
    expect(tracker.idleSince).toBe(start);
    expect(tracker.isThresholdMet(thresholdMs, start + thresholdMs - 1)).toBe(false);
    expect(tracker.isThresholdMet(thresholdMs, start + thresholdMs)).toBe(true);
  });

  it('any busy poll resets the idle-since timestamp', () => {
    const tracker = createIdleTracker();
    const start = 1_000_000;

    tracker.record(true, start);
    tracker.record(false, start + 120_000);
    expect(tracker.idleSince).toBeNull();
    expect(tracker.isThresholdMet(thresholdMs, start + 360_000)).toBe(false);
  });

  it('keeps the idle run start fixed across consecutive idle polls', () => {
    const tracker = createIdleTracker();
    const start = 1_000_000;
    tracker.record(true, start);
    tracker.record(true, start + DEFAULT_DOWNTIME_POLL_INTERVAL_MS);
    tracker.record(true, start + 2 * DEFAULT_DOWNTIME_POLL_INTERVAL_MS);
    expect(tracker.idleSince).toBe(start);
    expect(tracker.isThresholdMet(thresholdMs, start + thresholdMs - 1_000)).toBe(false);
    expect(tracker.isThresholdMet(thresholdMs, start + thresholdMs)).toBe(true);
  });
});

// ── Runtime idle evaluation (F2, AC5) ─────────────────────────────────

describe('runtime idle evaluation (evaluateIdle)', () => {
  const idle: LlamaStatus = {
    llama_server_running: true,
    local_active_query: false,
    model_switch_in_progress: false,
    local_lease_active: false,
    available_slots: 4,
    total_slots: 4,
  };

  function slotsFor(processing: number[], total = 4): LlamaSlot[] {
    return Array.from({ length: total }, (_, i) => ({
      slot_id: `s${i + 1}`,
      is_processing: processing.includes(i + 1),
    }));
  }

  it('fails closed when per-slot detail is absent (never admits the count)', () => {
    // Fail-closed contract (WL-0MUXVPXAZ005RESW): the untrusted
    // `available_slots` count is never a dispatch budget — absent `slots`
    // means no trustworthy signal, so even a full count is busy.
    expect(evaluateIdle(idle, 0)).toBe(false);
    expect(evaluateIdle({ ...idle, available_slots: 3 }, 0)).toBe(false);
    expect(evaluateIdle({ ...idle, available_slots: 4 }, 2)).toBe(false);
  });

  it('fails closed when per-slot detail is empty or stale', () => {
    expect(evaluateIdle({ ...idle, slots: [] }, 0)).toBe(false);
    expect(
      evaluateIdle(
        { ...idle, slots: slotsFor([]), slots_stale: true },
        0,
      ),
    ).toBe(false);
  });

  it('N=0 (default) requires all slots free from the per-slot array', () => {
    expect(evaluateIdle({ ...idle, slots: slotsFor([]) }, 0)).toBe(true);
    // available_slots still says 4 but the per-slot array shows one busy → busy.
    expect(
      evaluateIdle({ ...idle, slots: slotsFor([4]) }, 0),
    ).toBe(false);
  });

  it('N == total slots behaves like all slots free', () => {
    expect(evaluateIdle({ ...idle, slots: slotsFor([]) }, 4)).toBe(true);
    expect(evaluateIdle({ ...idle, slots: slotsFor([4]) }, 4)).toBe(false);
  });

  it('N > total slots can never be idle (never dispatches)', () => {
    expect(evaluateIdle({ ...idle, slots: slotsFor([]) }, 5)).toBe(false);
  });

  it('ambiguous responses (total_slots 0) are busy', () => {
    expect(
      evaluateIdle({ ...idle, total_slots: 0, available_slots: 0 }, 0),
    ).toBe(false);
  });
});

// ── Per-slot idle tracker (AC3/AC4) ───────────────────────────────────

describe('per-slot idle tracker (createPerSlotIdleTracker)', () => {
  const a: LlamaSlot = { slot_id: 'a', is_processing: false };
  const b: LlamaSlot = { slot_id: 'b', is_processing: false };

  it('starts a slot timer on its first free poll and continues it across free polls', () => {
    const tracker = createPerSlotIdleTracker();
    const start = 1_000_000;

    tracker.record([a, b], start);
    expect(tracker.idleSince.get('a')).toBe(start);
    expect(tracker.idleSince.get('b')).toBe(start);

    tracker.record([a, b], start + 30_000);
    expect(tracker.idleSince.get('a')).toBe(start); // run start stays fixed
    expect(tracker.idleSince.get('b')).toBe(start);
  });

  it('a slot starting processing resets ONLY its own timer (other timers continue)', () => {
    const tracker = createPerSlotIdleTracker();
    const start = 1_000_000;

    tracker.record([a, b], start);
    tracker.record([{ slot_id: 'a', is_processing: true }, b], start + 10_000);

    expect(tracker.idleSince.get('a')).toBeNull(); // own timer reset
    expect(tracker.idleSince.get('b')).toBe(start); // other timer continues
  });

  it('a slot absent from the payload is fail-closed to busy (its timer resets)', () => {
    const tracker = createPerSlotIdleTracker();
    const start = 1_000_000;

    tracker.record([a, b], start);
    tracker.record([a], start + 10_000); // b absent

    expect(tracker.idleSince.get('a')).toBe(start);
    expect(tracker.idleSince.get('b')).toBeNull();
  });

  it('an empty record resets every slot timer (global-busy reset path)', () => {
    const tracker = createPerSlotIdleTracker();
    const start = 1_000_000;

    tracker.record([a, b], start);
    tracker.record([], start + 10_000);

    expect(tracker.idleSince.get('a')).toBeNull();
    expect(tracker.idleSince.get('b')).toBeNull();
  });

  it('thresholdMetCount counts only slots continuously free for the full threshold', () => {
    const tracker = createPerSlotIdleTracker();
    const start = 1_000_000;

    tracker.record([a, b], start);
    expect(tracker.thresholdMetCount(DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS, start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS - 1)).toBe(0);
    expect(tracker.thresholdMetCount(DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS, start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS)).toBe(2);
    expect(tracker.thresholdMetCount(DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS, start + 500_000)).toBe(2);
  });

  it('a reset slot needs a fresh full run before it counts toward the threshold again', () => {
    const tracker = createPerSlotIdleTracker();
    const start = 1_000_000;

    tracker.record([a, b], start);
    // a goes processing at +10s (own timer reset) and free again at +20s.
    tracker.record([{ slot_id: 'a', is_processing: true }, b], start + 10_000);
    tracker.record([a, b], start + 20_000);

    // Only b has a full continuous run at start+threshold+5s.
    expect(tracker.thresholdMetCount(DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS, start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS + 5_000)).toBe(1);
    // a completes its fresh run at start+20s+threshold → both count.
    expect(tracker.thresholdMetCount(DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS, start + 20_000 + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS)).toBe(2);
  });
});

// ── evaluateIdle: per-slot mode (AC5 + per-slot free count) ───────────

describe('evaluateIdle per-slot mode (0 < N < total with slots present)', () => {
  const free = (id: string): LlamaSlot => ({ slot_id: id, is_processing: false });
  const busy = (id: string): LlamaSlot => ({ slot_id: id, is_processing: true });
  const perSlot = (slots: LlamaSlot[], available: number, total: number): LlamaStatus => ({
    llama_server_running: true,
    local_active_query: false,
    model_switch_in_progress: false,
    local_lease_active: false,
    available_slots: available,
    total_slots: total,
    slots,
  });
  // 4 slots, 2 free (slot-1, slot-2).
  const twoFree = perSlot([free('s1'), free('s2'), busy('s3'), busy('s4')], 2, 4);

  it('uses the per-slot free count when per-slot data is present and 0 < N < total', () => {
    expect(evaluateIdle(twoFree, 2)).toBe(true); // 2 of 4 free — enough
    expect(evaluateIdle(twoFree, 3)).toBe(false); // needs 3 — not enough
  });

  it('per-slot mode still requires the relaxed global checks (server up + no model switch)', () => {
    // Spare-capacity relaxation (parent WL-0MT32F90V008UAD2 AC2): in per-slot
    // mode ONLY llama_server_running and model_switch_in_progress remain
    // global gates — query/lease signals are superseded by per-slot
    // is_processing (a busy slot's query/lease is the operator's own session).
    expect(evaluateIdle(twoFree, 2)).toBe(true); // relaxed: query does NOT block
    expect(evaluateIdle({ ...twoFree, local_active_query: true }, 2)).toBe(true); // relaxed
    expect(evaluateIdle({ ...twoFree, local_lease_active: true }, 2)).toBe(true); // relaxed: lease does NOT block
    expect(evaluateIdle({ ...twoFree, model_switch_in_progress: true }, 2)).toBe(false); // still global
    expect(evaluateIdle({ ...twoFree, llama_server_running: false }, 2)).toBe(false); // still global
  });

  it('N=0 (default) still requires ALL slots free even when per-slot data is present', () => {
    expect(evaluateIdle(twoFree, 0)).toBe(false); // 2 < 4 → busy
    expect(evaluateIdle(perSlot([free('s1'), free('s2'), free('s3'), free('s4')], 4, 4), 0)).toBe(true);
  });

  it('N == total still requires ALL slots free even when per-slot data is present', () => {
    expect(evaluateIdle(perSlot([free('s1'), free('s2'), free('s3'), free('s4')], 4, 4), 4)).toBe(true);
    expect(evaluateIdle(perSlot([free('s1'), free('s2'), busy('s3'), free('s4')], 3, 4), 4)).toBe(false);
  });

  it('N > total never idles even with per-slot data', () => {
    expect(evaluateIdle(perSlot([free('s1'), free('s2'), free('s3'), free('s4')], 4, 4), 5)).toBe(false);
  });
});

// ── Spare-capacity dispatch (parent WL-0MT32F90V008UAD2, F1) ──────────
// Tests for the spare-capacity dispatch feature: relaxed global gate in
// per-slot mode (local_active_query / local_lease_active do NOT block),
// the new DEFAULT_DOWNTIME_REQUIRED_FREE_SLOTS = 2, per-tier free-slot
// minimums at dispatch selection, and unchanged pre-fix proxy degradation.

/** Per-slot status: 3 of 4 slots free (slot-1 busy), with global query/lease
 * signals active — exactly the "operator session" pattern the spare-capacity
 * dispatch must handle. */
function perSlotThreeOfFourFreeActiveQuery(): LlamaStatus {
  return {
    llama_server_running: true,
    model_switch_in_progress: false,
    local_lease_active: true,
    available_slots: 3,
    total_slots: 4,
    slots: [
      { slot_id: 'slot-1', is_processing: true },
      { slot_id: 'slot-2', is_processing: false },
      { slot_id: 'slot-3', is_processing: false },
      { slot_id: 'slot-4', is_processing: false },
    ],
  };
}

describe('spare-capacity dispatch: relaxed global idle gate (per-slot mode)', () => {
  it('per-slot mode: a mid-query busy slot does NOT block dispatch into free slots (AC1)', () => {
    // 3 of 4 slots free with local_active_query=true, local_lease_active=true.
    // In the relaxed global gate (AC1), these per-slot query/lease signals
    // are superseded by per-slot is_processing. Only llama_server_running and
    // model_switch_in_progress stay global.
    const status = perSlotThreeOfFourFreeActiveQuery();
    // The new relaxed check: active_query/local_active_query/local_lease
    // are NOT blocking in per-slot mode — 3 free >= N=2.
    expect(evaluateIdle(status, 2)).toBe(true); // spare capacity: 3 >= 2 free
  });

  it('per-slot mode: local_lease_active on a busy slot does NOT block dispatch (AC1)', () => {
    const status: LlamaStatus = {
      llama_server_running: true,
      model_switch_in_progress: false,
      local_lease_active: true,
      available_slots: 3,
      total_slots: 4,
      slots: [
        { slot_id: 'slot-1', is_processing: true },
        { slot_id: 'slot-2', is_processing: false },
        { slot_id: 'slot-3', is_processing: false },
        { slot_id: 'slot-4', is_processing: false },
      ],
    };
    // local_lease_active is per-slot; in per-slot mode it does NOT block.
    expect(evaluateIdle(status, 2)).toBe(true); // 3 free >= 2
  });

  it('per-slot mode: local_active_query on a busy slot does NOT block dispatch (AC2)', () => {
    const status: LlamaStatus = {
      llama_server_running: true,
      model_switch_in_progress: false,
      local_active_query: true,
      local_lease_active: false,
      available_slots: 2,
      total_slots: 3,
      slots: [
        { slot_id: 'slot-1', is_processing: true },
        { slot_id: 'slot-2', is_processing: false },
        { slot_id: 'slot-3', is_processing: false },
      ],
    };
    // 2 of 3 free with a mid-query busy slot — per-slot mode should fire.
    expect(evaluateIdle(status, 2)).toBe(true); // AC2: mid-query busy slot
  });

  it('per-slot mode: model_switch_in_progress still blocks dispatch (global gate)', () => {
    const status = perSlotThreeOfFourFreeActiveQuery();
    // model_switch_in_progress is ALWAYS global — even in per-slot mode.
    expect(evaluateIdle({ ...status, model_switch_in_progress: true }, 2)).toBe(false);
  });

  it('per-slot mode: llama_server_running=false still blocks dispatch (global gate)', () => {
    const status = perSlotThreeOfFourFreeActiveQuery();
    // server down is ALWAYS global — even in per-slot mode.
    expect(evaluateIdle({ ...status, llama_server_running: false }, 2)).toBe(false);
  });
});

describe('spare-capacity dispatch: DEFAULT_DOWNTIME_REQUIRED_FREE_SLOTS = 2 (AC1)', () => {
  it('DEFAULT_DOWNTIME_REQUIRED_FREE_SLOTS should be 2 for out-of-the-box spare-capacity', () => {
    // The new default: 2 of 3 slots must be free for dispatch.
    expect(DEFAULT_DOWNTIME_REQUIRED_FREE_SLOTS).toBe(2);
  });
});

describe('spare-capacity dispatch: pre-fix proxy (no local_active_query) fails closed', () => {
  it('pre-fix proxy (no local_active_query): absent signal → busy regardless of slot state', () => {
    // A pre-fix proxy does not serve local_active_query. The worker
    // fails closed (busy) on an absent signal — no silent degraded dispatch.
    const noLocalQuery: LlamaStatus = {
      llama_server_running: true,
      model_switch_in_progress: false,
      local_lease_active: false,
      available_slots: 2,
      total_slots: 4,
    };
    // Absent local_active_query → busy (fail-closed), not slot count.
    expect(evaluateIdle(noLocalQuery, 2)).toBe(false); // absent → busy
    expect(evaluateIdle(noLocalQuery, 4)).toBe(false); // absent → busy
    // Even with all slots free, absent local_active_query → busy.
    const allFree: LlamaStatus = {
      llama_server_running: true,
      model_switch_in_progress: false,
      local_lease_active: false,
      available_slots: 4,
      total_slots: 4,
    };
    expect(evaluateIdle(allFree, 2)).toBe(false); // absent → busy (fail-closed)
  });

  it('pre-fix proxy with N=0 (default): absent local_active_query → busy', () => {
    const status: LlamaStatus = {
      llama_server_running: true,
      model_switch_in_progress: false,
      local_lease_active: false,
      available_slots: 2,
      total_slots: 4,
    };
    // Absent local_active_query → busy (fail-closed), regardless of slot count.
    expect(evaluateIdle(status, 0)).toBe(false); // absent → busy
  });
});

describe('spare-capacity dispatch: ambiguous payloads are busy (AC5)', () => {
  it('missing slot_id fields are treated as busy (fail-closed)', () => {
    const malformed: LlamaStatus = {
      llama_server_running: true,
      model_switch_in_progress: false,
      local_lease_active: false,
      available_slots: 3,
      total_slots: 4,
      slots: [
        { slot_id: 'slot-1', is_processing: true },
        { slot_id: 'slot-2', is_processing: false },
      ],
    };
    // The slots array has only 2 entries for 4 total — this is ambiguous.
    // With per-slot mode active (0 < N < total), the free count is 1 < 2.
    expect(evaluateIdle(malformed, 2)).toBe(false);
  });

  it('total_slots 0 is always busy', () => {
    const status: LlamaStatus = {
      llama_server_running: true,
      model_switch_in_progress: false,
      local_lease_active: false,
      available_slots: 0,
      total_slots: 0,
    };
    expect(evaluateIdle(status, 2)).toBe(false);
  });

  it('N > total can never be idle', () => {
    const status: LlamaStatus = {
      llama_server_running: true,
      model_switch_in_progress: false,
      local_lease_active: false,
      available_slots: 3,
      total_slots: 3,
      slots: [
        { slot_id: 'slot-1', is_processing: false },
        { slot_id: 'slot-2', is_processing: false },
        { slot_id: 'slot-3', is_processing: false },
      ],
    };
    // 3 free < 4 required — never idle.
    expect(evaluateIdle(status, 4)).toBe(false);
  });
});

describe('slot ownership helpers (AC5)', () => {
  it('isSlotOwned is true only for a non-empty owner_session_id', () => {
    expect(isSlotOwned({ slot_id: 's', is_processing: false, owner_session_id: 'abc' })).toBe(true);
    expect(isSlotOwned({ slot_id: 's', is_processing: false, owner_session_id: null })).toBe(false);
    expect(isSlotOwned({ slot_id: 's', is_processing: false })).toBe(false);
    expect(isSlotOwned({ slot_id: 's', is_processing: false, owner_session_id: '' })).toBe(false);
  });

  it('countFreeUnownedSlots excludes processing AND owned slots', () => {
    expect(
      countFreeUnownedSlots([
        { slot_id: 'a', is_processing: false },
        { slot_id: 'b', is_processing: true },
        { slot_id: 'c', is_processing: false, owner_session_id: 'live' },
        { slot_id: 'd', is_processing: false },
      ]),
    ).toBe(2);
  });

  it('countFreeUnownedSlots is fail-closed for a missing is_processing', () => {
    expect(
      countFreeUnownedSlots([{ slot_id: 'a' } as unknown as LlamaSlot]),
    ).toBe(0);
  });

  it('countFreeUnownedSlots is 0 when every slot is owned (AC3 all-owned condition)', () => {
    // The literal all-owned case for the per-slot owner-lease gate
    // (WL-0MU8807BI008C9ME AC3): every slot carries a live owner lease, so
    // the per-slot free-unowned count — the gate signal in per-slot mode —
    // is exactly zero. A slot that is idle by `is_processing` but owned is
    // still NOT free.
    expect(
      countFreeUnownedSlots([
        { slot_id: 'a', is_processing: true, owner_session_id: 'owner-a' },
        { slot_id: 'b', is_processing: true, owner_session_id: 'owner-b' },
        { slot_id: 'c', is_processing: false, owner_session_id: 'owner-c' },
      ]),
    ).toBe(0);
  });
});

describe('evaluateIdle: idle-but-owned slot is not dispatchable (AC3/AC5)', () => {
  it('per-slot mode treats an owned free slot as busy', () => {
    // 3 slots reported: slot-1 owned (idle), slot-2/slot-3 unowned-free →
    // only 2 genuinely free, so N=2 is idle but N=3 would exceed the total.
    expect(evaluateIdle(perSlotIdleOwned, 2)).toBe(true);
    // Only 1 unowned slot free (slot-1 owned, slot-2 processing) → N=2 busy.
    expect(evaluateIdle(perSlotOwnedOneUnowned, 2)).toBe(false);
  });

  it('a single idle-but-owned slot reports busy (count-based path)', () => {
    // The global owner lease derives local_lease_active → the count-based
    // path fails closed.
    expect(evaluateIdle(singleSlotIdleOwned, 0)).toBe(false);
    expect(evaluateIdle(singleSlotIdleOwned, 1)).toBe(false);
  });
});

describe('createPerSlotIdleTracker: owned slot timer resets (AC5)', () => {
  it('an owned slot never accumulates idle time', () => {
    const tracker = createPerSlotIdleTracker();
    const start = 1_000_000;
    tracker.record(
      [
        { slot_id: 'slot-1', is_processing: false, owner_session_id: 'live' },
        { slot_id: 'slot-2', is_processing: false },
      ],
      start,
    );
    expect(tracker.thresholdMetCount(1_000, start + 5_000)).toBe(1);
  });
});


// ── Truthful lease_state availability (LP-0MVGDUVGE0024YAI) ───────────
//
// Schema v2 distinguishes `generating`, `idle_leased` (reserved-but-idle,
// the upstream false-busy case) and `free`. Only `generating` is busy: an
// `idle_leased` slot is dispatchable capacity, and the global
// `local_lease_active` gate is superseded when truthful per-slot lease state
// is available. Pre-v2 payloads keep the `owner_session_id` behaviour.

describe('truthful lease_state availability (LP-0MVGDUVGE0024YAI)', () => {
  const v2Pool = (leases: Array<'generating' | 'idle_leased' | 'free'>): LlamaStatus => ({
    llama_server_running: true,
    local_active_query: false,
    model_switch_in_progress: false,
    // A live global lease is present in every v2 case: the per-slot
    // lease_state is the authoritative signal.
    local_lease_active: true,
    available_slots: 0,
    total_slots: leases.length,
    status_schema_version: 2,
    capacity_hint: 'idle',
    slots: leases.map((lease_state, index) => ({
      slot_id: `slot-${index + 1}`,
      is_processing: lease_state === 'generating',
      owner_session_id: lease_state === 'free' ? null : 'sess-1',
      lease_state,
    })),
  });

  it('counts idle_leased slots as dispatchable capacity', () => {
    expect(
      countFreeUnownedSlots([
        { slot_id: 'a', is_processing: false, owner_session_id: 'sess', lease_state: 'idle_leased' },
        { slot_id: 'b', is_processing: false, lease_state: 'free' },
        { slot_id: 'c', is_processing: false, owner_session_id: 'sess', lease_state: 'generating' },
        { slot_id: 'd', is_processing: true, lease_state: 'free' },
      ]),
    ).toBe(2);
  });

  it('isSlotAvailableForDispatch: generating is busy, idle_leased/free are available', () => {
    expect(
      isSlotAvailableForDispatch({
        slot_id: 'a',
        is_processing: false,
        lease_state: 'generating',
      }),
    ).toBe(false);
    expect(
      isSlotAvailableForDispatch({
        slot_id: 'b',
        is_processing: false,
        lease_state: 'idle_leased',
      }),
    ).toBe(true);
    expect(
      isSlotAvailableForDispatch({ slot_id: 'c', is_processing: false, lease_state: 'free' }),
    ).toBe(true);
  });

  it('isSlotAvailableForDispatch: a pre-v2 slot keeps the owner_session_id rule', () => {
    expect(
      isSlotAvailableForDispatch({ slot_id: 'a', is_processing: false, owner_session_id: 'live' }),
    ).toBe(false);
    expect(isSlotAvailableForDispatch({ slot_id: 'b', is_processing: false })).toBe(true);
  });

  it('evaluateIdle: an all-idle_leased pool is idle despite a global lease', () => {
    expect(evaluateIdle(v2Pool(['idle_leased', 'idle_leased']), 0)).toBe(true);
    expect(evaluateIdle(v2Pool(['idle_leased', 'idle_leased']), 2)).toBe(true);
  });

  it('evaluateIdle: a generating slot is not available capacity', () => {
    expect(evaluateIdle(v2Pool(['generating', 'idle_leased']), 0)).toBe(false);
    expect(evaluateIdle(v2Pool(['generating', 'idle_leased']), 1)).toBe(true);
  });

  it('evaluateIdle: capacity_hint=saturated is never idle (defensive cross-check)', () => {
    const inconsistent: LlamaStatus = {
      ...v2Pool(['free', 'free']),
      capacity_hint: 'saturated',
    };
    expect(evaluateIdle(inconsistent, 0)).toBe(false);
  });

  it('per-slot tracker: an idle_leased slot accumulates idle time', () => {
    const tracker = createPerSlotIdleTracker();
    const start = 1_000_000;
    tracker.record(v2Pool(['idle_leased']).slots!, start);
    expect(tracker.thresholdMetCount(1_000, start + 5_000)).toBe(1);
  });

  it('per-slot tracker: a generating slot never accumulates idle time', () => {
    const tracker = createPerSlotIdleTracker();
    const start = 1_000_000;
    tracker.record(v2Pool(['generating']).slots!, start);
    expect(tracker.thresholdMetCount(1_000, start + 5_000)).toBe(0);
  });
});

describe('pre-v2 lease regression (LP-0MVGDUVGE0024YAI backward compatibility)', () => {
  it('a pre-v2 idle-but-owned slot is still busy (owner_session_id rule)', () => {
    // No status_schema_version / lease_state: the legacy behaviour must be
    // preserved exactly, so an owned slot is never dispatchable.
    const preV2: LlamaStatus = {
      llama_server_running: true,
      local_active_query: false,
      model_switch_in_progress: false,
      local_lease_active: true,
      available_slots: 1,
      total_slots: 1,
      slots: [{ slot_id: 'slot-1', is_processing: false, owner_session_id: 'live' }],
    };
    expect(countFreeUnownedSlots(preV2.slots!)).toBe(0);
    expect(evaluateIdle(preV2, 0)).toBe(false);
  });
});

// ── Proxy-authoritative local idle age (WL-0MVHSZR9C0012NQY) ──────────
//
// The llama-proxy publishes the authoritative monotonic local idle age
// (`local_idle_seconds`, LP-0MVGD9Z8Z0055Y5J). When it is usable it OWNS the
// idle-DURATION qualification: a worker that starts polling while the GPU has
// already been idle for hours must dispatch on its FIRST poll, while a proxy
// reporting a short idle age must never admit a dispatch on the strength of
// an older local tracker run. The signal qualifies duration only — the
// per-slot availability/fail-closed contract and `requiredFreeSlots` are
// unchanged.

describe('proxy-authoritative local idle age (WL-0MVHSZR9C0012NQY)', () => {
  const THRESHOLD_MS = 60_000;

  function idleAgeStatus(overrides: Partial<LlamaStatus> = {}): LlamaStatus {
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
      contention_queue_depth: 0,
      contention_queued_count: 0,
      ...overrides,
    };
  }

  function makeIdleAgeWorker(opts: {
    status: LlamaStatus;
    requiredFreeSlots?: number;
    thresholdMs?: number;
    recordDecision?: (entry: CoordinationLogEntry, cwd: string) => Promise<void>;
  }) {
    const poller = createDowntimePoller(
      'http://proxy:8000',
      vi.fn().mockResolvedValue(jsonResponseFixture(opts.status)),
    );
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-IDLE-AGE', title: 'Some task', stage: 'intake_complete' },
      }),
      ...(opts.recordDecision ? { recordDecision: opts.recordDecision } : {}),
    });
    const worker = createDowntimeWorker({
      poller,
      deps,
      config: () => ({
        enabled: true,
        thresholdMs: opts.thresholdMs ?? THRESHOLD_MS,
        requiredFreeSlots: opts.requiredFreeSlots ?? 0,
        model: 'plan',
        cwd: '/repo',
        noCandidateCooldownMs: 3_600_000,
        browseItemCount: 20,
      }),
    });
    return { worker, deps };
  }

  it('AC2: an already-elapsed proxy idle age dispatches on the FIRST poll (global mode)', async () => {
    // A fresh worker (fresh tracker, zero idle run) plus a proxy that has been
    // idle for two hours: the first poll must dispatch, without waiting for
    // the local tracker to accumulate `downtimeIdleThresholdMs`.
    const { worker, deps } = makeIdleAgeWorker({
      status: idleAgeStatus({ local_idle_seconds: 7_200, local_last_activity_source: 'finish' }),
    });
    const outcome = await worker.tick();
    expect(outcome.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });

  it('AC2: an already-elapsed proxy idle age dispatches on the FIRST poll (per-slot mode)', async () => {
    const { worker, deps } = makeIdleAgeWorker({
      // 2 of 4 slots required: in per-slot mode the capacity budget still
      // applies, the idle age only satisfies the duration requirement.
      requiredFreeSlots: 2,
      status: idleAgeStatus({ local_idle_seconds: 7_200 }),
    });
    const outcome = await worker.tick();
    expect(outcome.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });

  it('AC3: a short proxy idle age refuses even when the local tracker has an older run', async () => {
    vi.useFakeTimers();
    try {
      const start = 1_000_000;
      vi.setSystemTime(start);
      const { worker, deps } = makeIdleAgeWorker({
        status: idleAgeStatus({ local_idle_seconds: 5 }),
      });
      await worker.tick(); // starts the local idle run — no dispatch yet
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();

      // Long past the threshold: the LOCAL tracker would qualify here, but the
      // proxy (authoritative) still reports a 5 s idle age → refuse.
      vi.setSystemTime(start + THRESHOLD_MS + 30_000);
      const outcome = await worker.tick();
      expect(outcome.dispatched).toBe(false);
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
      // The refusal came from the proxy signal, not from a broken tracker:
      // the local idle run is intact and older than the threshold.
      expect(worker.idleSince).toBe(start);
    } finally {
      vi.useRealTimers();
    }
  });

  it('AC4: a live contention waiter resets the idle run despite a large reported idle age', async () => {
    vi.useFakeTimers();
    try {
      const start = 1_000_000;
      vi.setSystemTime(start);
      const { worker, deps } = makeIdleAgeWorker({
        status: idleAgeStatus({ local_idle_seconds: 7_200, contention_queue_depth: 2 }),
      });
      const outcome = await worker.tick();
      expect(outcome.dispatched).toBe(false);
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
      // The run is reset — no idle credit survives the contention poll.
      expect(worker.idleSince).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('AC4: a processing slot refuses a large reported idle age (per-slot mode)', async () => {
    const { worker, deps } = makeIdleAgeWorker({
      requiredFreeSlots: 2,
      status: idleAgeStatus({
        local_idle_seconds: 7_200,
        slots: [
          { slot_id: 'slot-1', is_processing: true },
          { slot_id: 'slot-2', is_processing: false },
          { slot_id: 'slot-3', is_processing: false },
        ],
        available_slots: 2,
        total_slots: 3,
      }),
    });
    const outcome = await worker.tick();
    // Activity on the poll outranks the idle age: the local tracker decides,
    // and a fresh worker has no accumulated run yet.
    expect(outcome.dispatched).toBe(false);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('AC4: a live (pre-v2) lease refuses a large reported idle age', async () => {
    const { worker, deps } = makeIdleAgeWorker({
      status: idleAgeStatus({
        local_idle_seconds: 7_200,
        local_lease_active: true,
        local_owner_session_id: 'operator-session',
        slots: [{ slot_id: 'slot-1', is_processing: false, owner_session_id: 'operator-session' }],
        available_slots: 1,
        total_slots: 1,
      }),
    });
    const outcome = await worker.tick();
    expect(outcome.dispatched).toBe(false);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(worker.idleSince).toBeNull();
  });

  it('AC5: an absent idle age (pre-feature proxy) restores the local tracker exactly', async () => {
    vi.useFakeTimers();
    try {
      const start = 1_000_000;
      vi.setSystemTime(start);
      const { worker, deps } = makeIdleAgeWorker({ status: idleAgeStatus() });
      await worker.tick();
      expect(deps.spawnAgentPane).not.toHaveBeenCalled(); // threshold not yet met
      vi.setSystemTime(start + THRESHOLD_MS - 1);
      expect((await worker.tick()).dispatched).toBe(false); // 1 ms short
      vi.setSystemTime(start + THRESHOLD_MS);
      expect((await worker.tick()).dispatched).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('AC6: a large idle age never bypasses the slots-unavailable contract', async () => {
    for (const overrides of [
      { slots: [], slots_stale: true },
      { slots: [] },
    ] as Array<Partial<LlamaStatus>>) {
      const recordDecision = vi.fn().mockResolvedValue(undefined);
      const { worker, deps } = makeIdleAgeWorker({
        status: idleAgeStatus({ ...overrides, local_idle_seconds: 7_200 }),
        recordDecision,
      });
      const outcome = await worker.tick();
      expect(outcome.dispatched).toBe(false);
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
      expect(worker.blockReason).toBe('no-slots');
      expect(recordDecision.mock.calls[0][0]).toMatchObject({
        reason: 'slots-unavailable',
        localIdleSeconds: 7_200,
      });
    }
  });

  it('AC7: a deferred tick records idle-age-pending with the idle-age evidence', async () => {
    const recordDecision = vi.fn().mockResolvedValue(undefined);
    const { worker } = makeIdleAgeWorker({
      status: idleAgeStatus({ local_idle_seconds: 5, local_last_activity_source: 'dispatch' }),
      recordDecision,
    });
    const outcome = await worker.tick();
    expect(outcome.dispatched).toBe(false);
    expect(recordDecision.mock.calls[0][0]).toMatchObject({
      reason: 'idle-age-pending',
      localIdleSeconds: 5,
      localLastActivitySource: 'dispatch',
    });
    // An observation, never a refusal: the header token is untouched.
    expect(worker.blockReason).toBeNull();
  });

  it('AC7: the decision log records the idle age and the activity source', async () => {
    const recordDecision = vi.fn().mockResolvedValue(undefined);
    const { worker } = makeIdleAgeWorker({
      // thresholdMs: 0 so the readiness gate is immediately satisfied and the
      // contention refusal (which carries the idle-age evidence) is reached.
      thresholdMs: 0,
      status: idleAgeStatus({
        local_idle_seconds: 12.5,
        local_last_activity_source: 'chunk',
        contention_queue_depth: 2,
      }),
      recordDecision,
    });
    await worker.tick();
    expect(recordDecision).toHaveBeenCalledTimes(1);
    expect(recordDecision.mock.calls[0][0]).toMatchObject({
      reason: 'proxy-contention',
      localIdleSeconds: 12.5,
      localLastActivitySource: 'chunk',
    });
  });
});

// ── Prefill-gate pacing helper (WL-0MVHSZRZQ00482QX) ──────────────────
//
// `evaluatePrefillPacing` computes the per-tick prefill pacing decision from
// the proxy's serialisation-gate fields (LP-0MVGDUUV3001XFRJ): the prefill
// capacity budget (0 while cap reached, else the headroom, unbounded when
// the cap is absent or 0) and the deferral reason (gate waiters first, then
// cap saturation, then a projected wait above the admission budget).
describe('evaluatePrefillPacing (WL-0MVHSZRZQ00482QX)', () => {
  it('AC2: cap reached → capacityBudget 0 and deferReason prefill-cap', () => {
    const pacing = evaluatePrefillPacing(
      { ...prefillPacingStatus(), local_prefills_in_flight: 1 },
      null,
    );
    expect(pacing.inFlight).toBe(1);
    expect(pacing.cap).toBe(1);
    expect(pacing.capacityBudget).toBe(0);
    expect(pacing.deferReason).toBe('prefill-cap');
  });

  it('AC2: below the cap the budget is the remaining prefill headroom (at least 1)', () => {
    const pacing = evaluatePrefillPacing(
      { ...prefillPacingStatus(), local_max_concurrent_prefills: 2, local_prefills_in_flight: 1 },
      null,
    );
    expect(pacing.capacityBudget).toBe(1);
    expect(pacing.deferReason).toBeUndefined();
    const atZero = evaluatePrefillPacing(
      { ...prefillPacingStatus(), local_max_concurrent_prefills: 1, local_prefills_in_flight: 0 },
      null,
    );
    expect(atZero.capacityBudget).toBe(1);
  });

  it('AC5: cap absent or 0 → unbounded prefill budget (capacityBudget undefined)', () => {
    const absent = evaluatePrefillPacing(prefillPacingStatus({ local_max_concurrent_prefills: undefined }), null);
    expect(absent.cap).toBeUndefined();
    expect(absent.capacityBudget).toBeUndefined();
    expect(absent.deferReason).toBeUndefined();
    const zero = evaluatePrefillPacing(prefillPacingStatus({ local_max_concurrent_prefills: 0 }), null);
    expect(zero.capacityBudget).toBeUndefined();
    expect(zero.deferReason).toBeUndefined();
  });

  it('AC3: prefill_gate_waiters > 0 defers with the distinct prefill-gate reason', () => {
    const pacing = evaluatePrefillPacing(prefillPacingStatus({ prefill_gate_waiters: 2 }), null);
    expect(pacing.gateWaiters).toBe(2);
    expect(pacing.deferReason).toBe('prefill-gate');
  });

  it('AC3: zero gate waiters is not contention evidence on its own', () => {
    const pacing = evaluatePrefillPacing(prefillPacingStatus({ prefill_gate_waiters: 0 }), null);
    expect(pacing.deferReason).toBeUndefined();
  });

  it('AC4: queue_eta_seconds above the budget defers with prefill-eta', () => {
    const pacing = evaluatePrefillPacing(prefillPacingStatus({ queue_eta_seconds: 300 }), null);
    expect(pacing.queueEtaSeconds).toBe(300);
    expect(pacing.budgetSeconds).toBe(120);
    expect(pacing.deferReason).toBe('prefill-eta');
  });

  it('AC4: a per-slot prefill ETA above the budget defers with prefill-eta', () => {
    const status = prefillPacingStatus({
      local_max_concurrent_prefills: 2,
      local_prefills_in_flight: 1,
      slots: [
        { slot_id: 'slot-1', is_processing: true, lease_state: 'generating', phase: 'prefill', prefill_eta_seconds: 300 },
        { slot_id: 'slot-2', is_processing: false, lease_state: 'free' },
        { slot_id: 'slot-3', is_processing: false, lease_state: 'free' },
        { slot_id: 'slot-4', is_processing: false, lease_state: 'free' },
      ],
    });
    const pacing = evaluatePrefillPacing(status, status.slots ?? null);
    expect(pacing.maxSlotPrefillEtaSeconds).toBe(300);
    expect(pacing.deferReason).toBe('prefill-eta');
  });

  it('AC4: a missing budget or ETA never blocks dispatch', () => {
    const noBudget = evaluatePrefillPacing(
      prefillPacingStatus({ prefill_budget_seconds: undefined, queue_eta_seconds: 300 }),
      null,
    );
    expect(noBudget.deferReason).toBeUndefined();
    const noEta = evaluatePrefillPacing(
      prefillPacingStatus({ queue_eta_seconds: undefined }),
      null,
    );
    expect(noEta.deferReason).toBeUndefined();
  });

  it('AC4: a queue ETA within the budget does not defer', () => {
    const pacing = evaluatePrefillPacing(prefillPacingStatus({ queue_eta_seconds: 30 }), null);
    expect(pacing.deferReason).toBeUndefined();
  });
});

// ── Pacing gate: calibration prerequisite + occupancy-only ETA ────────
//
// Parent WL-0MVPRZU0A000TSWD: the live dispatcher deferred every tick with
// `prefill-eta` on a fully idle pool (`capacityHint: idle`, `freeSlots 2/2`,
// nothing prefilling, no gate waiters) because the proxy's 97.5 s
// `queue_eta_seconds` exceeded the 60 s admission budget. That ETA is the
// NEWCOMER's own cold prefill — an unavoidable service cost, not a queue
// wait — and it was UNCALIBRATED (the proxy's own admission guard is inert at
// `insufficient_samples`). Deferring on it livelocks dispatch: never dispatch
// ⇒ never calibrate ⇒ stay pessimistic ⇒ never dispatch.
//
// The contract these specs pin:
//  - AC1 (parent): an uncalibrated ETA never paces dispatch (fail open), while
//    `prefill-cap` and `prefill-gate` keep their precedence;
//  - AC2 (parent): only OCCUPANCY paces — a wait behind other prefills; the
//    newcomer's own prefill (and an idle slot's stale per-slot ETA) never
//    blocks dispatch;
//  - AC3 (parent): a real occupancy ETA above the budget still defers with the
//    existing `prefill-eta` reason.
//
// RED WITNESS: the parent-AC1/AC2 specs below are `it.fails` — today the gate
// defers on `queue_eta_seconds` alone (and on any slot's `prefill_eta_seconds`,
// busy or not), so those bodies fail until the pacing fix lands. The suite
// stays GREEN meanwhile. Implementation child WL-0MVPUE4C9005380J flips each
// `it.fails` to `it` as it lands.
describe('evaluatePrefillPacing — calibration + occupancy (WL-0MVPUDYHD000QI0K)', () => {
  it.fails(
    'parent AC1: an uncalibrated ETA above the budget never defers (fail open)',
    () => {
      // The incident fixture: idle pool, 97.5 s own-prefill ETA, 60 s budget,
      // `prefill_eta_calibrated: false`.
      const status = prefillIdleUncalibrated;
      const pacing = evaluatePrefillPacing(status, status.slots ?? null);
      expect(pacing.queueEtaSeconds).toBe(97.5);
      expect(pacing.budgetSeconds).toBe(60);
      expect(pacing.deferReason).toBeUndefined();
    },
  );

  it('parent AC1: gate waiters still defer while the proxy is uncalibrated', () => {
    const pacing = evaluatePrefillPacing(
      { ...prefillIdleUncalibrated, prefill_gate_waiters: 2 },
      null,
    );
    expect(pacing.gateWaiters).toBe(2);
    expect(pacing.deferReason).toBe('prefill-gate');
  });

  it('parent AC1: a saturated cap still defers while the proxy is uncalibrated', () => {
    const pacing = evaluatePrefillPacing(
      { ...prefillIdleUncalibrated, local_prefills_in_flight: 1 },
      null,
    );
    expect(pacing.capacityBudget).toBe(0);
    expect(pacing.deferReason).toBe('prefill-cap');
  });

  it.fails(
    'parent AC2: a calibrated zero-occupancy pool never defers on a high own-prefill ETA',
    () => {
      const status = prefillIdleZeroOccupancy;
      const pacing = evaluatePrefillPacing(status, status.slots ?? null);
      // The 300 s ETA is entirely the newcomer's own prefill: no slot is
      // busy and the occupancy terms are zero.
      expect(pacing.queueEtaSeconds).toBe(300);
      expect(pacing.budgetSeconds).toBe(60);
      expect(pacing.deferReason).toBeUndefined();
    },
  );

  it.fails(
    'parent AC2: an idle slot\u2019s stale per-slot prefill ETA never defers',
    () => {
      // Same zero-occupancy pool, but a STALE per-slot `prefill_eta_seconds`
      // lingers on a slot that is not processing: an idle pool has no
      // in-flight slot ETA to respect.
      const status = prefillPacingStatus({
        ...prefillIdleZeroOccupancy,
        slots: [
          { slot_id: 'slot-1', is_processing: false, lease_state: 'free', prefill_eta_seconds: 300 },
          { slot_id: 'slot-2', is_processing: false, lease_state: 'free' },
        ],
      });
      const pacing = evaluatePrefillPacing(status, status.slots ?? null);
      expect(pacing.deferReason).toBeUndefined();
    },
  );

  it.fails(
    'parent AC2: occupancy below the budget does not defer even when the total ETA exceeds it',
    () => {
      // Own prefill (~97.5 s) + 30 s behind one in-flight prefill: the total
      // ETA (127.5 s) is above the 60 s budget, but the only PACED term —
      // occupancy — is below it.
      const status = prefillPacingStatus({
        local_prefills_in_flight: 1,
        local_max_concurrent_prefills: 2,
        prefill_budget_seconds: 60,
        queue_eta_seconds: 127.5,
        queue_eta_occupancy_seconds: 30,
        queue_eta_busy_slots: 1,
        prefill_eta_calibrated: true,
        slots: [
          { slot_id: 'slot-1', is_processing: true, lease_state: 'generating' },
          { slot_id: 'slot-2', is_processing: false, lease_state: 'free' },
        ],
      });
      const pacing = evaluatePrefillPacing(status, status.slots ?? null);
      expect(pacing.deferReason).toBeUndefined();
    },
  );

  it('parent AC3: an occupancy ETA above the budget still defers with prefill-eta', () => {
    // One slot prefilling, 300 s of occupancy wait, 60 s budget, capacity
    // headroom still positive (cap 2, one in flight) and no per-slot ETA on
    // the busy slot — only the occupancy term can explain the paced tick.
    const status = prefillBusyOccupancy;
    const pacing = evaluatePrefillPacing(status, status.slots ?? null);
    expect(pacing.capacityBudget).toBe(1);
    expect(pacing.gateWaiters).toBe(0);
    expect(pacing.budgetSeconds).toBe(60);
    expect(pacing.deferReason).toBe('prefill-eta');
  });

  it.fails('parent AC3: an uncalibrated busy pool does not defer on the ETA either', () => {
    const status = prefillPacingStatus({
      ...prefillBusyOccupancy,
      prefill_eta_calibrated: false,
    });
    const pacing = evaluatePrefillPacing(status, status.slots ?? null);
    expect(pacing.deferReason).toBeUndefined();
  });
});
