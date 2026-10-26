/**
 * packages/herdr/src/downtime-worker.orchestrator-tick.ts — the downtime
 * worker's per-tick state machine.
 *
 * Single responsibility: drive ONE tick — the enabled/disable-marker gates,
 * leader election + coordination check-in, the pane-lifecycle/reaper
 * maintenance passes, the no-candidate cooldown gate and the poll/evaluate
 * phase — applying the decision/starvation/strike helpers the dispatch module
 * owns.
 *
 * Extracted from `downtime-worker.ts` by WL-0MVLII2080074S5L (extract the
 * downtime-worker orchestrator modules). Every tick phase now takes the
 * shared `OrchestratorContext` as its first argument (plan option A): the
 * `createDowntimeWorker` closure vars it used to capture became explicit
 * context fields, so the tick is readable without the enclosing closure.
 * Moved blocks are verbatim (a refusal returns the same
 * `{ polled, dispatched, idle }` shape); no decision, threshold, ordering or
 * log message changed.
 *
 * Parent: WL-0MVF3F9A7000HKP7 (decompose the `downtime-worker.ts` god class).
 */

import { getEntry, hasPeerOffer, readCoordinationFile } from './coordination.js';
import { appendCoordinationLogEntry } from './downtime-log.js';
import { DEFAULT_DOWNTIME_CAPACITY_STARVATION_ALERT_MS } from './capacity-starvation.js';
import { disableMarkerExists } from './downtime-disable-marker.js';
import { cleanupStaleElection } from './leader-election.js';
import { runCoordinationCheckIn } from './downtime-worker.coordination-leader.js';
import {
  countFreeUnownedSlots,
  evaluateIdle,
  perSlotGlobalIdleChecks,
  pollShowsLocalActivity,
  usablePerSlotSlots,
} from './downtime-worker.idle.js';
import {
  DEFAULT_DOWNTIME_LONG_RUNNING_THRESHOLD_MS,
  DOWNTIME_PANE_LIFECYCLE_INTERVAL_MS,
  PANE_LIFECYCLE_MONITOR_ENABLED,
  capacityEvidence,
  reportedIdleSeconds,
} from './downtime-worker.constants.js';
import {
  monitorDispatchedPanes,
  paneLifecycleErrMsg,
  paneLifecycleWarn,
} from './downtime-worker.pane.js';
import { paneCloseReaperDue } from './pane-close-scheduler.js';
import {
  admitDispatch,
  batchMetadata,
  performDispatch,
  recordDecision,
  type OrchestratorConfig,
  type OrchestratorContext,
  type PollEvaluation,
} from './downtime-worker.orchestrator-dispatch.js';
import type { OrchestratorTickResult } from './downtime-worker.orchestrator-dispatch.js';

// ── Tick phases ────────────────────────────────────────────────────────

/**
 * The enabled / durable-disable-marker gates (WL-0MTTSWC1X005P4VD): return a
 * stopped tick when the worker is toggled off or a manual `d` marker is live,
 * else null.
 */
export function applyEnabledGates(
  ctx: OrchestratorContext,
  cfg: OrchestratorConfig,
): OrchestratorTickResult | null {
  // Short-circuit on the EFFECTIVE enabled state (override ?? settings):
  // while toggled off the worker performs no proxy polling, no idle
  // tracking, and no dispatch — exactly the settings-disabled path.
  if (!(ctx.override ?? cfg.enabled)) {
    ctx.activeAuditBatch = null; // disabled → no carried batch window
    return { polled: false, dispatched: false, idle: false };
  }
  // ── Live marker gate (MANUAL `d`-toggle semantics only) ──────────
  // WL-0MTTSWC1X005P4VD removed the sprint-complete auto-disable that
  // used to write/clear this marker from queue depth (RCA root cause A:
  // `completed/in_review >= browseItemCount` halted ALL dispatch AND the
  // coordination check-in — the 21:53Z silence with no log lines). Queue
  // depth NEVER stops the worker here: the producer review policy only
  // holds non-critical implement dispatch (see the shared review-queue
  // gate in dispatchDowntimeWork / dispatchFromCoordination), so audits
  // (the queue drain), plan, intake, critical implements and the
  // coordination check-in all continue regardless of queue depth.
  //
  // The marker is now written ONLY by the manual `d` toggle; a live
  // gate respects a manually toggled marker immediately (not just at
  // construction) so a disable survives a pane/plugin restart and is
  // honoured cross-process.
  if (disableMarkerExists(cfg.cwd) && ctx.override === null) {
    ctx.activeAuditBatch = null; // disabled → no carried batch window
    return { polled: false, dispatched: false, idle: false };
  }
  return null;
}

/**
 * Leader election + coordination check-in (parent WL-0MST3OJ8S0001ROL
 * AC1/AC2/AC3): self-heal, re-derive leadership every tick, take over a
 * stale lease, then run this instance's check-in. Returns the tick's clock
 * reading plus a stop result when this instance is not the leader.
 */
export async function runLeaderElectionAndCheckIn(
  ctx: OrchestratorContext,
  cfg: OrchestratorConfig,
): Promise<{ tickNow: number; stop: OrchestratorTickResult | null }> {
  // ── Leader election + coordination check-in (parent
  // WL-0MST3OJ8S0001ROL AC1/AC2/AC3) ───────────────────────────────────
  // In legacy mode (no coordinationDir) this whole block is skipped: no
  // election, no check-in — the worker is always the leader and uses the
  // direct tier chain below (pre-refactor behavior).
  const tickNow = Date.now();
  if (ctx.leaderManager !== null) {
    // ── F5 (WL-0MTF4ABQN0043F4V): self-heal + re-derive EVERY tick ──
    // The pre-fix code derived `leaderState` ONCE at creation and only
    // updated it inside the takeover branch — a lease that expired
    // mid-pause (worker's tick loop stalled in the no-candidate
    // cooldown) left the worker dispatching with a cached leaderState
    // as a zombie. Two changes fix this:
    //
    //  AC2 — self-heal FIRST. refreshLease() now renews only an OWNED
    //  lease regardless of validity (F4 ownership check), so an
    //  owned-but-EXPIRED lease is renewed here instead of silently
    //  no-oped. This must run before the isLeader() re-derivation
    //  below: detectStaleLeader() returns false for our OWN lease, so
    //  without it an expired owned lease would fall through BOTH the
    //  leader branch (isLeader() false) AND the takeover branch
    //  (hasLease true, detectStaleLeader false) — the self-heal would
    //  be starved. Foreign/missing leases are untouched (refreshLease
    //  no-ops on those — F4 fail-safe).
    ctx.leaderManager.refreshLease();
    //  AC1 — re-derive leadership every tick (one cheap lease-file
    //  read): a lease that expired mid-pause routes this worker OUT of
    //  zombie dispatch; if ANOTHER instance won the lease during the
    //  pause, this re-derived state yields — never fights the new
    //  leader (AC4).
    ctx.leaderState = ctx.leaderManager.isLeader();
    if (ctx.leaderState) {
      // Leader: self-heal already ran above (fresh acquiredAt this
      // tick — each proxy-poll cycle extends the 5-minute lease,
      // AC2). A failed refresh (rename/IO) is fail-safe: the existing
      // lease stands until it expires, then a new election runs.
    } else if (!ctx.leaderManager.hasLease() || ctx.leaderManager.detectStaleLeader()) {
      // No leader exists yet (fresh election) OR the elected leader's
      // lease expired (crash / idle) — try to take over NOW. Stale
      // state is cleaned first (an expired lease, or an orphaned lock
      // without a lease, must not block the new election). On success
      // we become the leader this tick; on lock contention (another
      // instance won first — its cleanup+no-op or a valid lease) we
      // stay non-leader and retry on a later tick. Fail-safe: a failed
      // election leaves us non-leader (no dispatch).
      cleanupStaleElection({ worklogDir: ctx.opts.coordinationDir! });
      ctx.leaderManager.attemptElection();
      ctx.leaderState = ctx.leaderManager.isLeader();
      if (ctx.leaderState) ctx.leaderManager.refreshLease();
      // Audit trail (WL-0MSXHAE290067VAL): log the leadership win —
      // initial election or takeover after a stale-lease detection.
      if (ctx.leaderState) {
        void appendCoordinationLogEntry(cfg.cwd, {
          kind: 'coordination',
          operation: 'election',
          instanceId: ctx.instanceId,
          at: new Date(tickNow).toISOString(),
        });
      }
    }

    // Coordination check-in (parent AC3 — first on startup, then every
    // 5 min, WL-0MTMPSCL8000O45H): recompute THIS instance's most-
    // important item and verify/update its entry in the shared
    // coordination file. Runs for leader AND non-leader alike — every
    // instance contributes its most important item; the single elected
    // leader dispatches from the list. Leader every 4 min
    // (WL-0MTOCBP1D009P4U3); clamp ≥ 60 s.
    //
    // WL-0MTMPSCL8000O45H AC2 — immediate re-offer when the owner's own
    // entry was removed by the leader's dispatch (push-based re-offer
    // via coordination-file observation on the next tick). Fail-open:
    // unreadable coordination file → no re-offer → the periodic cadence
    // retries. Not while paused (no-candidate cooldown is a full stop;
    // the periodic boundary below still cancels the pause on a fresh
    // offer) and not while the last check-in offered nothing (churn
    // guard — the periodic cadence re-probes for new work).
    let reOfferDue = false;
    try {
      const notPaused = ctx.cooldownUntil === null || Date.now() >= ctx.cooldownUntil;
      reOfferDue =
        notPaused
        && !disableMarkerExists(cfg.cwd)
        && !ctx.lastOfferEmpty
        && getEntry(ctx.opts.coordinationDir!, ctx.instanceId) === null;
    } catch {
      reOfferDue = false;
    }
    const effectiveCheckInMs = ctx.leaderState ? ctx.leaderCheckInMs : ctx.checkInIntervalMs;
    if (reOfferDue || ctx.lastCheckInAt === null || tickNow - ctx.lastCheckInAt >= effectiveCheckInMs) {
      ctx.lastCheckInAt = tickNow;
      try {
        const checkIn = await runCoordinationCheckIn(ctx.opts.deps, {
          cwd: cfg.cwd,
          coordinationDir: ctx.opts.coordinationDir!,
          instanceId: ctx.instanceId,
          browseItemCount: cfg.browseItemCount,
          markerStaleWindowMs: cfg.markerStaleWindowMs,
          nonTerminalCooldownMs: cfg.nonTerminalCooldownMs,
          maxAttempts: cfg.maxAttempts,
        }, tickNow);
        ctx.lastOfferEmpty = checkIn.offered === null;
        // WL-0MTEZ4XZJ006Y9U7 (AC2): a successful re-offer proves the
        // backlog is dispatchable again — cancel any no-candidate pause
        // so the leader resumes polling/dispatch this very tick. The
        // check-in block runs BEFORE the cooldown gate below, so the
        // pause can never suppress the only mechanism that re-offers
        // work once the coordination file empties.
        // WL-0MTEZ4XZJ006Y9U7 (AC2): any successful write (re-offer
        // or emptied entry) proves CLI health — cancel any pause so
        // polling resumes this tick. A non-update on a paused worker
        // also cancels (the write proved CLI health; dispatch will
        // resume next tick via the poll).
        if (checkIn.updated || checkIn.offered !== null) {
          ctx.cooldownUntil = null;
          ctx.errorStrikes = 0;
        } else if (ctx.cooldownUntil !== null && checkIn.offered !== null) {
          // File already holds the same entry (no write needed) but
          // CLI healthy — also cancel so stale-file probes don't keep
          // the pause alive while work still exists.
          ctx.cooldownUntil = null;
          ctx.errorStrikes = 0;
        } else if (ctx.cooldownUntil !== null && hasPeerOffer(
          readCoordinationFile(ctx.opts.coordinationDir!)?.entries ?? [],
          ctx.instanceId,
        )) {
          // Coordination check-in cancels, peer presence cancels (parent
          // WL-0MVP7QHUB003ZA2A AC3): an offer that APPEARS during a pause
          // (another instance's check-in) must not wait out the 60-minute
          // full stop — the offer list is not polled while paused, so this
          // check-in is the only tick that can observe it. A peer entry with
          // a dispatchable item means the backlog is not empty, so the pause
          // is cancelled and polling resumes on this very tick (the cooldown
          // gate below then sees `cooldownUntil === null`). Fail-safe: an
          // unreadable coordination file resolves `[]` → no peer → the pause
          // is left exactly as it is today.
          ctx.cooldownUntil = null;
          ctx.errorStrikes = 0;
        }
      } catch {
        // Fail-safe: a throwing check-in (stub or regression) must never
        // crash the worker — retried at the next cadence.
      }
    }

    // Non-leader short-circuit (AC4): no proxy polling, no idle
    // tracking, no dispatch — the check-in above is the instance's only
    // coordination activity. (Lease takeover was handled above.)
    if (!ctx.leaderState) {
      ctx.activeAuditBatch = null; // leadership lost → the batch window ends
      return { tickNow, stop: { polled: false, dispatched: false, idle: false } };
    }
  }
  return { tickNow, stop: null };
}

/**
 * Pane-lifecycle monitor + pane-close reaper passes (WL-0MU308WSF0002JWN,
 * WL-0MUJL1NAH0042GOS). Both are fire-and-forget: the single-flight dispatch
 * guard relies on `dispatching` being set before a second concurrent tick
 * reaches its check, so neither pass may add an await on the pre-dispatch
 * path.
 */
export function runPaneMaintenance(
  ctx: OrchestratorContext,
  cfg: OrchestratorConfig,
  tickNow: number,
): void {
  // ── Pane-lifecycle monitor (WL-0MU308WSF0002JWN) — DISABLED ────────
  // Mechanism B is switched off (WL-0MUMEKDK0008LKH8):
  // `PANE_LIFECYCLE_MONITOR_ENABLED` is false, so the guard below never
  // runs the monitor and the scheduled reaper further down is the only
  // active auto-close path. The block is retained (and the pure
  // classifier + its tests kept) so the design can be revisited.
  //
  // When enabled it would run on the LEADER (legacy mode: always) and
  // BEFORE the cooldown
  // gate, so completed dispatched panes are tidied even while dispatch
  // is paused in a no-candidate cooldown. Cadence-bounded (default 30 s)
  // so the ~10 s tick does not re-query the worklog for every open pane
  // on every tick.
  //
  // FIRE-AND-FORGET (deliberately NOT awaited): the single-flight
  // dispatch guard relies on the first in-flight tick setting
  // `dispatching` before a second concurrent tick reaches its check — an
  // extra await on the pre-dispatch path lets the second tick win that
  // race and double-dispatch (pinned by the worker single-flight test).
  // The monitor is internally fail-closed and idempotent, so running it
  // concurrently is safe; the `.catch` is belt-and-braces.
  const paneMonitorIntervalMs =
    cfg.paneLifecycleIntervalMs ?? DOWNTIME_PANE_LIFECYCLE_INTERVAL_MS;
  if (
    PANE_LIFECYCLE_MONITOR_ENABLED &&
    tickNow - ctx.lastPaneMonitorAt >= paneMonitorIntervalMs
  ) {
    ctx.lastPaneMonitorAt = tickNow;
    void monitorDispatchedPanes(ctx.opts.deps, cfg.cwd).catch((err) => {
      // fail-closed: pane-lifecycle monitoring must never crash the worker
      paneLifecycleWarn(`monitor pass threw: ${paneLifecycleErrMsg(err)}`);
    });
  }

  // ── Pane-close reaper (WL-0MUJL1NAH0042GOS) ────────────────────────
  // Scheduled, out-of-process closure of settled/abandoned panes.
  // Cadence-bounded (default 60 s) and gated by `paneClose.enabled`.
  // FIRE-AND-FORGET (like the monitor) so an extra await never lets a
  // concurrent tick win the single-flight dispatch race; the reaper is
  // internally fail-closed and idempotent, and its throw is caught here
  // so the worker continues. A pane already handled by the dispatch
  // monitor above is skipped by the reaper (shared classifier +
  // already-closed set), so the two mechanisms never double-close.
  if (paneCloseReaperDue(cfg.paneClose, ctx.lastPaneCloseReaperAt, tickNow)) {
    ctx.lastPaneCloseReaperAt = tickNow;
    const paneClose = cfg.paneClose!;
    if (typeof ctx.opts.deps.runPaneCloseReaper === 'function') {
      try {
        void ctx.opts.deps
          .runPaneCloseReaper(cfg.cwd, {
            idleThresholdMinutes: paneClose.idleThresholdMinutes,
            ledgerPath: paneClose.ledgerPath,
          })
          .catch((err) => {
            // fail-closed: the reaper must never crash the worker
            paneLifecycleWarn(`pane-close reaper pass threw: ${paneLifecycleErrMsg(err)}`);
          });
      } catch (err) {
        // Synchronous throw from the injected runner — swallow and log.
        paneLifecycleWarn(`pane-close reaper pass threw synchronously: ${paneLifecycleErrMsg(err)}`);
      }
    }
  }
}

/**
 * No-candidate cooldown gate (WL-0MTEZ4XZJ006Y9U7 AC2): a live pause is a
 * full stop (no poll, no idle tracking, no dispatch); an expired pause is
 * cleared here, after the check-in block had its chance to cancel it.
 */
export function applyCooldownGate(ctx: OrchestratorContext): OrchestratorTickResult | null {
  // Cooldown gate (WL-0MTEZ4XZJ006Y9U7 AC2 — ordering): the check-in
  // block above runs FIRST, so a no-candidate pause never suppresses the
  // coordination check-in (the only mechanism that re-offers work once
  // the coordination file empties); a fresh re-offer cancels the pause
  // directly. While paused the worker performs NO proxy polling, NO
  // idle tracking, and NO dispatch. The pause is a full stop (user
  // confirmed "pause completely"); once it expires the idle tracker is
  // empty, so a fresh full idle period is required before the next
  // dispatch (no stale idle credit from before the pause).
  if (ctx.cooldownUntil !== null) {
    if (Date.now() < ctx.cooldownUntil) {
      ctx.activeAuditBatch = null; // paused → the idle window is over
      return { polled: false, dispatched: false, idle: false };
    }
    // ── F5 cooldown-exit hook (AC3) ──
    // Pause expired — resume normal polling. Nothing further is needed
    // here for leadership: the leader block at the top of THIS tick
    // already ran the self-heal refreshLease + per-tick re-derivation
    // BEFORE reaching this gate, so any dispatch decision on this
    // resume tick (or later ones) uses a lease-fresh leaderState — even
    // when the tick loop stalled mid-pause, the first tick after expiry
    // re-derives before poll/dispatch. Belt-and-braces guarantee that
    // the cooldown-exit path can never dispatch on stale leadership.
    ctx.cooldownUntil = null; // pause expired — resume normal polling
    ctx.errorStrikes = 0; // fresh strike counter after the pause
    ctx.activeAuditBatch = null; // no stale batch budget across a pause
  }
  return null;
}

/**
 * Poll the proxy and evaluate availability: per-slot routing, the
 * fail-closed `slots-unavailable`/`saturated` refusals, the
 * proxy-authoritative idle age (WL-0MVHSZR9C0012NQY), the launch-fence
 * observation and the idle/ready thresholds. Returns the tick result for a
 * refusing poll, otherwise the evidence the dispatch gates consume.
 */
export async function pollAndEvaluate(
  ctx: OrchestratorContext,
  cfg: OrchestratorConfig,
): Promise<OrchestratorTickResult | PollEvaluation> {
  if (ctx.opts.poller.isPolling()) return { polled: false, dispatched: false, idle: ctx.tracker.idleSince !== null };


  const status = await ctx.opts.poller.poll();
  if (status === null) {
    ctx.tracker.record(false); // endpoint failure/ambiguity → busy
    ctx.perSlotTracker.record([]); // fail-closed: ambiguous poll resets every slot timer
    ctx.activeAuditBatch = null; // an ambiguous poll ends the batch window
    ctx.launchWindow.observePoll({ idle: false }); // unusable poll → window over
    return { polled: true, dispatched: false, idle: false };
  }

  // Per-slot routing (LP-0MSG5TA7Y002GN39): when the proxy serves
  // per-slot identity AND the config asks for 0 < N < total, idle
  // duration is tracked PER SLOT so dispatch requires the SAME N slots
  // continuously free for the full threshold. The global gate in
  // per-slot mode is the per-slot-safe subset (server up + no model
  // switch): a query/lease tied to a busy slot is the operator's own
  // session and must not reset the free slots' timers (spare-capacity
  // dispatch, parent WL-0MT32F90V008UAD2). A slot reporting processing
  // resets only its own timer.
  const perSlotSlots = usablePerSlotSlots(status);
  // LIVE contention/gate-waiter depth (WL-0MU1DWXO600153OI): computed once
  // per poll for the decision entries, the idle-age activity check below
  // and the dispatch gate. The CUMULATIVE `contention_queued_count` is
  // telemetry only and never a gate.
  const contentionQueueDepth =
    typeof status.contention_queue_depth === 'number' ? status.contention_queue_depth : 0;
  // Prefill-gate contention evidence (WL-0MVHSZRZQ00482QX AC3): the
  // proxy's serialisation-gate queue depth. `> 0` is equivalent to a
  // non-empty `contention_queue_depth` for the pace/back-off decision
  // (and it feeds the idle-age activity check and reset below).
  const prefillGateWaiters =
    typeof status.prefill_gate_waiters === 'number' ? status.prefill_gate_waiters : 0;
  // Truthful-capacity evidence for every decision entry on this poll
  // (LP-0MVGDUVGE0024YAI). Computed once; purely observational.
  const capacity = capacityEvidence(status, perSlotSlots);
  // Fail-closed precondition (WL-0MUXVPXAZ005RESW): unusable per-slot
  // detail — absent, empty (`slots: []`), or stale (`slots_stale: true`)
  // — means there is NO trustworthy availability signal. Refuse to
  // dispatch and record the distinct `slots-unavailable` reason so the
  // stop is observable in the decision log and header (never fall back
  // to the count-based path). NOTE: a large `local_idle_seconds` must
  // never bypass this contract — the idle age qualifies DURATION only,
  // never availability (WL-0MVHSZR9C0012NQY AC5).
  if (perSlotSlots === null) {
    ctx.tracker.record(false);
    ctx.perSlotTracker.record([]); // fail-closed: reset every slot timer
    ctx.launchWindow.observePoll({ idle: false }); // no trustworthy window → fence releases
    void recordDecision(ctx, cfg.cwd, 'slots-unavailable', {
      freeSlots: 0,
      totalSlots: status.total_slots,
      ownerPresent: status.local_lease_active === true,
      runningPanes: null,
      contentionDepth: contentionQueueDepth,
      ...capacity,
      // AC5: a batch that was armed is blocked by this fail-closed poll —
      // attach its metadata, then end it (no batch survives an unusable
      // availability signal).
      ...batchMetadata(ctx),
    });
    ctx.activeAuditBatch = null;
    return { polled: true, dispatched: false, idle: false };
  }
  // Schema-v2 saturated pool (LP-0MVGDUVGE0024YAI AC4): a defensive
  // cross-check that never admits a dispatch, even when the per-slot
  // detail looks inconsistent. Distinct reason/token so it is
  // distinguishable from slot-owner / contention / no-slots.
  if (status.capacity_hint === 'saturated') {
    ctx.tracker.record(false);
    ctx.perSlotTracker.record([]); // saturated → reset every slot timer
    ctx.launchWindow.observePoll({ idle: false }); // saturated pool → no window
    void recordDecision(ctx, cfg.cwd, 'capacity-saturated', {
      freeSlots: countFreeUnownedSlots(perSlotSlots),
      totalSlots: status.total_slots,
      ownerPresent: status.local_lease_active === true,
      runningPanes: null,
      contentionDepth: contentionQueueDepth,
      ...capacity,
      ...batchMetadata(ctx),
    });
    ctx.activeAuditBatch = null;
    return { polled: true, dispatched: false, idle: false };
  }

  // ── Proxy-authoritative idle age (WL-0MVHSZR9C0012NQY) ──
  // When the proxy reports a usable `local_idle_seconds` it OWNS the
  // DURATION qualification: the GPU may already have been idle for hours
  // before this worker started polling (plugin/pane restart, resumed
  // session), so waiting for the local tracker to accumulate a fresh
  // threshold would leave the local model idle when it could be working.
  // Two hard limits keep this surgical and fail-closed:
  //   - it qualifies DURATION only — the per-slot availability budget,
  //     the fail-closed `slots-unavailable`/`saturated` paths and
  //     `requiredFreeSlots` are unchanged;
  //   - LIVE activity evidence on the same poll (busy/owned slot, coarse
  //     live lease, or a contention/gate waiter) always outranks it →
  //     fall back to the local tracker (a contradictory payload never
  //     admits a dispatch).
  // Absent/non-finite → `null`, i.e. today's behaviour exactly.
  const idleAgeSeconds = reportedIdleSeconds(status);
  const activityOnPoll = pollShowsLocalActivity(
    status,
    perSlotSlots,
    contentionQueueDepth + prefillGateWaiters,
  );
  const idleAgeAuthority = idleAgeSeconds !== null && !activityOnPoll;
  const idleAgeQualifies = idleAgeAuthority && idleAgeSeconds * 1000 >= cfg.thresholdMs;

  const perSlotMode =
    cfg.requiredFreeSlots > 0 &&
    cfg.requiredFreeSlots < status.total_slots;

  let idle: boolean;
  let ready: boolean;
  if (perSlotMode && perSlotSlots !== null) {
    const globalIdle = perSlotGlobalIdleChecks(status);
    // Display-only: the global idle tracker also reflects per-slot query
    // activity for the title bar idle indicator — when any slot is
    // processing (including the operator's), the title bar shows "busy",
    // not "idle". The dispatch logic (spare-capacity relaxation) is
    // unaffected because free-slot count comes from perSlotTracker, not
    // tracker.idleSince. (parent WL-0MT65T14L002HTWB)
    const anySlotProcessing = perSlotSlots.some(
      (s) => typeof s.is_processing === 'boolean' && s.is_processing,
    );
    ctx.tracker.record(globalIdle && !anySlotProcessing);
    if (globalIdle) {
      ctx.perSlotTracker.record(perSlotSlots);
      idle = true;
      if (idleAgeAuthority) {
        // The proxy's idle age satisfies the duration requirement, so the
        // CURRENT free/unowned-slot budget is the only remaining check —
        // `requiredFreeSlots` (capacity) is deliberately NOT relaxed.
        ready =
          idleAgeQualifies &&
          countFreeUnownedSlots(perSlotSlots) >= cfg.requiredFreeSlots;
      } else {
        ready =
          ctx.perSlotTracker.thresholdMetCount(cfg.thresholdMs) >= cfg.requiredFreeSlots;
      }
    } else {
      ctx.perSlotTracker.record([]); // global busy → reset every slot timer
      idle = false;
      ready = false;
    }
  } else {
    // Single global tracker (no per-slot data, or N ≤ 0 / N ≥ total):
    // unchanged all-slots-free behaviour (parent AC2 parity).
    idle = evaluateIdle(status, cfg.requiredFreeSlots);
    ctx.tracker.record(idle);
    ready = idle && (idleAgeAuthority
      ? idleAgeQualifies
      : ctx.tracker.isThresholdMet(cfg.thresholdMs));
  }

  // AC3/AC4: an idle-age poll that reports a live contention/gate waiter
  // resets the run immediately instead of carrying an older idle credit
  // into the next poll — the backend is already working off that queue.
  // Runs AFTER the branches so it can never be re-seeded by them. Scoped
  // to the idle-age signal so a pre-feature proxy keeps today's
  // contention behaviour byte-for-byte.
  if (idleAgeSeconds !== null && (contentionQueueDepth > 0 || prefillGateWaiters > 0)) {
    ctx.tracker.record(false);
    ctx.perSlotTracker.record([]);
    ctx.activeAuditBatch = null;
  }

  // One-per-idle-window launch fence observation (parent AC3, slice C3):
  // feed every usable poll so a launch recorded earlier in this window is
  // released as soon as the proxy's own in-flight counter shows it
  // registered (or the window ends / counters are no longer servable).
  ctx.launchWindow.observePoll({
    idle,
    inFlight: status.local_prefills_in_flight,
    cap: status.local_max_concurrent_prefills,
  });

  if (!idle) {
    ctx.activeAuditBatch = null; // busy poll ends the continuous idle window
    return { polled: true, dispatched: false, idle: false };
  }
  if (!ready) {
    // Idle-age observability (WL-0MVHSZR9C0012NQY AC7): an idle tick
    // deferred by the proxy's authoritative idle age records the evidence
    // at the existing rate limit (non-blocking — the header blocking
    // token still reflects refusals only) so "why did it not dispatch?"
    // is answerable from the decision log. Scoped to the idle-age
    // authority: a pre-feature proxy OR a poll with live activity keeps
    // today's silent deferral byte-for-byte.
    if (idleAgeAuthority && !idleAgeQualifies) {
      void recordDecision(
        ctx,
        cfg.cwd,
        'idle-age-pending',
        {
          freeSlots: countFreeUnownedSlots(perSlotSlots),
          totalSlots: status.total_slots,
          ownerPresent: status.local_lease_active === true,
          runningPanes: null,
          contentionDepth: contentionQueueDepth,
          ...capacity,
        },
        { blocking: false },
      );
    }
    return { polled: true, dispatched: false, idle: true };
  }
  if (ctx.dispatching) return { polled: true, dispatched: false, idle: true };
  // Idle-age observability (AC7): when the proxy's elapsed idle age is
  // what admitted this poll, record it (non-blocking) so an admitted
  // dispatch carries the age/source evidence too. Rate-limited, so a
  // long idle window logs this at most once per interval.
  if (idleAgeAuthority && idleAgeQualifies) {
    void recordDecision(
      ctx,
      cfg.cwd,
      'idle-age-qualified',
      {
        freeSlots: countFreeUnownedSlots(perSlotSlots),
        totalSlots: status.total_slots,
        ownerPresent: status.local_lease_active === true,
        runningPanes: null,
        contentionDepth: contentionQueueDepth,
        ...capacity,
      },
      { blocking: false },
    );
  }

  return {
    status,
    perSlotSlots,
    contentionQueueDepth,
    prefillGateWaiters,
    capacity,
  };
}

/**
 * Drive one tick of the downtime worker (the object returned by
 * `createDowntimeWorker` delegates here). Phase order is significant and
 * unchanged: gates → leader/check-in → pane maintenance → cooldown →
 * poll/evaluate → dispatch admission → dispatch attempt.
 */
export async function runOrchestratorTick(
  ctx: OrchestratorContext,
): Promise<OrchestratorTickResult> {
  const cfg = ctx.opts.config();
  // Capacity-starvation tracking (WL-0MVKNC2N50025HXE AC3): the window and
  // the long-running progress window are re-read from settings every tick,
  // so an operator change applies live without a plugin restart.
  ctx.starvationTracker.configure(
    cfg.capacityStarvationAlertMs ?? DEFAULT_DOWNTIME_CAPACITY_STARVATION_ALERT_MS,
  );
  ctx.longRunningThresholdMs =
    cfg.longRunningThresholdMs ?? DEFAULT_DOWNTIME_LONG_RUNNING_THRESHOLD_MS;
  // Fresh per-tick decision state: clear the header blocking reason; a
  // gate below re-sets it when this tick is refused (WL-0MU8808ZY0091JIA).
  ctx.blockReason = null;
  const enabledGate = applyEnabledGates(ctx, cfg);
  if (enabledGate !== null) return enabledGate;
  const leader = await runLeaderElectionAndCheckIn(ctx, cfg);
  if (leader.stop !== null) return leader.stop;
  runPaneMaintenance(ctx, cfg, leader.tickNow);
  const cooldownGate = applyCooldownGate(ctx);
  if (cooldownGate !== null) return cooldownGate;
  const evaluated = await pollAndEvaluate(ctx, cfg);
  if ('polled' in evaluated) return evaluated;
  const admitted = await admitDispatch(ctx, cfg, evaluated);
  if ('polled' in admitted) return admitted;
  const outcome = await performDispatch(ctx, cfg, evaluated, admitted);
  return { polled: true, dispatched: outcome.dispatched, idle: true };
}
