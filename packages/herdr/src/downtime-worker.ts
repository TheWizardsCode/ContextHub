/**
 * packages/herdr/src/downtime-worker.ts — the downtime-worker barrel
 *
 * Thin, honest re-export barrel for the decomposed downtime-worker family
 * (parent WL-0MVF3F9A7000HKP7). It owns no implementation: every symbol
 * below is re-exported from a sibling module, and consumers keep importing
 * the public surface from `./downtime-worker.js`, so no importer changed.
 * The module layout (module → single responsibility → key exports) lives in
 * docs/dev/downtime-dispatcher.md#module-layout.
 *
 * Contract:
 *  - Ranking (WL-0MTK1ILM2009QYB2): the Herdr list head is the SOLE ranking
 *    path. `dispatchDowntimeWork` and the coordination offer path
 *    (`dispatchFromCoordination` / `computeMostImportantItem`) consume
 *    `deps.getHerdrListHead` and apply every remaining safety gate as a
 *    sequential FILTER; nothing re-implements ranking.
 *  - Fail-closed: "never dispatch, never throw" is the safe default at every
 *    boundary (see the source modules and the dispatcher docs).
 *  - Surface (Q2 refinement): only symbols a consumer actually imports from
 *    this exact path are re-exported; unused exports stay internal to the
 *    modules. The one deliberate exception is `StalledScanOptions` below —
 *    re-exported to keep the split guard's recorded pre-existing type-only
 *    `stalled-work ↔ downtime-worker` cycle edge intact (nothing imports it
 *    from the barrel at runtime).
 */

// ── External type-only edges (guard baseline) ─────────────────────────
// `LOCAL_PREFERENCE_ENV_VAR` is the one external runtime value re-exported
// (test-imported); the other three edges are type-only and exist to keep the
// pre-existing cycle edges in the split guard's frozen baseline.
export { LOCAL_PREFERENCE_ENV_VAR } from './local-preference.js';
export type { StalledScanOptions } from './stalled-work.js';
export type { ScheduledPrompt } from './scheduled-prompts.js';
export type { CoordinationEntry } from './coordination.js';

// ── Constants, types, clamps (WL-0MVN6UUEH009GID8) ────────────────────
export {
  DEFAULT_DOWNTIME_AUDIT_BATCH_MAX,
  DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
  DEFAULT_DOWNTIME_LONG_RUNNING_THRESHOLD_MS,
  DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS,
  DEFAULT_DOWNTIME_MAX_ATTEMPTS,
  DEFAULT_DOWNTIME_MODEL,
  DEFAULT_DOWNTIME_NON_TERMINAL_COOLDOWN_MS,
  DEFAULT_DOWNTIME_NO_CANDIDATE_COOLDOWN_MS,
  DEFAULT_DOWNTIME_POLL_INTERVAL_MS,
  DEFAULT_DOWNTIME_PROXY_URL,
  DEFAULT_DOWNTIME_REQUIRED_FREE_SLOTS,
  DEFAULT_DOWNTIME_STALL_SCAN_ENABLED,
  DEFAULT_DOWNTIME_STALL_THRESHOLD_MS,
  DOWNTIME_AUDIT_BATCH_MAX_MAX,
  DOWNTIME_AUDIT_BATCH_MAX_MIN,
  DOWNTIME_AUDIT_MIN_FREE_SLOTS,
  DOWNTIME_AUDIT_RECENCY_WINDOW_MS,
  DOWNTIME_AUDIT_STALE_WINDOW_MS,
  DOWNTIME_DECISION_LOG_MIN_INTERVAL_MS,
  DOWNTIME_DISPATCH_EXTEND_MAX,
  DOWNTIME_LONG_RUNNING_THRESHOLD_FLOOR_MS,
  DOWNTIME_LONG_RUNNING_THRESHOLD_MAX_MS,
  DOWNTIME_MAX_ATTEMPTS_MAX,
  DOWNTIME_MAX_ATTEMPTS_MIN,
  DOWNTIME_NON_TERMINAL_COOLDOWN_FLOOR_MS,
  DOWNTIME_NON_TERMINAL_COOLDOWN_MAX_MS,
  DOWNTIME_NO_CANDIDATE_COOLDOWN_FLOOR_MS,
  DOWNTIME_POLL_INTERVAL_FLOOR_MS,
  DOWNTIME_RUN_TIMEOUT_MS,
  DOWNTIME_WL_TIMEOUT_MS,
  LOCAL_DISPATCH_LEASE_MAX_SECONDS,
  LOCAL_FALLBACK_REASON_HEADER,
  LOCAL_PREFERENCE_HEADER,
  LOCAL_RESERVATION_HEADER,
  LOCAL_RESERVATION_TICKET_ENV,
  LOCAL_RESERVE_PATH,
  LOCAL_ROUTE_HEADER,
  MAX_DOWNTIME_STALL_THRESHOLD_MS,
  MIN_DOWNTIME_STALL_THRESHOLD_MS,
  decisionHeaderToken,
  isTransientDowntimeError,
  reportedIdleSeconds,
  withTransientRetry,
} from './downtime-worker.constants.js';
export type {
  AuditCandidate,
  DowntimeActiveAuditResult,
  DowntimeCandidate,
  DowntimeClaimExpected,
  DowntimeClaimResult,
  DowntimeHerdrItem,
  DowntimeHerdrListResult,
  DowntimeItemInfo,
  DowntimeItemResult,
  DowntimeNextResult,
  DowntimeSkillKind,
  DowntimeStage,
  HerdrPaneRecord,
  ImplementCandidate,
  InFlightPanes,
  LlamaSlot,
  LlamaStatus,
  LocalReservationGrantedBody,
  LocalReservationRefusedBody,
  LocalReserveFetcher,
  RunningPanesResult,
} from './downtime-worker.types.js';
export {
  clampDowntimeAuditBatchMax,
  clampDowntimeIdleThresholdMs,
  clampDowntimeLongRunningThresholdMs,
  clampDowntimeMarkerStaleWindowMs,
  clampDowntimeMaxAttempts,
  clampDowntimeNoCandidateCooldownMs,
  clampDowntimeNonTerminalCooldownMs,
  clampDowntimePollInterval,
  clampDowntimeRequiredFreeSlots,
  clampDowntimeStallThresholdMs,
} from './downtime-worker.clamps.js';

// ── Selection + parsers (WL-0MVLIHYOU000YQ0R) ─────────────────────────
export {
  classifyWindowHold,
  heldAssigneesOf,
  isAssigneeHeld,
  isSoftDeleted,
  resolveDependencyFrontier,
  selectAuditCandidate,
  selectCriticalCandidate,
  selectImplementCandidate,
  selectNextCandidate,
  selectWithRotation,
  toDowntimeCandidate,
  toImplementCandidate,
} from './downtime-worker.selection.js';
export {
  criticalSkillKind,
  parseAuditCandidatesOutput,
  parseCriticalCandidatesOutput,
  parseDepListBlockersOutput,
  parseImplementCandidatesOutput,
  parseInProgressOutput,
  parseNextCandidatesOutput,
  parseNextItemOutput,
  parseShowItemOutput,
  parseShownWorkItem,
  skillKindFromPrompt,
} from './downtime-worker.parsers.js';
export type { CriticalCandidate } from './downtime-worker.parsers.js';

// ── Idle detection + poller (WL-0MVLIHY1P002WP0D) ──────────────────────
export {
  countFreeUnownedSlots,
  createIdleTracker,
  createPerSlotIdleTracker,
  evaluateIdle,
  evaluatePrefillPacing,
  isIdleStatus,
  isSlotAvailableForDispatch,
  isSlotOwned,
} from './downtime-worker.idle.js';
export { createDowntimePoller, fetchLocalStatus, parseLlamaStatus } from './downtime-worker.poller.js';

// ── Pane spawn + lifecycle (WL-0MVLIHZBT006B1UI) ───────────────────────
export {
  DOWNTIME_PANE_LABEL_PREFIX,
  REPOSITORY_OVERRIDE_ENV_VARS,
  buildDowntimePaneArgs,
  buildDowntimeSpawnOptions,
  countRunningDowntimePanes,
  defaultDowntimeSpawn,
  isSafeDowntimePaneToClose,
  monitorDispatchedPanes,
  paneLabelItemId,
  parseHerdrPaneListOutput,
  resolveInFlightPanes,
  runningDowntimePaneItemIds,
  scrubRepositoryOverrides,
  spawnDowntimePane,
} from './downtime-worker.pane.js';
export type { DowntimeSpawn, DowntimeSpawnResult } from './downtime-worker.pane.js';

// ── Gates + stalled-resume (WL-0MVLIHZZI004D7EK) ───────────────────────
export {
  classifyItemForDispatch,
  computeAuditEligibleDepth,
  evaluateCriticalFirstGuard,
  fetchExtendedHerdrItems,
  finalizeAuditBatchOutcome,
  isAttemptBudgetExhausted,
  readReviewQueueGate,
  resolveAuditBatchStatus,
} from './downtime-worker.gates.js';
export type { AuditBatchOutcomeShape, DowntimeGateDeps } from './downtime-worker.gates.js';
export { resumeStalledWorkIfAble } from './downtime-worker.stalled-resume.js';
export { BLOCKED_QUESTIONS_INSTRUCTION, buildDowntimeDispatchComment, buildDowntimePrompt } from './downtime-worker.prompts.js';

// ── Dispatch pipeline (WL-0MVLII0NO007JJBA) ────────────────────────────
// The filter and claim pipeline are internal to the dispatch entry (Q2
// refinement); only consumer-used symbols keep a barrel export.
export { selectCriticalFirstCandidates } from './downtime-worker.dispatch-filter.js';
export { CPU_SATURATED_REASON } from './downtime-worker.dispatch-cpu-gate.js';
export { dispatchDowntimeWork } from './downtime-worker.dispatch.js';
export type {
  DowntimeDispatchEnrichmentEvent,
  DowntimeDispatchEvent,
  DowntimeDispatchFailureEvent,
  DowntimeErrorEvent,
} from './downtime-worker.dispatch-contract.js';
export {
  DEFAULT_LOCAL_RESERVATION_EXPECTED_TOKENS,
  buildLocalReservationRequest,
  createLocalReserver,
  parseLocalReservationResponse,
} from './downtime-worker.local-reservation.js';

// ── Coordination (WL-0MVLII1AO007TTRK) ─────────────────────────────────
export { computeMostImportantItem, coordinationTierRank } from './downtime-worker.coordination.js';
export { dispatchFromCoordination } from './downtime-worker.coordination-leader.js';
export { runCoordinationCheckIn } from './downtime-worker.coordination-checkin.js';
export {
  dominantGateOf,
  isWindowFullyHeld,
  summariseEmptyOffer,
} from './downtime-worker.offer-attribution.js';
export type {
  CoordinationOfferRejection,
  DispatchGateToken,
  EmptyOfferAttribution,
  EmptyOfferReason,
  OfferRejection,
} from './downtime-worker.offer-attribution.js';

// ── Worker contract + orchestrator (WL-0MVLII2080074S5L) ──────────────
export type { DowntimeWorker, DowntimeWorkerDeps } from './downtime-worker.worker-contract.js';
export {
  DEFAULT_LAUNCH_CONFIRMATION_GRACE_MS,
  createIdleWindowLaunchFence,
} from './downtime-worker.launch-fence.js';
export { createDowntimeWorker } from './downtime-worker.orchestrator.js';
