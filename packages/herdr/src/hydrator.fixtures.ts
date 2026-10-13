/**
 * packages/herdr/src/hydrator.fixtures.ts — shared fixtures for the hydrator
 * responsiveness contract suite (WL-0MUY1CX9900258E6).
 *
 * The contract is written test-first, so the fixtures are deliberately small,
 * deterministic and free of real timers:
 *
 *   • `hydratorExecRouter()` installs a recording exec seam: it answers every
 *     hydrator CLI shape with minimal valid JSON and records the exact
 *     `(bin, args, options)` of every spawn, so tests can assert the stdio
 *     and argument contract.
 *   • `makeWorstCaseTabs()` / `makeWorstCaseItems()` build the load profile
 *     the fix must survive (50+ tabs, 20+ in-progress items).
 *
 * No `vitest` import: these are plain builders consumed by the test file (and
 * by the implementation children's tests), so they stay usable outside a
 * vitest runtime.
 */

import type { HydratorItem, HydratorTab } from './hydrator.js';

// ── Recording exec seam ───────────────────────────────────────────────

/** One recorded CLI spawn. */
export interface RecordedSpawn {
  bin: string;
  args: string[];
  options: Record<string, unknown>;
}

/** Injectable exec seam shape used by the hydrator production deps. */
export type HydratorExec = (
  bin: string,
  args: string[],
  options?: unknown,
) => Promise<{ stdout: string; stderr: string }>;

export interface HydratorExecHarness {
  /** Every spawn, in order. */
  calls: RecordedSpawn[];
  /** The recording implementation to install via `setExecFileAsync()`. */
  exec: HydratorExec;
}

/**
 * Build a recording exec seam that answers the four hydrator CLI shapes with
 * minimal valid JSON and records every call. The tab-listing shape answers
 * `herdr tab list` (the hydrator's active-detection input).
 */
export function hydratorExecRouter(): HydratorExecHarness {
  const calls: RecordedSpawn[] = [];

  const exec: HydratorExec = async (bin, args, options) => {
    calls.push({
      bin,
      args,
      options: (options ?? {}) as Record<string, unknown>,
    });

    if (bin === 'herdr' && args.includes('tab') && args.includes('list')) {
      return { stdout: JSON.stringify({ result: { tabs: [] } }), stderr: '' };
    }
    if (args.includes('dep')) {
      return { stdout: JSON.stringify({ outbound: [] }), stderr: '' };
    }
    if (args.includes('update')) {
      return { stdout: JSON.stringify({ success: true }), stderr: '' };
    }
    if (args.includes('list')) {
      return { stdout: JSON.stringify({ workItems: [] }), stderr: '' };
    }
    return { stdout: '{}', stderr: '' };
  };

  return { calls, exec };
}

// ── Worst-case load fixtures ──────────────────────────────────────────

/** Zero-pad `n` so the generated work-item IDs match WORK_ITEM_ID_REGEX. */
function padded(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/**
 * Worst-case tab volume: `count` tabs (default 60) split across the current
 * workspace (`wCurrent`, even indices) and another workspace, each labelled
 * with an exact work-item ID as a real per-item tab would be.
 */
export function makeWorstCaseTabs(count = 60): HydratorTab[] {
  return Array.from({ length: count }, (_, i) => ({
    tab_id: `tab-${i}`,
    label: `WL-TAB${padded(i, 7)}`,
    workspace_id: i % 2 === 0 ? 'wCurrent' : 'wOther',
  }));
}

/**
 * Worst-case in-progress volume: `count` (default 25) tab-less candidates,
 * all at `plan_complete` so every one is eligible for demotion.
 */
export function makeWorstCaseItems(count = 25): HydratorItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `WL-ITEM${padded(i, 7)}`,
    title: `Stuck item ${i}`,
    status: 'in-progress',
    stage: 'plan_complete',
  }));
}
