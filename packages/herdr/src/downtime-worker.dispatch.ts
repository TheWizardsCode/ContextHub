/**
 * packages/herdr/src/downtime-worker.dispatch.ts — the downtime dispatch entry
 * point and its single-flight state.
 *
 * Single responsibility: decide, for ONE idle tick, whether any work may be
 * dispatched and which candidate wins — owning the per-process dispatch
 * pipeline counter (`dispatchInFlightCount`, declared here and nowhere else),
 * the terminal no-dispatch reason composition and the host-wide
 * audit-saturation log line the coordination path shares.
 *
 * Parent: WL-0MVF3F9A7000HKP7 (decompose the `downtime-worker.ts` god class).
 * The Herdr list-head filter lives in `downtime-worker.dispatch-filter.ts`, the
 * claim → marker → spawn pipeline in `downtime-worker.dispatch-claims.ts`,
 * the CPU gate in `downtime-worker.dispatch-cpu-gate.ts` and the prompt text in
 * `downtime-worker.prompts.ts`; this module keeps the entry point beside the
 * mutable single-flight counter so no cross-module mutable binding is
 * introduced (WL-0MVLII0NO007JJBA AC3). No behaviour change: filter order,
 * hold reasons and log lines are identical.
 */

import { resolveSprintViewWindow } from './browse-window.js';
import {
  DEFAULT_DOWNTIME_AUDIT_BATCH_MAX,
  DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS,
  DEFAULT_DOWNTIME_MAX_ATTEMPTS,
  DEFAULT_DOWNTIME_NON_TERMINAL_COOLDOWN_MS,
  DEFAULT_DOWNTIME_STALL_THRESHOLD_MS,
  DISPATCH_PIPELINE_SINGLE_FLIGHT,
  DOWNTIME_AUDIT_MIN_FREE_SLOTS,
  DOWNTIME_PANE_MIN_FREE_SLOTS,
} from './downtime-worker.constants.js';
import { clampDowntimeAuditBatchMax } from './downtime-worker.clamps.js';
import {
  REVIEW_QUEUE_HOLD_REASON,
  computeAuditEligibleDepth,
  fetchExtendedHerdrItems,
  finalizeAuditBatchOutcome,
  readReviewQueueGate,
  type ReviewQueueGateResult,
} from './downtime-worker.gates.js';
import { resolveInFlightPanes } from './downtime-worker.pane.js';
import { criticalSkillKind } from './downtime-worker.parsers.js';
import type { LocalPreference, LocalPreferenceMode } from './local-preference.js';
import {
  CPU_SATURATED_REASON,
  hostCpuGateEvidence,
  resolveCpuGate,
} from './downtime-worker.dispatch-cpu-gate.js';
import {
  STALLED_RESUME_REASON,
  resumeStalledWorkIfAble,
} from './downtime-worker.stalled-resume.js';
import {
  dispatchClaimedTier,
  dispatchScheduledPrompt,
} from './downtime-worker.dispatch-claims.js';
import { dispatchFromHerdrList } from './downtime-worker.dispatch-filter.js';
import type {
  DowntimeDispatchDeps,
  DowntimeDispatchOutcome,
} from './downtime-worker.dispatch-contract.js';

/**
 * Per-process dispatch-pipeline guard (WL-0MT50LKAK001EF5Q F3): at most ONE
 * dispatch pipeline (claim → marker → spawn) may be in flight in this process
 * at a time (concurrent callers beyond that are refused, not queued).
 *
 * This bounds PIPELINES, NOT live panes: there is deliberately no client-side
 * cap on dispatched panes (WL-0MU2EP6JL006A1U3) — panes stay open until an
 * operator closes them, and their number is limited only by the local LLM
 * idle / free-slot state. Cross-pane serialization is handled by the
 * pre-dispatch claim (Q5 — no lock file): the CAS claim atomically moves the
 * item out of `wl next`'s selection set for other panes.
 */
let dispatchInFlightCount = 0;

/**
 * Observability for host-wide audit saturation (WL-0MUIVE0YG000UVIA AC3):
 * emit a clear skip/defer line that names the condition and includes the
 * audit-runner queue state and free-slot contention so an operator can tell
 * infrastructure saturation from content problems. The machine-wide marker
 * guarantees at most one active audit per host, so the concurrent-audit
 * count is 1 by construction; the free-slot and contention figures are the
 * live slot state captured at the poll.
 *
 * Fail-closed: logging must never crash the worker.
 */
function logHostAuditSaturation(
  freeSlots: number | undefined,
  contentionQueueDepth: number | undefined,
): void {
  try {
    const slots = typeof freeSlots === 'number' ? freeSlots : 'unknown';
    const contention = typeof contentionQueueDepth === 'number' ? contentionQueueDepth : 'unknown';
    process.stderr.write(
      `[worklog-plugin] Downtime audit tier skipped: audit-host-saturated ` +
        `(concurrentAudits=1, freeSlots=${slots}, contentionQueueDepth=${contention})\n`,
    );
  } catch {
    // fail-closed: logging must never crash the worker
  }
}

/**
 * dispatch one downtime work item. Selection priority: FIRST the
 * scheduled-prompts tier (WL-0MSS1Q5ER007QDKX) — a due scheduled prompt
 * (e.g. `/skill:refactor` every 3 days) dispatches its prompt text before
 * any backlog tier, gated by the same code-freeze marker as audit/implement
 * (frozen OR ambiguous ⇒ skipped, plan/intake still run) and never
 * triggering the no-candidate cooldown; then the audit tier
 * (WL-0MSI8H3HP000K0RG): a completed/in_review item WITHOUT a valid audit AND
 * NOT already dispatched for audit by this worker →
 * `/skill:audit <id>` (the dispatched-marker exclusion,
 * WL-0MSLIY8ZR004QUSY, is applied by `deps.getNextAuditCandidate`). The
 * audit tier is ROOT-ONLY (WL-0MSTLFW14000KPEC): `wl list --root-only`
 * excludes completed/in_review children, so only parent items are ever
 * dispatched for audit — sub-tasks are never audited independently; and
 * exactly one audit is active at a time (WL-0MT3PHW4I002SNOV,
 * single-flight): before any candidate is selected the active-audit check
 * (`deps.getActiveAudit`) skips the audit tier while a non-stale
 * `kind=audit` dispatch marker (within `DOWNTIME_AUDIT_STALE_WINDOW_MS`,
 * 2h) maps to an item still `in_progress` — an audit dispatched by ANY
 * instance is honoured via the shared dispatch log (the stickiest
 * cross-instance single-flight signal), and a marker older than the
 * window is stale (the audit pane may have crashed without updating the
 * work item) and is ignored so a NEW audit can proceed. The skip reports
 * reason 'audit-in-flight' (never 'no-candidate' — the empty-backlog
 * cooldown is not entered while the audit runs) and the check fails open
 * (an unanswerable check just falls through to the next tier — dispatch
 * is never blocked); then —
 * BEFORE the non-critical implement tier — the critical-first tier
 * (WL-0MT3FM8VA005XBHE): the highest-priority open CRITICAL item at ANY
 * stage (idea / intake_complete / plan_complete), including
 * dependency-blocked ones (`wl list --priority critical --status open` does
 * NOT exclude them — unlike `wl next`), dispatched with the
 * stage-appropriate skill (Q2 caps retained + Q3 dependency-frontier
 * resolution — see `getNextCriticalCandidate`); then the non-critical
 * implement tier (WL-0MSMAYPQP001FLR6): the highest-priority open
 * plan_complete item with risk ≤ Medium / effort ≤ Medium → `/skill:implement <id>`
 * (fail-closed null on wl error or no candidate — never short-circuits the
 * fallback, AC5/AC6); if none, `wl next --stage intake_complete` →
 * `/skill:plan <id>`; if none, `wl next --stage idea` → `/skill:intake <id>`;
 * if all are empty, no dispatch.
 *
 * Critical-tier semantics: the lookup resolves through the same
 * `DowntimeNextResult` error channel as the audit tier — a GENUINELY empty
 * critical tier (`{ok:true, candidate:null}`) falls through to the
 * non-critical tiers, while `{ok:false}` is a wl-error strike (never a
 * silent fall-through, so a broken critical lookup can never look like "no
 * critical work"). The stage-appropriate skill comes from
 * `criticalSkillKind(candidate.stage)`; a dependency-blocked candidate is
 * dispatched as its nearest OPEN frontier blocker with the blocker's own
 * stage (Q3). The critical dispatch runs through the SAME
 * `dispatchClaimedTier` pipeline (CAS claim with the TIER_EXPECTED stage
 * entry → marker → spawn), so the claim-CAS, the dispatched-marker
 * change-guard (rolling-log kind is the skill-mapped implement/plan/intake)
 * and the single-flight guard compose unchanged.
 *
 * The audit tier resolves through the same `DowntimeNextResult` error
 * channel as the plan/intake tiers (WL-0MSLWJ2KP0002SV0): a GENUINELY empty
 * audit tier (`{ok:true, candidate:null}`) falls through to the implement
 * tier, but an audit-tier wl/parse failure (`{ok:false}`) is a `wl-error`
 * outcome — a CLI-error strike that never falls through looking healthy — so
 * a persistently broken audit lookup can never silently disable audit
 * dispatch (the caller's three-strike rule pauses and logs it).
 *
 * Code-freeze gate (WL-0MSQ0RPQP00636JY): the marker is re-read fresh on
 * EVERY dispatch (never cached). While the marker is frozen OR ambiguous
 * (fail-closed), the audit and non-critical implement tiers are skipped — no new
 * implementation work (or audits) starts during a release freeze — and
 * dispatch continues with the plan/intake tiers, which are low-risk prep
 * and still allowed. The critical tier is STILL consulted during a freeze,
 * with the split-by-skill rule (Q1): a critical plan_complete
 * (implement-kind) candidate is skipped (no new code mid-release), while
 * critical idea/intake_complete (intake/plan-kind) candidates STILL
 * dispatch — critical prep is as low-risk as non-critical prep. A freeze
 * skip with an empty plan/intake backlog is
 * reported as reason 'code-freeze' (NEVER 'no-candidate'), so it never
 * triggers the worker's no-candidate cooldown: polling continues and
 * implement/audit dispatch resumes immediately when the freeze lifts.
 *
 * A CLI error at the intake_complete tier does NOT short-circuit: the idea
 * tier is still attempted, so a tier-3 candidate can still dispatch. A
 * `wl-error` outcome (any CLI failure) is never a candidate and never a
 * `no-candidate`; the caller's three-strike rule decides when consecutive
 * errors pause the worker. Every tier runs its candidate through
 * `dispatchClaimedTier` (CAS claim → marker → spawn), so the item is
 * claimed BEFORE the pane spawns and a losing pane aborts with no pane, no
 * marker, no success record (the same-instant race, RC-1, is closed). The
 * caller must only invoke this once the idle tracker reports the threshold
 * met (AC1); a dispatch consumes the local slot, so the proxy reports busy
 * and the tracker requires a fresh full idle period before the next dispatch.
 */

export async function dispatchDowntimeWork(
  deps: DowntimeDispatchDeps,
  opts: {
    model: string;
    cwd: string;
    freeSlots?: number;
    browseItemCount?: number;
    /**
     * Depth-aware audit-batch cap (`downtimeAuditBatchMax`, parent
     * WL-0MVEDM8OT007WDRS AC1). Optional for backward compat — absent
     * leaves batching off (legacy single-dispatch behaviour). Threaded from
     * `DowntimeWorkerConfig.config()`. Clamped to `[1, 5]`; `1` disables
     * batching and restores legacy single-dispatch behaviour.
     */
    auditBatchMax?: number;
    /**
     * Depth-aware audit-batch continuation budget (parent
     * WL-0MVEDM8OT007WDRS AC1/AC2): continuation audits still available in
     * the CURRENT idle window BEFORE this dispatch. Absent = the first
     * dispatch (the worker owns the budget and initialises it to the cap)
     * or batching off. A successful audit dispatch reports the decremented
     * remainder via `outcome.auditBatch.remaining`.
     */
    auditBatchRemaining?: number;
    /**
     * True when the polled status reports the target slot is OWNED by a
     * live Local Proxy lease (AC2, WL-0MTYZXSLN008HZOW). Optional — absent
     * disables the gate. When true, dispatch is refused with reason
     * `slot-owned`: a slot is only dispatchable when truly unowned.
     */
    slotOwned?: boolean;
    /**
     * Proxy-contention LIVE queue depth (AC6, WL-0MTYZXSLN008HZOW): when > 0,
     * dispatched panes are already queued behind a busy local slot, so
     * dispatch backs off with reason `proxy-contention` until the queue
     * drains. MUST be sourced from `contention_queue_depth` (the live depth),
     * never `contention_queued_count` (cumulative, WL-0MU1DWXO600153OI).
     * Optional — absent/0 disables the gate.
     */
    contentionQueueDepth?: number;
    /**
     * Dispatched success-marker staleness window (WL-0MU6UL0RJ008IHGT): a
     * SUCCESS marker whose item is still at the marker's dispatched-at stage
     * is released once its age exceeds this window, so a pane that spawned
     * but never advanced the item cannot strand it forever. Optional for
     * backward compatibility — absent falls back to
     * `DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS`.
     */
    markerStaleWindowMs?: number;
    /**
     * Non-terminal pane-close cooldown (WL-0MUKYERLZ006ELL5): an item whose
     * previous same-kind pane closed without reaching a terminal stage is
     * skipped until this many ms elapse. Optional — absent falls back to
     * `DEFAULT_DOWNTIME_NON_TERMINAL_COOLDOWN_MS`.
     */
    nonTerminalCooldownMs?: number;
    /**
     * Per-item/per-kind dispatch-attempt cap (WL-0MUKYEXMK0033MFK): once an
     * item has been dispatched this many times for a kind at its current
     * stage it is flagged for producer review and skipped. Optional — absent
     * falls back to `DEFAULT_DOWNTIME_MAX_ATTEMPTS` (3).
     */
    maxAttempts?: number;
    /**
     * Stalled-work scan enable (WL-0MUYMBSA90092QV2 AC2/AC3): read live from
     * `downtimeStallScanEnabled`. Optional — absent defaults to enabled; the
     * scan is `inert` unless `scanStalledPanes`/`resumeStalledPane` deps are
     * wired, so an unwired caller is unaffected.
     */
    stallScanEnabled?: boolean;
    /**
     * Stalled-work stall threshold ms (WL-0MUYMBSA90092QV2): read live from
     * `downtimeStallThresholdMs` (clamped). Optional — absent falls back to
     * `DEFAULT_DOWNTIME_STALL_THRESHOLD_MS` (5 min).
     */
    stallScanThresholdMs?: number;
    /**
     * Host-CPU gate threshold (WL-0MVK0UO3Q002TXW6 AC2/AC5): the live
     * `downtimeCpuGatePercent` value, re-read on every dispatch tick. At or
     * above it new audit/implement dispatch is refused (including a critical
     * implement) and stalled panes are not resumed, while plan/intake/
     * risk-effort still dispatch. `0` disables the gate. Optional — absent
     * falls back to `DEFAULT_DOWNTIME_CPU_GATE_PERCENT` (75).
     */
    cpuGatePercent?: number;
    /**
     * Per-turn locality preference for the dispatched pane (parent
     * WL-0MVIKRFP0005JDL8 AC4, slice C4): forwarded to the pane as
     * `--local-preference` / `HERDR_LOCAL_PREFERENCE`. Optional — absent
     * leaves the launch byte-identical to today (fail-open C4-AC3).
     */
    localPreference?: LocalPreference;
    /**
     * Locality-preference precedence opt-in (WL-0MVNUIW77000VYAX AC4):
     * `operator-setting` keeps a persisted setting verbatim, `priority-rule`
     * lets a `low`-priority candidate resolve to `local-only`. Absent keeps
     * legacy fixed forwarding.
     */
    localPreferenceMode?: LocalPreferenceMode;
  },
): Promise<DowntimeDispatchOutcome> {
  // Per-process PIPELINE single-flight gate (F3, WL-0MT50LKAK001EF5Q): at
  // most ONE dispatch pipeline (claim → marker → spawn) in flight per process;
  // a concurrent caller is refused with the neutral single-flight reason
  // ('dispatch-in-flight' — never a strike). The count decrements in the
  // finally below — a failed spawn / marker failure / claim loss ends the
  // pipeline and never leaks an in-flight slot.
  //
  // This bounds PIPELINES, NOT live panes: there is deliberately NO
  // client-side cap on dispatched panes (WL-0MU2EP6JL006A1U3). Panes stay
  // open until an operator closes them, so the number of them is limited only
  // by the local LLM idle / free-slot check (the caller's gate).
  if (dispatchInFlightCount >= DISPATCH_PIPELINE_SINGLE_FLIGHT) {
    return { dispatched: false, reason: 'dispatch-in-flight' };
  }
  // ── Owner-lease gate (AC2/AC5, WL-0MTYZXSLN008HZOW) ──
  // A non-null Local Proxy owner lease means the slot is owned by a live
  // pane (`run-pi-agent.sh` holds it until `release-lease-on-exit.mjs`
  // releases it). Only a truly unowned slot is dispatchable. Neutral
  // reason — never a strike.
  if (opts.slotOwned === true) {
    return { dispatched: false, reason: 'slot-owned' };
  }
  // ── Contention feedback (AC6, WL-0MTYZXSLN008HZOW) ──
  // While the proxy reports queued local requests, dispatched panes are
  // already contending for the slot: back off until the queue drains.
  // Neutral reason — never a strike, never a cooldown.
  if (typeof opts.contentionQueueDepth === 'number' && opts.contentionQueueDepth > 0) {
    return { dispatched: false, reason: 'proxy-contention' };
  }
  dispatchInFlightCount += 1;
  try {
    // Unified contract WL-0MTK1ILM2009QYB2: Herdr list is the sole ranking path.
    // dispatchDowntimeWork consumes the Herdr selection list head (getHerdrListHead)
    // and applies safety gates as sequential FILTERS on that ordered sequence
    // (scheduled-prompt → code-freeze → dispatched-marker → free-slot minimums →
    // active-audit single-flight → freshness-recency → CAS claim → spawn).
    // No second tier ordering remains on this path (AC1–2). WL-0MT32F90V008UAD2 AC3
    // per-tier free-slot minimums (audit needs 2, single-pane 1) are now per-item
    // filters on the Herdr-ordered candidates rather than tier skips.
    const freeSlots = opts.freeSlots;
    const panesEligible = freeSlots === undefined || freeSlots >= DOWNTIME_PANE_MIN_FREE_SLOTS;
    const auditEligible = freeSlots === undefined || freeSlots >= DOWNTIME_AUDIT_MIN_FREE_SLOTS;

    // Sprint-view dispatch window (WL-0MUNS8X97007C9H9 AC1): the live per-root
    // `browseItemCount` clamped exactly as the TUI worklist does, so the Herdr
    // head below equals the rendered sprint view. Non-critical work outside
    // this window is never dispatched.
    const sprintWindow = resolveSprintViewWindow(opts.browseItemCount);

    // Depth-aware audit-batch budget (parent WL-0MVEDM8OT007WDRS AC1): the
    // clamped cap and the continuation budget available BEFORE this dispatch.
    // Absent `auditBatchRemaining` initialises the budget to the cap (the
    // first dispatch of a batch); `1` disables batching entirely.
    const auditBatchCap = clampDowntimeAuditBatchMax(
      opts.auditBatchMax ?? DEFAULT_DOWNTIME_AUDIT_BATCH_MAX,
    );
    const auditBatchRemainingBefore =
      opts.auditBatchRemaining === undefined
        ? auditBatchCap
        : Math.max(0, Math.trunc(opts.auditBatchRemaining));

    let auditInFlight = false;
    let auditCheckFailed = false;
    let freshnessSkip = false;
    // Host-wide audit saturation (WL-0MUIVE0YG000UVIA): true when the
    // machine-wide active-audit marker (another project/instance on this
    // host) caused the audit-tier skip, as opposed to a per-worklog
    // in-flight audit. Drives the 'audit-host-saturated' reason/log token.
    let auditHostSaturated = false;

    // Code-freeze gate (WL-0MSQ0RPQP00636JY): re-read the marker fresh on
    // every dispatch — never cached, so a freeze that starts or ends
    // mid-idle-period is honored on the next dispatch attempt. Frozen OR
    // ambiguous (fail-closed) → the audit and non-critical implement tiers
    // are skipped and dispatch falls through to the plan/intake tiers
    // below; the critical tier below is STILL consulted, pausing only its
    // implement-kind candidate (Q1 split-by-skill) — see the tier comment.
    const freezeStatus = deps.readCodeFreezeStatus(opts.cwd);
    const frozen = freezeStatus === 'frozen' || freezeStatus === 'ambiguous';

    // ── Host-CPU gate (WL-0MVK0UO3Q002TXW6 AC1/AC2/AC3) ──
    // ONE reading per dispatch tick (the sampler keeps the previous
    // /proc/stat sample in memory; nothing is written to disk). Fail-open:
    // an unusable reading leaves dispatch unchanged. At or above the live
    // threshold new audit/implement work is refused (no strike, no cooldown)
    // and stalled panes are not resumed, while plan/intake/risk-effort still
    // dispatch.
    const cpuGate = resolveCpuGate(deps, opts.cpuGatePercent);
    const cpuSaturated = cpuGate.saturated;
    const cpuEvidence = hostCpuGateEvidence(cpuGate);

    // ── Stalled-work scan (WL-0MUYMBSA90092QV2 AC1/AC3/AC4) ──
    // Idle-gated (a pane slot is free) and immediately before new-item
    // selection: prefer resuming a stalled pane over opening a new one. A
    // successful resume short-circuits the cycle with the neutral
    // 'stalled-resume' reason; any failure (unwired deps, unreadable pane
    // list, resume failure) falls through to the unchanged path below.
    if (panesEligible) {
      const resumed = await resumeStalledWorkIfAble(deps, opts.cwd, {
        enabled: opts.stallScanEnabled ?? true,
        frozen,
        cpuSaturated,
        thresholdMs: opts.stallScanThresholdMs ?? DEFAULT_DOWNTIME_STALL_THRESHOLD_MS,
        nonTerminalCooldownMs: opts.nonTerminalCooldownMs ?? DEFAULT_DOWNTIME_NON_TERMINAL_COOLDOWN_MS,
        maxAttempts: opts.maxAttempts ?? DEFAULT_DOWNTIME_MAX_ATTEMPTS,
      });
      if (resumed) return { dispatched: false, reason: STALLED_RESUME_REASON };
    }

    if (!frozen && panesEligible) {
      const duePrompt = await deps.getDueScheduledPrompt(opts.cwd);
      if (duePrompt !== null) {
        return await dispatchScheduledPrompt(deps, duePrompt, opts);
      }
    }

    // ── Review-queue depth gate — ONE bounded read per dispatch when the
    // non-critical implement tier is live (!frozen and a pane slot is free),
    // shared by the Herdr-head filter (dispatchFromHerdrList) AND the legacy
    // tier chain below (WL-0MT2UQWOR007CYY9; single getReviewQueueCount call
    // site per dispatch, WL-0MTTSWC1X005P4VD). Never a second ranking — the
    // gate only HOLDS non-critical implement candidates while the root-only
    // completed/in_review queue is at/over browseItemCount; audits/plan/
    // intake/critical flow unconditionally.
    let reviewGate: ReviewQueueGateResult | null = null;
    if (!frozen && !cpuSaturated && panesEligible) {
      reviewGate = await readReviewQueueGate(deps, opts.cwd, sprintWindow);
    }

    // ── Herdr list head consumes the ranking (WL-0MTK1ILM2009QYB2 ACs 1–2) ──
    // When the Herdr list is populated it is the sole ranking source; a
    // filtered-exhaustion returns the terminal reason directly and the legacy
    // tier chain is not consulted. When the list is genuinely empty (no ranked
    // candidates) the legacy chain remains as a test-compat fallback — the
    // extensive existing suite stubs per-tier lookups with an empty Herdr
    // head, so it stays green during migration. Production
    // `createDowntimeDeps` always returns a non-empty head when dispatchable
    // work exists, so the fallback is unreachable there and will be removed
    // once the suite is fully on Herdr-head stubs.
    {
      const flags = { auditInFlight, auditCheckFailed, auditCheckError: undefined, freshnessSkip, reviewHeld: false, cooldownHeld: false, budgetExhausted: false, cpuHeld: false, auditHostSaturated };
      const head = await deps.getHerdrListHead(opts.cwd, sprintWindow);
      if (!head.ok) return { dispatched: false, reason: 'wl-error', error: (head as { error?: string }).error };
      if (head.items.length > 0) {
        // Depth-derived batch activation (parent WL-0MVEDM8OT007WDRS AC1):
        // derive the audit-eligible depth from the ALREADY-FETCHED head (no
        // extra `wl` subprocess) and resolve the batch surface on every
        // outcome of this path. The head path is the production ranking, so
        // the batch decision never introduces a second eligibility definition.
        const auditDepth = computeAuditEligibleDepth(head.items, Date.now());
        const finalize = (outcome: DowntimeDispatchOutcome): DowntimeDispatchOutcome =>
          finalizeAuditBatchOutcome(outcome, {
            depth: auditDepth,
            cap: auditBatchCap,
            threshold: sprintWindow,
            remainingBefore: auditBatchRemainingBefore,
          });
        // Item-scoped in-flight state (WL-0MUBEZ6PE002WLP4 / F3): resolved
        // ONCE per idle cycle (a single `herdr pane list` read shared by both
        // dispatch loops) so the guard never adds a per-candidate process
        // spawn. `resolveInFlightPanes` never throws — an unavailable query
        // degrades to the marker-TTL fallback inside the decision table.
        const inFlight = await resolveInFlightPanes(deps, opts.cwd);
        const ctx = { cwd: opts.cwd, model: opts.model, localPreference: opts.localPreference, localPreferenceMode: opts.localPreferenceMode, freeSlots, frozen, cpuSaturated, panesEligible, auditEligible, reviewGate, markerStaleWindowMs: opts.markerStaleWindowMs ?? DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS, nonTerminalCooldownMs: opts.nonTerminalCooldownMs ?? DEFAULT_DOWNTIME_NON_TERMINAL_COOLDOWN_MS, maxAttempts: opts.maxAttempts ?? DEFAULT_DOWNTIME_MAX_ATTEMPTS, inFlight };
        const herdrOutcome = await dispatchFromHerdrList(deps, head.items, ctx, flags);
        if (herdrOutcome !== null) return finalize(herdrOutcome);

        // ── Extended dispatch window (WL-0MU6UL3GQ0015AA5) ──
        // The initial head is windowed (mandatory items always included, the
        // remaining slots filled from "other" items), so when the mandatory
        // set is large the first genuinely dispatchable candidate can fall
        // outside it and the dispatcher would report 'no-candidate' despite a
        // healthy backlog (the 2026-09-18 31-hour starvation). Re-read the
        // SAME ranking path with a bounded larger window and filter ONLY the
        // newly visible items — a window extension, never a second ranking.
        // Runs for every filtered-exhaustion reason (including a code-freeze,
        // where plan/intake work can still lie beyond the window); the
        // terminal reason below is unchanged when the extension adds nothing,
        // so no defined outcome is ever converted into a new failure.
        const extendedItems = await fetchExtendedHerdrItems(deps, opts.cwd, head.items);
        if (extendedItems.length > 0) {
          const extendedOutcome = await dispatchFromHerdrList(deps, extendedItems, ctx, flags);
          if (extendedOutcome !== null) return finalize(extendedOutcome);
        }
        auditInFlight = flags.auditInFlight;
        auditCheckFailed = flags.auditCheckFailed;
        auditHostSaturated = flags.auditHostSaturated;
        const auditCheckError = flags.auditCheckError;
        freshnessSkip = flags.freshnessSkip;
        const reviewHeld = flags.reviewHeld;
        const cooldownHeld = flags.cooldownHeld;
        const budgetExhausted = flags.budgetExhausted;
        const cpuHeld = flags.cpuHeld;
        // Herdr list had items but every one was filtered by a safety gate:
        // compose the terminal reason and DO NOT fall through to the legacy
        // chain (AC2 — gates are filters, not a fallback ranking).
        if (frozen) return finalize({ dispatched: false, reason: 'code-freeze' });
        // Host-CPU gate (AC2/AC4): at or above the threshold the remaining
        // audit/implement candidates were filtered by CPU — report the
        // distinct neutral reason (never 'no-candidate') with the measured
        // evidence. Code freeze keeps precedence above.
        if (cpuHeld) {
          return finalize({ ...cpuEvidence, dispatched: false, reason: CPU_SATURATED_REASON });
        }
        if (freshnessSkip) return finalize({ dispatched: false, reason: 'fresh-audit-skip' });
        if (auditInFlight) {
          // Host-wide saturation (WL-0MUIVE0YG000UVIA) vs per-worklog:
          // distinct reason strings for observability. 'audit-host-saturated'
          // means the machine-wide marker (another project/instance on this
          // host) held the audit slot; 'audit-in-flight' is a per-worklog
          // in-flight audit. auditInFlight keeps its original priority over
          // auditCheckFailed (a mixed tick still reports the audit skip).
          if (auditHostSaturated) {
            logHostAuditSaturation(opts.freeSlots, opts.contentionQueueDepth);
            return finalize({ dispatched: false, reason: 'audit-host-saturated' });
          }
          return finalize({ dispatched: false, reason: 'audit-in-flight' });
        }
        if (auditCheckFailed) return finalize({ dispatched: false, reason: 'wl-error', error: auditCheckError });
        // Deep review queue held the only remaining (non-critical implement)
        // candidates: neutral 'review-queue-hold', NEVER 'no-candidate' — no
        // cooldown while audits drain the queue (WL-0MTTSWC1X005P4VD AC2).
        if (reviewHeld) return finalize({ dispatched: false, reason: REVIEW_QUEUE_HOLD_REASON });
        // Non-terminal cooldown held the only remaining candidates: neutral
        // 'non-terminal-cooldown', NEVER 'no-candidate' — the backlog is not
        // empty, so the no-candidate cooldown must not fire
        // (WL-0MUKYERLZ006ELL5 AC3/AC6).
        if (cooldownHeld) return finalize({ dispatched: false, reason: 'non-terminal-cooldown' });
        // Per-item/per-kind attempt budget exhausted (WL-0MUKYEXMK0033MFK
        // AC2/AC5): neutral 'attempt-budget-exhausted', NEVER 'no-candidate'
        // — the backlog is not empty and no strike is recorded; polling
        // continues so other work still dispatches and the flag write is
        // retried if it failed.
        if (budgetExhausted) return finalize({ dispatched: false, reason: 'attempt-budget-exhausted' });
        return finalize({ dispatched: false, reason: 'no-candidate' });
      }
      // Genuinely empty Herdr list → keep flags and fall through to the
      // legacy chain (test-compat path; flags still drive the terminal reason).
      auditInFlight = flags.auditInFlight;
      auditCheckFailed = flags.auditCheckFailed;
      auditHostSaturated = flags.auditHostSaturated;
      freshnessSkip = flags.freshnessSkip;
    }

    // ── Legacy tier chain (retained for test compat; production-unreachable) ──
    // See the Herdr-list-head contract above.
    // Host-CPU gate (WL-0MVK0UO3Q002TXW6 AC2): the audit tier is refused while
    // the host is saturated — same placement as the code-freeze skip.
    if (!frozen && !cpuSaturated) {
      // Audit tier (WL-0MSI8H3HP000K0RG): dispatch /skill:audit for the
      // first completed/in_review item without a valid audit. Root-only
      // (WL-0MSTLFW14000KPEC): only PARENT items are candidates —
      // completed/in_review children are excluded server-side and never
      // dispatched independently. The lookup
      // resolves through the DowntimeNextResult error channel
      // (WL-0MSLWJ2KP0002SV0): {ok:true, candidate:null} is a GENUINELY
      // empty audit tier and falls through to the implement tier below;
      // {ok:false} is a wl/parse failure — fail closed to busy (a strike),
      // never a silent fall-through, so a broken audit query cannot look
      // like "no audit candidates" and silently disable the audit tier.
      //
      // Per-tier minimum (parent WL-0MT32F90V008UAD2 AC3): the audit tier
      // requires ≥ 2 free slots (parent + Phase 2 child at
      // `AUDIT_PHASE2_PARALLELISM=1`). When fewer are free the audit
      // lookup is skipped entirely — ineligible, not a strike and not a
      // wl-error (mirrors the code-freeze skip) — and dispatch falls
      // through to the implement tier (which needs only ≥ 1).
      if (auditEligible) {
        // Active-audit single-flight (WL-0MT3PHW4I002SNOV): before any
        // audit candidate is selected, check whether an audit-tier item is
        // currently in flight — a non-stale `kind=audit` dispatch marker
        // (within DOWNTIME_AUDIT_STALE_WINDOW_MS, 2h) maps to an item
        // still `in_progress` (the shared dispatch log makes this
        // cross-instance: an audit dispatched by ANY instance, leader or
        // not, is seen here). While one is active the audit tier is skipped
        // so audits stay strictly sequential — never fan-out consuming
        // extra LLM capacity. The skip reports reason 'audit-in-flight'
        // (never 'no-candidate') when the remaining backlog is empty, so
        // the no-candidate cooldown is not entered while the audit runs
        // (mirrors the code-freeze skip, WL-0MSQ0RPQP00636JY) and the next
        // idle tick re-checks. `{ok:false}` (the check could not complete,
        // e.g. a worklog query failure) fails open: the audit tier is
        // skipped and dispatch falls through to the next tier — the
        // dispatch loop is never blocked by an unanswerable check, and
        // when the fallback backlog is also empty the outcome is a
        // wl-error strike (partial information must not pause the worker
        // with no-candidate).
        const activeAudit = await deps.getActiveAudit(opts.cwd);
        if (activeAudit.ok) {
          if (activeAudit.active) {
            auditInFlight = true;
            auditHostSaturated = activeAudit.source === 'host-wide';
            // Host-wide saturation (WL-0MUIVE0YG000UVIA) vs per-worklog:
            // use distinct reason strings for observability. The `source`
            // field is set by getActiveAudit: 'host-wide' when the machine-
            // wide marker is active (cross-project serialisation),
            // 'per-worklog' when a per-worklog dispatch marker maps to an
            // in_progress item (single-project serialisation).
            const skipReason = activeAudit.source === 'host-wide'
              ? 'audit-host-saturated'
              : 'audit-in-flight';
            if (activeAudit.source === 'host-wide') {
              logHostAuditSaturation(opts.freeSlots, opts.contentionQueueDepth);
            } else {
              process.stderr.write(
                `[worklog-plugin] Downtime audit tier skipped: ${skipReason}\n`,
              );
            }
          } else {
            // No active audit: proceed with the candidate lookup unchanged.
            const audit = await deps.getNextAuditCandidate(opts.cwd);
            if (audit.ok) {
              if (audit.candidate !== null && audit.candidate.needsProducerReview !== true) {
                // Interim freshness re-check (WL-0MT8KSTOE00871E7): between
                // candidate selection and dispatch, a valid audit may have
                // been recorded (e.g. by a human or another process). Re-check
                // freshness to avoid dispatching a redundant audit pane and
                // writing a misleading dispatch comment. If a fresh audit now
                // exists, skip the dispatch entirely — no comment, no marker,
                // no spawn — and fall through to the next tier. Treat as
                // "already audited", not "no-candidate"/cooldown and not a
                // strike. Fail-open: a wl/CLI failure in the freshness check
                // is treated as "not fresh" (dispatch proceeds) — never a
                // silent skip.
                try {
                  const fresh = await deps.hasFreshAudit(audit.candidate.id, opts.cwd);
                  if (fresh) {
                    freshnessSkip = true;
                    process.stderr.write(
                      `[worklog-plugin] Downtime audit tier skip: fresh audit recorded during interim (item ${audit.candidate.id})\n`,
                    );
                    // Fall through to the next tier (implement/plan/intake).
                  } else {
                    return await dispatchClaimedTier(deps, 'audit', audit.candidate, { ...opts, selectionPath: 'legacy-tier', selectionReason: 'normal-scan' });
                  }
                } catch {
                  // Fail-open: the freshness check could not complete (e.g.
                  // wl/CLI error) — proceed with the dispatch (conservative
                  // default). The item is treated as "not fresh" for this tick.
                  return await dispatchClaimedTier(deps, 'audit', audit.candidate, { ...opts, selectionPath: 'legacy-tier', selectionReason: 'normal-scan' });
                }
              }
            } else {
              return { dispatched: false, reason: 'wl-error', error: audit.error };
            }
          }
        } else {
          // Fail-open: the check could not complete — skip the audit tier
          // and fall through to the next tier (never block all dispatch).
          auditCheckFailed = true;
        }
        // auditInFlight || auditCheckFailed → the audit tier is skipped and
        // dispatch falls through to the implement tier below.
      }
    }

    // Critical-first tier (WL-0MT3FM8VA005XBHE): consulted on EVERY
    // dispatch — including during a freeze. The lookup
    // (getNextCriticalCandidate) returns the stage-appropriate critical
    // candidate (F2: stage→skill via criticalSkillKind, plan_complete
    // implement caps Q2; F3: dependency-blocked items resolve to their
    // nearest open frontier blocker with the blocker's own stage). It
    // runs AFTER the audit tier (a completed/in_review item needing audit
    // keeps its slot) and BEFORE the non-critical implement/plan/intake
    // tiers — a critical item at ANY stage always wins over any
    // non-critical item (parent AC3). Error channel parity with the audit
    // tier (WL-0MSLWJ2KP0002SV0): {ok:true, candidate:null} is a GENUINELY
    // empty critical tier and falls through to the non-critical tiers;
    // {ok:false} is a wl/parse failure — fail closed to a wl-error strike
    // (never a silent fall-through, so a broken critical lookup cannot
    // silently look like "no critical work").
    //
    // Freeze split-by-skill (Q1): the marker is re-read fresh above, and
    // while frozen OR ambiguous (fail-closed) a critical IMPLEMENT
    // candidate (plan_complete) is SKIPPED — no new code changes land
    // mid-release — but a critical plan/intake candidate STILL dispatches
    // (low-risk prep allowed, matching the non-critical plan/intake tiers).
    // Pane minimum (parent WL-0MT32F90V008UAD2 AC3): the critical tier
    // needs ≥ 1 free slot like every single-pane tier.
    if (panesEligible) {
      const critical = await deps.getNextCriticalCandidate(opts.cwd);
      if (critical.ok) {
        if (critical.candidate !== null && critical.candidate.needsProducerReview !== true) {
          const kind = criticalSkillKind(critical.candidate.stage);
          // Safety gates: code freeze pauses a critical IMPLEMENT, and the
          // host-CPU gate pauses a critical implement too (saturation is
          // exactly when new heavy work does harm); critical plan/intake prep
          // still dispatches under both gates (WL-0MVK0UO3Q002TXW6 AC2).
          if (
            kind !== null &&
            !(frozen && kind === 'implement') &&
            !(cpuSaturated && kind === 'implement')
          ) {
            return await dispatchClaimedTier(deps, kind, critical.candidate, { ...opts, selectionPath: 'legacy-tier', selectionReason: 'critical-tier' });
          }
          // Frozen implement-kind critical (or a non-dispatchable stage):
          // skip this candidate (fail-closed pause) and fall through to
          // the non-critical tiers.
        }
      } else {
        return { dispatched: false, reason: 'wl-error', error: critical.error };
      }
    }

    if (!frozen && !cpuSaturated && panesEligible) {
      // Review-queue depth gate (WL-0MT2UQWOR007CYY9, shared by the live
      // Herdr-head path — read ONCE per dispatch above via
      // `readReviewQueueGate`, never a second wl call): when the root-only
      // completed/in_review review queue is deep enough (count >=
      // browseItemCount), NON-CRITICAL implement candidates are held.
      // Re-read live from settings every dispatch (no plugin restart
      // needed). Fail-closed: a wl error counting the queue → gate active
      // (only critical remains eligible). Critical-priority candidates
      // BYPASS the gate entirely; audits/plan/intake flow unconditionally.
      const gateActive = reviewGate?.deep ?? false;

      // Implement tier (WL-0MSMAYPQP001FLR6): after the critical-first
      // gate, dispatch /skill:implement for the highest-priority open
      // plan_complete item with
      // risk ≤ Medium / effort ≤ Medium. When the review-queue depth gate is
      // active, only critical-priority candidates remain eligible. When only
      // non-critical candidates exist under the gate, the implement tier is
      // skipped and dispatch falls through to plan/intake — the skip reason
      // must never be 'no-candidate' (the neutral reason keeps polling alive
      // so a critical implement / new plan / intake dispatches immediately).
      // getNextImplementCandidate is fail-closed (null on wl failure or no
      // candidate), so a null here means the tier is exhausted and the
      // plan/intake tiers below still run (AC5/AC6 — a wl error at the
      // implement tier does NOT short-circuit the fallback).
      // Pane minimum (parent WL-0MT32F90V008UAD2 AC3 / F3-fix
      // WL-0MT4RQTID000GT69): ≥ 1 free slot at selection time, matching the
      // critical/audit/plan/intake tiers — a direct dispatchDowntimeWork(
      // {freeSlots:0}) must never dispatch implement. 0 free slots is
      // ineligible (never a strike): the lookup is skipped entirely and
      // dispatch falls through to the plan tier's defensive no-candidate.
      let implementCandidate = await deps.getNextImplementCandidate(opts.cwd);
      if (implementCandidate !== null && implementCandidate.needsProducerReview !== true) {
        // Gate enforcement: only critical candidates bypass the review-queue
        // depth throttle (shared `isImplementHeldByReviewGate` semantics).
        // Non-critical candidates are excluded when the gate is active.
        if (!gateActive || implementCandidate.priority === 'critical') {
          return await dispatchClaimedTier(deps, 'implement', implementCandidate, { ...opts, selectionPath: 'legacy-tier', selectionReason: 'non-critical' });
        }
        // Non-critical candidate gated by review-queue depth — skip to
        // plan/intake tiers.
      }
      // Gate-active with no eligible implement candidate (or only non-critical):
      // fall through to plan/intake. The caller below must NOT report 'no-
      // candidate' when the remaining backlog is empty and the gate is active;
      // it must report 'review-queue-hold' instead (never 'no-candidate'), so
      // the no-candidate cooldown is not triggered (WL-0MTTSWC1X005P4VD AC2).
      if (gateActive) {
        let planIntakeEmpty = true;
        if (panesEligible) {
          const intakeComplete = await deps.getNextItem('intake_complete', opts.cwd);
          if (intakeComplete.ok && intakeComplete.candidate !== null && intakeComplete.candidate.needsProducerReview !== true) {
            planIntakeEmpty = false;
          }
        }
        if (planIntakeEmpty) {
          return { dispatched: false, reason: REVIEW_QUEUE_HOLD_REASON };
        }
        // plan/intake has candidates — fall through below to dispatch them.
      }
    }
    // Tier 2 (intake_complete → /skill:plan). A CLI error here does NOT
    // short-circuit: tier 3 is still attempted so a tier-3 candidate can
    // still dispatch (operator refinement). Pane minimum (parent
    // WL-0MT32F90V008UAD2 AC3): plan/intake need ≥ 1 free slot — via the
    // worker this is always true (the idle-duration gate has already
    // required ≥ N ≥ 1 free), the gate is defensive for direct API callers.
    let tier2Error = false;
    let tier2ErrorDetail: string | undefined;
    if (panesEligible) {
      const intakeComplete = await deps.getNextItem('intake_complete', opts.cwd);
      if (intakeComplete.ok) {
        if (intakeComplete.candidate !== null && intakeComplete.candidate.needsProducerReview !== true) {
          return await dispatchClaimedTier(deps, 'plan', intakeComplete.candidate, { ...opts, selectionPath: 'legacy-tier', selectionReason: 'non-critical' });
        }
      } else {
        tier2Error = true;
        tier2ErrorDetail = intakeComplete.error;
      }
    } else {
      // 0 free slots (defensive, unreachable via the worker): the panes
      // cannot run — treat as an empty backlog (no candidate dispatchable).
      return { dispatched: false, reason: 'no-candidate' };
    }

    // Tier 3 (idea → /skill:intake) is ALWAYS attempted when tier 2 produced
    // no candidate — including when tier 2 errored.
    const idea = await deps.getNextItem('idea', opts.cwd);
    if (idea.ok) {
      if (idea.candidate !== null && idea.candidate.needsProducerReview !== true) {
        return await dispatchClaimedTier(deps, 'intake', idea.candidate, { ...opts, selectionPath: 'legacy-tier', selectionReason: 'non-critical' });
      }
      if (tier2Error) {
        // Tier 2 errored and tier 3 answered empty: the backlog is NOT
        // provably empty (the intake_complete state is unknown) → fail
        // closed to busy (a strike), never a no-candidate — partial
        // information must not pause the worker.
        return { dispatched: false, reason: 'wl-error', error: tier2ErrorDetail };
      }
      // Both tiers answered with no candidate → genuine empty backlog. The
      // freeze gate must NOT pause the worker on an empty plan/intake
      // backlog: during a freeze that is a freeze skip (reason
      // 'code-freeze'), never the no-candidate cooldown — polling continues
      // so implement/audit dispatch resumes immediately when the freeze
      // lifts (WL-0MSQ0RPQP00636JY).
      return frozen
        ? { dispatched: false, reason: 'code-freeze' }
        : cpuSaturated
          ? { ...cpuEvidence, dispatched: false, reason: CPU_SATURATED_REASON }
          : freshnessSkip
          ? { dispatched: false, reason: 'fresh-audit-skip' }
          : auditInFlight
            ? {
                dispatched: false,
                reason: auditHostSaturated ? 'audit-host-saturated' : 'audit-in-flight',
              }
            : auditCheckFailed
              ? { dispatched: false, reason: 'wl-error', error: tier2ErrorDetail }
              : { dispatched: false, reason: 'no-candidate' };
    }
    // Tier 3 errored (with or without a tier-2 error): fail closed to busy.
    // The worker counts this as one CLI-error strike; the backlog is not
    // provably empty so this is never `no-candidate` (the three-strike rule
    // governs when consecutive errors pause the worker).
    return { dispatched: false, reason: 'wl-error', error: (idea as { error?: string }).error ?? tier2ErrorDetail };
  } finally {
    dispatchInFlightCount -= 1;
  }
}
