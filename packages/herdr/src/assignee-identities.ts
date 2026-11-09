/**
 * packages/herdr/src/assignee-identities.ts — the work-item `assignee`
 * identities the plugin writes and interprets, defined exactly once.
 *
 * ## Why this module exists (WL-0MW51OB1Y0073TLG, child WL-0MW55V8PA000CD6P)
 *
 * Two concepts share the `assignee` field and must never collapse back into
 * one value:
 *
 * - **`Map` — the producer hold.** `AGENT_ASSIGNEE` is the sentinel the
 *   interactive agent-command path claims with. A non-empty assignee is a
 *   *scheduling hold* (`wl next` skips it), so a session that ends while the
 *   item still carries `Map` leaves a deliberate producer hold that the shared
 *   release predicate (`skill/shared/claim_release.py` → `is_producer_assignee`
 *   / `should_release_assignee`) preserves and the stale-claim reaper never
 *   reaps.
 * - **`dispatcher` — the auto-dispatch claim.** The herdr downtime dispatcher
 *   claims every item it auto-dispatches as `DISPATCHER_ASSIGNEE`, across every
 *   tier (audit, implement, plan, intake, risk-effort). It means "an agent is
 *   on it", so it must be released on every terminal outcome, reaped when
 *   orphaned, and — critically — must never be read as a scheduling hold: the
 *   item stays dispatchable and is never attributed to an all-held window.
 *
 * The dispatcher used to claim with `Map`, which made an auto-dispatched claim
 * indistinguishable from a producer hold; the item was stranded the moment the
 * session ended (observed on WL-0MVR8GDJ3008WY3Y). Keeping both identities in
 * this one leaf module (no imports, so it can be consumed by `index.*` and
 * `downtime-worker.*` alike without forming a runtime cycle) is what stops the
 * two concepts drifting apart again, and it mirrors
 * `DISPATCHER_ASSIGNEE_DEFAULT` / `PRODUCER_ASSIGNEE_DEFAULT` on the
 * SorraAgents side of the release predicate.
 */

/**
 * Assignee the INTERACTIVE agent-command path claims with (`Map`).
 *
 * Also the worklog producer-hold sentinel: it is the one assignee the agent-side
 * release paths preserve. Do not use it for a dispatcher claim — see
 * {@link DISPATCHER_ASSIGNEE}.
 */
export const AGENT_ASSIGNEE = 'Map';

/**
 * Assignee the DOWNTIME DISPATCHER claims with (`dispatcher`).
 *
 * A releasable agent claim: never a producer hold, so the dispatch gates must
 * not treat it as a hold and the release paths must release it.
 */
export const DISPATCHER_ASSIGNEE = 'dispatcher';

/**
 * Whether *assignee* is the downtime dispatcher's claim identity
 * (case-insensitive, surrounding whitespace ignored).
 *
 * Callers use this to distinguish "an agent is on it" from "the producer parked
 * it": see `isAssigneeHeld` in `downtime-worker.selection.ts`.
 */
export function isDispatcherAssignee(
  assignee: string | null | undefined,
): boolean {
  if (typeof assignee !== 'string') return false;
  return assignee.trim().toLowerCase() === DISPATCHER_ASSIGNEE;
}
