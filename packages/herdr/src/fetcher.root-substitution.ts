/**
 * packages/herdr/src/fetcher.root-substitution.ts — critical-child root
 * substitution and the shared default-worklist assembly tail.
 *
 * Single responsibility: turn the browse feed plus the mandatory subsets into
 * the default worklist — dedupe by id, substitute every actionable critical
 * child by its ROOT ancestor (WL-0MVN4WESM007T4XI), prefer the richer
 * `wl list` audit fields for shared items (WL-0MUWDW0N6003KF6G), then select
 * within the browse window and regroup. Both default-view fetch paths (the
 * consolidated bundle and the per-subset fallback) end here, so the worklist
 * assembly has exactly one implementation.
 *
 * Leaf module: it imports only concrete siblings (`./smart-selection.js` for
 * the selection policy, `./grouping.js` for the section regroup,
 * `./fetcher.inprocess.js` for the fail-open SQLite ancestor read and
 * `./fetcher.json.js` for item normalisation) plus `import type` from
 * `./fetcher.types.js`; it never imports the `./fetcher.js` barrel (parent
 * AC4).
 *
 * The single-item `wl show` lookup the ancestor resolution falls back to is
 * INJECTED by the API module rather than imported: `fetchItemDetails` lives in
 * `./fetcher.api.js`, which itself imports THIS module, so importing it back
 * would close an `api → root-substitution → api` cycle the split guard rejects.
 * The seam is the same one {@link walkToRootAncestor} already takes for its
 * memoised lookup.
 *
 * Moved verbatim out of `fetcher.ts` (parent WL-0MVGKH47T007GKN1; extraction
 * WL-0MW08VWY6001COFS). No behaviour change: the `MAX_ANCESTOR_HOPS` bound of
 * 32, the substitution semantics (a critical child is represented by its root
 * ancestor, never duplicated), the audit-metadata merge, the count applying
 * only to the "other" items and the fail-open ancestor walk are unchanged.
 */

import { selectWorkItems } from './smart-selection.js';
import { regroupWorkItems } from './grouping.js';
import { readOutboundDepsInProcess, withInProcessDb } from './fetcher.inprocess.js';
import { normalizeItem } from './fetcher.json.js';
import { isActiveBlocker } from './fetcher.blockers.js';
import type { RootSubstitution, WorkItem, WorklistBundle, DependencyTargetRef } from './fetcher.types.js';

/**
 * Fail-open single-item read (`wl show`) used to resolve a critical child's
 * ancestors. Supplied by the caller (`fetchItemDetails` in
 * `./fetcher.api.js`) so this module never imports upward.
 */
export type ItemDetailsLookup = (id: string) => Promise<WorkItem | null>;

/**
 * Merge work item arrays, deduplicating by item ID (first occurrence wins).
 */
export function mergeUniqueById(...arrays: WorkItem[][]): WorkItem[] {
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

// ── Critical-child root-ancestor substitution (WL-0MVN4WESM007T4XI) ────
//
// The top level may only contain ROOT items (`selectWorkItems` drops every
// item with a `parentId`), so without a substitution step a critical child
// would silently disappear from the default worklist while the ship
// critical-items gate keeps blocking a release on it. Substitution keeps that
// work reachable without rendering the child twice: the child stays hidden at
// the top level, its ROOT ancestor is shown in its place.
//
// Reachability contract of the substituted root (WL-0MWDDAQ0L009FLEF): a
// substituted root MUST carry `childCount`, because every expand affordance in
// the worklist — the `▶` arrow, the Tab expand gate and the on-demand child
// fetch — is gated on `childCount > 0`. A stripped ancestor (no `childCount`)
// renders without an expand arrow and its critical child is unreachable both
// in the pane and in the dispatcher list head, which shares the same items.
// The ancestor reads themselves (`db.get` and the `wl show` fallback) emit no
// `childCount` — only the `wl list`/`wl next`/`wl worklist` enrichments — so
// substitution re-attaches it from the same in-process `getChildCounts` pass
// the child read uses, fail-open (a failed read leaves the arrow absent —
// today's behaviour, never a crash).

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
 * Substituted roots carry `childCount` (WL-0MWDDAQ0L009FLEF): the ancestor
 * reads emit none, and every worklist expand affordance gates on
 * `childCount > 0`, so the enrichment below re-attaches counts from the same
 * in-process `getChildCounts` pass the children read uses — fail-open (arrow
 * absent if the read fails), never a crash.
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
  itemDetails: ItemDetailsLookup,
  dirOverride?: string,
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
  //
  // While the connection is open it ALSO attaches `childCount` to every
  // resolved ancestor (WL-0MWDDAQ0L009FLEF): `db.get` returns the raw row
  // without `childCount` (only the `wl list`-style enrichments carry it), and
  // the worklist's expand affordance is gated on `childCount > 0` — a root
  // substituted without it renders without an expand arrow and its critical
  // child is unreachable. `getChildCounts` runs over ALL items (deleted
  // included) exactly like the CLI's enrichment and `readChildrenInProcess`;
  // a missing map entry means the item has no children and counts as 0.
  if (children.some((child) => !child.parentId || !knownById.has(child.parentId))) {
    // `dirOverride` targets the foreign root's database for the fast path too;
    // without it the lookup would resolve ancestors from the MODULE root and a
    // swept root's critical child could be substituted with the wrong parent.
    await withInProcessDb((db) => {
      const childCounts = db.getChildCounts(db.list({}));
      for (const child of children) {
        let currentId = child.parentId;
        while (currentId && !knownById.has(currentId) && !memo.has(currentId)) {
          const raw = db.get(currentId);
          if (!raw) break;
          const parent = normalizeItem(raw);
          if (parent.childCount === undefined) {
            parent.childCount = childCounts.get(currentId) ?? 0;
          }
          memo.set(currentId, parent);
          currentId = parent.parentId;
        }
      }
      return null;
    }, dirOverride);
  }

  const lookup = async (id: string): Promise<WorkItem | null> => {
    const known = knownById.get(id);
    if (known) return known;
    if (memo.has(id)) return memo.get(id) ?? null;
    // Fail-open fallback: the injected lookup runs `wl show` and resolves null
    // on any failure, memoised so sibling children never repeat the spawn.
    const item = await itemDetails(id);
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

  // Post-walk childCount enrichment (WL-0MWDDAQ0L009FLEF): a root resolved
  // via the `wl show` fallback (a chain whose first hop is already in the
  // candidate set skips the fast path, so hops ABOVE it resolve by `wl show`)
  // still lacks `childCount` even when the store is readable. ONE bounded
  // fail-open pass re-attaches counts from the same `getChildCounts` source;
  // an unavailable store leaves the arrow absent (the pre-fix behaviour),
  // never a crash. Only fires when a substituted root is actually missing
  // its count, so an already-enriched refresh never pays for it.
  if (roots.some((root) => root.childCount === undefined)) {
    await withInProcessDb((db) => {
      const childCounts = db.getChildCounts(db.list({}));
      for (const root of roots) {
        if (root.childCount === undefined) {
          root.childCount = childCounts.get(root.id) ?? 0;
        }
      }
      return null;
    }, dirOverride);
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

// ── Blocker pinning (WL-0MW7YJYS5009H7WC) ─────────────────────────────
//
// A visible `status=blocked` item's ACTIVE blockers (the outbound `depends-on`
// edges that still block it per the shared isActiveBlocker predicate) must be
// REPRESENTED in the default worklist — as the blocker itself when it is a
// root item, or via its ROOT ancestor when it is a child (the same
// ``show parents, not children`` parent-substitution rule the critical-child
// path applies, AC6). Root cause: the browse window is fully consumed by the
// mandatory review queue, so ``othersLimit = 0`` and every open blocker is
// cut by ``selectWorkItems`` while the blocked rows it waits on stay visible
// (they are mandatory). The pin pass reads the blockers back INTO the
// selection, pin-only (never remove/re-order an item visible today, never
// duplicate an id) and emits the blocker→blocked relationship the grouping
// child consumes (AC2/AC3/AC9).

/**
 * Blocker-pin map emitted by the selection tail for the grouping child
 * (WL-0MWDOL7I1001SXXA): blocker item id (root-substituted for a child
 * blocker) → the visible blocked item id(s) it blocks. First group wins when
 * a blocker blocks two visible blocked items that land in different groups.
 */
export type BlockerPinMap = ReadonlyMap<string, string | string[]>;

/**
 * Build the memoised item lookup the blocker-pin pass reuses from the
 * critical-child substitution machinery (knownById candidate set → in-process
 * SQLite fast path → `wl show` fallback).
 *
 * The in-process pass pre-resolves every blocker id AND its ancestor chain
 * (`parentId` walk) in ONE connection, attaching `childCount` to each resolved
 * node exactly like the critical-child path — so a child blocker's ROOT is
 * resolved without a `wl show` spawn on the default path (AC8), and the
 * substituted root renders with an expand affordance when it has children
 * (WL-0MWDDAQ0L009FLEF contract). `wl show` is only the fail-open fallback
 * when the store is unavailable.
 */
async function buildBlockerLookup(
  candidateItems: WorkItem[],
  blockerIds: string[],
  itemDetails: ItemDetailsLookup,
  dirOverride?: string,
): Promise<{
  knownById: Map<string, WorkItem>;
  lookup: (id: string) => Promise<WorkItem | null>;
}> {
  const knownById = new Map<string, WorkItem>();
  for (const item of candidateItems) {
    if (!knownById.has(item.id)) knownById.set(item.id, item);
  }
  const memo = new Map<string, WorkItem | null>();

  // In-process fast path: ONE connection resolves every blocker chain
  // (blocker → parent → … → root), mirroring substituteCriticalRoots. Skipped
  // entirely when every blocker id is already in the candidate set.
  if (blockerIds.some((id) => !knownById.has(id))) {
    await withInProcessDb((db) => {
      const childCounts = db.getChildCounts(db.list({}));
      for (const blockerId of blockerIds) {
        let currentId: string | null | undefined = blockerId;
        while (currentId && !knownById.has(currentId) && !memo.has(currentId)) {
          const raw = db.get(currentId);
          if (!raw) break;
          const item = normalizeItem(raw);
          if (item.childCount === undefined) {
            item.childCount = childCounts.get(currentId) ?? 0;
          }
          memo.set(currentId, item);
          currentId = item.parentId;
        }
      }
      return null;
    }, dirOverride);
  }

  const lookup = async (id: string): Promise<WorkItem | null> => {
    const known = knownById.get(id);
    if (known) return known;
    if (memo.has(id)) return memo.get(id) ?? null;
    const item = await itemDetails(id);
    memo.set(id, item);
    return item;
  };
  return { knownById, lookup };
}

/**
 * Pin the ACTIVE blockers of every visible blocked item into the selection.
 *
 * Reads the outbound dependency edges of ALL selected blocked ids in ONE
 * batched in-process pass (AC8: no new `wl` process spawn per visible blocked
 * item — the shared in-process dep reader, not a `wl dep list` fan-out),
 * filters through the shared {@link isActiveBlocker} predicate (AC7: the
 * pinned set can never disagree with the metadata panel's `Blocked By` rows),
 * and for each active blocker:
 *
 *  - a ROOT blocker joins the selection as itself;
 *  - a CHILD blocker never joins as a child — its ROOT ancestor (walked via
 *    the same parent substitution as the critical-child path, AC6) joins
 *    instead, and when that root is the blocked item itself (the
 *    ``LP-0MVMHNUAR006SRZT`` shape) or is otherwise already visible, the pin
 *    is a no-op (nothing is added, no duplicate, the child stays reachable
 *    via expand of the parent);
 *  - a blocker already selected (in an earlier group or via another blocked
 *    item) is never added twice (AC4).
 *
 * Pin-only: never removes or re-orders an item that is visible today. The
 * returned pin map (`blockerItemId → blockedItemId(s)`) travels with the
 * selection for the grouping override; a blocker that blocks two visible
 * blocked items carries BOTH blocked ids (the grouping child resolves
 * first-group-wins, AC2).
 *
 * Fail-open and deterministic (AC9): an unavailable in-process read, an
 * unresolvable blocker or an unresolvable root leaves the selection unchanged
 * for that edge; the pin decision is a pure function of item content +
 * dependency edges, never of `updatedAt`/arrival order.
 */
async function pinBlockersIntoSelection(
  selected: WorkItem[],
  candidateItems: WorkItem[],
  itemDetails: ItemDetailsLookup,
  dirOverride?: string,
): Promise<{ items: WorkItem[]; pins: BlockerPinMap }> {
  const blockedIds = selected
    .filter((item) => (item.status ?? '') === 'blocked')
    .map((item) => item.id);
  if (blockedIds.length === 0) {
    return { items: selected, pins: new Map() };
  }

  // AC8: ONE batched in-process outbound-dep read over all selected blocked
  // ids — no new spawn. Fail-open: an undefined read leaves the selection
  // unchanged (the metadata panel path is unaffected).
  const deps = await withInProcessDb(
    (db) => readOutboundDepsInProcess(db, blockedIds),
    dirOverride,
  );
  if (deps === undefined) {
    return { items: selected, pins: new Map() };
  }

  // Active blockers per blocked item, through the SHARED predicate (AC7).
  const activeBlockers = new Map<string, DependencyTargetRef[]>();
  for (const blockedId of blockedIds) {
    const targets = (deps.get(blockedId) ?? []).filter((target) =>
      isActiveBlocker({ id: target.id, status: target.status, stage: target.stage }),
    );
    if (targets.length > 0) activeBlockers.set(blockedId, targets);
  }
  if (activeBlockers.size === 0) {
    return { items: selected, pins: new Map() };
  }

  const selectedIds = new Set(selected.map((item) => item.id));
  const blockerIds = [
    ...new Set([...activeBlockers.values()].flat().map((t) => t.id)),
  ];
  const { lookup } = await buildBlockerLookup(
    candidateItems,
    blockerIds,
    itemDetails,
    dirOverride,
  );

  const added: WorkItem[] = [];
  const addedIds = new Set<string>();
  const pins = new Map<string, string[]>();
  for (const [blockedId, targets] of activeBlockers) {
    for (const target of targets) {
      // Resolve the blocker row: a child blocker is represented by its ROOT
      // ancestor (AC6), reusing the critical-child walk; a root blocker is
      // itself. The blocker may already be in the selection (a blocker that
      // is also a blocked root, e.g. the reproduction's ``blocked D blocks
      // blocked B`` edge) — already-visible rows are never added twice (AC4).
      const blocker = await lookup(target.id);
      if (!blocker) continue;
      let row = blocker;
      let rowId = blocker.id;
      if (blocker.parentId) {
        const root = await walkToRootAncestor(blocker.parentId, lookup);
        if (!root) continue;
        if (selectedIds.has(root.id)) continue; // AC6b: root already visible
        row = root;
        rowId = root.id;
      } else if (selectedIds.has(rowId)) {
        continue; // already visible (AC4)
      }

      // Record the pin edge ALWAYS (a blocker blocking two blocked items must
      // carry both — AC2 multi-block); the row itself is added only once.
      const existing = pins.get(rowId);
      pins.set(rowId, existing ? [...existing, blockedId] : [blockedId]);
      if (!addedIds.has(rowId)) {
        addedIds.add(rowId);
        added.push(row);
      }
    }
  }
  if (added.length === 0) {
    return { items: selected, pins: new Map() };
  }
  const pinsOut: Map<string, string | string[]> = new Map();
  for (const [id, list] of pins) {
    pinsOut.set(id, list.length === 1 ? list[0] : list);
  }
  return { items: [...selected, ...added], pins: pinsOut };
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
export async function mergeMandatoryAndSelect(
  items: WorkItem[],
  mandatory: WorkItem[],
  count: number,
  itemDetails: ItemDetailsLookup,
  dirOverride?: string,
): Promise<WorkItem[]> {
  const candidates = mergeUniqueById(items, mandatory);
  const substituted = await substituteCriticalRoots(mandatory, candidates, itemDetails, dirOverride);
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
  const ensured = ensureSubstitutedRoots(selected, substituted.roots);
  // Blocker pinning (WL-0MW7YJYS5009H7WC): every ACTIVE blocker of a visible
  // blocked item is represented in the returned list — a root blocker as
  // itself, a child blocker via its ROOT ancestor (AC6). Runs on the selected
  // set (BEFORE regrouping) so the pinned rows join the same group pipeline;
  // pin-only (never removes an item visible today), fail-open, and emits the
  // blocker→blocked map for the grouping override (the optional third
  // `regroupWorkItems` argument, consumed by WL-0MWDOL7I1001SXXA).
  const { items: pinnedItems, pins } = await pinBlockersIntoSelection(
    ensured,
    merged,
    itemDetails,
    dirOverride,
  );
  return regroupWorkItems(pinnedItems, 3, pins);
}

/**
 * Assemble the default worklist from a consolidated bundle, applying the same
 * merge/enrich/substitute/select/regroup pipeline as the per-subset path (see
 * {@link mergeMandatoryAndSelect}).
 */
export async function assembleDefaultWorklist(
  bundle: WorklistBundle,
  itemDetails: ItemDetailsLookup,
  count?: number,
  dirOverride?: string,
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
  return mergeMandatoryAndSelect(items, mandatory, count, itemDetails, dirOverride);
}
