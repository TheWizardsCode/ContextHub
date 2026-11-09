/**
 * packages/herdr/src/downtime-log.ts — bounded rolling logs for herdr
 * downtime dispatches (re-export barrel).
 *
 * The log lives at `<cwd>/.worklog/downtime-dispatches.log` (the `.worklog`
 * directory is gitignored, so the file is a local artifact; the worklog
 * comment added alongside it is the durable cross-machine trail). F6
 * WL-0MTII4CWT00452HU decision: dispatch/coordination logs stay per-root
 * (retained location) for per-project observability; the single
 * machine-wide coordination file/lease is authoritative for dispatch
 * decisions, but logs are not migrated — stale per-worklog coordination
 * files do not imply log migration. The file is bounded — only the most
 * recent `DOWNTIME_LOG_MAX_ENTRIES` entries are kept — so it rolls instead of
 * growing unbounded over a long-lived plugin pane. The COORDINATION log
 * (`.worklog/downtime-coordination.log`) instead rotates size-based with N
 * kept (WL-0MVKNC28B003UOLX): it holds 24 h of decision history with bounded
 * disk — see `COORDINATION_LOG_MAX_ENTRIES` /
 * `COORDINATION_LOG_MAX_ROTATED_FILES`. Callers must treat failures as
 * fail-closed (never crash the worker).
 *
 * The log doubles as the dispatched-marker source for the audit tier
 * (WL-0MSLIY8ZR004QUSY): `readDowntimeLogEntries` + `auditDispatchedItemIds`
 * let the audit-tier selection exclude items the downtime worker has already
 * dispatched for `/skill:audit`, closing the re-selection loop where a
 * dispatched run reverts the item to completed/in_review without a fresh
 * audit.
 *
 * ## Module layout (WL-0MVGKHFT4003X6JW)
 *
 * This file is a **thin barrel**: the module doc comment plus re-export
 * statements only, re-exporting exactly the surface consumers import from
 * `./downtime-log.js`. Every behaviour lives in a single-responsibility
 * sibling module, and no family module exceeds 1,000 lines (enforced by
 * `downtime-log.split-guard.test.ts`):
 *
 * | Module | Single responsibility |
 * |---|---|
 * | `downtime-log-storage.ts` | File names, retention/rotation policy, atomic bounded JSONL append, tolerant line parsing |
 * | `downtime-log-budget.ts` | Host-budget refusal vocabulary + evidence shape (pure leaf) |
 * | `downtime-log-coordination.ts` | Coordination/decision entry shape, append, readers, per-hour reason tally |
 * | `downtime-log-entries.ts` | Dispatch-log entry shapes, pane-close lifecycle entries, fail-closed appends, marker predicate |
 * | `downtime-log-markers.ts` | Dispatched-marker readers, staleness/stage guards, attempt budget, pane-close cooldown |
 * | `downtime-log-recent.ts` | Read-only "recent dispatches" projection and its 4-hour UTC time blocks |
 *
 * Layering: the extracted modules import concrete siblings and never this
 * barrel, so the import graph stays acyclic.
 */

// ── Storage: file names, retention policy, atomic append ──────────────
export {
  COORDINATION_LOG_FILE,
  DOWNTIME_LOG_FILE,
  COORDINATION_LOG_MAX_ENTRIES,
  COORDINATION_LOG_MAX_ENTRIES_CEILING,
  COORDINATION_LOG_MAX_ROTATED_FILES,
  COORDINATION_LOG_MAX_ROTATED_FILES_CEILING,
  COORDINATION_LOG_MIN_ENTRIES,
  DOWNTIME_LOG_MAX_ENTRIES,
  coordinationLogPolicyFromConfig,
  resolveCoordinationLogPolicy,
} from './downtime-log-storage.js';
export type {
  CoordinationLogPolicy,
  CoordinationLogPolicyInput,
} from './downtime-log-storage.js';

// ── Host-wide dispatch-budget vocabulary ──────────────────────────────
export {
  HOST_BUDGET_AUDIT_REASON,
  HOST_BUDGET_DECISION_REASONS,
  HOST_BUDGET_IMPLEMENT_REASON,
  HOST_BUDGET_UNKNOWN_REASON,
  isHostBudgetDecisionReason,
} from './downtime-log-budget.js';
export type {
  HostBudgetDecisionReason,
  HostBudgetEvidence,
} from './downtime-log-budget.js';

// ── Coordination / decision log ───────────────────────────────────────
export {
  appendCoordinationLogEntry,
  hourlyReasonTally,
  readCoordinationLogAllEntries,
  readCoordinationLogEntries,
} from './downtime-log-coordination.js';
export type {
  CoordinationLogEntry,
  HourlyReasonCount,
} from './downtime-log-coordination.js';

// ── Dispatch log + pane-close lifecycle entries ───────────────────────
export {
  appendDowntimeLogEntry,
  appendPaneCloseLogEntry,
  readDowntimeLogEntries,
} from './downtime-log-entries.js';
export type {
  DowntimeLogEntry,
  PaneCloseLogEntry,
  PaneLifecycleKind,
  PaneLifecycleOutcome,
} from './downtime-log-entries.js';

// ── Dispatched-marker readers and suppression decisions ───────────────
export {
  auditDispatchedItemIds,
  countAttempts,
  dispatchedItemMarkers,
  dispatchedItemStages,
  implementDispatchedItemIds,
  intakeDispatchedItemStages,
  isNonTerminalCooldownActive,
  markerStillExcludes,
  planDispatchedItemStages,
  recentAuditDispatchedItemIds,
  recentDispatchedItemIds,
  riskEffortDispatchedItemIds,
} from './downtime-log-markers.js';
export type {
  DispatchMarker,
  MarkerStageGuardMode,
} from './downtime-log-markers.js';

// ── Recent-dispatches projection and time blocks ──────────────────────
export {
  DISPATCH_TIME_BLOCK_HOURS,
  UNKNOWN_DISPATCH_TITLE,
  UNKNOWN_TIME_BLOCK_LABEL,
  dispatchTimeBlockLabel,
  groupRecentDispatchesByTimeBlock,
  recentDispatchedItems,
} from './downtime-log-recent.js';
export type {
  DispatchTimeBlock,
  RecentDispatchRow,
} from './downtime-log-recent.js';
