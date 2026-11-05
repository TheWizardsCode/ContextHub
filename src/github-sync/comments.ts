/**
 * src/github-sync/comments.ts — worklog→GitHub comment rendering and upsert.
 *
 * Concern: turning a worklog comment into its marker-prefixed GitHub body
 * (`buildGithubCommentBody`) and reconciling an issue's local comments with the
 * comments that already exist on GitHub (`upsertGithubIssueCommentsAsync`) —
 * matching by the `worklog:comment=<id>` marker, updating only bodies that
 * differ, creating the missing ones and persisting the `githubCommentId` /
 * `githubCommentUpdatedAt` mapping through the optional `persistComment`
 * callback. The push flow keeps orchestrating issues; only the comment
 * mapping/persistence rules live here, so they are tested and changed in one
 * place.
 *
 * Moved out of `src/github-sync.ts` (WL-0MW0JF8R6006HUA6, child 5 of 8 of the
 * WL-0MVGKH9Z900178UF `src/github-sync.ts` decomposition). Move-only: marker
 * syntax, author rendering, the "update only when the body differs" rule, the
 * `api.comment.create` / `api.comment.update` metric increments and the
 * swallow-and-log behaviour of a failing `persistComment` are unchanged.
 *
 * This module depends on the github barrel (`../github.js`), the shared
 * `./util.js` helpers and the metrics sink; it never imports the
 * `../github-sync.js` barrel.
 */

import type { Comment } from '../types.js';
import {
  GithubConfig,
  GithubIssueComment,
  stripWorklogMarkers,
  extractWorklogCommentId,
  buildWorklogCommentMarker,
  createGithubIssueCommentAsync,
  updateGithubIssueCommentAsync,
} from '../github.js';
import { increment } from '../github-metrics.js';
import { maxIsoTimestamp, sortCommentsByCreatedAt } from './util.js';

/**
 * Render a worklog comment as its marker-prefixed GitHub comment body.
 *
 * The body is the stable `<!-- worklog:comment=<id> -->` marker, then the
 * author label (bare author in bold, or `**worklog**` when the comment has no
 * author), then the comment text with any worklog markers stripped — trimmed
 * as a whole so an empty comment body leaves no trailing blank lines.
 */
export function buildGithubCommentBody(comment: Comment): string {
  const marker = buildWorklogCommentMarker(comment.id);
  const authorLabel = comment.author ? `**${comment.author}**` : '**worklog**';
  const body = stripWorklogMarkers(comment.comment);
  return `${marker}\n\n${authorLabel}\n\n${body}`.trim();
}

/**
 * Reconcile an issue's local comments with the GitHub comments that exist.
 *
 * Existing GitHub comments are index by their worklog comment marker; the
 * local comments are visited in `createdAt` order so the returned
 * `latestUpdatedAt` is the newest GitHub timestamp touched. A comment whose
 * GitHub body already matches is left untouched; a differing body is updated;
 * a comment with no GitHub counterpart is created. Every created/updated
 * comment has its `githubCommentId`/`githubCommentUpdatedAt` mapping written
 * back onto the local comment and handed to `persistComment`, whose failures
 * are swallowed and reported through `onVerboseLog` (a mapping write must never
 * abort the sync).
 */
export async function upsertGithubIssueCommentsAsync(
  issueConfig: GithubConfig,
  issueNumber: number,
  itemComments: Comment[],
  existingComments: GithubIssueComment[],
  persistComment?: (comment: Comment) => void,
  onVerboseLog?: (message: string) => void
): Promise<{ created: number; updated: number; latestUpdatedAt: string | null }> {
  // Build map of existing GH comments by worklog comment id (from markers)
  const byWorklogId = new Map<string, GithubIssueComment>();
  for (const ghComment of existingComments) {
    const markerId = extractWorklogCommentId(ghComment.body || undefined);
    if (!markerId) continue;
    if (!byWorklogId.has(markerId)) byWorklogId.set(markerId, ghComment);
  }

  let created = 0;
  let updated = 0;
  let latestUpdatedAt: string | null = null;
  const sorted = [...itemComments].sort(sortCommentsByCreatedAt);
  for (const comment of sorted) {
    const body = buildGithubCommentBody(comment);
    const existing = byWorklogId.get(comment.id);
    if (existing) {
      // If the GH comment exists, only update if body changed OR GH's updatedAt is newer than our recorded mapping
      const bodyMatch = (existing.body || '').trim() === body.trim();
      if (!bodyMatch) {
        increment('api.comment.update');
        // updateGithubIssueCommentAsync now schedules internally via the throttler
        // (see src/github.ts). Call it directly to avoid double-scheduling.
        const updatedComment = await updateGithubIssueCommentAsync(issueConfig, existing.id!, body);
        // Persist mapping back to local comment
        comment.githubCommentId = existing.id;
        comment.githubCommentUpdatedAt = updatedComment.updatedAt;
        if (persistComment) {
          try {
            persistComment(comment);
          } catch (err) {
            if (onVerboseLog) onVerboseLog(`[persist] failed to save comment mapping for ${comment.id}: ${(err as Error).message}`);
          }
        }
        updated += 1;
        latestUpdatedAt = maxIsoTimestamp(latestUpdatedAt, updatedComment.updatedAt);
      }
      continue;
    }

    // No GH comment mapping found — create a new comment
    increment('api.comment.create');
    // createGithubIssueCommentAsync now schedules internally via the throttler
    // (see src/github.ts). Call it directly to avoid double-scheduling.
    const createdComment = await createGithubIssueCommentAsync(issueConfig, issueNumber, body);
    // Persist mapping back to local comment so future runs can directly reference by ID
    comment.githubCommentId = createdComment.id;
    comment.githubCommentUpdatedAt = createdComment.updatedAt;
    if (persistComment) {
      try {
        persistComment(comment);
      } catch (err) {
        if (onVerboseLog) onVerboseLog(`[persist] failed to save comment mapping for ${comment.id}: ${(err as Error).message}`);
      }
    }
    created += 1;
    latestUpdatedAt = maxIsoTimestamp(latestUpdatedAt, createdComment.updatedAt);
  }

  return { created, updated, latestUpdatedAt };
}
