/**
 * packages/herdr/src/fetcher.ts — Worklog data fetching via wl CLI
 *
 * Provides typed access to the `wl` command-line interface for fetching
 * work items, filtering by stage, and retrieving item details.
 * All functions return plain data objects and do NOT depend on the
 * Herdr runtime — they can be tested in isolation.
 */

import { join } from 'node:path';
import { selectWorkItems } from './smart-selection.js';
import { regroupWorkItems } from './grouping.js';
import { STAGES } from './worklist.constants.js';
import type { Stage } from './worklist.constants.js';
import { isActiveBlocker } from './hydrator.js';
import { parseDepListBlockersOutput } from './downtime-worker.js';
import {
  getExecFileAsync,
  getWorklogDir,
  setWorklogDirChangedHandler,
} from './fetcher.args.js';
import { extractItems, extractJson, normalizeItem } from './fetcher.json.js';
import {
  CLI_BINARIES,
  DEFAULT_WL_TIMEOUT_MS,
  clearFetchMemo,
  runWl,
  setFetchMemoInvalidationHandler,
} from './fetcher.cli.js';
import { enrichInProcessItems, withInProcessDb } from './fetcher.inprocess.js';
import type {
  BlockerRef,
  ClaimResult,
  DependencyTargetRef,
  InProcessDb,
  InProcessRefreshScope,
  ReviewQueueState,
  RootSubstitution,
  WorkItem,
  WorklistBundle,
} from './fetcher.types.js';
import { isAuditFresh } from '@worklog/shared/icons';

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

// The cli leaf owns the memo, this module owns the worklist-bundle snapshot;
// the leaf may not import the barrel (parent AC4), so it reports a memo drop
// here and the snapshot is invalidated alongside it (declared below — the
// handler only runs after module init).
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

// ── Public API ────────────────────────────────────────────────────────

/**
 * Check whether the wl CLI is available on PATH.
 * Uses DEFAULT_WL_TIMEOUT_MS so a hung --version probe cannot block startup.
 */
export async function checkWlAvailable(): Promise<boolean> {
  const execFileAsync = getExecFileAsync();
  for (const binary of CLI_BINARIES) {
    try {
      await execFileAsync(binary, ['--version'], { maxBuffer: 1024, timeout: DEFAULT_WL_TIMEOUT_MS });
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * Merge work item arrays, deduplicating by item ID (first occurrence wins).
 */
function mergeUniqueById(...arrays: WorkItem[][]): WorkItem[] {
  const seen = new Set<string>();
  const merged: WorkItem[] = [];
  for (const item of arrays.flat()) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      merged.push(item);
    }
  }
  return merged;
}

// ── Consolidated worklist bundle (WL-0MVI0IT4S0070G78) ────────────────
//
// One `wl worklist --json` read replaces the five per-subset spawns a
// default-view refresh used to issue (four mandatory `wl list` queries + the
// `wl next` browse feed). See `docs/dev/herdr-event-driven-refresh.md`
// (§ "Cold-refresh cost") for the design rationale and the measured CPU
// before/after; the command's payload contract is documented in `CLI.md`.

/**
 * How long a fetched bundle may satisfy {@link fetchReviewQueueState}. The
 * banner state is refreshed on every tick, so a short window is invisible to
 * the operator while guaranteeing the concurrent review-state read in a
 * refresh derives from the SAME read instead of spawning a second `wl`.
 * Cleared immediately on any write and on a worklog-dir change.
 */
const WORKLIST_BUNDLE_SNAPSHOT_TTL_MS = 10_000;

/** Most recent successful bundle read, used only for review-queue state. */
let lastWorklistBundle: { dirKey: string; at: number; bundle: WorklistBundle } | null = null;

/**
 * Bundle read currently in flight for the current worklog dir. The
 * review-queue state read starts concurrently with the item fetch, so it
 * awaits this instead of spawning a second `wl` for the same subset.
 */
let inflightWorklistBundle: { dirKey: string; promise: Promise<WorklistBundle> } | null = null;

/**
 * Drop both worklist-bundle caches. Registered with the `wl` CLI leaf
 * (`./fetcher.cli.js`) as its memo-invalidation hook, so a write or a
 * worklog-dir change invalidates the review-queue snapshot derived from a
 * previously fetched bundle (WL-0MVI0IT4S0070G78) even though the leaf may not
 * import this barrel (parent AC4).
 */
function clearWorklistBundleCaches(): void {
  lastWorklistBundle = null;
  inflightWorklistBundle = null;
}

/** Identity of the worklog dir a bundle was read from. */
function worklogDirKey(): string {
  return getWorklogDir() ?? '';
}

/**
 * Parse a `wl worklist --json` payload, failing loudly (so the caller can
 * fail open) when the shape is not the documented one: a missing or
 * non-array subset means the `wl` on PATH is older than the consolidated
 * command and the per-subset spawn path must take over.
 */
function parseWorklistBundle(payload: unknown): WorklistBundle {
  const subsets = (payload as { subsets?: Record<string, unknown> } | null)?.subsets;
  if (!subsets || typeof subsets !== 'object') {
    throw new Error('wl worklist payload has no "subsets" object');
  }
  const listSubset = (key: string): WorkItem[] => {
    const value = subsets[key];
    if (!Array.isArray(value)) {
      throw new Error(`wl worklist payload is missing the "${key}" subset`);
    }
    return extractItems(value);
  };
  const browseRaw = subsets.browse;
  if (!Array.isArray(browseRaw)) {
    throw new Error('wl worklist payload is missing the "browse" subset');
  }
  return {
    critical: listSubset('critical'),
    reviewQueue: listSubset('reviewQueue'),
    inProgressRoots: listSubset('inProgressRoots'),
    blockedRoots: listSubset('blockedRoots'),
    // Browse entries are `{ workItem, reason, group?, groupLabel? }` — the
    // same shape `wl next -n <count> --json` emits, so `extractItems` applies
    // the identical normalization/group propagation.
    browse: browseRaw.length > 0 ? extractItems({ results: browseRaw }) : [],
  };
}

/**
 * Fetch every subset the default view needs in ONE `wl worklist` read.
 *
 * `count` bounds only the browse feed (the mandatory subsets are unbounded by
 * it), mirroring `wl next -n <count> --include-in-progress --include-blocked`
 * plus the four mandatory `wl list` queries. The command is a pure read: it
 * never re-sorts, so this adds no write byproduct and the result is cacheable
 * by the CLI read cache (WL-0MVI0IS6Y0028KTO).
 */
async function fetchWorklistBundle(count?: number, timeoutMs?: number): Promise<WorklistBundle> {
  const args = ['worklist'];
  if (count !== undefined) {
    args.push('-n', String(count));
  }
  const dirKey = worklogDirKey();
  const promise = runWl(args, true, timeoutMs).then((output) => {
    const bundle = parseWorklistBundle(extractJson(output));
    lastWorklistBundle = { dirKey, at: Date.now(), bundle };
    return bundle;
  });
  inflightWorklistBundle = { dirKey, promise };
  try {
    return await promise;
  } finally {
    if (inflightWorklistBundle?.promise === promise) {
      inflightWorklistBundle = null;
    }
  }
}

/**
 * The bundle read currently in flight for this worklog dir, if any. The
 * review-queue state read awaits it so a refresh needs only ONE `wl` spawn.
 */
function pendingWorklistBundle(): Promise<WorklistBundle> | null {
  const inflight = inflightWorklistBundle;
  if (inflight === null) return null;
  if (inflight.dirKey !== worklogDirKey()) return null;
  return inflight.promise;
}

// ── Critical-child root-ancestor substitution (WL-0MVN4WESM007T4XI) ────
//
// The top level may only contain ROOT items (`selectWorkItems` drops every
// item with a `parentId`), so without a substitution step a critical child
// would silently disappear from the default worklist while the ship
// critical-items gate keeps blocking a release on it. Substitution keeps that
// work reachable without rendering the child twice: the child stays hidden at
// the top level, its ROOT ancestor is shown in its place.

/** Maximum `parentId` hops walked when resolving a critical child's root. */
const MAX_ANCESTOR_HOPS = 32;

/**
 * Partition the critical items of a mandatory list into root criticals (kept)
 * and critical children (dropped from the top level). `done` children are
 * skipped: `selectWorkItems` already excludes them, so resolving their
 * ancestors would only cost lookups.
 */
function partitionCriticalItems(mandatory: WorkItem[]): {
  kept: WorkItem[];
  children: WorkItem[];
} {
  const kept: WorkItem[] = [];
  const children: WorkItem[] = [];
  for (const item of mandatory) {
    if (item.priority === 'critical' && item.parentId) {
      if (item.stage !== 'done') children.push(item);
      continue;
    }
    kept.push(item);
  }
  return { kept, children };
}

/**
 * Walk `parentId` upward to the top-most non-child item (the ROOT ancestor).
 *
 * Returns `null` when any link cannot be resolved (fail-open) or the chain is
 * cyclic / deeper than {@link MAX_ANCESTOR_HOPS} (corrupt data must never hang
 * a refresh). The lookup is injected so the caller controls resolution order
 * (merged candidate set → in-process memo → `wl show`).
 */
async function walkToRootAncestor(
  parentId: string,
  lookup: (id: string) => WorkItem | null | Promise<WorkItem | null>,
): Promise<WorkItem | null> {
  const seen = new Set<string>();
  let currentId: string | undefined = parentId;
  while (currentId && !seen.has(currentId) && seen.size < MAX_ANCESTOR_HOPS) {
    seen.add(currentId);
    const parent = await lookup(currentId);
    if (!parent) return null;
    if (!parent.parentId) return parent;
    currentId = parent.parentId;
  }
  return null;
}

/**
 * Display-layer substitution of critical children by their ROOT ancestors
 * (WL-0MVN4WESM007T4XI, WL-0MVSSANRK000V00S):
 *
 *  - the critical subset is partitioned into root criticals (kept) and
 *    critical children (dropped from the top level);
 *  - for each still-actionable critical child the root ancestor is resolved by
 *    walking `parentId` upward to the top-most non-child item;
 *  - every resolved root not already in the mandatory set joins it, so the
 *    root is always shown and never cut by `browseItemCount`.
 *
 * Resolution order: the merged candidate set (free), then the in-process
 * SQLite fast path (`withInProcessDb` → `db.get`, ONE connection for all
 * chains), then `wl show` as the fail-open fallback. Every lookup is memoised
 * per refresh (hits AND misses), so sibling critical children sharing a
 * root/chain cost ONE lookup — no new hot-path spawn when the in-process read
 * succeeds (WL-0MVI0IT4S0070G78 / WL-0MV5CBQ6L005SPAG).
 *
 * Display-layer only: nothing is written back, and the substituted root keeps
 * its own `priority`/`status`/`stage` and group — no badge, marker or
 * indicator is attached. Fail-open: an unresolvable parent (missing/deleted)
 * means the child is simply not shown; the refresh never crashes and never
 * falls back to rendering the child at the top level.
 */
async function substituteCriticalRoots(
  mandatory: WorkItem[],
  candidates: WorkItem[],
): Promise<RootSubstitution> {
  const { kept, children } = partitionCriticalItems(mandatory);
  if (children.length === 0) return { mandatory: kept, roots: [] };

  const knownById = new Map<string, WorkItem>();
  for (const item of [...candidates, ...kept]) {
    if (!knownById.has(item.id)) knownById.set(item.id, item);
  }

  // Per-refresh memo: parent id → item, or null when it does not exist. Both
  // hits and misses are kept so a shared chain is never looked up twice.
  const memo = new Map<string, WorkItem | null>();

  // In-process SQLite fast path: ONE connection pre-resolves every ancestor
  // reachable from an actionable critical child. Skipped entirely when each
  // child's parent is already in the merged candidate set (nothing to read).
  if (children.some((child) => !child.parentId || !knownById.has(child.parentId))) {
    await withInProcessDb((db) => {
      for (const child of children) {
        let currentId = child.parentId;
        while (currentId && !knownById.has(currentId) && !memo.has(currentId)) {
          const raw = db.get(currentId);
          if (!raw) break;
          const parent = normalizeItem(raw);
          memo.set(currentId, parent);
          currentId = parent.parentId;
        }
      }
      return null;
    });
  }

  const lookup = async (id: string): Promise<WorkItem | null> => {
    const known = knownById.get(id);
    if (known) return known;
    if (memo.has(id)) return memo.get(id) ?? null;
    // Fail-open fallback: `fetchItemDetails` runs `wl show` and resolves null
    // on any failure, memoised so sibling children never repeat the spawn.
    const item = await fetchItemDetails(id);
    memo.set(id, item);
    return item;
  };

  const roots: WorkItem[] = [];
  const rootIds = new Set<string>();
  const mandatoryIds = new Set(kept.map((item) => item.id));
  for (const child of children) {
    const parentId = child.parentId;
    if (!parentId) continue;
    const root = await walkToRootAncestor(parentId, lookup);
    if (!root) continue; // Fail-open: the child is not shown at top level.
    if (mandatoryIds.has(root.id) || rootIds.has(root.id)) continue;
    rootIds.add(root.id);
    roots.push(root);
  }
  return { mandatory: [...kept, ...roots], roots };
}

/**
 * Guarantee every substituted root is rendered even when the browse window
 * (`browseItemCount`) would otherwise cut it. Roots join the mandatory set
 * BEFORE selection; this final pass only restores a root the "other" slice
 * dropped, never duplicating a root that was already selected (the caller
 * regroups afterwards, so ordering is unaffected).
 */
function ensureSubstitutedRoots(selected: WorkItem[], roots: WorkItem[]): WorkItem[] {
  if (roots.length === 0) return selected;
  const selectedIds = new Set(selected.map((item) => item.id));
  const missing = roots.filter((root) => !selectedIds.has(root.id));
  return missing.length === 0 ? selected : [...selected, ...missing];
}

/**
 * Shared tail of BOTH default-view fetch paths (the consolidated bundle and
 * the per-subset fallback): apply the critical-child root substitution to the
 * mandatory subsets, merge with the browse feed, then select and regroup.
 *
 *  - mandatory subsets (critical, review queue, in-progress roots, blocked
 *    roots) are always included, whatever the browse window; a critical child
 *    is represented by its substituted root ancestor instead
 *    (WL-0MVN4WESM007T4XI);
 *  - items shared with a mandatory subset take the richer `wl list`-style
 *    audit fields (`auditResult`, `auditedAt`, `fingerprint`,
 *    `currentFingerprint`) so the audit-bucket sort classifies them exactly as
 *    `wl list` does (WL-0MUWDW0N6003KF6G);
 *  - the count limits only the remaining "other" items, and the final set is
 *    regrouped so no duplicate section headings render (WL-0MSAK8YLB0025EGW).
 */
async function mergeMandatoryAndSelect(
  items: WorkItem[],
  mandatory: WorkItem[],
  count: number,
): Promise<WorkItem[]> {
  const candidates = mergeUniqueById(items, mandatory);
  const substituted = await substituteCriticalRoots(mandatory, candidates);
  // Audit-metadata merge (WL-0MUWDW0N6003KF6G): `wl next` does not emit the
  // audit content fingerprints (`fingerprint`/`currentFingerprint`) that
  // `wl list` does. Deduplication below keeps the FIRST occurrence, so without
  // this enrichment the default worklist would silently drop the fingerprint
  // metadata for any item also present in a mandatory `wl list` subset — the
  // in_review 6-bucket sort then degrades to the timestamp gate only, which
  // can rank a fingerprint-fresh (but time-stale) item into the wrong bucket
  // and reorder it ahead of a higher-priority item. Prefer the richer
  // `wl list` representation for audit fields so the default worklist and the
  // stage-filtered view (`fetchItemsByStage`) classify buckets identically.
  const mandatoryById = new Map(substituted.mandatory.map((item) => [item.id, item]));
  const enrichedItems = items.map((item) => {
    const rich = mandatoryById.get(item.id);
    if (!rich) return item;
    return {
      ...item,
      auditResult: rich.auditResult,
      auditedAt: rich.auditedAt,
      fingerprint: rich.fingerprint,
      currentFingerprint: rich.currentFingerprint,
    };
  });
  const merged = mergeUniqueById(enrichedItems, substituted.mandatory);
  const selected = selectWorkItems(merged, count);
  return regroupWorkItems(ensureSubstitutedRoots(selected, substituted.roots));
}

/**
 * Assemble the default worklist from a consolidated bundle, applying the same
 * merge/enrich/substitute/select/regroup pipeline as the per-subset path (see
 * {@link mergeMandatoryAndSelect}).
 */
async function assembleDefaultWorklist(
  bundle: WorklistBundle,
  count?: number,
): Promise<WorkItem[]> {
  const items = bundle.browse;
  if (count === undefined) {
    // Count-less callers get the base feed unchanged (historical behaviour).
    return items;
  }

  const mandatory = mergeUniqueById(
    bundle.critical,
    bundle.reviewQueue,
    bundle.inProgressRoots,
    bundle.blockedRoots,
  );
  return mergeMandatoryAndSelect(items, mandatory, count);
}

/**
 * Derive the review-queue state from a bundle's `reviewQueue` subset: the
 * root-only in_review items with status `completed`, plus whether any of them
 * still lacks a current audit. Kept identical to the standalone-query
 * derivation so the banner is unchanged.
 */
function reviewQueueStateFromItems(items: WorkItem[]): ReviewQueueState {
  const completed = items.filter((item) => item.status === 'completed');
  const auditsOutstanding = completed.some((item) =>
    !isAuditFresh(item.auditedAt, item.updatedAt, item.fingerprint, item.currentFingerprint),
  );
  return { count: completed.length, auditsOutstanding };
}

/**
 * Review-queue state from a bundle read earlier in this refresh (same worklog
 * dir, within {@link WORKLIST_BUNDLE_SNAPSHOT_TTL_MS}), or `undefined` when
 * there is none — the caller then runs the standalone query.
 */
function snapshotReviewQueueState(): ReviewQueueState | undefined {
  const snapshot = lastWorklistBundle;
  if (snapshot === null) return undefined;
  if (snapshot.dirKey !== worklogDirKey()) return undefined;
  if (Date.now() - snapshot.at > WORKLIST_BUNDLE_SNAPSHOT_TTL_MS) return undefined;
  return reviewQueueStateFromItems(snapshot.bundle.reviewQueue);
}

/**
 * The exact `wl list` invocation backing the root-only in_review review
 * queue. Shared so {@link fetchMandatorySubsets} and
 * {@link fetchReviewQueueState} build an IDENTICAL argument vector — the
 * in-flight fetch memo then deduplicates the two concurrent calls into a
 * single `wl` spawn per refresh (WL-0MV5CBQ6L005SPAG). Changing one query
 * without the other silently reintroduces the duplicate spawn.
 *
 * The status filter spans BOTH `completed` (awaiting producer review) and
 * `in-progress` (being re-worked after review feedback, WL-0MV6JGVPH009YDXB)
 * — the mandatory review set must show both, matching the smart-selection
 * predicate in selectWorkItems.
 */
function reviewQueueArgs(): string[] {
  return ['list', '--status', 'completed,in-progress', '--stage', 'in_review', '--root-only'];
}

/**
 * Fetch the mandatory subsets that must ALWAYS be shown in the default
 * worklist: all critical items, all in_review items (the producer-review
 * queue — status completed awaiting review or in-progress being re-worked
 * after review feedback, WL-0MV6JGVPH009YDXB), all actively-worked
 * in-progress root items (WL-0MV6KV22S004NYIU) and all status=blocked root
 * items (WL-0MV71WBHB007D8ZE).
 *
 * These are fetched explicitly via `wl list` because `wl next -n N` hard-caps
 * at 32 items — even `-n 500` returns only 32, so a large superset cannot
 * capture all critical/in_review/in-progress/blocked items. Runs the four
 * queries in parallel to mitigate refresh latency.
 */
async function fetchMandatorySubsets(): Promise<WorkItem[]> {
  // Critical items: fetch ALL critical items across all statuses (open,
  // in-progress, blocked, completed) at EVERY parent level (no --root-only).
  // This ensures child critical items that block releases (e.g. untriaged
  // test-failures) are discovered by the refresh: the display layer never
  // renders a child at the top level (the rootOnly gate in selectWorkItems,
  // WL-0MS964SIA0057ABR / WL-0MVSSAKAU001RC2Z) and instead substitutes the
  // child's ROOT ancestor into the mandatory set (substituteCriticalRoots,
  // WL-0MVN4WESM007T4XI) so the release-blocking work stays reachable.
  // Making this query root-only would hide that discovery feed.
  //
  // We query all statuses because `wl list --priority critical` only returns
  // `open` and `completed` items by default, missing `in-progress` critical
  // items that the ship critical-items gate detects.
  //
  // Review items: root-only is appropriate because the in_review queue
  // is about producer review of parent items; child items are handled by
  // the parent's review lifecycle. The query spans status completed AND
  // in-progress (re-worked items stay in_review, WL-0MV6JGVPH009YDXB) so
  // re-worked reviews are never dropped from the mandatory set.
  //
  // Actively-worked items: root-only, status in-progress at ANY stage. These
  // can otherwise fall outside the `wl next` top-N window (the base feed is
  // capped at 32, and a low-priority in-progress item is outranked by
  // in-review (+600) and audit-not-ready (+3500) boosts), hiding the
  // producer's real-time "what am I working on" signal
  // (WL-0MV6KV22S004NYIU). The query is NOT merged into reviewQueueArgs()
  // because it is a distinct concern with a different stage scope — adding it
  // there would break the review-queue single-spawn dedup invariant.
  //
  // Blocked items: root-only, status=blocked at ANY stage (root-only keeps
  // them at the same top-level visibility as the other mandatory subsets).
  // `wl next` penalises blocked items by -10000, so a release-blocking
  // blocked in_review item ranks far below the browseItemCount window and is
  // never returned by the base feed — the explicit subset fetch guarantees it
  // is still shown (WL-0MV71WBHB007D8ZE). The query is NOT merged into
  // reviewQueueArgs() (the review queue is stage-scoped; blocked spans stages).
  const [criticalOutput, reviewOutput, activeOutput, blockedOutput] = await Promise.all([
    runWl(['list', '--priority', 'critical', '--status', 'open,in-progress,blocked,completed']),
    runWl(reviewQueueArgs()),
    runWl(['list', '--status', 'in-progress', '--root-only']),
    runWl(['list', '--status', 'blocked', '--root-only']),
  ]);
  const criticalItems = extractItems(extractJson(criticalOutput));
  const reviewItems = extractItems(extractJson(reviewOutput));
  const activeItems = extractItems(extractJson(activeOutput));
  const blockedItems = extractItems(extractJson(blockedOutput));
  return mergeUniqueById(criticalItems, reviewItems, activeItems, blockedItems);
}

/**
 * Fetch the next available work items (via `wl next`).
 *
 * Dependency-blocked items are SHOWN in the selection list: the query passes
 * `--include-blocked` so `wl next`'s default exclusions do not hide blocked
 * backlog work (WL-0MV6TFX0600145M2). Blocked items still rank low (the
 * shared scorer applies a heavy blocked penalty), so they surface at the
 * bottom of the list rather than displacing actionable work.
 *
 * When a count is given, smart selection is applied: all critical items, all
 * in_review review-queue items, all actively-worked in-progress items and all
 * status=blocked root items are always included (regardless of count,
 * WL-0MV6KV22S004NYIU / WL-0MV71WBHB007D8ZE) and the count limits only the
 * remaining "other" items. The mandatory subsets are merged from explicit
 * `wl list` queries (see fetchMandatorySubsets), so a blocked item that ranks
 * below the `-n` window is still shown. A critical CHILD is never rendered at
 * the top level; its root ancestor is substituted into the mandatory set
 * instead (both fetch paths share {@link mergeMandatoryAndSelect},
 * WL-0MVN4WESM007T4XI).
 */
export async function fetchNextItems(count?: number): Promise<WorkItem[]> {
  // ── Consolidated read (WL-0MVI0IT4S0070G78) ───────────────────────
  // One `wl worklist` spawn returns the browse feed AND the four mandatory
  // subsets, replacing five spawns per refresh tick. Any failure (older `wl`
  // without the command, non-zero exit, malformed payload, missing subset)
  // falls through to the per-subset path below with unchanged behaviour.
  try {
    // A count-less call must mirror `wl next`'s default window (1 item).
    const bundle = await fetchWorklistBundle(count === undefined ? 1 : count);
    return await assembleDefaultWorklist(bundle, count);
  } catch (error) {
    // A hung `wl` is not "unavailable": propagating the timeout keeps the
    // refresh latency bounded instead of paying the timeout again per subset.
    if ((error as { wlTimeout?: boolean } | null)?.wlTimeout === true) {
      throw error;
    }
    // Fail-open: fall back to today's per-subset spawn path.
  }

  const args = ['next'];
  if (count !== undefined) {
    args.push('-n', String(count));
  }
  args.push('--include-in-progress');
  // Show dependency-blocked items in the Herdr selection list. `wl next`
  // excludes them by default (shared filterCandidates, unless includeBlocked);
  // without this flag blocked backlog work silently disappears from the
  // worklist (WL-0MV6TFX0600145M2). The base feed includes them within its
  // `-n` window; the status=blocked mandatory subset (see
  // fetchMandatorySubsets) additionally guarantees a low-ranked blocked item
  // is never cut (WL-0MV71WBHB007D8ZE). The implement-tier candidate lookup
  // (getNextImplementCandidate) deliberately keeps the default exclusion.
  args.push('--include-blocked');

  // Run the base `wl next` selection and the mandatory subsets CONCURRENTLY:
  // they are independent reads, and overlapping them removes one full `wl`
  // startup from the critical path of a cold refresh (WL-0MV5CBQ6L005SPAG).
  // The mandatory subsets are only needed when a count window is applied;
  // the count-less path returns the base selection unchanged.
  const needMandatory = count !== undefined;
  const mandatoryPromise: Promise<WorkItem[]> = needMandatory
    ? fetchMandatorySubsets()
    : Promise.resolve([] as WorkItem[]);
  const [output, mandatory] = await Promise.all([runWl(args), mandatoryPromise]);
  const payload = extractJson(output);
  const items = extractItems(payload);
  if (count === undefined) {
    return items;
  }

  // Smart selection: merge the mandatory subsets with the regular wl next
  // results (deduplicated by ID), then always show the mandatory set and
  // limit only the "other" items to fill the remaining count slots.
  //
  // Identical tail to the consolidated bundle path (the SAME critical-child
  // root substitution, audit-metadata merge and regroup) via
  // {@link mergeMandatoryAndSelect} (WL-0MVN4WESM007T4XI).
  return mergeMandatoryAndSelect(items, mandatory, count);
}

/**
 * Status set used per stage by the stage-filtered worklist fetch.
 *
 * Most stages show only open items (`status=open`) — the "every open item
 * in the stage" rule from WL-0MSDT8X1V003206G. The in_review stage is the
 * exception (WL-0MSKCRX730052IIW): per the project workflow, advancing an
 * item to in_review sets its status to `completed` (or leaves it
 * `in-progress` while it is being re-worked after review feedback), so
 * restricting to `status=open` would hide the entire review queue. `open`
 * is included for robustness (no in_review item carries it today).
 * `blocked` is also included (WL-0MV70XY6D008013C): the release gate
 * queries `wl list --stage in_review` with NO status filter, so a
 * status=blocked item in the in_review stage blocks the release; the
 * review filter must show it or the selection list and the release gate
 * disagree about what is in the review queue.
 *
 * plan_complete and intake_complete are also exceptions (WL-0MUIB7D30009KG00):
 * after WL-0MTOHS5B4001Y9FX removed the in_progress stage, actively-worked
 * items retain their pipeline stage (`plan_complete`/`intake_complete`) and
 * only flip `status` to `in-progress`. Excluding `in-progress` from these
 * stages would make actively-worked items invisible in their corresponding
 * stage-filtered worklists.
 */
const STAGE_STATUS: Record<string, string> = {
  in_review: 'completed,in-progress,open,blocked',
  plan_complete: 'open,in-progress',
  intake_complete: 'open,in-progress',
};

/**
 * Fetch work items filtered by stage (via `wl list`).
 *
 * Guards against invalid/unknown stages: returns an empty list without
 * issuing a CLI call when the requested stage is not in the canonical
 * `STAGES` list (WL-0MUY1CRS7001UTQJ). This prevents misleading empty
 * worklists from being populated for removed stages such as `in_progress`
 * and `completed`.
 *
 * Status per valid stage:
 * - `in_review` (WL-0MSKCRX730052IIW): `completed`, `in-progress`, `open`,
 *   `blocked` — in_review items carry `completed`/`in-progress` status per
 *   the project workflow; `blocked` is included (WL-0MV70XY6D008013C) so the
 *   review filter matches the release gate's unfiltered `wl list --stage
 *   in_review`, which treats a status=blocked in_review item as
 *   release-blocking.
 * - `plan_complete` / `intake_complete` (WL-0MUIB7D30009KG00): `open`,
 *   `in-progress` — actively-worked items retain their pipeline stage and
 *   flip `status` to `in-progress` (WL-0MTOHS5B4001Y9FX removed the
 *   in_progress stage).
 * - `idea` / `done`: `open` only — items with status `blocked`, `in-progress`,
 *   or `completed` are excluded even when their stage matches.
 *
 * Root-only (WL-0MS964SIA0057ABR): stage-filtered top-level lists hide
 * child items; children remain reachable via expand (wl list --parent).
 * Results are regrouped priority-first (WL-0MSOPHLD1000EWNN): priority
 * bucket sections, then stage, then id — same ordering as the default
 * worklist. Within a single stage view the stage tie-break is a no-op, so
 * priority buckets + id tie-break apply.
 */
export async function fetchItemsByStage(stage: string): Promise<WorkItem[]> {
  if (!STAGES.includes(stage as Stage)) {
    return [];
  }
  const status = STAGE_STATUS[stage] ?? 'open';
  const output = await runWl(['list', '--status', status, '--stage', stage, '--root-only']);
  const payload = extractJson(output);
  return regroupWorkItems(extractItems(payload));
}

/**
 * Fetch work items filtered by priority (via `wl list`).
 *
 * Mirrors the stage-filter fetch semantics (WL-0MSDT8X1V003206G): every
 * OPEN root item with that priority — `wl list --status open --priority <p>
 * --root-only` — no `browseItemCount` cap, no `wl next` selection omission;
 * children stay hidden and remain reachable via expand exactly as in the
 * unfiltered view. Results follow the standard list order and are regrouped
 * priority-first (WL-0MSOPHLD1000EWNN) so the group sections stay
 * consistent with the default worklist.
 */
export async function fetchItemsByPriority(priority: string): Promise<WorkItem[]> {
  const output = await runWl(['list', '--status', 'open', '--priority', priority, '--root-only']);
  const payload = extractJson(output);
  return regroupWorkItems(extractItems(payload));
}

/**
 * Fetch details for a single work item by ID (via `wl show`).
 */
export async function fetchItemDetails(id: string): Promise<WorkItem | null> {
  try {
    const output = await runWl(['show', id]);
    const payload = extractJson(output);
    const items = extractItems(payload);
    return items.length > 0 ? items[0] : null;
  } catch {
    return null;
  }
}

/**
 * Outbound dependency targets for MULTIPLE items in ONE in-process pass
 * (F4 — WL-0MVJV2ORY002MNFF). The hydrator used to spawn `wl dep list <id>`
 * (plus `wl show` per non-terminal edge) once per candidate per tick; this
 * reads every candidate's outbound edges from the SQLite store in one pass,
 * matching the CLI's field semantics (missing target → status `deleted`,
 * title `(missing)`) and adding the target `stage` directly (the lookup the
 * spawn path pays a `wl show` for).
 *
 * Fail-open: resolves `undefined` when no in-process read is possible (no
 * worklog dir, no SQLite file, `@worklog/shared` unavailable, or any read
 * throws) so the caller falls back to its `wl dep list` spawn path exactly
 * as today. A refresh scope shares the refresh's ONE connection; scope-less
 * callers open one fresh connection per call (bounded, batched — never one
 * per item).
 */
export async function fetchOutboundDepsForItems(
  itemIds: string[],
  scope?: InProcessRefreshScope,
): Promise<Map<string, DependencyTargetRef[]> | undefined> {
  const unique = [...new Set(itemIds)];
  if (unique.length === 0) return new Map();
  const read = (db: InProcessDb): Map<string, DependencyTargetRef[]> => {
    const byItem = new Map<string, DependencyTargetRef[]>();
    for (const id of unique) {
      const targets: DependencyTargetRef[] = [];
      for (const edge of db.listDependencyEdgesFrom(id)) {
        const target = db.get(edge.toId);
        const ref: DependencyTargetRef = {
          id: edge.toId,
          status: typeof target?.status === 'string' ? target.status : 'deleted',
          title: typeof target?.title === 'string' ? target.title : '(missing)',
        };
        if (typeof target?.stage === 'string' && target.stage.length > 0) {
          ref.stage = target.stage;
        }
        targets.push(ref);
      }
      byItem.set(id, targets);
    }
    return byItem;
  };
  return scope ? await scope.read(read) : await withInProcessDb(read);
}

/**
 * Fetch the ACTIVE dependency blockers of a work item — the outbound
 * `depends-on` edges that still block it (WL-0MV8EZRDJ001TDA8).
 *
 * `wl dep list <id> --json` edges carry only id/title/status/priority, so
 * each edge that is not already terminal by status is enriched with its
 * target's `stage` via `wl show` (mirroring the hydrator's
 * `listOutboundDeps`) before the shared {@link isActiveBlocker} predicate
 * decides whether it still blocks: `completed`/`deleted` targets and
 * targets at stage `in_review`/`done` are NOT blockers. A failed stage
 * lookup leaves the edge's stage undefined and it is classified by status
 * alone.
 *
 * Fail-open (AC): a failed/unparseable `wl dep list` (or any unexpected
 * error) yields an empty array rather than throwing — the panel then
 * simply omits its `Blocked By` rows.
 */
export async function fetchBlockersForItem(id: string): Promise<BlockerRef[]> {
  try {
    // F4 in-process fast path (WL-0MVJV2ORY002MNFF): the active-blocker read
    // runs against the SQLite store (no `wl dep list` or per-edge `wl show`
    // spawn). The targets carry the stage directly, so the per-edge stage
    // lookup the spawn path pays for is free here. Fail-open: an undefined
    // in-process read (no dir/SQLite file/shared package) falls through to
    // the spawn path below exactly as today.
    const inProcess = await fetchOutboundDepsForItems([id]);
    if (inProcess !== undefined) {
      const blockers: BlockerRef[] = [];
      for (const target of inProcess.get(id) ?? []) {
        if (!isActiveBlocker({ id: target.id, status: target.status, stage: target.stage })) {
          continue;
        }
        const edgeStatus = target.status;
        blockers.push({ id: target.id, title: target.title ?? '(missing)', ...(edgeStatus ? { status: edgeStatus } : {}) });
      }
      return blockers;
    }

    const output = await runWl(['dep', 'list', id]);
    const edges = parseDepListBlockersOutput(output);
    if (edges === null) return [];

    const blockers: BlockerRef[] = [];
    for (const edge of edges) {
      const status = (edge.status ?? '').toLowerCase().trim();
      const stage =
        status === 'completed' || status === 'deleted'
          ? undefined
          : (await fetchItemDetails(edge.id))?.stage;
      if (!isActiveBlocker({ id: edge.id, status: edge.status, stage })) continue;
      // The edge's `status` is already on the `dep list` edge — pass it
      // through (no per-blocker lookup): the panel renders it as an icon +
      // text suffix on the `Blocked By` row (WL-0MVBMLY2Z0032CYR). A
      // status-less edge yields a ref without the field.
      const edgeStatus = edge.status;
      blockers.push({ id: edge.id, title: edge.title, ...(edgeStatus ? { status: edgeStatus } : {}) });
    }
    return blockers;
  } catch {
    // Fail-open: no blocker rows on any lookup failure.
    return [];
  }
}

/**
 * Fetch the total count of actionable work items.
 *
 * Pass a refresh scope (WL-0MV6C6SLB005HX7B) to read the count via the
 * refresh's ONE shared in-process connection; omit it to open a fresh
 * per-call connection (the pre-WL-0MV6C6SLB005HX7B behaviour).
 */
export async function fetchActionableCount(
  scope?: InProcessRefreshScope,
): Promise<number | undefined> {
  // Fast path: count in-process against the SQLite store. This removes a
  // whole `wl` process spawn from every refresh and is exact: the CLI's
  // actionable count is the number of non-deleted items in those statuses.
  const inProcess = scope
    ? await scope.read((db) => db.list({ status: ['open', 'in-progress', 'blocked'] }).length)
    : await withInProcessDb((db) =>
        db.list({ status: ['open', 'in-progress', 'blocked'] }).length,
      );
  if (inProcess !== undefined) {
    return inProcess;
  }
  try {
    const output = await runWl(['list', '--status', 'open,in-progress,blocked']);
    const payload = JSON.parse(output);
    if (payload && typeof payload === 'object' && typeof (payload as any).count === 'number') {
      return (payload as any).count;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run `wl sync` to synchronize local data with the remote.
 * Returns success status and optional error message.
 */
export async function runWlSync(): Promise<{ success: boolean; error?: string }> {
  try {
    const output = await runWl(['sync']);
    const payload = extractJson(output);
    const result = payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>)
      : {};
    return { success: result?.success !== false };
  } catch (err: any) {
    return { success: false, error: err.message ?? String(err) };
  }
}

/**
 * Fetch the review-queue state (root-only in_review items with status
 * `completed`) for the sprint-complete / queue-depth banner (parent
 * WL-0MTHSHN5V008R5L0; banner copy selection AH-0MUDYTQ55002NUSJ). Returns
 * the count and whether an outstanding audit remains, or undefined on
 * failure — callers treat undefined as "unknown" and leave state unchanged
 * (fail-closed, AC1).
 *
 * Uses `wl list --status completed,in-progress --stage in_review
 * --root-only --json` — the SAME query as the mandatory review subset (see
 * {@link reviewQueueArgs}), so the in-flight memo deduplicates the two into
 * ONE spawn — and then keeps only the `completed` items in-process. This
 * preserves the banner's historical "completed/in_review" semantics while
 * the mandatory worklist subset consumes the full (completed + in-progress)
 * set (WL-0MV6JGVPH009YDXB). In-progress/in_review items are excluded here
 * because they are being re-worked after review feedback: they are not
 * dispatchable to the audit tier (which selects completed/in_review only),
 * so counting them in "focus on audits" would be misleading.
 *
 * "Outstanding audit" reuses the shared `isAuditFresh` predicate: a missing `auditedAt`
 * or a stored audit that is not current counts as outstanding; a fresh
 * audit (passed or failed) does not. `wl list --json` exposes
 * `currentFingerprint` for items that carry a stored fingerprint, so the
 * predicate uses the primary content gate rather than the 60 s time gate
 * (WL-0MUN7QWFP0010EQC); items without a stored fingerprint still fall back
 * to the time gate. A CLI error or unparseable output resolves to
 * undefined (never throws).
 *
 * Root-only is intentional (WL-0MSTLFW14000KPEC): children are not counted as
 * independent review-queue entries — a completed/in_review child is covered by
 * its parent's audit (derived at read time for display, WL-0MUBVH8QG0020H9L)
 * and is never dispatched for audit independently.
 */
export async function fetchReviewQueueState(): Promise<ReviewQueueState | undefined> {
  // Derive from the consolidated bundle when one was already read (or is in
  // flight) in this refresh (WL-0MVI0IT4S0070G78): the bundle's `reviewQueue`
  // subset is the same query this function used to issue, so the banner needs
  // no second `wl` spawn on the default view.
  const pending = pendingWorklistBundle();
  if (pending !== null) {
    const bundle = await pending.catch(() => null);
    if (bundle) return reviewQueueStateFromItems(bundle.reviewQueue);
  }
  const fromBundle = snapshotReviewQueueState();
  if (fromBundle !== undefined) return fromBundle;

  try {
    // Identical args to {@link fetchMandatorySubsets}'s review query so the
    // in-flight memo deduplicates the two into ONE spawn when a refresh
    // schedules both concurrently (WL-0MV5CBQ6L005SPAG).
    const output = await runWl(reviewQueueArgs());
    const payload = extractJson(output);
    return reviewQueueStateFromItems(extractItems(payload));
  } catch {
    // Fail-closed: a query failure means we cannot determine queue state
    // — the conservative default is to leave the banner state unchanged (AC1).
    return undefined;
  }
}

/**
 * Count completed + in_review work items (root-only) for the sprint-complete
 * check (parent WL-0MTHSHN5V008R5L0). Returns the count, or undefined on
 * failure. Thin wrapper over {@link fetchReviewQueueState}, retained for
 * existing callers.
 */
export async function fetchCompletedItemCount(): Promise<number | undefined> {
  const state = await fetchReviewQueueState();
  return state?.count;
}

/**
 * In-process read of the direct children of `parentIds`, shared by the
 * single-parent expand read ({@link fetchChildrenForItem}) and the batched
 * refresh read ({@link fetchChildrenForItems}) so BOTH apply the identical
 * ordering, fields, depth-neutral enrichment and needs-CLI-fingerprint
 * fallback rule (WL-0MVJV2ORY002MNFF).
 *
 * childCounts is computed over ALL items (deleted included), matching the
 * CLI's `getChildCounts()` enrichment. Children themselves are non-deleted
 * only, matching `wl list --parent`'s default filtering.
 */
function readChildrenInProcess(
  db: InProcessDb,
  parentIds: string[],
): { byParent: Map<string, WorkItem[]>; needsCli: boolean } {
  const wanted = new Set(parentIds);
  const allRaw = db.list({});
  const childCounts = db.getChildCounts(allRaw);
  const matched = allRaw.filter(
    (item) => item.parentId && wanted.has(String(item.parentId)) && item.status !== 'deleted',
  );
  const enriched = enrichInProcessItems(db, matched);
  // A stored fingerprint needs the CLI's currentFingerprint enrichment, so
  // the fast path must not serve the batch in that case.
  const needsCli = enriched.some((item) => Boolean(item.fingerprint));
  const byParent = new Map<string, WorkItem[]>();
  for (const item of enriched) {
    const parentId = item.parentId;
    if (!parentId || !wanted.has(parentId)) continue;
    const list = byParent.get(parentId) ?? [];
    list.push({ ...item, childCount: childCounts.get(item.id) ?? 0 });
    byParent.set(parentId, list);
  }
  return { byParent, needsCli };
}

/**
 * Fetch child work items for a given parent ID (via `wl list --parent`).
 *
 * Child items are returned with the given hierarchy `depth` for display
 * (default 1 = direct children of a top-level item). Nested expansion
 * passes the parent's depth + 1 so grandchildren render at depth 2, etc.
 * (WL-0MSQ3FH1K000MMJW) — depth is derived from the fetch path, never
 * hardcoded.
 *
 * Results are regrouped priority-first (WL-0MSOPHLD1000EWNN): priority
 * bucket sections, then stage, then id — same ordering as the default
 * worklist.
 *
 * The returned children are NOT enriched with parent-audit state here; the
 * worklist render layer does that at read time (withParentAudit) when it
 * nests a child under its parent, so derived coverage
 * (WL-0MUBVH8QG0020H9L) never leaks into the fetch/model layer.
 *
 * F4 in-process fast path (WL-0MVJV2ORY002MNFF): expanding a node no
 * longer spawns `wl list --parent <id>`. The read runs in-process against
 * the SQLite store — the same reader the batched refresh path uses, so
 * ordering/fields/fallback semantics match exactly — and falls back to the
 * `wl` spawn when no in-process read is possible or a child carries a
 * stored audit fingerprint (CLI `currentFingerprint` enrichment). Pass a
 * refresh scope to reuse the refresh's ONE connection; scope-less callers
 * (the per-expand keypress path) open one fresh connection per expand — a
 * single bounded open replacing a whole `wl` spawn, never a per-helper open
 * inside a refresh.
 */
export async function fetchChildrenForItem(
  parentId: string,
  depth = 1,
  scope?: InProcessRefreshScope,
): Promise<WorkItem[]> {
  const inProcess = scope
    ? await scope.read((db) => readChildrenInProcess(db, [parentId]))
    : await withInProcessDb((db) => readChildrenInProcess(db, [parentId]));
  if (inProcess && !inProcess.needsCli) {
    const children = (inProcess.byParent.get(parentId) ?? []).map((item) => ({ ...item, depth }));
    return regroupWorkItems(children);
  }

  const output = await runWl(['list', '--parent', parentId]);
  const payload = extractJson(output);
  const items = extractItems(payload);
  return regroupWorkItems(items.map((item) => ({ ...item, depth })));
}

/**
 * Fetch the direct children of MULTIPLE expanded parents in ONE pass
 * (WL-0MV5CBQ6L005SPAG). The default worklist can have dozens of expanded
 * parents; spawning `wl list --parent <id>` once per parent made the
 * expanded-children cost the dominant share of a cold refresh. This reads
 * the children in-process from the SQLite store (one read for all parents)
 * and groups them per parent with the SAME ordering and fields as
 * {@link fetchChildrenForItem}.
 *
 * Fail-open / correctness:
 * - When no in-process read is possible (no resolved worklog dir, no SQLite
 *   file, `@worklog/shared` unavailable) it falls back to one
 *   `wl list --parent` spawn per parent, so behaviour is unchanged there.
 * - When any matched child carries a stored audit fingerprint the CLI's
 *   `currentFingerprint` enrichment is required for exact freshness, so the
 *   whole batch falls back to spawning `wl`. Audited children are rare
 *   because audit dispatch is root-only, so this is the uncommon path.
 *
 * `depthByParent` overrides the display depth per parent (default 1); the
 * worklist passes each expanded item's hierarchy depth + 1 so nested
 * expansion still renders at the correct depth (WL-0MSQ3FH1K000MMJW).
 *
 * Pass a refresh scope (WL-0MV6C6SLB005HX7B) to read via the refresh's ONE
 * shared in-process connection; omit it to open a fresh per-call connection
 * exactly as before.
 */
export async function fetchChildrenForItems(
  parentIds: string[],
  depthByParent?: Map<string, number>,
  scope?: InProcessRefreshScope,
): Promise<Map<string, WorkItem[]>> {
  const uniqueParents = [...new Set(parentIds)];
  const result = new Map<string, WorkItem[]>();
  for (const id of uniqueParents) result.set(id, []);
  if (uniqueParents.length === 0) return result;

  // A refresh scope shares ONE in-process connection with the refresh's other
  // in-process readers (WL-0MV6C6SLB005HX7B); scope-less callers open a fresh
  // per-call connection exactly as before.
  const inProcess = scope
    ? await scope.read((db) => readChildrenInProcess(db, uniqueParents))
    : await withInProcessDb((db) => readChildrenInProcess(db, uniqueParents));

  if (inProcess && !inProcess.needsCli) {
    for (const id of uniqueParents) {
      const depth = depthByParent?.get(id) ?? 1;
      const children = (inProcess.byParent.get(id) ?? []).map((item) => ({ ...item, depth }));
      result.set(id, regroupWorkItems(children));
    }
    return result;
  }

  // Fallback: preserve the exact per-parent CLI semantics (including
  // currentFingerprint enrichment for audited children).
  const fetched = await Promise.all(
    uniqueParents.map(async (id) => {
      try {
        const children = await fetchChildrenForItem(id, depthByParent?.get(id) ?? 1);
        return [id, children] as const;
      } catch {
        // Fail-open: a failed child fetch leaves the previously rendered
        // children in place (the caller carries them over).
        return [id, [] as WorkItem[]] as const;
      }
    }),
  );
  for (const [id, children] of fetched) result.set(id, children);
  return result;
}

// ── Work-item claiming ────────────────────────────────────────────────

/**
 * Timeout for claim status updates so a hung `wl` CLI cannot delay the
 * agent pane from opening (AC2: failures must not block the pane).
 */
const CLAIM_TIMEOUT_MS = 3000;

/**
 * Claim a work item before dispatching an agent command. For every tier
 * except audit the claim sets its status to `in_progress` with the given
 * assignee, matching the claim pattern documented in AGENTS.md. For the
 * audit tier (`expected` = `completed`/`in_review`) the claim is
 * STATUS-NEUTRAL: it writes only the assignee, guarded by
 * `--if-status completed --if-stage in_review --if-assignee ""`, so an
 * audited item never enters the `in_progress`/`in_review` hybrid
 * (WL-0MV85WCJJ0087VMP). Targets the configured worklog database via
 * `--worklog-dir` when set.
 *
 * With `expected` (status/stage), the claim is a compare-and-swap (RCA
 * WL-0MSRBFFLN005W3VT design point 1): `--if-status`/`--if-stage` are
 * passed to `wl update`, so the transition only applies while the item is
 * still in the state the tier selected it in. The audit tier additionally
 * CASes on the empty assignee (`--if-assignee ""`), so assigning an item
 * makes the claim fail stale. Exactly one concurrent pane wins; a loser
 * gets `{success:false, stale:true}` and the caller aborts the dispatch. A
 * stale result is detected from the wl CLI's `"error": "stale"` JSON
 * payload on stderr.
 *
 * `worklogRoot` (optional, WL-0MTQ14W7L003II5A) targets the update at a
 * specific worklog root's database via per-call `--worklog-dir` — the
 * downtime leader's cross-root claims (coordination offers live in the
 * offering instance's root, not the leader's). Undefined → the module
 * override (or ambient cwd) decides, as before.
 *
 * Never throws — failures are returned so callers can log them without
 * blocking the agent pane from opening.
 */
export async function claimWorkItem(
  id: string,
  assignee: string,
  expected?: { status?: string; stage?: string },
  worklogRoot?: string,
  migrateStage?: string,
): Promise<ClaimResult> {
  try {
    // Status-neutral audit-tier claim (WL-0MV85WCJJ0087VMP): an audited
    // `completed`/`in_review` item must never enter the `in_progress`/
    // `in_review` hybrid the stranding autocracies were built on. The claim
    // therefore writes ONLY the assignee — no `--status`/`--stage` — guarded
    // by the tier's status/stage expectation AND the empty-assignee CAS. A
    // failed audit restores by clearing the assignee, so the item never
    // leaves the review queue. Every other tier keeps the status-flip claim.
    const isAuditTier = expected?.status === 'completed' && expected?.stage === 'in_review';
    const args = isAuditTier
      ? [
          'update',
          id,
          '--assignee',
          assignee,
          '--if-status',
          expected.status as string,
          '--if-stage',
          expected.stage as string,
          // `""` is a meaningful expected value: only an UNASSIGNED item may
          // be claimed, so a concurrent/human assignee makes the claim stale.
          '--if-assignee',
          '',
        ]
      : ['update', id, '--status', 'in_progress', '--assignee', assignee];
    if (!isAuditTier) {
      if (expected?.status) {
        args.push('--if-status', expected.status);
      }
      if (expected?.stage) {
        args.push('--if-stage', expected.stage);
      }
      // Retired-stage recovery (WL-0MTYL7DX9000MZOH): an item stuck on a stage
      // that is no longer valid (e.g. the removed `in_progress` stage) cannot
      // satisfy the tier's normalised stage CAS. In that case the caller passes
      // the tier's target stage as an atomic MIGRATION — the CAS guard still
      // matches the item's ACTUAL (retired) stage for race safety, while
      // `--stage` advances the stored value to a valid stage in the same write.
      // Without this, the claim is rejected by the status/stage validator and
      // counted as a hard wl-error strike.
      if (migrateStage !== undefined) {
        args.push('--stage', migrateStage);
      }
    }
    // Per-call --worklog-dir targeting (WL-0MTQ14W7L003II5A): the downtime
    // leader claims coordination offers in the OFFER's own worklog root,
    // which may differ from the module override (the leader pane's root).
    // Passing the root resolves the update against the item's own database;
    // absent/undefined keeps the historical module-override behavior.
    const dirOverride = worklogRoot !== undefined ? join(worklogRoot, '.worklog') : undefined;
    await runWl(args, true, CLAIM_TIMEOUT_MS, dirOverride);
    return { success: true };
  } catch (err: any) {
    const message = err.message ?? String(err);
    // Lost CAS race: the wl CLI exits non-zero with `{"success":false,
    // "error":"stale", ...}` on stderr (runWl surfaces stderr first).
    const stale =
      message.includes('"error":"stale"') ||
      message.includes('"error": "stale"') ||
      message.includes("'stale'") ||
      message.includes('Conditional update skipped');
    return { success: false, stale, error: message };
  }
}

/**
 * Roll back a pre-dispatch CAS claim that succeeded but never completed
 * dispatch (WL-0MT32F908002YFFA AC1/AC2): restore the item to its
 * pre-claim status + stage so a future idle period can re-select it. Used
 * when the dispatch marker cannot be written (`marker-write-failed`) or the
 * pane spawn fails (`spawn-failed`) — in both cases the CAS claimed the item
 * (`in_progress`) but no agent is working it, so leaving it claimed strands
 * it in a state no tier selects.
 *
 * The reverse transition is guarded by the SAME race-safe CAS shape as the
 * claim: `--if-status in_progress` (plus `--if-stage <original.stage>` when
 * known) ensures only THIS claim's state is reverted. A concurrent
 * human/agent that already moved the item makes the update stale → resolves
 * `false` (nothing to roll back) and never clobbers their change.
 *
 * `original.status` defaults to `open` (the plan/intake/implement/risk-effort
 * tiers); the audit tier passes `completed` so a failed audit dispatch
 * returns to the audit queue rather than the open backlog. When
 * `original.assignee` is a non-empty string (the audit tier,
 * WL-0MV85WCJJ0087VMP) the rollback is STATUS-NEUTRAL: it clears only the
 * claiming agent's assignee, guarded by `--if-assignee <agent>`, and never
 * rewrites status/stage. `worklogRoot` targets that root's database via
 * per-call `--worklog-dir` (the same cross-root convention as
 * `claimWorkItem`).
 *
 * Never throws — a failure resolves `false` so the caller can fall back to
 * the fail-closed abort outcome.
 */
export async function rollbackClaimWorkItem(
  id: string,
  original?: { status?: string; stage?: string; assignee?: string },
  worklogRoot?: string,
): Promise<boolean> {
  try {
    // The audit tier's claim is STATUS-NEUTRAL (WL-0MV85WCJJ0087VMP): it
    // writes only the assignee and never flips status/stage, so its rollback
    // must likewise not rewrite them — it clears only the claiming agent's
    // assignee, guarded by `--if-assignee <agent>` so a concurrent assignee
    // change makes the rollback stale (no clobber). Every OTHER tier keeps
    // the legacy status/stage restore but ALSO clears THIS claim's assignee
    // (guarded by `--if-assignee <agent>`) so a failed dispatch never leaves a
    // non-empty assignee behind. A non-empty assignee is a scheduling hold
    // (WL-0MV85WDOM007BKF8): residue would make the item permanently
    // undispatchable after a marker-write/spawn failure
    // (WL-0MV85WD400091OZ6). When the claiming agent is unknown the legacy
    // restore is applied as before (fail-safe: no stricter claim than the
    // original).
    const isAuditTier =
      original?.status === 'completed' && original?.stage === 'in_review';
    const claimedAgent = original?.assignee;
    const hasClaimedAgent = typeof claimedAgent === 'string' && claimedAgent.length > 0;
    let args: string[];
    if (isAuditTier && hasClaimedAgent) {
      // Status-neutral, assignee-guarded clear (Option A).
      args = ['update', id, '--assignee', '', '--if-assignee', claimedAgent as string];
    } else if (isAuditTier) {
      // No claimed agent known: best-effort restore of the review-queue state
      // (never the plan_complete coercion that stranded items).
      args = ['update', id, '--status', 'completed', '--stage', original?.stage ?? 'in_review'];
    } else {
      // Legacy status/stage restore + clear THIS claim's assignee (hold).
      args = ['update', id, '--status', original?.status ?? 'open', '--if-status', 'in_progress'];
      if (original?.stage) {
        args.push('--if-stage', original.stage);
        args.push('--stage', original.stage);
      }
      if (hasClaimedAgent) {
        args.push('--assignee', '');
        args.push('--if-assignee', claimedAgent as string);
      }
    }
    const dirOverride = worklogRoot !== undefined ? join(worklogRoot, '.worklog') : undefined;
    await runWl(args, true, CLAIM_TIMEOUT_MS, dirOverride);
    return true;
  } catch {
    // Fail-closed: a failed/stale rollback resolves false (the caller reports
    // the failure and leaves the item as-is — no worse than before recovery).
    return false;
  }
}

/**
 * Flag a work item as needing producer review (`needsProducerReview = true`)
 * via `wl reviewed <id> true` (WL-0MUKYEXMK0033MFK AC3). The downtime
 * dispatcher calls this once an item exhausts its per-item/per-kind attempt
 * budget so it surfaces for human triage instead of looping through idle
 * cycles. `worklogRoot` targets that root's database via per-call
 * `--worklog-dir` (the same cross-root convention as `claimWorkItem`).
 *
 * Idempotent: setting the flag true when it is already true is a no-op.
 * Never throws — a failure resolves `false` (fail-closed: the dispatcher
 * still skips the budget-exhausted item and retries the flag next cycle).
 */
export async function markNeedsProducerReviewWorkItem(
  id: string,
  worklogRoot?: string,
): Promise<boolean> {
  try {
    const dirOverride = worklogRoot !== undefined ? join(worklogRoot, '.worklog') : undefined;
    await runWl(['reviewed', id, 'true'], true, CLAIM_TIMEOUT_MS, dirOverride);
    return true;
  } catch {
    return false;
  }
}
