/**
 * Audit-trail comment for parent demotion on late child attach.
 *
 * When a `completed`/`in_review` parent is demoted back to
 * `open`/`plan_complete` because a new child was attached, the transition was
 * previously silent: the parent simply reappeared in the open queue with no
 * explanation (WL-0MTWU4Y82001B3UH, parent epic WL-0MTWU13SU008VLW9).
 *
 * This helper records *why* the parent was reopened — the attached child, the
 * actor, and the from -> to transition — as a comment on the parent, so a
 * revival is explicable in `wl show` / the TUI.
 *
 * Kept in the CLI layer (not `@worklog/shared`) because worktrees resolve
 * `@worklog/shared` to the main checkout's built `dist`, so shared changes are
 * invisible to the worktree test suite; the CLI layer is fully testable here.
 * The helper is best-effort: a comment-write failure never undoes the demotion
 * or aborts the attach that triggered it.
 */

import type { DemotedParent, WorkItem } from './types.js';
import type { WorklogDatabase } from './database.js';

/**
 * Record a demotion audit-trail comment on the demoted parent.
 *
 * @param db - the worklog database to write the comment to
 * @param demotedParent - the demotion result returned by
 *   `demoteParentOnChildAdded` (carries the parent id and from/to transition)
 * @param child - the newly attached child (used for the id/actor); may be
 *   omitted when the caller does not have the child to hand
 */
export function recordDemotionAuditTrail(
  db: WorklogDatabase,
  demotedParent: DemotedParent,
  child?: WorkItem | null,
): void {
  try {
    const actor = (child?.createdBy ?? '').trim() || 'system';
    const childRef = child
      ? `${child.id}${child.title ? ` ("${child.title}")` : ''}`
      : 'an unnamed child';
    db.createComment({
      workItemId: demotedParent.parent.id,
      author: actor,
      comment:
        `Parent reopened: ${childRef} was attached, demoting ` +
        `${demotedParent.from.status}/${demotedParent.from.stage} -> ` +
        `${demotedParent.to.status}/${demotedParent.to.stage} at ${new Date().toISOString()}.`,
      references: child ? [child.id] : [],
    });
  } catch {
    // Best-effort: the demotion itself already succeeded; never abort the
    // caller (or roll back the parent state) just because the comment failed.
  }
}
