/**
 * packages/herdr/src/downtime-worker.ts — Local-LLM downtime worker (contract)
 *
 * Test-first contract for the herdr downtime worker (parent
 * WL-0MSF49FMW009M06K). Implemented in F1 (tests + fixtures), F2 (settings
 * clamps, poller, parsing, runtime idle evaluation) and F3 (idle tracker,
 * dispatch orchestration, pane spawn):
 *
 *  - `isIdleStatus` — idle detection from a `/llama/local/status` payload.
 *  - `evaluateIdle` — runtime idle evaluation with the fail-closed
 *    degradation for a configured N < total slots (no per-slot data yet) and
 *    the spare-capacity per-slot mode (relaxed global gate, parent
 *    WL-0MT32F90V008UAD2).
 *  - `parseLlamaStatus` / `fetchLocalStatus` / `createDowntimePoller` — the
 *    single-flight poller for `GET {proxyUrl}/llama/local/status` with
 *    per-poll timeout and fail-closed parsing.
 *  - `createIdleTracker` — continuous idle-duration tracker (idleSince vs
 *    threshold).
 *  - `dispatchDowntimeWork` — Herdr-list-head dispatch (WL-0MTK1ILM2009QYB2): consumes the Herdr selection list head
 *    (`deps.getHerdrListHead` = fetcher → smart-selection → grouping, the sole ranking path) and applies
 *    every remaining safety gate as a sequential FILTER on that ordered sequence (scheduled prompt first,
 *    then code-freeze, dispatched-marker, free-slot minimums, active-audit single-flight (per-worklog
 *    AND host-wide machine marker, WL-0MUIVE0YG000UVIA — reason 'audit-host-saturated'), freshness/recency,
 *    pre-dispatch CAS claim + per-process single-flight, then spawn). No second ranking implementation remains
 *    on the dispatch path (AC1–2). The former audit/implement/plan/intake tier ordering is retired.
 *    Code-freeze gate
 *    (WL-0MSQ0RPQP00636JY): the ship-it marker is re-read fresh on every
 *    dispatch; while frozen OR ambiguous (fail-closed) the audit and
 *    implement tiers are skipped (no new implementations/audits during a
 *    release) and plan/intake still dispatch; an empty plan/intake backlog
 *    during a freeze reports reason 'code-freeze' (never 'no-candidate'),
 *    so the freeze never triggers the no-candidate cooldown and dispatch
 *    resumes immediately when it lifts. The audit tier
 *    additionally excludes items the downtime worker has already dispatched
 *    for `/skill:audit` (durable dispatched-marker exclusion,
 *    WL-0MSLIY8ZR004QUSY) unless a fresh audit exists since, closing the
 *    re-selection loop where a dispatched run reverts the item to
 *    completed/in_review without recording a fresh audit. Every tier
 *    additionally excludes items with `needsProducerReview === true`
 *    (parent WL-0MTIAL65N004T22F): items flagged for producer review are
 *    never auto-dispatched, preventing the worker from consuming local
 *    slots on items awaiting a human decision.
 *    A NON-TERMINAL pane-close cooldown (WL-0MUKYERLZ006ELL5) is applied as
 *    a sequential filter after the dispatched-marker exclusion and before
 *    the code-freeze gate: an item whose previous pane of the SAME kind
 *    closed without reaching a terminal stage (`agent-ended-no-terminal`,
 *    `audit-ended-no-result`, ...) is skipped until
 *    `downtimeNonTerminalCooldownMs` has elapsed, or the item advances past
 *    its dispatched-at stage. It is neutral — never a strike, never
 *    `no-candidate` (distinct reason `non-terminal-cooldown`) — so it never
 *    enters the no-candidate cooldown; the same filter is applied on the
 *    coordination offer path (`computeMostImportantItem` /
 *    `dispatchFromCoordination`). A tier-2 CLI error does
 *    NOT short-circuit: the idea tier is still attempted so a tier-3
 *    candidate can still dispatch.
 *    `wl next` failures are reported as `{ok:false}` (fail closed to busy)
 *    and are never mistaken for an empty backlog; three consecutive error
 *    outcomes pause the worker entirely after logging the persistent error
 *    via `deps.recordError` (three-strike rule, `DOWNTIME_ERROR_STRIKE_LIMIT`).
 *  - `dispatchFromCoordination` / `computeMostImportantItem` — the
 *    coordination leader + check-in (WL-0MTK1ILM2009QYB2 F3): the shared
 *    coordination file holds one OFFER per instance — its own Herdr list
 *    head (computed at the check-in by `computeMostImportantItem` over
 *    `deps.getHerdrListHead` with the same sequential filters). The leader
 *    dispatches offers in FILE ORDER, re-validating each at dispatch time
 *    (`fetchItem` → `classifyItemForDispatch` as filters). The cross-root
 *    tier priority / critical override / round-robin cursor ordering are
 *    RETIRED (no second ranking on the dispatch path, AC1–2).
 *  - `buildDowntimePaneArgs` / `spawnDowntimePane` — send-to-pi.sh
 *    invocation (`--pane-name Downtime <kind>`, `--no-focus`, `--cwd`,
 *    `--model`), detached and unref'd; `error`/`exit` handlers capture a
 *    spawn failure or non-zero script exit so a failed pane is never
 *    logged as a successful dispatch (WL-0MSLWJ3I70031Z8U).
 *    `buildDowntimeSpawnOptions` bounds the dispatched audit fan-out:
 *    `AUDIT_PHASE2_PARALLELISM=1` makes the audit skill's Phase 2 child
 *    deep-analysis strictly sequential so a parent audit needs exactly
 *    2 local slots (parent + one child).
 *    (original bound WL-0MSORQ1RG005DGUS; serialisation fixed by
 *    WL-0MVE1NZ4J000H5NH). Dispatcher anchor (C0 WL-0MTR01EU7005SYZG):
 *    pane placement (WL-0MU321YK70035AYT): the worklog dispatch path resolves
 *    the candidate's project workspace from its worklog root
 *    (`deps.resolveProjectWorkspace` — the herdr plugin pane whose logical
 *    root equals `opts.cwd`), ensures/reuses a tab labelled with the exact
 *    work-item id (`deps.getItemTabAnchor`), and forwards that tab's root
 *    pane as `--anchor <id>` so send-to-pi.sh splits from THAT pane. Each
 *    project's automated panes therefore land in the project's own workspace
 *    grouped per item — the PRIMARY path. When no plugin pane resolves, the
 *    path falls back to the per-prefix tab in the Dispatcher workspace
 *    (`deps.getDispatcherTabAnchor`, C1 WL-0MTRQT482001SNXC), then to the
 *    retained machine-wide Dispatcher anchor (`deps.getDispatcherAnchor`,
 *    C0 WL-0MTR01EU7005SYZG). Anchor provisioning failure degrades to reason
 *    'anchor-unavailable' (neutral "no dispatch this cycle", never a fallback
 *    to the leader's pane). Scheduled-prompt spawns keep the Dispatcher
 *    anchor (no work-item id).
 *  - `createDowntimeWorker` — per-tick orchestrator (poll → evaluate →
 *    track → dispatch) with settings re-read each tick, plus the
 *    no-candidate cooldown (WL-0MSI7DQL10016QYX): a genuine empty backlog
 *    in both stages pauses the worker entirely for
 *    `downtimeNoCandidateCooldownMs` (default 60 min) — no poll, no idle
 *    tracking, no dispatch — and resets the idle tracker so a fresh full
 *    idle period is required after the pause. Transient `wl` errors and the
 *    in-flight dispatch guard never trigger the cooldown; three consecutive
 *    CLI-error outcomes do (three-strike rule), after logging the
 *    persistent error via `deps.recordError`. In coordination mode
 *    (WL-0MTEZ4XZJ006Y9U7) an empty coordination file is an OFFER LIST,
 *    not the backlog: the leader removes each entry after dispatching, so
 *    an empty file is a transient gap — the tick probes the worklog
 *    (`computeMostImportantItem`) before pausing and only a genuinely
 *    empty backlog pauses (a probe CLI error is itself a three-strike
 *    event, never a silent pause). The cooldown gate runs AFTER the
 *    leader-election/check-in block so the check-in (the only
 *    re-offer mechanism) still lands during a pause, and a successful
 *    re-offer (`checkIn.updated && offered !== null`) cancels the pause
 *    immediately.
 *  - `buildDowntimePrompt` / `BLOCKED_QUESTIONS_INSTRUCTION` — dispatched
 *    agent prompt, including the blocked-questions instruction.
 *  - `clampDowntimePollInterval` / `clampDowntimeIdleThresholdMs` /
 *    `clampDowntimeRequiredFreeSlots` / `clampDowntimeNoCandidateCooldownMs` /
 *    `clampDowntimeMarkerStaleWindowMs` (WL-0MU6UL0RJ008IHGT) /
 *    `clampDowntimeAuditBatchMax` (parent WL-0MVEDM8OT007WDRS AC1: the
 *    depth-aware audit-batch cap, default 2, clamped to 1–5, `1` = off)
 *    — settings clamps, wired into `settings.ts`.
 *  - `selectWithRotation` (WL-0MSSRED76008LGB6) — rotation-aware selection:
 *    within each tier, candidates sharing the same priority level are
 *    rotated round-robin via the shared durable cursor
 *    (`.worklog/downtime-round-robin.json`, `downtime-round-robin.ts`);
 *    fail-open — no registry / no priority → pre-rotation sortIndex order.
 *  - `jitterPollIntervalMs` (WL-0MSSRED76008LGB6) — probe jitter: the
 *    effective poll interval is jittered ±50% of
 *    `downtimePollIntervalMs` per reschedule so instances do not probe in
 *    lockstep; fail-open without a registry → static interval.
 *
 * Fail-closed behaviour (never dispatch, never throw) is the SAFE default
 * at every boundary.
 *
 * ## Module layout (WL-0MVLII0NO007JJBA)
 *
 * This file is the barrel: it re-exports the decomposed family and keeps the
 * worker orchestrator, the coordination dispatch and the injected deps
 * contract until the later split children land. The dispatch pipeline itself
 * is decomposed into `downtime-worker.dispatch.ts` (entry + the single
 * `dispatchInFlightCount`), `downtime-worker.dispatch-filter.ts` (Herdr
 * list-head filters), `downtime-worker.dispatch-claims.ts` (claim → marker →
 * spawn), `downtime-worker.dispatch-cpu-gate.ts`,
 * `downtime-worker.local-reservation.ts`, `downtime-worker.stalled-resume.ts`
 * and `downtime-worker.prompts.ts`.
 */

import { DEFAULT_BROWSE_ITEM_COUNT, resolveSprintViewWindow } from './browse-window.js';
import type { CodeFreezeStatus } from './code-freeze.js';
import {
  DEFAULT_DOWNTIME_CPU_GATE_PERCENT,
  type HostCpuReading,
} from './host-cpu.js';
import { disableMarkerExists, removeDisableMarker, writeDisableMarker } from './downtime-disable-marker.js';
import type { ScheduledPrompt } from './scheduled-prompts.js';
import type { RoundRobinRegistry } from './downtime-round-robin.js';
import { LOCAL_PREFERENCE_ENV_VAR, type LocalPreference } from './local-preference.js';

/**
 * Re-exported for the dispatch tests: the pane-launch env var carrying the
 * per-turn locality preference (canonical definition in
 * `./local-preference.ts`).
 */
export { LOCAL_PREFERENCE_ENV_VAR };
import {
  readCoordinationFile,
  getEntry,
  upsertEntry,
  removeEntry,
  type CoordinationEntry,
} from './coordination.js';
import { selectLeastRecentlyServed } from './downtime-round-robin-by-root.js';
import {
  createLeaderElectionManager,
  cleanupStaleElection,
  DEFAULT_LEASE_TTL_SECONDS,
} from './leader-election.js';
import { appendCoordinationLogEntry, type CoordinationLogEntry } from './downtime-log.js';
import {
  CapacityStarvationTracker,
  DEFAULT_DOWNTIME_CAPACITY_STARVATION_ALERT_MS,
  type CapacityStarvationObservation,
} from './capacity-starvation.js';
import type {
  LongRunningPaneObservation,
  LongRunningScanOptions,
} from './long-running-panes.js';
import {
  readDowntimeLogEntries as _readDowntimeEntries,
  dispatchedItemMarkers as _dispatchedMarkers,
  markerStillExcludes as _markerStillExcludes,
  isNonTerminalCooldownActive as _isNonTerminalCooldownActive,
  type DispatchMarker,
  type DowntimeLogEntry,
  type PaneCloseLogEntry,
  type PaneLifecycleKind,
} from './downtime-log.js';
import type { PaneItemState } from './pane-lifecycle.js';
import { paneCloseReaperDue } from './pane-close-scheduler.js';
import type {
  StalledPaneCandidate,
  StalledResumeOutcome,
  StalledScanOptions,
} from './stalled-work.js';
import type {
  DispatcherAnchor,
  DispatcherPrefixTabAnchor,
  ItemTabAnchor,
  ProjectWorkspaceTarget,
} from './dispatcher-anchor.js';

export type { ScheduledPrompt } from './scheduled-prompts.js';
export type { CoordinationEntry } from './coordination.js';

// ── Re-exports for moved constants/types/clamps ─────────────────
export * from './downtime-worker.constants.js';
export * from './downtime-worker.types.js';
export * from './downtime-worker.clamps.js';
export * from './downtime-worker.parsers.js';
export * from './downtime-worker.selection.js';
export * from './downtime-worker.idle.js';
export * from './downtime-worker.poller.js';
export * from './downtime-worker.pane.js';
export * from './downtime-worker.gates.js';
export * from './downtime-worker.prompts.js';
// Dispatch-pipeline modules (WL-0MVLII0NO007JJBA). The filter and the claim
// pipeline are internal to the dispatch entry, so they are NOT re-exported
// wholesale (Q2 refinement: only consumer-used symbols are public); the
// critical-first selector is consumer-used and keeps its barrel export.
export { selectCriticalFirstCandidates, type CriticalFirstCandidate } from './downtime-worker.dispatch-filter.js';
export * from './downtime-worker.dispatch-cpu-gate.js';
export * from './downtime-worker.local-reservation.js';
export * from './downtime-worker.stalled-resume.js';
export * from './downtime-worker.dispatch-contract.js';
export { dispatchDowntimeWork } from './downtime-worker.dispatch.js';

// Dispatch-pipeline symbols the remaining monolith still calls directly (the
// coordination paths reuse the claim pipeline and the scheduled-prompt tier;
// the orchestrator calls the dispatch entry). Extracted modules are always
// imported as concrete siblings — never through the barrel.
import {
  CPU_SATURATED_REASON,
  hostCpuGateEvidence,
  resolveCpuGate,
} from './downtime-worker.dispatch-cpu-gate.js';
import {
  STALLED_RESUME_REASON,
  resumeStalledWorkIfAble,
} from './downtime-worker.stalled-resume.js';
import { selectCriticalFirstCandidates } from './downtime-worker.dispatch-filter.js';
import {
  dispatchClaimedTier,
  dispatchScheduledPrompt,
} from './downtime-worker.dispatch-claims.js';
import { dispatchDowntimeWork } from './downtime-worker.dispatch.js';
import type {
  DowntimeDispatchEnrichmentEvent,
  DowntimeDispatchEvent,
  DowntimeDispatchFailureEvent,
  DowntimeDispatchOutcome,
  DowntimeErrorEvent,
} from './downtime-worker.dispatch-contract.js';

// Pane symbols the remaining monolith still calls directly (the dispatch loops'
// in-flight guard, the orchestrator's monitor pass and its warn helpers).
import {
  monitorDispatchedPanes,
  paneLifecycleErrMsg,
  paneLifecycleWarn,
  resolveInFlightPanes,
  type DowntimeSpawnResult,
} from './downtime-worker.pane.js';

// Dispatch-gate symbols the remaining monolith still calls directly (the
// list-head filters, the coordination classifier and the audit-batch surface).
// The gates module owns its sections wholesale and, like every extracted
// module, is imported as a concrete sibling — never through the barrel.
import {
  REVIEW_QUEUE_HOLD_REASON,
  classifyItemForDispatch,
  computeAuditEligibleDepth,
  evaluateCriticalFirstGuard,
  fetchExtendedHerdrItems,
  finalizeAuditBatchOutcome,
  flagBudgetExhausted,
  isAttemptBudgetExhausted,
  isImplementHeldByReviewGate,
  readReviewQueueGate,
  type ReviewQueueGateResult,
} from './downtime-worker.gates.js';

// Idle/poller symbols the remaining monolith still calls directly. The two
// modules own their sections wholesale; everything below is a normal sibling
// import (never a barrel self-import), so the layering stays acyclic. The
// three helpers are module-internal co-ordinates of the idle evaluation
// (exported by idle.ts for the orchestrator tick, not public API).
import {
  countFreeUnownedSlots,
  createIdleTracker,
  createPerSlotIdleTracker,
  evaluateIdle,
  evaluatePrefillPacing,
  perSlotGlobalIdleChecks,
  pollShowsLocalActivity,
  usablePerSlotSlots
} from './downtime-worker.idle.js';
import {
  COORDINATION_TIER_ORDER,
  DEFAULT_COORDINATION_CHECK_IN_MS,
  DEFAULT_DOWNTIME_AUDIT_BATCH_MAX,
  DEFAULT_DOWNTIME_LONG_RUNNING_THRESHOLD_MS,
  DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS,
  DEFAULT_DOWNTIME_MAX_ATTEMPTS,
  DEFAULT_DOWNTIME_NON_TERMINAL_COOLDOWN_MS,
  DEFAULT_DOWNTIME_STALL_THRESHOLD_MS,
  DEFAULT_LEADER_CHECK_IN_MS,
    DOWNTIME_AUDIT_MIN_FREE_SLOTS,
    DOWNTIME_DECISION_LOG_MIN_INTERVAL_MS,
  DOWNTIME_ERROR_STRIKE_LIMIT,
  DOWNTIME_PANE_LIFECYCLE_INTERVAL_MS,
  DOWNTIME_PANE_MIN_FREE_SLOTS,
  DOWNTIME_WL_TIMEOUT_MS,
  capacityEvidence,
    PANE_LIFECYCLE_MONITOR_ENABLED,
  decisionHeaderToken,
  reportedIdleSeconds
} from './downtime-worker.constants.js';
import type {
  CoordinationTierKind,
  DecisionEntryFields
} from './downtime-worker.constants.js';

import type {
  DowntimeActiveAuditResult,
  DowntimeCandidate,
  DowntimeClaimExpected,
  DowntimeClaimResult,
    DowntimeHerdrItem,
  DowntimeHerdrListResult,
  DowntimeItemInfo,
  DowntimeItemResult,
  DowntimeNextResult,
  DowntimePoller,
  DowntimeSkillKind,
  DowntimeStage,
  IdleWindowLaunchFence,
  IdleWindowLaunchObservation,
  IdleWindowLaunchVerdict,
  InFlightPanes,
  LocalReservationRequest,
  LocalReservationResult,
  MostImportantItemResult,
  RunningPanesResult
} from './downtime-worker.types.js';

import { clampDowntimeAuditBatchMax } from './downtime-worker.clamps.js';

// ── Idle-window launch fence (parent WL-0MVIKRFP0005JDL8, slice C3) ──
//
// One-per-idle-window reservation race guard, client side. The proxy's
// atomic reservation (slice C2) already arbitrates CROSS-instance: two
// instances asking for a ticket in the same idle window get exactly one
// grant between them, and the loser defers with the refusal evidence. This
// fence closes the residual same-instance window in which a *granted*
// launch could be followed by ANOTHER granted launch before the proxy's
// own status catches up:
//
//   - a fresh launch takes seconds to boot pi and start its prefill, so
//     `local_prefills_in_flight` can still report the pre-launch headroom
//     on the next few polls;
//   - without a fence, a permissive proxy (grants N tickets for N slots —
//     the slice's recorded risky assumption) would grant a second ticket
//     against that stale headroom and herdr would launch a second pane in
//     the same idle window;
//   - the guard therefore treats an idle window as SPENT once this instance
//     launches a ticket-backed pane, and refuses further launches until a
//     fresh observation shows the launched prefill REGISTERED
//     (`local_prefills_in_flight` advanced past the admission value) and
//     headroom returned (`in_flight < cap`). The AC2 test drives exactly
//     this: launch → stale in_flight (fence holds, no spawn) → in_flight
//     advances (registered, fence clear) → headroom + a NEW ticket → the
//     second launch is admitted with its own ticket.
//
// Fail-open by construction: when the proxy does not serve the prefill
// counters (older proxy), or `cap` is 0/absent (unbounded), the fence can
// never be evaluated and stays inert — today's behaviour byte-for-byte. A
// launch it can never confirm (crash / remote fallback) is reported as
// registered after a bounded grace so a dead pane cannot wedge the
// dispatcher. It never admits a dispatch the per-slot / saturated / prefill
// gates would refuse (AC5) — it only ever adds refusals, never a grant.

/**
 * Bounded grace after a launch before the fence self-releases even without
 * observed registration. Covers a pane that was granted a ticket but died
 * before ever prefilling (crash / remote fallback) — the fence must never
 * wedge the worker on an admit it can never observe.
 */
export const DEFAULT_LAUNCH_CONFIRMATION_GRACE_MS = 5 * 60_000;


/** Create a per-worker {@link IdleWindowLaunchFence}. */
export function createIdleWindowLaunchFence(
  graceMs: number = DEFAULT_LAUNCH_CONFIRMATION_GRACE_MS,
): IdleWindowLaunchFence {
  // Admission snapshot: the last usable `local_prefills_in_flight` a launch
  // decision was based on. A launch is registered once a later poll reports a
  // STRICTLY greater count (the launched pane joined the proxy's counter),
  // which is what makes the next observation trustworthy.
  let baseline: number | undefined;
  let pending = 0;
  let pendingSince = 0;

  /** Drop the hold but keep the baseline — a launch admitted on this same
   *  poll must still be recordable (and therefore fenced). */
  const release = (): void => {
    pending = 0;
    pendingSince = 0;
  };
  /** The counters are no longer judgeable: the fence goes fully inert. */
  const reset = (): void => {
    release();
    baseline = undefined;
  };

  /** The fence is evaluable only when the proxy serves a serialised cap. */
  const usable = (inFlight: number | undefined, cap: number | undefined): boolean =>
    typeof inFlight === 'number' && typeof cap === 'number' && cap > 0;

  return {
    get pendingLaunches(): number {
      return pending;
    },
    recordLaunch(now: number): void {
      // Only a counter-serving observation can hold the fence; a launch
      // recorded on a pre-feature proxy is never fenced (fail-open).
      if (typeof baseline !== 'number') return;
      pending += 1;
      pendingSince = now;
    },
    observePoll({ idle, inFlight, cap }: IdleWindowLaunchObservation): void {
      if (!usable(inFlight, cap)) {
        // The proxy stopped serving counters (or the cap is unbounded) —
        // the fence can no longer be judged; fail open.
        reset();
        return;
      }
      if (pending > 0) {
        if (!idle) {
          // The window ended (busy poll): the launched pane registered or the
          // window gave way — nothing to hold any more.
          release();
        } else if (inFlight! > baseline!) {
          // The launched pane is now counted: this observation is
          // demonstrably POST-launch, so its headroom is trustworthy again.
          release();
        } else {
          // Still the pre-launch count — keep holding against the stale
          // snapshot (the baseline stays put).
          return;
        }
      }
      baseline = inFlight;
    },
    admit(now: number): IdleWindowLaunchVerdict {
      if (pending === 0) return { ok: true };
      // Dead-pane safety: without observed registration within the grace
      // window (crash / remote fallback), release the fence — never wedged.
      if (now - pendingSince >= graceMs) {
        release();
        return { ok: true };
      }
      return { ok: false, reason: 'idle-window-spent' };
    },
  };
}

// ── Dispatch contract: the injected dependency boundary (F3) ──────────
//
// The dispatch PIPELINE itself lives in named modules (WL-0MVLII0NO007JJBA):
// `downtime-worker.dispatch.ts` (entry + single-flight state),
// `downtime-worker.dispatch-filter.ts` (Herdr list-head filters),
// `downtime-worker.dispatch-claims.ts` (claim → marker → spawn),
// `downtime-worker.dispatch-cpu-gate.ts`, `downtime-worker.local-reservation.ts`,
// `downtime-worker.stalled-resume.ts` and `downtime-worker.prompts.ts`. This
// interface stays here until the final thin-barrel child and is re-exported
// unchanged; each extracted module declares the structural slice it touches.

/** External boundaries injected so the dispatch logic is testable. */
export interface DowntimeWorkerDeps {
  /**
   * Herdr list head fetch (WL-0MTK1ILM2009QYB2): the canonical ranking
   * (fetcher → smart-selection → grouping). Returns ordered candidates
   * (already ranked); dispatcher applies safety gates as sequential filters.
   * Fail-closed `{ok:false}` on a wl/parse failure (a strike), otherwise
   * `{ok:true, items:[…]}` (empty when genuinely empty).
   */
  getHerdrListHead(cwd: string, limit?: number): Promise<DowntimeHerdrListResult>;
  /**
   * Runs `wl next --stage <stage> -n 10 --json` and reports the first
   * selectable candidate (or a wl failure). `cwd` is the worklog root whose
   * `.worklog/downtime-dispatches.log` is consulted for the plan/intake
   * dispatched-marker change-guard (RCA WL-0MSRBFFLN005W3VT design point 3):
   * a candidate already dispatched for its tier while still at its
   * dispatched-at stage is excluded. A batch is fetched so excluding the
   * top candidate does not starve selection of the next one.
   */
  getNextItem(stage: DowntimeStage, cwd: string): Promise<DowntimeNextResult>;
  /**
   * Look up the next completed/in_review item WITHOUT a valid audit (the
   * audit dispatch tier, which runs before the implement/plan/intake tiers).
   * ROOT-ONLY (WL-0MSTLFW14000KPEC): the `wl list` lookup carries
   * `--root-only`, so completed/in_review children (items with a parentId)
   * are excluded server-side and are never dispatched independently — only
   * parent items are audit candidates (the producer reviews deliverable
   * units, whose audits cover their children).
   * Uses the same `DowntimeNextResult` error channel as `getNextItem`
   * (WL-0MSLWJ2KP0002SV0): `{ok:false}` is a wl/parse failure (a CLI-error
   * strike — never a candidate), while `{ok:true, candidate:null}` is a
   * GENUINELY empty audit tier. The distinction matters: a broken audit
   * lookup must never silently look like "no audit candidates" (which would
   * disable the audit dispatch tier forever without any observable trace).
   * `cwd` is the worklog root whose `.worklog/downtime-dispatches.log` is
   * consulted for the dispatched-marker exclusion (WL-0MSLIY8ZR004QUSY):
   * items the downtime worker already dispatched for `/skill:audit` are
   * never re-selected while they still lack a fresh audit.
   */
  getNextAuditCandidate(cwd: string): Promise<DowntimeNextResult>;
  /**
   * Active-audit single-flight check (WL-0MT3PHW4I002SNOV): true when any
   * non-stale `kind=audit` dispatch marker in the shared rolling dispatch
   * log (`<cwd>/.worklog/downtime-dispatches.log`) maps to an item still
   * `in_progress` — an audit was dispatched (by ANY instance, leader or
   * not) and has not yet completed/reviewed. The dispatcher consults this
   * before selecting an audit candidate and skips the audit tier while one
   * is active, keeping audits strictly sequential (never fan-out). A marker
   * older than `DOWNTIME_AUDIT_STALE_WINDOW_MS` (2h) is treated as stale
   * (the audit pane may have crashed without updating the work item) and
   * ignored. Fail-open: `{ok:false}` on a worklog-query failure — the
   * dispatcher then skips the audit tier and falls through to the next
   * tier rather than blocking all dispatch (fail-safe). `cwd` is the
   * worklog root the dispatch log lives under.
   */
  getActiveAudit(cwd: string): Promise<DowntimeActiveAuditResult>;
  /**
   * Running-downtime-panes liveness query: count dispatched downtime panes
   * that are STILL ALIVE (a live pi agent in a `Downtime …`-labelled Herdr
   * pane), machine-wide.
   *
   * NOTE (WL-0MU2EP6JL006A1U3): this is NOT a dispatch cap. The count feeds
   * only the owner-lease qualifier (`slotOwned`), so an operator's own lease
   * does not block spare-capacity dispatch when the worker has no pane of its
   * own. Dispatched panes stay open until an operator closes them, so binding
   * dispatch to this count stalls the dispatcher; capacity is limited by the
   * local LLM idle / free-slot check alone.
   *
   * Production wires this to `herdr pane list` (the same machine-wide
   * source as the worklist's agent tracker). Fail-open: `{ok:false}` on
   * a herdr failure — the caller degrades to "no known running pane", so the
   * qualifier is inactive and dispatch is unaffected (the proxy's own lease
   * signals still gate capacity).
   *
   * Optional for backward compatibility: when ABSENT, owner-pane
   * qualification is unavailable, so `slotOwned` is not applied (the
   * in-flight pipeline guard and the proxy lease gate still apply).
   */
  getRunningDowntimePanes?(cwd: string): Promise<RunningPanesResult>;
  /**
   * Count completed/in_review root items for the review-queue depth gate
   * (WL-0MT2UQWOR007CYY9): `wl list --status completed --stage in_review
   * --root-only --json`, bounded by `DOWNTIME_WL_TIMEOUT_MS`. Returns the
   * count, or `null` on failure — a failure means "gate active" (only
   * critical implements remain eligible), consistent with the code-freeze
   * ambiguous ⇒ frozen convention.
   */
  getReviewQueueCount(cwd: string): Promise<number | null>;
  /**
   * Look up the next implement-tier candidate (WL-0MSMAYPQP001FLR6): the
   * highest-priority open plan_complete item with risk ≤ Medium / effort ≤ Medium,
   * excluding dependency-blocked items (wl next default) and items already
   * dispatched for `/skill:implement` (kind `implement` dispatched markers,
   * AC6). Fail-closed: a wl failure yields null (no dispatch) — the
   * plan/intake fallback still runs. `cwd` is the worklog root whose
   * `.worklog/downtime-dispatches.log` is consulted for the marker set.
   */
  getNextImplementCandidate(cwd: string): Promise<DowntimeCandidate | null>;
  /**
   * Look up the next critical-first candidate (WL-0MT3FM8VA005XBHE): the
   * highest-priority open CRITICAL item at ANY stage (idea /
   * intake_complete / plan_complete), including dependency-blocked ones
   * (`wl list --priority critical --status open` does NOT exclude them —
   * unlike `wl next`), with the stage-appropriate skill mapping and the
   * plan_complete implement caps (decision Q2). The returned candidate is
   * the stage-appropriate dispatch target (kind derived via
   * `criticalSkillKind(candidate.stage)` by the tier). Fail-closed: a wl
   * failure resolves `{ok:false}` via the `DowntimeNextResult` error
   * channel (never a silent empty — a broken critical lookup must not
   * look like "no critical work"). `cwd` is the worklog root whose
   * `.worklog/downtime-dispatches.log` is consulted for the dispatched-
   * marker change-guard (an item already dispatched for its tier while
   * still at its dispatched-at stage is excluded).
   */
  getNextCriticalCandidate(cwd: string): Promise<DowntimeNextResult>;
  /**
   * Fetch ONE work item by id (leader-only coordination path): the leader
   * re-checks each coordination entry's item against its CURRENT worklog
   * state so a stale entry can never be dispatched on faith alone.
   * `cwd` is the entry's worklog root (the item lives in that worklog).
   * Fail-closed: `{ok:false}` on a wl failure or an unparseable/missing
   * item — the caller treats it as a CLI-error strike (never a silent
   * skip).
   *
   * Optional for backward compatibility: the legacy (non-coordination)
   * dispatch path never consults it; `createDowntimeDeps` always provides
   * it and `dispatchFromCoordination` (the leader path) fails closed
   * (`wl-error`) when it is absent.
   */
  fetchItem?(itemId: string, cwd: string): Promise<DowntimeItemResult>;
  /**
   * Re-check whether a work item already has a fresh audit (WL-0MT8KSTOE00871E7).
   * Called in the audit-tier dispatch path BETWEEN candidate selection and
   * dispatch to detect whether a valid audit was recorded in the interim
   * (e.g. by a human or another process). Resolves true when the item has
   * a fresh audit (auditedAt within AUDIT_FRESHNESS_AT_NEAR_TOLERANCE_MS of
   * updatedAt, via isAuditFresh), false otherwise.
   * Fail-closed: `{ok:false}` on a wl/CLI failure → treated as "not fresh"
   * (the dispatch proceeds — conservative default, never blocks dispatch).
   *
   * Convenience wrapper: fetches the item and applies `isAuditFresh`.
   * A single dep on the worker boundary, testable without wl.
   */
  hasFreshAudit(itemId: string, cwd: string): Promise<boolean>;
  /**
   * Read the current code-freeze marker status (tri-state: 'frozen' /
   * 'not-frozen' / 'ambiguous'). `cwd` is the worklog root; the marker
   * lives at `<cwd>/.worklog/code-freeze.json`. Read fresh on EVERY
   * dispatch (never cached) so a freeze that starts or ends between idle
   * periods is honored on the next dispatch attempt (WL-0MSQ0RPQP00636JY).
   * Fail-closed: an 'ambiguous' marker is treated as frozen by the
   * dispatcher — no implement/audit dispatch while the marker cannot be
   * trusted.
   */
  readCodeFreezeStatus(cwd: string): CodeFreezeStatus;
  /**
   * Host-CPU reading for the CPU-aware dispatch gate (WL-0MVK0UO3Q002TXW6
   * AC1/AC2): 0–100 % host utilisation from `/proc/stat` deltas across the
   * worker's poll interval, normalised across all cores, with a 1-min
   * load-average fallback.
   *
   * Consulted once per dispatch tick (never cached). FAIL-OPEN: when absent
   * (unwired seam) or when it resolves `{ ok: false }` (unreadable/
   * unparseable host metrics) the gate cannot evaluate and dispatch proceeds
   * unchanged. At or above the live `downtimeCpuGatePercent` threshold new
   * audit/implement dispatch is refused with the neutral
   * `cpu-saturated` reason while intake/plan/risk-effort keep flowing; stalled
   * panes are not resumed either. Must never throw.
   *
   * Production wiring (`createDowntimeDeps`) uses a module-level sampler that
   * holds the previous `/proc/stat` sample in memory — no disk state.
   */
  readHostCpu?(): HostCpuReading;
  /**
   * Claim the item (CAS: `wl update <id> --status in_progress --if-status
   * <expected.status> [--if-stage <expected.stage>]`) BEFORE anything else.
   * Exactly one concurrent pane wins; a loser resolves `{ok:false,
   * reason:'stale'}` and the dispatcher aborts (no pane, no marker, no
   * success record). A `{ok:false, reason:'error'}` is a wl CLI failure
   * (a strike, never silently discarded — WL-0MSLWJ310000ND0X absorbed).
   *
   * `cwd` (optional, WL-0MTQ14W7L003II5A) is the worklog root the item
   * lives in — the coordination leader claims offers in the offering
   * instance's OWN root, which may differ from the leader pane's module
   * override. Absent/undefined → legacy behavior (module override / cwd).
   *
   * `migrateStage` (optional, WL-0MTYL7DX9000MZOH) advances the stored
   * stage to a valid value in the same atomic claim — used to recover an
   * item stuck on the retired `in_progress` stage, whose actual stage can
   * be used as the CAS guard but can never equal the tier's target stage.
   */
  claimItem(
    itemId: string,
    expected: DowntimeClaimExpected,
    cwd?: string,
    migrateStage?: string,
  ): Promise<DowntimeClaimResult>;
  /**
   * Open a visible pi agent pane running the prompt (via send-to-pi.sh).
   * Resolves `{ok:true}` when the pane opened (or the probe window elapsed
   * with no failure — fire-and-forget); `{ok:false, error|exitCode}` on a
   * handled spawn `error` event or a non-zero script exit within the probe
   * window (no unhandled-exception crash, WL-0MSLWJ3I70031Z8U absorbed).
   * `paneName` overrides the default `Downtime <kind>` pane name — the
   * scheduled-prompts tier passes `Downtime <entryId>` (WL-0MSS1Q5ER007QDKX).
   * `itemTitle`/`itemId` thread the candidate's context so the pane is named
   * `Downtime triggered <kind> <title> - <id>` (WL-0MSJ4E8UA005KG9Y).
   * `anchorId` (C0 WL-0MTR01EU7005SYZG) forwards the dedicated Dispatcher
   * anchor pane id so send-to-pi.sh splits from THAT pane (--anchor) instead
   * of the leader's current pane — dispatched panes always land in the
   * Dispatcher workspace regardless of leadership. Absent → legacy
   * current-pane behavior (non-downtime/TUI spawns and pre-C0 callers).
   */
  spawnAgentPane(
    prompt: string,
    opts: {
      model: string;
      cwd: string;
      paneName?: string;
      itemTitle?: string;
      itemId?: string;
      anchorId?: string;
      /** Raw work-item priority of the dispatched candidate (parent AC3). */
      priority?: string | null;
      /**
       * Granted local-reservation ticket id (parent WL-0MVIKRFP0005JDL8,
       * slice C2 AC1): forwarded to the pane as `--reservation-ticket` /
       * `PI_LOCAL_RESERVATION_TICKET` so the session's first request carries
       * `X-Local-Reservation`. Absent on a fail-open (older proxy) dispatch.
       */
      reservationTicketId?: string;
      /**
       * Per-turn locality preference (parent WL-0MVIKRFP0005JDL8 AC4, slice
       * C4): forwarded to the pane as `--local-preference` /
       * `HERDR_LOCAL_PREFERENCE` so the Worklog pi extension sends
       * `X-Local-Preference` on every request and logs the route. Absent →
       * no header, no route log (fail-open).
       */
      localPreference?: LocalPreference;
    },
  ): Promise<DowntimeSpawnResult>;
  /**
   * Local capacity reservation (parent WL-0MVIKRFP0005JDL8 AC1/AC2, slice
   * C2): `POST {proxyUrl}/llama/local/reserve`, called ONCE per dispatch
   * attempt (the existing single-flight poll cadence — never a new polling
   * loop) after the CAS claim and BEFORE the success marker/spawn.
   *
   * - granted → the ticket is forwarded to the pane and the spawn proceeds;
   * - refused (`429`) → the dispatch DEFERS with the proxy's `retry_after_s`,
   *   the claim is rolled back and the spawn path never runs;
   * - `null` (absent endpoint / 500 / timeout) → fail OPEN: dispatch
   *   proceeds exactly as today, with no reservation header.
   *
   * A throwing client is treated as `null` (fail-open) at the call site.
   * Optional for backward compatibility: when ABSENT no reservation is
   * attempted and behaviour is byte-identical to today (older proxies are
   * fully supported). Production wiring (`index.ts`) always provides it.
   */
  reserveLocalCapacity?(request: LocalReservationRequest): Promise<LocalReservationResult | null>;
  /**
   * Resolve the dedicated machine-wide Dispatcher anchor pane (C0
   * WL-0MTR01EU7005SYZG, F1 WL-0MTR2CD4X006XI7U): the persisted anchor pane
   * id in the 'Dispatcher' workspace, provisioning it idempotently on first
   * dispatch. Every downtime pane spawn must anchor to this pane so dispatch
   * placement is independent of which instance holds the leader lease.
   * Resolves null on provisioning failure — the caller degrades to "no
   * dispatch this cycle" (fail-safe, never a fallback to the leader's pane).
   * Optional: when ABSENT the worker spawns without an anchor (legacy
   * behavior — the send-to-pi.sh `pane current` fallback), which preserves
   * backward compatibility for callers that predate C0. Production wiring
   * (`createDowntimeDeps`) always provides it, so downtime dispatch is
   * always anchored.
   */
  getDispatcherAnchor?(cwd: string): Promise<DispatcherAnchor | null>;
  /**
   * Resolve the project workspace hosting the worklog plugin pane for the
   * worklog root `cwd` (WL-0MU321YK70035AYT, AC1/AC3). When it resolves, the
   * worklog dispatch path places the pane in that workspace (via
   * {@link getItemTabAnchor}) instead of the machine-wide Dispatcher anchor.
   * This is the PRIMARY placement path (AC1, WL-0MUR5FUWD00024XN): a `null`
   * result (no plugin pane, or an unreadable/ambiguous one) falls back to
   * {@link getDispatcherTabAnchor} (per-prefix Dispatcher tab) when wired,
   * else to {@link getDispatcherAnchor} (AC4). Optional for backward
   * compatibility with pre-change callers/tests; production wiring
   * (`createDowntimeDeps`) always provides it.
   */
  resolveProjectWorkspace?(cwd: string): Promise<ProjectWorkspaceTarget | null>;
  /**
   * Ensure/reuse the tab labelled with the exact work-item id `itemId` inside
   * the resolved project `workspaceId`, returning its anchor (root) pane
   * (WL-0MU321YK70035AYT, AC2). A second dispatch for the same item reuses the
   * same tab. A `null` result fails the dispatch closed with
   * 'anchor-unavailable' — never a wrong-workspace placement. Optional for
   * backward compatibility with pre-change callers/tests; production wiring
   * (`createDowntimeDeps`) always provides it.
   */
  getItemTabAnchor?(
    cwd: string,
    workspaceId: string,
    itemId: string,
  ): Promise<ItemTabAnchor | null>;
  /**
   * Resolve or create the per-prefix tab anchor inside the Dispatcher
   * workspace (C1, parent WL-0MTRQT482001SNXC). Given a work-item id
   * prefix (e.g. `WL`, `TCE`), returns the tab+pane for routing the dispatch
   * into a per-project tab. This is a FALLBACK path (AC3, WL-0MUR5FUWD00024XN):
   * it is only consulted when {@link resolveProjectWorkspace} does not
   * resolve a project workspace for the item's root. A `null` result then
   * degrades to 'anchor-unavailable' — the caller NEVER falls back to the
   * legacy Dispatcher anchor or the leader's pane when this dep is wired.
   * Optional for test callers that inject mocks; production wiring provides
   * it.
   */
  getDispatcherTabAnchor?(
    cwd: string,
    prefix: string,
  ): Promise<DispatcherPrefixTabAnchor | null>;
  /**
   * Audit trail for a successful dispatch: comment on the item + rolling
   * log entry under `.worklog`. Resolves TRUE only when the rolling-log
   * MARKER was written (the dispatched-marker source); a comment failure is
   * tolerated (the comment is a durable cross-machine trail, not the
   * marker). A false result makes the dispatcher ABORT before spawning — an
   * unmarked item is never dispatched (fail-closed, RCA design point 2).
   * Scheduled-prompt dispatches pass `noItemComment: true` — there is no
   * work item, so only the rolling-log marker is written (no wl comment).
   */
  recordDispatch(event: DowntimeDispatchEvent): Promise<boolean>;
  /**
   * Look up the first DUE scheduled prompt (WL-0MSS1Q5ER007QDKX): reads the
   * project-local config at `<cwd>/.worklog/scheduled-prompts.json` and
   * returns the first entry whose frequency threshold is met, in config
   * order. Absent or malformed config → null (fail-closed, logged): no
   * scheduled dispatch and the existing tiers are unaffected (`wl init` is
   * the provisioning path). A due entry resolves non-null — the caller
   * dispatches it instead of reaching the backlog tiers.
   */
  getDueScheduledPrompt(cwd: string): Promise<ScheduledPrompt | null>;
  /**
   * Persist a scheduled prompt's `lastTriggeredAt` (atomic tmp+rename) so a
   * delayed dispatch never fires more often than its frequency. Resolves
   * false on any failure — the dispatcher ABORTS the spawn (an unrecorded
   * dispatch never runs) and the entry stays due for the next idle slot.
   * Must never throw (fail-closed).
   */
  recordScheduledPromptTrigger(cwd: string, promptId: string, at: string): Promise<boolean>;
  /**
   * Record a spawn-failure trace for an attempted dispatch (audit-log
   * integrity, WL-0MSLWJ3I70031Z8U AC2): a failed pane spawn appends an
   * `outcome: 'spawn-failed'` entry with the error/exit trace to the
   * rolling log, so the log distinguishes "attempted" from "opened" and
   * never claims success for a pane that never appeared. Must never throw
   * (fail-closed): audit logging must not crash the worker.
   */
  recordDispatchFailure(event: DowntimeDispatchFailureEvent): Promise<void>;
  /**
   * Best-effort post-spawn enrichment (WL-0MUBVL251006JAQ0 / F6): append a
   * second log entry carrying the resolved pane id, preserving the marker
   * fields. OPTIONAL — when absent the enrichment is skipped. Must never
   * throw and must never block/un-mark the dispatch (fail-open): the
   * dispatcher swallows any rejection.
   */
  recordDispatchEnrichment?(event: DowntimeDispatchEnrichmentEvent): Promise<void>;
  /**
   * Pane-lifecycle item state lookup (WL-0MU308WSF0002JWN): resolve the
   * current work-item state (stage/status/risk/effort/auditedAt/auditResult/
   * needsProducerReview) for a dispatched pane's item so the monitor can
   * classify its lifecycle outcome. OPTIONAL — when absent the monitor
   * cannot classify and takes no action (fail-open; production wiring always
   * provides it). Must never throw; resolves null on a wl/CLI failure so a
   * lookup failure never triggers a spurious close.
   */
  getItemLifecycleState?(itemId: string, cwd: string): Promise<PaneItemState | null>;
  /**
   * Close a dispatched pane (WL-0MU308WSF0002JWN): `herdr pane close
   * <paneId>`. Resolves true on success, false on any failure. OPTIONAL —
   * when absent the monitor logs the outcome but performs no close (used by
   * legacy/test callers). Must never throw (fail-closed): a failed close is
   * logged with `closed:false` and never blocks other panes.
   *
   * `expected` (optional, WL-0MU4US5MP001JFEN AC7) carries the dispatch
   * context so an implementation can verify the live pane really is the
   * downtime pane spawned for THIS item before closing it — never close an
   * unrelated/operator pane whose id happens to collide with a stale entry.
   */
  closePane?(
    paneId: string,
    cwd: string,
    expected?: { itemId: string; kind: PaneLifecycleKind },
  ): Promise<boolean>;
  /**
   * Pane-close reaper runner (WL-0MUJL1NAH0042GOS). OPTIONAL — when absent
   * the periodic reaper does not run (legacy/test callers). Production wires
   * this to `runScheduledPaneClose` over the real herdr/session-log I/O.
   * Fail-closed: must never throw (the worker catches and logs a throw);
   * disabled settings must result in zero close calls.
   */
  runPaneCloseReaper?(
    cwd: string,
    opts: { idleThresholdMinutes: number; ledgerPath?: string },
  ): Promise<void>;
  /**
   * Record a pane-close lifecycle entry in the rolling dispatch log
   * (WL-0MU308WSF0002JWN). OPTIONAL — when absent the monitor falls back to
   * appending directly via `appendPaneCloseLogEntry`. Must never throw
   * (fail-closed): logging must never crash the worker.
   */
  recordPaneClose?(entry: PaneCloseLogEntry, cwd: string): Promise<void>;
  /**
   * Roll back a CAS claim that succeeded but never completed dispatch
   * (WL-0MT32F908002YFFA AC1/AC2): restore the item to its pre-claim
   * status + stage so a future idle period can re-select it. Called when
   * the marker write fails AFTER the claim (marker-write-failed — the item
   * is stranded in `in_progress` with no marker and no pane) and when the
   * pane spawn fails (spawn-failed — the item is claimed + marked but no
   * agent is working it). Resolves `true` when the rollback succeeded,
   * `false` when the item was already moved (race-safe: a concurrent human
   * or another agent already fixed it — nothing to roll back). Must never
   * throw (fail-closed: a rollback failure must not crash the worker; the
   * item remains claimed, which is no worse than the pre-fix state).
   *
   * `original` is the tier's pre-claim expectation (`status`+`stage`); the
   * audit tier passes `completed`, every other tier `open`. `cwd` is the
   * worklog root for the rollback `wl update`.
   */
  rollbackClaim(
    itemId: string,
    original: DowntimeClaimExpected,
    cwd: string,
  ): Promise<boolean>;
  /**
   * Flag an item for producer review (`needsProducerReview = true`) after its
   * automatic dispatch budget is exhausted (WL-0MUKYEXMK0033MFK AC3). Called
   * once when the per-item/per-kind attempt count reaches `maxAttempts`, so a
   * repeatedly non-terminal item surfaces for human triage instead of
   * looping through idle cycles forever. `cwd` is the item's worklog root
   * (cross-root safe). OPTIONAL — when absent the dispatcher still SKIPS the
   * budget-exhausted item (the cap is enforced) but cannot persist the flag
   * (legacy/test callers). Must never throw (fail-closed): a flag write
   * failure must not crash the worker, and the item stays budget-skipped so
   * the flag is retried on the next cycle.
   */
  markNeedsProducerReview?(itemId: string, cwd: string): Promise<boolean>;
  /**
   * Machine-wide stalled-work scan (WL-0MUYMBSA90092QV2 AC1/AC4): scan every
   * `herdr pane list` record for a pane hosting a non-terminal item whose
   * agent has stopped working, and return the resumable candidates (each
   * carrying its OWN worklog root). Consulted ONCE per idle cycle,
   * immediately before new-item selection. Since WL-0MV5639GG00085Q7 the scan
   * also reads the machine-wide model-cooldown signal and offers a DUE
   * cooldown pane as a candidate that bypasses the generic stall threshold
   * (an active cooldown is never woken). OPTIONAL — when absent (or when
   * `resumeStalledPane` is absent) the scan degrades to "no stalled resume"
   * and normal dispatch proceeds unchanged. Must never throw: an
   * unreadable/unparseable scan resolves an empty array.
   */
  scanStalledPanes?(cwd: string, opts: StalledScanOptions): Promise<StalledPaneCandidate[]>;
  /**
   * Attempt an in-place resume of ONE stalled candidate (WL-0MUYMBSA90092QV2
   * AC2/AC6): prompt a live agent with `continue`, or relaunch pi in the SAME
   * pane continuing its session and then submit `continue`. Records a
   * dispatch attempt on success so the existing per-item/per-kind cap
   * applies. OPTIONAL (see `scanStalledPanes`). Must never throw: every
   * failure is a NEUTRAL `{resumed:false}` outcome — never a strike, never a
   * crash, never a duplicate pane.
   */
  resumeStalledPane?(
    candidate: StalledPaneCandidate,
    opts: StalledScanOptions,
  ): Promise<StalledResumeOutcome>;
  /**
   * Machine-wide LONG-RUNNING pane scan (WL-0MVKNC2N50025HXE AC2): report live
   * agent panes whose non-terminal item has had NO observable progress (no
   * `updatedAt` bump, no fresh dispatch marker) for the configured window —
   * INCLUDING panes whose `agent_status` is `working`.
   *
   * Consulted ONLY when a capacity-starvation signal fires (the dispatcher
   * has refused every tick on local capacity for the configured window), so
   * the signal names the panes holding the model. OBSERVATION ONLY: nothing
   * in this path may resume, prompt or close a pane — a legitimately long
   * session must never be interrupted by an alert.
   *
   * OPTIONAL — when absent the starvation signal is emitted without pane
   * evidence. Must never throw: an unreadable/unparseable scan resolves an
   * empty array.
   */
  scanLongRunningPanes?(
    cwd: string,
    opts: LongRunningScanOptions,
  ): Promise<LongRunningPaneObservation[]>;
  /**
   * Record a persistent CLI-error event (three consecutive wl failures).
   * Must never throw (fail-closed): logging must not crash the worker.
   */
  recordError(event: DowntimeErrorEvent): Promise<void>;
  /**
   * Record one no-dispatch DECISION entry (WL-0MU8808ZY0091JIA) — the reason
   * a polled tick refused to dispatch (slot-owner / contention / no-candidate
   * / review-queue-hold / code-freeze / ...), with the observed slot/owner
   * fields. Optional: when absent the worker appends directly to
   * `.worklog/downtime-coordination.log` (the production default). Tests
   * inject a spy to assert the decision vocabulary and rate-limiting without
   * touching the filesystem. Fail-closed: a throw is swallowed.
   */
  recordDecision?(entry: CoordinationLogEntry, cwd: string): Promise<void>;
}

// ── Coordination modules (WL-0MVLII1AO007TTRK) ────────────────────────
// The leader-election coordination section moved verbatim into two named
// modules: `downtime-worker.coordination.ts` (the OFFER computation — tier
// rank, candidate shape, sequential offer filters) and
// `downtime-worker.coordination-leader.ts` (the gated dispatch, the
// depth-aware audit-batch runtime, the own-head fallback and the check-in).
// Consumer-imported symbols keep their barrel export; the leader module
// imports the offer module (one direction only) plus the gates/pane/
// dispatch-claims siblings, never this barrel.
export * from './downtime-worker.coordination.js';
export {
  dispatchFromCoordination,
  runCoordinationCheckIn,
} from './downtime-worker.coordination-leader.js';
import { computeMostImportantItem } from './downtime-worker.coordination.js';
import {
  dispatchFromCoordination,
  runCoordinationCheckIn,
} from './downtime-worker.coordination-leader.js';

// ── Worker orchestrator (implemented — F3) ────────────────────────────

/**
 * Per-tick configuration; re-read every tick so settings apply live.
 *
 * `override` (optional) is the per-instance in-memory enabled-state override:
 * `null` (default) follows the global setting; `true`/`false` force dispatch
 * on/off for THIS worker regardless of the global config. The override is
 * purely in-memory — it resets on plugin restart and never touches the shared
 * settings file (per-instance scoping, parent WL-0MSZ4NSOE007AQEF).
 */
export interface DowntimeWorkerConfig {
  poller: DowntimePoller;
  deps: DowntimeWorkerDeps;
  /**
   * Per-instance in-memory enabled override. `null` (default) = follow the
   * global setting; `true`/`false` force dispatch on/off for this worker.
   */
  override?: boolean | null;
  /** Re-read each tick so settings changes apply without a restart. */
  config(): {
    enabled: boolean;
    thresholdMs: number;
    requiredFreeSlots: number;
    model: string;
    cwd: string;
    /** Pause duration after a genuine empty backlog (no-candidate), ms. */
    noCandidateCooldownMs: number;
    /**
     * Per-turn locality preference for dispatched panes (parent
     * WL-0MVIKRFP0005JDL8 AC4, slice C4). Read live on every tick from the
     * `downtimeLocalPreference` setting (default `local-only`). Optional for
     * backward compat — absent leaves the pane launch byte-identical to
     * today (no `X-Local-Preference`, no route log).
     */
    localPreference?: LocalPreference;
    /**
     * Non-terminal pane-close cooldown, ms (WL-0MUKYERLZ006ELL5). Optional
     * for backward compat — defaults to DEFAULT_DOWNTIME_NON_TERMINAL_COOLDOWN_MS.
     */
    nonTerminalCooldownMs?: number;
    /**
     * Per-item/per-kind dispatch-attempt cap (WL-0MUKYEXMK0033MFK). Optional
     * for backward compat — defaults to DEFAULT_DOWNTIME_MAX_ATTEMPTS (3).
     * Once an item reaches the cap for a kind at its current stage it is
     * flagged for producer review and excluded from further automatic
     * dispatch of that kind.
     */
    maxAttempts?: number;
    /** Sprint-complete threshold (parent WL-0MTHSHN5V008R5L0). Optional for backward compat — defaults to 20. */
    browseItemCount?: number;
    /**
     * Depth-aware audit-batch cap (`downtimeAuditBatchMax`, parent
     * WL-0MVEDM8OT007WDRS AC1). Optional for backward compat — defaults to
     * `DEFAULT_DOWNTIME_AUDIT_BATCH_MAX` (2). `1` = batching off (legacy
     * single-dispatch behaviour); read live on every tick and threaded into
     * both dispatch paths.
     */
    auditBatchMax?: number;
    /**
     * Dispatched success-marker staleness window, ms (WL-0MU6UL0RJ008IHGT).
     * Optional for backward compat — defaults to
     * `DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS` (24 h).
     */
    markerStaleWindowMs?: number;
    /**
     * Stalled-work scan enable (WL-0MUYMBSA90092QV2): read live on every tick.
     * Optional for backward compat — defaults to enabled.
     */
    stallScanEnabled?: boolean;
    /**
     * Stalled-work stall threshold, ms (WL-0MUYMBSA90092QV2): read live on
     * every tick. Optional — defaults to `DEFAULT_DOWNTIME_STALL_THRESHOLD_MS`.
     */
    stallScanThresholdMs?: number;
    /**
     * Host-CPU dispatch gate threshold, percent (WL-0MVK0UO3Q002TXW6 AC5):
     * read live on every tick from `downtimeCpuGatePercent`, so a settings
     * change applies without a plugin restart. Optional — defaults to
     * `DEFAULT_DOWNTIME_CPU_GATE_PERCENT` (75); `0` disables the gate.
     */
    cpuGatePercent?: number;
    /**
     * Continuous capacity-refusal window before a `capacity-starved`
     * observation is written (WL-0MVKNC2N50025HXE AC3). Read live on every
     * tick. Optional — defaults to
     * `DEFAULT_DOWNTIME_CAPACITY_STARVATION_ALERT_MS` (2 h).
     */
    capacityStarvationAlertMs?: number;
    /**
     * Progress window before a live-agent pane is reported as long-running on
     * a starvation signal (WL-0MVKNC2N50025HXE AC2). Read live on every tick.
     * Optional — defaults to `DEFAULT_DOWNTIME_LONG_RUNNING_THRESHOLD_MS` (3 h).
     */
    longRunningThresholdMs?: number;
    /**
     * Pane-lifecycle monitor cadence, ms (WL-0MU308WSF0002JWN). Optional —
     * defaults to `DOWNTIME_PANE_LIFECYCLE_INTERVAL_MS` (30 s). Tests may
     * pass 0 to run the monitor on every tick.
     */
    paneLifecycleIntervalMs?: number;
    /**
     * Pane-close reaper scheduling (WL-0MUJL1NAH0042GOS). Optional — when
     * absent the reaper does not run. `enabled` gates the pass, `intervalMs`
     * overrides the cadence, and `ledgerPath` overrides the ledger location.
     * The reaper is fail-closed: a throw is caught and never crashes the
     * worker.
     */
    paneClose?: {
      enabled: boolean;
      idleThresholdMinutes: number;
      intervalMs?: number;
      ledgerPath?: string;
    };
  };
  /**
   * Optional shared round-robin registry (WL-0MSSRED76008LGB6) used for
   * rotation-aware selection and probe jitter. When absent, selection falls
   * back to the pre-rotation sortIndex order and probes use the static
   * interval (fail-open).
   */
  registry?: RoundRobinRegistry;
  /**
   * Shared coordination directory — the `.worklog` dir where
   * `downtime-coordination.json` (+ the leader lock/lease) lives. All
   * herdr instances contributing to the same coordination list pass the
   * same value (parent AC3 — single-machine v1).
   *
   * Optional for backward compatibility / fail-open: when ABSENT the
   * worker runs the LEGACY non-coordination flow — every instance polls
   * and dispatches through the direct tier chain (`dispatchDowntimeWork`)
   * exactly as before the refactor (used by existing tests and by
   * configurations that have not wired coordination). Production wiring
   * (`createDowntimeWorker` in index.ts) always passes it.
   */
  coordinationDir?: string;
  /**
   * Stable per-instance id used for leader election and the coordination
   * entry key (parent AC3 `instanceId`). Omitted → generated once at
   * worker construction (per-process id; a restarted instance re-offers
   * under a fresh id and its dead lease expires in the TTL).
   */
  instanceId?: string;
  /** Leader lease TTL seconds (parent AC2 — default 5 minutes). */
  leaseTtlSeconds?: number;
  /**
   * Coordination check-in interval (WL-0MTMPSCL8000O45H — default 5
   * minutes, parent AC3): every instance re-verifies/updates its entry at
   * this cadence, whether leader or not. Clamped to ≥ 60 000 ms to avoid
   * CLI churn.
   */
  checkInIntervalMs?: number;
  /**
   * Leader coordination check-in interval (WL-0MTOCBP1D009P4U3 — default
   * 4 minutes): the leader re-offers at this cadence; followers use
   * checkInIntervalMs (5 min default, WL-0MTMPSCL8000O45H). The value
   * must be < lease TTL (5 min) so renewal is inside. Clamped to ≥ 60 000
   * ms.
   */
  leaderCheckInIntervalMs?: number;
}

export interface DowntimeWorkerTickResult {
  polled: boolean;
  dispatched: boolean;
  idle: boolean;
}

export interface DowntimeWorker {
  /** One poll + evaluation + possible dispatch. Call from the scheduler task. */
  tick(): Promise<DowntimeWorkerTickResult>;
  /** Idle-since timestamp of the current idle run (null when busy). */
  readonly idleSince: number | null;
  /** True while a dispatch is in flight. */
  readonly dispatching: boolean;
  /** Timestamp of the last successful dispatch (null until the first). */
  readonly lastDispatchAt: number | null;
  /**
   * Short token for the gate that blocked the last polled tick (e.g.
   * `'slot-owner'`, `'contention'`, `'code-freeze'`), or null when the worker
   * was not gate-blocked (idle/busy/dispatching/disabled). Powers the header's
   * `[downtime held: <token>]` label so "idle slots but no dispatches" is
   * visible (WL-0MU8808ZY0091JIA AC4).
   */
  readonly blockReason: string | null;
  /**
   * Whether the worker is enabled per the current settings (re-read) AND the
   * per-instance in-memory override: effective enabled = `override ??
   * cfg.enabled` (the override takes precedence when set). The getter re-reads
   * the global setting each call, so a settings change applies live while the
   * override stays in force.
   */
  readonly enabled: boolean;
  /**
   * The current per-instance in-memory override (`null` = follow settings;
   * `true`/`false` = force dispatch on/off for this instance).
   */
  readonly override: boolean | null;
  /**
   * True when the current `override === false` was restored from the
   * persisted disable marker (`.herdr-downtime-disabled`) at construction
   * — i.e. the disable survived a pane/plugin restart. False for a live
   * toggle() press and after any explicit re-enable; lets the header show a
   * "restored" notice so a restored disable is never silent
   * (WL-0MT5SG0VU005ARUR).
   */
  readonly restoredFromMarker: boolean;
  /**
   * Flip the per-instance in-memory override: `null` → `false` (disable
   * dispatch for this instance) → `true` (force dispatch on for this
   * instance) → `null` (return to following the global setting), and so on.
   * In-memory only — never written to the settings file, never persisted.
   */
  toggle(): void;
  /**
   * Compute a jittered probe interval (WL-0MSSRED76008LGB6): the effective
   * poll interval is jittered ±50% of the configured `downtimePollIntervalMs`
   * per call (random, injectable RNG via the worker's registry) so instances
   * with identical configuration do not probe in lockstep. Returns the
   * clamped interval for the NEXT probe.
   */
  jitterPollIntervalMs(baseIntervalMs: number): number;
  /**
   * True while the worker is paused in the no-candidate cooldown: no proxy
   * polling, no idle tracking, and no dispatch until the pause expires
   * (WL-0MSI7DQL10016QYX).
   */
  readonly paused: boolean;
  /**
   * Count of consecutive CLI-error dispatch outcomes (three-strike rule).
   * Reset to 0 on a successful dispatch, a genuine no-candidate outcome, or
   * when a cooldown expires.
   */
  readonly errorStrikes: number;
  /**
   * Whether THIS instance currently holds the elected leadership (parent
   * WL-0MST3OJ8S0001ROL AC1): true while the leader lease is valid and
   * owned by this instance. Only the leader polls the proxy and dispatches.
   */
  readonly isLeader: boolean;
  /**
   * The instance id this worker uses for leader election and its
   * coordination entry key (parent AC3 `instanceId`). Stored per worker
   * construction for the process lifetime.
   */
  readonly instanceId: string;
}

/**
 * Compose poller + idle evaluation + tracker + dispatch into the per-tick
 * worker the scheduler loop (F4) registers as a due-work task.
 */
export function createDowntimeWorker(opts: DowntimeWorkerConfig): DowntimeWorker {
  const tracker = createIdleTracker();
  const perSlotTracker = createPerSlotIdleTracker();
  let dispatching = false;
  let lastDispatchAt: number | null = null;
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
  let activeAuditBatch: {
    depth: number;
    cap: number;
    remaining: number;
    /**
     * Batch-local exclusion set (WL-0MVFE1DD8000D8T2 AC3/AC4): every item id
     * already dispatched in THIS batch window, so a continuation can never
     * re-select an item even before its dispatched marker is written/read.
     */
    dispatchedIds: Set<string>;
  } | null = null;
  // Pane-lifecycle monitor cadence gate (WL-0MU308WSF0002JWN): the timestamp
  // of the last monitor pass. 0 forces a pass on the first tick.
  let lastPaneMonitorAt = 0;
  // Pane-close reaper cadence gate (WL-0MUJL1NAH0042GOS): timestamp of the
  // last scheduled reaper pass. 0 forces a pass on the first tick.
  let lastPaneCloseReaperAt = 0;
  // No-candidate cooldown (WL-0MSI7DQL10016QYX): timestamp until which the
  // worker is fully paused (no poll, no idle tracking, no dispatch) after a
  // genuine empty backlog OR three consecutive CLI errors. Cancelled early
  // when a coordination check-in re-offers a fresh item
  // (WL-0MTEZ4XZJ006Y9U7). null = not paused.
  let cooldownUntil: number | null = null;
  // Three-strike rule: consecutive CLI-error dispatch outcomes. A successful
  // dispatch, a genuine no-candidate outcome, or an expired cooldown resets it.
  let errorStrikes = 0;
  // No-dispatch decision logging (WL-0MU8808ZY0091JIA): the last reason
  // written and when, so repeated identical refusals are rate-limited.
  let lastDecisionReason: string | null = null;
  let lastDecisionAt = 0;
  // Continuous capacity-starvation tracking (WL-0MVKNC2N50025HXE AC3): a run
  // of capacity-flagged refusals is an episode; once it has lasted the
  // configured window a `capacity-starved` observation is written ONCE per
  // window so a silent all-night NOP becomes diagnosable. Observation only —
  // it never gates dispatch, never strikes and never replaces the refusal
  // reason/header token. Reset by any non-capacity outcome and by a
  // successful dispatch.
  const starvationTracker = new CapacityStarvationTracker();
  // Long-running pane progress window (AC2), re-read from settings every tick
  // and used only to annotate a starvation signal.
  let longRunningThresholdMs = DEFAULT_DOWNTIME_LONG_RUNNING_THRESHOLD_MS;
  // Current header blocking token; null when not gate-blocked. Reset each tick.
  let blockReason: string | null = null;
  // One-per-idle-window launch fence (parent WL-0MVIKRFP0005JDL8, slice C3):
  // holds once the instance launches a ticket-backed pane and releases only
  // when a fresh observation shows the launched prefill registered. This is
  // per-instance state — the proxy's atomic reservation is the cross-instance
  // arbiter (slice C2); the fence closes the STALE-STATUS same-instance window
  // (a permissive proxy granting N tickets against unchanged headroom).
  const launchWindow = createIdleWindowLaunchFence();
  // Per-instance in-memory enabled override (parent WL-0MSZ4NSOE007AQEF):
  // null (default) = follow the global setting; true/false force dispatch
  // on/off for THIS instance. In-memory only — resets on plugin restart,
  // never written to the shared settings file. Initialized from the optional
  // config so callers can construct a pre-toggled worker.
  let override: boolean | null = opts.override ?? null;
  // Durable disable (WL-0MT5SFP990001FNW): when the per-worklog-root marker
  // exists, the worker starts disabled so a previous `d` press survives a
  // restart. Explicit opts.override wins over the marker (marker is only the
  // fallback when no override is passed).
  let restoredFromMarker = false;
  if (opts.override === undefined && disableMarkerExists(opts.config().cwd)) {
    override = false;
    restoredFromMarker = true;
  }

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
  // Timestamp of the last coordination check-in (WL-0MTMPSCL8000O45H —
  // default 5-min cadence, parent AC3). null until the first tick so every
  // instance checks in on startup (first check-in on startup — parent
  // Constraint).
  let lastCheckInAt: number | null = null;
  // WL-0MTMPSCL8000O45H AC2 — churn guard: true when the LAST
  // runCoordinationCheckIn offered nothing (genuine empty backlog). While
  // true the immediate re-offer is suppressed (re-probing an empty worklog
  // every ~10 s tick would churn wl); the periodic cadence retries until
  // work appears and an offer lands.
  let lastOfferEmpty = false;
  // Per-tick cached leadership decision (the lease read is cheap but let a
  // tick observe ONE consistent state — an election win mid-tick applies
  // next tick). Legacy mode (no coordinationDir) is always the leader.
  let leaderState = leaderManager ? leaderManager.isLeader() : true;

  // Three-strike pause (WL-0MSI7DQL10016QYX; shared by the CLI-error path
  // and the coordination probe-failure path, WL-0MTEZ4XZJ006Y9U7): N
  // consecutive failures pause the worker entirely and log the persistent
  // error so it is auditable. A single transient failure does NOT pause —
  // it retries on the next idle period. Fail-closed: error logging must
  // never crash the worker.
  // WL-0MTJPYM53003ORCV: log on EVERY strike (not just 3) with structured
  // fields for debuggability.
  const pauseAfterPersistentErrors = async (
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
  ): Promise<void> => {
    errorStrikes += 1;
    const attempt = errorStrikes;
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
      await opts.deps.recordError({
        cwd: opts.config().cwd,
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
    if (errorStrikes >= DOWNTIME_ERROR_STRIKE_LIMIT) {
      cooldownUntil = Date.now() + opts.config().noCandidateCooldownMs;
      errorStrikes = 0;
      tracker.record(false);
      perSlotTracker.record([]);
    }
  };

  // ── Capacity-starvation observation (WL-0MVKNC2N50025HXE AC3) ──
  // Write ONE observation entry for a capacity-refusal episode that has
  // outlasted the configured window. It reuses the refusal's evidence fields
  // (same schema), adds the episode length and — when the long-running scan
  // is wired — names the panes holding the model. Observation only: it does
  // not set the header blocking token, never gates dispatch, and a logging
  // failure is swallowed (fail-closed).
  const writeCapacityStarvationSignal = async (
    cwd: string,
    starvation: CapacityStarvationObservation,
    fields: DecisionEntryFields,
    now: number,
  ): Promise<void> => {
    let longRunningPanes: LongRunningPaneObservation[] | undefined;
    if (typeof opts.deps.scanLongRunningPanes === 'function') {
      try {
        const observed = await opts.deps.scanLongRunningPanes(cwd, {
          thresholdMs: longRunningThresholdMs,
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
      instanceId,
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
      if (typeof opts.deps.recordDecision === 'function') {
        await opts.deps.recordDecision(entry, cwd);
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
  const recordDecision = async (
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
  ): Promise<void> => {
    if (options.blocking !== false) blockReason = decisionHeaderToken(reason);
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
        ? starvationTracker.observe(options.starvationReason ?? reason, now)
        : null;
    if (
      lastDecisionReason === reason &&
      now - lastDecisionAt < DOWNTIME_DECISION_LOG_MIN_INTERVAL_MS
    ) {
      // Rate-limited refusal: skip the refusal line, but never the signal.
      if (starvation !== null) {
        await writeCapacityStarvationSignal(cwd, starvation, fields, now);
      }
      return; // identical refusal within the window
    }
    lastDecisionReason = reason;
    lastDecisionAt = now;
    const entry: CoordinationLogEntry = {
      kind: 'decision',
      operation: 'no-dispatch',
      instanceId,
      reason,
      ...fields,
      at: new Date(now).toISOString(),
    };
    try {
      if (typeof opts.deps.recordDecision === 'function') {
        await opts.deps.recordDecision(entry, cwd);
      } else {
        await appendCoordinationLogEntry(cwd, entry);
      }
    } catch {
      // fail-closed: decision logging must never crash the worker
    }
    // The starvation observation always follows the refusal line (it never
    // replaces it) — AC5: the reason/token stream stays intact.
    if (starvation !== null) {
      await writeCapacityStarvationSignal(cwd, starvation, fields, now);
    }
  };

  /**
   * Depth-aware audit-batch diagnostics (parent WL-0MVEDM8OT007WDRS AC5):
   * metadata attached to a decision while a batch is armed. `depth`/`cap` are
   * re-measured from the dispatch outcome when it read the Herdr head (a
   * blocked continuation), otherwise they are the values the active batch was
   * armed with; `remaining` is the continuation budget still available BEFORE
   * this decision (`0` once the batch has ended). Absent entirely when no
   * batch is active, so non-batch decisions keep their existing shape.
   */
  const batchMetadata = (
    live?: { depth: number; cap: number },
  ): { auditBatchDepth?: number; auditBatchCap?: number; auditBatchRemaining?: number } =>
    activeAuditBatch === null
      ? {}
      : {
          auditBatchDepth: live?.depth ?? activeAuditBatch.depth,
          auditBatchCap: live?.cap ?? activeAuditBatch.cap,
          auditBatchRemaining: activeAuditBatch.remaining,
        };

  return {
    get idleSince(): number | null {
      return tracker.idleSince;
    },
    get dispatching(): boolean {
      return dispatching;
    },
    get lastDispatchAt(): number | null {
      return lastDispatchAt;
    },
    get isLeader(): boolean {
      return leaderState;
    },
    get instanceId(): string {
      return instanceId;
    },
    get enabled(): boolean {
      // Effective enabled = override ?? cfg.enabled: the per-instance
      // override takes precedence when set (so `d` can force dispatch on
      // for one pane even when the global setting is off); with no override
      // the worker follows the global setting exactly as before.
      return override ?? opts.config().enabled;
    },
    get override(): boolean | null {
      return override;
    },
    get restoredFromMarker(): boolean {
      return restoredFromMarker;
    },
    toggle(): void {
      // null → false → null cycle: pressing `d` disables dispatch;
      // pressing again returns to following the global setting.
      // No force-enable: a second press never sets override to true.
      // The per-worklog-root marker (WL-0MT5SFP990001FNW) is written on
      // disable and removed on re-enable so the disable survives restarts.
      // A live press (or an explicit re-enable) clears the restored flag so
      // the header notice only reflects the marker-restored state.
      if (override === null) {
        override = false;
        restoredFromMarker = false;
        writeDisableMarker(opts.config().cwd);
      } else {
        override = null;
        restoredFromMarker = false;
        removeDisableMarker(opts.config().cwd);
      }
    },
    jitterPollIntervalMs(baseIntervalMs: number): number {
      // Fail-open: no registry → static interval (no jitter).
      return opts.registry
        ? opts.registry.getEffectivePollInterval(baseIntervalMs)
        : baseIntervalMs;
    },
    get paused(): boolean {
      return cooldownUntil !== null && Date.now() < cooldownUntil;
    },
    get errorStrikes(): number {
      return errorStrikes;
    },
    get blockReason(): string | null {
      return blockReason;
    },
    async tick(): Promise<DowntimeWorkerTickResult> {
      const cfg = opts.config();
      // Capacity-starvation tracking (WL-0MVKNC2N50025HXE AC3): the window and
      // the long-running progress window are re-read from settings every tick,
      // so an operator change applies live without a plugin restart.
      starvationTracker.configure(
        cfg.capacityStarvationAlertMs ?? DEFAULT_DOWNTIME_CAPACITY_STARVATION_ALERT_MS,
      );
      longRunningThresholdMs =
        cfg.longRunningThresholdMs ?? DEFAULT_DOWNTIME_LONG_RUNNING_THRESHOLD_MS;
      // Fresh per-tick decision state: clear the header blocking reason; a
      // gate below re-sets it when this tick is refused (WL-0MU8808ZY0091JIA).
      blockReason = null;
      // Short-circuit on the EFFECTIVE enabled state (override ?? settings):
      // while toggled off the worker performs no proxy polling, no idle
      // tracking, and no dispatch — exactly the settings-disabled path.
      if (!(override ?? cfg.enabled)) {
        activeAuditBatch = null; // disabled → no carried batch window
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
      if (disableMarkerExists(cfg.cwd) && override === null) {
        activeAuditBatch = null; // disabled → no carried batch window
        return { polled: false, dispatched: false, idle: false };
      }

      // ── Leader election + coordination check-in (parent
      // WL-0MST3OJ8S0001ROL AC1/AC2/AC3) ───────────────────────────────────
      // In legacy mode (no coordinationDir) this whole block is skipped: no
      // election, no check-in — the worker is always the leader and uses the
      // direct tier chain below (pre-refactor behavior).
      const tickNow = Date.now();
      if (leaderManager !== null) {
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
        leaderManager.refreshLease();
        //  AC1 — re-derive leadership every tick (one cheap lease-file
        //  read): a lease that expired mid-pause routes this worker OUT of
        //  zombie dispatch; if ANOTHER instance won the lease during the
        //  pause, this re-derived state yields — never fights the new
        //  leader (AC4).
        leaderState = leaderManager.isLeader();
        if (leaderState) {
          // Leader: self-heal already ran above (fresh acquiredAt this
          // tick — each proxy-poll cycle extends the 5-minute lease,
          // AC2). A failed refresh (rename/IO) is fail-safe: the existing
          // lease stands until it expires, then a new election runs.
        } else if (!leaderManager.hasLease() || leaderManager.detectStaleLeader()) {
          // No leader exists yet (fresh election) OR the elected leader's
          // lease expired (crash / idle) — try to take over NOW. Stale
          // state is cleaned first (an expired lease, or an orphaned lock
          // without a lease, must not block the new election). On success
          // we become the leader this tick; on lock contention (another
          // instance won first — its cleanup+no-op or a valid lease) we
          // stay non-leader and retry on a later tick. Fail-safe: a failed
          // election leaves us non-leader (no dispatch).
          cleanupStaleElection({ worklogDir: opts.coordinationDir! });
          leaderManager.attemptElection();
          leaderState = leaderManager.isLeader();
          if (leaderState) leaderManager.refreshLease();
          // Audit trail (WL-0MSXHAE290067VAL): log the leadership win —
          // initial election or takeover after a stale-lease detection.
          if (leaderState) {
            void appendCoordinationLogEntry(cfg.cwd, {
              kind: 'coordination',
              operation: 'election',
              instanceId,
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
          const notPaused = cooldownUntil === null || Date.now() >= cooldownUntil;
          reOfferDue =
            notPaused
            && !disableMarkerExists(cfg.cwd)
            && !lastOfferEmpty
            && getEntry(opts.coordinationDir!, instanceId) === null;
        } catch {
          reOfferDue = false;
        }
        const effectiveCheckInMs = leaderState ? leaderCheckInMs : checkInIntervalMs;
        if (reOfferDue || lastCheckInAt === null || tickNow - lastCheckInAt >= effectiveCheckInMs) {
          lastCheckInAt = tickNow;
          try {
            const checkIn = await runCoordinationCheckIn(opts.deps, {
              cwd: cfg.cwd,
              coordinationDir: opts.coordinationDir!,
              instanceId,
              browseItemCount: cfg.browseItemCount,
              markerStaleWindowMs: cfg.markerStaleWindowMs,
              nonTerminalCooldownMs: cfg.nonTerminalCooldownMs,
              maxAttempts: cfg.maxAttempts,
            }, tickNow);
            lastOfferEmpty = checkIn.offered === null;
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
              cooldownUntil = null;
              errorStrikes = 0;
            } else if (cooldownUntil !== null && checkIn.offered !== null) {
              // File already holds the same entry (no write needed) but
              // CLI healthy — also cancel so stale-file probes don't keep
              // the pause alive while work still exists.
              cooldownUntil = null;
              errorStrikes = 0;
            }
          } catch {
            // Fail-safe: a throwing check-in (stub or regression) must never
            // crash the worker — retried at the next cadence.
          }
        }

        // Non-leader short-circuit (AC4): no proxy polling, no idle
        // tracking, no dispatch — the check-in above is the instance's only
        // coordination activity. (Lease takeover was handled above.)
        if (!leaderState) {
          activeAuditBatch = null; // leadership lost → the batch window ends
          return { polled: false, dispatched: false, idle: false };
        }
      }

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
        tickNow - lastPaneMonitorAt >= paneMonitorIntervalMs
      ) {
        lastPaneMonitorAt = tickNow;
        void monitorDispatchedPanes(opts.deps, cfg.cwd).catch((err) => {
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
      if (paneCloseReaperDue(cfg.paneClose, lastPaneCloseReaperAt, tickNow)) {
        lastPaneCloseReaperAt = tickNow;
        const paneClose = cfg.paneClose!;
        if (typeof opts.deps.runPaneCloseReaper === 'function') {
          try {
            void opts.deps
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

      // Cooldown gate (WL-0MTEZ4XZJ006Y9U7 AC2 — ordering): the check-in
      // block above runs FIRST, so a no-candidate pause never suppresses the
      // coordination check-in (the only mechanism that re-offers work once
      // the coordination file empties); a fresh re-offer cancels the pause
      // directly. While paused the worker performs NO proxy polling, NO
      // idle tracking, and NO dispatch. The pause is a full stop (user
      // confirmed "pause completely"); once it expires the idle tracker is
      // empty, so a fresh full idle period is required before the next
      // dispatch (no stale idle credit from before the pause).
      if (cooldownUntil !== null) {
        if (Date.now() < cooldownUntil) {
          activeAuditBatch = null; // paused → the idle window is over
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
        cooldownUntil = null; // pause expired — resume normal polling
        errorStrikes = 0; // fresh strike counter after the pause
        activeAuditBatch = null; // no stale batch budget across a pause
      }
      if (opts.poller.isPolling()) return { polled: false, dispatched: false, idle: tracker.idleSince !== null };


      const status = await opts.poller.poll();
      if (status === null) {
        tracker.record(false); // endpoint failure/ambiguity → busy
        perSlotTracker.record([]); // fail-closed: ambiguous poll resets every slot timer
        activeAuditBatch = null; // an ambiguous poll ends the batch window
        launchWindow.observePoll({ idle: false }); // unusable poll → window over
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
        tracker.record(false);
        perSlotTracker.record([]); // fail-closed: reset every slot timer
        launchWindow.observePoll({ idle: false }); // no trustworthy window → fence releases
        void recordDecision(cfg.cwd, 'slots-unavailable', {
          freeSlots: 0,
          totalSlots: status.total_slots,
          ownerPresent: status.local_lease_active === true,
          runningPanes: null,
          contentionDepth: contentionQueueDepth,
          ...capacity,
          // AC5: a batch that was armed is blocked by this fail-closed poll —
          // attach its metadata, then end it (no batch survives an unusable
          // availability signal).
          ...batchMetadata(),
        });
        activeAuditBatch = null;
        return { polled: true, dispatched: false, idle: false };
      }
      // Schema-v2 saturated pool (LP-0MVGDUVGE0024YAI AC4): a defensive
      // cross-check that never admits a dispatch, even when the per-slot
      // detail looks inconsistent. Distinct reason/token so it is
      // distinguishable from slot-owner / contention / no-slots.
      if (status.capacity_hint === 'saturated') {
        tracker.record(false);
        perSlotTracker.record([]); // saturated → reset every slot timer
        launchWindow.observePoll({ idle: false }); // saturated pool → no window
        void recordDecision(cfg.cwd, 'capacity-saturated', {
          freeSlots: countFreeUnownedSlots(perSlotSlots),
          totalSlots: status.total_slots,
          ownerPresent: status.local_lease_active === true,
          runningPanes: null,
          contentionDepth: contentionQueueDepth,
          ...capacity,
          ...batchMetadata(),
        });
        activeAuditBatch = null;
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
        tracker.record(globalIdle && !anySlotProcessing);
        if (globalIdle) {
          perSlotTracker.record(perSlotSlots);
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
              perSlotTracker.thresholdMetCount(cfg.thresholdMs) >= cfg.requiredFreeSlots;
          }
        } else {
          perSlotTracker.record([]); // global busy → reset every slot timer
          idle = false;
          ready = false;
        }
      } else {
        // Single global tracker (no per-slot data, or N ≤ 0 / N ≥ total):
        // unchanged all-slots-free behaviour (parent AC2 parity).
        idle = evaluateIdle(status, cfg.requiredFreeSlots);
        tracker.record(idle);
        ready = idle && (idleAgeAuthority
          ? idleAgeQualifies
          : tracker.isThresholdMet(cfg.thresholdMs));
      }

      // AC3/AC4: an idle-age poll that reports a live contention/gate waiter
      // resets the run immediately instead of carrying an older idle credit
      // into the next poll — the backend is already working off that queue.
      // Runs AFTER the branches so it can never be re-seeded by them. Scoped
      // to the idle-age signal so a pre-feature proxy keeps today's
      // contention behaviour byte-for-byte.
      if (idleAgeSeconds !== null && (contentionQueueDepth > 0 || prefillGateWaiters > 0)) {
        tracker.record(false);
        perSlotTracker.record([]);
        activeAuditBatch = null;
      }

      // One-per-idle-window launch fence observation (parent AC3, slice C3):
      // feed every usable poll so a launch recorded earlier in this window is
      // released as soon as the proxy's own in-flight counter shows it
      // registered (or the window ends / counters are no longer servable).
      launchWindow.observePoll({
        idle,
        inFlight: status.local_prefills_in_flight,
        cap: status.local_max_concurrent_prefills,
      });

      if (!idle) {
        activeAuditBatch = null; // busy poll ends the continuous idle window
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
      if (dispatching) return { polled: true, dispatched: false, idle: true };
      // Idle-age observability (AC7): when the proxy's elapsed idle age is
      // what admitted this poll, record it (non-blocking) so an admitted
      // dispatch carries the age/source evidence too. Rate-limited, so a
      // long idle window logs this at most once per interval.
      if (idleAgeAuthority && idleAgeQualifies) {
        void recordDecision(
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
      const freeSlots = countFreeUnownedSlots(perSlotSlots);

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
      if (typeof opts.deps.getRunningDowntimePanes === 'function') {
        try {
          const running = await opts.deps.getRunningDowntimePanes(cfg.cwd);
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
      const ownerPresent = status.local_lease_active === true;
      const slotOwned = countFreeUnownedSlots(perSlotSlots) === 0;
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
        void recordDecision(cfg.cwd, 'slot-owned', {
          freeSlots,
          totalSlots: status.total_slots,
          ownerPresent,
          runningPanes,
          contentionDepth: contentionQueueDepth,
          ...capacity,
          // AC5: an armed batch blocked by slot ownership keeps the existing
          // `slot-owned` token, now with its depth/cap/remaining metadata.
          ...batchMetadata(),
        });
        activeAuditBatch = null; // no owned slot can host a continuation
        return { polled: true, dispatched: false, idle: true };
      }
      if (contentionQueueDepth > 0) {
        void recordDecision(cfg.cwd, 'proxy-contention', {
          freeSlots,
          totalSlots: status.total_slots,
          ownerPresent,
          runningPanes,
          contentionDepth: contentionQueueDepth,
          ...capacity,
          // AC5: an armed batch blocked by proxy contention keeps the existing
          // `proxy-contention` token, now with its metadata.
          ...batchMetadata(),
        });
        activeAuditBatch = null; // proxy contention ends the batch window
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
      const prefillPacing = evaluatePrefillPacing(status, perSlotSlots);
      if (prefillPacing.deferReason !== undefined) {
        void recordDecision(cfg.cwd, prefillPacing.deferReason, {
          freeSlots,
          totalSlots: status.total_slots,
          ownerPresent,
          runningPanes,
          contentionDepth: contentionQueueDepth,
          ...capacity,
          ...batchMetadata(),
        });
        activeAuditBatch = null; // a paced tick ends the batch window
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
      const launchVerdict = launchWindow.admit(Date.now());
      if (!launchVerdict.ok) {
        void recordDecision(cfg.cwd, 'idle-window-spent', {
          freeSlots,
          totalSlots: status.total_slots,
          ownerPresent,
          runningPanes,
          contentionDepth: contentionQueueDepth,
          ...capacity,
          ...batchMetadata(),
          // How many of THIS instance's launches the proxy has not yet
          // accounted for (observability evidence, AC3).
          pendingLaunches: launchWindow.pendingLaunches,
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
      // entry. The CAS claim + dispatched-marker guards are preserved
      // inside `dispatchClaimedTier` (AC5). The idle-duration gate above
      // has already required ≥ N ≥ 1 free slots continuously, so the
      // dispatch runs only with a real slot available.
      //
      // Legacy mode (no coordinationDir / no fetchItem dep): the direct
      // per-instance tier chain (`dispatchDowntimeWork`) — pre-refactor
      // behavior, retained as the fail-open fallback.
      dispatching = true;
      // Depth-aware audit-batch continuation budget BEFORE this dispatch
      // (parent WL-0MVEDM8OT007WDRS AC1/AC2/AC5): `null` = no batch armed.
      // Passed to the dispatcher so a continuation decrements it; captured
      // here so the observability decisions below can distinguish a
      // continuation from the first dispatch of a batch AND attach the active
      // batch metadata to a blocked/ended decision.
      const armedBatch = activeAuditBatch;
      const continuationBudget = armedBatch !== null ? armedBatch.remaining : null;
      try {
        const outcome =
          opts.coordinationDir && typeof opts.deps.fetchItem === 'function'
            ? await dispatchFromCoordination(
                opts.deps,
                readCoordinationFile(opts.coordinationDir)?.entries ?? [],
                {
                  model: cfg.model,
                  cwd: cfg.cwd,
                  coordinationDir: opts.coordinationDir,
                  localPreference: cfg.localPreference,
                  freeSlots: effectiveFreeSlots,
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
                  leaseTtlMs: opts.leaseTtlSeconds
                    ? opts.leaseTtlSeconds * 1000
                    : DEFAULT_LEASE_TTL_SECONDS * 1000,
                },
              )
            : await dispatchDowntimeWork(opts.deps, {
                model: cfg.model,
                cwd: cfg.cwd,
                // Per-turn locality preference (slice C4 AC1), read live from
                // `downtimeLocalPreference`. Absent on legacy configs →
                // today's byte-identical launch (fail-open C4-AC3).
                localPreference: cfg.localPreference,
                freeSlots: effectiveFreeSlots,
                browseItemCount: cfg.browseItemCount,
                // Depth-aware audit-batch cap (parent WL-0MVEDM8OT007WDRS AC1).
                auditBatchMax: cfg.auditBatchMax,
                // Continuation budget for the current idle window; absent on
                // the first dispatch / when no batch is armed.
                ...(continuationBudget !== null ? { auditBatchRemaining: continuationBudget } : {}),
                // Owner-lease (AC2) + contention (AC6) gates
                // (WL-0MTYZXSLN008HZOW). No pane-count cap
                // (WL-0MU2EP6JL006A1U3).
                slotOwned,
                contentionQueueDepth,
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
            cfg.cwd,
            reservationRefused ? 'reservation-refused' : outcome.reason,
            {
              freeSlots,
              totalSlots: status.total_slots,
              ownerPresent,
              runningPanes,
              contentionDepth: contentionQueueDepth,
              ...capacity,
              // AC5: a held/blocked continuation reuses the EXISTING token
              // unchanged (`audit-in-flight` / `audit-host-saturated` /
              // `code-freeze` / `review-queue-hold` / `no-candidate` / ...) and
              // gains the active batch metadata as an additive field.
              ...batchMetadata(outcome.auditBatch),
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
        if (!outcome.dispatched) activeAuditBatch = null;
        if (outcome.dispatched) {
          // One-per-idle-window fence (parent AC3, slice C3): record the
          // launch so the NEXT dispatch decision in this window requires a
          // fresh observation that the launched prefill registered.
          launchWindow.recordLaunch(Date.now());
          lastDispatchAt = Date.now();
          errorStrikes = 0; // a successful dispatch proves the CLI is healthy
          // A successful dispatch proves capacity was available, so the
          // capacity-starvation episode is over (WL-0MVKNC2N50025HXE AC3).
          starvationTracker.reset();
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
              cfg.cwd,
              'audit-batch-continue',
              {
                freeSlots,
                totalSlots: status.total_slots,
                ownerPresent,
                runningPanes,
                contentionDepth: contentionQueueDepth,
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
            activeAuditBatch = {
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
                cfg.cwd,
                'audit-batch-end',
                {
                  freeSlots,
                  totalSlots: status.total_slots,
                  ownerPresent,
                  runningPanes,
                  contentionDepth: contentionQueueDepth,
                  auditBatchDepth: batch.depth,
                  auditBatchCap: batch.cap,
                  auditBatchRemaining: batch.remaining,
                  auditBatchEndReason: batch.depth < batchThreshold ? 'depth' : 'cap',
                },
                { blocking: false },
              );
            }
            activeAuditBatch = null;
            // Belt-and-suspenders: even if the proxy does not immediately
            // report busy, require a fresh full idle period before the next
            // dispatch (AC5).
            tracker.record(false);
            perSlotTracker.record([]);
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
          if (outcome.ownBacklogDispatch === true && leaderManager !== null) {
            leaderManager.releaseLeadership();
            leaderState = false;
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
          if (opts.coordinationDir && typeof opts.deps.fetchItem === 'function') {
            const probe = await computeMostImportantItem(opts.deps, cfg.cwd, Date.now(), cfg.browseItemCount, cfg.markerStaleWindowMs, cfg.nonTerminalCooldownMs, cfg.maxAttempts, cfg.stallScanEnabled, cfg.stallScanThresholdMs, cfg.cpuGatePercent);
            if (probe.ok && 'noCandidate' in probe && probe.noCandidate) {
              errorStrikes = 0; // the CLI answered — it is healthy
              cooldownUntil = Date.now() + cfg.noCandidateCooldownMs;
              tracker.record(false);
              perSlotTracker.record([]);
            } else if (!probe.ok) {
              await pauseAfterPersistentErrors(
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
            errorStrikes = 0; // the CLI answered — it is healthy
            cooldownUntil = Date.now() + cfg.noCandidateCooldownMs;
            tracker.record(false);
            perSlotTracker.record([]);
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
        return { polled: true, dispatched: outcome.dispatched, idle: true };
      } finally {
        dispatching = false;
      }
    },
  };
}

