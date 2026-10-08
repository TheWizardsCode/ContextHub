/**
 * packages/herdr/src/stalled-work.ts — pure stalled-pane classifier
 * (WL-0MUYMBO9X000WDF6, parent WL-0MUMA5OMH0024PN1).
 *
 * The downtime dispatcher must, before opening a NEW pane, notice an existing
 * pane whose pi agent stopped working on a non-terminal work item and resume
 * that work in place. This module provides the pure decision half of that
 * feature: {@link classifyStalledPane} maps a `herdr pane list` record + the
 * pane's work-item info + guard inputs to `{ stalled: true, kind }` or
 * `{ stalled: false, reason }` with no CLI/IO, so every stall condition and
 * every safety/no-progress exclusion is unit-testable in isolation.
 *
 * The resume orchestrator (`resumeStalledPane`) lands in a sibling item
 * (WL-0MUYMBPZ5004LBFX) and builds on this classifier.
 *
 * Reuse, not duplication: `paneLabelItemId` (downtime-worker), the
 * non-terminal status/stage check (`isActiveBlocker`, hydrator), the
 * non-terminal pane-close cooldown (`isNonTerminalCooldownActive`,
 * downtime-log) and the per-item/per-kind attempt cap
 * (`isAttemptBudgetExhausted`, downtime-worker) are the canonical predicates.
 */

import { isActiveBlocker } from './hydrator.js';
import { isNonTerminalCooldownActive, type DowntimeLogEntry } from './downtime-log.js';
import {
  DEFAULT_DOWNTIME_STALL_THRESHOLD_MS,
  isAttemptBudgetExhausted,
  paneLabelItemId,
  type DowntimeItemInfo,
  type DowntimeSkillKind,
  type HerdrPaneRecord,
} from './downtime-worker.js';

// ── Guard inputs ──────────────────────────────────────────────────────

/**
 * The guard inputs the classifier needs beyond the pane and item themselves.
 * Kept explicit (rather than reading settings/log directly) so the classifier
 * stays pure.
 */
export interface StalledPaneGuards {
  /** Rolling downtime dispatch log (cooldown, attempt budget, stall anchor). */
  entries: DowntimeLogEntry[];
  /** Non-terminal pane-close cooldown window (ms). */
  nonTerminalCooldownMs: number;
  /** Per-item/per-kind dispatch attempt cap. */
  maxAttempts: number;
}

// ── Decision types ────────────────────────────────────────────────────

/**
 * Machine-readable reason a pane is NOT a stalled candidate. One code per
 * stall condition / safety exclusion so callers can log or assert precisely:
 *
 *  - `no-agent`                 — the pane hosts no live pi agent.
 *  - `no-item-id`               — the label has no parseable work-item id.
 *  - `kind-unknown`             — the label carries no dispatch kind.
 *  - `item-terminal`            — the item is completed/deleted or in_review/done.
 *  - `needs-producer-review`    — the item is flagged for producer review.
 *  - `agent-working`            — the agent is actively working (not stalled).
 *  - `agent-blocked`            — the agent is blocked (never hijacked).
 *  - `kind-stale`               — the item advanced past the pane's kind.
 *  - `cooldown-active`          — the non-terminal pane-close cooldown holds it.
 *  - `attempt-cap-exhausted`    — the per-item/per-kind attempt cap is reached.
 *  - `last-activity-unknown`    — no activity timestamp to measure a stall.
 *  - `stall-threshold-not-elapsed` — not-working for less than the threshold.
 */
export type StalledPaneReason =
  | 'no-agent'
  | 'no-item-id'
  | 'kind-unknown'
  | 'item-terminal'
  | 'needs-producer-review'
  | 'agent-working'
  | 'agent-blocked'
  | 'kind-stale'
  | 'cooldown-active'
  | 'attempt-cap-exhausted'
  | 'last-activity-unknown'
  | 'stall-threshold-not-elapsed';

/** The classifier's decision: stalled (with the derived kind) or a reason. */
export type StalledPaneDecision =
  | { stalled: true; kind: DowntimeSkillKind }
  | { stalled: false; reason: StalledPaneReason };

// ── Label → kind ──────────────────────────────────────────────────────

/** Every dispatch kind a pane label can name. */
const STALLED_PANE_KINDS: readonly DowntimeSkillKind[] = [
  'implement',
  'risk-effort',
  'intake',
  'audit',
  'plan',
];

/**
 * Derive the dispatched kind from a pane label. Recognises the launcher's
 * `<Downtime|Manually> triggered <kind> …` convention (the kind token is
 * immediately after `triggered`, so a title word can never masquerade as the
 * kind). Returns `null` for any other label — including a free-form
 * `Manually triggered prompt …` pane, which has no dispatch kind.
 */
export function stalledPaneKindFromLabel(label: string | undefined): DowntimeSkillKind | null {
  if (typeof label !== 'string' || label === '') return null;
  const match = /(?:downtime|manually)\s+triggered\s+([a-z][a-z-]*)/i.exec(label);
  if (match === null) return null;
  const token = match[1].toLowerCase();
  return (STALLED_PANE_KINDS as readonly string[]).includes(token)
    ? (token as DowntimeSkillKind)
    : null;
}

// ── Kind vs item-stage progression ────────────────────────────────────

/** Worklog stage rank (higher = further through the lifecycle). */
const ITEM_STAGE_RANK: Record<string, number> = {
  idea: 0,
  intake_complete: 1,
  plan_complete: 2,
  // Retired `in_progress` stage — an item being implemented. Rank it with
  // plan_complete so an implement pane is not treated as stale.
  in_progress: 2,
  in_review: 3,
  done: 4,
};

/** The stage at which each dispatched kind operates. */
const KIND_STAGE_RANK: Record<DowntimeSkillKind, number> = {
  intake: 0,
  plan: 1,
  'risk-effort': 2,
  implement: 2,
  audit: 3,
};

/**
 * True when the item has already advanced past the pane's dispatched kind
 * (parent AC4): e.g. an `intake` pane on an item now at `intake_complete`, or
 * an `implement` pane on an item now at `in_review`. An unknown stage cannot
 * prove advancement, so it fails open (not stale).
 */
function itemAdvancedPastKind(kind: DowntimeSkillKind, stage: string | undefined): boolean {
  const itemRank = typeof stage === 'string' ? (ITEM_STAGE_RANK[stage] ?? -1) : -1;
  return itemRank > KIND_STAGE_RANK[kind];
}

// ── Not-working duration ──────────────────────────────────────────────

/** `herdr agent_status` values that mean the agent is actively working. */
const WORKING_AGENT_STATUSES: ReadonlySet<string> = new Set([
  'work',
  'working',
  'busy',
  'running',
]);

/**
 * Timestamp of the item's last observed progress, used as the anchor for the
 * "not-working has persisted at least the threshold" test. It is the LATER of
 * the item's `updatedAt` and the item's most recent dispatch marker for
 * `kind`, so a pane freshly dispatched for an item last updated long ago is
 * not mistaken for a stall. Returns `null` when neither is parseable — the
 * caller treats that as an unprovable stall (fail-safe: skip).
 */
function resolveLastActivityAt(
  itemInfo: DowntimeItemInfo,
  entries: DowntimeLogEntry[],
  itemId: string,
  kind: DowntimeSkillKind,
): number | null {
  let anchor: number | null = null;
  if (typeof itemInfo.updatedAt === 'string' && itemInfo.updatedAt !== '') {
    const updated = Date.parse(itemInfo.updatedAt);
    if (!Number.isNaN(updated)) anchor = updated;
  }
  for (const entry of entries) {
    if (entry.itemId !== itemId || entry.kind !== kind) continue;
    if (entry.outcome === 'spawn-failed') continue;
    if (entry.enrichment === true) continue;
    if (typeof entry.dispatchedAt !== 'string') continue;
    const dispatched = Date.parse(entry.dispatchedAt);
    if (Number.isNaN(dispatched)) continue;
    if (anchor === null || dispatched > anchor) anchor = dispatched;
  }
  return anchor;
}

// ── Classifier ────────────────────────────────────────────────────────

/**
 * Decide whether a `herdr pane list` record describes a STALLED pane
 * (parent AC1/AC4). A pane is stalled when ALL hold:
 *
 *  1. it hosts a live pi agent (`agent` present);
 *  2. its label suffix parses to a non-terminal item (status not
 *     `completed`/`deleted`, stage not `in_review`/`done`);
 *  3. its `agent_status` is not `blocked` and not actively working;
 *  4. its not-working state has persisted at least `thresholdMs`;
 *
 * and NONE of the safety/no-progress exclusions apply: producer-review flag,
 * non-terminal pane-close cooldown, attempt cap, or item advanced past the
 * pane's dispatched kind.
 *
 * Pure: `now` and `thresholdMs` are injected so the decision is deterministic.
 * Skips are neutral by construction — the caller must not turn them into a
 * CLI-error strike or a `no-candidate` cooldown.
 *
 * @param pane       Parsed `herdr pane list` record.
 * @param itemInfo   The item named by the pane's label suffix.
 * @param guards     Log-derived cooldown/attempt/anchor inputs.
 * @param now        Current epoch ms (injectable for tests).
 * @param thresholdMs Minimum continuous not-working duration for a stall.
 */
export function classifyStalledPane(
  pane: HerdrPaneRecord,
  itemInfo: DowntimeItemInfo,
  guards: StalledPaneGuards,
  now: number = Date.now(),
  thresholdMs: number = DEFAULT_DOWNTIME_STALL_THRESHOLD_MS,
): StalledPaneDecision {
  // 1. A live pi agent must be present (an `agent` value is set).
  if (typeof pane.agent !== 'string' || pane.agent === '') {
    return { stalled: false, reason: 'no-agent' };
  }

  // 2. The label must carry a work-item id and a dispatch kind.
  const itemId = paneLabelItemId(pane.label);
  if (itemId === null) {
    return { stalled: false, reason: 'no-item-id' };
  }
  const kind = stalledPaneKindFromLabel(pane.label);
  if (kind === null) {
    return { stalled: false, reason: 'kind-unknown' };
  }

  // 3. The item must be non-terminal (not completed/deleted, not
  //    in_review/done) — reuse the canonical predicate.
  if (!isActiveBlocker(itemInfo)) {
    return { stalled: false, reason: 'item-terminal' };
  }

  // 4. Producer-review flag is a hard exclusion.
  if (itemInfo.needsProducerReview === true) {
    return { stalled: false, reason: 'needs-producer-review' };
  }

  // 5. The agent must be neither actively working nor blocked.
  const status = (pane.agentStatus ?? '').toLowerCase().trim();
  if (WORKING_AGENT_STATUSES.has(status)) {
    return { stalled: false, reason: 'agent-working' };
  }
  if (status === 'blocked') {
    return { stalled: false, reason: 'agent-blocked' };
  }

  // 6. The item must not have advanced past the pane's dispatched kind.
  if (itemAdvancedPastKind(kind, itemInfo.stage)) {
    return { stalled: false, reason: 'kind-stale' };
  }

  // 7. No-progress guards: non-terminal pane-close cooldown, then attempt cap.
  if (
    isNonTerminalCooldownActive(
      guards.entries,
      itemId,
      kind,
      itemInfo.stage,
      guards.nonTerminalCooldownMs,
      now,
    )
  ) {
    return { stalled: false, reason: 'cooldown-active' };
  }
  if (
    isAttemptBudgetExhausted(
      guards.entries,
      itemId,
      kind,
      itemInfo.stage,
      guards.maxAttempts,
    )
  ) {
    return { stalled: false, reason: 'attempt-cap-exhausted' };
  }

  // 8. The not-working state must have persisted at least the threshold.
  const lastActivityAt = resolveLastActivityAt(itemInfo, guards.entries, itemId, kind);
  if (lastActivityAt === null) {
    return { stalled: false, reason: 'last-activity-unknown' };
  }
  if (now - lastActivityAt < thresholdMs) {
    return { stalled: false, reason: 'stall-threshold-not-elapsed' };
  }

  return { stalled: true, kind };
}
