/**
 * packages/herdr/src/downtime-worker.prep-supply.ts — the PURE per-root
 * prep-supply classification core (WL-0MWTBJ5N1005BNXZ, child 1 of
 * WL-0MWTAD1KM0081UUD).
 *
 * ## Why this module exists
 *
 * The 2026-11-22/23 overnight run burned 873 refusals (588
 * `audit-budget-saturated`) with an empty prep bucket, and diagnosing it
 * required classifying items by hand. This module pins the *vocabulary* of that
 * classification (the buckets and their precedence) ahead of the read-only
 * report command (WL-0MWTBJ7G1004Y29B), so the measurement cannot silently
 * drift. The report command adds data acquisition (worklist reads, `--root`,
 * `--now`) and its output rendering on top of this core; nothing here does I/O.
 *
 * ## Reuse, never re-implement
 *
 * The classifier gates are delegated to `classifyItemForDispatchDetail` and
 * `isAttemptBudgetExhausted` (`downtime-worker.gates.ts`); the marker and
 * cooldown predicates to `downtime-log-markers.ts`; the soft-delete predicate
 * to `downtime-worker.selection.ts`. This module only *orders* those existing
 * predicates into buckets — it never restates one. The dispatcher's own filter
 * chain (classify → marker → attempt budget → cooldown) is untouched: a
 * verdict here is a *reporting* label, never a dispatch decision.
 *
 * ## Read-only
 *
 * Pure functions over plain data: no `wl`, no subprocess, no filesystem, no
 * mutation of the input (the fixture suite freezes its items to prove it).
 *
 * Canonical bucket table: `docs/dev/downtime-dispatcher.md` →
 * *Prep-supply buckets*. That table and `PREP_SUPPLY_BUCKETS` are one source
 * of truth in two places; the suite fails if they drift.
 */

import {
  classifyItemForDispatchDetail,
  isAttemptBudgetExhausted,
} from './downtime-worker.gates.js';
import {
  DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS,
  DEFAULT_DOWNTIME_MAX_ATTEMPTS,
  DEFAULT_DOWNTIME_NON_TERMINAL_COOLDOWN_MS,
} from './downtime-worker.constants.js';
import {
  dispatchedItemMarkers,
  isNonTerminalCooldownActive,
  markerStillExcludes,
  type DispatchMarker,
} from './downtime-log-markers.js';
import type { DowntimeLogEntry } from './downtime-log-entries.js';
import { isSoftDeleted } from './downtime-worker.selection.js';
import type { ClassifyGateToken } from './downtime-worker.offer-attribution.js';
import type { DowntimeItemInfo } from './downtime-worker.types.js';

/**
 * The prep-supply buckets, in **primary-cause precedence order** — the first
 * bucket that applies to an item is the one reported for it. Documented once,
 * in the same order, in `docs/dev/downtime-dispatcher.md` →
 * *Prep-supply buckets* (the suite asserts the two agree).
 *
 * `offerable` is last because it is the only non-refusal outcome.
 */
export const PREP_SUPPLY_BUCKETS = [
  'producer-review',
  'dispatch-marker',
  'assignee-hold',
  'dependency',
  'startOn',
  'other-gated',
  'attempt-budget',
  'cooldown',
  'offerable',
] as const;

export type PrepSupplyBucket = (typeof PREP_SUPPLY_BUCKETS)[number];

/**
 * The only stages that count as prep supply. `plan_complete` items are
 * implement candidates, never prep supply (parent WL-0MWTAD1KM0081UUD).
 */
export const PREP_SUPPLY_STAGES = ['idea', 'intake_complete'] as const;

/** The dispatch kind a prep-stage item would be offered as. */
export type PrepSupplyKind = 'intake' | 'plan';

/**
 * The dispatch tier of a prep stage: `idea` → `intake`,
 * `intake_complete` → `plan` (the classifier's own mapping). Anything else is
 * not prep supply.
 */
export function prepSupplyKindForStage(
  stage: string | undefined | null,
): PrepSupplyKind | null {
  if (stage === 'idea') return 'intake';
  if (stage === 'intake_complete') return 'plan';
  return null;
}

/**
 * A prep-supply candidate: the gate-fitting item shape plus the dependency
 * edges `wl` records (`from` = this item, `to` = the blocker it waits on).
 */
export interface PrepSupplyItem extends DowntimeItemInfo {
  dependencies?: ReadonlyArray<{ from: string; to: string }>;
}

/**
 * Everything a per-root window classification needs. Every field except `now`
 * has a documented default so a fixture only states what it exercises.
 * `now` is REQUIRED: a frozen clock is what makes a past window replayable.
 */
export interface PrepSupplyContext {
  /** Frozen evaluation instant (ms since epoch). */
  now: number;
  /** Rolling dispatch-log entries of THIS root (markers, pane closes). */
  logEntries?: ReadonlyArray<DowntimeLogEntry>;
  /**
   * Status of blocker items referenced by dependency edges but not present in
   * the window. An unresolvable blocker is treated as UNMET (fail-closed).
   */
  blockerStatusById?: Readonly<Record<string, string | undefined>>;
  /** Per-item, per-kind, per-stage attempt cap (default: dispatcher default). */
  maxAttempts?: number;
  /** Success-marker staleness window (default: dispatcher default). */
  markerStalenessMs?: number;
  /** Non-terminal pane-close cooldown (default: dispatcher default). */
  cooldownMs?: number;
}

/**
 * Why an item is NOT prep supply at all (it appears in no bucket):
 * - `soft-deleted` — non-empty `deletedBy`; never dispatched at any tier;
 * - `terminal-status` — `completed` / `deleted`; work, not supply;
 * - `not-prep-stage` — e.g. `plan_complete` (an implement candidate).
 */
export type PrepSupplyExclusion =
  | 'not-prep-stage'
  | 'terminal-status'
  | 'soft-deleted';

/**
 * One item's verdict: exactly ONE bucket (the primary cause), or `bucket:
 * null` plus the `excluded` reason when the item is out of prep-supply scope.
 * `classifierGate` carries the classifier's own stable token when it refused,
 * so a report can quote the dispatcher's vocabulary instead of paraphrasing.
 */
export interface PrepSupplyVerdict {
  id: string;
  bucket: PrepSupplyBucket | null;
  excluded?: PrepSupplyExclusion;
  kind: PrepSupplyKind | null;
  classifierGate?: ClassifyGateToken;
}

/** One root's classified window: buckets, counts and the offerable ids. */
export interface PrepSupplyRootWindow {
  root: string;
  /** Item ids per bucket, sorted lexicographically (stable, diffable). */
  buckets: Record<PrepSupplyBucket, string[]>;
  counts: Record<PrepSupplyBucket, number>;
  /** The `offerable` bucket, named for readability at call sites. */
  offerable: string[];
  /** Out-of-scope items: they appear in no bucket, by construction. */
  excluded: Array<{ id: string; reason: PrepSupplyExclusion }>;
  /** Every window item's verdict, sorted by item id. */
  verdicts: PrepSupplyVerdict[];
}

/** Marker maps for the two prep kinds, built once per window. */
type PrepMarkers = Record<PrepSupplyKind, Map<string, DispatchMarker>>;

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'deleted']);

function emptyBuckets(): Record<PrepSupplyBucket, string[]> {
  const buckets = {} as Record<PrepSupplyBucket, string[]>;
  for (const bucket of PREP_SUPPLY_BUCKETS) buckets[bucket] = [];
  return buckets;
}

function buildMarkers(entries: ReadonlyArray<DowntimeLogEntry>): PrepMarkers {
  const mutable = [...entries];
  return {
    intake: dispatchedItemMarkers(mutable, 'intake'),
    plan: dispatchedItemMarkers(mutable, 'plan'),
  };
}

/**
 * An outstanding success marker at the item's CURRENT stage: the plan/intake
 * tiers use the `stage-guard` mode (a legacy stageless marker never freezes an
 * item) and the marker expires after the staleness window.
 */
function hasOutstandingMarker(
  item: PrepSupplyItem,
  kind: PrepSupplyKind,
  markers: PrepMarkers,
  ctx: PrepSupplyContext,
): boolean {
  const marker = markers[kind].get(item.id);
  if (marker === undefined) return false;
  const staleness = ctx.markerStalenessMs ?? DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS;
  return markerStillExcludes(marker, item.stage, ctx.now, staleness, 'stage-guard');
}

/**
 * True when any dependency edge of this item points at a blocker that is not
 * terminal. An UNRESOLVABLE blocker (absent from the window AND from
 * `blockerStatusById`) is treated as unmet: the read-only report must never
 * over-report supply on incomplete evidence.
 */
function hasUnmetDependency(
  item: PrepSupplyItem,
  ctx: PrepSupplyContext,
): boolean {
  const deps = item.dependencies ?? [];
  for (const dep of deps) {
    if (dep.from !== item.id) continue;
    const status = ctx.blockerStatusById?.[dep.to];
    if (status === undefined) return true; // unresolvable → fail-closed
    if (!TERMINAL_STATUSES.has(status)) return true;
  }
  return false;
}

/**
 * Classify ONE item into its primary bucket (or its out-of-scope exclusion).
 *
 * Precedence — first match wins, so a fixture with several causes reports the
 * single highest-ranked one:
 *
 * 1. `soft-deleted` / `terminal-status` / `not-prep-stage` → excluded;
 * 2. `producer-review` (classifier gate);
 * 3. `dispatch-marker` (outstanding plan/intake marker at the current stage);
 * 4. scheduling holds: `assignee-hold` → `dependency` → `startOn`;
 * 5. `other-gated` (a prep-stage item the classifier refuses for a reason
 *    with no dedicated bucket, e.g. an `in-progress` claim);
 * 6. `attempt-budget`, then `cooldown` (the dispatcher's worker-side gates);
 * 7. `offerable`.
 */
function classifyOne(
  item: PrepSupplyItem,
  ctx: PrepSupplyContext,
  markers: PrepMarkers,
): PrepSupplyVerdict {
  // ── Out of prep-supply scope altogether ────────────────────────────
  if (isSoftDeleted(item)) {
    return { id: item.id, bucket: null, excluded: 'soft-deleted', kind: null };
  }
  const status = typeof item.status === 'string' ? item.status : '';
  if (TERMINAL_STATUSES.has(status)) {
    return { id: item.id, bucket: null, excluded: 'terminal-status', kind: null };
  }
  const kind = prepSupplyKindForStage(item.stage);
  if (kind === null) {
    return { id: item.id, bucket: null, excluded: 'not-prep-stage', kind: null };
  }

  const detail = classifyItemForDispatchDetail(item, ctx.now);
  const gate = detail.gate;

  // ── 2. producer review outranks everything else ────────────────────
  if (gate === 'producer-review') {
    return { id: item.id, bucket: 'producer-review', kind, classifierGate: gate };
  }

  // ── 3. an in-flight prep dispatch outranks a scheduling hold ───────
  if (hasOutstandingMarker(item, kind, markers, ctx)) {
    return { id: item.id, bucket: 'dispatch-marker', kind, classifierGate: gate };
  }

  // ── 4. scheduling holds, in documented order ───────────────────────
  if (gate === 'assignee-hold') {
    return { id: item.id, bucket: 'assignee-hold', kind, classifierGate: gate };
  }
  if (hasUnmetDependency(item, ctx)) {
    return { id: item.id, bucket: 'dependency', kind, classifierGate: gate };
  }
  if (gate === 'startOnNotReached') {
    return { id: item.id, bucket: 'startOn', kind, classifierGate: gate };
  }

  // ── 5. a prep-stage item that is not even open/blocked ─────────────
  if (status !== 'open' && status !== 'blocked') {
    return { id: item.id, bucket: 'other-gated', kind, classifierGate: gate };
  }
  if (gate !== undefined) {
    // Any other classifier refusal has no dedicated prep bucket.
    return { id: item.id, bucket: 'other-gated', kind, classifierGate: gate };
  }

  // ── 6. worker-side gates: attempt budget, then cooldown ────────────
  const entries = [...(ctx.logEntries ?? [])];
  const stage = typeof item.stage === 'string' ? item.stage : undefined;
  const maxAttempts = ctx.maxAttempts ?? DEFAULT_DOWNTIME_MAX_ATTEMPTS;
  if (isAttemptBudgetExhausted(entries, item.id, kind, stage, maxAttempts)) {
    return { id: item.id, bucket: 'attempt-budget', kind, classifierGate: undefined };
  }
  const cooldownMs = ctx.cooldownMs ?? DEFAULT_DOWNTIME_NON_TERMINAL_COOLDOWN_MS;
  if (isNonTerminalCooldownActive(entries, item.id, kind, stage, cooldownMs, ctx.now)) {
    return { id: item.id, bucket: 'cooldown', kind, classifierGate: undefined };
  }

  // ── 7. genuinely offerable prep supply ────────────────────────────
  return { id: item.id, bucket: 'offerable', kind, classifierGate: undefined };
}

/**
 * Classify a single item (convenience for one-off reads). Builds the marker
 * maps for that one call; use {@link classifyPrepSupplyWindow} for a window.
 */
export function classifyPrepSupplyItem(
  item: PrepSupplyItem,
  ctx: PrepSupplyContext,
): PrepSupplyVerdict {
  return classifyOne(item, ctx, buildMarkers(ctx.logEntries ?? []));
}

/**
 * Classify ONE root's prep-supply window.
 *
 * Pure aggregation over {@link classifyPrepSupplyItem}'s rules: every item gets
 * exactly one verdict, bucket member ids are sorted, and every bucket count is
 * derivable from its id list (so "sum of buckets == prep-scope items" is an
 * arithmetic invariant, not a claim).
 */
export function classifyPrepSupplyWindow(
  root: string,
  items: ReadonlyArray<PrepSupplyItem>,
  ctx: PrepSupplyContext,
): PrepSupplyRootWindow {
  const markers = buildMarkers(ctx.logEntries ?? []);
  const buckets = emptyBuckets();
  const excluded: Array<{ id: string; reason: PrepSupplyExclusion }> = [];
  const verdicts: PrepSupplyVerdict[] = [];

  for (const item of items) {
    const verdict = classifyOne(item, ctx, markers);
    verdicts.push(verdict);
    if (verdict.bucket === null) {
      excluded.push({ id: verdict.id, reason: verdict.excluded ?? 'not-prep-stage' });
      continue;
    }
    buckets[verdict.bucket].push(verdict.id);
  }

  const counts = {} as Record<PrepSupplyBucket, number>;
  for (const bucket of PREP_SUPPLY_BUCKETS) {
    buckets[bucket].sort();
    counts[bucket] = buckets[bucket].length;
  }
  verdicts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  excluded.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    root,
    buckets,
    counts,
    offerable: buckets.offerable,
    excluded,
    verdicts,
  };
}
