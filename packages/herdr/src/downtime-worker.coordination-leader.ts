/**
 * packages/herdr/src/downtime-worker.coordination-leader.ts — leader-side
 * coordination dispatch.
 *
 * Single responsibility: the leader's half of leader-election coordination —
 * dispatch the OFFER list in file order under every safety gate (gated
 * dispatch), keep the depth-aware audit-batch runtime, scan the leader's own
 * head as a fallback, and compute/upsert this instance's check-in offer.
 *
 * Parent: WL-0MVF3F9A7000HKP7 (decompose the `downtime-worker.ts` god class).
 * Extracted verbatim from `downtime-worker.ts` by WL-0MVLII1AO007TTRK (extract
 * downtime-worker coordination modules). No behaviour change: offer file
 * semantics (one offer per instance, file-order dispatch, re-validation at
 * dispatch time via `fetchItem` → `classifyItemForDispatch`), the retired-tier
 * note, cross-root ordering and the check-in cadence are unchanged. It imports
 * the offer computation from `downtime-worker.coordination.ts` (one direction
 * only) plus the gates/pane/dispatch-claims siblings — never the barrel.
 */

import { resolveSprintViewWindow } from './browse-window.js';
import { removeOffer, type CoordinationEntry } from './coordination.js';
import type { DowntimeLogEntry } from './downtime-log.js';
import { selectLeastRecentlyServed } from './downtime-round-robin-by-root.js';
import { clampDowntimeAuditBatchMax } from './downtime-worker.clamps.js';
import {
  createCoordinationBatchRuntime,
  readOwnHeadWindow,
  type CoordinationBatchRuntime,
} from './downtime-worker.coordination-batch.js';
import { computeMostImportantItem, toCoordinationCandidate, type CoordinationDeps } from './downtime-worker.coordination.js';
import {
  dispatchFromOwnHead,
  dispatchFromRegisteredRoots,
  type HeadScanBase,
  type HeadScanHolds,
} from './downtime-worker.head-scan.js';
import {
  withOfferRejections,
  type CoordinationOfferRejection,
  type DispatchGateToken,
} from './downtime-worker.offer-attribution.js';
import {
  entryOffers,
  orderAdmissibleOffers,
  type AdmissibleOffer,
} from './downtime-worker.offer-selection.js';
import { resolveTerminalOutcome } from './downtime-worker.terminal-reason.js';
import {
  DEFAULT_DOWNTIME_AUDIT_BATCH_MAX,
  DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS,
  DEFAULT_DOWNTIME_MAX_ATTEMPTS,
  DEFAULT_DOWNTIME_NON_TERMINAL_COOLDOWN_MS,
  DEFAULT_DOWNTIME_STALL_THRESHOLD_MS,
  DOWNTIME_PANE_MIN_FREE_SLOTS,
} from './downtime-worker.constants.js';
import {
  dispatchClaimedTier,
  dispatchScheduledPrompt,
} from './downtime-worker.dispatch-claims.js';
import {
  isAuditBudgetHoldOutcome,
  isHostBudgetHoldReason,
  type DowntimeDispatchOutcome,
} from './downtime-worker.dispatch-contract.js';
import {
  hostCpuGateEvidence,
  resolveCpuGate,
} from './downtime-worker.dispatch-cpu-gate.js';
import {
  auditItemEligible,
  auditPinAdmits,
  classifyItemForDispatchDetail,
  computeAuditEligibleDepth,
  finalizeAuditBatchOutcome,
  flagBudgetExhausted,
  isAttemptBudgetExhausted,
  isImplementHeldByReviewGate,
  readReviewQueueGate,
  type ReviewQueueGateResult,
} from './downtime-worker.gates.js';
import {
  isNonTerminalCooldownActive as _isNonTerminalCooldownActive,
  readDowntimeLogEntries as _readDowntimeEntries,
} from './downtime-log.js';
import { resolveInFlightPanes } from './downtime-worker.pane.js';
import {
  STALLED_RESUME_REASON,
  resumeStalledWorkIfAble,
} from './downtime-worker.stalled-resume.js';
import type {
  DowntimeHerdrListResult,
  DowntimeItemResult,
  InFlightPanes,
} from './downtime-worker.types.js';
import type { LocalPreference, LocalPreferenceMode } from './local-preference.js';

/**
 * The leader-facing dependency slice: the offer seams plus the item re-fetch
 * the dispatch-time re-validation needs (see `CoordinationLeaderDeps.fetchItem`).
 * Named structurally so this module never imports the barrel.
 */
export type CoordinationLeaderDeps = CoordinationDeps & {
  /** Re-fetch one offered item in its own worklog root (dispatch-time re-validation). */
  fetchItem?(itemId: string, cwd: string): Promise<DowntimeItemResult>;
};


/**
 * Leader-only dispatch from the shared coordination OFFER list
 * (WL-0MTK1ILM2009QYB2 "dispatcher == Herdr list head"): the
 * coordination file holds ONE entry per instance. Since v2
 * (parent WL-0MWDDHQON0015T3P AC1) each entry advertises up to three
 * BUCKET nominees (`implement` / `audit` / `prep`) drawn from that
 * instance's own worklog Herdr list head at the owner's check-in
 * (`computeMostImportantItem`, canonical ranking via
 * fetcher → smart-selection → grouping); a legacy v1 entry advertises its
 * single `workItemId` as one offer (AC9). The leader does NOT re-rank the
 * offers (no tier priority, no round-robin cursor — those second
 * orderings are retired by WL-0MTK1ILM2009QYB2 AC1–2): ENTRIES dispatch
 * in file order, and every safety gate is a sequential FILTER at
 * dispatch time on each OFFER (WL-0MTMPIQBE001J41P — no wall-clock
 * prune):
 *  - `fetchItem` re-fetch: the offer is validated against the item's
 *    CURRENT state (a stale offer — item closed/in_progress/review-gated
 *    or otherwise non-dispatchable — is dropped via `removeOffer`, no
 *    pane, no marker, no cursor, and dispatch continues to the next
 *    offer);
 *  - `classifyItemForDispatch` maps the fetched item to its dispatch
 *    skill and enforces the producer-review gate + audit freshness/
 *    recency + implement caps;
 *  - code-freeze split-by-skill: audit/implement offers skip while frozen
 *    (plan/intake still dispatch);
 *  - review-queue depth gate (WL-0MT2UQWOR007CYY9, rewired by
 *    WL-0MTTSWC1X005P4VD): a NON-CRITICAL implement offer is HELD (entry
 *    kept, skipped this cycle) while ITS OWN root's completed/in_review
 *    queue is deep — audits (the queue drain), plan, intake and critical
 *    implements flow unconditionally; when every surviving offer is held,
 *    the outcome reason is the neutral 'review-queue-hold' (never
 *    'no-candidate' / cooldown);
 *  - per-tier free-slot minimums (audit ≥ 2, single-pane ≥ 1);
 *  - non-terminal pane-close cooldown (WL-0MUKYERLZ006ELL5): an offer whose
 *    previous same-kind pane closed without reaching a terminal stage is
 *    KEPT but skipped this cycle until `downtimeNonTerminalCooldownMs`
 *    elapses (or the item advances past its dispatched-at stage); when every
 *    surviving offer is cooldown-held the outcome is the neutral
 *    'non-terminal-cooldown' (never 'no-candidate').
 *
 * The filter chain is applied to EVERY offer of an entry, unchanged and in
 * this order (parent AC4 — no gate duplicated, relaxed or reordered):
 * classify → attempt budget → non-terminal cooldown → per-root code freeze →
 * CPU gate → audit slot minimum/pin → review-queue hold → host-budget
 * admission → CAS claim. `classifyItemForDispatch` remains the single
 * classifier; the offer's declared bucket is never a gate verdict.
 *
 * ## Drain-aware tie-break (parent AC5)
 *
 * Among the offers of ONE entry that are simultaneously ADMISSIBLE, dispatch
 * order is audit-drain (the entry root's review queue is at/over
 * `browseItemCount`, so audits — the queue drain — go first) → prep (keeps
 * implement fed) → implement. A fixed implement-first ladder is deliberately
 * NOT implemented (precedent WL-0MW9X7EJ6009EL6E). The tie-break is a
 * selection ORDER, never a gate: a filter that refuses an offer still refuses
 * it. Cross-root round-robin still owns ROOT order, so tier choice happens
 * only inside an entry and no root gains an unfair share (AC8).
 *
 * The first admissible offer — in tie-break order — dispatches via the
 * existing `dispatchClaimedTier` pipeline (CAS claim → marker write → host
 * admission → spawn), and ONLY that offer is removed (parent AC6): the
 * entry's remaining nominees and its `lastUpdated` are untouched, so the next
 * tick can dispatch the next tier without waiting for the owner's check-in.
 * An entry whose last offer dispatches is dropped exactly as before (AC9). A
 * claimed-but-failed spawn also consumes just that offer (the marker +
 * in_progress claim prevent a double dispatch).
 *
 * Fail-closed at every boundary: a wl failure fetching an entry resolves
 * `wl-error` only when EVERY entry failed (a fully broken lookup — a
 * strike); a per-entry failure skips that entry (fail-open per instance,
 * parent risk mitigation — one broken worklog must not starve the rest).
 *
 * ## Continuable holds and terminal-reason precedence
 *
 * A budget refusal is a CONTINUABLE HOLD (WL-0MWBT76WY00298AY): the offer
 * loop records the first refusal and keeps trying the remaining offers, and
 * the own-head scan records it on `HeadScanHolds.hostBudget` /
 * `HeadScanHolds.auditBudget` and steps to the next candidate, so prep work
 * ranked behind a budget-refused candidate still dispatches. When nothing
 * else dispatches, the terminal-reason chain folds those holds in with a
 * fixed precedence (WL-0MWDDHVF2004PTYX AC2 — the AUDIT rung was added
 * ABOVE the host rung so an audit refusal with `detail: 'http-404'` — a
 * broken proxy contract — is never masked by an ambient implement-cap
 * statement):
 *
 *     code-freeze → CPU → review-queue → non-terminal cooldown →
 *     attempt budget → in-flight → leaf-audit pin → audit budget →
 *     host budget → no-candidate
 *
 * so a budget hold reports the neutral refusal (never `no-candidate`) with
 * its `{live, max}` evidence — and, on an audit-budget refusal, the failing
 * exchange on `detail` — no strike, no cooldown, no attempt-budget charge.
 */
export async function dispatchFromCoordination(
  deps: CoordinationLeaderDeps,
  entries: CoordinationEntry[],
  opts: { model: string; cwd: string; coordinationDir: string; localPreference?: LocalPreference; /** Locality precedence opt-in (WL-0MVNUIW77000VYAX AC4); absent keeps legacy fixed forwarding. */ localPreferenceMode?: LocalPreferenceMode; freeSlots?: number; /** Prefill-paced budget (single-pane tiers); audit uses raw `freeSlots` (WL-0MVR8FI4Q0007CGR). */ effectiveFreeSlots?: number; leaseTtlMs?: number; browseItemCount?: number; nonTerminalCooldownMs?: number; maxAttempts?: number; markerStaleWindowMs?: number; stallScanEnabled?: boolean; stallScanThresholdMs?: number;
    /**
     * Host-CPU gate threshold (WL-0MVK0UO3Q002TXW6 AC2/AC5): live
     * `downtimeCpuGatePercent` re-read every tick. At or above it new
     * audit/implement offers are KEPT but skipped this cycle, the own-backlog
     * fallback / audit-batch continuation skip those kinds, and stalled panes
     * are not resumed. `0` disables. Optional — absent falls back to the
     * default (75).
     */
    cpuGatePercent?: number;
    /** Depth-aware audit-batch cap (parent WL-0MVEDM8OT007WDRS AC1); optional — absent leaves batching off. */ auditBatchMax?: number; /** Depth-aware audit-batch continuation budget (parent WL-0MVEDM8OT007WDRS AC1); consumed by the coordination continuation item (WL-0MVFE1DD8000D8T2). */ auditBatchRemaining?: number; /** Batch-local exclusion set: item ids already dispatched in the current audit batch (WL-0MVFE1DD8000D8T2 AC3/AC4). Never re-selected within one batch. */ auditBatchDispatchedIds?: readonly string[];
    /**
     * Relaxed leaf-audit admission pin (C4, WL-0MVV1F0HK009JQAP; wired to the
     * leader by WL-0MVV1F130009VZ1P C5): the tick admitted this dispatch in the
     * single-free-slot band for ONE classified leaf audit offer, so every
     * non-audit offer is ineligible (`slots-unavailable`) and the audit tier
     * admits no other candidate. `undefined` = no relaxation (unchanged).
     */
    pinnedAuditItemId?: string;
    /**
     * Resolved `downtimeWorklogRoots` roots the leader may sweep (WL-0MVR8GDJ3008WY3Y O1): already validated/normalised by `loadSettings`; absent/empty ⇒ no sweep (AC6).
     */
    registeredRoots?: readonly string[] },
  now: number = Date.now(),
): Promise<DowntimeDispatchOutcome> {
  // Depth-aware audit-batch surface (parent WL-0MVEDM8OT007WDRS AC1–AC5):
  // every outcome of this invocation is finalized against the leader's own
  // audit-eligible depth so the worker can decide the idle-reset deferral and
  // the (deferred) leadership hand-off without re-deriving state. Skipped
  // entirely when the caller supplies no batch surface, keeping direct API
  // callers byte-for-byte unchanged.
  const batchSupplied =
    opts.auditBatchMax !== undefined || opts.auditBatchRemaining !== undefined;
  const batchRuntime = createCoordinationBatchRuntime(deps, opts, now);
  const outcome = await dispatchFromCoordinationGated(deps, entries, opts, now, batchRuntime);
  if (!batchSupplied) return outcome;
  const cap = clampDowntimeAuditBatchMax(
    opts.auditBatchMax ?? DEFAULT_DOWNTIME_AUDIT_BATCH_MAX,
  );
  const remainingBefore =
    opts.auditBatchRemaining === undefined
      ? cap
      : Math.max(0, Math.trunc(opts.auditBatchRemaining));
  const threshold = resolveSprintViewWindow(opts.browseItemCount);
  const finalized = finalizeAuditBatchOutcome(outcome, {
    depth: await batchRuntime.readDepth(),
    cap,
    threshold,
    remainingBefore,
  });
  if (finalized.auditBatchContinuation !== true) return finalized;
  // AC4: the own-backlog leadership hand-off is deferred to BATCH END. Raise
  // the step-down surface only when THIS continuation ended the batch (cap
  // reached or depth dropped); a failed continuation never hands off (AC3).
  const status = finalized.auditBatch;
  const batchEnded = status === undefined || !status.active || status.remaining <= 0;
  const { auditBatchContinuation: _continuation, ...rest } = finalized;
  return {
    ...rest,
    auditBatchContinuation: true,
    ownBacklogDispatch: finalized.dispatched && batchEnded,
  };
}

/**
 * The gate-and-scan half of `dispatchFromCoordination` (unchanged behaviour):
 * safety gates, scheduled prompts, the coordination offer scan and the
 * own-backlog fallback. Split out so the audit-batch surface can be applied to
 * EVERY outcome once, in `dispatchFromCoordination`.
 */
async function dispatchFromCoordinationGated(
  deps: CoordinationLeaderDeps,
  entries: CoordinationEntry[],
  opts: Parameters<typeof dispatchFromCoordination>[2],
  now: number,
  batchRuntime: CoordinationBatchRuntime,
): Promise<DowntimeDispatchOutcome> {
  // The leader path REQUIRES the item-fetch dep: without it the leader can
  // never classify an entry — fail closed to a strike (a misconfigured
  // deployment must be visible, not silently idle).
  if (typeof deps.fetchItem !== 'function') {
    return { dispatched: false, reason: 'wl-error', error: 'fetchItem unavailable' };
  }
  const freezeStatus = deps.readCodeFreezeStatus(opts.cwd);
  const frozen = freezeStatus === 'frozen' || freezeStatus === 'ambiguous';

  // ── Host-CPU gate (WL-0MVK0UO3Q002TXW6 AC2–AC4) ──
  // ONE reading per dispatch tick (the sampler keeps the previous /proc/stat
  // sample in memory). At or above the live threshold new audit/implement
  // dispatch is refused while plan/intake/risk-effort keep flowing and the
  // stalled-work resume is skipped (it would wake an agent and add load).
  // Neutral: the coordination entry is KEPT (never removed), no strike, no
  // no-candidate cooldown. Fail-open when the reading is unusable.
  const cpuGate = resolveCpuGate(deps, opts.cpuGatePercent);
  const cpuSaturated = cpuGate.saturated;
  const cpuEvidence = hostCpuGateEvidence(cpuGate);
  let cpuHold = false;

  // Per-offer rejection attribution (WL-0MVR8FKMU009XTED AC2): every entry
  // rejected at dispatch time records its id, root and the STABLE gate token,
  // so the terminal reason can never collapse them into a bare
  // `no-candidate`. Derived from the entries snapshot already read.
  const offerRejections: CoordinationOfferRejection[] = [];
  const rejectOffer = (
    offer: { workItemId: string },
    worklogRoot: string,
    gate: DispatchGateToken,
    assignee?: string,
  ): void => {
    offerRejections.push({
      workItemId: offer.workItemId,
      worklogRoot,
      gate,
      ...(assignee !== undefined && assignee.trim().length > 0 ? { assignee: assignee.trim() } : {}),
    });
  };
  // Attribution is PER OFFER, not per instance (parent AC4): a v2 entry advertises
  // up to three nominees, so flatten every entry's offer list.
  const rejectedOffers = (
    list: CoordinationEntry[],
    gate: DispatchGateToken,
  ): CoordinationOfferRejection[] =>
    list.flatMap((entry) =>
      entryOffers(entry).map((offer) => ({
        workItemId: offer.workItemId,
        worklogRoot: entry.worklogRoot ?? entry.directory,
        gate,
      })),
    );

  // No wall-clock prune (WL-0MTMPIQBE001J41P) — entries persist until
  // dispatch-time eligibility check (fetchItem+classify) finds them
  // non-dispatchable. Stale offers are dropped at dispatch, never by age.

  // Per-tier free-slot minimums (parent WL-0MT32F90V008UAD2 AC3): the
  // audit tier needs ≥ 2 slots (parent + Phase 2 child at
  // AUDIT_PHASE2_PARALLELISM=1); every single-pane tier needs ≥ 1. When
  // freeSlots is absent (direct API callers), the minimums do not gate
  // (fail-open for direct API use — the worker always passes the count).
  const freeSlots = opts.freeSlots;
  // The audit minimum is a SLOT-COUNT requirement (parent + Phase 2 child):
  // evaluate it against the raw slot budget, never the prefill-concurrency
  // budget (WL-0MVR8FI4Q0007CGR AC2). Single-pane tiers keep the prefill-
  // paced budget as their >= 1 slot input. The per-CANDIDATE decision is
  // `auditItemEligible` in the offer/own-head filters below (leaf-aware,
  // parent WL-0MSORQ8Y4004YT63 C3 — wired here by WL-0MVV1F130009VZ1P C5).
  const auditSlotBudget = freeSlots;
  const pinnedAuditItemId = opts.pinnedAuditItemId;
  const panesBudget = opts.effectiveFreeSlots ?? freeSlots;
  // A relaxed leaf-audit tick (C4) reserves its single free slot for the
  // PINNED audit item: every single-pane tier is ineligible, exactly as on
  // the direct path, so the relaxed budget can never leak to another tier.
  const panesEligible =
    pinnedAuditItemId === undefined &&
    (panesBudget === undefined || panesBudget >= DOWNTIME_PANE_MIN_FREE_SLOTS);
  if (!panesEligible && pinnedAuditItemId === undefined) {
    // No slot can host a pane — nothing to dispatch (mirrors the legacy
    // tier chain's 0-free-slots defensive no-candidate). A relaxed pin
    // continues to the audit-only offer scan instead.
    return withOfferRejections(
      { dispatched: false, reason: 'no-candidate' },
      rejectedOffers(entries, 'slots-unavailable'),
    );
  }

  // ── Stalled-work scan (WL-0MUYMBSA90092QV2 AC1/AC3/AC4) ──
  // Idle-gated (free slot present) and immediately before new-item
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
      now,
    });
    if (resumed) return { dispatched: false, reason: STALLED_RESUME_REASON };
  }

  // Review-queue depth gate (WL-0MT2UQWOR007CYY9, live-path rewire by
  // WL-0MTTSWC1X005P4VD): read ONCE per offer root (cached for this
  // invocation). Each root's queue depth is authoritative for ITS OWN
  // non-critical implement offers (audits/plan/intake/critical flow
  // unconditionally). Frozen → null (implements are already freeze-paused).
  const reviewGateCache = new Map<string, ReviewQueueGateResult>();
  const reviewGateForRoot = async (root: string): Promise<ReviewQueueGateResult | null> => {
    if (frozen) return null;
    if (!reviewGateCache.has(root)) {
      reviewGateCache.set(root, await readReviewQueueGate(deps, root, opts.browseItemCount));
    }
    return reviewGateCache.get(root) ?? null;
  };

  // Item-scoped in-flight cache (WL-0MUBEZ6PE002WLP4 / F4
  // WL-0MUBVKYH5009CGBI): resolved per OFFER root (never the leader's own
  // root — the WL-0MTQ14W7L003II5A cross-root invariant), so a leader-side
  // TOCTOU re-check rejects an offer whose pane appeared after the owner
  // computed it (AC2.10). Cached so each root is queried at most once.
  const inFlightCache = new Map<string, InFlightPanes>();
  const inFlightForRoot = async (root: string): Promise<InFlightPanes> => {
    if (!inFlightCache.has(root)) {
      inFlightCache.set(root, await resolveInFlightPanes(deps, root));
    }
    return inFlightCache.get(root) ?? { available: false, itemIds: new Set() };
  };
  let inFlightHold = false;

  // Non-terminal pane-close cooldown (WL-0MUKYERLZ006ELL5): read the rolling
  // dispatch log ONCE per OFFER root (cached) — the log is per-worklog-root,
  // like the review gate and in-flight caches above.
  const cooldownEntriesCache = new Map<string, DowntimeLogEntry[]>();
  const cooldownEntriesForRoot = async (root: string): Promise<DowntimeLogEntry[]> => {
    if (!cooldownEntriesCache.has(root)) {
      cooldownEntriesCache.set(root, await _readDowntimeEntries(root));
    }
    return cooldownEntriesCache.get(root) ?? [];
  };
  const cooldownMs = opts.nonTerminalCooldownMs ?? DEFAULT_DOWNTIME_NON_TERMINAL_COOLDOWN_MS;
  let cooldownHold = false;
  // Dispatched-marker staleness window (WL-0MU6UL0RJ008IHGT): forwarded to
  // the own-backlog fallback's marker exclusion (the offer path consults the
  // marker through `fetchItem` + staleness maps below).
  const markerStaleWindowMs = opts.markerStaleWindowMs ?? DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS;
  // Per-item/per-kind attempt-budget hold (WL-0MUKYEXMK0033MFK): neutral hold
  // — the backlog is not empty, so the caller must not pause or drop the
  // entry. A flagged set keeps the producer-review flag to at most one write
  // per dispatch (AC7c).
  const maxAttempts = opts.maxAttempts ?? DEFAULT_DOWNTIME_MAX_ATTEMPTS;
  let budgetHold = false;
  // A relaxed leaf-audit pin held at least one offer (C4/C5): the reserved
  // slot, not an empty backlog, is why nothing dispatched.
  let pinHeld = false;
  // Host-budget hold (WL-0MVXY0YG7009JMHI F3 AC5): the first offer refused by
  // the machine-wide implement cap. The offer is KEPT (valid work — only the
  // host is full) and the tick ends on the refusal, never 'no-candidate', so
  // no cooldown/strike is recorded and the next idle tick re-checks.
  let hostBudgetHold: DowntimeDispatchOutcome | undefined;
  // Audit-budget hold (WL-0MWDDHVF2004PTYX): the first offer refused by the
  // proxy-derived AUDIT budget (`audit-budget-saturated` /
  // `audit-budget-unknown`, or the legacy `host-budget-audit` /
  // `audit-host-saturated`). Mirrors `hostBudgetHold` — the offer is KEPT, the
  // hold is neutral (no strike, no cooldown, no attempt-budget charge), and
  // the tick ends on the refusal. Recorded SEPARATELY so the terminal chain
  // can rank it ABOVE an implement refusal: an audit refusal with
  // `detail: 'http-404'` is a broken proxy contract, not an ambient
  // implement-cap statement (AC2). `rejectedOffers` attribution carries the
  // `audit-budget` gate token (AC5).
  let auditBudgetHold: DowntimeDispatchOutcome | undefined;
  const flaggedForBudget = new Set<string>();

  // Scheduled-prompts tier (WL-0MSS1Q5ER007QDKX): FIRST dispatch stage,
  // gated by the SAME fresh-read code-freeze marker as the audit/implement
  // tiers (AC5) — while frozen OR ambiguous (fail-closed) scheduled prompts
  // are skipped so no new code changes land mid-release, and dispatch falls
  // through to the coordination tiers below. A due prompt dispatches its
  // prompt text immediately — it never reaches the backlog tiers, so it
  // never triggers the no-candidate cooldown (AC6). Absent or malformed
  // config resolves null (fail-closed, logged by the dep): no scheduled
  // dispatch and the tiers below are unaffected (AC2).
  if (!frozen && panesEligible) {
    const duePrompt = await deps.getDueScheduledPrompt(opts.cwd);
    if (duePrompt !== null) {
      return await dispatchScheduledPrompt(deps, duePrompt, {
        model: opts.model,
        cwd: opts.cwd,
        ...(opts.localPreference !== undefined ? { localPreference: opts.localPreference } : {}),
        ...(opts.localPreferenceMode !== undefined
          ? { localPreferenceMode: opts.localPreferenceMode }
          : {}),
      });
    }
  }

  // Entries are OFFERS — one per instance, each naming that instance's
  // own worklog Herdr list head at its last check-in (computeMostImportantItem).
  // The leader dispatches in ROUND-ROBIN across worklogRoots: the
  // least-recently-served project root is selected first (cursor advances
  // atomically via selectLeastRecentlyServed). WL-0MTMPIQBE001J41P: entries
  // persist until dispatch-time eligibility finds them non-dispatchable; a
  // stale offer is removed eagerly (no pane, no marker) and dispatch
  // continues to the next offer.
  // Round-robin cross-project dispatch: select the least-recently-served
  // project root before dispatch iteration (wire in the cursor infrastructure
  // that was implemented but never connected — WL-0MTQ2FGSK004CBRK).
  const entryRoots = entries
    .filter(e => e.instanceId.length > 0 && entryOffers(e).length > 0)
    .map(e => e.worklogRoot ?? e.directory);
  const selectedRoot = selectLeastRecentlyServed(opts.coordinationDir, entryRoots, now);
  if (selectedRoot !== null) {
    const idx = entries.findIndex(
      e => (e.worklogRoot ?? e.directory) === selectedRoot,
    );
    if (idx > 0) {
      const [selected] = entries.splice(idx, 1);
      entries.unshift(selected);
    }
  }

  let fetchAttempts = 0;
  let fetchFailures = 0;
  let lastFetchError: string | undefined;
  let lastEntryWorkItemId: string | undefined; // WL-0MTJPYM53003ORCV
  // True when at least one non-critical implement offer was held this cycle
  // by the review-queue depth gate (drives the terminal reason).
  let reviewHold = false;
  const ownHeadHolds: HeadScanHolds = {
    budget: false,
    cooldown: false,
    inFlight: false,
    review: false,
    cpu: false,
  };
  // Audit-batch continuation budget (parent WL-0MVEDM8OT007WDRS AC1/AC4): the
  // clamped cap and the continuation budget available BEFORE this dispatch
  // (absent `auditBatchRemaining` initialises it to the cap — the first
  // dispatch of a potential batch; `1` disables batching).
  const batchCap = clampDowntimeAuditBatchMax(
    opts.auditBatchMax ?? DEFAULT_DOWNTIME_AUDIT_BATCH_MAX,
  );
  const batchRemainingBefore =
    opts.auditBatchRemaining === undefined
      ? batchCap
      : Math.max(0, Math.trunc(opts.auditBatchRemaining));

  for (const entry of entries) {
    if (entry.instanceId.length === 0) continue;
    const offers = entryOffers(entry);
    if (offers.length === 0) continue;
    const worklogRoot = entry.worklogRoot ?? entry.directory;
    // Rejections are per OFFER but the SUCCESS outcome describes one entry's
    // decision, so only THIS entry's slice rides along with a dispatch: a peer
    // entry's refusal belongs to that entry's own attribution and must never
    // pollute this outcome (WL-0MWDDHVF2004PTYX AC7).
    const rejectionsBeforeEntry = offerRejections.length;
    // ── Phase 1 — the UNCHANGED sequential filter chain, per offer ─────
    // (parent WL-0MWDDHQON0015T3P AC4.) Iterating the entry's offers is what
    // stops one refused bucket from hiding the entry's other nominees; every
    // filter below is the pre-tier-aware block verbatim — no gate duplicated,
    // relaxed or reordered. A survivor is only ADMISSIBLE here: the
    // drain-aware tie-break in phase 2 still owns the dispatch decision, and
    // `classifyItemForDispatchDetail` stays the single classifier (the offer's
    // declared bucket is never used as a gate verdict).
    const admissible: AdmissibleOffer[] = [];
    for (const offer of offers) {
      fetchAttempts += 1;
      const result = await deps.fetchItem(offer.workItemId, worklogRoot);
      if (!result.ok) {
        // Per-offer wl/parse failure — tolerated (fail-open per instance:
        // one broken worklog must not starve the rest).
        fetchFailures += 1;
        lastFetchError = (result as { error?: string }).error ?? 'fetchItem failed';
        lastEntryWorkItemId = offer.workItemId; // WL-0MTJPYM53003ORCV
        rejectOffer(offer, worklogRoot, 'wl-error');
        continue;
      }
      // Sequential FILTERS on the offer (never a ranking).
      // Producer-review gate (parent WL-0MTIAL65N004T22F AC3) + dispatch-
      // time eligibility (WL-0MTMPIQBE001J41P): a now-gated or otherwise
      // non-dispatchable offer is stale — remove it, no pane, no marker.
      const classification = classifyItemForDispatchDetail(result.info, now);
      const kind = classification.kind;
      if (kind === null) {
        rejectOffer(offer, worklogRoot, classification.gate, result.info.assignee ?? undefined);
        removeOffer(opts.coordinationDir, entry.instanceId, offer.workItemId);
        continue;
      }
      // Per-item/per-kind attempt budget (WL-0MUKYEXMK0033MFK AC1/AC2/AC3):
      // flag the item for producer review and keep the offer (it is still a
      // valid offer once a human clears the flag) but skip it this cycle.
      // Neutral — never a strike, never 'no-candidate' (AC5).
      if (isAttemptBudgetExhausted(await cooldownEntriesForRoot(worklogRoot), result.info.id, kind, result.info.stage, maxAttempts)) {
        if (!flaggedForBudget.has(result.info.id)) {
          flaggedForBudget.add(result.info.id);
          await flagBudgetExhausted(deps, result.info.id, worklogRoot);
        }
        budgetHold = true;
        rejectOffer(offer, worklogRoot, 'attempt-budget-exhausted');
        continue;
      }
      // Non-terminal pane-close cooldown (WL-0MUKYERLZ006ELL5): neutral
      // sequential filter — keep the offer (it is still a valid offer) but
      // skip it this cycle while the cooldown holds. Never a strike, never
      // 'no-candidate'.
      if (
        _isNonTerminalCooldownActive(
          await cooldownEntriesForRoot(worklogRoot),
          result.info.id,
          kind,
          result.info.stage,
          cooldownMs,
          now,
        )
      ) {
        cooldownHold = true;
        rejectOffer(offer, worklogRoot, 'non-terminal-cooldown');
        continue;
      }
      // Code-freeze split-by-skill: audit/implement/risk-effort offers pause
      // during a freeze/ambiguous marker (plan/intake still dispatch). A frozen
      // offer is stale for the dispatch window — drop it so the owner re-offers
      // its next head at the next check-in.
      if (frozen && (kind === 'audit' || kind === 'implement' || kind === 'risk-effort')) {
        rejectOffer(offer, worklogRoot, 'code-freeze');
        removeOffer(opts.coordinationDir, entry.instanceId, offer.workItemId);
        continue;
      }
      // Host-CPU gate (WL-0MVK0UO3Q002TXW6 AC2/AC4): at or above the threshold
      // audit/implement offers are refused. The offer is KEPT — it is still a
      // valid offer and the next idle tick re-checks the live CPU (removing it
      // would also force an owner re-offer cycle for work that is only
      // temporarily held). Evaluated AFTER the freeze so a dual-gated tick
      // reports `code-freeze` (AC4 precedence).
      if (cpuSaturated && (kind === 'audit' || kind === 'implement')) {
        cpuHold = true;
        rejectOffer(offer, worklogRoot, 'cpu-saturated');
        continue;
      }
      // Relaxed leaf-audit tick (C4, WL-0MVV1F0HK009JQAP; leader-path wiring
      // C5 WL-0MVV1F130009VZ1P): the tick admitted this dispatch for ONE pinned
      // leaf audit, so no other tier may consume the relaxed slot — a non-audit
      // offer is reported `slots-unavailable` (the token the direct path uses
      // when its pane budget is unavailable).
      if (pinnedAuditItemId !== undefined && kind !== 'audit') {
        pinHeld = true;
        rejectOffer(offer, worklogRoot, 'slots-unavailable');
        continue;
      }
      // Audit-tier slot minimum: an audit pane needs a second slot for its
      // Phase 2 child (WL-0MSORQ1RG005DGUS / WL-0MT32F90V008UAD2 AC3) — skip
      // the offer this cycle when too few slots are free, but KEEP it (it is
      // still a valid offer; the next cycle may have the slot). The minimum is
      // PER CANDIDATE (leaf-aware, parent WL-0MSORQ8Y4004YT63 AC2/AC3): in the
      // single-free-slot band only a classified LEAF is eligible, so the leader
      // reaches the same decision as the direct path for the same candidate.
      if (kind === 'audit' && !auditPinAdmits(pinnedAuditItemId, result.info.id)) {
        pinHeld = true;
        rejectOffer(offer, worklogRoot, 'audit-slot-min');
        continue;
      }
      if (
        kind === 'audit' &&
        !(await auditItemEligible(deps, result.info, auditSlotBudget, worklogRoot))
      ) {
        // Budget precondition (AC3): the tick records the
        // `audit-tier-budget-skipped` observation for this same raw slot
        // budget; here we only attribute the rejected offer.
        rejectOffer(offer, worklogRoot, 'audit-slot-min');
        continue;
      }
      // Review-queue depth gate (WL-0MT2UQWOR007CYY9, live-path rewire by
      // WL-0MTTSWC1X005P4VD): hold a NON-CRITICAL implement offer while ITS
      // OWN root's review queue is deep. Audits (the queue drain), plan,
      // intake and critical implements flow unconditionally. The offer is
      // KEPT (not removed) — the queue may drain below the threshold at any
      // moment (an audit completes / producer reviews) and the next cycle
      // then dispatches it; the owner's check-in re-offers its next head
      // once the gate allows.
      if (kind === 'implement') {
        const gate = await reviewGateForRoot(worklogRoot);
        if (isImplementHeldByReviewGate(kind, result.info, gate)) {
          reviewHold = true;
          rejectOffer(offer, worklogRoot, 'review-queue-hold');
          continue;
        }
      }
      // Leader-side in-flight re-check (AC2.10): an offer computed BEFORE the
      // pane appeared must not dispatch now. Only a PROVEN live working pane
      // blocks (an unavailable query must not stall all coordination dispatch);
      // the owner's offer computation already applied the marker-TTL fallback.
      // The offer is KEPT — it is still valid once the pane finishes.
      if (result.info.priority === 'critical') {
        const inFlight = await inFlightForRoot(worklogRoot);
        if (inFlight.available && inFlight.itemIds.has(result.info.id)) {
          inFlightHold = true;
          rejectOffer(offer, worklogRoot, 'in-flight-pane');
          continue;
        }
      }
      admissible.push({ kind, info: result.info, offer });
    }

    // ── Phase 2 — drain-aware tie-break, then dispatch ────────────────
    // Parent AC5: when several offers of ONE entry are simultaneously
    // admissible, the order is audit-drain (the root's review queue is at/over
    // `browseItemCount`, so audits — the drain — go first) → prep (keeps
    // implement fed) → implement. A fixed implement-first ladder is explicitly
    // NOT implemented (precedent WL-0MW9X7EJ6009EL6E: implement-first inflates
    // the queue and starves both the audits that drain it and the prep that
    // feeds it). `sort` is stable, so file order still breaks a tie inside a
    // bucket. Tier choice never crosses roots: the round-robin above owns root
    // order (AC8), and a single-offer entry dispatches without an extra gate
    // read — its behaviour is byte-identical to pre-v2.
    const ordered = orderAdmissibleOffers(
      admissible,
      // The drain flag is the SAME per-root review-queue reading the chain
      // consults, cached for this tick — no second gate definition (AC4).
      admissible.length > 1 ? await reviewGateForRoot(worklogRoot) : null,
    );
    for (const chosen of ordered) {
      // Dispatch attempt (CAS claim → marker → host-budget admission → spawn).
      const outcome = await dispatchClaimedTier(
        deps,
        chosen.kind,
        toCoordinationCandidate(chosen.info),
        {
          model: opts.model,
          cwd: worklogRoot,
          localPreference: opts.localPreference,
          localPreferenceMode: opts.localPreferenceMode,
          selectionPath: 'coordination-offer',
          selectionReason: 'leader-offer',
        },
      );
      if (outcome.dispatched) {
        // Dispatched — remove ONLY this offer (parent AC6): the entry's
        // remaining nominees and its `lastUpdated` stay untouched, so the
        // next tick can dispatch the next tier without a fresh check-in; an
        // entry whose last offer dispatched is dropped exactly as before
        // (AC9). `removeOffer` owns both halves of that rule. The rejections
        // of the entry's OTHER offers ride along, so a multi-offer tick never
        // loses its per-offer attribution.
        removeOffer(opts.coordinationDir, entry.instanceId, chosen.offer.workItemId);
        return withOfferRejections(
          outcome,
          offerRejections.slice(rejectionsBeforeEntry),
        );
      }
      if (outcome.reservation?.admit === false) {
        // The proxy REFUSED the local-capacity ticket (parent AC3/AC4, slice
        // C3): a capacity deferral, not an offer problem. Keep the offer (it
        // is still valid) and return the refusal evidence WITHOUT falling
        // through to the own-backlog fallback — that fallback would retry other
        // items and eventually report a generic terminal reason, losing the
        // `admit: false` / `retryAfterS` / proxy-reason evidence the decision
        // log needs to distinguish a lost reservation race from a paced stop
        // (coordination-path parity, C3-AC4).
        return outcome;
      }
      if (outcome.reason === 'claim-failed') {
        // Another pane won the CAS race — neutral; try the next admissible
        // offer (its own tier), then the next entry.
        continue;
      }
      if (outcome.reason === 'claim-rolled-back') {
        // Marker write failed and claim was rolled back (WL-0MT32F908002YFFA);
        // the item is back in the backlog — try the next admissible offer.
        continue;
      }
      if (isHostBudgetHoldReason(outcome.reason)) {
        // Machine-wide budget refusal (F3 AC5 / WL-0MWDDHVF2004PTYX): NEUTRAL
        // hold — keep the offer, no strike, no attempt budget, no cooldown
        // (AC4). The entry's OTHER nominees are still dispatched below (their
        // own admission), which is the motivating regression fix (parent AC7);
        // if none dispatches the tick ends on this refusal. The rung is
        // tier-decided: an IMPLEMENT refusal (`host-budget-implement`, or
        // `host-budget-unknown` from an implement admission) records
        // `hostBudgetHold`; an AUDIT refusal (`audit-budget-saturated` /
        // `audit-budget-unknown` + `detail`, or the legacy `host-budget-audit`
        // / `audit-host-saturated`) records `auditBudgetHold` on its own rung
        // so it is NEVER masked by `host-budget-implement` (AC1/AC2) — and is
        // attributed in the per-offer rejection payload with the `audit-budget`
        // gate token (AC5).
        if (isAuditBudgetHoldOutcome(outcome)) {
          auditBudgetHold ??= outcome;
          rejectOffer(chosen.offer, worklogRoot, 'audit-budget');
        } else {
          hostBudgetHold ??= outcome;
        }
        continue;
      }
      if (outcome.reason === 'wl-error') {
        // A wl failure is a strike — stop the cycle (three-strike rule
        // decides when to pause). Carry the offer's workItemId for logging.
        return { ...outcome, workItemId: chosen.offer.workItemId };
      }
      if (outcome.reason === 'anchor-unavailable') {
        // Dispatcher anchor provisioning failed (C0 WL-0MTR01EU7005SYZG): the
        // anchor is MACHINE-WIDE, so no other offer can spawn either — stop the
        // cycle now (neutral, no strike, no cooldown; the next idle tick
        // retries the provisioning). Keep the offer: it is still valid.
        return outcome;
      }
      if (outcome.reason === 'spawn-failed' || outcome.reason === 'marker-write-failed') {
        // The item is claimed (+ marked) but the pane never appeared: remove
        // only THAT offer (its item can never be re-offered safely); the
        // standing marker and the in_progress claim prevent double-dispatch,
        // and the entry's other nominees stay dispatchable.
        removeOffer(opts.coordinationDir, entry.instanceId, chosen.offer.workItemId);
        return withOfferRejections(
          outcome,
          offerRejections.slice(rejectionsBeforeEntry),
        );
      }
    }
  }

  // A wl lookup that failed for EVERY entry is a persistent CLI/parse
  // failure — a strike (never a silent no-candidate). Per-instance
  // failures are tolerated (fail-open). Carry the last entry's workItemId
  // for per-strike logging (WL-0MTJPYM53003ORCV).
  if (fetchAttempts > 0 && fetchFailures === fetchAttempts) {
    return withOfferRejections(
      {
        dispatched: false,
        reason: 'wl-error',
        error: lastFetchError ?? 'all fetchItem lookups failed',
        workItemId: lastEntryWorkItemId,
      },
      offerRejections,
    );
  }

  // ── Own-backlog fallback (parent WL-0MUU4XFU90008E24 AC1–AC9) ──────
  // Only reached when the coordination offer list yielded no dispatchable
  // candidate. The leader MAY then read its OWN backlog beyond the
  // sprint-view window: a bounded WINDOW EXTENSION of the SAME canonical
  // ranking (`getHerdrListHead`), never a second ranking, and ONLY against
  // the leader's own `opts.cwd` (never another instance's root — AC2). Every
  // existing safety gate is applied as a sequential filter (AC7):
  // classify (producer review / freshness / caps), dispatched-marker
  // exclusion, attempt budget, non-terminal cooldown, code-freeze,
  // audit slot minimum, in-flight (critical) and the review-queue hold.
  // The window is bounded by `DOWNTIME_DISPATCH_EXTEND_MAX` (AC9).
  // Fail-open: a `{ok:false}`/thrown/empty lookup resolves `[]`, leaving the
  // original terminal reason unchanged and never panicking (AC9). A
  // successful own-backlog dispatch is flagged `ownBacklogDispatch` so the
  // worker loop steps down leadership exactly once (AC4); a normal in-view
  // dispatch never reaches this block.
  //
  // WL-0MVFE1DD8000D8T2: the filter chain lives in `dispatchFromOwnHead` so
  // the audit-batch continuation above applies it byte-for-byte identically
  // (no duplicated gates, no second ranking). WL-0MW4ZOSD6004SAVD moved it to
  // `downtime-worker.head-scan.ts` so the registered-root sweep reuses it too.
  // The per-root gate closures below stay here (they own the per-tick caches).
  const headScanBase: HeadScanBase = {
    cpuSaturated,
    auditSlotBudget,
    panesEligible,
    pinnedAuditItemId,
    markerStaleWindowMs,
    maxAttempts,
    cooldownMs,
    cooldownEntriesForRoot,
    inFlightForRoot,
    reviewGateForRoot,
    holds: ownHeadHolds,
    flaggedForBudget,
  };
  const scanOptions = {
    model: opts.model,
    cwd: opts.cwd,
    localPreference: opts.localPreference,
    localPreferenceMode: opts.localPreferenceMode,
  };
  // Fail-open (AC9): a thrown own-root lookup must leave the original
  // terminal reason unchanged and never panic.
  const ownWindow = await readOwnHeadWindow(deps, opts.cwd, opts.browseItemCount);
  if (ownWindow !== null) {
    batchRuntime.setDepth(computeAuditEligibleDepth([...ownWindow.head, ...ownWindow.tail], now));
    // ── Audit-batch continuation (parent WL-0MVEDM8OT007WDRS AC4) ──
    // While a batch is armed the leader continues the audit drain from its
    // OWN head — the same bounded window EXTENSION and the same sequential
    // filter chain as the fallback below — instead of waiting for the offer
    // list to be re-populated. AUDIT-kind only, distinct targets (marker
    // exclusion + the batch-local exclusion set), exactly one dispatch per
    // invocation, and any non-`dispatched` outcome ENDS the batch (AC3): a
    // continuation never hops to another target. Armed only when the worker
    // passed a live budget (`auditBatchRemaining > 0`) and batching is on
    // (`cap > 1`); otherwise the unchanged fallback runs.
    if (batchRemainingBefore > 0 && batchCap > 1) {
      const continuation = await dispatchFromOwnHead(
        deps,
        scanOptions,
        {
          ...headScanBase,
          root: opts.cwd,
          window: ownWindow,
          frozen,
          kinds: ['audit'],
          excludeIds: new Set(opts.auditBatchDispatchedIds ?? []),
          selectionPath: 'own-backlog',
          selectionReason: 'own-backlog-audit-batch-continuation',
          skipOnLostClaim: false,
          includeHead: false,
        },
        now,
      );
      if (continuation !== null) return { ...continuation, auditBatchContinuation: true };
    }
  }

  // ── Registered-root sweep (parent WL-0MVR8GDJ3008WY3Y O1, AC1–AC6) ──
  // ONLY when the offer list yielded nothing dispatchable. Sweeps the resolved
  // `downtimeWorklogRoots` registry in round-robin order through the SAME
  // canonical ranking (`readOwnHeadWindow` → `getHerdrListHead`) and the FULL
  // sequential filter chain, so a root with dispatchable work but no running
  // herdr instance becomes reachable without bypassing any gate. Served BEFORE
  // the leader's own out-of-view backlog so a busy leader root cannot starve
  // the registry (AC4). Absent/empty registry ⇒ no-op (AC6); unreadable roots
  // are skipped without a strike (AC5). A dispatched sweep never sets
  // `ownBacklogDispatch` — the leader must not hand off leadership for it.
  const sweptOutcome = await dispatchFromRegisteredRoots(
    deps,
    {
      ...scanOptions,
      coordinationDir: opts.coordinationDir,
      ...(opts.registeredRoots !== undefined ? { registeredRoots: opts.registeredRoots } : {}),
      ...(opts.browseItemCount !== undefined ? { browseItemCount: opts.browseItemCount } : {}),
      frozen,
    },
    headScanBase,
    now,
  );
  if (sweptOutcome !== null) return sweptOutcome;

  if (ownWindow !== null) {
    const ownOutcome = await dispatchFromOwnHead(
      deps,
      scanOptions,
      {
        ...headScanBase,
        root: opts.cwd,
        window: ownWindow,
        frozen,
        kinds: null,
        excludeIds: new Set<string>(),
        selectionPath: 'own-backlog',
        selectionReason: 'own-backlog-fallback',
        skipOnLostClaim: true,
        includeHead: false,
      },
      now,
    );
    if (ownOutcome !== null) {
      if (ownOutcome.dispatched) return { ...ownOutcome, ownBacklogDispatch: true };
      // Any other terminal outcome (wl-error / spawn-failed /
      // anchor-unavailable / marker-write-failed) is returned unchanged so
      // the caller's strike/skip semantics are preserved.
      return ownOutcome;
    }
  }

  // No offer survived the dispatch-time filters (or a freeze skip with no
  // plan/intake offers). The caller decides cooldown vs. resume via the
  // same reason semantics as the legacy dispatcher — in the worker tick,
  // a coordination-mode no-candidate is probed against the worklog
  // (WL-0MTEZ4XZJ006Y9U7): an empty OFFER FILE is never mistaken for an
  // empty BACKLOG. A deep-queue hold is reported as the neutral
  // 'review-queue-hold' (never 'no-candidate' — the cooldown must not fire
  // while audits are draining the queue; the gate may lift at any moment).
  // A hold reported by the own-head scan (fallback, registered-root sweep or
  // batch continuation) is folded in here so a filtered own-head backlog keeps
  // its neutral reason.
  //
  // TERMINAL-REASON PRECEDENCE (module contract; WL-0MWBT76WY00298AY AC5,
  // extended by WL-0MWDDHVF2004PTYX AC2): `code-freeze` → CPU →
  // review-queue → non-terminal cooldown → attempt budget → in-flight →
  // leaf-audit pin → AUDIT budget → host budget → `no-candidate`. The full
  // ordering — and why the audit rung sits above the host rung — lives in
  // `resolveTerminalOutcome` (`downtime-worker.terminal-reason.ts`), a pure
  // sibling; this call site only hands it the holds the tick recorded. The
  // offer path's `hostBudgetHold` / `auditBudgetHold` are reported first when
  // both a path hold and an own-head hold recorded one for the same rung.
  const terminal = resolveTerminalOutcome({
    frozen,
    cpuHold,
    cpuEvidence,
    ownHeadHolds,
    reviewHold,
    cooldownHold,
    budgetHold,
    inFlightHold,
    pinHeld,
    pinnedAuditItemId,
    auditBudgetHold,
    hostBudgetHold,
  });
  return withOfferRejections(terminal, offerRejections);
}
