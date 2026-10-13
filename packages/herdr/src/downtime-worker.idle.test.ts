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

import { describe, it, expect } from 'vitest';
import {
  isIdleStatus,
  evaluateIdle,
  createIdleTracker,
  createPerSlotIdleTracker,
  countFreeUnownedSlots,
  isSlotOwned,
  DEFAULT_DOWNTIME_POLL_INTERVAL_MS,
  DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
  DEFAULT_DOWNTIME_REQUIRED_FREE_SLOTS,
  type LlamaStatus,
  type LlamaSlot,
} from './downtime-worker.js';
import {
  makeDeps,
  singleSlotIdleOwned,
  perSlotIdleOwned,
  perSlotOwnedOneUnowned,
} from './downtime-worker.fixtures.js';

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

