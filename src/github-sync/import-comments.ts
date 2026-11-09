/**
 * src/github-sync/import-comments.ts — GitHub → worklog comment import phase.
 *
 * Concern: the final phase of the import. It maps the imported issues back to
 * their work-item ids, decides which issues need their comment thread fetched,
 * lists those threads and turns every non-worklog, non-empty GitHub comment
 * into a worklog comment carrying the `githubCommentId` /
 * `githubCommentUpdatedAt` mapping the push flow uses next time.
 *
 * The fetch filter is the part worth reading twice: comments are only fetched
 * for issues that are *newly mapped* or whose GitHub `updatedAt` is newer than
 * the locally recorded `githubIssueUpdatedAt`, so a full import does not issue
 * one comment API call per issue. Comments originating in worklog (they carry a
 * `worklog:comment=<id>` marker) are skipped, because they were pushed from
 * worklog and already exist locally.
 *
 * Extracted from `src/github-sync.ts` (WL-0MW0JFANE006VCGO, child 7 of 8 of the
 * WL-0MVGKH9Z900178UF `src/github-sync.ts` decomposition). Move-only: the
 * filter predicates, the `gh-<id>` fallback comment id, the `comments` progress
 * phase and the skip-on-failed-thread-fetch behaviour are unchanged. GitHub
 * helpers come from the `../github.js` barrel; this module never imports the
 * `./github-sync.js` barrel.
 */

import type { Comment, WorkItem } from '../types.js';
import {
  GithubConfig,
  GithubIssueComment,
  extractWorklogCommentId,
  listGithubIssueCommentsAsync,
} from '../github.js';
import type { ImportScanState } from './import-hierarchy.js';
import type { ProgressCallback, ProgressEmitter } from './progress.js';

/** Inputs of the comment import phase. */
export interface ImportCommentsOptions {
  /** GitHub connection/label-prefix configuration. */
  config: GithubConfig;
  /** The local items the import started from (its GitHub snapshot). */
  items: WorkItem[];
  /** The merged items produced by this import. */
  mergedItems: WorkItem[];
  /** The scan state (see `issueMetaById` / `seenIssueNumbers`). */
  state: ImportScanState;
  /** Optional id generator for imported comments. */
  generateCommentId?: () => string;
  /** Optional progress consumer. */
  onProgress?: ProgressCallback;
  /** The flow's progress emitter. */
  emitProgress: ProgressEmitter;
}

/**
 * Import the GitHub comments of the issues that changed since the recorded
 * local snapshot, skipping worklog-originated and empty comments.
 */
export async function importIssueComments(options: ImportCommentsOptions): Promise<Comment[]> {
  const { config, items, mergedItems, state, generateCommentId, onProgress, emitProgress } = options;
  // ── Import comments from GitHub issues ────────────────────────────────
  const importedComments: Comment[] = [];
  // Build a lookup: issueNumber -> workItemId from mergedItems
  const itemIdByIssueNumber = new Map<number, string>();
  for (const item of mergedItems) {
    if (item.githubIssueNumber) {
      itemIdByIssueNumber.set(item.githubIssueNumber, item.id);
    }
  }

  // Only fetch comments for issues that changed since the local GitHub snapshot
  // (or for newly-created mappings). This avoids per-issue comment API calls for
  // unchanged issues during full imports.
  const localByIdForComments = new Map(items.map(item => [item.id, item]));
  const shouldFetchCommentsForIssue = (issueNumber: number): boolean => {
    const workItemId = itemIdByIssueNumber.get(issueNumber);
    if (!workItemId) {
      return false;
    }
    const local = localByIdForComments.get(workItemId);
    if (!local) {
      return true;
    }
    const issueMeta = state.issueMetaById.get(workItemId);
    if (!issueMeta || !issueMeta.updatedAt) {
      return true;
    }
    if (!local.githubIssueUpdatedAt) {
      return true;
    }
    const remoteMs = new Date(issueMeta.updatedAt).getTime();
    const localMs = new Date(local.githubIssueUpdatedAt).getTime();
    if (Number.isNaN(remoteMs) || Number.isNaN(localMs)) {
      return true;
    }
    return remoteMs > localMs;
  };

  const commentIssueNumbers = [...state.seenIssueNumbers].filter(shouldFetchCommentsForIssue);
  const commentIssueTotal = commentIssueNumbers.length;
  let commentIssueIndex = 0;
  for (const issueNumber of commentIssueNumbers) {
    commentIssueIndex++;
    emitProgress(onProgress, 'comments', commentIssueIndex, commentIssueTotal || 1);
    const workItemId = itemIdByIssueNumber.get(issueNumber);
    if (!workItemId) continue;

    let ghComments: GithubIssueComment[];
    try {
      ghComments = await listGithubIssueCommentsAsync(config, issueNumber);
    } catch {
      continue;
    }

    for (const ghComment of ghComments) {
      // Skip worklog-originated comments (pushed from Worklog → GitHub)
      const worklogCommentId = extractWorklogCommentId(ghComment.body || undefined);
      if (worklogCommentId) continue;

      // Skip comments with no meaningful body
      if (!ghComment.body || !ghComment.body.trim()) continue;

      const commentId = generateCommentId ? generateCommentId() : `gh-${ghComment.id}`;
      importedComments.push({
        id: commentId,
        workItemId,
        author: ghComment.author || 'unknown',
        comment: ghComment.body,
        createdAt: ghComment.updatedAt,
        references: [],
        githubCommentId: ghComment.id,
        githubCommentUpdatedAt: ghComment.updatedAt,
      });
    }
  }

  return importedComments;
}
