/**
 * packages/herdr/src/fetcher-spawn-cap.test.ts — bounded `wl` spawn
 * concurrency (F5 — WL-0MVJV2PC2008PY64).
 *
 * An unbounded fan-out of `wl` reads is a memory hazard: each process peaks at
 * ~120–145 MB on the operator's ~100 MB store, so a dozen concurrent reads
 * would blow the parent epic's ≤ ~300 MB per-pane ceiling long before the
 * fan-out thins out. This suite pins the F5 contract:
 *
 *   1. reads never exceed the documented cap of concurrent `wl` processes,
 *      whatever the burst size;
 *   2. queued reads are released FIFO on a microtask — they never block the
 *      TUI event loop and every read still settles (nothing is dropped);
 *   3. a failing read releases its slot (no slot leak wedges the queue);
 *   4. reads that are deduplicated by the in-flight memo consume ONE slot
 *      (dedupe and the cap compose, they do not double-count);
 *   5. writes are NOT capped: a claim/`wl comment add` must never queue behind
 *      a refresh's read slots.
 *
 * The real spawn is replaced through the fetcher's injectable exec seam
 * (`setExecFileAsync`), so no `wl` process is started by this suite.
 *
 * Run: npx vitest run packages/herdr/src/fetcher-spawn-cap.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_WL_SPAWN_CAP,
  fetchItemDetails,
  getWlSpawnCap,
  resetExecFileAsync,
  resetWlSpawnCap,
  setExecFileAsync,
  setWlSpawnCap,
  _resetWlSpawnStats,
  _wlSpawnStats,
} from './fetcher.js';

/** Resolve after `n` macrotask turns, letting queued releases run. */
async function settle(turns = 5): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Install an exec seam whose spawns block until the test releases them, and
 * record the peak number of simultaneously in-flight child processes.
 */
function installGatedExec(): {
  release: () => void;
  started: () => number;
  args: () => string[][];
} {
  let started = 0;
  let released = false;
  const args: string[][] = [];
  const gates: Array<() => void> = [];

  setExecFileAsync((async (_file: unknown, argv: unknown) => {
    args.push([...((argv as string[]) ?? [])]);
    started += 1;
    // Once released, every later spawn resolves immediately (queued reads
    // that acquire a slot AFTER the release must not deadlock on old gates).
    if (released) {
      return { stdout: '{"success":true,"workItems":[]}', stderr: '' };
    }
    await new Promise<void>((resolve) => {
      gates.push(resolve);
    });
    return { stdout: '{"success":true,"workItems":[]}', stderr: '' };
  }) as Parameters<typeof setExecFileAsync>[0]);

  return {
    release: () => {
      released = true;
      for (const resolve of gates.splice(0)) resolve();
    },
    started: () => started,
    args: () => args,
  };
}

describe('bounded wl spawn concurrency (F5 — WL-0MVJV2PC2008PY64)', () => {
  beforeEach(() => {
    resetWlSpawnCap();
    _resetWlSpawnStats();
  });

  afterEach(() => {
    resetExecFileAsync();
    resetWlSpawnCap();
    _resetWlSpawnStats();
  });

  it('documents a cap of 2 concurrent read spawns per pane', () => {
    // The documented budget (docs/dev/herdr-event-driven-refresh.md) is
    // cap × per-spawn peak; at ~125–145 MB per spawn a cap of 2 keeps the
    // aggregate ≤ ~290 MB, inside the parent AC 5 ≤ ~300 MB ceiling.
    expect(DEFAULT_WL_SPAWN_CAP).toBe(2);
    expect(getWlSpawnCap()).toBe(DEFAULT_WL_SPAWN_CAP);
  });

  it('rejects a meaningless cap (below 1)', () => {
    expect(() => setWlSpawnCap(0)).toThrow(/positive integer/);
    expect(() => setWlSpawnCap(-3)).toThrow(/positive integer/);
    expect(() => setWlSpawnCap(1.5)).toThrow(/positive integer/);
  });

  it('never runs more than the cap of read spawns at once, and settles every read', async () => {
    const gate = installGatedExec();
    const burst = 8;
    const reads = Array.from({ length: burst }, (_, index) =>
      // Distinct ids keep the in-flight memo from deduplicating them.
      fetchItemDetails(`WL-FAKE${index}`),
    );

    // Let the burst get as far as it can: exactly `cap` spawns are in flight
    // and the rest are queued (never spawned, never dropped).
    await settle();
    expect(getWlSpawnCap()).toBe(DEFAULT_WL_SPAWN_CAP);
    expect(gate.started()).toBe(DEFAULT_WL_SPAWN_CAP);
    expect(_wlSpawnStats().active).toBe(DEFAULT_WL_SPAWN_CAP);
    expect(_wlSpawnStats().queued).toBe(burst - DEFAULT_WL_SPAWN_CAP);

    gate.release();
    const settled = await Promise.all(reads);

    // Every read resolved (nothing dropped)…
    expect(settled.length).toBe(burst);
    // …every read spawned exactly once (the cap queues, it does not coalesce
    // distinct reads)…
    expect(gate.started()).toBe(burst);
    // …and the cap was never exceeded at any point.
    expect(_wlSpawnStats().peak).toBeLessThanOrEqual(DEFAULT_WL_SPAWN_CAP);
    expect(_wlSpawnStats().active).toBe(0);
    expect(_wlSpawnStats().queued).toBe(0);
  });

  it('releases queued reads FIFO without blocking the event loop', async () => {
    // Cap 1 serialises the burst, so the settle order is a strict FIFO probe:
    // the only way {2,3} can settle ahead of {0,1} would be a LIFO/priority
    // release — never a parallel reordering.
    setWlSpawnCap(1);
    const gate = installGatedExec();
    const settleOrder: number[] = [];
    let ticked = 0;
    const heartbeat = setInterval(() => {
      ticked += 1;
    }, 1);

    const reads = Array.from({ length: 4 }, (_, index) =>
      fetchItemDetails(`WL-FIFO${index}`).then(() => {
        settleOrder.push(index);
      }),
    );
    await settle(2);
    expect(gate.started()).toBe(1);
    gate.release();
    await Promise.all(reads);
    clearInterval(heartbeat);

    // FIFO: the settle order matches the issue order.
    expect(settleOrder).toEqual([0, 1, 2, 3]);
    // The loop kept ticking while reads were queued and released: the release
    // path is a microtask, so a spawn-heavy burst cannot freeze input.
    expect(ticked).toBeGreaterThan(0);
  });

  it('releases the slot when a read rejects (no slot leak)', async () => {
    let call = 0;
    setExecFileAsync((async () => {
      call += 1;
      if (call <= DEFAULT_WL_SPAWN_CAP) {
        throw new Error('wl exploded');
      }
      return { stdout: '{"success":true,"workItems":[]}', stderr: '' };
    }) as Parameters<typeof setExecFileAsync>[0]);

    const failing = await Promise.allSettled(
      Array.from({ length: DEFAULT_WL_SPAWN_CAP }, (_, index) =>
        fetchItemDetails(`WL-BOOM${index}`),
      ),
    );
    expect(failing.length).toBe(DEFAULT_WL_SPAWN_CAP);
    expect(_wlSpawnStats().active).toBe(0);
    expect(_wlSpawnStats().queued).toBe(0);

    // A subsequent read still gets a slot (the semaphore did not wedge).
    const after = await fetchItemDetails('WL-AFTER');
    expect(after).toBeNull();
    expect(_wlSpawnStats().active).toBe(0);
  });

  it('counts a deduplicated racing read as ONE slot', async () => {
    const gate = installGatedExec();
    // The same read issued twice concurrently: the in-flight memo shares the
    // promise, so only one `wl` process (and one slot) is taken.
    const a = fetchItemDetails('WL-SAME');
    const b = fetchItemDetails('WL-SAME');
    await settle(2);

    expect(gate.started()).toBe(1);
    expect(_wlSpawnStats().active).toBe(1);
    expect(_wlSpawnStats().queued).toBe(0);

    gate.release();
    await Promise.all([a, b]);
    expect(gate.started()).toBe(1);
    expect(_wlSpawnStats().active).toBe(0);
  });

  it('keeps the cap effective for a burst larger than the queue it replaces', async () => {
    setWlSpawnCap(1);
    const gate = installGatedExec();
    const reads = Array.from({ length: 5 }, (_, index) =>
      fetchItemDetails(`WL-SERIAL${index}`),
    );
    await settle(2);
    // Serialised: exactly one spawn is in flight, four wait.
    expect(gate.started()).toBe(1);
    expect(_wlSpawnStats().queued).toBe(4);

    gate.release();
    await Promise.all(reads);
    expect(_wlSpawnStats().peak).toBe(1);
    expect(gate.started()).toBe(5);
  });
});
