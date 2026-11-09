/**
 * packages/herdr/src/fetcher.blockers.ts — active dependency-blocker predicate.
 *
 * Single responsibility: decide whether an outbound `depends-on` target still
 * blocks the item that depends on it — a target is active unless its status is
 * `completed`/`deleted` or its stage is `in_review`/`done`. Shared by the
 * blocker reads of the fetch API (`./fetcher.api.js`) and the hydrator's
 * dependency hydration.
 *
 * Leaf module: it declares its own structural target shape and imports nothing,
 * so it can be reached from `./fetcher.api.js` without an
 * `api → hydrator → ./fetcher.js → api` cycle: `hydrator.ts` imports the
 * predicate from here and re-exports it, which keeps its own public surface
 * unchanged (parent WL-0MVGKH47T007GKN1 AC4).
 *
 * Moved verbatim out of `hydrator.ts` (parent WL-0MVGKH47T007GKN1; extraction
 * WL-0MW08VWY6001COFS). No behaviour change: the terminal status/stage sets and
 * the case-insensitive comparison are unchanged.
 */

/**
 * The part of an outbound dependency target the predicate reads. Every caller
 * passes a whole edge/item, so `id` is accepted (and ignored) to keep those
 * call sites unchanged.
 */
export interface ActiveBlockerTarget {
  id?: string;
  status?: string;
  stage?: string;
}

/** Statuses considered terminal for an outbound dependency target. */
const TERMINAL_DEP_STATUSES = new Set(['completed', 'deleted']);
/** Stages considered terminal for an outbound dependency target. */
const TERMINAL_DEP_STAGES = new Set(['in_review', 'done']);

/**
 * True when an outbound dependency still blocks: the target is neither
 * `completed`/`deleted` nor at a terminal stage (`in_review`/`done`).
 */
export function isActiveBlocker(target: ActiveBlockerTarget): boolean {
  const status = (target.status ?? '').toLowerCase();
  if (TERMINAL_DEP_STATUSES.has(status)) return false;
  const stage = (target.stage ?? '').toLowerCase();
  if (TERMINAL_DEP_STAGES.has(stage)) return false;
  return true;
}
