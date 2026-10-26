/**
 * packages/herdr/src/downtime-worker.worker-contract.ts — the downtime
 * worker's public contract: the injected dependency boundary and the
 * per-tick orchestrator's configuration / result / handle shapes.
 *
 * Single responsibility: define the external seams a caller wires into
 * `createDowntimeWorker` and the object it returns.
 *
 * Extracted from `downtime-worker.ts` by WL-0MVLII2080074S5L (extract the
 * downtime-worker orchestrator modules). The orchestrator modules consume
 * these types, and `DowntimeWorkerDeps` cannot stay in the barrel —
 * split-family modules may not import the barrel at runtime (split-guard
 * gate, SA baseline) — so the contract moved verbatim into its own module
 * and the barrel re-exports it. The pure-data types module
 * (`downtime-worker.types.ts`) stays the lowest layer and stays ≤ 1,000
 * lines; `DowntimeWorkerDeps` (with its in-baseline type references) does
 * not fit there, hence this separate module. No behaviour change.
 *
 * Parent: WL-0MVF3F9A7000HKP7 (decompose the `downtime-worker.ts` god class).
 */

import type { HostCpuReading } from './host-cpu.js';
import type { LocalPreference, LocalPreferenceMode } from './local-preference.js';
import type { RoundRobinRegistry } from './downtime-round-robin.js';
import type { ScheduledPrompt } from './scheduled-prompts.js';
import type { PaneItemState } from './pane-lifecycle.js';
import type { DowntimeSpawnResult } from './downtime-worker.pane.js';
import type {
  PaneCloseLogEntry,
  PaneLifecycleKind,
  CoordinationLogEntry,
} from './downtime-log.js';
import type {
  DispatcherAnchor,
  DispatcherPrefixTabAnchor,
  ItemTabAnchor,
  ProjectWorkspaceTarget,
} from './dispatcher-anchor.js';
import type {
  DowntimeDispatchEnrichmentEvent,
  DowntimeDispatchFailureEvent,
  DowntimeDispatchEvent,
  DowntimeErrorEvent,
} from './downtime-worker.dispatch-contract.js';
import type {
  DowntimeActiveAuditResult,
  DowntimeCandidate,
  DowntimeClaimExpected,
  DowntimeClaimResult,
  DowntimeHerdrListResult,
  DowntimeItemResult,
  DowntimeNextResult,
  DowntimePoller,
  DowntimeStage,
  LocalReservationRequest,
  LocalReservationResult,
  LongRunningPaneObservation,
  LongRunningScanOptions,
  RunningPanesResult,
  StalledPaneCandidate,
  StalledResumeOutcome,
  StalledScanOptions,
} from './downtime-worker.types.js';

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
  /**
   * Tri-state code-freeze read (`CodeFreezeStatus` in `code-freeze.ts`).
   * Declared inline rather than imported: `code-freeze.ts` sits inside the
   * split guard's frozen cycle baseline, so importing it from a split-family
   * module would join that cycle. The union is byte-identical to the alias.
   */
  readCodeFreezeStatus(cwd: string): 'frozen' | 'not-frozen' | 'ambiguous';
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
     * `downtimeLocalPreference` setting (default `remote-ok`,
     * WL-0MVNUHWH500196K1; `local-only` is the explicit opt-in). Optional
     * for backward compat — absent leaves the pane launch byte-identical to
     * today (no `X-Local-Preference`, no route log).
     */
    localPreference?: LocalPreference;
    /**
     * Locality-preference precedence opt-in (WL-0MVNUIW77000VYAX AC4): how the
     * dispatch boundary derives the pane's preference from `localPreference`.
     * `operator-setting` = the operator persisted the knob (wins over
     * priority); `priority-rule` = the knob was not persisted, so a
     * `low`-priority candidate resolves to `local-only` and everything else to
     * the deployment default. Optional for backward compat — absent keeps
     * today's fixed forwarding (no marker fields).
     */
    localPreferenceMode?: LocalPreferenceMode;
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
