/**
 * Attribution comments for orphaning and promotion (R2,
 * WL-0MWGRKYG0006N2A8, parent WL-0MWFMKWZA005ZT4T).
 *
 * When a child survives its parent — either because the parent was deleted
 * with `--no-recursive` (explicit orphaning) or because the child was detached
 * (`parentId -> null`, "promoted" to a top-level item) — the history of *why*
 * it happened was previously lost. This helper records that decision as a
 * comment on the child so `wl show` / the TUI explains how the item came to be
 * parentless and which parent it used to belong to.
 *
 * The promotion comment carries the retention-rule rationale (AC5):
 *
 *   - `promote-because-live` — the child's subject is still live, so it was
 *     promoted to a top-level item rather than retired.
 *   - `retire-because-stale` — the previous parent no longer resolves to a
 *     live item (hard-deleted, soft-deleted or a bogus sentinel such as
 *     `WL-NULL`), so the stale link was retired and the live child promoted.
 *
 * Kept in the CLI layer (not `@worklog/shared`) because worktrees resolve
 * `@worklog/shared` to the main checkout's built `dist`, so shared changes are
 * invisible to the worktree test suite; the CLI layer is fully testable here.
 * Both helpers are best-effort: a comment-write failure never undoes the
 * orphaning/promotion or aborts the command that triggered it.
 */

import type { WorklogDatabase } from './database.js';
import { isSoftDeleted } from '@worklog/shared/predicates';

/** Retention-rule rationale tokens recorded on a promotion (AC5). */
export type PromotionRationale = 'promote-because-live' | 'retire-because-stale';

/** Human-readable explanation for each rationale token. */
const RATIONALE_EXPLANATION: Record<PromotionRationale, string> = {
  'promote-because-live':
    "the child's subject is still live, so it was promoted to a top-level item " +
    'rather than retired',
  'retire-because-stale':
    'the previous parent no longer resolves to a live item, so the stale link ' +
    'was retired and the live child promoted to top-level',
};

/**
 * Build the comment text recording a promotion (`parentId -> null`).
 *
 * @param previousParentId - the parent the child was detached from
 * @param rationale - the retention-rule rationale token
 * @param via - the command/module that performed the detach
 */
export function buildDetachComment(
  previousParentId: string,
  rationale: PromotionRationale,
  via: string,
): string {
  return (
    `Promoted to top-level (previous parent: ${previousParentId}) via ${via}. ` +
    `Rationale: ${rationale} — ${RATIONALE_EXPLANATION[rationale]}.`
  );
}

/**
 * Record a promotion-attribution comment on a detached child.
 *
 * The rationale is derived from the previous parent's state: a parent that
 * still resolves to a live (non-soft-deleted) row yields
 * `promote-because-live`; anything else (hard-deleted, soft-deleted or an
 * unresolvable sentinel) yields `retire-because-stale`.
 *
 * @param db - the worklog database to write the comment to
 * @param childId - the item that was detached
 * @param previousParentId - the parent id the item no longer references
 * @param via - the command/module that performed the detach
 */
export function recordDetachAttribution(
  db: WorklogDatabase,
  childId: string,
  previousParentId: string | null | undefined,
  via: string,
): void {
  if (!previousParentId) return;

  const parent = db.get(previousParentId);
  const parentIsLive = !!parent && !isSoftDeleted(parent);
  const rationale: PromotionRationale = parentIsLive
    ? 'promote-because-live'
    : 'retire-because-stale';

  try {
    db.createComment({
      workItemId: childId,
      author: 'system',
      comment: buildDetachComment(previousParentId, rationale, via),
      references: [previousParentId],
    });
  } catch {
    // Best-effort: the detach already succeeded; never abort the caller (or
    // roll back the parent link) just because the comment failed.
  }
}

/**
 * Record an attribution comment on each child orphaned by an explicit
 * `wl delete --no-recursive` (AC2).
 *
 * The comment names the previous parent and the explicit decision so the
 * survivorship is traceable back to the parent work item. Children that are
 * themselves already soft-deleted are skipped — they are not live orphans.
 *
 * @param db - the worklog database to write the comment to
 * @param childId - the surviving child
 * @param previousParentId - the parent that was deleted
 * @param options - `via` (the command path) and the optional delete `reason`
 */
export function recordOrphanAttribution(
  db: WorklogDatabase,
  childId: string,
  previousParentId: string,
  options: { via: string; reason?: string },
): void {
  if (!previousParentId) return;

  const child = db.get(childId);
  if (!child || isSoftDeleted(child)) return;

  const reasonSuffix = options.reason ? ` Reason given: ${options.reason}.` : '';

  try {
    db.createComment({
      workItemId: childId,
      author: 'system',
      comment:
        `Orphaned by explicit decision via ${options.via}: previous parent ` +
        `${previousParentId} was deleted without its children, leaving this ` +
        `child live as a top-level item.${reasonSuffix}`,
      references: [previousParentId],
    });
  } catch {
    // Best-effort: the delete already succeeded; never abort the caller.
  }
}
