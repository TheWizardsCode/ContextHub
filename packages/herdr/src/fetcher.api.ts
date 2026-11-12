/**
 * packages/herdr/src/fetcher.api.ts — the public fetch API over the `wl` CLI.
 *
 * Single responsibility: every per-query read the worklist performs — the
 * default `wl next` feed (with the `wl next -n` 32-item hard-cap workaround),
 * the four mandatory subsets behind it, the stage/priority filters, single-item
 * details, outbound dependencies and blockers, the actionable count, `wl sync`,
 * the review-queue count and the child reads (single parent and batched).
 * Assembly of the default worklist itself lives in
 * `./fetcher.root-substitution.js`.
 *
 * Leaf module: it imports only concrete siblings — `./fetcher.root-substitution.js`
 * (the assembly tail), `./fetcher.args.js`, `./fetcher.cli.js`,
 * `./fetcher.json.js`, `./fetcher.inprocess.js`, `./fetcher.review-queue.js`,
 * `./fetcher.worklist-bundle.js`, `./fetcher.blockers.js`,
 * `./downtime-worker.parsers.js`, `./grouping.js`, `./worklist.constants.js` —
 * plus `import type` from `./fetcher.types.js`; it never imports the
 * `./fetcher.js` barrel (parent AC4). Each collaborator is the module that
 * actually declares the symbol: the dep-list parser is taken from
 * `./downtime-worker.parsers.js` (its declaring leaf) and the active-blocker
 * predicate from `./fetcher.blockers.js`, so no edge reaches the barrel or the
 * `downtime-worker.ts` / `hydrator.ts` hubs that import it.
 *
 * Moved verbatim out of `fetcher.ts` (parent WL-0MVGKH47T007GKN1; extraction
 * WL-0MW08VWY6001COFS). No behaviour change: the consolidated-bundle-first
 * `fetchNextItems` path with its fail-open per-subset fallback (a hung `wl`
 * still propagates its timeout), the `STAGE_STATUS` sets, every argument
 * vector, the in-process fast paths and their CLI fallbacks are unchanged.
 */

import { STAGES } from './worklist.constants.js';
import type { Stage } from './worklist.constants.js';
import { regroupWorkItems } from './grouping.js';
import { getExecFileAsync } from './fetcher.args.js';
import { extractItems, extractJson } from './fetcher.json.js';
import { CLI_BINARIES, DEFAULT_WL_TIMEOUT_MS, runWl } from './fetcher.cli.js';
import { enrichInProcessItems, withInProcessDb } from './fetcher.inprocess.js';
import { fetchWorklistBundle } from './fetcher.worklist-bundle.js';
import { fetchReviewQueueState, reviewQueueArgs } from './fetcher.review-queue.js';
import { isActiveBlocker } from './fetcher.blockers.js';
import { parseDepListBlockersOutput } from './downtime-worker.parsers.js';
import {
  assembleDefaultWorklist,
  mergeMandatoryAndSelect,
  mergeUniqueById,
} from './fetcher.root-substitution.js';
import type {
  BlockerRef,
  DependencyTargetRef,
  InProcessDb,
  InProcessRefreshScope,
  WorkItem,
} from './fetcher.types.js';

// ── Public fetch API ──────────────────────────────────────────────────

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
 * Fetch the mandatory subsets that must ALWAYS be shown in the default
 * worklist: all critical items, all in_review items (the producer-review
 * queue — status completed awaiting review or in-progress being re-worked
 * after review feedback, WL-0MV6JGVPH009YDXB), all actively-worked
 * in-progress root items (WL-0MV6KV22S004NYIU) and all status=blocked root
 * items (WL-0MV71WBHB007D8ZE).
 *
 * `dirOverride` is the `.worklog` directory of a FOREIGN root the read must
 * target (registered-root sweep, WL-0MVR8GDJ3008WY3Y); absent means the
 * module-configured root (unchanged behaviour).
 *
 * These are fetched explicitly via `wl list` because `wl next -n N` hard-caps
 * at 32 items — even `-n 500` returns only 32, so a large superset cannot
 * capture all critical/in_review/in-progress/blocked items. Runs the four
 * queries in parallel to mitigate refresh latency.
 */
async function fetchMandatorySubsets(dirOverride?: string): Promise<WorkItem[]> {
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
    runWl(['list', '--priority', 'critical', '--status', 'open,in-progress,blocked,completed'], true, undefined, dirOverride),
    runWl(reviewQueueArgs(), true, undefined, dirOverride),
    runWl(['list', '--status', 'in-progress', '--root-only'], true, undefined, dirOverride),
    runWl(['list', '--status', 'blocked', '--root-only'], true, undefined, dirOverride),
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
export async function fetchNextItems(count?: number, dirOverride?: string): Promise<WorkItem[]> {
  // A `dirOverride` (the `.worklog` directory of a foreign root) targets THAT
  // root's database for the whole read — the registered-root sweep's canonical
  // ranking seam (WL-0MVR8GDJ3008WY3Y AC3). Absent ⇒ module-configured root,
  // i.e. byte-for-byte today's behaviour.
  const itemDetails = (id: string): Promise<WorkItem | null> =>
    dirOverride === undefined ? fetchItemDetails(id) : fetchItemDetails(id, dirOverride);
  // ── Consolidated read (WL-0MVI0IT4S0070G78) ───────────────────────
  // One `wl worklist` spawn returns the browse feed AND the four mandatory
  // subsets, replacing five spawns per refresh tick. Any failure (older `wl`
  // without the command, non-zero exit, malformed payload, missing subset)
  // falls through to the per-subset path below with unchanged behaviour.
  try {
    // A count-less call must mirror `wl next`'s default window (1 item).
    const bundle = await fetchWorklistBundle(
      count === undefined ? 1 : count,
      undefined,
      dirOverride,
    );
    return await assembleDefaultWorklist(bundle, itemDetails, count, dirOverride);
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
    ? fetchMandatorySubsets(dirOverride)
    : Promise.resolve([] as WorkItem[]);
  const [output, mandatory] = await Promise.all([
    runWl(args, true, undefined, dirOverride),
    mandatoryPromise,
  ]);
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
  return mergeMandatoryAndSelect(items, mandatory, count, itemDetails, dirOverride);
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
 *
 * `dirOverride` (a `.worklog` directory) targets a FOREIGN root — used by the
 * registered-root sweep so an ancestor lookup reads the item's own database
 * (WL-0MVR8GDJ3008WY3Y).
 */
export async function fetchItemDetails(
  id: string,
  dirOverride?: string,
): Promise<WorkItem | null> {
  try {
    const output = await runWl(['show', id], true, undefined, dirOverride);
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
