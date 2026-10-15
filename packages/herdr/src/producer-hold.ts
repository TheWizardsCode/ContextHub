/**
 * packages/herdr/src/producer-hold.ts — the producer scheduling-hold sentinel.
 *
 * The per-item producer hold was re-homed from the retired producer-review
 * DB flag onto the item's assignee
 * (epic WL-0MV82CHGQ000HAZZ, child WL-0MV85WGIT004PHRC). Assigning an item to
 * the producer's reserved wl identity pauses automatic dispatch and lets the
 * release gate recognise "the producer owns this item" from the assignee
 * alone (WL-0MV85WDOM007BKF8).
 *
 * Extracted into its own module so the fetcher, pane-close chain and
 * downtime worker can all share the sentinel without importing each other in
 * a cycle.
 */

/**
 * Reserved assignee value that marks the producer's per-item scheduling hold.
 *
 * The producer's wl identity is `Map`, so assigning an item to it is an
 * explicit, self-describing "pause auto-dispatch" switch — no magic DB flag
 * is involved. Because the value is the producer's real wl identity, the
 * release gate and the downtime dispatcher can recognise "the producer owns
 * this item" from the assignee alone
 * (WL-0MV85WDOM007BKF8; epic WL-0MV82CHGQ000HAZZ Q2).
 *
 * The sentinel is a reserved identity: it must never collide with an
 * automated agent identity (`pi`, `implement`, `@github-copilot`, …) and it
 * does not. By contrast, the dispatcher's assignee-hold helper
 * (`isAssigneeHeld` in `downtime-worker.ts`) treats ANY non-empty assignee as
 * a hold; this constant identifies the specific producer hold the release
 * gate keys on. Clearing the assignee (empty/whitespace) releases the hold.
 */
export const PRODUCER_HOLD_ASSIGNEE = 'Map';

/**
 * Whether an assignee value is the producer-hold sentinel.
 *
 * Whitespace-only and non-string values are never the sentinel: a blank
 * assignee means "unassigned" (the hold is released). Comparison is exact —
 * the sentinel is a reserved wl identity, not a prefix nor a case variant.
 * A non-sentinel non-empty assignee is still a hold for dispatch purposes;
 * this helper only distinguishes the producer's own hold for the release gate
 * (WL-0MV85WDOM007BKF8).
 */
export function isProducerHold(assignee?: string | null): boolean {
  return (
    typeof assignee === 'string' && assignee.trim() === PRODUCER_HOLD_ASSIGNEE
  );
}
