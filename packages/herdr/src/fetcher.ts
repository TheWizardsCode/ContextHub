/**
 * packages/herdr/src/fetcher.ts — barrel for the fetcher family.
 *
 * `./fetcher.js` is the single specifier every consumer imports (parent
 * WL-0MVGKH47T007GKN1 AC2). This module only re-exports the family's leaf
 * modules and declares no functions, types or constants of its own; the split
 * is a move-only refactor, so the public surface and behaviour are unchanged.
 *
 * Every fetch path is fail-open: a `wl` spawn or in-process read that fails
 * resolves the documented fallback (or `undefined`) instead of throwing, so a
 * caller always has a safe path — see `./fetcher.cli.js` and
 * `./fetcher.inprocess.js`.
 *
 * Module layout (single responsibility and key exports per leaf) is documented
 * in `docs/dev/herdr-event-driven-refresh.md` → "Fetcher module layout".
 *
 * The only non-re-export content is this file's import wiring: the two
 * cache-invalidation hooks a leaf cannot register itself, because a leaf must
 * not import this barrel (parent AC4).
 */

import { setWorklogDirChangedHandler } from './fetcher.args.js';
import { clearFetchMemo, setFetchMemoInvalidationHandler } from './fetcher.cli.js';
import { clearWorklistBundleCaches } from './fetcher.worklist-bundle.js';

// A worklog-dir change drops the in-flight fetch memo; a memo invalidation (the
// write path) also drops the worklist-bundle snapshot. Registered here because
// neither leaf may import the barrel (parent AC4).
setWorklogDirChangedHandler(clearFetchMemo);
setFetchMemoInvalidationHandler(clearWorklistBundleCaches);

// ── Argument/exec primitives ──────────────────────────────────────────

export {
  formatWlError,
  setWorklogDir,
  getWorklogDir,
  buildWlArgs,
  buildWlArgsForRoot,
  resetWorklogDir,
  setExecFileAsync,
  getExecFileAsync,
  resetExecFileAsync,
} from './fetcher.args.js';
export type {
  BlockerRef,
  ClaimResult,
  DependencyTargetRef,
  InProcessOpenStats,
  InProcessRefreshScope,
  ReviewQueueState,
  WlError,
  WorkItem,
} from './fetcher.types.js';

// ── Bounded `wl` spawn concurrency + payload JSON helpers ─────────────

export {
  DEFAULT_WL_SPAWN_CAP,
  getWlSpawnCap,
  setWlSpawnCap,
  resetWlSpawnCap,
  _wlSpawnStats,
  _resetWlSpawnStats,
} from './fetcher.spawn-cap.js';
export { extractJson, extractItems } from './fetcher.json.js';

// ── CLI execution + in-process SQLite reads ──────────────────────────

export { DEFAULT_WL_TIMEOUT_MS, clearFetchMemo, _fetchMemoSize } from './fetcher.cli.js';
export {
  getInProcessOpenStats,
  resetInProcessOpenStats,
  createInProcessRefreshScope,
} from './fetcher.inprocess.js';

// ── Consolidated worklist bundle + review-queue state ────────────────

export { fetchReviewQueueState } from './fetcher.review-queue.js';

// ── Public fetch API + critical-child root substitution ──────────────

export {
  checkWlAvailable,
  fetchActionableCount,
  fetchBlockersForItem,
  fetchChildrenForItem,
  fetchChildrenForItems,
  fetchCompletedItemCount,
  fetchItemDetails,
  fetchItemsByPriority,
  fetchItemsByStage,
  fetchNextItems,
  fetchOutboundDepsForItems,
  runWlSync,
} from './fetcher.api.js';

// ── Work-item claiming ────────────────────────────────────────────────

export {
  claimWorkItem,
  rollbackClaimWorkItem,
  markNeedsProducerReviewWorkItem,
} from './fetcher.claim.js';
