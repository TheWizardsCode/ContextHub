/**
 * packages/herdr/src/hydrator.ts — Herdr hydrator (WL-0MSOJLZD9004P8PI)
 *
 * Self-heals the work queue: periodically fetches every `in-progress` work
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
import { getExecFileAsync, buildWlArgs, extractJson } from './fetcher.js';

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
  /** Number of in-progress items considered this tick (≤ the per-tick cap). */
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

  const paneStep = await runStep(
    'pane-list',
    stepTimeoutMs,
    now,
    log,
    () => deps.listActivePanes(workspaceId),
  );
  if (paneStep.status === 'timeout') {
    return {
      ok: false,
      considered,
      demoted: 0,
      skipped: 0,
      reason: 'pane-list step timeout (no demotion on ambiguous evidence)',
    };
  }
  if (paneStep.status === 'error' || paneStep.value === null) {
    return {
      ok: false,
      considered,
      demoted: 0,
      skipped: 0,
      reason: 'pane list unavailable (no demotion on ambiguous evidence)',
    };
  }
  const panes = paneStep.value;
  const activeIds = collectPaneWorkItemIds(panes, workspaceId);

  let demoted = 0;
  let skipped = 0;
  let processed = 0;
  for (const item of items) {
    if (processed >= maxItemsPerTick) break;
    if (!item || typeof item.id !== 'string' || item.id.length === 0) continue;
    processed += 1;

    const hasActivePane = activeIds.has(item.id);
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

    const decision = decideDemotion(item, { hasActivePane, blocked });
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
        `[hydrator] released ${item.id}: in-progress/${item.stage ?? '?'} → ${decision.status}/${decision.stage} (no live pane)`,
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
        hydratorExecOptions(4 * 1024 * 1024),
      );
      const payload = extractJson(stdout) as { outbound?: unknown } | null;
      const outbound = payload?.outbound;
      return Array.isArray(outbound) ? (outbound as HydratorDepTarget[]) : null;
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
  };
}
