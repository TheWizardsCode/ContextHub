/**
 * packages/herdr/src/hydrator.ts — Herdr hydrator (WL-0MSOJLZD9004P8PI)
 *
 * Self-heals the work queue: periodically fetches every `in_progress` work
 * item, matches each against a live agent pane in the current workspace
 * (the pane's title carries the work-item ID), and DEMOTES any item with no
 * matching pane so it re-enters the dispatchable pool instead of lingering
 * in `in-progress` forever.
 *
 * Demotion decision (signal-based, mirroring `dispatch` eligibility):
 *  - item is not `in-progress`            → untouched (not in scope)
 *  - a live pane title contains the ID    → untouched (genuinely being worked)
 *  - stage `in_review`                    → `status=completed`, stage `in_review`
 *  - an active outbound dependency blocker→ `status=blocked` (stage made compatible)
 *  - otherwise                            → `status=open`  (stage preserved)
 *
 * Folded-in no-activity/claim-age timeout (WL-0MTTSWE0G008M1VA, 2026-09-13):
 * the pane-absent signal is the primary "stuck" signal. A claim with no live
 * pane is stale regardless of activity age, so it is released (reset to
 * `open` at the claimed stage) — the 2 h dispatch stale window
 * (`DOWNTIME_AUDIT_STALE_WINDOW_MS`) is the activity bound an operator can
 * use to reason about abandoned claims. Every release is logged (who/why/age
 * is carried by the work-item audit trail from the `wl` mutation itself).
 *
 * Fail-open by design: an unavailable/unparseable `wl list` or `herdr pane
 * list` aborts the cycle WITHOUT demoting — a transient CLI error must never
 * trigger a false demotion. Matching pane titles are produced by the shared
 * `pane-title.ts` builders, which preserve the work-item ID suffix under
 * truncation so live panes always carry their ID.
 *
 * The module is dependency-injected (`HydratorDeps`) so the orchestration is
 * unit-tested without spawning `wl`/`herdr`; production wiring lives in
 * `createProductionHydratorDeps()`.
 */

import {
  getExecFileAsync,
  buildWlArgs,
  extractJson,
  DEFAULT_WL_TIMEOUT_MS,
} from './fetcher.js';

// ── Constants ─────────────────────────────────────────────────────────

/** Hydration cadence (ms). Runs inside the worklist pane's TaskScheduler. */
export const HYDRATOR_INTERVAL_MS = 30_000;

/** Scheduler-level watchdog bound for one hydration run (ms). */
export const HYDRATOR_RUN_TIMEOUT_MS = 20_000;

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
  open: ['idea', 'intake_complete', 'plan_complete', 'in_progress'],
  blocked: ['idea', 'intake_complete', 'plan_complete'],
  completed: ['in_review', 'done'],
  'in-progress': ['intake_complete', 'plan_complete', 'in_progress'],
};

/** Statuses considered terminal for an outbound dependency target. */
const TERMINAL_DEP_STATUSES = new Set(['completed', 'deleted']);
/** Stages considered terminal for an outbound dependency target. */
const TERMINAL_DEP_STAGES = new Set(['in_review', 'done']);

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
  pane_id?: string;
  label?: string;
  workspace_id?: string;
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
  /** Number of in-progress items considered. */
  considered: number;
  /** Number of items actually demoted. */
  demoted: number;
  /** Number of items left untouched (live pane, non-candidate, or failure). */
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
  /** `herdr pane list` → panes, or null when unavailable. */
  listActivePanes: () => Promise<HydratorPane[] | null>;
  /** `wl dep list <id>` → outbound targets, or null when unavailable. */
  listOutboundDeps: (itemId: string) => Promise<HydratorDepTarget[] | null>;
  /** Apply a demotion via `wl update`; true when it was persisted. */
  applyDemotion: (itemId: string, status: string, stage: string) => Promise<boolean>;
  /** Optional diagnostic log sink. */
  log?: (message: string) => void;
}

// ── Pure helpers ──────────────────────────────────────────────────────

/**
 * Extract every work-item ID appearing in `text` (e.g. a pane label).
 * Always returns a fresh array; no shared regex state.
 */
export function extractWorkItemIdsFromText(text: string): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  return text.match(WORK_ITEM_ID_REGEX) ?? [];
}

/**
 * Collect the set of work-item IDs carried by active pane titles.
 *
 * When `workspaceId` is provided, only panes in that workspace are
 * considered (a pane in another workspace must not make an item look
 * active). Panes without a `workspace_id` are always included (fail-open
 * toward "active" — safer against false demotion).
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

/** True when a live pane in the workspace carries the item's ID. */
export function isActivePaneMatch(
  itemId: string,
  panes: readonly HydratorPane[],
  workspaceId?: string,
): boolean {
  return collectPaneWorkItemIds(panes, workspaceId).has(itemId);
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
 * allowed stage below `in_progress` (`plan_complete`, else `idea`).
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
 * (not `in-progress`, or a live pane is attached).
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
  return { status: 'open', stage: compatibleStage(stage, 'open') };
}

// ── Orchestration ─────────────────────────────────────────────────────

/** Await `fn`, returning null on any throw (fail-open seam). */
async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/**
 * Build a visibility-gated runner used by BOTH the 30 s scheduler task and
 * the hidden→visible resume hook (AC4). While the worklist pane is hidden
 * the runner is a no-op, so hiding the tab spawns zero `wl`/`herdr`
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
 * Run one hydration cycle: fetch in-progress items + active panes, decide a
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

  const items = await safe(() => deps.listInProgressItems());
  if (items === null) {
    return {
      ok: false,
      considered: 0,
      demoted: 0,
      skipped: 0,
      reason: 'in-progress list unavailable',
    };
  }

  const panes = await safe(() => deps.listActivePanes());
  if (panes === null) {
    return {
      ok: false,
      considered: items.length,
      demoted: 0,
      skipped: 0,
      reason: 'pane list unavailable (no demotion on ambiguous evidence)',
    };
  }

  const activeIds = collectPaneWorkItemIds(panes, workspaceId);

  let demoted = 0;
  let skipped = 0;
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || item.id.length === 0) continue;

    const hasActivePane = activeIds.has(item.id);
    let blocked = false;
    if (!hasActivePane) {
      const targets = await safe(() => deps.listOutboundDeps(item.id));
      blocked = Array.isArray(targets) && targets.some(isActiveBlocker);
    }

    const decision = decideDemotion(item, { hasActivePane, blocked });
    if (decision === null) {
      skipped += 1;
      continue;
    }

    const applied = await safe(() =>
      deps.applyDemotion(item.id, decision.status, decision.stage),
    );
    if (applied === true) {
      demoted += 1;
      log(
        `[hydrator] released ${item.id}: in-progress/${item.stage ?? '?'} → ${decision.status}/${decision.stage} (no live pane)`,
      );
    } else {
      skipped += 1;
      log(`[hydrator] demotion failed for ${item.id} (left unchanged)`);
    }
  }

  return { ok: true, considered: items.length, demoted, skipped };
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
 * Production `HydratorDeps` backed by the real `wl` and `herdr` CLIs.
 * Uses the injectable exec seam from `fetcher.ts` (tests never hit this).
 */
export function createProductionHydratorDeps(): HydratorDeps {
  const herdrBin = (): string => process.env.HERDR_BIN_PATH ?? 'herdr';

  return {
    listInProgressItems: async () => {
      const { stdout } = await getExecFileAsync()(
        'wl',
        buildWlArgs(['list', '--status', 'in-progress', '--json']),
        { encoding: 'utf8', timeout: DEFAULT_WL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      );
      const payload = extractJson(stdout) as { workItems?: unknown } | null;
      const raw = payload?.workItems;
      if (!Array.isArray(raw)) return null;
      return raw
        .map(normaliseItem)
        .filter((item): item is HydratorItem => item !== null);
    },

    listActivePanes: async () => {
      const { stdout } = await getExecFileAsync()(herdrBin(), ['pane', 'list'], {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
      });
      const payload = extractJson(stdout) as
        | { result?: { panes?: unknown } }
        | null;
      const panes = payload?.result?.panes;
      return Array.isArray(panes) ? (panes as HydratorPane[]) : null;
    },

    listOutboundDeps: async (itemId: string) => {
      const { stdout } = await getExecFileAsync()(
        'wl',
        buildWlArgs(['dep', 'list', itemId, '--json']),
        { encoding: 'utf8', timeout: DEFAULT_WL_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      );
      const payload = extractJson(stdout) as { outbound?: unknown } | null;
      const outbound = payload?.outbound;
      return Array.isArray(outbound) ? (outbound as HydratorDepTarget[]) : null;
    },

    applyDemotion: async (itemId: string, status: string, stage: string) => {
      const { stdout } = await getExecFileAsync()(
        'wl',
        buildWlArgs(['update', itemId, '--status', status, '--stage', stage, '--json']),
        { encoding: 'utf8', timeout: DEFAULT_WL_TIMEOUT_MS },
      );
      const payload = extractJson(stdout) as { success?: boolean } | null;
      return payload?.success === true;
    },
  };
}
