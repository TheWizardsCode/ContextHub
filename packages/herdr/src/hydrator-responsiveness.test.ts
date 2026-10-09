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
import {
  runHydrationOnce,
  type HydratorDeps,
  type HydratorItem,
  type HydratorPane,
} from './hydrator.js';
import { makeWorstCaseItems, makeWorstCasePanes } from './hydrator.fixtures.js';

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
