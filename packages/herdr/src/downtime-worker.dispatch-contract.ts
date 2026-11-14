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
import type { DowntimeAuditBatchStatus, AuditCandidateScopeResult } from './downtime-worker.gates.js';
import type { CoordinationOfferRejection } from './downtime-worker.offer-attribution.js';
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
  /**
   * Leaf-vs-parent scope lookup for an audit candidate (see
   * `DowntimeWorkerDeps.getAuditCandidateScope`). `wl show <id> --children
   * --json` mapped to `{ok:true, scope}` / `{ok:false}`; callers classify
   * through `classifyAuditScope`, which treats `{ok:false}` as `'parent'`.
   */
  getAuditCandidateScope(itemId: string, cwd: string): Promise<AuditCandidateScopeResult>;
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
  /**
   * Host-wide dispatch-budget admission (WL-0MVXY0YG7009JMHI F3, audit tier
   * WL-0MVXY0XPF006YUHA F2): the ONE machine-scoped ledger read per dispatch
   * attempt, called in `dispatchClaimedTier` immediately before the dispatch
   * marker is written so both dispatcher paths funnel through it (F3 AC1).
   * Applies to the `implement` and `audit` kinds — plan/intake/risk-effort are
   * never budgeted. Optional — absent means no host budget (legacy/test callers
   * stay byte-identical).
   */
  admitHostDispatch?(
    input: DowntimeHostBudgetAdmissionInput,
  ): Promise<DowntimeHostBudgetAdmission>;
  /**
   * Record the spawned pane id on a reserved budget entry (AC3 "confirm").
   * Countable in the ledger's liveness rules for the implement tier (the audit
   * tier counts a fresh entry regardless, as the retired marker did).
   * Best-effort.
   */
  confirmHostDispatch?(
    itemId: string,
    kind: DowntimeDispatchKind,
    paneId: string,
    cwd: string,
  ): Promise<void>;
  /**
   * Release a host-budget reservation (AC3): every abort path in the claim
   * pipeline, and the pane-close handler. Idempotent, never throws.
   *
   * `release` carries the identity the caller owns
   * (WL-0MWFJD5T4003OM91) — `kind` + the admission `attemptId` (or the closed
   * `paneId`) — and its `reason` lands in the ledger's audit trail
   * (WL-0MWFJDGXQ001OXP8). Releasing by item id alone could delete a
   * still-running dispatch's entry, which is the defect this replaces.
   */
  releaseHostDispatch?(
    itemId: string,
    cwd: string,
    release?: DowntimeHostBudgetRelease,
  ): Promise<void>;
  /**
   * Release a dispatched audit's PROXY LEASE (WL-0MWFJH3NW006F5GN AC3):
   * called on every terminal path after an audit ADMITTED with a held lease
   * (marker-write failure, spawn failure, anchor-unavailable, pane close) so
   * a released audit never holds the shared GPU past its own run. The session
   * id is derived from the item id (`auditLeaseSessionId(itemId)`), so no
   * state is threaded. Must be idempotent and never throw — an unheld session
   * is a successful no-op and a leaked lease is bounded by the proxy's own
   * expiry (the availability read reports `reclaimed`). OPTIONAL — absent for
   * legacy/test callers means the release is skipped (the dispatch outcome is
   * never changed by a release failure).
   */
  releaseAuditLease?(
    itemId: string,
    cwd: string,
    release?: { reason?: string },
  ): Promise<void>;
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

/**
 * Host-budget admission request (WL-0MVXY0YG7009JMHI F3): one dispatch asking
 * the machine-scoped ledger whether it may start. Structurally mirrors
 * `host-dispatch-budget.ts`'s admission input so the dispatch pipeline depends
 * on the seam, not on the ledger module.
 */
export interface DowntimeHostBudgetAdmissionInput {
  itemId: string;
  /**
   * Dispatch kind. The `implement` and `audit` kinds are budgeted; the pipeline
   * only calls the seam for those two.
   */
  kind: DowntimeDispatchKind;
  /** Worklog root the dispatch operates on. */
  cwd: string;
}

/**
 * Host-budget admission verdict. `live`/`max` are the tier's observed count and
 * configured cap, carried on the outcome as evidence (F3 AC2).
 */
export interface DowntimeHostBudgetAdmission {
  admitted: boolean;
  live: number;
  max: number;
  /**
   * Refusal token. The implement tier uses `host-budget-implement` /
   * `host-budget-unknown`. The audit tier is proxy-derived
   * (WL-0MWAMSK9H005BOHD) and reports the proxy's own vocabulary
   * (`audit-budget-saturated` / `audit-budget-unknown`); only the one-release
   * `HERDR_AUDIT_LOCAL_BUDGET=1` legacy path still reports
   * `host-budget-audit` / `audit-host-saturated` / `host-budget-unknown`.
   */
  reason?: string;
  /**
   * The failing exchange on a fail-closed audit-budget refusal
   * (`audit-budget-unknown`): the name the proxy read failed with
   * (`http-404`, `timeout`, `network`, `http-<status>`, `bad-body`,
   * `seam-absent`) — see {@link AuditAvailabilityOutcome}. Absent on an
   * implement refusal and on a `saturated` (proxy answered) audit refusal,
   * where there is no failing exchange. Carried through to the decision entry
   * so the log names the broken contract without reading code
   * (WL-0MWDDHVF2004PTYX AC3).
   */
  detail?: string;
  /** True when an unreadable ledger was rewritten from live panes (AC6). */
  repaired?: boolean;
  /**
   * The reservation's attempt token (WL-0MWFJD5T4003OM91). Carried on the
   * verdict so every abort path of THIS attempt releases by identity — it can
   * only ever remove this dispatch's own entry.
   */
  attemptId?: string;
  /**
   * The PROXY AUDIT LEASE this admission holds (WL-0MWFJH3NW006F5GN AC1):
   * present on an AUDIT admission whose acquire answered `200`. The release
   * discipline re-derives the session id from the item id
   * (`auditLeaseSessionId(itemId)`), so this is evidence for the decision log
   * and the TTL-bound assertion, not a threaded handle.
   */
  lease?: { sessionId: string; expiresAt?: number };
  /**
   * The proxy's bounded `retry_after_s` cooldown on a `429` lease refusal
   * (WL-0MWFJH3NW006F5GN AC2): carried on the `audit-budget-saturated`
   * refusal so the dispatcher honours the proxy's deferral advice. Absent
   * when the proxy did not serve one or the refusal was not a 429.
   */
  retryAfterS?: number;
}

/**
 * What a release must prove it owns (WL-0MWFJD5T4003OM91).
 *
 * The ledger entry key is `itemId` + `kind`; ownership is proven by the
 * `attemptId` the admission verdict carries, or by the confirmed `paneId` on a
 * pane-close path. A release that proves neither is refused by the ledger
 * rather than deleting whichever entry happens to share the item id.
 */
export interface DowntimeHostBudgetRelease {
  /** Entry kind (`implement`/`audit`); omitted by the pane-close path. */
  kind?: DowntimeDispatchKind;
  /** The confirmed pane this release owns. */
  paneId?: string;
  /** The attempt token from {@link DowntimeHostBudgetAdmission.attemptId}. */
  attemptId?: string;
  /** Why the release happened — recorded in the ledger's audit trail. */
  reason?: string;
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
   * The reserve handshake was ATTEMPTED but produced no usable outcome
   * (WL-0MVWEZF4Z004UNYT AC4): the reason NAMES the failing exchange
   * (`http-400` for a wire-contract break, `http-404` for a pre-reserve
   * proxy, `http-5xx`/`timeout`/`bad-body`/`ttl-below-bound` otherwise).
   * Present ONLY when the dispatch proceeded FAIL-OPEN (no ticket) after an
   * attempted reserve; absent when no client is wired (older install), when
   * the reserve was skipped (see `reservationSkipped`), and on a refusal or
   * a grant. This is what makes a broken contract distinguishable from an
   * old proxy in the dispatch record.
   */
  reservationUnavailable?: string;
  /**
   * The reserve call was deliberately SKIPPED and the dispatch proceeded
   * (WL-0MVWEZF4Z004UNYT AC8): only `remote-ok` dispatches (whose first
   * request goes remote and could never consume a ticket) skip. Absent
   * otherwise — a plain fail-open dispatch without a wired client carries
   * no field.
   */
  reservationSkipped?: string;
  /**
   * Resolved per-turn locality preference forwarded to the pane
   * (WL-0MVNUIW77000VYAX AC5). Absent on legacy entries and on callers that
   * did not opt into the priority rule.
   */
  localPreference?: LocalPreference;
  /**
   * Why the preference resolved to its value (WL-0MVNUIW77000VYAX AC5):
   * `operator-setting` (persisted `downtimeLocalPreference` won),
   * `priority-low` (the low-priority rule chose `local-preferred`) or `default`
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
   *
   * `no-candidate` itself is UNCHANGED by the empty-leader work (parent
   * WL-0MVP7QHUB003ZA2A): it still means "this cycle yielded no
   * dispatchable candidate". What the reason *implies* for the worker loop
   * is now decided there, from state the loop already holds — the empty
   * cycle steps leadership down (`releaseLeadership()`, AC1), and the
   * no-candidate pause is armed only when the offer list holds no peer
   * offer (`hasPeerOffer`, AC2). No new outcome flag was introduced for
   * either behaviour, so this contract stays the complete reason surface.
   * already running — a non-stale kind=audit dispatch marker maps to an
   * `in_progress` item — so the audit tier was skipped; a skip that leaves
   * an empty remaining backlog reports this reason, NEVER 'no-candidate',
   * so the no-candidate cooldown is not entered while the audit runs) |
   * 'fresh-audit-skip' (WL-0MT8KSTOE00871E7: a valid audit was recorded
   * during the interim between candidate selection and dispatch, so the
   * audit tier was skipped — an empty remaining backlog reports this
   * reason, NEVER 'no-candidate', so the cooldown is not entered while
   * the item is already audited).
   *
   * Host-wide dispatch budget (WL-0MVXY0YG7009JMHI F3, audit tier
   * WL-0MVXY0XPF006YUHA F2):
   * `host-budget-implement` (the ledger reports the implement tier at or over
   * its machine-wide cap, or the tier is disabled with `maxImplement: 0`),
   * `host-budget-audit` (the same for the audit tier at any cap other than 1,
   * including the `maxAudit: 0` kill switch) and `host-budget-unknown` (the
   * ledger could not be read: the dispatcher fails closed and rewrites it from
   * the live pane list). The audit tier keeps the retired marker's token
   * `audit-host-saturated` at its `maxAudit: 1` default, so existing consumers
   * and logs are unchanged. All of these are NEUTRAL skips — no strike, no
   * attempt budget, no no-candidate cooldown — so the next idle tick re-checks
   * as soon as a slot frees. `budget` carries the `live`/`max` evidence.
   *
   * Proxy audit lease (WL-0MWFJH3NW006F5GN): the AUDIT admission is decided
   * by the lease acquire, not the availability read. `audit-budget-saturated`
   * is here a 429 lease refusal too (the same shared token), and
   * `audit-budget-unavailable` names a 503 proxy registry failure;
   * `retryAfterS` carries the proxy's bounded deferral advice on the 429.
   */
  reason?: string;
  /**
   * Host-budget evidence (WL-0MVXY0YG7009JMHI F3 AC2): the tier's observed
   * live count and configured cap at admission time. Present on a
   * `host-budget-implement` / `host-budget-unknown` refusal (and on any other
   * outcome the admission seam annotated); absent everywhere else.
   */
  budget?: { live: number; max: number };
  /**
   * Failing exchange on a fail-closed AUDIT-budget refusal
   * (`audit-budget-unknown`): `http-404` (endpoint-absent), `timeout` /
   * `network` / `http-<status>` (unreachable), `bad-body` (unparsable) or
   * `seam-absent` (no client wired). Copied from the admission seam's
   * {@link DowntimeHostBudgetAdmission.detail} so the terminal reason and the
   * decision entry can name the broken proxy contract; absent on every other
   * outcome (WL-0MWDDHVF2004PTYX AC3).
   */
  detail?: string;
  /**
   * The proxy's bounded audit-lease cooldown on a `429` refusal
   * (`audit-budget-saturated`, WL-0MWFJH3NW006F5GN AC2): the proxy's own
   * `retry_after_s`, honoured as the deferral advice carried on the decision
   * entry. Absent on every other outcome.
   */
  retryAfterS?: number;
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
   *
   * Note (parent WL-0MVP7QHUB003ZA2A AC1): the *empty*-cycle step-down needs
   * no counterpart flag — it is decided in the worker loop from the
   * `no-candidate` reason plus the genuine-empty probe result, and releases
   * leadership through the same `releaseLeadership()` primitive. This field
   * therefore stays a dispatch-sourcing signal only.
   */
  ownBacklogDispatch?: boolean;

  /**
   * Per-offer rejections (WL-0MVR8FKMU009XTED AC2): every coordination entry
   * the leader rejected at dispatch time, with its work item id, worklog root
   * and the STABLE gate token that rejected it. Additive evidence only — the
   * outcome's `reason` and every dispatch decision are unchanged.
   */
  offerRejections?: CoordinationOfferRejection[];

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

// ── Continuable holds (WL-0MWBT76WY00298AY AC1) ────────────────────────
//
// A head scan may only step past a NON-DISPATCHED outcome when that outcome
// is a CONTINUABLE HOLD: a neutral condition that applies to that candidate
// (or to the host's budget) rather than a terminal failure of the tick.
//
// This is an ALLOW-LIST, deliberately not a deny-list: "not dispatched" is
// never enough to continue. A new refusal reason must be added here
// explicitly, so a future strike-worthy outcome cannot be swallowed into a
// silent retry loop by accident.

/**
 * Lost-claim outcomes: the CAS race was lost (`claim-failed`) or the marker
 * write failed after the claim and the claim was rolled back
 * (`claim-rolled-back`). Both are neutral and candidate-scoped; the two head
 * scans already continue past them when `skipOnLostClaim` is set.
 */
export const LOST_CLAIM_REASONS: ReadonlySet<string> = new Set([
  'claim-failed',
  'claim-rolled-back',
]);

/**
 * Host-budget refusals: the machine-wide dispatch budget (or the proxy-owned
 * audit-budget verdict) refused this BUDGETED candidate (`implement` /
 * `audit`). Every token below is emitted by the same admission seam
 * (`dispatchClaimedTier`) with the same neutral contract — `{live, max}`
 * evidence, no strike, no cooldown, no attempt budget — so all of them are
 * continuable holds:
 *  - `host-budget-implement` / `host-budget-audit` / `host-budget-unknown`
 *    (the ledger path), and
 *  - `audit-budget-saturated` / `audit-budget-unknown` (the proxy-owned
 *    availability verdict) plus the one-release legacy `audit-host-saturated`.
 *
 * This set is the UNION allow-list that keeps every budget refusal a
 * continuable hold; the terminal-reason precedence further splits it into
 * the AUDIT rung ({@link AUDIT_BUDGET_HOLD_REASONS} — "this host's audit
 * tier was refused") and the implement/host rung below it
 * (WL-0MWDDHVF2004PTYX AC2).
 *
 * Prep work (`plan` / `intake` / `risk-effort`) is never budget-gated, which
 * is exactly why a refusal must not end the scan: the prep candidate ranked
 * behind the refused budgeted candidate is still dispatchable.
 */
export const HOST_BUDGET_HOLD_REASONS: ReadonlySet<string> = new Set([
  'host-budget-implement',
  'host-budget-audit',
  'host-budget-unknown',
  'audit-budget-saturated',
  'audit-budget-unknown',
  'audit-host-saturated',
]);

/**
 * The AUDIT tier's budget-refusal tokens — the subset of
 * {@link HOST_BUDGET_HOLD_REASONS} that names a refusal of the audit tier
 * (proxy-derived `audit-budget-*`, plus the one-release legacy
 * `host-budget-audit` / `audit-host-saturated`). A refusal quoted with one of
 * these is a statement about the AUDIT tier and therefore OUTRANKS an
 * implement-tier refusal in the terminal-reason precedence
 * (WL-0MWDDHVF2004PTYX AC2): an audit refusal with `detail: 'http-404'` is a
 * broken proxy contract, not an ambient implement-cap statement.
 *
 * `host-budget-unknown` is DELIBERATELY absent: both tiers quote it when the
 * ledger cannot be trusted, so the refusing tier is decided from the
 * outcome's `kind` by {@link isAuditBudgetHoldOutcome}.
 */
export const AUDIT_BUDGET_HOLD_REASONS: ReadonlySet<string> = new Set([
  'audit-budget-saturated',
  'audit-budget-unknown',
  'host-budget-audit',
  'audit-host-saturated',
]);

/** True when `reason` is one of the host-budget refusal tokens. */
export function isHostBudgetHoldReason(reason: string | undefined): boolean {
  return reason !== undefined && HOST_BUDGET_HOLD_REASONS.has(reason);
}

/** True when `reason` is one of the AUDIT tier's budget-refusal tokens. */
export function isAuditBudgetHoldReason(reason: string | undefined): boolean {
  return reason !== undefined && AUDIT_BUDGET_HOLD_REASONS.has(reason);
}

/**
 * True when a budget-refusal OUTCOME refused the AUDIT tier.
 *
 * Unambiguous tokens are decided by {@link AUDIT_BUDGET_HOLD_REASONS}; the one
 * tier-ambiguous token (`host-budget-unknown` — both tiers fail closed to it
 * when the ledger cannot be trusted) is decided by the outcome's `kind`
 * (carried on the refusal by `dispatchClaimedTier`, WL-0MWDDHVF2004PTYX),
 * falling back to the implement/host rung when no kind was recorded.
 */
export function isAuditBudgetHoldOutcome(outcome: {
  reason?: string;
  kind?: string;
}): boolean {
  if (!isHostBudgetHoldReason(outcome.reason)) return false;
  if (isAuditBudgetHoldReason(outcome.reason)) return true;
  // `host-budget-unknown` — the refusing tier decides (fallback: host rung).
  return outcome.kind === 'audit';
}

/** True when `reason` is one of the lost-claim tokens. */
export function isLostClaimReason(reason: string | undefined): boolean {
  return reason !== undefined && LOST_CLAIM_REASONS.has(reason);
}

/**
 * The single continuable-hold predicate every head-scan path consults
 * (WL-0MWBT76WY00298AY AC1). `true` for exactly the allow-listed neutral
 * holds — lost claims and host-budget refusals — and `false` for every other
 * non-dispatch outcome (`wl-error`, `spawn-failed`, `marker-write-failed`,
 * `anchor-unavailable`, `no-candidate`, …), which must keep returning
 * immediately so the caller's strike/skip semantics are preserved.
 */
export function isContinuableHoldOutcome(outcome: { reason?: string }): boolean {
  return isHostBudgetHoldReason(outcome.reason) || isLostClaimReason(outcome.reason);
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
