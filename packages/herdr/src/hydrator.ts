/**
 * packages/herdr/src/hydrator.ts — Herdr hydrator (WL-0MSOJLZD9004P8PI)
 *
 * Self-heals the work queue: periodically fetches every `in-progress` work
 * item, matches each against the panes of the current workspace (every
 * dispatched item gets an agent pane whose TITLE carries its work-item ID
 * as a preserved suffix), and DEMOTES any item with no matching pane so it
 * re-enters the dispatchable pool instead of lingering in `in-progress`
 * forever.
 *
 * Demotion decision (signal-based, mirroring `dispatch` eligibility):
 *  - item is not `in-progress`            → untouched (not in scope)
 *  - a pane TITLE containing the item ID  → untouched (genuinely being worked)
 *  - stage `in_review`                    → `status=completed`, stage `in_review`
 *  - an active outbound dependency blocker→ `status=blocked` (stage made compatible)
 *  - a live claim holder (lock held)      → untouched (pane-less driven session)
 *  - otherwise                            → `status=open`, stage `intake_complete`
 *
 * The two busy signals are independent and both are checked: the pane rule is
 * PRIMARY and evaluated first (a pane match short-circuits and never probes),
 * and the claim holder is the second, mechanically verifiable signal
 * (`WL-0MVWDAZL10025P8J` / `WL-0MVWDB3IG004NRIU`). `held` is evaluated AFTER
 * `in_review` and `blocked`, so a live claim only suppresses the release to
 * `open` and never overrides the audit-tier completion or the dependency
 * `blocked` transition.
 *
 * Active detection (WL-0MV1BWETT005GSUJ): a single simple rule — if there
 * is a pane in the current workspace whose title contains the work-item ID
 * (e.g. `Downtime triggered implement … - WL-0MSOJLZD9004P8PI`) the item is
 * actively being worked on; if there is no such pane, the item is not.
 *
 * The producer rejected an earlier tab-label formulation as unreliable
 * (workspace review, 2026-10-16): "It should be simple. Look for a pane in
 * this workspace with the work item id as the title. If it exists then work
 * item is busy." Tabs are created by the dispatcher-ANCHOR as a placement
 * side effect and can be renamed/re-parented by the user or the tab may not
 * exist yet while the item is being dispatched (a false-demotion race). Pane
 * titles, by contrast, are set at spawn time by the shared `pane-title.ts`
 * builders, always preserve the item ID as a trailing suffix under truncation
 * (`truncatePaneTitlePreservingSuffix`), and survive pane re-parenting — so a
 * pane-title match is the reliable "someone is working this item" signal
 * (WL-0MV1BWETT005GSUJ rework).
 *
 * Folded-in no-activity/claim-age timeout (WL-0MTTSWE0G008M1VA, 2026-09-13):
 * the pane-absent signal is the primary "stuck" signal. A claim with no
 * matching pane is stale regardless of activity age, so it is released
 * (reset to `open`/`intake_complete`) — the 2 h dispatch stale window
 * (`DOWNTIME_AUDIT_STALE_WINDOW_MS`) is the activity bound an operator can
 * use to reason about abandoned claims. Every release is logged (who/why/age
 * is carried by the work-item audit trail from the `wl` mutation itself).
 *
 * Fail-open by design: an unavailable/unparseable `wl list` or `herdr pane
 * list` aborts the cycle WITHOUT demoting — a transient CLI error must never
 * trigger a false demotion. A production log sink
 * (`createHydratorFileLog` → `<worklog root>/.worklog/logs/hydrator.log`) is
 * wired by default (F2/AC5) so such a cycle is operator-observable rather
 * than failing silently. Matching panes are produced by the shared
 * `pane-title.ts` builders, which preserve the work-item ID suffix under
 * truncation so every spawned agent pane carries its ID in the title.
 *
 * Selection-list marker (WL-0MV1BWETT005GSUJ): the same pane set drives the
 * selection list's in-progress marker via `markItemsActiveByPane` /
 * `applyActivePaneMarkers` — an item with a matching pane title is rendered
 * `in-progress` (marker + Group N) even when its worklog status is still
 * `open`, so the marker reflects pane existence rather than only the status
 * the demotion loop maintains. The marker ALSO stamps the row's green-circle
 * icon (`agentState='working'`) for pane-matched items and clears it for
 * unmatched ones — the producer's rule that a green circle appears exactly
 * when a work-item pane is open in this workspace and never otherwise. The
 * production wiring injects this through the worklist's
 * `applyActivePaneMarkers` seam (`index.ts`).
 *
 * Live claim holder (WL-0MVWDB3IG004NRIU): a pane-less driven session still
 * holds its per-child `flock` claim, so "busy" is `pane OR live claim holder`.
 * The local, side-effect-free heldness probe lives in `./claim-lock.ts`
 * (`probeClaimHolders`); the cycle asks it ONCE per tick over the pane-less
 * candidates (batched, zero `wl`/`herdr` spawns) and suppresses the
 * release-to-`open` branch while a claim is held (or ambiguous evidence
 * forces fail-open — never a release on uncertainty). The pane signal stays
 * primary and unchanged: a pane title match short-circuits and never probes.
 *
 * Fail-open rules for the probe (deliberate asymmetry: ambiguity ⇒ no
 * demotion, proven death ⇒ release): an unreadable/unenumerable `locks/`
 * directory, a corrupt lock file, an unexpected `fs`/`flock` error, an
 * undecidable probe, a `claim-probe` step timeout or a missing per-item
 * verdict each suppress demotion with a named reason. Heldness is the kernel
 * `flock`, never file existence or `started_at` age (lock files persist after
 * release). The recorded-`pid` fallback carries the PID-REUSE GUARD: it is
 * trusted only when the lock's `started_at` is not earlier than the recorded
 * process start time, otherwise the verdict is `held`
 * (`pid-reuse-suspected`) so a recycled pid can never read as a live claim.
 *
 * Release trail (WL-0MVWDB7F2003SORI): every applied demotion also clears the
 * scheduling hold (`--assignee ""`, CAS-guarded with `--if-assignee
 * <observed holder>` so a concurrent assignee change is never clobbered) and
 * writes a `herdr-hydrator` audit comment naming the deciding signal and the
 * previous holder (`released because no pane and claim holder dead; previous
 * assignee: implement`). A comment failure is tolerated — the demotion stands
 * and the cycle continues.
 *
 * Non-goals (deliberate): no wall-clock TTL, no heartbeat, no new protocol, no
 * change to dispatch, the worklist selection marker, the drive orchestrator or
 * `implement.py`; orphaned-lock cleanup and hydrator log rotation are separate
 * work items.
 *
 * Opening/closing a work-item pane does NOT touch the worklog DB, so the
 * DB-change-gated refresh tick can never update this marker for it. The
 * worklist therefore re-applies the marker on the hydrate cadence and on
 * focus-resume (see `refreshPaneMarkers`), and `markItemsActiveByPane` restores
 * each item's pre-marker status first so a CLOSED pane clears the marker
 * without a `wl` re-fetch.
 *
 * Bounded, responsive runs (WL-0MUY1CXSV008F8TZ, WL-0MUY1CYV6008BQWX,
 * WL-0MUY1CYCB003DTKO): every step races a per-step budget so a hung
 * `wl`/`herdr` child aborts the run and is NAMED (rather than wedging until
 * the 20 s scheduler watchdog, which abandons the awaited promise but cannot
 * cancel the child); the candidate loop is capped per tick so a large queue
 * cannot make one run unbounded; and every CLI spawn is stdio-isolated
 * (`stdin: 'ignore'`, `stderr: 'pipe'`). Each step emits a
 * `<label> ... elapsed <n>ms` timing line through the injectable sink.
 *
 * The module is dependency-injected (`HydratorDeps`) so the orchestration is
 * unit-tested without spawning `wl`/`herdr`; production wiring lives in
 * `createProductionHydratorDeps()`.
 */

import type { ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  getExecFileAsync,
  buildWlArgs,
  extractJson,
  getWorklogDir,
  fetchOutboundDepsForItems,
} from './fetcher.js';
import { parseMachinePaneListOutput } from './dispatcher-anchor.js';
import { resolveHerdrBin } from './herdr-bin.js';
import { probeClaimHolders, type ClaimHolderVerdict } from './claim-lock.js';

// ── Constants ─────────────────────────────────────────────────────────

/** Hydration cadence (ms). Runs inside the worklist pane's TaskScheduler. */
export const HYDRATOR_INTERVAL_MS = 30_000;

/** Scheduler-level watchdog bound for one hydration run (ms). */
export const HYDRATOR_RUN_TIMEOUT_MS = 20_000;

/**
 * Soft budget for a single hydrate step (ms). Each step (in-progress list,
 * pane list, per-item dep list, demotion apply) races its lookup against
 * this timer so a hung `wl`/`herdr` child cannot wedge the run until the
 * 20 s scheduler watchdog (which abandons the awaited promise but cannot
 * cancel the child). Kept well below `HYDRATOR_RUN_TIMEOUT_MS` so the run
 * always names the offending step while stopping the remaining spawns
 * (WL-0MUY1CXSV008F8TZ).
 */
export const HYDRATOR_STEP_TIMEOUT_MS = 5_000;

/**
 * Hard-kill bound for a single hydrator `execFile` spawn (ms). Sits above
 * the per-step soft budget so the orchestrator's step timer fires first and
 * names the step, while the hung child is still killed shortly after rather
 * than lingering until the 20 s watchdog (WL-0MUY1CXSV008F8TZ).
 */
export const HYDRATOR_EXEC_TIMEOUT_MS = 10_000;

/**
 * Hard-kill bound for the best-effort release audit comment spawn (ms).
 *
 * The comment is a tolerated side effect of a demotion that has ALREADY been
 * persisted (WL-0MVWDB7F2003SORI): a hung/slow `wl comment add` must fail as a
 * logged error, never trip the `demotion-apply` step budget and abort the
 * cycle. The bound is therefore below `HYDRATOR_STEP_TIMEOUT_MS`, so the exec
 * child is killed and the rejection is caught inside `applyDemotion`.
 */
export const HYDRATOR_RELEASE_COMMENT_TIMEOUT_MS = 2_000;

/**
 * Default cap on candidates processed per hydrate tick. Bounds the number
 * of sequential CLI spawns so a large queue cannot make one run unbounded;
 * the remainder is deferred to the next 30 s tick (WL-0MUY1CYV6008BQWX).
 */
export const HYDRATOR_MAX_ITEMS_PER_TICK = 50;

/**
 * Work-item ID matcher: an uppercase project prefix, a dash, then the
 * base36 id (e.g. `WL-0MSOJLZD9004P8PI`, `AH-0MTVYBL2L0085G6G`,
 * `CG-0MT5Y1X5T001M4S6`).
 */
export const WORK_ITEM_ID_REGEX = /[A-Z][A-Z0-9]*-[0-9A-Z]{6,}/g;
/**
 * Status → allowed stages, mirroring the project's status/stage
 * compatibility rules (`src/config.ts`, `deriveStageStatusCompatibility`).
 * Used only to keep a demotion valid; a demotion that would violate the
 * rules is repaired (never emitted invalid).
 */
export const ALLOWED_STAGES_BY_STATUS: Record<string, readonly string[]> = {
  open: ['idea', 'intake_complete', 'plan_complete'],
  blocked: ['idea', 'intake_complete', 'plan_complete'],
  completed: ['in_review', 'done'],
  'in-progress': ['intake_complete', 'plan_complete'],
};

/** Statuses considered terminal for an outbound dependency target. */
const TERMINAL_DEP_STATUSES = new Set(['completed', 'deleted']);
/** Stages considered terminal for an outbound dependency target. */
const TERMINAL_DEP_STAGES = new Set(['in_review', 'done']);

/** File name of the hydrator diagnostic log inside `.worklog/logs/`. */
export const HYDRATOR_LOG_FILE = 'hydrator.log';
/** Author recorded on every hydrator release audit comment. */
export const HYDRATOR_COMMENT_AUTHOR = 'herdr-hydrator';
/** Rolling bound: keep at most this many lines in the hydrator log. */
export const HYDRATOR_LOG_MAX_LINES = 200;

// ── Types ─────────────────────────────────────────────────────────────

/** The subset of a work item the hydrator needs. */
export interface HydratorItem {
  id: string;
  title?: string;
  status?: string;
  stage?: string;
  /**
   * Current assignee. A non-empty value is the scheduling hold
   * (WL-0MV85WDOM007BKF8), so a release must clear it and name the previous
   * holder in the audit comment (WL-0MVWDB7F2003SORI).
   */
  assignee?: string;
}

/**
 * Extra context for a demotion write (WL-0MVWDB7F2003SORI).
 *
 * A release must clear the scheduling hold (`--assignee ""`), guard that
 * clear with a CAS on the holder it observed (`--if-assignee <prev>`) so a
 * concurrent assignee change is never clobbered, and record who held the item
 * so the release is explicable from the item alone.
 */
export interface DemotionOptions {
  /** The holder observed this cycle; empty/absent ⇒ no `--if-assignee` guard. */
  previousAssignee?: string;
  /** Human-readable deciding signal, used in the release audit comment. */
  reason?: string;
}

/** The subset of a `herdr pane list` entry the hydrator needs. */
export interface HydratorPane {
  pane_id: string;
  /** The pane's title/label (e.g. `Downtime triggered implement … - WL-…`). */
  label: string;
  /**
   * Workspace the pane belongs to when known. `herdr pane list --workspace`
   * already scopes production output, so the field is normally omitted; it
   * lets the pure helpers enforce (and tests exercise) the same scoping
   * contract on an unscoped payload.
   */
  workspace_id?: string;
  /**
   * Raw `agent_status` reported for the pane, when herdr provides it.
   * Retained in the shape for forward compatibility but no longer used
   * by the hydrator's active detection (pane-title existence alone is the
   * signal).
   */
  agent_status?: string;
}

/** An outbound dependency target (`wl dep list` → `outbound`). */
export interface HydratorDepTarget {
  id: string;
  status?: string;
  stage?: string;
}

/** A demotion decision: the status/stage to write. */
export interface DemotionDecision {
  status: string;
  stage: string;
}

/** Outcome of one hydration cycle. */
export interface HydrationResult {
  ok: boolean;
  /** Number of in-progress items considered this tick (≤ the per-tick cap). */
  considered: number;
  /** Number of items actually demoted. */
  demoted: number;
  /** Number of items left untouched (matching pane, non-candidate, or failure). */
  skipped: number;
  /** Human-readable failure reason when `ok` is false. */
  reason?: string;
}

/**
 * Injectable seams for the hydrator. Every method may throw; the
 * orchestration treats a throw as a failed/unavailable lookup (fail-open).
 */
export interface HydratorDeps {
  /** `wl list --status in-progress` → items, or null when unavailable. */
  listInProgressItems: () => Promise<HydratorItem[] | null>;
  /**
   * `herdr pane list [--workspace <id>]` → panes, or null when unavailable.
   * The current workspace id is passed so the payload does not scale with
   * panes outside it (WL-0MUY1CYV6008BQWX).
   */
  listActivePanes: (workspaceId?: string) => Promise<HydratorPane[] | null>;
  /** `wl dep list <id>` → outbound targets, or null when unavailable. */
  listOutboundDeps: (itemId: string) => Promise<HydratorDepTarget[] | null>;
  /**
   * F4 batched dep read (WL-0MVJV2ORY002MNFF): outbound targets for ALL
   * candidates in ONE in-process pass (production wiring reads the SQLite
   * store, no `wl dep list` spawn). Resolves `itemId → targets` for every
   * requested id, or `undefined` when the batched read is unavailable — the
   * caller then falls back to the per-item {@link listOutboundDeps} spawn
   * seam exactly as before. Absent (test fakes / pre-F4 shapes) → per-item
   * lookups, unchanged.
   */
  listOutboundDepsBatch?: (
    itemIds: string[],
  ) => Promise<Map<string, HydratorDepTarget[] | undefined> | undefined>;
  /**
   * Optional batched claim-holder probe (WL-0MVWDB3IG004NRIU): for the given
   * pane-less candidates, answer *is this item's `<worklog>/locks/child-<id>
   * .lock` currently held by a live claim holder?* Called exactly ONCE per
   * cycle over the pane-less candidates, bounded by the per-tick cap.
   * Production wiring delegates to `probeClaimHolders` (`claim-lock.ts`) — a
   * local, side-effect-free probe with zero `wl`/`herdr` spawns.
   *
   * Optional so existing test fakes keep compiling: an absent seam disables
   * the held signal and preserves the pre-existing behaviour byte-for-byte.
   * Fail-open: a step timeout, a thrown/unavailable probe, or a missing
   * per-item verdict suppresses that cycle's (or item's) demotion — never a
   * release on ambiguous evidence.
   */
  hasLiveClaimHolder?: (
    itemIds: string[],
  ) => Promise<Map<string, ClaimHolderVerdict>>;
  /**
   * Apply a demotion via `wl update`; true when it was persisted.
   *
   * Production wiring also clears the scheduling hold (`--assignee ""`, CAS
   * guarded by `--if-assignee <previous>`) and writes the release audit
   * comment naming the deciding signal and the previous holder
   * (WL-0MVWDB7F2003SORI). A failed comment is logged and never fails the
   * demotion — the `[hydrator] released` log line stays the primary local
   * trail.
   */
  applyDemotion: (
    itemId: string,
    status: string,
    stage: string,
    opts?: DemotionOptions,
  ) => Promise<boolean>;
  /** Optional diagnostic log sink. */
  log?: (message: string) => void;
  /** Injectable monotonic clock (ms) for deterministic per-step timing. */
  now?: () => number;
  /** Per-step budget (ms); defaults to `HYDRATOR_STEP_TIMEOUT_MS`. */
  stepTimeoutMs?: number;
  /** Max candidates per tick; defaults to `HYDRATOR_MAX_ITEMS_PER_TICK`. */
  maxItemsPerTick?: number;
}

/** Stable labels for the bounded hydrate steps (logs / diagnostics). */
export type HydratorStepLabel =
  | 'in-progress-list'
  | 'pane-list'
  | 'dep-list'
  | 'claim-probe'
  | 'demotion-apply';

// ── Pure helpers ──────────────────────────────────────────────────────

/**
 * Extract every work-item ID appearing in `text` (e.g. a shell command line
 * or tab/window title). Always returns a fresh array; no shared regex state.
 *
 * Retained for `ship-guard.ts`; also used for active-pane-title matching
 * (see `collectPaneWorkItemIds`).
 */
export function extractWorkItemIdsFromText(text: string): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  return text.match(WORK_ITEM_ID_REGEX) ?? [];
}

/**
 * Collect the set of work-item IDs whose pane title carries the ID
 * (WL-0MV1BWETT005GSUJ rework: a pane with the work item id as the title).
 *
 * Every pane spawned for an item is titled by the shared `pane-title.ts`
 * builders (`Downtime triggered implement … - WL-…`, `Manually triggered …
 * - WL-…`, `Shell: … WL-…`), and the truncation helper preserves the ID as a
 * trailing suffix (`truncatePaneTitlePreservingSuffix`), so a pane whose
 * title CONTAINS the exact item ID is that item's pane. The scan uses the
 * shared `WORK_ITEM_ID_REGEX` matcher, so only tokens shaped exactly like a
 * work-item ID count — ordinary words in the title cannot produce a false
 * match.
 *
 * When `workspaceId` is provided, only panes in that workspace are considered
 * (a pane in another workspace must not make an item look active). Panes
 * without a `workspace_id` are always included (fail-open toward "active" —
 * safer against false demotion); the production `herdr pane list --workspace`
 * payload omits the field because the CLI already scoped it.
 */
export function collectPaneWorkItemIds(
  panes: readonly HydratorPane[],
  workspaceId?: string,
): Set<string> {
  const ids = new Set<string>();
  for (const pane of panes) {
    if (
      workspaceId &&
      typeof pane.workspace_id === 'string' &&
      pane.workspace_id.length > 0 &&
      pane.workspace_id !== workspaceId
    ) {
      continue;
    }
    const label = typeof pane.label === 'string' ? pane.label : '';
    for (const id of extractWorkItemIdsFromText(label)) ids.add(id);
  }
  return ids;
}

/**
 * True when a pane in the workspace is titled with the item's ID — the title
 * contains the exact ID token (never a partial match). A simple rule: if there
 * is a pane with the work item id in its title the item is actively being
 * worked on; if there is not, it is not (WL-0MV1BWETT005GSUJ rework).
 */
export function isActivePaneMatch(
  itemId: string,
  panes: readonly HydratorPane[],
  workspaceId?: string,
): boolean {
  return collectPaneWorkItemIds(panes, workspaceId).has(itemId);
}

/**
 * AC1: extract every work-item ID (`WL-[0-9A-Z]+` …) appearing in the labels
 * of the given panes. Returns a fresh array; deduplicates across panes.
 */
export function extractWorkItemIdsFromPaneTitles(
  panes: readonly HydratorPane[],
): string[] {
  const ids = new Set<string>();
  for (const pane of panes) {
    if (typeof pane.label !== 'string') continue;
    for (const id of extractWorkItemIdsFromText(pane.label)) ids.add(id);
  }
  return [...ids];
}

/**
 * Minimal item shape for pane-based active marking. `WorkItem` structurally
 * satisfies it (id + optional status/stage/children/agentState), so the
 * worklist can pass live items without this dependency-light module
 * importing a worklog type.
 */
export interface ActivePaneItem {
  id: string;
  status?: string;
  stage?: string;
  children?: ActivePaneItem[];
  /** Agent-slot state stamped by the pane marker (`working` = pane open). */
  agentState?: string;
}

/**
 * Non-enumerable per-item record of the work-item's true worklog status
 * before the pane marker overrode it. A `Symbol` keeps the bookkeeping
 * invisible to `JSON.stringify`/deep-equal assertions over the work-item
 * shape; a fresh `wl` fetch yields objects without it, so the true status is
 * (re)captured on every refresh.
 */
const PANE_MARKER_BASE_STATUS = Symbol('paneMarkerBaseStatus');

/** `ActivePaneItem` carrying the pane-marker bookkeeping symbol. */
type PaneMarkedActivePaneItem = ActivePaneItem & {
  [PANE_MARKER_BASE_STATUS]?: string;
};

/**
 * Mark every item that has a matching workspace pane as `in-progress` so
 * the selection list's in-progress marker (and Group N placement) reflects
 * pane-title existence, not only the worklog status the demotion loop
 * maintains (WL-0MV1BWETT005GSUJ). Recurses into children.
 *
 * The same pane membership also drives the row's green-circle (agent-slot)
 * icon: an item with a matching pane gets `agentState='working'` (the green
 * circle), an item without one gets it cleared — the producer's rule that a
 * green circle appears exactly when a work-item pane is open in this
 * workspace and never otherwise. The icon is therefore independent of the
 * event-driven agent-status tracker, which could not honour that invariant
 * (a freshly-spawned/`unknown` pane is absent from `herdr agent list`, an
 * agent `done` state prunes the icon even with the pane still open, and a
 * closed pane's icon could linger until an event/TTL refresh landed).
 *
 * Idempotent: each item's pre-marker status is captured on first sight and
 * restored on every later pass, so calling this again after a pane closes
 * clears the marker (back to the true worklog status) without a `wl`
 * re-fetch — the marker refresh spawns only `herdr pane list`. Terminal
 * `in_review`/`completed` items are left untouched by the STATUS marker
 * (they already carry the review/audit marker and belong in the In Review
 * group), but the GREEN CIRCLE still reflects pane existence for them — an
 * open pane means the item is being worked, regardless of its stage.
 *
 * Pure and synchronous — the caller owns pane fetching (see
 * `applyActivePaneMarkers`).
 */
export function markItemsActiveByPane(
  items: readonly ActivePaneItem[],
  activeIds: ReadonlySet<string>,
): void {
  for (const item of items) {
    const marked = item as PaneMarkedActivePaneItem;
    if (PANE_MARKER_BASE_STATUS in marked) {
      // Restore the true worklog status before re-evaluating, so a pane that
      // has since closed clears its marker and a still-open pane keeps it.
      item.status = marked[PANE_MARKER_BASE_STATUS];
    } else {
      Object.defineProperty(marked, PANE_MARKER_BASE_STATUS, {
        value: item.status,
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
    if (activeIds.has(item.id)) {
      const status = (item.status ?? '').toLowerCase();
      const stage = (item.stage ?? '').toLowerCase();
      if (status !== 'completed' && stage !== 'in_review') {
        item.status = 'in-progress';
      }
      // Green circle: a pane in this workspace whose title carries the item
      // ID exists ⇒ the item is being worked, regardless of agent state.
      item.agentState = 'working';
    } else {
      // No matching pane ⇒ no green circle (clear any stale stamp).
      delete item.agentState;
    }
    const children = item.children;
    if (Array.isArray(children) && children.length > 0) {
      markItemsActiveByPane(children, activeIds);
    }
  }
}

/**
 * Fetch `herdr pane list` for `workspaceId` and mark every item with a
 * matching pane title as `in-progress` (see `markItemsActiveByPane`).
 * Fail-open: an unavailable/unparseable pane list leaves the items unchanged,
 * so a transient CLI error never clears a marker.
 */
export async function applyActivePaneMarkers(
  items: readonly ActivePaneItem[],
  listActivePanes: HydratorDeps['listActivePanes'],
  workspaceId?: string,
): Promise<void> {
  let panes: HydratorPane[] | null;
  try {
    panes = await listActivePanes(workspaceId);
  } catch {
    return;
  }
  if (panes === null) return;
  markItemsActiveByPane(items, collectPaneWorkItemIds(panes, workspaceId));
}

/**
 * True when an outbound dependency still blocks: the target is neither
 * `completed`/`deleted` nor at a terminal stage (`in_review`/`done`).
 */
export function isActiveBlocker(target: HydratorDepTarget): boolean {
  const status = (target.status ?? '').toLowerCase();
  if (TERMINAL_DEP_STATUSES.has(status)) return false;
  const stage = (target.stage ?? '').toLowerCase();
  if (TERMINAL_DEP_STAGES.has(stage)) return false;
  return true;
}

/**
 * Return `stage` when it is valid for `status`, otherwise the closest
 * allowed stage (`plan_complete`, else `idea`).
 *
 * `in_progress` is no longer part of the CLI stage vocabulary, so it is
 * never in the allowed list and is always repaired to a valid stage
 * (WL-0MUY1CSQG007TCYX).
 */
export function compatibleStage(stage: string, status: string): string {
  const allowed = ALLOWED_STAGES_BY_STATUS[status] ?? [];
  if (allowed.includes(stage)) return stage;
  if (allowed.includes('plan_complete')) return 'plan_complete';
  if (allowed.includes('idea')) return 'idea';
  return allowed[0] ?? stage;
}

/**
 * Build the body of a release audit comment (WL-0MVWDB7F2003SORI).
 *
 * Names the deciding signal and the previous holder so the release is
 * explicable from the item alone, e.g.
 * `released because no pane and claim holder dead; previous assignee: implement`.
 * An item with no holder records `previous assignee: (none)` — never an
 * ambiguous empty suffix.
 *
 * @param reason            The deciding signal (e.g. `released because no
 *                          matching pane`).
 * @param previousAssignee  The holder observed this cycle, if any.
 */
export function buildReleaseComment(
  reason: string,
  previousAssignee?: string,
): string {
  const holder =
    typeof previousAssignee === 'string' && previousAssignee.length > 0
      ? previousAssignee
      : '(none)';
  const signal = reason.length > 0 ? reason : 'released';
  return `${signal}; previous assignee: ${holder}`;
}

/**
 * Pure demotion decision. Returns `null` when the item must be left alone
 * (not `in-progress`, a matching ACTIVE pane exists — F1 — or a live claim
 * holder keeps the item busy).
 *
 * The `hasActivePane` context key is retained for source compatibility; its
 * value now comes from the pane-title check `isActivePaneMatch`.
 *
 * Branch precedence (WL-0MVWDB3IG004NRIU, AC3 of the parent): `held` is
 * evaluated AFTER the `in_review` and `blocked` branches, so a held claim
 * only suppresses the final release-to-`open` branch and never overrides the
 * audit-tier `in_review → completed` or the dependency `blocked` transition:
 * `not in-progress → null` · `hasActivePane → null` · `stage in_review →
 * completed` · `blocked → blocked` · `held → null` · `else → open/
 * intake_complete`.
 */
export function decideDemotion(
  item: HydratorItem,
  ctx: { hasActivePane: boolean; blocked: boolean; held: boolean },
): DemotionDecision | null {
  const status = (item.status ?? '').toLowerCase();
  if (status !== 'in-progress' && status !== 'in_progress') return null;
  if (ctx.hasActivePane) return null;

  const stage = item.stage ?? 'idea';
  if (stage === 'in_review') {
    return { status: 'completed', stage: 'in_review' };
  }
  if (ctx.blocked) {
    return { status: 'blocked', stage: compatibleStage(stage, 'blocked') };
  }
  if (ctx.held) return null;
  // AC3 else-branch as written: release to `open` at `intake_complete`
  // (per WL-0MTF5WO2Q008B8US AC3; the stage is valid for `open` in
  // ALLOWED_STAGES_BY_STATUS / config.defaults.yaml).
  return { status: 'open', stage: 'intake_complete' };
}

// ── Orchestration ─────────────────────────────────────────────────────

/** Marker error so a step timeout is distinguishable from a seam failure. */
class StepTimeoutError extends Error {
  constructor(label: HydratorStepLabel) {
    super(`hydrate step '${label}' exceeded its budget`);
    this.name = 'StepTimeoutError';
  }
}

/** Outcome of one bounded hydrate step. */
type StepOutcome<T> =
  | { status: 'ok'; value: T; elapsedMs: number }
  | { status: 'timeout'; elapsedMs: number }
  | { status: 'error'; error: unknown; elapsedMs: number };

/**
 * Run one hydrate step under a bounded budget and emit a timing log.
 *
 * The lookup races a `setTimeout` guard: a step that exceeds `timeoutMs`
 * resolves as `timeout` (never rejects to the caller) so the orchestrator
 * can abort the run and name the offending step. A seam that throws is
 * reported as `error` and stays fail-open at the call site. Every outcome
 * logs `<label> ... elapsed <n>ms` through the injectable sink and clock so
 * the timing evidence is deterministic in tests (WL-0MUY1CXSV008F8TZ).
 */
async function runStep<T>(
  label: HydratorStepLabel,
  timeoutMs: number,
  now: () => number,
  log: (message: string) => void,
  fn: () => Promise<T>,
): Promise<StepOutcome<T>> {
  const start = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => reject(new StepTimeoutError(label)), timeoutMs);
      fn().then(resolve, reject);
    });
    const elapsedMs = now() - start;
    log(`[hydrator] ${label} ok elapsed ${elapsedMs}ms`);
    return { status: 'ok', value, elapsedMs };
  } catch (error) {
    const elapsedMs = now() - start;
    if (error instanceof StepTimeoutError) {
      log(`[hydrator] ${label} timeout elapsed ${elapsedMs}ms`);
      return { status: 'timeout', elapsedMs };
    }
    log(`[hydrator] ${label} failed elapsed ${elapsedMs}ms`);
    return { status: 'error', error, elapsedMs };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Build a visibility-gated runner used by BOTH the 30 s scheduler task and
 * the hidden→visible resume hook (AC4). While the worklist pane is hidden
 * the runner is a no-op, so hiding it spawns zero `wl`/`herdr`
 * processes (AC5).
 *
 * The same runner is invoked immediately on focus-resume, so regaining
 * focus re-checks without waiting for the next 30 s tick.
 *
 * @param deps         Injectable seams (production or test fakes).
 * @param workspaceId  Current herdr workspace id (undefined → all panes).
 * @param isVisible    Visibility probe (normally `paneGate.visible`).
 */
export function createHydratorRunner(
  deps: HydratorDeps,
  opts: { workspaceId?: string; isVisible: () => Promise<boolean> },
): () => Promise<HydrationResult | null> {
  return async () => {
    if (!(await opts.isVisible())) return null;
    return runHydrationOnce(deps, opts.workspaceId);
  };
}

/**
 * Run one hydration cycle: fetch in-progress items + workspace panes, decide a
 * demotion per item, and apply it. Fail-open at every boundary — an
 * unavailable lookup aborts the cycle without demoting.
 *
 * @param deps        Injectable seams (production or test fakes).
 * @param workspaceId Current herdr workspace id (undefined → all panes).
 */
export async function runHydrationOnce(
  deps: HydratorDeps,
  workspaceId?: string,
): Promise<HydrationResult> {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => Date.now());
  const stepTimeoutMs = deps.stepTimeoutMs ?? HYDRATOR_STEP_TIMEOUT_MS;
  const maxItemsPerTick = deps.maxItemsPerTick ?? HYDRATOR_MAX_ITEMS_PER_TICK;

  const inProgressStep = await runStep(
    'in-progress-list',
    stepTimeoutMs,
    now,
    log,
    () => deps.listInProgressItems(),
  );
  if (inProgressStep.status === 'timeout') {
    return {
      ok: false,
      considered: 0,
      demoted: 0,
      skipped: 0,
      reason: `in-progress-list step timeout after ${stepTimeoutMs}ms`,
    };
  }
  if (inProgressStep.status === 'error' || inProgressStep.value === null) {
    return {
      ok: false,
      considered: 0,
      demoted: 0,
      skipped: 0,
      reason: 'in-progress list unavailable',
    };
  }
  const items = inProgressStep.value;
  const considered = Math.min(items.length, Math.max(0, maxItemsPerTick));

  const tabStep = await runStep(
    'pane-list',
    stepTimeoutMs,
    now,
    log,
    () => deps.listActivePanes(workspaceId),
  );
  if (tabStep.status === 'timeout') {
    return {
      ok: false,
      considered,
      demoted: 0,
      skipped: 0,
      reason: 'pane-list step timeout (no demotion on ambiguous evidence)',
    };
  }
  if (tabStep.status === 'error' || tabStep.value === null) {
    return {
      ok: false,
      considered,
      demoted: 0,
      skipped: 0,
      reason: 'pane list unavailable (no demotion on ambiguous evidence)',
    };
  }
  const panes = tabStep.value;

  // F4 (WL-0MVJV2ORY002MNFF): resolve every pane match once — the loop used
  // to recompute `collectPaneWorkItemIds` per item (O(panes) per item).
  const paneIds = collectPaneWorkItemIds(panes, workspaceId);

  // F4 batched dependency read: when the seam exists, ONE `dep-list` step
  // reads every candidate's outbound edges (production wiring: in-process,
  // one SQLite connection per tick) instead of one `wl dep list` spawn per
  // candidate. The candidate list mirrors the per-item loop's ordering and
  // per-tick cap exactly (valid ids, pane-matched items consume a cap slot),
  // so the batched lookup fetches precisely the deps the loop consumes.
  const depCandidateIds: string[] = [];
  {
    let capSlots = 0;
    for (const item of items) {
      if (capSlots >= maxItemsPerTick) break;
      if (!item || typeof item.id !== 'string' || item.id.length === 0) continue;
      capSlots += 1;
      if (paneIds.has(item.id)) continue;
      depCandidateIds.push(item.id);
    }
  }
  // `null` → the batched read was unavailable and the loop falls back to the
  // per-item spawn seam; a Map → per-item decisions come from the batch.
  let depByItem: Map<string, HydratorDepTarget[] | undefined> | null = null;
  if (deps.listOutboundDepsBatch && depCandidateIds.length > 0) {
    const batchStep = await runStep('dep-list', stepTimeoutMs, now, log, () =>
      deps.listOutboundDepsBatch!(depCandidateIds),
    );
    if (batchStep.status === 'timeout') {
      // Abort like the per-item dep-list timeout: a hung dependency check is
      // ambiguous evidence, so no candidate is released on an incomplete read.
      return {
        ok: false,
        considered,
        demoted: 0,
        skipped: 0,
        reason: 'dep-list step timeout (batched dependency read)',
      };
    }
    if (batchStep.status === 'ok' && batchStep.value !== undefined) {
      depByItem = batchStep.value;
    }
    // status === 'error' / undefined value → fall through to the per-item
    // spawn seam (fail-open, exactly as before the batched seam existed).
  }

  // WL-0MVWDB3IG004NRIU: ONE batched claim-holder probe per cycle, over the
  // SAME pane-less candidate list as the dep read (a pane-matched item
  // short-circuits and never probes; candidates beyond the per-tick cap are
  // deferred to the next tick). Production wiring is a local, spawn-free
  // `flock`/`/proc/locks` probe, so the cycle adds zero `wl`/`herdr` spawns.
  // Fail-open, consistent with `pane-list`/`dep-list` handling: a step
  // timeout or an unavailable/abnormal probe result suppresses demotion for
  // the WHOLE cycle with a named reason — never a release on ambiguous
  // evidence. An absent seam (existing test fakes) leaves the held signal
  // off and the pre-existing behaviour byte-for-byte unchanged.
  let claimByItem: Map<string, ClaimHolderVerdict> | null = null;
  if (deps.hasLiveClaimHolder && depCandidateIds.length > 0) {
    const claimStep = await runStep('claim-probe', stepTimeoutMs, now, log, () =>
      deps.hasLiveClaimHolder!(depCandidateIds),
    );
    if (claimStep.status === 'timeout') {
      return {
        ok: false,
        considered,
        demoted: 0,
        skipped: 0,
        reason: 'claim-probe step timeout (no demotion on ambiguous evidence)',
      };
    }
    if (claimStep.status === 'error' || !(claimStep.value instanceof Map)) {
      return {
        ok: false,
        considered,
        demoted: 0,
        skipped: 0,
        reason: 'claim-probe step unavailable (no demotion on ambiguous evidence)',
      };
    }
    claimByItem = claimStep.value;
  }

  let demoted = 0;
  let skipped = 0;
  let processed = 0;
  for (const item of items) {
    if (processed >= maxItemsPerTick) break;
    if (!item || typeof item.id !== 'string' || item.id.length === 0) continue;
    processed += 1;

    // Pane title is the active signal: a pane in the current workspace whose
    // title contains the item ID means the item is being worked on; otherwise
    // it is released (WL-0MV1BWETT005GSUJ).
    const hasActivePane = paneIds.has(item.id);
    let blocked = false;
    if (!hasActivePane) {
      if (depByItem !== null) {
        // F4 batched decision: a missing/undefined entry means the dep lookup
        // was unavailable for this item — fail-open toward release, the same
        // rule as an unavailable per-item lookup.
        const targets = depByItem.get(item.id);
        blocked = Array.isArray(targets) && targets.some(isActiveBlocker);
      } else {
        const depStep = await runStep(
          'dep-list',
          stepTimeoutMs,
          now,
          log,
          () => deps.listOutboundDeps(item.id),
        );
        if (depStep.status === 'timeout') {
          // Abort the run: a hung dependency check is ambiguous evidence, so
          // the remaining candidates (and their demotions) are deferred to the
          // next tick rather than releasing on an incomplete check.
          return {
            ok: false,
            considered: processed,
            demoted,
            skipped,
            reason: `dep-list step timeout for ${item.id}`,
          };
        }
        // A seam failure stays fail-open toward release (pre-existing
        // behaviour): an unavailable dep lookup never blocks a demotion.
        blocked =
          depStep.status === 'ok' &&
          Array.isArray(depStep.value) &&
          depStep.value.some(isActiveBlocker);
      }
    }

    // Held = a live claim holder owns this item's per-child lock (or the
    // probe was ambiguous for it). Fail-open per item: a missing verdict in
    // an otherwise-usable probe map is ambiguous evidence → treat as held
    // (suppress), never released. `claimByItem === null` (no seam, or no
    // pane-less candidates) → `held` stays false, preserving pre-seam
    // behaviour.
    let held = false;
    if (claimByItem !== null) {
      const verdict = claimByItem.get(item.id);
      held = verdict === undefined || verdict.held;
    }

    const decision = decideDemotion(item, { hasActivePane: hasActivePane, blocked, held });
    if (decision === null) {
      skipped += 1;
      if (held) {
        const verdict = claimByItem?.get(item.id) as ClaimHolderVerdict | undefined;
        const pid = typeof verdict?.pid === 'number' ? ` pid ${verdict.pid}` : '';
        const sid = typeof verdict?.sessionId === 'string' ? ` session ${verdict.sessionId}` : '';
        log(`[hydrator] kept ${item.id}: live claim holder${pid}${sid}`);
      }
      continue;
    }

    // Deciding signal for this release, named identically in the audit
    // comment and the local log line. The pane is absent by definition (a
    // matching pane returns `null` above); the claim holder is the second,
    // mechanically verifiable signal (WL-0MVWDB3IG004NRIU).
    const verdict = claimByItem?.get(item.id);
    const deadClaimHolder =
      verdict !== undefined && !verdict.held && verdict.reason === 'stale';
    const releaseReason = deadClaimHolder
      ? 'released because no pane and claim holder dead'
      : 'released because no matching pane';

    const applyStep = await runStep(
      'demotion-apply',
      stepTimeoutMs,
      now,
      log,
      () =>
        deps.applyDemotion(item.id, decision.status, decision.stage, {
          previousAssignee: item.assignee,
          reason: releaseReason,
        }),
    );
    if (applyStep.status === 'timeout') {
      return {
        ok: false,
        considered: processed,
        demoted,
        skipped,
        reason: `demotion-apply step timeout for ${item.id}`,
      };
    }
    if (applyStep.status === 'ok' && applyStep.value === true) {
      demoted += 1;
      log(
        `[hydrator] released ${item.id}: in-progress/${item.stage ?? '?'} → ${decision.status}/${decision.stage} (${deadClaimHolder ? 'no pane, claim holder dead' : 'no matching pane'})`,
      );
    } else {
      skipped += 1;
      log(`[hydrator] demotion failed for ${item.id} (left unchanged)`);
    }
  }

  return { ok: true, considered: processed, demoted, skipped };
}

// ── Production wiring ─────────────────────────────────────────────────

/** Normalise one raw `wl list` entry into a `HydratorItem`. */
function normaliseItem(raw: unknown): HydratorItem | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id : null;
  if (!id) return null;
  return {
    id,
    title: typeof o.title === 'string' ? o.title : undefined,
    status: typeof o.status === 'string' ? o.status : undefined,
    stage: typeof o.stage === 'string' ? o.stage : undefined,
    assignee: typeof o.assignee === 'string' ? o.assignee : undefined,
  };
}

/**
 * Exec options shared by every hydrator CLI spawn (WL-0MUY1CYCB003DTKO).
 *
 * `stdin: 'ignore'` and `stderr: 'pipe'` encode the isolation contract so
 * no hydrator spawn can inherit the pane's stdio. `execFile` already pipes
 * all three streams (so the TUI's stdin is not inherited today); recording
 * the intent here keeps that guarantee explicit and makes it survive a
 * future swap to a `spawn`-based seam, where `stdin: 'ignore'` is honoured
 * directly. `stdin`/`stderr` are asserted because `@types/node`'s
 * `ExecFileOptions` does not model them (Node ignores unknown keys).
 *
 * The `timeout` is the HARD kill bound (`HYDRATOR_EXEC_TIMEOUT_MS`), above
 * the per-step soft budget enforced by `runStep`, so the orchestrator names
 * the offending step before the child is killed.
 */
function hydratorExecOptions(
  maxBuffer?: number,
): ExecFileOptionsWithStringEncoding {
  return {
    encoding: 'utf8',
    timeout: HYDRATOR_EXEC_TIMEOUT_MS,
    ...(maxBuffer !== undefined ? { maxBuffer } : {}),
    stdin: 'ignore',
    stderr: 'pipe',
  } as ExecFileOptionsWithStringEncoding;
}

/**
 * Build a fail-open diagnostic sink for the hydrator (F2/WL-0MTF5WO2Q008B8US,
 * AC5): appends one timestamped line per call to
 * `<cwd>/.worklog/logs/hydrator.log`, rolling to the most recent `maxLines`
 * entries (mirrors the bounded rolling pattern of `downtime-log.ts`). Never
 * throws — a log failure must never break the hydration loop.
 *
 * @param opts.cwd     Project root used for `<cwd>/.worklog/logs` placement
 *                     (defaults to `process.cwd()`).
 * @param opts.maxLines Rolling bound; defaults to `HYDRATOR_LOG_MAX_LINES`.
 */
export function createHydratorFileLog(
  opts: { cwd?: string; maxLines?: number } = {},
): (message: string) => void {
  const cwd = opts.cwd ?? process.cwd();
  const maxLines = opts.maxLines ?? HYDRATOR_LOG_MAX_LINES;
  return (message: string) => {
    try {
      const dir = join(cwd, '.worklog', 'logs');
      const filePath = join(dir, HYDRATOR_LOG_FILE);
      mkdirSync(dir, { recursive: true });

      let lines: string[] = [];
      try {
        const existing = readFileSync(filePath, 'utf8');
        lines = existing.split('\n').filter((ln) => ln.trim() !== '');
      } catch {
        lines = []; // first entry or unreadable file → start fresh
      }
      lines.push(`${new Date().toISOString()} ${message}`);
      if (lines.length > maxLines) {
        lines = lines.slice(lines.length - maxLines);
      }

      // Temp name carries pid + a random suffix so two concurrent writers
      // never collide on the same temp path. Same directory → same filesystem
      // → the rename is atomic.
      const tmpPath = join(
        dir,
        `.${HYDRATOR_LOG_FILE}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
      );
      try {
        writeFileSync(tmpPath, lines.join('\n') + '\n', 'utf8');
        renameSync(tmpPath, filePath);
      } catch (err) {
        // Clean up the temp file (best-effort) and leave the target untouched.
        try {
          unlinkSync(tmpPath);
        } catch {
          /* best-effort */
        }
        throw err;
      }
    } catch {
      // Fail-open: a broken log sink never breaks the hydrator.
    }
  };
}

/**
 * Production `HydratorDeps` backed by the real `wl` and `herdr` CLIs.
 * Uses the injectable exec seam from `fetcher.ts` (tests never hit this).
 *
 * Returns a real `log` sink by default (F2): diagnostics land in
 * `<worklog root>/.worklog/logs/hydrator.log` so a silently-failing
 * hydrator is operator-observable (AC5).
 */
export function createProductionHydratorDeps(
  opts: { log?: HydratorDeps['log'] } = {},
): HydratorDeps {
  const herdrBin = (): string => resolveHerdrBin();

  // Resolve the project root from the worklog-dir override when set, else
  // fall back to the process cwd (both work in the plugin pane).
  const worklogDir = getWorklogDir();
  const logRoot = worklogDir ? dirname(worklogDir) : process.cwd();
  const log = opts.log ?? createHydratorFileLog({ cwd: logRoot });

  return {
    listInProgressItems: async () => {
      const { stdout } = await getExecFileAsync()(
        'wl',
        buildWlArgs(['list', '--status', 'in-progress', '--json']),
        hydratorExecOptions(8 * 1024 * 1024),
      );
      const payload = extractJson(stdout) as { workItems?: unknown } | null;
      const raw = payload?.workItems;
      if (!Array.isArray(raw)) return null;
      return raw
        .map(normaliseItem)
        .filter((item): item is HydratorItem => item !== null);
    },

    listActivePanes: async (workspaceId?: string) => {
      // Scope the pane payload to the current workspace when known so it
      // does not scale with panes elsewhere (WL-0MUY1CYV6008BQWX).
      const args = ['pane', 'list'];
      if (typeof workspaceId === 'string' && workspaceId.length > 0) {
        args.push('--workspace', workspaceId);
      }
      const { stdout } = await getExecFileAsync()(
        herdrBin(),
        args,
        hydratorExecOptions(8 * 1024 * 1024),
      );
      // Reuse the shared dispatcher-anchor pane parser (no second parser):
      // `parseMachinePaneListOutput` keeps each record's `label` (the pane
      // title), which is the hydrator's active signal. Tolerates the
      // `{ result: { panes: [...] } }` envelope and `pane_id`/`paneId` key
      // variants. Fail-open: unparseable output → null (no demotion).
      const parsed = parseMachinePaneListOutput(stdout);
      if (parsed === null) return null;
      return parsed.map((pane) => ({
        pane_id: pane.paneId,
        label: pane.label ?? '',
        workspace_id: pane.workspaceId,
      }));
    },

    listOutboundDeps: async (itemId: string) => {
      const { stdout } = await getExecFileAsync()(
        'wl',
        buildWlArgs(['dep', 'list', itemId, '--json']),
        hydratorExecOptions(4 * 1024 * 1024),
      );
      const payload = extractJson(stdout) as { outbound?: unknown } | null;
      const outbound = payload?.outbound;
      if (!Array.isArray(outbound)) return null;
      const targets = outbound as HydratorDepTarget[];
      // AC3: `wl dep list` carries only `status` — fetch the stage via
      // `wl show` for each edge not already completed/deleted so the
      // blocked-vs-open decision matches `isDependencyActive` (a target at
      // stage `in_review`/`done` is NOT an active blocker). Fail-open: an
      // unparseable/unfetchable `wl show` leaves the edge's stage undefined
      // (treated as an active blocker — the conservative, pre-existing
      // classification).
      const enriched: HydratorDepTarget[] = [];
      for (const target of targets) {
        const status = (target.status ?? '').toLowerCase().trim();
        if (status === 'completed' || status === 'deleted') {
          enriched.push(target);
          continue;
        }
        try {
          const { stdout: showOut } = await getExecFileAsync()(
            'wl',
            buildWlArgs(['show', target.id, '--json']),
            hydratorExecOptions(4 * 1024 * 1024),
          );
          const showPayload = extractJson(showOut) as {
            workItem?: { stage?: unknown };
          } | null;
          const stage = showPayload?.workItem?.stage;
          enriched.push(
            typeof stage === 'string'
              ? { ...target, stage }
              : target,
          );
        } catch {
          // Failed stage lookup — keep the edge as-is (status only).
          enriched.push(target);
        }
      }
      return enriched;
    },

    // F4 (WL-0MVJV2ORY002MNFF): the batched dep seam reads every candidate's
    // outbound deps in ONE in-process pass (one SQLite connection per tick)
    // instead of one `wl dep list` spawn per candidate — runHydrationOnce
    // prefers this seam when present. Targets carry the stage directly, so
    // the per-edge `wl show` of the spawn path is free here. Fail-open:
    // `undefined` when no in-process read is possible, in which case the
    // orchestrator falls back to the per-item {@link listOutboundDeps} spawn
    // seam exactly as today.
    listOutboundDepsBatch: async (itemIds: string[]) => {
      const read = await fetchOutboundDepsForItems(itemIds);
      if (read === undefined) return undefined;
      const result = new Map<string, HydratorDepTarget[] | undefined>();
      for (const [id, targets] of read) {
        result.set(
          id,
          targets.map((target) => ({ id: target.id, status: target.status, stage: target.stage })),
        );
      }
      return result;
    },

    // WL-0MVWDB3IG004NRIU: batched claim-holder probe — ONE call per cycle
    // over the pane-less candidates. The worklog root is resolved once per
    // cycle through `getWorklogDir()` (already imported here; the `.worklog`
    // store root is exactly what `probeClaimHolders` expects, and it falls
    // back to `$WORKLOG_DIR` / `<cwd>/.worklog` when the override is unset).
    // The probe itself is local and side-effect-free (one `locks/` dir read + a
    // `/proc/locks` snapshot or non-blocking `flock` per file) — zero new
    // `wl`/`herdr` spawns per item.
    hasLiveClaimHolder: async (itemIds: string[]) =>
      probeClaimHolders(itemIds, { worklogDir }),

    // WL-0MVWDB7F2003SORI: a release must also clear the scheduling hold and
    // record who held the item. The `--assignee ""` clear is CAS-guarded by
    // `--if-assignee <previous>` whenever a holder was observed, mirroring
    // `rollbackClaimWorkItem()` (fetcher.ts): a concurrent assignee change
    // makes the demotion stale instead of clobbering the new holder. With no
    // observed holder there is nothing to guard — `--assignee ""` alone is
    // idempotent. The audit comment is best-effort: a comment failure is
    // logged and never fails the demotion (the `[hydrator] released` log line
    // remains the primary local trail).
    applyDemotion: async (
      itemId: string,
      status: string,
      stage: string,
      opts: DemotionOptions = {},
    ) => {
      const args = [
        'update',
        itemId,
        '--status',
        status,
        '--stage',
        stage,
        '--assignee',
        '',
      ];
      const previousAssignee = opts.previousAssignee;
      if (typeof previousAssignee === 'string' && previousAssignee.length > 0) {
        args.push('--if-assignee', previousAssignee);
      }
      args.push('--json');
      const { stdout } = await getExecFileAsync()(
        'wl',
        buildWlArgs(args),
        hydratorExecOptions(),
      );
      const payload = extractJson(stdout) as { success?: boolean } | null;
      if (payload?.success !== true) return false;

      try {
        await getExecFileAsync()(
          'wl',
          buildWlArgs([
            'comment',
            'add',
            itemId,
            '--comment',
            buildReleaseComment(opts.reason ?? 'released', previousAssignee),
            '--author',
            HYDRATOR_COMMENT_AUTHOR,
            '--json',
          ]),
          {
            ...hydratorExecOptions(),
            timeout: HYDRATOR_RELEASE_COMMENT_TIMEOUT_MS,
          },
        );
      } catch (err) {
        log(
          `[hydrator] release comment failed for ${itemId} (demotion stands): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return true;
    },

    log,
  };
}
