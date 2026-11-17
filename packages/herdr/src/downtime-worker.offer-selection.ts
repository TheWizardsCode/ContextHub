/**
 * packages/herdr/src/downtime-worker.offer-selection.ts — the leader's
 * drain-aware tie-break over one entry's ADMISSIBLE offers.
 *
 * Parent: WL-0MWDDHQON0015T3P (tier-aware offers). Work item:
 * WL-0MWDVN2HN004CQ1O (leader iterates offers through the unchanged filter
 * chain with drain-aware tie-break).
 *
 * Responsibility: pure selection arithmetic only. It never fetches, classifies
 * or gates an item — the leader's sequential filter chain has already decided
 * admissibility — so `classifyItemForDispatchDetail` stays the single
 * classifier and no gate is duplicated, relaxed or reordered here (parent AC4).
 * Cross-root ORDER is likewise not this module's business:
 * `selectLeastRecentlyServed` owns root order, and this tie-break orders offers
 * only INSIDE one entry, so no root gains an unfair share (parent AC8).
 */

import type { CoordinationEntry, CoordinationOffer } from './coordination.js';
import { toOfferBucket } from './coordination.js';
import type { ReviewQueueGateResult } from './downtime-worker.gates.js';
import type { DowntimeItemInfo, DowntimeSkillKind } from './downtime-worker.types.js';

/** One offer that survived the leader's sequential filter chain. */
export interface AdmissibleOffer {
  /** The CLASSIFIER's kind — never the offer's declared bucket (parent AC4). */
  kind: DowntimeSkillKind;
  info: DowntimeItemInfo;
  offer: CoordinationOffer;
}

/**
 * The offers ONE entry advertises (parent AC1/AC9): its v2 bounded `offers`
 * payload, or — for a legacy v1 entry with no payload — the single
 * `workItemId` as one offer, exactly the pre-tier-aware behaviour. The
 * synthetic v1 bucket is never used as a gate verdict: the leader re-classifies
 * every offer at dispatch time, so the classifier stays the single source of
 * bucket truth.
 */
export function entryOffers(entry: CoordinationEntry): ReadonlyArray<CoordinationOffer> {
  if (Array.isArray(entry.offers) && entry.offers.length > 0) return entry.offers;
  const id = typeof entry.workItemId === 'string' ? entry.workItemId : '';
  return id.length > 0 ? [{ kind: 'implement', workItemId: id }] : [];
}

/**
 * Drain-aware rank (parent AC5). `drainArmed` = this entry's OWN root review
 * queue is at/over `browseItemCount`, so AUDITS (the queue drain) go first.
 * Otherwise `prep` (plan/intake/risk-effort) goes first so implement work keeps
 * being fed, and `implement` comes last — never a fixed implement-first ladder
 * (precedent WL-0MW9X7EJ6009EL6E: implement-first inflates the review queue and
 * starves both the audits that drain it and the prep that feeds it). Lower rank
 * dispatches first.
 */
export function drainAwareRank(kind: DowntimeSkillKind | null, drainArmed: boolean): number {
  const bucket = toOfferBucket(kind);
  if (drainArmed) return bucket === 'audit' ? 0 : bucket === 'prep' ? 1 : 2;
  return bucket === 'prep' ? 0 : bucket === 'implement' ? 1 : 2;
}

/**
 * Order one entry's admissible offers for dispatch (parent AC5). The sort is
 * stable, so the owner's file order still breaks a tie inside a bucket. `gate`
 * is the entry root's review-queue reading (`null` when it is unreadable, the
 * tick is frozen, or the caller does not need it); a single admissible offer is
 * returned untouched, so the pre-v2 single-offer path costs no extra queue
 * read and behaves byte-identically.
 */
export function orderAdmissibleOffers<T extends { kind: DowntimeSkillKind }>(
  offers: readonly T[],
  gate: ReviewQueueGateResult | null,
): readonly T[] {
  if (offers.length < 2) return offers;
  const drainArmed = gate !== null && gate.deep;
  return [...offers].sort(
    (a, b) => drainAwareRank(a.kind, drainArmed) - drainAwareRank(b.kind, drainArmed),
  );
}
