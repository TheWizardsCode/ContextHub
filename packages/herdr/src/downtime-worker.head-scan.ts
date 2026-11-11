/**
 * packages/herdr/src/downtime-worker.head-scan.ts — bounded head/extension
 * candidate scan and the registered-root sweep it powers.
 *
 * Single responsibility: apply the leader's FULL sequential filter chain to a
 * canonical-ranking window (`dispatchFromOwnHead`), and drive that same scan
 * across the resolved `downtimeWorklogRoots` registry in round-robin order
 * (`dispatchFromRegisteredRoots`, parent WL-0MVR8GDJ3008WY3Y option O1).
 *
 * Parent: WL-0MVF3F9A7000HKP7 (decompose the `downtime-worker.ts` god class).
 * `dispatchFromOwnHead` was moved here VERBATIM from
 * `downtime-worker.coordination-leader.ts` by WL-0MW4ZOSD6004SAVD (registered-
 * root sweep) for two reasons: the leader module sits on the 1,000-line split
 * ceiling, and the sweep must reuse the filter chain byte-for-byte instead of
 * duplicating it. Behaviour is unchanged for the own-backlog fallback and the
 * audit-batch continuation; the sweep is an additional caller.
 *
 * Layering: the dependency seam is declared STRUCTURALLY (the dispatch and
 * gate slices) rather than importing `CoordinationLeaderDeps` from the leader
 * — that would be a module cycle. The gate closures the leader owns
 * (`cooldownEntriesForRoot`, `inFlightForRoot`, `reviewGateForRoot`) are passed
 * in through the scan context, so each root is inspected against ITS OWN
 * worklog state.
 */

import { selectLeastRecentlyServed } from './downtime-round-robin-by-root.js';
import { readOwnHeadWindow } from './downtime-worker.coordination-batch.js';
import {
  isContinuableHoldOutcome,
  isHostBudgetHoldReason,
  type DowntimeDispatchDeps,
  type DowntimeDispatchOutcome,
} from './downtime-worker.dispatch-contract.js';
import { dispatchClaimedTier } from './downtime-worker.dispatch-claims.js';
import {
  auditItemEligible,
  auditPinAdmits,
  classifyItemForDispatch,
  evaluateCriticalFirstGuard,
  flagBudgetExhausted,
  isAttemptBudgetExhausted,
  isImplementHeldByReviewGate,
  type DowntimeGateDeps,
  type ReviewQueueGateResult,
} from './downtime-worker.gates.js';
import {
  dispatchedItemMarkers as _dispatchedMarkers,
  isNonTerminalCooldownActive as _isNonTerminalCooldownActive,
  markerStillExcludes as _markerStillExcludes,
  type DispatchMarker,
  type DowntimeLogEntry,
} from './downtime-log.js';
import type {
  DowntimeHerdrItem,
  DowntimeSkillKind,
  DowntimeStage,
  InFlightPanes,
} from './downtime-worker.types.js';
import type { LocalPreference, LocalPreferenceMode } from './local-preference.js';

/**
 * The deps slice these scans touch: the dispatch pipeline (claim → marker →
 * spawn) plus the gate helpers (audit eligibility, budget flag, window
 * extension). Both are structural subsets of `DowntimeWorkerDeps`, so the
 * leader passes its full deps object unchanged.
 */
export type HeadScanDeps = DowntimeDispatchDeps & DowntimeGateDeps;

/** Holds reported back to the caller's terminal-reason composition. */
export interface HeadScanHolds {
  budget: boolean;
  cooldown: boolean;
  inFlight: boolean;
  review: boolean;
  cpu: boolean;
  /**
   * Host-budget refusal recorded by this scan (WL-0MWBT76WY00298AY AC4).
   *
   * A sibling of `budget` (the per-item ATTEMPT budget), `cooldown`,
   * `inFlight`, `review` and `cpu` — never conflated with them. On a
   * continuable host-budget refusal the scan records the FIRST refusal's
   * reason token and `{live, max}` evidence here and keeps scanning, so the
   * caller can report the neutral refusal (never `no-candidate`) when nothing
   * else dispatches. Precedence in the caller's terminal chain is documented
   * at the composition site: this hold is LAST, after `code-freeze` → CPU →
   * review → cooldown → attempt-budget → in-flight → leaf-audit pin.
   */
  hostBudget?: { reason: string; budget?: { live: number; max: number } };
}

/**
 * Everything a head scan needs that is independent of the ROOT being scanned:
 * the gate budgets, the lock-step helpers and the leader-owned per-root state
 * closures. `dispatchFromRegisteredRoots` spreads this base and adds the
 * per-root parts (root, window, freeze state, selection path).
 */
export interface HeadScanBase {
  /**
   * Host-CPU gate state (WL-0MVK0UO3Q002TXW6 AC2): while saturated this scan
   * refuses audit/implement kinds in the same place as the code freeze, so
   * the own-backlog fallback and the audit-batch continuation are gated too.
   */
  cpuSaturated: boolean;
  /** Raw free-slot budget the per-item leaf-aware audit gate reads (C3). */
  auditSlotBudget: number | undefined;
  /** False when a relaxed leaf-audit pin reserves the single free slot. */
  panesEligible: boolean;
  /** Relaxed-tick pin (C4): only this audit item may consume the slot. */
  pinnedAuditItemId: string | undefined;
  markerStaleWindowMs: number;
  maxAttempts: number;
  cooldownMs: number;
  cooldownEntriesForRoot(root: string): Promise<DowntimeLogEntry[]>;
  inFlightForRoot(root: string): Promise<InFlightPanes>;
  reviewGateForRoot(root: string): Promise<ReviewQueueGateResult | null>;
  /** Holds reported back to the caller's terminal-reason composition. */
  holds: HeadScanHolds;
  /** Producer-review flag writes already performed this cycle (deduped). */
  flaggedForBudget: Set<string>;
}

/** A fully-resolved scan over exactly ONE root's canonical window. */
export interface HeadScanContext extends HeadScanBase {
  /** The worklog root whose state every gate and the claim target resolve against. */
  root: string;
  /** Canonical ranking: the sprint-view head plus its bounded extension. */
  window: { head: DowntimeHerdrItem[]; tail: DowntimeHerdrItem[] };
  /** This root's own code-freeze state (`frozen`/`ambiguous` ⇒ true). */
  frozen: boolean;
  /** Kinds this scan may dispatch; `null` = every classified kind. */
  kinds: readonly DowntimeSkillKind[] | null;
  /** Batch-local exclusion set (never re-selected within one batch). */
  excludeIds: ReadonlySet<string>;
  /** `selectionPath` recorded on the dispatch pipeline. */
  selectionPath: string;
  /** Selection reason recorded on the dispatch pipeline. */
  selectionReason: string;
  /** `claim-failed`/`claim-rolled-back` → try the next item (fallback) or end the scan (continuation). */
  skipOnLostClaim: boolean;
  /**
   * Scan the canonical HEAD as well as the bounded extension. The own-backlog
   * fallback scans only the extension (in-view items belong to the offer
   * path); a registered root has no owner offering its head, so its whole
   * canonical window is in scope.
   */
  includeHead: boolean;
}

/** Scan options that never change per root. */
export interface HeadScanOptions {
  model: string;
  cwd: string;
  localPreference?: LocalPreference;
  localPreferenceMode?: LocalPreferenceMode;
}

/** The subset of leader dispatch options the registered-root sweep needs. */
export interface RegisteredRootSweepOptions extends HeadScanOptions {
  /** Machine-wide coordination directory holding the round-robin cursor. */
  coordinationDir: string;
  /** Resolved `downtimeWorklogRoots` registry; absent/empty ⇒ no sweep (AC6). */
  registeredRoots?: readonly string[];
  /** The live sprint-view window (`browseItemCount`) bounding each head read. */
  browseItemCount?: number;
  /** The leader's OWN root freeze state (avoids a duplicate read for it). */
  frozen: boolean;
}

/** Canonical order with no exclusions — shared immutable empty set. */
const EMPTY_EXCLUDE: ReadonlySet<string> = new Set<string>();

/** `frozen`/`ambiguous` are both fail-closed for audit/implement work. */
function isFrozenStatus(status: 'frozen' | 'not-frozen' | 'ambiguous'): boolean {
  return status === 'frozen' || status === 'ambiguous';
}

/**
 * Normalise the registry: drop empty/whitespace entries and de-duplicate the
 * root list. Order is preserved (registry order is the tie break after the
 * round-robin cursor), so a configured list is never re-ranked.
 */
function normaliseRegisteredRoots(roots: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of roots ?? []) {
    const trimmed = root.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Own-head candidate scan shared by the leader's own-backlog fallback
 * (parent WL-0MUU4XFU90008E24), the audit-batch continuation (parent
 * WL-0MVEDM8OT007WDRS AC4) and the registered-root sweep
 * (WL-0MVR8GDJ3008WY3Y O1).
 *
 * Applies the EXACT same sequential filter chain in every case — classify →
 * dispatched-marker exclusion (id-guard) → attempt budget → non-terminal
 * cooldown → code-freeze → CPU gate → audit slot minimum → critical in-flight
 * guard → review-queue hold — with no duplicated gate logic. The scan never
 * ranks: `window.head` + `window.tail` is the canonical order.
 *
 * Every gate and the claim target resolve against `ctx.root` (never the
 * leader's own root), so a swept candidate lands in ITS OWN worklog database.
 *
 * Returns `null` when no candidate was dispatched or attempted (the caller
 * keeps its original terminal reason), otherwise the dispatch outcome with
 * `ownBacklogDispatch` deliberately LEFT UNSET — the caller decides the
 * leadership hand-off semantics (the fallback hands off immediately, the
 * batch continuation defers it to batch end, the registered-root sweep never
 * hands off).
 */
export async function dispatchFromOwnHead(
  deps: HeadScanDeps,
  opts: HeadScanOptions,
  ctx: HeadScanContext,
  now: number,
): Promise<DowntimeDispatchOutcome | null> {
  const { head, tail } = ctx.window;
  // The extension is the canonical supplement; the head is its ranked prefix.
  // Own-backlog/continuation scans start at the extension; the sweep scans the
  // whole window because no offer owner exists for a registered root.
  const ranked: DowntimeHerdrItem[] = ctx.includeHead ? [...head, ...tail] : tail;
  const candidates = ranked.filter(item => !ctx.excludeIds.has(item.id));
  if (candidates.length === 0) return null;
  const ownEntries = await ctx.cooldownEntriesForRoot(ctx.root);
  const ownMarkerMaps: Record<DowntimeSkillKind, Map<string, DispatchMarker>> = {
    audit: _dispatchedMarkers(ownEntries, 'audit'),
    implement: _dispatchedMarkers(ownEntries, 'implement'),
    plan: _dispatchedMarkers(ownEntries, 'plan'),
    intake: _dispatchedMarkers(ownEntries, 'intake'),
    'risk-effort': _dispatchedMarkers(ownEntries, 'risk-effort'),
  };
  const ownInFlight = await ctx.inFlightForRoot(ctx.root);
  for (const item of candidates) {
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
        await flagBudgetExhausted(deps, item.id, ctx.root);
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
    // Leaf-aware per-item audit minimum + relaxed-tick pin (C3/C4) — the same
    // helpers as the offer loop, so no caller can dispatch a candidate the
    // offer path would skip.
    if (ctx.pinnedAuditItemId !== undefined && kind !== 'audit') continue;
    if (kind !== 'audit' && !ctx.panesEligible) continue;
    if (kind === 'audit' && !auditPinAdmits(ctx.pinnedAuditItemId, item.id)) continue;
    if (
      kind === 'audit' &&
      !(await auditItemEligible(deps, item, ctx.auditSlotBudget, ctx.root))
    ) {
      continue;
    }
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
      const gate = await ctx.reviewGateForRoot(ctx.root);
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
        cwd: ctx.root,
        localPreference: opts.localPreference,
        localPreferenceMode: opts.localPreferenceMode,
        selectionPath: ctx.selectionPath,
        selectionReason: ctx.selectionReason,
      },
    );
    if (outcome.dispatched) return outcome;
    // A non-continuable outcome (wl-error, spawn-failed, marker-write-failed,
    // anchor-unavailable, …) is returned unchanged so the caller's strike/skip
    // semantics are preserved. Only the allow-listed continuable holds below
    // may step to the next candidate (AC1/AC7).
    if (!isContinuableHoldOutcome(outcome)) return outcome;
    if (isHostBudgetHoldReason(outcome.reason)) {
      // Machine-wide budget refusal (WL-0MWBT76WY00298AY AC2): NEUTRAL — no
      // strike, no cooldown, no attempt budget. Record the FIRST refusal (the
      // ledger is host-wide, so later budgeted candidates report the same
      // condition) and step on to the next candidate, which may be prep work
      // the budget never gates. The batch continuation (`skipOnLostClaim`
      // false) is the one exception: it records the hold and ENDS the batch
      // (AC6) — a batch never hops to another audit target.
      ctx.holds.hostBudget ??= {
        reason: outcome.reason as string,
        ...(outcome.budget !== undefined ? { budget: outcome.budget } : {}),
      };
      if (!ctx.skipOnLostClaim) return outcome;
      continue;
    }
    // A lost CAS race / marker-recovery rollback applies to one candidate.
    // Unchanged semantics (AC7): the fallback/sweep continue, while the batch
    // continuation ends on it exactly as before.
    if (ctx.skipOnLostClaim) continue;
    return outcome;
  }
  return null;
}

/**
 * Registered-root sweep (parent WL-0MVR8GDJ3008WY3Y AC1–AC6, option O1).
 *
 * Reached ONLY when the coordination offer list yielded nothing dispatchable
 * (the caller invokes it after the offer loop, before its own-backlog
 * fallback). Candidate universe:
 *
 *     offers ∪ sweep(registeredRoots) ∪ ownBacklog(opts.cwd)
 *
 * Frozen rules:
 *
 *  1. **One canonical ranking (AC3).** Each root is read through
 *     `readOwnHeadWindow` — `getHerdrListHead(root, sprintView)` plus the SAME
 *     bounded extension (`DOWNTIME_DISPATCH_EXTEND_MAX`) the own-backlog
 *     fallback uses. The first eligible item in that canonical order wins; the
 *     sweep is a bounded WINDOW over roots, never a second ranking.
 *  2. **Round-robin fairness (AC4).** The starting root is chosen with the
 *     SAME `selectLeastRecentlyServed` cursor the offer path uses (it advances
 *     the selected root atomically); the sweep then visits the remaining roots
 *     in registry order. A root with nothing dispatchable never consumes the
 *     tick — the sweep continues to the next root. The sweep runs BEFORE the
 *     leader's own out-of-view backlog, so a busy leader root cannot starve the
 *     registry.
 *  3. **No gate bypass (AC2).** Every candidate passes the FULL sequential
 *     filter chain against ITS OWN root's state (freeze marker, review queue,
 *     in-flight panes, cooldown log, claim target). A gate that holds the only
 *     swept candidate keeps its NEUTRAL terminal reason (the caller's hold
 *     flags), never `no-candidate`.
 *  4. **Fail-open (AC5).** A root whose head read throws or resolves
 *     `{ok:false}` (missing/unreadable) is skipped without a strike and never
 *     crashes the tick. When every registered root fails, the caller's terminal
 *     reason is unchanged.
 *  5. **Fail-safe (AC6).** No registry (absent/empty after normalisation) ⇒
 *     `null` immediately, with no cursor read/write and no extra `wl` spawn —
 *     today's behaviour byte-for-byte.
 *  6. A swept dispatch is recorded with `selectionPath:
 *     'registered-root-sweep'` and does NOT raise `ownBacklogDispatch`: the
 *     leader is serving a registered root, not its own backlog, so it must not
 *     hand off leadership (that would flap the machine-wide election on every
 *     sweep).
 */
export async function dispatchFromRegisteredRoots(
  deps: HeadScanDeps,
  opts: RegisteredRootSweepOptions,
  base: HeadScanBase,
  now: number,
): Promise<DowntimeDispatchOutcome | null> {
  const roots = normaliseRegisteredRoots(opts.registeredRoots);
  // AC6: an empty or unresolvable registry leaves today's behaviour unchanged.
  if (roots.length === 0) return null;
  // AC4: the least-recently-served root starts the sweep (the cursor advances
  // for it here, exactly as the offer path does); the rest follow in registry
  // order. A root found with nothing dispatchable is skipped, not charged.
  const first = selectLeastRecentlyServed(opts.coordinationDir, [...roots], now);
  const ordered = first === null ? roots : [first, ...roots.filter(root => root !== first)];
  for (const root of ordered) {
    // AC5: a missing/unreadable root resolves `null` (the reader already
    // catches thrown reads and `{ok:false}`) — a skip, never a strike.
    const window = await readOwnHeadWindow(deps, root, opts.browseItemCount);
    if (window === null) continue;
    // AC2: the freeze marker is PER ROOT. Reuse the tick-level read for the
    // leader's own root; a registered root is read fresh so its own freeze can
    // never be bypassed (and the leader's freeze cannot wrongly block it).
    const frozen =
      root === opts.cwd ? opts.frozen : isFrozenStatus(deps.readCodeFreezeStatus(root));
    const outcome = await dispatchFromOwnHead(
      deps,
      opts,
      {
        ...base,
        root,
        window,
        frozen,
        kinds: null,
        excludeIds: EMPTY_EXCLUDE,
        selectionPath: 'registered-root-sweep',
        selectionReason: 'registered-root-sweep',
        skipOnLostClaim: true,
        includeHead: true,
      },
      now,
    );
    // A dispatch, or a terminal (strike/spawn-failed/…) outcome, ends the
    // tick. A root with nothing dispatchable returns `null` and the sweep
    // continues to the next registered root.
    if (outcome !== null) return outcome;
  }
  return null;
}
