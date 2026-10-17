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
 *  - otherwise                            → `status=open`, stage `intake_complete`
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
} from './fetcher.js';
import { parseMachinePaneListOutput } from './dispatcher-anchor.js';

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
/** Rolling bound: keep at most this many lines in the hydrator log. */
export const HYDRATOR_LOG_MAX_LINES = 200;

// ── Types ─────────────────────────────────────────────────────────────

/** The subset of a work item the hydrator needs. */
export interface HydratorItem {
  id: string;
  title?: string;
  status?: string;
  stage?: string;
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
  /** Apply a demotion via `wl update`; true when it was persisted. */
  applyDemotion: (itemId: string, status: string, stage: string) => Promise<boolean>;
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
 * Pure demotion decision. Returns `null` when the item must be left alone
 * (not `in-progress`, or a matching ACTIVE pane exists — F1).
 *
 * The `hasActivePane` context key is retained for source compatibility; its
 * value now comes from the pane-title check `isActivePaneMatch`.
 */
export function decideDemotion(
  item: HydratorItem,
  ctx: { hasActivePane: boolean; blocked: boolean },
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
    const hasActivePane = isActivePaneMatch(item.id, panes, workspaceId);
    let blocked = false;
    if (!hasActivePane) {
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

    const decision = decideDemotion(item, { hasActivePane: hasActivePane, blocked });
    if (decision === null) {
      skipped += 1;
      continue;
    }

    const applyStep = await runStep(
      'demotion-apply',
      stepTimeoutMs,
      now,
      log,
      () => deps.applyDemotion(item.id, decision.status, decision.stage),
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
        `[hydrator] released ${item.id}: in-progress/${item.stage ?? '?'} → ${decision.status}/${decision.stage} (no matching pane)`,
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
  const herdrBin = (): string => process.env.HERDR_BIN_PATH ?? 'herdr';

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

    applyDemotion: async (itemId: string, status: string, stage: string) => {
      const { stdout } = await getExecFileAsync()(
        'wl',
        buildWlArgs(['update', itemId, '--status', status, '--stage', stage, '--json']),
        hydratorExecOptions(),
      );
      const payload = extractJson(stdout) as { success?: boolean } | null;
      return payload?.success === true;
    },

    log,
  };
}
