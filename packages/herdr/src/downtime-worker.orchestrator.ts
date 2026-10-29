/**
 * packages/herdr/src/downtime-worker.orchestrator.ts — the downtime worker
 * factory.
 *
 * Single responsibility: construct one worker instance — build its explicit
 * shared state (`buildOrchestratorContext`) and return the `DowntimeWorker`
 * handle whose getters/methods expose that state and whose `tick()` delegates
 * to the tick state machine (`downtime-worker.orchestrator-tick.ts`).
 *
 * Extracted from `downtime-worker.ts` by WL-0MVLII2080074S5L (extract the
 * downtime-worker orchestrator modules). `createDowntimeWorker` keeps its
 * exact exported signature and the returned object keeps every property,
 * getter and method with identical observable behaviour; the closure locals
 * became the explicit `OrchestratorContext` fields the tick phases take as
 * their first argument (plan option A). No logic change.
 *
 * Parent: WL-0MVF3F9A7000HKP7 (decompose the `downtime-worker.ts` god class).
 */

import { CapacityStarvationTracker } from './capacity-starvation.js';
import {
  disableMarkerExists,
  removeDisableMarker,
  writeDisableMarker,
} from './downtime-disable-marker.js';
import { createLeaderElectionManager } from './leader-election.js';
import {
  DEFAULT_COORDINATION_CHECK_IN_MS,
  DEFAULT_DOWNTIME_LONG_RUNNING_THRESHOLD_MS,
  DEFAULT_LEADER_CHECK_IN_MS,
} from './downtime-worker.constants.js';
import { createIdleTracker, createPerSlotIdleTracker } from './downtime-worker.idle.js';
import { createIdleWindowLaunchFence } from './downtime-worker.launch-fence.js';
import { runOrchestratorTick } from './downtime-worker.orchestrator-tick.js';
import type {
  OrchestratorContext,
  OrchestratorTickResult,
} from './downtime-worker.orchestrator-dispatch.js';
import type {
  DowntimeWorker,
  DowntimeWorkerConfig,
} from './downtime-worker.worker-contract.js';

// ── Worker orchestrator (implemented — F3) ────────────────────────────

/**
 * Build the explicit shared state of one worker instance: the trackers, the
 * launch fence, the leader-election manager and every mutable field the tick
 * phases read and write. Each field keeps the rationale comment it carried as
 * a `createDowntimeWorker` closure local.
 */
export function buildOrchestratorContext(opts: DowntimeWorkerConfig): OrchestratorContext {
  const markerDisabled =
    opts.override === undefined && disableMarkerExists(opts.config().cwd);

  // ── Leader-election + coordination state (parent WL-0MST3OJ8S0001ROL) ──
  // One leader-election manager per worker (per process): the instance id
  // is fixed at construction so the lease file owner and the coordination
  // entry key stay stable for the process lifetime. The manager owns the
  // file lock/lease at `<coordinationDir>/downtime-leader.lock` +
  // `downtime-leader-lease.json`. When `coordinationDir` is ABSENT the
  // worker runs the legacy flow (self is always the leader — no election)
  // so existing non-coordination configurations/tests keep working
  // unchanged (fail-open).
  const leaderManager = opts.coordinationDir
    ? createLeaderElectionManager({
        worklogDir: opts.coordinationDir,
        instanceId: opts.instanceId,
        leaseTtlSeconds: opts.leaseTtlSeconds,
      })
    : null;
  const instanceId = leaderManager ? leaderManager.getInstanceId() : (opts.instanceId ?? 'legacy');
  const DOWNTIME_CHECK_IN_FLOOR_MS = 60_000;
  const _rawCheckInMs = opts.checkInIntervalMs ?? DEFAULT_COORDINATION_CHECK_IN_MS;
  const checkInIntervalMs = Math.max(_rawCheckInMs, DOWNTIME_CHECK_IN_FLOOR_MS);
  const _rawLeaderMs =
    (opts as { leaderCheckInIntervalMs?: number }).leaderCheckInIntervalMs
      ?? DEFAULT_LEADER_CHECK_IN_MS;
  const leaderCheckInMs = Math.max(_rawLeaderMs, DOWNTIME_CHECK_IN_FLOOR_MS);

  return {
    opts,
    leaderManager,
    instanceId,
    checkInIntervalMs,
    leaderCheckInMs,
    tracker: createIdleTracker(),
    perSlotTracker: createPerSlotIdleTracker(),
    dispatching: false,
    lastDispatchAt: null,
    // Depth-aware audit-batch continuation state (parent WL-0MVEDM8OT007WDRS
    // AC1/AC2/AC3/AC5): the continuation audits still available in the CURRENT
    // continuous idle window plus the depth/cap they were measured against.
    // `null` = no batch armed (legacy single-dispatch behaviour). Armed only by
    // a successful AUDIT dispatch whose outcome reports an active batch with
    // budget remaining; cleared on the cap, a depth drop, a non-audit dispatch,
    // ANY non-`dispatched` outcome, a busy or unavailable poll, a pause/
    // cooldown, leadership loss, or a disabled worker. Keeping depth/cap here
    // (not just the budget) lets every blocked/ended batch decision carry the
    // `auditBatchDepth`/`auditBatchCap`/`auditBatchRemaining` diagnostics.
    //
    // Trade-off (AC2): only this dispatcher's OWN post-dispatch reset is
    // deferred. The dispatched audit pane's occupancy still makes the proxy
    // busy, which (a) resets the idle tracker through the normal per-tick
    // busy path and (b) ends the batch window (a busy poll closes the
    // continuous idle window, `activeAuditBatch` is cleared below on every
    // non-idle poll). A continuation therefore only fires while the proxy
    // stays idle at the next poll; after any busy interlude the worker
    // requires a fresh full idle period and the next audit dispatch re-arms
    // a fresh batch while the queue is still deep. Batching is a queue-drain
    // optimisation, never a relaxation of the idle-duration gate.
    activeAuditBatch: null,
    // Pane-lifecycle monitor cadence gate (WL-0MU308WSF0002JWN): the timestamp
    // of the last monitor pass. 0 forces a pass on the first tick.
    lastPaneMonitorAt: 0,
    // Pane-close reaper cadence gate (WL-0MUJL1NAH0042GOS): timestamp of the
    // last scheduled reaper pass. 0 forces a pass on the first tick.
    lastPaneCloseReaperAt: 0,
    // No-candidate cooldown (WL-0MSI7DQL10016QYX): timestamp until which the
    // worker is fully paused (no poll, no idle tracking, no dispatch) after a
    // genuine empty backlog OR three consecutive CLI errors. Cancelled early
    // when a coordination check-in re-offers a fresh item
    // (WL-0MTEZ4XZJ006Y9U7). null = not paused.
    cooldownUntil: null,
    // Three-strike rule: consecutive CLI-error dispatch outcomes. A successful
    // dispatch, a genuine no-candidate outcome, or an expired cooldown resets it.
    errorStrikes: 0,
    // No-dispatch decision logging (WL-0MU8808ZY0091JIA): the last reason
    // written and when, so repeated identical refusals are rate-limited.
    lastDecisionReason: null,
    lastDecisionAt: 0,
    // Continuous capacity-starvation tracking (WL-0MVKNC2N50025HXE AC3): a run
    // of capacity-flagged refusals is an episode; once it has lasted the
    // configured window a `capacity-starved` observation is written ONCE per
    // window so a silent all-night NOP becomes diagnosable. Observation only —
    // it never gates dispatch, never strikes and never replaces the refusal
    // reason/header token. Reset by any non-capacity outcome and by a
    // successful dispatch.
    starvationTracker: new CapacityStarvationTracker(),
    // Long-running pane progress window (AC2), re-read from settings every tick
    // and used only to annotate a starvation signal.
    longRunningThresholdMs: DEFAULT_DOWNTIME_LONG_RUNNING_THRESHOLD_MS,
    // Current header blocking token; null when not gate-blocked. Reset each tick.
    blockReason: null,
    // One-per-idle-window launch fence (parent WL-0MVIKRFP0005JDL8, slice C3):
    // holds once the instance launches a ticket-backed pane and releases only
    // when a fresh observation shows the launched prefill registered. This is
    // per-instance state — the proxy's atomic reservation is the cross-instance
    // arbiter (slice C2); the fence closes the STALE-STATUS same-instance window
    // (a permissive proxy granting N tickets against unchanged headroom).
    launchWindow: createIdleWindowLaunchFence(),
    // Per-instance in-memory enabled override (parent WL-0MSZ4NSOE007AQEF):
    // null (default) = follow the global setting; true/false force dispatch
    // on/off for THIS instance. In-memory only — resets on plugin restart,
    // never written to the shared settings file. Initialized from the optional
    // config so callers can construct a pre-toggled worker.
    override: markerDisabled ? false : (opts.override ?? null),
    // Durable disable (WL-0MT5SFP990001FNW): when the per-worklog-root marker
    // exists, the worker starts disabled so a previous `d` press survives a
    // restart. Explicit opts.override wins over the marker (marker is only the
    // fallback when no override is passed).
    restoredFromMarker: markerDisabled,
    // Timestamp of the last coordination check-in (WL-0MTMPSCL8000O45H —
    // default 5-min cadence, parent AC3). null until the first tick so every
    // instance checks in on startup (first check-in on startup — parent
    // Constraint).
    lastCheckInAt: null,
    // WL-0MTMPSCL8000O45H AC2 — churn guard: true when the LAST
    // runCoordinationCheckIn offered nothing (genuine empty backlog). While
    // true the immediate re-offer is suppressed (re-probing an empty worklog
    // every ~10 s tick would churn wl); the periodic cadence retries until
    // work appears and an offer lands.
    lastOfferEmpty: false,
    // Per-tick cached leadership decision (the lease read is cheap but let a
    // tick observe ONE consistent state — an election win mid-tick applies
    // next tick). Legacy mode (no coordinationDir) is always the leader.
    leaderState: leaderManager ? leaderManager.isLeader() : true,
  };
}


/**
 * Compose poller + idle evaluation + tracker + dispatch into the per-tick
 * worker the scheduler loop (F4) registers as a due-work task.
 */
export function createDowntimeWorker(opts: DowntimeWorkerConfig): DowntimeWorker {
  const ctx = buildOrchestratorContext(opts);

  return {
    get idleSince(): number | null {
      return ctx.tracker.idleSince;
    },
    get dispatching(): boolean {
      return ctx.dispatching;
    },
    get lastDispatchAt(): number | null {
      return ctx.lastDispatchAt;
    },
    get isLeader(): boolean {
      return ctx.leaderState;
    },
    get instanceId(): string {
      return ctx.instanceId;
    },
    get enabled(): boolean {
      // Effective enabled = override ?? cfg.enabled: the per-instance
      // override takes precedence when set (so `d` can force dispatch on
      // for one pane even when the global setting is off); with no override
      // the worker follows the global setting exactly as before.
      return ctx.override ?? ctx.opts.config().enabled;
    },
    get override(): boolean | null {
      return ctx.override;
    },
    get restoredFromMarker(): boolean {
      return ctx.restoredFromMarker;
    },
    toggle(): void {
      // null → false → null cycle: pressing `d` disables dispatch;
      // pressing again returns to following the global setting.
      // No force-enable: a second press never sets override to true.
      // The per-worklog-root marker (WL-0MT5SFP990001FNW) is written on
      // disable and removed on re-enable so the disable survives restarts.
      // A live press (or an explicit re-enable) clears the restored flag so
      // the header notice only reflects the marker-restored state.
      if (ctx.override === null) {
        ctx.override = false;
        ctx.restoredFromMarker = false;
        writeDisableMarker(ctx.opts.config().cwd);
      } else {
        ctx.override = null;
        ctx.restoredFromMarker = false;
        removeDisableMarker(ctx.opts.config().cwd);
      }
    },
    jitterPollIntervalMs(baseIntervalMs: number): number {
      // Fail-open: no registry → static interval (no jitter).
      return ctx.opts.registry
        ? ctx.opts.registry.getEffectivePollInterval(baseIntervalMs)
        : baseIntervalMs;
    },
    get paused(): boolean {
      return ctx.cooldownUntil !== null && Date.now() < ctx.cooldownUntil;
    },
    get errorStrikes(): number {
      return ctx.errorStrikes;
    },
    get blockReason(): string | null {
      return ctx.blockReason;
    },

    async tick(): Promise<OrchestratorTickResult> {
      return runOrchestratorTick(ctx);
    },
  };
}
