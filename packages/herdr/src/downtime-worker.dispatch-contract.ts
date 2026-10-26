/**
 * packages/herdr/src/downtime-worker.dispatch-contract.ts — the dispatch
 * pipeline's contract: the dependency boundary it uses and the event/outcome
 * types it produces.
 *
 * Single responsibility: describe a downtime dispatch — the event recorded for
 * it, the outcome reported for it, the reservation evidence carried on it —
 * and the external seams the dispatch pipeline calls.
 *
 * Parent: WL-0MVF3F9A7000HKP7 (decompose the `downtime-worker.ts` god class).
 * Moved verbatim out of `downtime-worker.ts` by WL-0MVLII0NO007JJBA (extract
 * the downtime-worker dispatch pipeline) and re-exported from the barrel.
 * No behaviour change.
 *
 * ## Why the deps boundary is a structural slice, not `DowntimeWorkerDeps`
 *
 * `DowntimeWorkerDeps` stays in the barrel until the final 'thin barrel'
 * child, and it references types from modules that import the barrel back
 * (`stalled-work.ts`, `long-running-panes.ts`). Importing the barrel — even as
 * `import type` — joins the split guard's frozen cycle baseline, which the
 * guard rejects. So the pipeline declares the structural subset it actually
 * touches, exactly as `downtime-worker.pane.ts` and
 * `downtime-worker.gates.ts` already do: every member below is the same
 * optional method `DowntimeWorkerDeps` declares, so callers keep passing the
 * full deps object unchanged. Keep the two in sync when a seam changes.
 */

import type { HostCpuReading, HostCpuSource } from './host-cpu.js';
import type {
  LocalPreference,
  LocalPreferenceMode,
  LocalPreferenceReason,
} from './local-preference.js';
import type { ScheduledPrompt } from './scheduled-prompts.js';
import type { PaneLifecycleKind } from './downtime-log.js';
import type {
  DispatcherAnchor,
  DispatcherPrefixTabAnchor,
  ItemTabAnchor,
  ProjectWorkspaceTarget,
} from './dispatcher-anchor.js';
import type { DowntimeSpawnResult } from './downtime-worker.pane.js';
import type { DowntimeAuditBatchStatus } from './downtime-worker.gates.js';
import type {
  DowntimeActiveAuditResult,
  DowntimeCandidate,
  DowntimeClaimExpected,
  DowntimeClaimResult,
  DowntimeDispatchKind,
  DowntimeHerdrListResult,
  DowntimeNextResult,
  DowntimeStage,
  LocalReservationRequest,
  LocalReservationResult,
  RunningPanesResult,
  StalledPaneCandidate,
  StalledScanOptions,
} from './downtime-worker.types.js';

/**
 * The dispatch-facing slice of `DowntimeWorkerDeps`: the seams the Herdr-head
 * filter, the claim pipeline, the scheduled-prompt tier and the dispatch entry
 * call. See the module doc for why this is a structural copy.
 */
export interface DowntimeDispatchDeps {
  /** Herdr list head — the sole ranking source (see `DowntimeWorkerDeps`). */
  getHerdrListHead(cwd: string, limit?: number): Promise<DowntimeHerdrListResult>;
  /** `wl next --stage <stage>` lookup (see `DowntimeWorkerDeps.getNextItem`). */
  getNextItem(stage: DowntimeStage, cwd: string): Promise<DowntimeNextResult>;
  /** Audit-tier candidate lookup (see `DowntimeWorkerDeps`). */
  getNextAuditCandidate(cwd: string): Promise<DowntimeNextResult>;
  /** Review-queue depth read (see `DowntimeWorkerDeps`). */
  getReviewQueueCount(cwd: string): Promise<number | null>;
  /** Active-audit single-flight read (see `DowntimeWorkerDeps`). */
  getActiveAudit(cwd: string): Promise<DowntimeActiveAuditResult>;
  /** Running-downtime-panes liveness query (see `DowntimeWorkerDeps`). */
  getRunningDowntimePanes?(cwd: string): Promise<RunningPanesResult>;
  /** Implement-tier candidate lookup (see `DowntimeWorkerDeps`). */
  getNextImplementCandidate(cwd: string): Promise<DowntimeCandidate | null>;
  /** Critical-first candidate lookup (see `DowntimeWorkerDeps`). */
  getNextCriticalCandidate(cwd: string): Promise<DowntimeNextResult>;
  /** Interim audit-freshness re-check (see `DowntimeWorkerDeps`). */
  hasFreshAudit(itemId: string, cwd: string): Promise<boolean>;
  /**
   * Code-freeze marker status (see `DowntimeWorkerDeps.readCodeFreezeStatus`
   * and `CodeFreezeStatus` in `code-freeze.ts`; the union is spelled out here
   * because `code-freeze.ts` is inside the split guard's cycle baseline).
   */
  readCodeFreezeStatus(cwd: string): 'frozen' | 'not-frozen' | 'ambiguous';
  /** Host-CPU reading for the CPU gate (see `DowntimeWorkerDeps`). */
  readHostCpu?(): HostCpuReading;
  /** CAS claim (see `DowntimeWorkerDeps.claimItem`). */
  claimItem(
    itemId: string,
    expected: DowntimeClaimExpected,
    cwd?: string,
    migrateStage?: string,
  ): Promise<DowntimeClaimResult>;
  /** Pane spawn with placement/anchor overrides (see `DowntimeWorkerDeps`). */
  spawnAgentPane(
    prompt: string,
    opts: {
      model: string;
      cwd: string;
      paneName?: string;
      itemTitle?: string;
      itemId?: string;
      anchorId?: string;
      priority?: string | null;
      reservationTicketId?: string;
      localPreference?: LocalPreference;
    },
  ): Promise<DowntimeSpawnResult>;
  /** Local capacity reservation (see `DowntimeWorkerDeps`). */
  reserveLocalCapacity?(request: LocalReservationRequest): Promise<LocalReservationResult | null>;
  /** Machine-wide Dispatcher anchor (see `DowntimeWorkerDeps`). */
  getDispatcherAnchor?(cwd: string): Promise<DispatcherAnchor | null>;
  /** Project workspace resolution (see `DowntimeWorkerDeps`). */
  resolveProjectWorkspace?(cwd: string): Promise<ProjectWorkspaceTarget | null>;
  /** Item-ID tab anchor (see `DowntimeWorkerDeps.getItemTabAnchor`). */
  getItemTabAnchor?(
    cwd: string,
    workspaceId: string,
    itemId: string,
  ): Promise<ItemTabAnchor | null>;
  /** Per-prefix Dispatcher tab anchor (see `DowntimeWorkerDeps`). */
  getDispatcherTabAnchor?(
    cwd: string,
    prefix: string,
  ): Promise<DispatcherPrefixTabAnchor | null>;
  /** Dispatch trail: marker write + item comment (see `DowntimeWorkerDeps`). */
  recordDispatch(event: DowntimeDispatchEvent): Promise<boolean>;
  /** First DUE scheduled prompt (see `DowntimeWorkerDeps`). */
  getDueScheduledPrompt(cwd: string): Promise<ScheduledPrompt | null>;
  /** Persist a scheduled prompt's trigger time (see `DowntimeWorkerDeps`). */
  recordScheduledPromptTrigger(cwd: string, promptId: string, at: string): Promise<boolean>;
  /** Spawn-failure trace (see `DowntimeWorkerDeps`). */
  recordDispatchFailure(event: DowntimeDispatchFailureEvent): Promise<void>;
  /** Best-effort post-spawn enrichment (see `DowntimeWorkerDeps`). */
  recordDispatchEnrichment?(event: DowntimeDispatchEnrichmentEvent): Promise<void>;
  /** Root-pane close (see `DowntimeWorkerDeps.closePane`). */
  closePane?(
    paneId: string,
    cwd: string,
    expected?: { itemId: string; kind: PaneLifecycleKind },
  ): Promise<boolean>;
  /** CAS claim rollback (see `DowntimeWorkerDeps.rollbackClaim`). */
  rollbackClaim(itemId: string, original: DowntimeClaimExpected, cwd: string): Promise<boolean>;
  /** Machine-wide stalled-work scan (see `DowntimeWorkerDeps`). */
  scanStalledPanes?(cwd: string, opts: StalledScanOptions): Promise<StalledPaneCandidate[]>;
  /**
   * In-place stalled-pane resume (see `DowntimeWorkerDeps.resumeStalledPane`).
   * Narrowed to its `resumed` discriminant so this module stays free of the
   * `stalled-work.ts` types (that module sits inside the cycle baseline).
   */
  resumeStalledPane?(
    candidate: StalledPaneCandidate,
    opts: StalledScanOptions,
  ): Promise<{ resumed: boolean }>;
}

/** Audit event recorded for every successful downtime dispatch. */
export interface DowntimeDispatchEvent {
  itemId: string;
  kind: DowntimeDispatchKind;
  /** ISO-8601 UTC timestamp of the dispatch. */
  dispatchedAt: string;
  /** Worklog root (the rolling log lives at `<cwd>/.worklog`). */
  cwd: string;
  title?: string;
  /**
   * When true, `recordDispatch` skips the work-item comment (scheduled-prompt
   * dispatches have no work item — there is no item to comment; the rolling
   * log marker is the only trace, WL-0MSS1Q5ER007QDKX AC4). Absent/false on
   * normal tier dispatches (comment added, unchanged).
   */
  noItemComment?: boolean;
  /**
   * Worklog stage of the item at dispatch (plan/intake change-guard, RCA
   * WL-0MSRBFFLN005W3VT design point 3): a candidate is excluded while it is
   * still at its dispatched-at stage; a stage advancement releases it.
   * Backward compatible — absent on legacy entries.
   */
  stage?: string;
  /**
   * Which selection loop produced this dispatch (WL-0MUBVL251006JAQ0 / F6):
   * `critical-first` | `normal-scan` | `coordination-offer` |
   * `scheduled-prompt`. Makes the next RCA answerable from the log alone.
   * Backward compatible — absent on legacy entries.
   */
  selectionPath?: string;
  /**
   * Machine-readable reason the candidate was selected (WL-0MUBVL251006JAQ0
   * / F6): e.g. `no-live-pane`, `marker-stale-escalation`, `non-critical`,
   * `scheduled-due`. Paired with `selectionPath`. Backward compatible —
   * absent on legacy entries.
   */
  selectionReason?: string;
  /**
   * Granted local-reservation ticket id forwarded to the pane (parent
   * WL-0MVIKRFP0005JDL8 AC1/AC4, slice C2). Lets the dispatch marker be
   * correlated with the pane's route log. Backward compatible — absent on
   * legacy entries, fail-open dispatches and reservation refusals.
   */
  reservationTicketId?: string;
  /** ISO timestamp the ticket was granted at (parent AC4, slice C2). */
  reservationGrantedAt?: string;
  /**
   * Resolved per-turn locality preference forwarded to the pane
   * (WL-0MVNUIW77000VYAX AC5). Absent on legacy entries and on callers that
   * did not opt into the priority rule.
   */
  localPreference?: LocalPreference;
  /**
   * Why the preference resolved to its value (WL-0MVNUIW77000VYAX AC5):
   * `operator-setting` (persisted `downtimeLocalPreference` won),
   * `priority-low` (the low-priority rule chose `local-only`) or `default`
   * (deployment default kept). Absent on legacy entries; readers ignore it.
   */
  localPreferenceReason?: LocalPreferenceReason;
}

/**
 * Post-spawn enrichment entry (WL-0MUBVL251006JAQ0 / F6 AC6.2/AC6.3): a
 * best-effort SECOND log entry recording the resolved pane/session id for a
 * successful dispatch. It copies `itemId`/`kind`/`stage`/`dispatchedAt` from
 * the success marker verbatim so the marker readers (last-entry-wins,
 * stale-release, fail-closed staleness) see the SAME marker state — the extra
 * fields are additive. `paneId` is `null` when it could not be resolved
 * (never a guess), and appending this entry is fail-open: a failure never
 * blocks or un-marks the dispatch.
 */
export interface DowntimeDispatchEnrichmentEvent extends DowntimeDispatchEvent {
  /** Resolved pane id, or null when it could not be resolved. */
  paneId: string | null;
  /** Discriminator so readers can tell an enrichment from a fresh dispatch. */
  enrichment: true;
}

/**
 * Spawn-failure trace appended to the rolling dispatch log when a pane
 * spawn errors or the script exits non-zero (WL-0MSLWJ3I70031Z8U AC2).
 * Mirrors the dispatch marker's fields (including `stage`, so the marker
 * readers keep excluding the item exactly as the standing marker does) and
 * carries the failure details; the written entry adds
 * `outcome: 'spawn-failed'` so the log distinguishes "attempted" (failed
 * spawn) from "opened" (success marker).
 */
export interface DowntimeDispatchFailureEvent extends DowntimeDispatchEvent {
  /** Spawn-level error message (e.g. ENOENT), when the spawn errored. */
  error?: string;
  /** send-to-pi.sh exit code (null = killed by a signal). */
  exitCode?: number | null;
}

/**
 * Persistent-error event recorded when the wl CLI fails
 * `DOWNTIME_ERROR_STRIKE_LIMIT` times consecutively. Written to the rolling
 * `.worklog` log so the failure is auditable even though no dispatch occurs.
 */
export interface DowntimeErrorEvent {
  /** Worklog root (the rolling log lives at `<cwd>/.worklog`). */
  cwd: string;
  /** ISO-8601 UTC timestamp of the error. */
  at: string;
  message: string;
  /** Underlying wl/CLI error (timeout, SQLITE_BUSY, parse failure, stderr) — WL-0MTL4PC0Y005GXTI. */
  error?: string;

  // ── Enriched per-strike fields (WL-0MTJPYM53003ORCV) ──

  /** Excerpt of stderr from the failing wl CLI invocation, truncated to 200 chars with `[truncated]` marker if longer. */
  stderrExcerpt?: string;
  /** Exit code from the failing wl CLI spawn (null = killed by signal). */
  exitCode?: number | null;
  /** Timeout in ms that was configured for the wl CLI invocation. */
  timeoutMs?: number;
  /** Work item id that was being dispatched when the error occurred. */
  workItemId?: string;
  /** The wl subcommand that failed (e.g. "wl show <id>", "wl close <id>"). */
  command?: string;
  /** Which strike this is in the three-strike sequence (1, 2, or 3). */
  attempt?: number;
  /** Distinguishes coordination probe failures from dispatch-path CLI failures.
   * `"coordination-probe"` = worklog probe failed while shared coordination file held no dispatchable entry.
   * `"dispatch-cli"` = wl CLI error during dispatch (spawn-failed / claim-failed / fetchItem failure). */
  probeContext?: string;
}

export interface DowntimeDispatchOutcome {
  dispatched: boolean;
  candidate?: DowntimeCandidate;
  kind?: DowntimeDispatchKind;
  /**
   * Non-dispatch reasons: 'dispatch-in-flight' | 'no-candidate' |
   * 'wl-error' | 'code-freeze' | 'claim-failed' (lost the CAS race —
   * another pane won; neutral) | 'marker-write-failed' (fail-closed abort
   * BEFORE spawn — includes the scheduled-prompt persist failure) |
   * 'claim-rolled-back' (WL-0MT32F908002YFFA: the marker write failed
   * AFTER a successful claim and the claim was rolled back to its
   * pre-claim status+stage — the item is re-selectable next idle period;
   * neutral) |
   * 'spawn-failed' (handled spawn error or non-zero script exit; the
   * failure trace is appended to the rolling log, the claim is rolled back
   * to its pre-claim status+stage and the spawn-failed marker is
   * non-excluding (WL-0MT32F908002YFFA AC2/AC4) so the item is re-selectable
   * next idle period — the outcome is still NOT success) | 'anchor-unavailable' (C0 WL-0MTR01EU7005SYZG: the
   * machine-wide Dispatcher anchor pane could not be provisioned — neutral
   * "no dispatch this cycle", never a fallback to the leader's pane) |
   * 'audit-in-flight' (WL-0MT3PHW4I002SNOV: an audit is
   * in flight) | 'audit-host-saturated' (WL-0MUIVE0YG000UVIA: the
   * machine-wide active-audit marker shows an audit running on this host —
   * dispatched by ANY project/instance — so the audit tier is deferred
   * host-wide) | 'fresh-audit-skip' (WL-0MT8KSTOE00871E7: a fresh audit
   * was recorded during interim). When `reason` is 'wl-error', `error`
   * may carry the underlying wl/CLI error details (timeout, SQLITE_BUSY,
   * parse failure, stderr) for the three-strike pause log.
   * already running — a non-stale kind=audit dispatch marker maps to an
   * `in_progress` item — so the audit tier was skipped; a skip that leaves
   * an empty remaining backlog reports this reason, NEVER 'no-candidate',
   * so the no-candidate cooldown is not entered while the audit runs) |
   * 'fresh-audit-skip' (WL-0MT8KSTOE00871E7: a valid audit was recorded
   * during the interim between candidate selection and dispatch, so the
   * audit tier was skipped — an empty remaining backlog reports this
   * reason, NEVER 'no-candidate', so the cooldown is not entered while
   * the item is already audited).
   */
  reason?: string;
  /**
   * Spawn-level error message ('spawn-failed' trace, e.g. ENOENT on
   * send-to-pi.sh — WL-0MSLWJ3I70031Z8U AC2).
   */
  error?: string;
  /**
   * send-to-pi.sh exit code ('spawn-failed' trace; null = killed by a
   * signal — WL-0MSLWJ3I70031Z8U AC2).
   */
  exitCode?: number | null;

  // ── Enriched per-strike error fields (WL-0MTJPYM53003ORCV) ──

  /** Timeout in ms that was used for the wl CLI call that failed. */
  timeoutMs?: number;
  /** Work item id being dispatched (set on dispatch-tier failures). */
  workItemId?: string;

  /**
   * True when this successful dispatch was sourced from the leader's OWN
   * backlog beyond the sprint-view window by the fallback (parent
   * WL-0MUU4XFU90008E24 AC1/AC4). The worker loop uses this machine-readable
   * surface to perform the voluntary `releaseLeadership()` step-down exactly
   * once per own-backlog dispatch, and never for a normal in-view dispatch.
   * Absent/false on every other outcome.
   */
  ownBacklogDispatch?: boolean;

  /**
   * Depth-aware audit-batch surface (parent WL-0MVEDM8OT007WDRS AC1/AC2/AC3).
   * Present on every AUDIT dispatch and on pre-selection gate refusals of an
   * audit-batch continuation; absent on non-audit dispatches and on hard
   * dispatch failures (spawn/marker/anchor/claim-rollback), which end the
   * batch without a continuation surface. The worker loop defers the
   * post-dispatch idle-tracker reset ONLY when `kind === 'audit'` and this
   * status reports `active === true` with `remaining > 0`.
   */
  auditBatch?: DowntimeAuditBatchStatus;

  /**
   * True when this outcome came from an AUDIT-BATCH CONTINUATION — the leader
   * sourced the target from its own Herdr head while a batch was armed
   * (parent WL-0MVEDM8OT007WDRS AC4, implementation WL-0MVFE1DD8000D8T2).
   *
   * The worker loop uses it to keep the leadership hand-off deferred: the
   * own-backlog step-down (`releaseLeadership()`) must happen exactly once, at
   * BATCH END, never mid-batch. `dispatchFromCoordination` therefore raises
   * `ownBacklogDispatch` for a continuation only when that dispatch ends the
   * batch (cap reached / depth dropped); every other continuation leaves both
   * flags false so the leader keeps draining its own head within the same
   * idle window. Absent on every non-continuation outcome.
   */
  auditBatchContinuation?: boolean;

  /**
   * Local-capacity reservation evidence from this dispatch attempt (parent
   * WL-0MVIKRFP0005JDL8 AC1/AC2/AC4, slice C2). Present on a reservation
   * REFUSAL (admit `false` + the proxy's `retryAfterS`) and on a granted
   * ticket that could not be forwarded (spawn failure → `reservationReleased`).
   * Absent when no reservation was attempted (no client wired / fail-open
   * older proxy) and on a successful dispatch (the ticket is forwarded to the
   * pane instead). The worker loop copies these fields onto the no-dispatch
   * decision entry so the log answers "why did we not launch?".
   */
  reservation?: DowntimeReservationEvidence;

  /**
   * Host-CPU gate evidence (WL-0MVK0UO3Q002TXW6 AC4): present on a
   * `cpu-saturated` outcome — the measured utilisation, its source and the
   * live threshold — so the worker loop can copy it onto the decision entry.
   * Absent on every other outcome.
   */
  hostCpuPercent?: number;
  hostCpuSource?: HostCpuSource;
  cpuGatePercent?: number;
}

/**
 * Reservation evidence carried by a dispatch outcome and copied onto the
 * polled decision entry (parent AC4). Field names mirror
 * {@link DecisionEntryFields} so the worker loop can spread it directly.
 */
export interface DowntimeReservationEvidence {
  reservationTicket?: { id: string; grantedAt: string };
  admit?: boolean;
  projectedWaitS?: number;
  retryAfterS?: number;
  reservationReleased?: boolean;
}
