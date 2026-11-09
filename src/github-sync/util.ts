/**
 * src/github-sync/util.ts — small shared helpers of the github-sync flows.
 *
 * Concern: the pure primitives both the push and the import flow need —
 * timestamp ordering (`maxIsoTimestamp`, `latestCommentTimestamp`), comment
 * ordering (`sortCommentsByCreatedAt`), the comment-sync predicate
 * (`commentNeedsSync`), title shortening (`truncateTitle`) and the stable
 * comparison key used to decide whether an imported item changed
 * (`stableItemKeyForImport`). Keeping them here lets the flow modules share one
 * implementation instead of carrying private copies.
 *
 * Moved verbatim from the private helpers in `src/github-sync.ts`
 * (WL-0MW0JF6TH00749I2, child 3 of 8 of the WL-0MVGKH9Z900178UF
 * `src/github-sync.ts` decomposition). Move-only: the behaviour of every
 * helper is unchanged. This module depends only on the core types
 * (`../types.js`) and never on the `./github-sync.js` barrel.
 */

import type { Comment, WorkItem } from '../types.js';

/**
 * Return whichever of two ISO timestamps is later, tolerating absent and
 * unparseable values.
 *
 * - both absent → `null`
 * - one absent → the other (or `null` when it is an empty string)
 * - both unparseable → the left value
 * - one unparseable → the parseable value
 * - otherwise the later timestamp
 */
export function maxIsoTimestamp(left?: string | null, right?: string | null): string | null {
  if (!left && !right) {
    return null;
  }
  if (!left) {
    return right || null;
  }
  if (!right) {
    return left || null;
  }
  const leftTime = new Date(left).getTime();
  const rightTime = new Date(right).getTime();
  if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) {
    return left;
  }
  if (Number.isNaN(leftTime)) {
    return right;
  }
  if (Number.isNaN(rightTime)) {
    return left;
  }
  return leftTime >= rightTime ? left : right;
}

/**
 * Latest `createdAt` timestamp across a list of comments, or `null` when the
 * list is empty.
 */
export function latestCommentTimestamp(itemComments: Comment[]): string | null {
  let latest: string | null = null;
  for (const comment of itemComments) {
    latest = maxIsoTimestamp(latest, comment.createdAt);
  }
  return latest;
}

/**
 * Comparator ordering comments by `createdAt` ascending.
 *
 * Unparseable timestamps sort before parseable ones; when both are unparseable
 * the comparator reports equality so the input order is preserved.
 */
export function sortCommentsByCreatedAt(left: Comment, right: Comment): number {
  const leftTime = new Date(left.createdAt).getTime();
  const rightTime = new Date(right.createdAt).getTime();
  if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) {
    return 0;
  }
  if (Number.isNaN(leftTime)) {
    return -1;
  }
  if (Number.isNaN(rightTime)) {
    return 1;
  }
  return leftTime - rightTime;
}

/**
 * Shorten a title to `maxLen` characters (default 60), replacing the elided
 * tail with a single ellipsis character. Shorter titles are returned as-is.
 */
export function truncateTitle(title: string, maxLen = 60): string {
  return title.length <= maxLen ? title : title.slice(0, maxLen - 1) + '\u2026';
}

/**
 * True when an item's comments are newer than the recorded GitHub issue
 * timestamp, so the comment set needs to be pushed.
 *
 * No comments → no sync. A missing or unparseable recorded timestamp → sync.
 */
export function commentNeedsSync(item: WorkItem, itemComments: Comment[]): boolean {
  if (itemComments.length === 0) {
    return false;
  }
  if (!item.githubIssueUpdatedAt) {
    return true;
  }
  const latest = latestCommentTimestamp(itemComments);
  if (!latest) {
    return true;
  }
  const issueUpdatedAt = new Date(item.githubIssueUpdatedAt).getTime();
  if (Number.isNaN(issueUpdatedAt)) {
    return true;
  }
  const latestCommentTime = new Date(latest).getTime();
  if (Number.isNaN(latestCommentTime)) {
    return true;
  }
  return latestCommentTime > issueUpdatedAt;
}

/**
 * Stable comparison key for an imported item.
 *
 * Ignores the sync bookkeeping fields (`updatedAt`, `githubIssueNumber`,
 * `githubIssueId`, `githubIssueUpdatedAt`) and normalises tags to a sorted
 * list, so two items with the same content produce the same key regardless of
 * tag order. Keys are serialised in sorted order for a deterministic string.
 */
export function stableItemKeyForImport(item: WorkItem): string {
  const {
    updatedAt,
    githubIssueNumber,
    githubIssueId,
    githubIssueUpdatedAt,
    ...rest
  } = item;
  const normalized = {
    ...rest,
    tags: [...(item.tags || [])].slice().sort(),
  };
  const keys = Object.keys(normalized).sort();
  return JSON.stringify(normalized, keys);
}
