/**
 * Tests for stale-slot-detail attribution (WL-0MW1VITA8009RLHQ).
 *
 * Incident (2026-11-04): the proxy served `slots_stale: true` together with
 * `slots_detail_stale: true` and `slot_counts_stale: false` — detail frozen in
 * an 8-hour-old snapshot while the counts were fresh. herdr read only
 * `slots_stale`, collapsed all of that into one opaque `slots-unavailable`
 * refusal, and the decision log could not distinguish "the proxy's `/slots`
 * query is failing" from "only the counts are cached". `local_abandoned_slots`
 * (served as 2 while both cached slots were frozen `is_processing`) was not
 * parsed at all.
 *
 * Contract under test:
 *  1. `slots_detail_stale`, `slot_counts_stale` and `local_abandoned_slots` are
 *     parsed with the SAME optional contract as `slots_stale`: absent →
 *     undefined (legacy proxy, unchanged behaviour); non-boolean flag →
 *     reject the poll (fail-closed); present → carried on LlamaStatus.
 *  2. Availability is UNCHANGED: `slots` stays usable only when non-empty and
 *     not `slots_stale`; the count-based fallback stays removed. The new flags
 *     are evidence, never an alternative budget.
 *  3. Every `slots-unavailable` decision entry carries the observed flags, so a
 *     stop is attributable from the decision log alone.
 *  4. `local_abandoned_slots` is carried as advisory evidence, so a
 *     self-contradictory snapshot (counts say free, detail says all slots busy)
 *     is visible in the record.
 *  5. A legacy payload records none of the new fields (log shape unchanged).
 *  6. The herdr header keeps ONE `no-slots` blocking token for every unusable
 *     per-slot detail (WL-0MW2F2B5W004V57W, parent AC4): the staleness
 *     distinction lives on the decision entry, not in the header — see the
 *     rationale in `decisionHeaderToken` and
 *     docs/dev/downtime-dispatcher.md → "Why the header keeps a single
 *     `no-slots` token".
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseLlamaStatus,
  createDowntimeWorker,
  createDowntimePoller,
  type DowntimeWorkerDeps,
} from './downtime-worker.js';
import { usablePerSlotSlots, evaluateIdle, countFreeUnownedSlots } from './downtime-worker.idle.js';
import { capacityEvidence, decisionHeaderToken } from './downtime-worker.constants.js';
import { readCoordinationLogEntries } from './downtime-log.js';

// ── Payload fixtures ───────────────────────────────────────────────────

/** The exact live shape observed on 2026-11-04 (router-mode frozen snapshot). */
function frozenSnapshotPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    llama_server_running: true,
    local_active_query: false,
    model_switch_in_progress: false,
    local_lease_active: false,
    available_slots: 2,
    total_slots: 2,
    capacity_hint: 'idle',
    // Detail frozen in an old snapshot, counts fresh.
    slots_stale: true,
    slots_detail_stale: true,
    slot_counts_stale: false,
    local_abandoned_slots: 2,
    slots: [
      { slot_id: 0, is_processing: true, lease_state: 'generating' },
      { slot_id: 1, is_processing: true, lease_state: 'generating' },
    ],
    ...overrides,
  };
}

function legacyPayload(): Record<string, unknown> {
  return {
    llama_server_running: true,
    local_active_query: false,
    model_switch_in_progress: false,
    local_lease_active: false,
    available_slots: 2,
    total_slots: 2,
    slots: [
      { slot_id: 'slot-0', is_processing: false },
      { slot_id: 'slot-1', is_processing: false },
    ],
  };
}

// ── 1. Parsing contract ────────────────────────────────────────────────

describe('parseLlamaStatus: stale-detail flags', () => {
  it('carries slots_detail_stale, slot_counts_stale and local_abandoned_slots', () => {
    const status = parseLlamaStatus(frozenSnapshotPayload());
    expect(status).not.toBeNull();
    expect(status!.slots_stale).toBe(true);
    expect(status!.slots_detail_stale).toBe(true);
    expect(status!.slot_counts_stale).toBe(false);
    expect(status!.local_abandoned_slots).toBe(2);
  });

  it('distinguishes detail-stale-from-counts-fresh (the incident combination)', () => {
    const status = parseLlamaStatus(
      frozenSnapshotPayload({ slots_stale: true, slots_detail_stale: true, slot_counts_stale: false }),
    )!;
    // The two new flags are independent of `slots_stale` and of each other.
    expect(status.slots_detail_stale).toBe(true);
    expect(status.slot_counts_stale).toBe(false);
  });

  it('leaves the new fields undefined on a legacy payload', () => {
    const status = parseLlamaStatus(legacyPayload())!;
    expect(status.slots_stale).toBeUndefined();
    expect(status.slots_detail_stale).toBeUndefined();
    expect(status.slot_counts_stale).toBeUndefined();
    expect(status.local_abandoned_slots).toBeUndefined();
  });

  it.each([
    ['slots_detail_stale', 'yes'],
    ['slots_detail_stale', 1],
    ['slot_counts_stale', 'true'],
    ['slot_counts_stale', null],
  ])('a malformed %s (%s) rejects the poll (fail-closed)', (field, value) => {
    expect(parseLlamaStatus(legacyPayload_({ [field]: value }))).toBeNull();
  });

  it.each([
    ['local_abandoned_slots', -1],
    ['local_abandoned_slots', 'two'],
  ])('a malformed %s (%s) rejects the poll', (field, value) => {
    expect(parseLlamaStatus(legacyPayload_({ [field]: value }))).toBeNull();
  });

  it('accepts explicit false/0 (a healthy snapshot that reports its shape)', () => {
    const status = parseLlamaStatus(
      legacyPayload_({ slots_detail_stale: false, slot_counts_stale: false, local_abandoned_slots: 0 }),
    )!;
    expect(status.slots_detail_stale).toBe(false);
    expect(status.slot_counts_stale).toBe(false);
    expect(status.local_abandoned_slots).toBe(0);
  });
});

/** Legacy payload plus explicit overrides (keeps the base legitimately usable). */
function legacyPayload_(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...legacyPayload(), ...overrides };
}

// ── 2. Availability must NOT broaden ──────────────────────────────────

describe('availability is unchanged by the new evidence', () => {
  it('stale detail still fails closed even when the counts are fresh', () => {
    const status = parseLlamaStatus(frozenSnapshotPayload())!;
    // The trap this item guards against: fresh counts + stale detail must NOT
    // be read as usable capacity.
    expect(status.slot_counts_stale).toBe(false);
    expect(usablePerSlotSlots(status)).toBeNull();
    expect(evaluateIdle(status, 1)).toBe(false);
  });

  it('a frozen snapshot never yields a free-slot budget', () => {
    const status = parseLlamaStatus(frozenSnapshotPayload())!;
    expect(countFreeUnownedSlots(status.slots!)).toBe(0);
    // Yet the untrusted count claims 2 — the contradiction is exactly what the
    // evidence fields make visible instead of silently trusting.
    expect(status.available_slots).toBe(2);
    expect(status.capacity_hint).toBe('idle');
  });

  it('an unflagged payload keeps the trusted per-slot path', () => {
    const status = parseLlamaStatus(legacyPayload())!;
    expect(usablePerSlotSlots(status)).not.toBeNull();
    expect(evaluateIdle(status, 1)).toBe(true);
    expect(countFreeUnownedSlots(status.slots!)).toBe(2);
  });
});

// ── 3. Decision-entry attribution ─────────────────────────────────────

describe('capacityEvidence carries the stale-detail flags', () => {
  it('records the flags and the abandoned-slot count', () => {
    const status = parseLlamaStatus(frozenSnapshotPayload())!;
    const evidence = capacityEvidence(status, usablePerSlotSlots(status));
    expect(evidence.slotsStale).toBe(true);
    expect(evidence.slotsDetailStale).toBe(true);
    expect(evidence.slotCountsStale).toBe(false);
    expect(evidence.localAbandonedSlots).toBe(2);
  });

  it('omits every new field for a legacy proxy (log shape unchanged)', () => {
    const status = parseLlamaStatus(legacyPayload())!;
    const evidence = capacityEvidence(status, usablePerSlotSlots(status));
    expect(evidence).not.toHaveProperty('slotsStale');
    expect(evidence).not.toHaveProperty('slotsDetailStale');
    expect(evidence).not.toHaveProperty('slotCountsStale');
    expect(evidence).not.toHaveProperty('localAbandonedSlots');
  });
});

describe('slots-unavailable decision entries are attributable', () => {
  function makeWorker(payload: Record<string, unknown>, root: string) {
    let idx = 0;
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => (idx++ === 0 ? payload : payload),
    }));
    const deps = {
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
      recordError: vi.fn().mockResolvedValue(undefined),
      getDueScheduledPrompt: vi.fn().mockResolvedValue(null),
      recordScheduledPromptTrigger: vi.fn().mockResolvedValue(true),
      readCodeFreezeStatus: vi.fn().mockReturnValue('not-frozen'),
      fetchItem: vi.fn().mockResolvedValue({ ok: true, info: { id: 'WL-X', stage: 'idea', status: 'open' } }),
      getActiveAudit: vi.fn().mockResolvedValue({ ok: true, active: false }),
      getReviewQueueCount: vi.fn().mockResolvedValue(0),
      getRunningDowntimePanes: vi.fn().mockResolvedValue({ ok: true, count: 0, paneIds: [], records: [] }),
    } as unknown as DowntimeWorkerDeps;
    return createDowntimeWorker({
      poller: createDowntimePoller('http://proxy:8000', fetcher as never, 5000),
      deps,
      config: () => ({
        enabled: true,
        thresholdMs: 0,
        requiredFreeSlots: 1,
        model: 'plan',
        cwd: root,
        noCandidateCooldownMs: 3_600_000,
      }),
    });
  }

  it('records which signal was stale, so the stop is diagnosable from the log', async () => {
    const root = mkdtempSync(join(tmpdir(), 'herdr-stale-evidence-'));
    try {
      const worker = makeWorker(frozenSnapshotPayload(), root);
      await worker.tick();
      expect(worker.blockReason).toBe('no-slots');

      await vi.waitFor(async () => {
        const decisions = (await readCoordinationLogEntries(root)).filter((e) => e.kind === 'decision');
        expect(decisions).toHaveLength(1);
        expect(decisions[0]).toMatchObject({
          reason: 'slots-unavailable',
          freeSlots: 0,
          totalSlots: 2,
          slotsStale: true,
          slotsDetailStale: true,
          slotCountsStale: false,
          localAbandonedSlots: 2,
        });
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps one `no-slots` header token: the staleness distinction lives in the record', async () => {
    const staleRoot = mkdtempSync(join(tmpdir(), 'herdr-stale-token-'));
    const plainRoot = mkdtempSync(join(tmpdir(), 'herdr-plain-token-'));
    try {
      // Frozen snapshot vs a plainly unusable (empty) per-slot payload. Both
      // are `slots-unavailable`; the header must NOT split (AC4 decision:
      // the blocking state an operator acts on is identical either way).
      const staleWorker = makeWorker(frozenSnapshotPayload(), staleRoot);
      await staleWorker.tick();
      const plainWorker = makeWorker({ ...legacyPayload(), slots: [] }, plainRoot);
      await plainWorker.tick();

      expect(decisionHeaderToken('slots-unavailable')).toBe('no-slots');
      expect(staleWorker.blockReason).toBe('no-slots');
      expect(plainWorker.blockReason).toBe('no-slots');

      // The distinction the header deliberately omits IS attributable on the
      // decision entry — and the plain payload's entry keeps its old shape.
      await vi.waitFor(async () => {
        const stale = (await readCoordinationLogEntries(staleRoot)).filter((e) => e.kind === 'decision');
        expect(stale).toHaveLength(1);
        expect(stale[0]).toMatchObject({
          reason: 'slots-unavailable',
          slotsStale: true,
          slotsDetailStale: true,
          slotCountsStale: false,
          localAbandonedSlots: 2,
        });
        const plain = (await readCoordinationLogEntries(plainRoot)).filter((e) => e.kind === 'decision');
        expect(plain).toHaveLength(1);
        expect(plain[0].reason).toBe('slots-unavailable');
        expect(plain[0]).not.toHaveProperty('slotsDetailStale');
        expect(plain[0]).not.toHaveProperty('slotCountsStale');
      });
    } finally {
      rmSync(staleRoot, { recursive: true, force: true });
      rmSync(plainRoot, { recursive: true, force: true });
    }
  });

  it('records no stale-evidence fields for a legacy proxy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'herdr-stale-legacy-'));
    try {
      // An empty slot array is the pre-feature "no detail" shape → unusable.
      const worker = makeWorker({ ...legacyPayload(), slots: [] }, root);
      await worker.tick();
      await vi.waitFor(async () => {
        const decisions = (await readCoordinationLogEntries(root)).filter((e) => e.kind === 'decision');
        expect(decisions).toHaveLength(1);
        expect(decisions[0].reason).toBe('slots-unavailable');
        expect(decisions[0]).not.toHaveProperty('slotsStale');
        expect(decisions[0]).not.toHaveProperty('slotsDetailStale');
        expect(decisions[0]).not.toHaveProperty('slotCountsStale');
        expect(decisions[0]).not.toHaveProperty('localAbandonedSlots');
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
