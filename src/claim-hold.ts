/**
 * TTL-bounded monotonic claim-hold guard (SA-0MVE34D9B005TUYJ →
 * SA-0MVKWV2V2006JC8E).
 *
 * ## Why
 *
 * The project invariant is *actively worked ⇒ `in_progress`*
 * (SA-0MTFTFUIH000UWM9). A background `wl sync --if-idle` broke it four times
 * in a single implement run (SA-0MVDQF3VW002PKCA, 2026-10-18) by writing a
 * pre-claim snapshot back over a held claim, so the agent had to re-claim the
 * item between tool calls.
 *
 * The merge layer alone cannot prevent this. `isRegressionDefault()`
 * (`src/sync.ts`) treats only `status: open` / `stage: idea` as regression
 * defaults, so `status: in-progress → open` is refused, but:
 *
 *   - a *write* path can install a stale row outright —
 *     `WorklogDatabase.import()` re-stamps any semantically-changed incoming
 *     row with `updatedAt = new Date().toISOString()`, so a stale row that
 *     reaches the persist layer becomes the newest row and wins every later
 *     merge (`upsertItems()` behaves the same on the delta path); and
 *   - `stage: plan_complete → intake_complete` is a *non-default → non-default*
 *     transition, which the merge resolves purely by timestamp — so a stale
 *     row that looks newer also downgrades the stage.
 *
 * This module is the monotonic guard that both paths lack: while a claim is
 * *held*, a sync may not reduce the claimed `status`/`stage` pair to a less
 * active pair, and the claim's `updatedAt`/`activityAt` are preserved (never
 * re-stamped).
 *
 * ## What counts as a held claim
 *
 *   - `status: in-progress` (the canonical hyphenated form; `in_progress` is
 *     accepted for older stores), **or**
 *   - a non-empty `assignee` on an item that is neither `completed` nor
 *     `deleted` (the "assignee-only hold" used by the audit tier), **and**
 *   - the claim's activity timestamp (`activityAt`, falling back to
 *     `updatedAt`) is within `syncClaimHoldTtlHours` (default 24 h).
 *
 * `stage` alone is never a claim: the workflow advances stages without
 * claiming.
 *
 * ## What it does NOT do (deliberately)
 *
 *   - It is **not** "last writer wins on status": a *newer, more active*
 *     transition always propagates (`in-progress → completed`,
 *     `plan_complete → in_review`, a close, an audit demotion of a completed
 *     item, a reassignment).
 *   - It is **not** a fieldset freeze: only `status`/`stage` (and the claim's
 *     own timestamps) are pinned; every other field still resolves by
 *     timestamp as before.
 *   - It never blocks an **attributed delete** (`deletedBy`/`deleteReason`):
 *     deletion is terminal intent and must keep propagating
 *     (WL-0MSKZ30SK007K9TO).
 *   - It is **time-bounded**: a claim older than the TTL is released, so an
 *     abandoned claim cannot freeze an item forever (`0` disables the guard).
 */

import type { WorkItem } from './types.js';

/** Default claim-protection window: long enough to cover an 8-hour drive run. */
export const DEFAULT_CLAIM_HOLD_TTL_HOURS = 24;

/**
 * Activity ranking for `status`. A transition to a *lower* rank is a
 * downgrade; `deleted` is ranked highest because an (attributed) delete is
 * terminal intent, and it is exempted separately anyway.
 *
 * Unknown/custom statuses are not ranked (the guard skips them rather than
 * guessing).
 */
const STATUS_ACTIVITY: Readonly<Record<string, number>> = {
  open: 0,
  blocked: 1,
  input_needed: 1,
  'in-progress': 2,
  in_progress: 2,
  completed: 3,
  deleted: 4,
};

/**
 * Activity ranking for `stage`, following the documented workflow order
 * (`idea → intake_complete → plan_complete → in_progress → in_review → done`).
 * Unknown/custom stages are not ranked.
 */
const STAGE_ACTIVITY: Readonly<Record<string, number>> = {
  idea: 0,
  intake_complete: 1,
  prd_complete: 2,
  plan_complete: 3,
  in_progress: 4,
  in_review: 5,
  done: 6,
};

/** Resolved claim-hold policy for one sync run. */
export interface ClaimHoldPolicy {
  /** Protection window in hours. `0` (or negative) disables the guard. */
  ttlHours: number;
  /** Injectable clock (ms since epoch) — tests pin it; default `Date.now()`. */
  nowMs?: number;
}

/** One refused downgrade, recorded for the sync log / `--json` output. */
export interface ClaimHoldDecision {
  workItemId: string;
  /** The claimed pair that was preserved (local side). */
  keptStatus: string;
  keptStage: string;
  /** The downgraded pair the sync tried to write (incoming/merged side). */
  attemptedStatus: string;
  attemptedStage: string;
  /** Which fields would have been downgraded. */
  fields: Array<'status' | 'stage'>;
  /** Age of the claim in hours at decision time. */
  claimAgeHours: number;
  ttlHours: number;
  reason: string;
}

/** The subset of `WorkItem` the guard reads. */
type ClaimFields = Pick<
  WorkItem,
  'id' | 'status' | 'stage' | 'assignee' | 'updatedAt' | 'activityAt'
> & {
  deletedBy?: string;
  deleteReason?: string;
};

/** Parse an ISO timestamp to ms, or `undefined` when absent/unparseable. */
function parseTimestamp(value: string | undefined | null): number | undefined {
  if (!value) return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * True when *item* is a **held** claim — actively worked and last active
 * within the policy's TTL.
 *
 * `in-progress` covers the implement/plan/intake claim; a non-empty assignee
 * covers the audit tier's status-neutral hold (`--if-assignee` CAS) and the
 * producer scheduling hold. Terminal statuses are never claims.
 */
export function isHeldClaim(
  item: ClaimFields | null | undefined,
  policy: ClaimHoldPolicy,
): boolean {
  if (!item) return false;
  if (!(policy.ttlHours > 0)) return false; // `0` (or negative) disables

  const status = String(item.status ?? '');
  const assigned = typeof item.assignee === 'string' && item.assignee.trim() !== '';
  const isClaim = status === 'in-progress' || status === 'in_progress' || assigned;
  if (!isClaim) return false;
  if (status === 'completed' || status === 'deleted') return false;

  // Age of the claim: `activityAt` moves on comments too, so it is the truest
  // "someone is working on this" signal; fall back to `updatedAt`.
  const activity = parseTimestamp(item.activityAt) ?? parseTimestamp(item.updatedAt);
  if (activity === undefined) return true; // unparseable — protect conservatively
  return claimAgeHours(activity, policy) <= policy.ttlHours;
}

/** Age in hours of a claim timestamp under the policy clock (non-negative). */
export function claimAgeHours(activityMs: number, policy: ClaimHoldPolicy): number {
  const now = policy.nowMs ?? Date.now();
  return Math.max(0, (now - activityMs) / 3_600_000);
}

/** True for an attributed (real-intent) soft delete — never blocked here. */
function isAttributedDelete(item: ClaimFields): boolean {
  return Boolean(item.deletedBy) || Boolean(item.deleteReason);
}

/** Rank of a status, or `undefined` for an unknown/custom status. */
function statusRank(status: string | undefined): number | undefined {
  if (!status) return undefined;
  return STATUS_ACTIVITY[status];
}

/** Rank of a stage, or `undefined` for an unknown/custom stage. */
function stageRank(stage: string | undefined): number | undefined {
  if (!stage) return undefined;
  return STAGE_ACTIVITY[stage];
}

/** `laterTimestamp`-style max, preserving `undefined` when both are absent. */
function laterTimestamp(a?: string, b?: string): string | undefined {
  const ams = parseTimestamp(a);
  const bms = parseTimestamp(b);
  if (ams === undefined) return b;
  if (bms === undefined) return a;
  return ams >= bms ? a : b;
}

export interface ApplyClaimHoldResult {
  /** Incoming items with any held-claim downgrade refused (order preserved). */
  items: WorkItem[];
  /** One entry per refused downgrade — for the sync log and `--json`. */
  decisions: ClaimHoldDecision[];
}

/**
 * Apply the monotonic claim guard to a set of items about to be persisted.
 *
 * @param currentItems - The store's **current** rows (a fresh read, i.e. one
 *   that can see claims written by another process during the sync window).
 * @param incomingItems - The merged items the sync is about to write.
 * @param policy - TTL policy (see {@link ClaimHoldPolicy}).
 * @returns The items to persist plus the refusal decisions. Items without a
 *   held-claim downgrade are returned unchanged (same object identity).
 */
export function applyClaimHold(
  currentItems: readonly WorkItem[],
  incomingItems: readonly WorkItem[],
  policy: ClaimHoldPolicy,
): ApplyClaimHoldResult {
  if (!(policy.ttlHours > 0)) {
    return { items: [...incomingItems], decisions: [] };
  }

  const current = new Map<string, WorkItem>();
  for (const item of currentItems) {
    current.set(item.id, item);
  }

  const decisions: ClaimHoldDecision[] = [];
  const items = incomingItems.map((incoming) => {
    const existing = current.get(incoming.id);
    if (!existing || !isHeldClaim(existing, policy)) return incoming;
    if (isAttributedDelete(incoming)) return incoming; // deletion is terminal intent

    const localStatusRank = statusRank(existing.status);
    const localStageRank = stageRank(existing.stage);
    const incomingStatusRank = statusRank(incoming.status);
    const incomingStageRank = stageRank(incoming.stage);

    const statusDowngrade =
      localStatusRank !== undefined &&
      incomingStatusRank !== undefined &&
      incomingStatusRank < localStatusRank;
    const stageDowngrade =
      localStageRank !== undefined &&
      incomingStageRank !== undefined &&
      incomingStageRank < localStageRank;

    if (!statusDowngrade && !stageDowngrade) return incoming;

    const fields: Array<'status' | 'stage'> = [];
    if (statusDowngrade) fields.push('status');
    if (stageDowngrade) fields.push('stage');

    const activity = parseTimestamp(existing.activityAt) ?? parseTimestamp(existing.updatedAt);
    const ageHours = activity === undefined ? 0 : claimAgeHours(activity, policy);

    decisions.push({
      workItemId: incoming.id,
      keptStatus: existing.status,
      keptStage: existing.stage,
      attemptedStatus: incoming.status,
      attemptedStage: incoming.stage,
      fields,
      claimAgeHours: Number(ageHours.toFixed(3)),
      ttlHours: policy.ttlHours,
      reason:
        `held claim (${fields.join('+')} downgrade refused): ` +
        `${existing.status}/${existing.stage} → ${incoming.status}/${incoming.stage}`,
    });

    // Pin the claimed *pair* (a half-downgraded pair would be an invalid
    // status/stage combination) and the claim's own timestamps, so neither the
    // merge nor `import()`/`upsertItems()`' re-stamp can make the losing side
    // look newer. Every other field keeps the merged value.
    return {
      ...incoming,
      status: existing.status,
      stage: existing.stage,
      updatedAt: existing.updatedAt,
      activityAt: laterTimestamp(existing.activityAt, incoming.activityAt),
    };
  });

  return { items, decisions };
}

/**
 * Resolve the claim-hold TTL from project config.
 *
 * Accepts both spellings used across the docs and existing configs:
 * `sync.claimHoldTtlHours` (nested, as specified by the work item) and the
 * flat `syncClaimHoldTtlHours` (consistent with the other `sync*` keys).
 * Invalid values fall back to {@link DEFAULT_CLAIM_HOLD_TTL_HOURS}; `0`
 * disables the guard.
 */
export function resolveClaimHoldTtlHours(config: unknown): number {
  const cfg = (config ?? {}) as Record<string, any>;
  const candidates = [cfg.sync?.claimHoldTtlHours, cfg.syncClaimHoldTtlHours];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === '') continue;
    const value = Number(candidate);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return DEFAULT_CLAIM_HOLD_TTL_HOURS;
}
