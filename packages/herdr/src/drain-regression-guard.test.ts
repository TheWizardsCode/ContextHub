/**
 * Regression guard for the withdrawn client-side drain (WL-0MUWIHUL2000JEFR).
 * Owned by WL-0MV563AU2007FM56, a child of WL-0MV54ZP3Y00514Y9 ("Resume
 * model-exhausted jobs instead of switching to cheap").
 *
 * The withdrawn predecessor removed three behaviours from the cheap-switch
 * path. The model-cooldown machinery must not have reintroduced any of them:
 *
 *  1. **No client-side slot-count completion gate.** The old drain waited for
 *     `MODE_SWITCH_DRAIN_FREE_SLOTS` (= `DOWNTIME_AUDIT_MIN_FREE_SLOTS` = 2)
 *     free slots before switching to cheap. The proxy's own server-side
 *     bounded drain stays authoritative; the client only applies the per-slot
 *     operator minimum (1 free slot), so a 3-slot pool with 1 free slot still
 *     switches.
 *  2. **No dispatch pause.** The old `drainPaused` worker config made the
 *     downtime dispatcher skip NEW dispatches while draining. The
 *     model-cooldown gate is confined to the cheap-switch decision and never
 *     pauses dispatch.
 *  3. **No unbounded latch.** The old `draining` boolean could hold the switch
 *     indefinitely. The cooldown hold is bounded by `cooldownUntil` — the
 *     reader returns only active entries, so the first tick at/after expiry
 *     resumes the normal decision.
 *
 * The tests assert observable behaviour through the public worker API and the
 * absence of the withdrawn module surface; they do not grep the source.
 *
 * Run: npx vitest run packages/herdr/src/drain-regression-guard.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as modeSwitchModule from './mode-switch-worker.js';
import {
  createModeSwitchWorker,
  type AdminApiFetcher,
} from './mode-switch-worker.js';
import {
  createDowntimePoller,
  createDowntimeWorker,
  type DowntimeWorkerConfig,
  type LlamaStatus,
} from './downtime-worker.js';
import {
  idleAllSlotsFree,
  jsonResponseFixture,
  makeDeps,
} from './downtime-worker.fixtures.js';
import { writeModelCooldown } from '@worklog/shared/model-cooldown';

// ── Helpers ────────────────────────────────────────────────────────────

/** Flush fire-and-forget promise chains (the worker's cheap POST). */
async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

interface RecordedCall {
  url: string;
  method: string;
  body?: string;
}

/**
 * Minimal admin-API fetcher: records POSTs (the mode switches) and reports
 * `fast` on GET so the cheap switch is never suppressed by a stale mode.
 */
function recordAdminCalls(): { fetcher: AdminApiFetcher; posts: RecordedCall[] } {
  const posts: RecordedCall[] = [];
  const fetcher: AdminApiFetcher = async (url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'POST') {
      posts.push({ url, method, body: init?.body });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return { ok: true, status: 200, json: async () => ({ mode: 'fast' }) };
  };
  return { fetcher, posts };
}

/** 3-slot proxy with `free` slots free and the remaining slots processing. */
function threeSlotStatus(free: number): LlamaStatus {
  return {
    llama_server_running: true,
    local_active_query: false,
    model_switch_in_progress: false,
    local_lease_active: false,
    available_slots: free,
    total_slots: 3,
    slots: [0, 1, 2].map((i) => ({
      slot_id: `slot-${i + 1}`,
      is_processing: i >= free,
    })),
  };
}

// ── (1) No client-side slot-count completion gate + (3) no unbounded latch ──

describe('withdrawn client-side drain — cheap-switch path (WL-0MV563AU2007FM56)', () => {
  let cooldownDir: string;
  let clock: number;
  const now = () => clock;

  beforeEach(() => {
    cooldownDir = mkdtempSync(join(tmpdir(), 'wl-drain-regression-'));
    clock = 1_000_000;
  });

  afterEach(() => {
    rmSync(cooldownDir, { recursive: true, force: true });
  });

  it('has no slot-count completion gate: a 3-slot pool with 1 free slot still switches to cheap', async () => {
    const { fetcher, posts } = recordAdminCalls();
    const worker = createModeSwitchWorker({
      fetcher,
      now,
      isLeader: () => true,
      coordinationDir: cooldownDir,
    });
    clock += 900_000; // idle window met

    await worker.tick({
      enabled: true,
      idleThresholdMs: 900_000,
      proxyUrl: 'http://proxy',
      // The withdrawn drain completion gate required 2 free slots; this status
      // has only 1, which must not block the cheap switch any more.
      proxyStatus: threeSlotStatus(1),
    });
    await flushAsync();

    expect(posts).toHaveLength(1);
    expect(posts[0].body).toBe(JSON.stringify({ mode: 'cheap' }));

    // The withdrawn drain-state surface and its completion budget are gone.
    expect('getIsDraining' in worker).toBe(false);
    expect(
      (modeSwitchModule as Record<string, unknown>).MODE_SWITCH_DRAIN_FREE_SLOTS,
    ).toBeUndefined();
  });

  it('has no unbounded latch: the cooldown hold ends exactly at cooldownUntil', async () => {
    const { fetcher, posts } = recordAdminCalls();
    const worker = createModeSwitchWorker({
      fetcher,
      now,
      isLeader: () => true,
      coordinationDir: cooldownDir,
    });
    clock += 900_000;
    const cooldownUntil = clock + 60_000;
    writeModelCooldown(
      cooldownDir,
      { paneId: 'pane-exhausted', reason: 'all providers exhausted', cooldownUntil },
      clock,
    );

    // Held while the cooldown is active (an all-free idle proxy would otherwise
    // switch immediately).
    await worker.tick({
      enabled: true,
      idleThresholdMs: 900_000,
      proxyUrl: 'http://proxy',
      proxyStatus: threeSlotStatus(3),
    });
    await flushAsync();
    expect(posts).toHaveLength(0);

    // The first tick at/after `cooldownUntil` resumes the normal cheap decision
    // — the hold is not a latch.
    clock = cooldownUntil;
    await worker.tick({
      enabled: true,
      idleThresholdMs: 900_000,
      proxyUrl: 'http://proxy',
      proxyStatus: threeSlotStatus(3),
    });
    await flushAsync();
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toBe(JSON.stringify({ mode: 'cheap' }));
  });
});

// ── (2) No dispatch pause ──────────────────────────────────────────────

describe('withdrawn dispatch pause — downtime dispatcher (WL-0MV563AU2007FM56)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wl-drain-pause-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('ignores a legacy drainPaused config and still dispatches a new pane', async () => {
    const poller = createDowntimePoller(
      'http://proxy:8000',
      vi.fn().mockResolvedValue(jsonResponseFixture(idleAllSlotsFree)),
    );
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-DRAIN', title: 'Drain regression', stage: 'intake_complete' },
      }),
      getRunningDowntimePanes: vi.fn().mockResolvedValue({
        ok: true,
        count: 0,
        paneIds: [],
        records: [],
      }),
    });
    // The withdrawn `drainPaused` worker config: if it were honoured again the
    // worker would skip the NEW dispatch below and return "draining".
    const legacyConfig = {
      enabled: true,
      thresholdMs: 0,
      requiredFreeSlots: 1,
      model: 'plan',
      cwd: root,
      noCandidateCooldownMs: 3_600_000,
      browseItemCount: 20,
      drainPaused: true,
    } as unknown as ReturnType<DowntimeWorkerConfig['config']>;

    const worker = createDowntimeWorker({
      poller,
      deps,
      config: () => ({ ...legacyConfig }),
    });
    const outcome = await worker.tick();

    expect(outcome.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });
});
