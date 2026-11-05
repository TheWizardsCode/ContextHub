/**
 * packages/herdr/src/fetcher.spawn-cap.ts — bounded `wl` spawn concurrency limiter.
 *
 * Single responsibility: the process-wide semaphore that caps concurrent `wl`
 * READ spawns — the documented default/settable cap, the strict-FIFO waiter
 * queue and the peak/queued stats counters. Leaf module: it imports nothing, so
 * it can never widen an import cycle (parent AC4). Moved verbatim out of
 * `fetcher.ts` (parent WL-0MVGKH47T007GKN1; extraction WL-0MW08VUKQ005BU1B).
 * `acquireWlSpawnSlot`/`releaseWlSpawnSlot` are exported for the CLI-execution
 * path in `fetcher.ts` (their only consumer) and are deliberately NOT
 * re-exported from the barrel, so the public spawn-cap surface stays exactly
 * the six symbols consumers already import. No behaviour change.
 */

// ── Bounded `wl` spawn concurrency (F5 — WL-0MVJV2PC2008PY64) ────────

/**
 * Maximum number of concurrent `wl` READ spawns one pane may keep in flight.
 *
 * Without a bound, a spawn-heavy refresh (fallback per-subset/per-parent
 * reads, per-edge `wl show` / `wl dep list` probes) can fan out to a dozen
 * `wl` processes at once — each peaking at ~120–145 MB on a large DB — and
 * blow past the parent epic's ≤ ~300 MB aggregate per-pane RSS ceiling
 * before concurrency ever thins out naturally. Capping concurrent reads at
 * {@link DEFAULT_WL_SPAWN_CAP} bounds the pane's aggregate spawn RSS at
 * `cap × per-spawn peak` (per-spawn peaks measured per profile/target by the
 * F1 harness and recorded in `large-db-budget.json`; the bound is documented
 * in `docs/dev/herdr-event-driven-refresh.md` § "Bounded `wl` spawn
 * concurrency (F5 — WL-0MVJV2PC2008PY64)").
 *
 * F8 (`WL-0MVKVJYV6008SL9G`) tightened the cap from 2 to 1: F7's end-to-end
 * verification measured a **cold** `wl show` peak of 144.6–175.3 MB per spawn
 * on the built CLI at full scale, so `2 × peak` (289–351 MB) could not
 * guarantee the ≤ ~300 MB ceiling. A cap of 1 bounds the worst case at one
 * spawn's peak (≤ ~176 MB) with margin, and also halves the measured
 * event-loop blocking of a spawn burst. Serialising reads costs wall time on
 * the rare fallback fan-out paths; the consolidated single-read default view
 * and the in-process expand/hydrator reads are unaffected.
 *
 * Only READ commands are capped. Writes (claims, `wl comment add`, chord
 * commands, `wl sync`) spawn immediately: they are user-driven, rare, and
 * already serialised by the CLI's own mutation lock, so queueing them behind
 * reads would add latency without bounding a real memory fan-out. `wl sync`
 * additionally keeps its own F3 isolation path (auto-sync.ts) untouched.
 *
 * The queue is promise-based and strictly FIFO: a waiter is released on a
 * microtask when a slot frees, so queued reads NEVER block the TUI event
 * loop (asserted by the F1 harness spawn-burst scenario).
 */
export const DEFAULT_WL_SPAWN_CAP = 1;

let wlSpawnCap = DEFAULT_WL_SPAWN_CAP;
let activeWlSpawns = 0;
let peakActiveWlSpawns = 0;
const wlSpawnWaiters: Array<() => void> = [];

/**
 * The current spawn-concurrency cap (concurrent `wl` read spawns allowed).
 * Exported so the harness/tests assert the documented bound.
 */
export function getWlSpawnCap(): number {
  return wlSpawnCap;
}

/**
 * Override the cap (a positive integer). The harness uses this to prove the
 * enforcement is the documented constant even when a test changes it. Values
 * below 1 are rejected — the documented bound must stay meaningful.
 */
export function setWlSpawnCap(cap: number): void {
  if (!Number.isInteger(cap) || cap < 1) {
    throw new Error(`wl spawn cap must be a positive integer (got ${String(cap)})`);
  }
  wlSpawnCap = cap;
}

/** Restore the documented default cap (test teardown / harness reset). */
export function resetWlSpawnCap(): void {
  wlSpawnCap = DEFAULT_WL_SPAWN_CAP;
}

/** Test helper: current semaphore state (cap, active, peak, queued waiters). */
export function _wlSpawnStats(): {
  cap: number;
  active: number;
  peak: number;
  queued: number;
} {
  return {
    cap: wlSpawnCap,
    active: activeWlSpawns,
    peak: peakActiveWlSpawns,
    queued: wlSpawnWaiters.length,
  };
}

/** Test helper: clear the semaphore counters (per-test isolation). */
export function _resetWlSpawnStats(): void {
  activeWlSpawns = 0;
  peakActiveWlSpawns = 0;
  wlSpawnWaiters.length = 0;
}

/**
 * Reserve a spawn slot, waiting FIFO when the cap is reached. Never blocks.
 *
 * Returns how long the caller waited (ms) so a queued read can inherit the
 * timeout budget of the refresh that issued it — see {@link queuedTimeout}.
 */
export async function acquireWlSpawnSlot(): Promise<number> {
  const grab = (): void => {
    activeWlSpawns += 1;
    if (activeWlSpawns > peakActiveWlSpawns) peakActiveWlSpawns = activeWlSpawns;
  };
  if (activeWlSpawns < wlSpawnCap) {
    grab();
    return 0;
  }
  const queuedAt = Date.now();
  await new Promise<void>((resolve) => {
    wlSpawnWaiters.push(() => {
      grab();
      resolve();
    });
  });
  return Date.now() - queuedAt;
}

/** Free a slot and hand it to the oldest waiter (FIFO, on a microtask). */
export function releaseWlSpawnSlot(): void {
  activeWlSpawns -= 1;
  const next = wlSpawnWaiters.shift();
  if (next !== undefined) {
    queueMicrotask(next);
  }
}
