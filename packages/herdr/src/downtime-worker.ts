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
 * ## Module layout (WL-0MVLII0NO007JJBA, WL-0MVLII2080074S5L)
 *
 * This file is the barrel: it re-exports the decomposed family. The dispatch
 * pipeline lives in `downtime-worker.dispatch.ts` (entry + the single
 * `dispatchInFlightCount`), `downtime-worker.dispatch-filter.ts` (Herdr
 * list-head filters), `downtime-worker.dispatch-claims.ts` (claim \(→ marker →
 * spawn), `downtime-worker.dispatch-cpu-gate.ts`,
 * `downtime-worker.local-reservation.ts`, `downtime-worker.stalled-resume.ts`
 * and `downtime-worker.prompts.ts`. The worker orchestrator lives in five
 * named modules, each with ONE responsibility:
 *
 *  - `downtime-worker.worker-contract.ts` — the injected dependency boundary
 *    (`DowntimeWorkerDeps`) and the config / tick-result / handle types;
 *  - `downtime-worker.launch-fence.ts` — the one-per-idle-window launch
 *    fence (`createIdleWindowLaunchFence`);
 *  - `downtime-worker.orchestrator-dispatch.ts` — the shared orchestrator
 *    context, the dispatch admission gates and the dispatch attempt;
 *  - `downtime-worker.orchestrator-tick.ts` — the tick state machine (gates,
 *    leader/check-in, pane maintenance, cooldown, poll/evaluate) plus the
 *    three-strike rule and the no-dispatch decision log;
 *  - `downtime-worker.orchestrator.ts` — `createDowntimeWorker`, the factory
 *    and the returned handle.
 *
 * Extracted modules import concrete siblings — never this barrel — so the
 * layering stays acyclic.
 */

import { LOCAL_PREFERENCE_ENV_VAR } from './local-preference.js';

/**
 * Re-exported for the dispatch tests: the pane-launch env var carrying the
 * per-turn locality preference (canonical definition in
 * `./local-preference.ts`).
 */
export { LOCAL_PREFERENCE_ENV_VAR };
// Type-only edge kept for the split guard's frozen cycle baseline: nothing in
// this barrel imports `stalled-work.ts` at runtime (a value import here would
// be a runtime cycle), while the recorded type-only edge must stay. The scan
// shapes it names are re-exported by the shared types module below for
// consumers.
export type { StalledScanOptions } from './stalled-work.js';
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

// ── Worker contract, launch fence and orchestrator (WL-0MVLII2080074S5L) ──
// The worker orchestrator is decomposed into named modules, each with one
// responsibility: `downtime-worker.worker-contract.ts` (the injected deps
// boundary + the config/result/handle types), `downtime-worker.launch-fence.ts`
// (the one-per-idle-window launch fence),
// `downtime-worker.orchestrator-dispatch.ts` (shared tick context, the
// dispatch admission gates and the dispatch attempt),
// `downtime-worker.orchestrator-tick.ts` (the tick state machine, the
// cooldown/three-strike rule and the decision log) and
// `downtime-worker.orchestrator.ts` (the factory and the returned handle).
// Consumer-imported symbols keep their barrel export; the orchestrator
// modules import concrete siblings and never this barrel.
export * from './downtime-worker.worker-contract.js';
export {
  createIdleWindowLaunchFence,
  DEFAULT_LAUNCH_CONFIRMATION_GRACE_MS,
} from './downtime-worker.launch-fence.js';
export { createDowntimeWorker } from './downtime-worker.orchestrator.js';
