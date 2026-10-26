/**
 * packages/herdr/src/downtime-worker.orchestrator-dispatch.ts — the downtime
 * worker's per-tick dispatch admission and attempt.
 *
 * Single responsibility: turn an admitted idle poll into at most ONE dispatch
 * — the running-pane/owner-lease/contention/prefill/launch-fence admission
 * gates, then the coordination-or-legacy dispatch call and the outcome
 * transitions (three-strike pause, no-candidate cooldown, audit-batch
 * bookkeeping, decision logging).
 *
 * It also declares the shared orchestrator state shapes (`OrchestratorContext`
 * and its per-tick evidence types) because the tick phases and the dispatch
 * attempt both consume them, and the split-guard cycle baseline forbids the
 * orchestrator siblings from importing the barrel.
 *
 * Extracted from `downtime-worker.ts` by WL-0MVLII2080074S5L (extract the
 * downtime-worker orchestrator modules). Moved blocks are verbatim; the
 * `createDowntimeWorker` closure vars they close over became explicit fields
 * of `OrchestratorContext` (plan option A), and the tick's local poll
 * evidence is passed as `evaluation`/`admission`. No decision, threshold,
 * ordering or log message changed.
 *
 * Parent: WL-0MVF3F9A7000HKP7 (decompose the `downtime-worker.ts` god class).
 */

import { resolveSprintViewWindow } from './browse-window.js';
import { DEFAULT_LEASE_TTL_SECONDS } from './leader-election.js';
import { appendCoordinationLogEntry, type CoordinationLogEntry } from './downtime-log.js';
import {
  DOWNTIME_DECISION_LOG_MIN_INTERVAL_MS,
  DOWNTIME_ERROR_STRIKE_LIMIT,
  DOWNTIME_WL_TIMEOUT_MS,
  capacityEvidence,
  decisionHeaderToken,
  type DecisionEntryFields,
} from './downtime-worker.constants.js';
import type { CapacityStarvationObservation } from './capacity-starvation.js';
import { dispatchFromCoordination } from './downtime-worker.coordination-leader.js';
import { computeMostImportantItem } from './downtime-worker.coordination.js';
import { hasPeerOffer, readCoordinationFile } from './coordination.js';
import { countFreeUnownedSlots, evaluatePrefillPacing } from './downtime-worker.idle.js';
import { dispatchDowntimeWork } from './downtime-worker.dispatch.js';
import type {
  IdleTracker,
  IdleWindowLaunchFence,
  LlamaSlot,
  LlamaStatus,
  LongRunningPaneObservation,
  PerSlotIdleTracker,
} from './downtime-worker.types.js';
import type { CapacityStarvationTracker } from './capacity-starvation.js';
import type { LeaderElectionManager } from './leader-election.js';
import type { DowntimeWorkerConfig } from './downtime-worker.worker-contract.js';

//
// ── Shared orchestrator state (context threading, plan option A) ───────
//
// The per-tick orchestrator used to close over ~30 mutable locals inside
// `createDowntimeWorker`. Extracting the tick phases to module scope (so a
// tick-phase change does not require holding the 1,300-line closure in view)
// lifts those locals into ONE explicit context object with the same names;
// every tick-phase helper takes it as its first argument. Internal only —
// never re-exported from the barrel (parent AC3; Q2 refinement).

/** The live-re-read settings slice every tick phase consumes. */
export type OrchestratorConfig = ReturnType<DowntimeWorkerConfig['config']>;

/**
 * The audit-batch continuation state carried across the ticks of one
 * continuous idle window (parent WL-0MVEDM8OT007WDRS AC1/AC2/AC3/AC5).
 * `null` = no batch armed (legacy single-dispatch behaviour).
 */
export interface ActiveAuditBatch {
  /** Queue depth the continuation budget was measured against. */
  depth: number;
  /** Audit-batch cap the continuations are budgeted from. */
  cap: number;
  /** Continuation budget still available BEFORE this dispatch. */
  remaining: number;
  /**
   * Batch-local exclusion set (WL-0MVFE1DD8000D8T2 AC3/AC4): every item id
   * already dispatched in THIS batch window, so a continuation can never
   * re-select an item even before its dispatched marker is written/read.
   */
  dispatchedIds: Set<string>;
}

/**
 * The explicit shared state of one downtime-worker instance. Internal module
 * export only — never re-exported from the barrel.
 */
export interface OrchestratorContext {
  readonly opts: DowntimeWorkerConfig;
  readonly tracker: IdleTracker;
  readonly perSlotTracker: PerSlotIdleTracker;
  readonly starvationTracker: CapacityStarvationTracker;
  readonly launchWindow: IdleWindowLaunchFence;
  readonly leaderManager: LeaderElectionManager | null;
  readonly instanceId: string;
  readonly checkInIntervalMs: number;
  readonly leaderCheckInMs: number;
  // ── Mutable per-tick state; each field's rationale comment travels with
  // its construction site in `buildOrchestratorContext`. ──
  dispatching: boolean;
  lastDispatchAt: number | null;
  activeAuditBatch: ActiveAuditBatch | null;
  lastPaneMonitorAt: number;
  lastPaneCloseReaperAt: number;
  cooldownUntil: number | null;
  errorStrikes: number;
  lastDecisionReason: string | null;
  lastDecisionAt: number;
  longRunningThresholdMs: number;
  blockReason: string | null;
  override: boolean | null;
  restoredFromMarker: boolean;
  lastCheckInAt: number | null;
  lastOfferEmpty: boolean;
  leaderState: boolean;
}

/** The per-tick result shape (identical to `DowntimeWorkerTickResult`). */
export interface OrchestratorTickResult {
  polled: boolean;
  dispatched: boolean;
  idle: boolean;
}

/**
 * One usable poll's evidence, computed in the tick's poll/evaluate phase and
 * consumed by the dispatch admission gates and the dispatch attempt.
 */
export interface PollEvaluation {
  status: LlamaStatus;
  perSlotSlots: LlamaSlot[];
  /** LIVE contention depth (WL-0MU1DWXO600153OI) — never cumulative. */
  contentionQueueDepth: number;
  /** Prefill-gate serialisation waiters (WL-0MVHSZRZQ00482QX AC3). */
  prefillGateWaiters: number;
  /** Truthful-capacity evidence (LP-0MVGDUVGE0024YAI), observational only. */
  capacity: ReturnType<typeof capacityEvidence>;
}

/** The gates' verdict: everything the dispatch attempt needs from admission. */
export interface DispatchAdmission {
  freeSlots: number;
  totalSlots: number;
  ownerPresent: boolean;
  runningPanes: number | null;
  contentionQueueDepth: number;
  capacity: ReturnType<typeof capacityEvidence>;
  /** min(free-slot budget, prefill headroom) (AC2). */
  effectiveFreeSlots: number;
  /** True when no free UNOWNED slot remains (AC2/AC5/AC6). */
  slotOwned: boolean;
}

// ── Cooldown / three-strike state machine + decision log ───────────────

// Three-strike pause (WL-0MSI7DQL10016QYX; shared by the CLI-error path
// and the coordination probe-failure path, WL-0MTEZ4XZJ006Y9U7): N
// consecutive failures pause the worker entirely and log the persistent
// error so it is auditable. A single transient failure does NOT pause —
// it retries on the next idle period. Fail-closed: error logging must
// never crash the worker.
// WL-0MTJPYM53003ORCV: log on EVERY strike (not just 3) with structured
// fields for debuggability.
export async function pauseAfterPersistentErrors(
  ctx: OrchestratorContext,
  message: string,
  error?: string,
  extra?: {
    workItemId?: string;
    command?: string;
    stderrExcerpt?: string;
    exitCode?: number | null;
    timeoutMs?: number;
    probeContext?: string;
  },
): Promise<void> {
  ctx.errorStrikes += 1;
  const attempt = ctx.errorStrikes;
  // Enrich stderr: the explicit stderr excerpt wins; otherwise fall back
  // to the plain error string (fetcher.ts builds it from
  // `stderr || stdout || error.message`, so it IS the stderr in most
  // wl-error cases). Truncate to 200 chars with [truncated] marker
  // (WL-0MTJPYM53003ORCV).
  const rawStderr = extra?.stderrExcerpt ?? error ?? '';
  const stderrExcerpt =
    rawStderr.length > 0
      ? rawStderr.length > 200
        ? rawStderr.slice(0, 200) + '[truncated]'
        : rawStderr
      : undefined;
  try {
    await ctx.opts.deps.recordError({
      cwd: ctx.opts.config().cwd,
      at: new Date().toISOString(),
      message,
      ...(error ? { error } : {}),
      ...(stderrExcerpt ? { stderrExcerpt } : {}),
      ...(extra?.exitCode !== undefined ? { exitCode: extra.exitCode } : {}),
      ...(extra?.timeoutMs !== undefined ? { timeoutMs: extra.timeoutMs } : {}),
      ...(extra?.workItemId ? { workItemId: extra.workItemId } : {}),
      ...(extra?.command ? { command: extra.command } : {}),
      attempt,
      ...(extra?.probeContext ? { probeContext: extra.probeContext } : {}),
    });
  } catch {
    // fail-closed: error logging must never crash the worker
  }
  if (ctx.errorStrikes >= DOWNTIME_ERROR_STRIKE_LIMIT) {
    ctx.cooldownUntil = Date.now() + ctx.opts.config().noCandidateCooldownMs;
    ctx.errorStrikes = 0;
    ctx.tracker.record(false);
    ctx.perSlotTracker.record([]);
  }
}

// ── Capacity-starvation observation (WL-0MVKNC2N50025HXE AC3) ──
// Write ONE observation entry for a capacity-refusal episode that has
// outlasted the configured window. It reuses the refusal's evidence fields
// (same schema), adds the episode length and — when the long-running scan
// is wired — names the panes holding the model. Observation only: it does
// not set the header blocking token, never gates dispatch, and a logging
// failure is swallowed (fail-closed).
export async function writeCapacityStarvationSignal(
  ctx: OrchestratorContext,
  cwd: string,
  starvation: CapacityStarvationObservation,
  fields: DecisionEntryFields,
  now: number,
): Promise<void> {
  let longRunningPanes: LongRunningPaneObservation[] | undefined;
  if (typeof ctx.opts.deps.scanLongRunningPanes === 'function') {
    try {
      const observed = await ctx.opts.deps.scanLongRunningPanes(cwd, {
        thresholdMs: ctx.longRunningThresholdMs,
        now,
      });
      if (Array.isArray(observed) && observed.length > 0) {
        longRunningPanes = observed;
      }
    } catch {
      // fail-safe: an unreadable scan must never suppress the signal
    }
  }
  const entry: CoordinationLogEntry = {
    kind: 'decision',
    operation: 'no-dispatch',
    instanceId: ctx.instanceId,
    reason: 'capacity-starved',
    ...fields,
    starvedSince: new Date(starvation.starvedSince).toISOString(),
    starvedMs: starvation.starvedMs,
    consecutiveCapacityRefusals: starvation.consecutiveRefusals,
    lastCapacityReason: starvation.lastReason,
    ...(longRunningPanes !== undefined ? { longRunningPanes } : {}),
    at: new Date(now).toISOString(),
  };
  try {
    if (typeof ctx.opts.deps.recordDecision === 'function') {
      await ctx.opts.deps.recordDecision(entry, cwd);
    } else {
      await appendCoordinationLogEntry(cwd, entry);
    }
  } catch {
    // fail-closed: observation logging must never affect dispatch
  }
};

// ── No-dispatch decision log (WL-0MU8808ZY0091JIA) ──
// Record WHY a polled tick refused to dispatch so "idle slots but no
// dispatches" is diagnosable from the logs alone. Rate-limited: a repeated
// refusal with the SAME reason is written at most once per
// DOWNTIME_DECISION_LOG_MIN_INTERVAL_MS; a reason CHANGE always writes. The
// header blocking token is updated on EVERY refusal (even a rate-limited
// one) so the header never goes stale. Fail-closed: a logging failure never
// affects the dispatch decision.
//
// Audit-batch observability (parent WL-0MVEDM8OT007WDRS AC5) rides on the
// same log and the same rate limit:
//  - refusals keep their EXISTING reason tokens; while a batch is armed they
//    additionally carry `auditBatchDepth` / `auditBatchCap` /
//    `auditBatchRemaining`;
//  - `audit-batch-continue` (an accepted continuation) and
//    `audit-batch-end` (a silent cap/depth deactivation) are OBSERVATIONS,
//    not refusals — they are written with `blocking: false` so the header
//    blocking token still reflects refusals only, exactly as today.
export async function recordDecision(
  ctx: OrchestratorContext,
  cwd: string,
  reason: string,
  fields: DecisionEntryFields,
  options: {
    /**
     * `false` for a NON-refusal observation (`audit-batch-continue` /
     * `audit-batch-end`): it is recorded in the decision log but must NOT
     * set the header blocking token, which reflects refusals only
     * (parent AC5 "header blocking token updates on every refusal exactly
     * as today"). Defaults to `true` — every refusal keeps today's
     * behaviour.
     */
    blocking?: boolean;
    /**
     * Reason fed to the capacity-starvation tracker INSTEAD of `reason`.
     * Used when a refusal is grouped under one decision/header token while
     * the starvation signal must still see the underlying vocabulary —
     * `reservation-refused` is grouped for the header (proxy reason in
     * `reservationReason`), but the tracker must judge the PROXY's reason
     * (`prefill-gate` / `queue-full` are capacity refusals, an unknown
     * open-vocabulary reason is not). Defaults to `reason`.
     */
    starvationReason?: string;
  } = {},
): Promise<void> {
  if (options.blocking !== false) ctx.blockReason = decisionHeaderToken(reason);
  const now = Date.now();
  // ── Continuous capacity-starvation signal (WL-0MVKNC2N50025HXE AC3) ──
  // The episode tracker is fed with EVERY blocking refusal BEFORE the rate
  // limiter below, so a rate-limited repeat still advances the episode. A
  // non-capacity refusal resets it (capacity was available, so the fleet is
  // not starved). Once the episode crosses the configured window ONE extra
  // `capacity-starved` OBSERVATION entry is written AFTER the refusal line,
  // carrying the episode length and the panes the long-running detector
  // flags — the diagnosis the 2026-10-22/23 incident could not make. It is
  // an observation, not a refusal: the header blocking token and the
  // underlying reason are unchanged, it is written even when the refusal
  // itself is rate-limited, and a logging failure never affects dispatch.
  const starvation =
    options.blocking !== false
      ? ctx.starvationTracker.observe(options.starvationReason ?? reason, now)
      : null;
  if (
    ctx.lastDecisionReason === reason &&
    now - ctx.lastDecisionAt < DOWNTIME_DECISION_LOG_MIN_INTERVAL_MS
  ) {
    // Rate-limited refusal: skip the refusal line, but never the signal.
    if (starvation !== null) {
      await writeCapacityStarvationSignal(ctx, cwd, starvation, fields, now);
    }
    return; // identical refusal within the window
  }
  ctx.lastDecisionReason = reason;
  ctx.lastDecisionAt = now;
  const entry: CoordinationLogEntry = {
    kind: 'decision',
    operation: 'no-dispatch',
    instanceId: ctx.instanceId,
    reason,
    ...fields,
    at: new Date(now).toISOString(),
  };
  try {
    if (typeof ctx.opts.deps.recordDecision === 'function') {
      await ctx.opts.deps.recordDecision(entry, cwd);
    } else {
      await appendCoordinationLogEntry(cwd, entry);
    }
  } catch {
    // fail-closed: decision logging must never crash the worker
  }
  // The starvation observation always follows the refusal line (it never
  // replaces it) — AC5: the reason/token stream stays intact.
  if (starvation !== null) {
    await writeCapacityStarvationSignal(ctx, cwd, starvation, fields, now);
  }
}

/**
 * Depth-aware audit-batch diagnostics (parent WL-0MVEDM8OT007WDRS AC5):
 * metadata attached to a decision while a batch is armed. `depth`/`cap` are
 * re-measured from the dispatch outcome when it read the Herdr head (a
 * blocked continuation), otherwise they are the values the active batch was
 * armed with; `remaining` is the continuation budget still available BEFORE
 * this decision (`0` once the batch has ended). Absent entirely when no
 * batch is active, so non-batch decisions keep their existing shape.
 */
export function batchMetadata(
  ctx: OrchestratorContext,
  live?: { depth: number; cap: number },
): { auditBatchDepth?: number; auditBatchCap?: number; auditBatchRemaining?: number } {
  return ctx.activeAuditBatch === null
    ? {}
    : {
        auditBatchDepth: live?.depth ?? ctx.activeAuditBatch.depth,
        auditBatchCap: live?.cap ?? ctx.activeAuditBatch.cap,
        auditBatchRemaining: ctx.activeAuditBatch.remaining,
      };
}

// ── Dispatch admission gates ───────────────────────────────────────────

/**
 * Every pre-dispatch gate on a usable idle poll: the running-pane liveness
 * telemetry, the owner-lease/slot and proxy-contention refusals, the
 * prefill-gate pacing and the one-per-idle-window launch fence. Returns the
 * tick result for a refusing gate, otherwise the admitted dispatch evidence.
 */
export async function admitDispatch(
  ctx: OrchestratorContext,
  cfg: OrchestratorConfig,
  evaluation: PollEvaluation,
): Promise<OrchestratorTickResult | DispatchAdmission> {
  // ── Dispatch (parent WL-0MST3OJ8S0001ROL AC4, F5 WL-0MTII48OV008P2QU AC4) ──
  // Single machine-wide slot budget: ONE leader poll → ONE freeSlots
  // snapshot derived from the per-slot array — the ONLY trusted
  // availability source (fail-closed contract, WL-0MUXVPXAZ005RESW) —
  // forwarded to the sole dispatch call. No per-worklog duplication —
  // total concurrently dispatched never exceeds the shared budget
  // (WL-0MT50LKAK001EF5Q single cap source). Per-tier minimums
  // (WL-0MT32F90V008UAD2 AC3): audit needs ≥2 (parent + Phase 2 child),
  // single-pane tiers need ≥1; idle-duration gate (configured N) is
  // unchanged and shared. The untrusted `available_slots` count is NEVER
  // used as a dispatch budget.
  const freeSlots = countFreeUnownedSlots(evaluation.perSlotSlots);

  // ── Running-pane liveness (decision-log telemetry only) ──
  // Count dispatched downtime panes that are STILL ALIVE (machine-wide,
  // across roots and leader/instance restarts).
  //
  // NOTE (WL-0MU2EP6JL006A1U3): this count is deliberately NOT a dispatch
  // cap. Dispatched panes stay open until an operator closes them, so
  // gating on it allows exactly one dispatch per pane-close (the overnight
  // stall). With the fail-closed contract (WL-0MUXVPXAZ005RESW) the
  // ownership gate is derived from the trusted per-slot array, so this
  // count is reported in the decision log only. Capacity is limited by
  // the local LLM idle / free-slot check alone.
  //
  // Fail-open: a failed query yields `null` → no known worker pane is
  // reported (the proxy's own lease signal still gates slot capacity). A
  // `herdr pane list` hiccup must never silently stop the dispatcher.
  let runningPanes: number | null = null;
  if (typeof ctx.opts.deps.getRunningDowntimePanes === 'function') {
    try {
      const running = await ctx.opts.deps.getRunningDowntimePanes(cfg.cwd);
      runningPanes = running.ok ? running.count : null;
    } catch {
      runningPanes = null; // fail-open — the proxy lease signal still gates
    }
  }

  // ── Owner-lease + contention gates (AC2/AC5/AC6) ──
  // `slotOwned`: no free UNOWNED slot remains (every slot is processing
  // or lease-owned), so a new pane must not be dispatched. Under the
  // fail-closed contract (WL-0MUXVPXAZ005RESW) the budget and the
  // ownership qualifier both come from the SAME per-slot array (the only
  // trusted availability source), so the two gates can never disagree.
  //
  // Per-slot gate (WL-0MU8807BI008C9ME): a busy or owned slot does NOT
  // block dispatch into the free unowned slots — `slotOwned` fires only
  // when countFreeUnownedSlots === 0. `ownerPresent` is retained purely
  // for the decision log (derived from `local_lease_active`).
  const ownerPresent = evaluation.status.local_lease_active === true;
  const slotOwned = countFreeUnownedSlots(evaluation.perSlotSlots) === 0;
  // `contentionQueueDepth` (LIVE depth only, WL-0MU1DWXO600153OI) is
  // computed once at the top of the tick: `contention_queued_count` is
  // cumulative telemetry and must never gate dispatch.

  // Single machine-wide dispatch gate applied to BOTH coordination and
  // legacy modes: a new pane must never be dispatched while the slot is
  // owned or the proxy reports live contention. Each refusal is neutral
  // (never a strike, never a cooldown) — the next idle tick re-evaluates.
  // Returning here (before `dispatching = true`) also covers the
  // coordination path (`dispatchFromCoordination`), which does not route
  // through `dispatchDowntimeWork`.
  //
  // There is deliberately NO client-side cap on the number of live panes
  // (WL-0MU2EP6JL006A1U3): the LLM idle / free-slot gate above is the
  // concurrency limiter, and a liveness-query failure no longer blocks
  // dispatch (it only feeds the `slotOwned` qualifier).
  if (slotOwned) {
    void recordDecision(ctx, cfg.cwd, 'slot-owned', {
      freeSlots,
      totalSlots: evaluation.status.total_slots,
      ownerPresent,
      runningPanes,
      contentionDepth: evaluation.contentionQueueDepth,
      ...evaluation.capacity,
      // AC5: an armed batch blocked by slot ownership keeps the existing
      // `slot-owned` token, now with its depth/cap/remaining metadata.
      ...batchMetadata(ctx),
    });
    ctx.activeAuditBatch = null; // no owned slot can host a continuation
    return { polled: true, dispatched: false, idle: true };
  }
  if (evaluation.contentionQueueDepth > 0) {
    void recordDecision(ctx, cfg.cwd, 'proxy-contention', {
      freeSlots,
      totalSlots: evaluation.status.total_slots,
      ownerPresent,
      runningPanes,
      contentionDepth: evaluation.contentionQueueDepth,
      ...evaluation.capacity,
      // AC5: an armed batch blocked by proxy contention keeps the existing
      // `proxy-contention` token, now with its metadata.
      ...batchMetadata(ctx),
    });
    ctx.activeAuditBatch = null; // proxy contention ends the batch window
    return { polled: true, dispatched: false, idle: true };
  }

  // ── Prefill-gate pacing (WL-0MVHSZRZQ00482QX) ──
  // The proxy serialises local prefills (LP-0MVGDUUV3001XFRJ), so a
  // free slot alone does not mean a NEW pane can prefill: its request
  // would queue behind the in-flight prefill and possibly fall back to a
  // remote provider. Pace to the same gate the proxy enforces. This can
  // only make the dispatcher MORE conservative — it never raises the
  // free-slot budget and never bypasses the fail-closed checks above.
  //   - gate waiters > 0 → contention evidence (reason `prefill-gate`);
  //   - cap reached → prefill capacity budget 0 (reason `prefill-cap`);
  //   - projected wait above the admission budget → reason `prefill-eta`.
  // Every field is absent on a pre-feature proxy → no pacing at all.
  const prefillPacing = evaluatePrefillPacing(evaluation.status, evaluation.perSlotSlots);
  if (prefillPacing.deferReason !== undefined) {
    void recordDecision(ctx, cfg.cwd, prefillPacing.deferReason, {
      freeSlots,
      totalSlots: evaluation.status.total_slots,
      ownerPresent,
      runningPanes,
      contentionDepth: evaluation.contentionQueueDepth,
      ...evaluation.capacity,
      ...batchMetadata(ctx),
    });
    ctx.activeAuditBatch = null; // a paced tick ends the batch window
    return { polled: true, dispatched: false, idle: true };
  }
  // Effective local dispatch budget (AC2): min(free-slot budget, prefill
  // headroom). `capacityBudget` is undefined when the cap is absent/0 or
  // the in-flight count is not served — today's free-slot-only budget.
  const effectiveFreeSlots =
    prefillPacing.capacityBudget === undefined
      ? freeSlots
      : Math.min(freeSlots, prefillPacing.capacityBudget);

  // ── One-per-idle-window launch fence (parent AC3, slice C3) ──
  // The proxy's atomic reservation (C2) arbitrates a cross-instance race;
  // this client-side fence handles the STALE-STATUS same-instance window:
  // once a launch is recorded, no further launch may be admitted while
  // the proxy's in-flight counter has not yet shown the launched prefill
  // registered — the current headroom is the pre-launch snapshot, so a
  // permissive proxy could otherwise grant a second ticket against it.
  // Distinct header token (`window-spent`) so an operator can tell this
  // hold from a paced stop (`prefill-gate`/`prefill-cap`) and from a lost
  // cross-instance race (`reservation-lost`). Neutral: never a strike,
  // never a cooldown.
  const launchVerdict = ctx.launchWindow.admit(Date.now());
  if (!launchVerdict.ok) {
    void recordDecision(ctx, cfg.cwd, 'idle-window-spent', {
      freeSlots,
      totalSlots: evaluation.status.total_slots,
      ownerPresent,
      runningPanes,
      contentionDepth: evaluation.contentionQueueDepth,
      ...evaluation.capacity,
      ...batchMetadata(ctx),
      // How many of THIS instance's launches the proxy has not yet
      // accounted for (observability evidence, AC3).
      pendingLaunches: ctx.launchWindow.pendingLaunches,
    });
    // The batch window is unchanged: the fence applies to the NEXT launch
    // decision, not to an already-armed batch (a continuation retries on
    // the following tick once registration is observed). No spawn is
    // attempted, no reserve request is made.
    return { polled: true, dispatched: false, idle: true };
  }

  // Coordination mode: the elected leader reads the shared coordination
  // list, re-fetches and classifies each entry's item (tier priority:
  // audit → implement → plan → intake) and dispatches the
  // highest-priority available item when a slot opens, removing its

  return {
    freeSlots,
    totalSlots: evaluation.status.total_slots,
    ownerPresent,
    runningPanes,
    contentionQueueDepth: evaluation.contentionQueueDepth,
    capacity: evaluation.capacity,
    effectiveFreeSlots,
    slotOwned,
  };
}

// ── Dispatch attempt ───────────────────────────────────────────────────

/**
 * Perform ONE dispatch attempt and apply its outcome transitions (cooldown /
 * three-strike, audit-batch bookkeeping, decision logging). Mirrors the
 * original `createDowntimeWorker` tick's dispatch block exactly; `dispatching`
 * flips true before the attempt and resets in all paths (single-flight guard
 * — a second concurrent tick checks it before reaching this phase).
 */
export async function performDispatch(
  ctx: OrchestratorContext,
  cfg: OrchestratorConfig,
  evaluation: PollEvaluation,
  admission: DispatchAdmission,
): Promise<{ dispatched: boolean }> {
  // entry. The CAS claim + dispatched-marker guards are preserved
  // inside `dispatchClaimedTier` (AC5). The idle-duration gate above
  // has already required ≥ N ≥ 1 free slots continuously, so the
  // dispatch runs only with a real slot available.
  //
  // Legacy mode (no coordinationDir / no fetchItem dep): the direct
  // per-instance tier chain (`dispatchDowntimeWork`) — pre-refactor
  // behavior, retained as the fail-open fallback.
  ctx.dispatching = true;
  // Depth-aware audit-batch continuation budget BEFORE this dispatch
  // (parent WL-0MVEDM8OT007WDRS AC1/AC2/AC5): `null` = no batch armed.
  // Passed to the dispatcher so a continuation decrements it; captured
  // here so the observability decisions below can distinguish a
  // continuation from the first dispatch of a batch AND attach the active
  // batch metadata to a blocked/ended decision.
  const armedBatch = ctx.activeAuditBatch;
  const continuationBudget = armedBatch !== null ? armedBatch.remaining : null;
  // Coordination entries read ONCE for this dispatch (parent
  // WL-0MVP7QHUB003ZA2A AC2): the same snapshot feeds the dispatch attempt
  // AND the no-candidate arm's peer-offer check below, so the "is a peer's
  // offer still live?" question costs a cheap in-memory scan instead of a
  // second worklog CLI probe.
  const coordinationEntries =
    ctx.opts.coordinationDir && typeof ctx.opts.deps.fetchItem === 'function'
      ? readCoordinationFile(ctx.opts.coordinationDir)?.entries ?? []
      : [];
  try {
    const outcome =
      ctx.opts.coordinationDir && typeof ctx.opts.deps.fetchItem === 'function'
        ? await dispatchFromCoordination(
            ctx.opts.deps,
            coordinationEntries,
            {
              model: cfg.model,
              cwd: cfg.cwd,
              coordinationDir: ctx.opts.coordinationDir,
              localPreference: cfg.localPreference,
              localPreferenceMode: cfg.localPreferenceMode,
              freeSlots: admission.effectiveFreeSlots,
              browseItemCount: cfg.browseItemCount,
              auditBatchMax: cfg.auditBatchMax,
              // Continuation budget (parent WL-0MVEDM8OT007WDRS AC1) —
              // consumed by the coordination continuation item.
              ...(continuationBudget !== null ? { auditBatchRemaining: continuationBudget } : {}),
              // Batch-local exclusion set (WL-0MVFE1DD8000D8T2 AC3/AC4):
              // every target already dispatched in this batch window.
              ...(armedBatch !== null
                ? { auditBatchDispatchedIds: [...armedBatch.dispatchedIds] }
                : {}),
              nonTerminalCooldownMs: cfg.nonTerminalCooldownMs,
              maxAttempts: cfg.maxAttempts,
              // Dispatched success-marker staleness window
              // (WL-0MU6UL0RJ008IHGT): forwarded to the own-backlog
              // fallback's marker exclusion.
              markerStaleWindowMs: cfg.markerStaleWindowMs,
              stallScanEnabled: cfg.stallScanEnabled,
              stallScanThresholdMs: cfg.stallScanThresholdMs,
              cpuGatePercent: cfg.cpuGatePercent,
              leaseTtlMs: ctx.opts.leaseTtlSeconds
                ? ctx.opts.leaseTtlSeconds * 1000
                : DEFAULT_LEASE_TTL_SECONDS * 1000,
            },
          )
        : await dispatchDowntimeWork(ctx.opts.deps, {
            model: cfg.model,
            cwd: cfg.cwd,
            // Per-turn locality preference (slice C4 AC1), read live from
            // `downtimeLocalPreference`. Absent on legacy configs →
            // today's byte-identical launch (fail-open C4-AC3). The mode
            // (WL-0MVNUIW77000VYAX) tells the dispatch boundary whether the
            // low-priority rule may derive the value.
            localPreference: cfg.localPreference,
            localPreferenceMode: cfg.localPreferenceMode,
            freeSlots: admission.effectiveFreeSlots,
            browseItemCount: cfg.browseItemCount,
            // Depth-aware audit-batch cap (parent WL-0MVEDM8OT007WDRS AC1).
            auditBatchMax: cfg.auditBatchMax,
            // Continuation budget for the current idle window; absent on
            // the first dispatch / when no batch is armed.
            ...(continuationBudget !== null ? { auditBatchRemaining: continuationBudget } : {}),
            // Owner-lease (AC2) + contention (AC6) gates
            // (WL-0MTYZXSLN008HZOW). No pane-count cap
            // (WL-0MU2EP6JL006A1U3).
            slotOwned: admission.slotOwned,
            contentionQueueDepth: admission.contentionQueueDepth,
            // Success-marker staleness window (WL-0MU6UL0RJ008IHGT).
            markerStaleWindowMs: cfg.markerStaleWindowMs,
            // Non-terminal pane-close cooldown (WL-0MUKYERLZ006ELL5).
            nonTerminalCooldownMs: cfg.nonTerminalCooldownMs,
            // Per-item/per-kind dispatch-attempt cap (WL-0MUKYEXMK0033MFK).
            maxAttempts: cfg.maxAttempts,
            // Stalled-work scan before new-item selection
            // (WL-0MUYMBSA90092QV2).
            stallScanEnabled: cfg.stallScanEnabled,
            stallScanThresholdMs: cfg.stallScanThresholdMs,
            // Host-CPU gate threshold (WL-0MVK0UO3Q002TXW6 AC2/AC5).
            cpuGatePercent: cfg.cpuGatePercent,
          });
    // Record the refusal reason (WL-0MU8808ZY0091JIA): actionable
    // no-dispatch outcomes (no-candidate / review-queue-hold / code-freeze
    // / audit-in-flight / wl-error / ...) are logged (rate-limited) so the
    // dispatcher's decision is observable. A successful dispatch is not a
    // refusal.
    if (!outcome.dispatched && typeof outcome.reason === 'string') {
      // A reserve-handshake refusal is a DISTINCT operator signal from a
      // paced stop (parent AC3, slice C3): record it under the grouped
      // `reservation-refused` reason (header token `reservation-lost`) and
      // keep the proxy's own vocabulary in `reservationReason`, so a lost
      // reservation race can never be confused with herdr's own
      // `prefill-gate`/`prefill-cap` pacing.
      const reservationRefused = outcome.reservation?.admit === false;
      void recordDecision(
        ctx,
        cfg.cwd,
        reservationRefused ? 'reservation-refused' : outcome.reason,
        {
          freeSlots: admission.freeSlots,
          totalSlots: evaluation.status.total_slots,
          ownerPresent: admission.ownerPresent,
          runningPanes: admission.runningPanes,
          contentionDepth: admission.contentionQueueDepth,
          ...admission.capacity,
          // AC5: a held/blocked continuation reuses the EXISTING token
          // unchanged (`audit-in-flight` / `audit-host-saturated` /
          // `code-freeze` / `review-queue-hold` / `no-candidate` / ...) and
          // gains the active batch metadata as an additive field.
          ...batchMetadata(ctx, outcome.auditBatch),
          // The proxy's own refusal reason (open vocabulary), preserved
          // for diagnosis alongside the grouped entry reason.
          ...(reservationRefused ? { reservationReason: outcome.reason } : {}),
          // Reservation evidence (parent WL-0MVIKRFP0005JDL8 AC2/AC4,
          // slice C2): a refusal carries its reason as the decision reason
          // (distinct header token) plus `admit: false`, `retryAfterS` and
          // `projectedWaitS`; a granted ticket that could not be forwarded
          // carries `reservationTicket` + `reservationReleased`. Absent on
          // fail-open dispatches and pre-reservation outcomes.
          ...outcome.reservation,
          // Host-CPU gate evidence (WL-0MVK0UO3Q002TXW6 AC4): present on a
          // `cpu-saturated` refusal so the measured utilisation, its
          // source and the configured threshold are recoverable from the
          // decision log. Absent on every other outcome.
          ...(outcome.hostCpuPercent !== undefined
            ? {
                hostCpuPercent: outcome.hostCpuPercent,
                hostCpuSource: outcome.hostCpuSource,
                cpuGatePercent: outcome.cpuGatePercent,
              }
            : {}),
        },
        // The grouped token must not change the starvation signal: the
        // tracker keeps judging the PROXY's own reason, exactly as it did
        // when that reason was the entry reason (slice C3).
        reservationRefused ? { starvationReason: outcome.reason } : {},
      );
    }
    // Any non-`dispatched` outcome ends the audit batch (parent
    // WL-0MVEDM8OT007WDRS AC3): the next audit requires a fresh full idle
    // period, and a continuation never skips to another target. The
    // refusal token above already carries the batch metadata, so no
    // separate end token is emitted (no duplicate line per refusal).
    if (!outcome.dispatched) ctx.activeAuditBatch = null;
    if (outcome.dispatched) {
      // One-per-idle-window fence (parent AC3, slice C3): record the
      // launch so the NEXT dispatch decision in this window requires a
      // fresh observation that the launched prefill registered.
      ctx.launchWindow.recordLaunch(Date.now());
      ctx.lastDispatchAt = Date.now();
      ctx.errorStrikes = 0; // a successful dispatch proves the CLI is healthy
      // A successful dispatch proves capacity was available, so the
      // capacity-starvation episode is over (WL-0MVKNC2N50025HXE AC3).
      ctx.starvationTracker.reset();
      const batch = outcome.auditBatch;
      // AC5 observability: a CONTINUATION audit dispatch records its own
      // decision token (with depth/cap/remaining) at the existing rate
      // limit. The first dispatch of a batch is a normal dispatch. This
      // is an observation, not a refusal — it must not touch the header
      // blocking token.
      if (
        continuationBudget !== null &&
        continuationBudget > 0 &&
        outcome.kind === 'audit' &&
        batch !== undefined &&
        batch.active
      ) {
        void recordDecision(
          ctx,
          cfg.cwd,
          'audit-batch-continue',
          {
            freeSlots: admission.freeSlots,
            totalSlots: evaluation.status.total_slots,
            ownerPresent: admission.ownerPresent,
            runningPanes: admission.runningPanes,
            contentionDepth: admission.contentionQueueDepth,
            auditBatchDepth: batch.depth,
            auditBatchCap: batch.cap,
            auditBatchRemaining: batch.remaining,
          },
          { blocking: false },
        );
      }
      // Conditional idle reset (parent WL-0MVEDM8OT007WDRS AC2): only a
      // successful AUDIT dispatch in an active batch with budget
      // remaining defers the reset — every gate (idle-duration, free
      // slots, slot ownership, contention, freeze, active-audit markers,
      // single-flight) is still re-checked on the continuation tick.
      // Every other dispatch keeps today's full reset exactly.
      const deferIdleReset =
        outcome.kind === 'audit' &&
        batch !== undefined &&
        batch.active &&
        batch.remaining > 0;
      if (deferIdleReset) {
        // The batch-local exclusion set accumulates every target dispatched
        // in this window (WL-0MVFE1DD8000D8T2 AC3/AC4).
        const dispatchedId = outcome.candidate?.id;
        const nextIds = new Set(armedBatch?.dispatchedIds ?? []);
        if (dispatchedId !== undefined && dispatchedId.length > 0) {
          nextIds.add(dispatchedId);
        }
        ctx.activeAuditBatch = {
          depth: batch.depth,
          cap: batch.cap,
          remaining: batch.remaining,
          dispatchedIds: nextIds,
        };
      } else {
        // Batch-end observability (AC5): the silent deactivation of an
        // armed batch after a successful audit dispatch (cap reached or
        // depth dropped below the threshold) gets ONE distinct token so
        // "why did the batch stop?" is answerable from the log. It is
        // rate-limited like every other decision and is never emitted on
        // a refusal (that token already carries the metadata) or when no
        // batch was armed (nothing ended).
        if (continuationBudget !== null && outcome.kind === 'audit' && batch !== undefined) {
          const batchThreshold = resolveSprintViewWindow(cfg.browseItemCount);
          void recordDecision(
            ctx,
            cfg.cwd,
            'audit-batch-end',
            {
              freeSlots: admission.freeSlots,
              totalSlots: evaluation.status.total_slots,
              ownerPresent: admission.ownerPresent,
              runningPanes: admission.runningPanes,
              contentionDepth: admission.contentionQueueDepth,
              auditBatchDepth: batch.depth,
              auditBatchCap: batch.cap,
              auditBatchRemaining: batch.remaining,
              auditBatchEndReason: batch.depth < batchThreshold ? 'depth' : 'cap',
            },
            { blocking: false },
          );
        }
        ctx.activeAuditBatch = null;
        // Belt-and-suspenders: even if the proxy does not immediately
        // report busy, require a fresh full idle period before the next
        // dispatch (AC5).
        ctx.tracker.record(false);
        ctx.perSlotTracker.record([]);
      }
      // Voluntary leadership hand-off after an own-backlog fallback
      // dispatch (parent WL-0MUU4XFU90008E24 AC4/AC5/A3): the fallback
      // reached beyond the sprint-view window into the leader's own
      // backlog, so the instance relinquishes leadership so another
      // instance can win the next election. The claim / marker / spawn
      // already completed inside `dispatchFromCoordination` before this
      // point, so the step-down never rolls back a pending dispatch and
      // the dispatched pane is not orphaned. Exactly once per own-backlog
      // dispatch (the outcome is consumed here), and never for a normal
      // in-view dispatch. Setting `leaderState = false` prevents an
      // immediate self re-election in this tick (the election block runs
      // at the start of the next tick). Legacy mode (`leaderManager ===
      // null`) is unchanged.
      if (outcome.ownBacklogDispatch === true && ctx.leaderManager !== null) {
        ctx.leaderManager.releaseLeadership();
        ctx.leaderState = false;
      }
    } else if (outcome.reason === 'no-candidate') {
      // WL-0MTEZ4XZJ006Y9U7 (AC1): in coordination mode the shared file
      // is an OFFER LIST, not the backlog — after a dispatch the leader
      // removes the entry, so an empty file is a TRANSIENT gap while the
      // worklog still has dispatchable work (the pre-fix code paused on
      // it for the full cooldown, stalling the dispatch).
      // WL-0MTMPSCL8000O45H AC2: the owner also observes its own entry
      // missing and re-offers immediately on the next tick (not while in
      // noCandidate cooldown and not when the last check-in found nothing).
      // Probe the worklog before pausing; only a GENUINELY empty backlog
      // pauses (legacy non-coordination semantics unchanged):
      //  - probe finds a candidate → no pause, no strike: the periodic
      //    check-in re-offers it and dispatch resumes;
      //  - probe fails (wl/CLI errors) → fail-closed strike (a broken
      //    lookup must never look like an empty backlog — the
      //    three-strike rule decides when to pause);
      //  - probe finds nothing → genuine empty backlog → pause entirely
      //    and reset the idle tracker (fresh full idle period required
      //    after the pause).
      if (ctx.opts.coordinationDir && typeof ctx.opts.deps.fetchItem === 'function') {
        const probe = await computeMostImportantItem(ctx.opts.deps, cfg.cwd, Date.now(), cfg.browseItemCount, cfg.markerStaleWindowMs, cfg.nonTerminalCooldownMs, cfg.maxAttempts, cfg.stallScanEnabled, cfg.stallScanThresholdMs, cfg.cpuGatePercent);
        if (probe.ok && 'noCandidate' in probe && probe.noCandidate) {
          ctx.errorStrikes = 0; // the CLI answered — it is healthy
          // Empty-leader hand-off (parent WL-0MVP7QHUB003ZA2A AC1): a
          // genuinely empty cycle (no in-view, no offer, no own-backlog
          // dispatch AND an empty own root) releases leadership so a peer
          // whose sprint view DOES hold dispatchable work can win the next
          // election and dispatch. Leadership is a transient role granted
          // to the instance with work to do, not permanently held by a
          // no-work instance. This is the SAME `releaseLeadership()`
          // primitive the own-backlog hand-off above uses (the election
          // primitive is reused, never modified) and it fires at most once
          // per cycle: the `ctx.leaderState === true` guard makes a repeat
          // call in the same tick a no-op, and `releaseLeadership()` itself
          // is an idempotent stateless lock/lease file delete (fail-safe —
          // never throws, so it cannot escape the dispatch attempt). The
          // step-down is skipped for every other branch: a probe candidate
          // (transiently empty coordination file), a failed probe
          // (fail-closed strike path — an unknown backlog is not an empty
          // one) and every hold/gate reason, which return their own
          // terminal reason before reaching this arm. Legacy mode
          // (`leaderManager === null`) has nothing to hand off and is
          // unchanged.
          if (ctx.leaderManager !== null && ctx.leaderState) {
            ctx.leaderManager.releaseLeadership();
            ctx.leaderState = false;
          }
          // Peer-offer suppression (parent WL-0MVP7QHUB003ZA2A AC2): the
          // probe answered only "is THIS instance's own root empty?". When a
          // PEER's entry still holds a dispatchable offer, the backlog is not
          // empty — it is another root's — and the 60-minute full stop would
          // stop polling the offer list entirely, starving that offer (the
          // live 2026-10-26 incident: an idle leader paused while
          // ContextHub's offer sat undispatched). So a live peer offer skips
          // the pause arm AND its idle-tracker reset, leaving the offer list
          // polled and the peer offer dispatchable across the leadership
          // hand-off. The check is a cheap scan of the entries already read
          // for this dispatch (no second worklog probe).
          if (!hasPeerOffer(coordinationEntries, ctx.instanceId)) {
            ctx.cooldownUntil = Date.now() + cfg.noCandidateCooldownMs;
            ctx.tracker.record(false);
            ctx.perSlotTracker.record([]);
          }
        } else if (!probe.ok) {
          await pauseAfterPersistentErrors(
            ctx,
            `Downtime worker: worklog probe failed while the shared ` +
            `coordination file held no dispatchable entry — ` +
            `${DOWNTIME_ERROR_STRIKE_LIMIT} consecutive errors, pausing ` +
            `dispatch for ${cfg.noCandidateCooldownMs}ms.`,
            undefined,
            { probeContext: 'coordination-probe', timeoutMs: DOWNTIME_WL_TIMEOUT_MS },
          );
        }
        // probe.ok with a candidate (or `reviewQueueHold` — the deep-queue
        // gate left only held implements, WL-0MTTSWC1X005P4VD — or
        // `inFlightHold` — only in-flight criticals remain,
        // WL-0MUBVKYH5009CGBI): no pause — the empty file is a transient
        // gap / the hold may lift at any moment; the check-in re-offers
        // the candidate.
      } else {
        // Legacy mode — original semantics: no-candidate means a genuine
        // empty backlog; pause entirely for the cooldown.
        ctx.errorStrikes = 0; // the CLI answered — it is healthy
        ctx.cooldownUntil = Date.now() + cfg.noCandidateCooldownMs;
        ctx.tracker.record(false);
        ctx.perSlotTracker.record([]);
      }
    } else if (outcome.reason === 'wl-error') {
      // Three-strike rule on CLI errors: a dispatch attempt ending in a
      // wl failure is one strike. Three consecutive strikes pause the
      // worker entirely (no dispatch) AFTER logging the persistent error
      // so the failure is auditable. A single transient error does NOT
      // pause — it retries on the next idle period. Carry the
      // underlying wl error (WL-0MTL4PC0Y005GXTI) so the pause entry is
      // actionable. WL-0MTJPYM53003ORCV: pass structured error context.
      await pauseAfterPersistentErrors(
        ctx,
        `Downtime worker: ${DOWNTIME_ERROR_STRIKE_LIMIT} consecutive ` +
        `wl CLI errors — pausing dispatch for ${cfg.noCandidateCooldownMs}ms.`,
        outcome.error,
        { probeContext: 'dispatch-cli', timeoutMs: DOWNTIME_WL_TIMEOUT_MS, workItemId: outcome.workItemId },
      );
    }
    // Any other non-dispatch outcome (dispatch-in-flight, code-freeze
    // skip, review-queue-hold — WL-0MTTSWC1X005P4VD) is neutral: no
    // strike, no cooldown — the next idle period retries (a freeze skip
    // keeps polling so implement/audit dispatch resumes immediately when
    // the freeze lifts, WL-0MSQ0RPQP00636JY; a deep-queue hold keeps
    // polling so audits keep draining and dispatch resumes the moment
    // the queue thins).
    return { dispatched: outcome.dispatched };
  } finally {
    ctx.dispatching = false;
  }
}
