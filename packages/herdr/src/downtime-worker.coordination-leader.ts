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
import { getEntry, removeEntry, upsertEntry, type CoordinationEntry } from './coordination.js';
import { appendCoordinationLogEntry, type DowntimeLogEntry } from './downtime-log.js';
import { selectLeastRecentlyServed } from './downtime-round-robin-by-root.js';
import { clampDowntimeAuditBatchMax } from './downtime-worker.clamps.js';
import { computeMostImportantItem, toCoordinationCandidate, type CoordinationDeps } from './downtime-worker.coordination.js';
import {
  DEFAULT_DOWNTIME_AUDIT_BATCH_MAX,
  DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS,
  DEFAULT_DOWNTIME_MAX_ATTEMPTS,
  DEFAULT_DOWNTIME_NON_TERMINAL_COOLDOWN_MS,
  DEFAULT_DOWNTIME_STALL_THRESHOLD_MS,
  DOWNTIME_AUDIT_MIN_FREE_SLOTS,
  DOWNTIME_PANE_MIN_FREE_SLOTS,
} from './downtime-worker.constants.js';
import {
  dispatchClaimedTier,
  dispatchScheduledPrompt,
} from './downtime-worker.dispatch-claims.js';
import type { DowntimeDispatchOutcome } from './downtime-worker.dispatch-contract.js';
import {
  CPU_SATURATED_REASON,
  hostCpuGateEvidence,
  resolveCpuGate,
} from './downtime-worker.dispatch-cpu-gate.js';
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
import {
  dispatchedItemMarkers as _dispatchedMarkers,
  isNonTerminalCooldownActive as _isNonTerminalCooldownActive,
  markerStillExcludes as _markerStillExcludes,
  readDowntimeLogEntries as _readDowntimeEntries,
  type DispatchMarker,
} from './downtime-log.js';
import { resolveInFlightPanes } from './downtime-worker.pane.js';
import {
  STALLED_RESUME_REASON,
  resumeStalledWorkIfAble,
} from './downtime-worker.stalled-resume.js';
import type {
  DowntimeHerdrItem,
  DowntimeHerdrListResult,
  DowntimeItemResult,
  DowntimeSkillKind,
  DowntimeStage,
  InFlightPanes,
} from './downtime-worker.types.js';
import type { LocalPreference } from './local-preference.js';

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
 * coordination file holds ONE entry per instance — each entry offers that
 * instance's own worklog Herdr list HEAD, computed at the owner's
 * check-in (`computeMostImportantItem`, canonical ranking via
 * fetcher → smart-selection → grouping). The leader does NOT re-rank the
 * offers (no tier priority, no round-robin cursor — those second
 * orderings are retired by WL-0MTK1ILM2009QYB2 AC1–2): entries dispatch
 * in file order, and every safety gate is a sequential FILTER at
 * dispatch time on each offer (WL-0MTMPIQBE001J41P — no wall-clock
 * prune):
 *  - `fetchItem` re-fetch: the offer is validated against the item's
 *    CURRENT state (a stale offer — item closed/in_progress/review-gated
 *    or otherwise non-dispatchable — is dropped via `removeEntry`, no
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
 * The first offer that passes every filter dispatches via the existing
 * `dispatchClaimedTier` pipeline (CAS claim → marker write → spawn); its
 * entry is removed so the owner re-offers its next Herdr head at the next
 * check-in (AC3). A claimed-but-failed spawn also consumes the entry
 * (the marker + in_progress claim prevent a double dispatch).
 *
 * Fail-closed at every boundary: a wl failure fetching an entry resolves
 * `wl-error` only when EVERY entry failed (a fully broken lookup — a
 * strike); a per-entry failure skips that entry (fail-open per instance,
 * parent risk mitigation — one broken worklog must not starve the rest).
 */
export async function dispatchFromCoordination(
  deps: CoordinationLeaderDeps,
  entries: CoordinationEntry[],
  opts: { model: string; cwd: string; coordinationDir: string; localPreference?: LocalPreference; freeSlots?: number; leaseTtlMs?: number; browseItemCount?: number; nonTerminalCooldownMs?: number; maxAttempts?: number; markerStaleWindowMs?: number; stallScanEnabled?: boolean; stallScanThresholdMs?: number;
    /**
     * Host-CPU gate threshold (WL-0MVK0UO3Q002TXW6 AC2/AC5): live
     * `downtimeCpuGatePercent` re-read every tick. At or above it new
     * audit/implement offers are KEPT but skipped this cycle, the own-backlog
     * fallback / audit-batch continuation skip those kinds, and stalled panes
     * are not resumed. `0` disables. Optional — absent falls back to the
     * default (75).
     */
    cpuGatePercent?: number;
    /** Depth-aware audit-batch cap (parent WL-0MVEDM8OT007WDRS AC1); optional — absent leaves batching off. */ auditBatchMax?: number; /** Depth-aware audit-batch continuation budget (parent WL-0MVEDM8OT007WDRS AC1); consumed by the coordination continuation item (WL-0MVFE1DD8000D8T2). */ auditBatchRemaining?: number; /** Batch-local exclusion set: item ids already dispatched in the current audit batch (WL-0MVFE1DD8000D8T2 AC3/AC4). Never re-selected within one batch. */ auditBatchDispatchedIds?: readonly string[] },
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
 * Batch runtime shared between the coordination dispatcher and its finalizer
 * (WL-0MVFE1DD8000D8T2 AC4): memoises the leader's own audit-eligible depth so
 * one invocation reads the own Herdr head at most once, whether the read came
 * from the continuation scan or from the outcome finalizer.
 */
interface CoordinationBatchRuntime {
  /** Memoised audit-eligible depth over the leader's own head + window extension. */
  readDepth(): Promise<number>;
  /** Record a depth already computed from a window this invocation read. */
  setDepth(depth: number): void;
}

function createCoordinationBatchRuntime(
  deps: CoordinationLeaderDeps,
  opts: { cwd: string; browseItemCount?: number },
  now: number,
): CoordinationBatchRuntime {
  let depth: number | null = null;
  let pending: Promise<number> | null = null;
  return {
    setDepth(value: number): void {
      depth = value;
    },
    async readDepth(): Promise<number> {
      if (depth !== null) return depth;
      pending ??= (async () => {
        const window = await readOwnHeadWindow(deps, opts.cwd, opts.browseItemCount);
        return window === null
          ? 0
          : computeAuditEligibleDepth([...window.head, ...window.tail], now);
      })();
      depth = await pending;
      return depth;
    },
  };
}

/**
 * The leader's own dispatch window (WL-0MVFE1DD8000D8T2 AC4): the canonical
 * ranking head windowed to the live sprint view, plus the bounded window
 * EXTENSION (`fetchExtendedHerdrItems`, never a second ranking). Fail-open:
 * a `{ok:false}`/thrown lookup resolves `null` — the caller then falls back to
 * its unchanged behaviour or to a depth of 0 (no batch armed).
 */
async function readOwnHeadWindow(
  deps: CoordinationLeaderDeps,
  cwd: string,
  browseItemCount?: number,
): Promise<{ head: DowntimeHerdrItem[]; tail: DowntimeHerdrItem[] } | null> {
  const sprintWindow = resolveSprintViewWindow(browseItemCount);
  let ownHead: DowntimeHerdrListResult | null = null;
  try {
    ownHead = await deps.getHerdrListHead(cwd, sprintWindow);
  } catch {
    ownHead = null;
  }
  if (ownHead === null || !ownHead.ok) return null;
  const tail = await fetchExtendedHerdrItems(deps, cwd, ownHead.items, {
    includeNonCritical: true,
  });
  return { head: ownHead.items, tail };
}

/**
 * Own-head candidate scan shared by the leader's own-backlog fallback
 * (parent WL-0MUU4XFU90008E24) and the audit-batch continuation (parent
 * WL-0MVEDM8OT007WDRS AC4).
 *
 * Factored out so the continuation applies the EXACT same sequential filter
 * chain as the fallback — classify → dispatched-marker exclusion (id-guard) →
 * attempt budget → non-terminal cooldown → code-freeze → audit slot minimum →
 * critical in-flight guard → review-queue hold — with no duplicated gate
 * logic. The scan never ranks: `window.head` + `window.tail` is the canonical
 * order.
 *
 * Returns `null` when no candidate was dispatched or attempted (the caller
 * keeps its original terminal reason), otherwise the dispatch outcome with
 * `ownBacklogDispatch` deliberately LEFT UNSET — the caller decides the
 * leadership hand-off semantics (the fallback hands off immediately, the
 * batch continuation defers it to batch end).
 */
async function dispatchFromOwnHead(
  deps: CoordinationLeaderDeps,
  opts: { model: string; cwd: string; localPreference?: LocalPreference },
  ctx: {
    window: { head: DowntimeHerdrItem[]; tail: DowntimeHerdrItem[] };
    frozen: boolean;
    /**
     * Host-CPU gate state (WL-0MVK0UO3Q002TXW6 AC2): while saturated this scan
     * refuses audit/implement kinds in the same place as the code freeze, so
     * the own-backlog fallback and the audit-batch continuation are gated too.
     */
    cpuSaturated: boolean;
    auditEligible: boolean;
    markerStaleWindowMs: number;
    maxAttempts: number;
    cooldownMs: number;
    cooldownEntriesForRoot(root: string): Promise<DowntimeLogEntry[]>;
    inFlightForRoot(root: string): Promise<InFlightPanes>;
    reviewGateForRoot(root: string): Promise<ReviewQueueGateResult | null>;
    /** Kinds this scan may dispatch; `null` = every classified kind. */
    kinds: readonly DowntimeSkillKind[] | null;
    /** Batch-local exclusion set (never re-selected within one batch). */
    excludeIds: ReadonlySet<string>;
    /** Selection reason recorded on the dispatch pipeline. */
    selectionReason: string;
    /** `claim-failed`/`claim-rolled-back` → try the next item (fallback) or end the scan (continuation). */
    skipOnLostClaim: boolean;
    /** Holds reported back to the caller's terminal-reason composition. */
    holds: {
      budget: boolean;
      cooldown: boolean;
      inFlight: boolean;
      review: boolean;
      cpu: boolean;
    };
    /** Producer-review flag writes already performed this cycle (deduped). */
    flaggedForBudget: Set<string>;
  },
  now: number,
): Promise<DowntimeDispatchOutcome | null> {
  const { head, tail } = ctx.window;
  const ownTail = tail.filter(item => !ctx.excludeIds.has(item.id));
  if (ownTail.length === 0) return null;
  const ownEntries = await ctx.cooldownEntriesForRoot(opts.cwd);
  const ownMarkerMaps: Record<DowntimeSkillKind, Map<string, DispatchMarker>> = {
    audit: _dispatchedMarkers(ownEntries, 'audit'),
    implement: _dispatchedMarkers(ownEntries, 'implement'),
    plan: _dispatchedMarkers(ownEntries, 'plan'),
    intake: _dispatchedMarkers(ownEntries, 'intake'),
    'risk-effort': _dispatchedMarkers(ownEntries, 'risk-effort'),
  };
  const ownInFlight = await ctx.inFlightForRoot(opts.cwd);
  void head; // the extension alone is the supplement; `head` is the ranked prefix
  for (const item of ownTail) {
    // Sequential filters — the same contract as the offer path.
    const kind = classifyItemForDispatch(item, now);
    if (kind === null) continue;
    if (ctx.kinds !== null && !ctx.kinds.includes(kind)) continue;
    const marker = ownMarkerMaps[kind]?.get(item.id);
    if (
      marker !== undefined &&
      _markerStillExcludes(
        marker,
        item.stage,
        now,
        ctx.markerStaleWindowMs,
        kind === 'audit' || kind === 'implement' ? 'id-guard' : 'stage-guard',
      )
    ) {
      continue;
    }
    if (isAttemptBudgetExhausted(ownEntries, item.id, kind, item.stage, ctx.maxAttempts)) {
      if (!ctx.flaggedForBudget.has(item.id)) {
        ctx.flaggedForBudget.add(item.id);
        await flagBudgetExhausted(deps, item.id, opts.cwd);
      }
      ctx.holds.budget = true;
      continue;
    }
    if (_isNonTerminalCooldownActive(ownEntries, item.id, kind, item.stage, ctx.cooldownMs, now)) {
      ctx.holds.cooldown = true;
      continue;
    }
    if (ctx.frozen && (kind === 'audit' || kind === 'implement' || kind === 'risk-effort')) continue;
    // Host-CPU gate (WL-0MVK0UO3Q002TXW6 AC2): refuse NEW audit/implement work
    // while the host is saturated; plan/intake/risk-effort still dispatch.
    // After the freeze so a dual-gated tick reports `code-freeze`.
    if (ctx.cpuSaturated && (kind === 'audit' || kind === 'implement')) {
      ctx.holds.cpu = true;
      continue;
    }
    if (kind === 'audit' && !ctx.auditEligible) continue;
    if (item.priority === 'critical') {
      const guard = evaluateCriticalFirstGuard(
        item.id,
        ownInFlight,
        marker?.dispatchedAt,
        now,
        ctx.markerStaleWindowMs,
      );
      if (!guard.escalate) {
        ctx.holds.inFlight = true;
        continue;
      }
    }
    if (kind === 'implement') {
      const gate = await ctx.reviewGateForRoot(opts.cwd);
      if (isImplementHeldByReviewGate(kind, item, gate)) {
        ctx.holds.review = true;
        continue;
      }
    }
    const outcome = await dispatchClaimedTier(
      deps,
      kind,
      {
        id: item.id,
        title: item.title,
        stage: kind === 'audit' ? 'audit' : ((item.stage as DowntimeStage) ?? 'idea'),
        status: item.status,
        priority: item.priority,
        sortIndex: item.sortIndex,
      },
      {
        model: opts.model,
        cwd: opts.cwd,
        localPreference: opts.localPreference,
        selectionPath: 'own-backlog',
        selectionReason: ctx.selectionReason,
      },
    );
    if (outcome.dispatched) return outcome;
    // A lost CAS race / marker-recovery rollback applies to one candidate.
    if (
      ctx.skipOnLostClaim &&
      (outcome.reason === 'claim-failed' || outcome.reason === 'claim-rolled-back')
    ) {
      continue;
    }
    // Any other terminal outcome (or, for a continuation, ANY non-dispatched
    // outcome — AC3: a batch never hops to another target) is returned
    // unchanged so the caller's strike/skip semantics are preserved.
    return outcome;
  }
  return null;
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

  // No wall-clock prune (WL-0MTMPIQBE001J41P) — entries persist until
  // dispatch-time eligibility check (fetchItem+classify) finds them
  // non-dispatchable. Stale offers are dropped at dispatch, never by age.

  // Per-tier free-slot minimums (parent WL-0MT32F90V008UAD2 AC3): the
  // audit tier needs ≥ 2 slots (parent + Phase 2 child at
  // AUDIT_PHASE2_PARALLELISM=1); every single-pane tier needs ≥ 1. When
  // freeSlots is absent (direct API callers), the minimums do not gate
  // (fail-open for direct API use — the worker always passes the count).
  const freeSlots = opts.freeSlots;
  const auditEligible = freeSlots === undefined || freeSlots >= DOWNTIME_AUDIT_MIN_FREE_SLOTS;
  const panesEligible = freeSlots === undefined || freeSlots >= DOWNTIME_PANE_MIN_FREE_SLOTS;
  if (!panesEligible) {
    // No slot can host a pane — nothing to dispatch (mirrors the legacy
    // tier chain's 0-free-slots defensive no-candidate).
    return { dispatched: false, reason: 'no-candidate' };
  }

  // ── Stalled-work scan (WL-0MUYMBSA90092QV2 AC1/AC3/AC4) ──
  // Idle-gated (free slot present) and immediately before new-item
  // selection: prefer resuming a stalled pane over opening a new one. A
  // successful resume short-circuits the cycle with the neutral
  // 'stalled-resume' reason; any failure (unwired deps, unreadable pane
  // list, resume failure) falls through to the unchanged path below.
  {
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
  if (!frozen) {
    const duePrompt = await deps.getDueScheduledPrompt(opts.cwd);
    if (duePrompt !== null) {
      return await dispatchScheduledPrompt(deps, duePrompt, {
        model: opts.model,
        cwd: opts.cwd,
        ...(opts.localPreference !== undefined ? { localPreference: opts.localPreference } : {}),
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
    .filter(e => e.instanceId.length > 0 && e.workItemId.length > 0)
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
  const ownHeadHolds = {
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
    if (entry.instanceId.length === 0 || entry.workItemId.length === 0) continue;
    fetchAttempts += 1;
    const worklogRoot = entry.worklogRoot ?? entry.directory;
    const result = await deps.fetchItem(entry.workItemId, worklogRoot);
    if (!result.ok) {
      // Per-entry wl/parse failure — tolerated (fail-open per instance:
      // one broken worklog must not starve the rest).
      fetchFailures += 1;
      lastFetchError = (result as { error?: string }).error ?? 'fetchItem failed';
      lastEntryWorkItemId = entry.workItemId; // WL-0MTJPYM53003ORCV
      continue;
    }
    // Sequential FILTERS on the offer (never a ranking).
    // Producer-review gate (parent WL-0MTIAL65N004T22F AC3) + dispatch-
    // time eligibility (WL-0MTMPIQBE001J41P): a now-gated or otherwise
    // non-dispatchable offer is stale — remove it, no pane, no marker.
    const kind = classifyItemForDispatch(result.info, now);
    if (kind === null) {
      removeEntry(opts.coordinationDir, entry.instanceId);
      continue;
    }
    // Per-item/per-kind attempt budget (WL-0MUKYEXMK0033MFK AC1/AC2/AC3):
    // flag the item for producer review and keep the entry (it is still a
    // valid offer once a human clears the flag) but skip it this cycle.
    // Neutral — never a strike, never 'no-candidate' (AC5).
    if (isAttemptBudgetExhausted(await cooldownEntriesForRoot(worklogRoot), result.info.id, kind, result.info.stage, maxAttempts)) {
      if (!flaggedForBudget.has(result.info.id)) {
        flaggedForBudget.add(result.info.id);
        await flagBudgetExhausted(deps, result.info.id, worklogRoot);
      }
      budgetHold = true;
      continue;
    }
    // Non-terminal pane-close cooldown (WL-0MUKYERLZ006ELL5): neutral
    // sequential filter — keep the entry (it is still a valid offer) but
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
      continue;
    }
    // Code-freeze split-by-skill: audit/implement/risk-effort offers pause
    // during a freeze/ambiguous marker (plan/intake still dispatch). A frozen
    // offer is stale for the dispatch window — drop it so the owner re-offers
    // its next head at the next check-in.
    if (frozen && (kind === 'audit' || kind === 'implement' || kind === 'risk-effort')) {
      removeEntry(opts.coordinationDir, entry.instanceId);
      continue;
    }
    // Host-CPU gate (WL-0MVK0UO3Q002TXW6 AC2/AC4): at or above the threshold
    // audit/implement offers are refused. The entry is KEPT — it is still a
    // valid offer and the next idle tick re-checks the live CPU (removing it
    // would also force an owner re-offer cycle for work that is only
    // temporarily held). Evaluated AFTER the freeze so a dual-gated tick
    // reports `code-freeze` (AC4 precedence).
    if (cpuSaturated && (kind === 'audit' || kind === 'implement')) {
      cpuHold = true;
      continue;
    }
    // Audit-tier slot minimum: an audit pane needs a second slot for its
    // Phase 2 child (WL-0MSORQ1RG005DGUS / WL-0MT32F90V008UAD2 AC3) — skip
    // the offer this cycle when too few slots are free, but KEEP it (it is
    // still a valid offer; the next cycle may have the slot).
    if (kind === 'audit' && !auditEligible) continue;
    // Review-queue depth gate (WL-0MT2UQWOR007CYY9, live-path rewire by
    // WL-0MTTSWC1X005P4VD): hold a NON-CRITICAL implement offer while ITS
    // OWN root's review queue is deep. Audits (the queue drain), plan,
    // intake and critical implements flow unconditionally. The entry is
    // KEPT (not removed) — the queue may drain below the threshold at any
    // moment (an audit completes / producer reviews) and the next cycle
    // then dispatches it; the owner's check-in re-offers its next head
    // once the gate allows.
    if (kind === 'implement') {
      const gate = await reviewGateForRoot(worklogRoot);
      if (isImplementHeldByReviewGate(kind, result.info, gate)) {
        reviewHold = true;
        continue;
      }
    }
    // Leader-side in-flight re-check (AC2.10): an offer computed BEFORE the
    // pane appeared must not dispatch now. Only a PROVEN live working pane
    // blocks (an unavailable query must not stall all coordination dispatch);
    // the owner's offer computation already applied the marker-TTL fallback.
    // The entry is KEPT — the offer is still valid once the pane finishes.
    if (result.info.priority === 'critical') {
      const inFlight = await inFlightForRoot(worklogRoot);
      if (inFlight.available && inFlight.itemIds.has(result.info.id)) {
        inFlightHold = true;
        continue;
      }
    }
    // Dispatch attempt (CAS claim → marker → spawn).
    const outcome = await dispatchClaimedTier(
      deps,
      kind,
      toCoordinationCandidate(result.info),
      {
        model: opts.model,
        cwd: worklogRoot,
        localPreference: opts.localPreference,
        selectionPath: 'coordination-offer',
        selectionReason: 'leader-offer',
      },
    );
    if (outcome.dispatched) {
      // Dispatched — remove the entry so the owner re-queues its next
      // Herdr head at the next check-in (AC3 re-queue).
      removeEntry(opts.coordinationDir, entry.instanceId);
      return outcome;
    }
    if (outcome.reservation?.admit === false) {
      // The proxy REFUSED the local-capacity ticket (parent AC3/AC4, slice
      // C3): a capacity deferral, not an offer problem. Keep the entry (the
      // offer is still valid) and return the refusal evidence WITHOUT falling
      // through to the own-backlog fallback — that fallback would retry other
      // items and eventually report a generic terminal reason, losing the
      // `admit: false` / `retryAfterS` / proxy-reason evidence the decision
      // log needs to distinguish a lost reservation race from a paced stop
      // (coordination-path parity, C3-AC4).
      return outcome;
    }
    if (outcome.reason === 'claim-failed') {
      // Another pane won the CAS race — neutral; try the next offer.
      continue;
    }
    if (outcome.reason === 'claim-rolled-back') {
      // Marker write failed and claim was rolled back (WL-0MT32F908002YFFA);
      // the item is back in the backlog — try the next offer.
      continue;
    }
    if (outcome.reason === 'wl-error') {
      // A wl failure is a strike — stop the cycle (three-strike rule
      // decides when to pause). Carry the entry's workItemId for logging.
      return { ...outcome, workItemId: entry.workItemId };
    }
    if (outcome.reason === 'anchor-unavailable') {
      // Dispatcher anchor provisioning failed (C0 WL-0MTR01EU7005SYZG): the
      // anchor is MACHINE-WIDE, so no other offer can spawn either — stop the
      // cycle now (neutral, no strike, no cooldown; the next idle tick
      // retries the provisioning). Keep the entry: the offer is still valid.
      return outcome;
    }
    if (outcome.reason === 'spawn-failed' || outcome.reason === 'marker-write-failed') {
      // The item is claimed (+ marked) but the pane never appeared:
      // remove the entry so the owner re-queues; the standing marker and
      // the in_progress claim prevent double-dispatch.
      removeEntry(opts.coordinationDir, entry.instanceId);
      return outcome;
    }
  }

  // A wl lookup that failed for EVERY entry is a persistent CLI/parse
  // failure — a strike (never a silent no-candidate). Per-instance
  // failures are tolerated (fail-open). Carry the last entry's workItemId
  // for per-strike logging (WL-0MTJPYM53003ORCV).
  if (fetchAttempts > 0 && fetchFailures === fetchAttempts) {
    return {
      dispatched: false,
      reason: 'wl-error',
      error: lastFetchError ?? 'all fetchItem lookups failed',
      workItemId: lastEntryWorkItemId,
    };
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
  // (no duplicated gates, no second ranking).
  {
    // Fail-open (AC9): a thrown own-root lookup must leave the original
    // terminal reason unchanged and never panic.
    const ownWindow = await readOwnHeadWindow(deps, opts.cwd, opts.browseItemCount);
    if (ownWindow !== null) {
      batchRuntime.setDepth(computeAuditEligibleDepth([...ownWindow.head, ...ownWindow.tail], now));
      const sharedScan = {
        window: ownWindow,
        frozen,
        cpuSaturated,
        auditEligible,
        markerStaleWindowMs,
        maxAttempts,
        cooldownMs,
        cooldownEntriesForRoot,
        inFlightForRoot,
        reviewGateForRoot,
        holds: ownHeadHolds,
        flaggedForBudget,
      };
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
          { model: opts.model, cwd: opts.cwd, localPreference: opts.localPreference },
          {
            ...sharedScan,
            kinds: ['audit'],
            excludeIds: new Set(opts.auditBatchDispatchedIds ?? []),
            selectionReason: 'own-backlog-audit-batch-continuation',
            skipOnLostClaim: false,
          },
          now,
        );
        if (continuation !== null) return { ...continuation, auditBatchContinuation: true };
      }
      const ownOutcome = await dispatchFromOwnHead(
        deps,
        { model: opts.model, cwd: opts.cwd, localPreference: opts.localPreference },
        {
          ...sharedScan,
          kinds: null,
          excludeIds: new Set<string>(),
          selectionReason: 'own-backlog-fallback',
          skipOnLostClaim: true,
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
  }

  // No offer survived the dispatch-time filters (or a freeze skip with no
  // plan/intake offers). The caller decides cooldown vs. resume via the
  // same reason semantics as the legacy dispatcher — in the worker tick,
  // a coordination-mode no-candidate is probed against the worklog
  // (WL-0MTEZ4XZJ006Y9U7): an empty OFFER FILE is never mistaken for an
  // empty BACKLOG. A deep-queue hold is reported as the neutral
  // 'review-queue-hold' (never 'no-candidate' — the cooldown must not fire
  // while audits are draining the queue; the gate may lift at any moment).
  // A hold reported by the own-head scan (fallback or batch continuation) is
  // folded in here so a filtered own-head backlog keeps its neutral reason.
  return frozen
    ? { dispatched: false, reason: 'code-freeze' }
    : cpuHold || ownHeadHolds.cpu
      ? { ...cpuEvidence, dispatched: false, reason: CPU_SATURATED_REASON }
      : reviewHold || ownHeadHolds.review
        ? { dispatched: false, reason: REVIEW_QUEUE_HOLD_REASON }
        : cooldownHold || ownHeadHolds.cooldown
          ? { dispatched: false, reason: 'non-terminal-cooldown' }
          : budgetHold || ownHeadHolds.budget
            ? { dispatched: false, reason: 'attempt-budget-exhausted' }
            : inFlightHold || ownHeadHolds.inFlight
            ? { dispatched: false, reason: 'in-flight-pane' }
            : { dispatched: false, reason: 'no-candidate' };
}

/**
 * One coordination check-in (WL-0MTMPSCL8000O45H — default every 5 min,
 * parent AC3): recompute this instance's most-important item and upsert
 * its entry in the shared coordination file. When the instance has NOTHING
 * dispatchable (genuine empty backlog, no CLI errors) the own entry is
 * removed — the leader must not float a dead offer; the owner re-offers
 * when work appears (immediately on next tick after dispatch removes it —
 * WL-0MTMPSCL8000O45H AC2). On a CLI-error computation the existing entry
 * is kept (fail-open) — a transient wl failure must never drop a valid
 * offer. Returns the stored item id (or null when nothing was offered).
 */
export async function runCoordinationCheckIn(
  deps: CoordinationLeaderDeps,
  coordinator: {
    cwd: string;
    coordinationDir: string;
    instanceId: string;
    /** browseItemCount threshold for the review-queue depth gate (defaults to DEFAULT_BROWSE_ITEM_COUNT). */
    browseItemCount?: number;
    /** Dispatched success-marker staleness window (WL-0MU6UL0RJ008IHGT); defaults to DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS. */
    markerStaleWindowMs?: number;
    /** Non-terminal pane-close cooldown (WL-0MUKYERLZ006ELL5); defaults to DEFAULT_DOWNTIME_NON_TERMINAL_COOLDOWN_MS. */
    nonTerminalCooldownMs?: number;
    /** Per-item/per-kind dispatch-attempt cap (WL-0MUKYEXMK0033MFK); defaults to DEFAULT_DOWNTIME_MAX_ATTEMPTS. */
    maxAttempts?: number;
  },
  now: number = Date.now(),
): Promise<{ offered: string | null; updated: boolean }> {
  const current = getEntry(coordinator.coordinationDir, coordinator.instanceId);
  // NOTE (WL-0MUYMBSA90092QV2 AC3): the check-in is NOT idle-gated (it runs
  // before the proxy poll, for leader and non-leader alike), so the
  // stalled-work scan is deliberately DISABLED here — resuming a pane is a
  // dispatch-like side effect that must only run when the dispatcher is
  // idle-gated and would otherwise dispatch. The idle-gated paths
  // (`dispatchDowntimeWork` / `dispatchFromCoordination` / the no-candidate
  // probe below) perform the scan+resume.
  const result = await computeMostImportantItem(deps, coordinator.cwd, now, coordinator.browseItemCount, coordinator.markerStaleWindowMs, coordinator.nonTerminalCooldownMs, coordinator.maxAttempts, false);
  if (!result.ok) {
    // wl/CLI errors — keep the existing entry (fail-open), retry next check-in.
    return { offered: current?.workItemId ?? null, updated: false };
  }
  if (!('candidate' in result)) {
    // Genuinely nothing dispatchable (`noCandidate`), the deep-queue hold
    // left nothing offerable (`reviewQueueHold`, WL-0MTTSWC1X005P4VD), or a
    // stalled pane was resumed in place (`stalledResume`,
    // WL-0MUYMBSA90092QV2) — either way the own entry is removed (no dead
    // offers; the owner re-offers once work becomes offerable). The caller
    // distinguishes the reasons via the probe path (reviewQueueHold and
    // stalledResume must never pause).
    const removed = removeEntry(coordinator.coordinationDir, coordinator.instanceId) !== null;
    // Audit trail (WL-0MSXHAE290067VAL): log the emptied check-in.
    void appendCoordinationLogEntry(coordinator.cwd, {
      kind: 'coordination',
      operation: 'checkin',
      instanceId: coordinator.instanceId,
      workItemId: null,
      at: new Date(now).toISOString(),
    });
    return { offered: null, updated: removed };
  }
  if (!('candidate' in result) || result.candidate === undefined) {
    // Defensive: a malformed result (stub/regression) keeps the entry.
    return { offered: current?.workItemId ?? null, updated: false };
  }
  const entry: CoordinationEntry = {
    instanceId: coordinator.instanceId,
    workItemId: result.candidate.id,
    directory: coordinator.cwd,
    assignedAt: current?.assignedAt ?? new Date(now).toISOString(),
    lastUpdated: new Date(now).toISOString(),
  };
  const updated = upsertEntry(coordinator.coordinationDir, entry);
  // Audit trail (WL-0MSXHAE290067VAL): log the offered item on every
  // successful check-in write.
  if (updated) {
    void appendCoordinationLogEntry(coordinator.cwd, {
      kind: 'coordination',
      operation: 'checkin',
      instanceId: coordinator.instanceId,
      workItemId: entry.workItemId,
      at: new Date(now).toISOString(),
    });
  }
  return { offered: entry.workItemId, updated };
}
