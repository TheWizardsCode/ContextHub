/**
 * packages/herdr/src/downtime-worker.coordination-batch.ts — the leader's
 * own-head window + audit-batch depth runtime.
 *
 * Extracted verbatim from `downtime-worker.coordination-leader.ts` by
 * WL-0MVR8FKMU009XTED (machine-readable attribution for empty offers and
 * skipped tiers) to keep every `downtime-worker*.ts` production module inside
 * the 1000-line split-guard ceiling while that work item added the leader-side
 * per-entry rejection attribution. No behaviour change: the canonical ranking
 * read (`getHerdrListHead` → bounded window extension) and the memoised
 * audit-eligible depth are byte-identical.
 *
 * Layering: the dependency seam is declared STRUCTURALLY here (only
 * `getHerdrListHead` is needed) instead of importing
 * `CoordinationLeaderDeps` from the leader module — that would create a
 * value-free but still recorded module cycle, which the split guard rejects.
 */

import { resolveSprintViewWindow } from './browse-window.js';
import {
  computeAuditEligibleDepth,
  fetchExtendedHerdrItems,
  type DowntimeGateDeps,
} from './downtime-worker.gates.js';
import type {
  DowntimeHerdrItem,
  DowntimeHerdrListResult,
} from './downtime-worker.types.js';

/**
 * Batch runtime shared between the coordination dispatcher and its finalizer
 * (WL-0MVFE1DD8000D8T2 AC4): memoises the leader's own audit-eligible depth so
 * one invocation reads the own Herdr head at most once, whether the read came
 * from the continuation scan or from the outcome finalizer.
 */
export interface CoordinationBatchRuntime {
  /** Memoised audit-eligible depth over the leader's own head + window extension. */
  readDepth(): Promise<number>;
  /** Record a depth already computed from a window this invocation read. */
  setDepth(depth: number): void;
}

export function createCoordinationBatchRuntime(
  deps: DowntimeGateDeps,
  opts: { cwd: string; browseItemCount?: number },
  now: number,
): CoordinationBatchRuntime {
  let depth: number | null = null;
  let pending: Promise<number> | null = null;
  return {
    setDepth(value: number): void {
      depth = value;
    },
    async readDepth(): Promise<number> {
      if (depth !== null) return depth;
      pending ??= (async () => {
        const window = await readOwnHeadWindow(deps, opts.cwd, opts.browseItemCount);
        return window === null
          ? 0
          : computeAuditEligibleDepth([...window.head, ...window.tail], now);
      })();
      depth = await pending;
      return depth;
    },
  };
}

/**
 * The leader's own dispatch window (WL-0MVFE1DD8000D8T2 AC4): the canonical
 * ranking head windowed to the live sprint view, plus the bounded window
 * EXTENSION (`fetchExtendedHerdrItems`, never a second ranking). Fail-open:
 * a `{ok:false}`/thrown lookup resolves `null` — the caller then falls back to
 * its unchanged behaviour or to a depth of 0 (no batch armed).
 */
export async function readOwnHeadWindow(
  deps: DowntimeGateDeps,
  cwd: string,
  browseItemCount?: number,
): Promise<{ head: DowntimeHerdrItem[]; tail: DowntimeHerdrItem[] } | null> {
  const sprintWindow = resolveSprintViewWindow(browseItemCount);
  let ownHead: DowntimeHerdrListResult | null = null;
  try {
    ownHead = await deps.getHerdrListHead(cwd, sprintWindow);
  } catch {
    ownHead = null;
  }
  if (ownHead === null || !ownHead.ok) return null;
  const tail = await fetchExtendedHerdrItems(deps, cwd, ownHead.items, {
    includeNonCritical: true,
  });
  return { head: ownHead.items, tail };
}
