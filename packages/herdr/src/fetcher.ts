/**
 * packages/herdr/src/fetcher.ts — barrel for the fetcher family.
 *
 * Single responsibility: keep `./fetcher.js` the one specifier every consumer
 * imports (parent WL-0MVGKH47T007GKN1 AC2) by re-exporting the family's leaf
 * modules unchanged — the argument/exec primitives, the data types, the
 * spawn-cap limiter, the JSON helpers, `wl` CLI execution, in-process SQLite
 * reads, the consolidated worklist bundle, review-queue state, the
 * critical-child root substitution, the work-item claiming mutations and the
 * public fetch API. It also registers the two cache-invalidation hooks the
 * leaves cannot wire themselves (a leaf may not import this barrel).
 *
 * The monolith was split section by section (parent WL-0MVGKH47T007GKN1); the
 * barrel's own final form is the close-out child (WL-0MW08VZ5M003OK2X).
 * Behaviour is unchanged by every extraction: this file only re-exports.
 */

import { setWorklogDirChangedHandler } from './fetcher.args.js';
import { clearFetchMemo, setFetchMemoInvalidationHandler } from './fetcher.cli.js';
import { clearWorklistBundleCaches } from './fetcher.worklist-bundle.js';

// ── Re-exported leaf modules (move-only split) ────────────────────────
//
// Consumers keep importing every symbol from `./fetcher.js`: the barrel
// re-exports the arg/exec primitives, the pure data types, the spawn-cap
// limiter and the JSON helpers from their extracted leaf modules, so no
// consumer import path changes.

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

// The in-flight fetch memo and the worklist-bundle snapshot live in this
// module; the args leaf may not import the barrel (parent AC4), so the
// worklog-dir setters run this invalidation instead.
setWorklogDirChangedHandler(clearFetchMemo);

// The in-flight fetch memo lives in the cli leaf and the worklist-bundle
// snapshot in the bundle leaf; neither leaf may import the barrel (parent
// AC4), so the memo drop is reported here and the snapshot is invalidated
// alongside it (declared below — the handler only runs after module init).
setFetchMemoInvalidationHandler(clearWorklistBundleCaches);

// ── Bounded `wl` spawn concurrency + `wl`-payload JSON helpers ───────
//
// Both sections are extracted verbatim into leaf modules
// (WL-0MW08VUKQ005BU1B): the spawn-cap limiter lives in
// `./fetcher.spawn-cap.js` and the payload extraction/normalisation in
// `./fetcher.json.js`. The barrel re-exports the consumer-imported symbols so
// no consumer import path changes; the slot acquire/release primitives and
// `normalizeItem` stay module-private surface (imported above, never
// re-exported), which is what keeps the frozen public surface unchanged.

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
//
// Both sections are extracted verbatim into leaf modules
// (WL-0MW08VVC0007L28M): the `wl` CLI spawn/timeout/retry/in-flight-memo path
// lives in `./fetcher.cli.js` and the fail-open in-process SQLite read path in
// `./fetcher.inprocess.js`. The barrel re-exports every consumer-imported
// symbol so no consumer import path changes; the memo invalidation seam and the
// private execution helpers stay module-private surface.

export { DEFAULT_WL_TIMEOUT_MS, clearFetchMemo, _fetchMemoSize } from './fetcher.cli.js';
export {
  getInProcessOpenStats,
  resetInProcessOpenStats,
  createInProcessRefreshScope,
} from './fetcher.inprocess.js';

// ── Consolidated worklist bundle + review-queue state ────────────────
//
// Both sections are extracted verbatim into leaf modules
// (WL-0MW08VW3L003U3HG): the TTL-bounded `wl worklist` bundle read in
// `./fetcher.worklist-bundle.js` and the review-queue banner derivation/query
// in `./fetcher.review-queue.js`. The barrel re-exports the consumer-imported
// symbol (`fetchReviewQueueState`) so no consumer import path changes; the
// bundle snapshot/in-flight caches stay module-private to their leaf (the
// barrel only registers the invalidation hook and reads the bundle).

export { fetchReviewQueueState } from './fetcher.review-queue.js';

// ── Public fetch API + critical-child root substitution ──────────────
//
// Both sections are extracted verbatim into leaf modules
// (WL-0MW08VWY6001COFS): the critical-child root substitution and the shared
// default-worklist assembly tail live in `./fetcher.root-substitution.js`, and
// the per-query public fetch API lives in `./fetcher.api.js`. The barrel
// re-exports the consumer-imported fetch functions so no consumer import path
// changes; `mergeUniqueById` and the assembly helpers stay module-private to
// the substitution leaf (no consumer imports them, parent AC3).

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
//
// Extracted verbatim into `./fetcher.claim.js` (WL-0MW08VY7W009DK5W): the
// tier-aware claim, the pre-dispatch rollback and the needs-producer-review
// flag. The barrel re-exports the consumer-imported mutations so no consumer
// import path changes; `CLAIM_TIMEOUT_MS` stays module-private to the leaf and
// the claim argument vectors are unchanged.

export {
  claimWorkItem,
  rollbackClaimWorkItem,
  markNeedsProducerReviewWorkItem,
} from './fetcher.claim.js';
