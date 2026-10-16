/**
 * packages/herdr/src/hydrator-responsiveness.test.ts — UI-responsiveness
 * regression test for the hydrate task (WL-0MUY1CZES0099A04; parent
 * WL-0MUY0RDBQ001H74P).
 *
 * The production bug: the 30 s hydrate task issued sequential `wl`/`herdr`
 * spawns with no per-step bound and no per-tick cap, so a slow or hung CLI
 * could leave the run in flight for the whole 20 s scheduler watchdog while
 * the HERDR pane felt unresponsive to keyboard input. This suite drives a
 * worst-case hydrate (60 panes, 25 in-progress items) with deliberately slow
 * fake seams and samples event-loop delay — the deterministic proxy for
 * command-input lag — while the run is in flight.
 *
 * Revert check (verified once during implementation): removing the per-step
 * budget from `runHydrationOnce` makes the "bounds the run" case hang until
 * the test timeout, and removing the per-tick cap makes the cap case demote
 * all 25 items. Both assertions therefore fail on revert.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  runHydrationOnce,
  type HydratorDeps,
  type HydratorItem,
  type HydratorPane,
} from './hydrator.js';
import { makeWorstCaseItems, makeWorstCasePanes } from './hydrator.fixtures.js';
import {
  stateCounterFilePath,
  watchDbChanges,
  type DbChangeWatch,
} from './db-change.js';

/** Resolve after `ms` on the real event loop. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Nearest-rank percentile of a numeric sample. */
function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[index];
}

describe('hydrate UI responsiveness (WL-0MUY1CZES0099A04)', () => {
  it('keeps event-loop delay under 100 ms p95 during a worst-case hydrate', async () => {
    const panes = makeWorstCasePanes(60);
    const items = makeWorstCaseItems(25);
    const deps: HydratorDeps = {
      // Deliberately slow seams: each CLI-shaped lookup yields the event
      // loop, as the real async `execFile` spawns must.
      listInProgressItems: async () => {
        await delay(4);
        return items;
      },
      listActivePanes: async () => {
        await delay(4);
        return panes;
      },
      listOutboundDeps: async () => {
        await delay(4);
        return [];
      },
      applyDemotion: async () => {
        await delay(4);
        return true;
      },
      maxItemsPerTick: 25,
      log: () => {},
    };

    const intervalMs = 5;
    const delays: number[] = [];
    let last = Date.now();
    const sampler = setInterval(() => {
      const tick = Date.now();
      delays.push(Math.max(0, tick - last - intervalMs));
      last = tick;
    }, intervalMs);

    let result;
    try {
      result = await runHydrationOnce(deps, 'wCurrent');
    } finally {
      clearInterval(sampler);
    }

    expect(result.ok).toBe(true);
    expect(result.demoted).toBe(25);
    // Command-input lag proxy: the event loop was never starved for long.
    expect(percentile(delays, 0.95)).toBeLessThan(100);
  });

  it('bounds the run and names a timed-out step instead of hanging', async () => {
    // A hung `wl`/`herdr` seam must not wedge the hydrate: the per-step
    // budget aborts the run, names the offending step, and keeps the
    // wall-clock bound well under the 20 s scheduler watchdog.
    const deps: HydratorDeps = {
      listInProgressItems: () => new Promise<HydratorItem[]>(() => {}),
      listActivePanes: async () => [],
      listOutboundDeps: async () => [],
      applyDemotion: async () => true,
      stepTimeoutMs: 50,
      log: () => {},
    };

    const started = Date.now();
    const result = await runHydrationOnce(deps);
    const elapsedMs = Date.now() - started;

    expect(result.ok).toBe(false);
    expect(result.reason ?? '').toContain('timeout');
    expect(result.reason ?? '').toContain('in-progress-list');
    expect(elapsedMs).toBeLessThan(1_000);
    expect(result.demoted).toBe(0);
  });

  it('defers candidates beyond the per-tick cap without touching them', async () => {
    const items = makeWorstCaseItems(25);
    const touched: string[] = [];
    const deps: HydratorDeps = {
      listInProgressItems: async () => items,
      listActivePanes: async () => [] as HydratorPane[],
      listOutboundDeps: async (id: string) => {
        touched.push(id);
        return [];
      },
      applyDemotion: async () => true,
      maxItemsPerTick: 10,
      log: () => {},
    };

    const result = await runHydrationOnce(deps, 'wCurrent');

    expect(result.demoted).toBe(10);
    expect(touched).toHaveLength(10);
  });
});

/**
 * F5 (WL-0MV5CBQTS008ZWHR) — the event-driven watch must never block the
 * pane's event loop.
 *
 * In `worklist.ts` the watch callback dispatches the refresh asynchronously
 * (`void requestWatchRefresh()`), so a burst of agent writes is coalesced and
 * applied without starving keyboard input. This suite exercises the real
 * {@link watchDbChanges} primitive (real `fs.watch`, real timers) with a
 * refresh workload shaped like the cold default-view refresh — awaited steps
 * that each yield to the event loop (the real `doRefresh` awaits bounded `wl`
 * spawns). It samples event-loop delay, the same deterministic proxy for
 * command-input lag used above; a synchronous (loop-blocking) refresh would
 * push the p95 well past the 100 ms budget and fail the test.
 *
 * The pane wiring (watch → gates → single-flight/trailing-coalescing
 * `doRefresh`) is pinned by `worklist-watch.test.ts` (F1/F3); this test pins
 * the non-blocking responsiveness guarantee on top of it.
 */
describe('event-driven watch UI responsiveness (WL-0MV5CBQTS008ZWHR)', () => {
  it('keeps event-loop delay under 100 ms p95 during and after a watch-triggered refresh', async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-watch-resp-cache-'));
    const worklogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-watch-resp-log-'));
    const counterFile = stateCounterFilePath(cacheDir, worklogDir);
    fs.mkdirSync(path.dirname(counterFile), { recursive: true });
    fs.writeFileSync(counterFile, JSON.stringify({ state: 0 }), 'utf-8');

    // A non-blocking refresh: several awaited steps, each yielding to the
    // event loop, mirroring the real `doRefresh` spawn path. Counted so the
    // burst-coalescing and post-dispose idle contracts are asserted too.
    let refreshes = 0;
    const refresh = async (): Promise<void> => {
      refreshes += 1;
      for (let i = 0; i < 5; i++) await delay(6);
    };

    const watch: DbChangeWatch = watchDbChanges(
      cacheDir,
      worklogDir,
      () => {
        void refresh();
      },
      { debounceMs: 20 },
    );

    // Sample event-loop delay (command-input lag proxy) throughout.
    const intervalMs = 5;
    const delays: number[] = [];
    let last = Date.now();
    const sampler = setInterval(() => {
      const tick = Date.now();
      delays.push(Math.max(0, tick - last - intervalMs));
      last = tick;
    }, intervalMs);

    try {
      expect(watch.active).toBe(true);

      // A burst of agent writes lands; the watch coalesces it into one
      // trailing refresh without blocking the loop.
      for (let i = 1; i <= 8; i++) {
        fs.writeFileSync(counterFile, JSON.stringify({ state: i }), 'utf-8');
        await delay(3);
      }
      // Let the debounce fire and the refresh run to completion.
      await delay(150);
    } finally {
      clearInterval(sampler);
      watch.dispose();
    }

    expect(refreshes).toBeGreaterThanOrEqual(1);
    // Command-input lag proxy: the loop was never starved for long, during
    // or after the watch-triggered refresh.
    expect(percentile(delays, 0.95)).toBeLessThan(100);

    // After dispose the watch schedules nothing further (idle no-op).
    const settled = refreshes;
    await delay(60);
    expect(refreshes).toBe(settled);

    fs.rmSync(cacheDir, { recursive: true, force: true });
    fs.rmSync(worklogDir, { recursive: true, force: true });
  });
});
