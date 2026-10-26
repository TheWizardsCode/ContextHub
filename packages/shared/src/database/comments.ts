/**
 * packages/shared/src/database/comments.ts — comment storage, comment-side
 * FTS upkeep and activity stamping for the `database.ts` decomposition.
 *
 * Parent: WL-0MVGKGHNR0019OLT (decompose the `database.ts` god class).
 * Slice: WL-0MVOBP6K0007574C (extract dependency and comment modules).
 *
 * ## Responsibility
 *
 * Everything that owns comment rows and the parent-item bookkeeping a comment
 * write implies: comment CRUD (`createComment`, `getComment`, `updateComment`,
 * `deleteComment`, `getCommentsForWorkItem`, `getAllComments`), the two bulk
 * sync entry points (`upsertComments` — incremental delta pull;
 * `importComments` — destructive full snapshot), the change-detection
 * predicate they share (`hasCommentChanged`), and comment activity stamping
 * (`touchWorkItemActivityAt`, which bumps `activityAt` while deliberately
 * preserving `updatedAt` so comment activity never invalidates a passing
 * audit).
 *
 * ## Boundary
 *
 * **Belongs here.** Comment rows, the parent-item FTS refresh a comment write
 * requires (comment text is embedded in the parent's FTS row), and the
 * comment-activity timestamp rule.
 *
 * **Does NOT belong here.** Work-item row CRUD and hierarchy traversal
 * (`work-items.ts`, `hierarchy.ts`), dependency edges and blocked/open
 * reconciliation (`dependencies.ts`), audit results, sort ordering, search
 * and sync transport. This module reads/writes the store directly through
 * `WorklogDatabaseContext` and never imports the `database.ts` façade, so the
 * graph stays acyclic. Comment ids come from `generateCommentId` in
 * `context.ts`; comment text is normalised with `unescapeText` from
 * `../persistent-store.js`, matching what `saveComment()` stores.
 *
 * `WorklogDatabase` keeps a thin delegating member per function so the façade
 * surface is unchanged (parent AC — public API untouched).
 */

import { Comment, CreateCommentInput, UpdateCommentInput } from '../types.js';
import { unescapeText } from '../persistent-store.js';
import {
  WorklogDatabaseContext,
  WriteHooks,
  generateCommentId,
} from './context.js';

/**
 * Create a new comment
 */
export function createComment(
  ctx: WorklogDatabaseContext,
  hooks: WriteHooks,
  input: CreateCommentInput,
): Comment | null {
  // Validate required fields
  if (!input.author || input.author.trim() === '') {
    throw new Error('Author is required');
  }
  if (!input.comment || input.comment.trim() === '') {
    throw new Error('Comment text is required');
  }

  // Verify that the work item exists
  if (!ctx.store.getWorkItem(input.workItemId)) {
    return null;
  }

  const id = generateCommentId(ctx);
  const now = new Date().toISOString();

  const comment: Comment = {
    id,
    workItemId: input.workItemId,
    author: input.author,
    comment: input.comment,
    createdAt: now,
    references: input.references || [],
    // Normalize nullable inputs: treat null as undefined
    githubCommentId: input.githubCommentId == null ? undefined : input.githubCommentId,
    githubCommentUpdatedAt: input.githubCommentUpdatedAt == null ? undefined : input.githubCommentUpdatedAt,
  };

  // Debug: log creation intent before saving (only when not silent)
   if (!ctx.silent) {
     // Send to stderr so JSON output on stdout is not contaminated
     hooks.debug(`WorklogDatabase.createComment: creating comment for ${input.workItemId} by ${input.author}`);
   }

   ctx.store.saveComment(comment);
   touchWorkItemActivityAt(ctx, input.workItemId);
   // Re-index the parent work item in FTS to include the new comment text
   const parentItem = ctx.store.getWorkItem(input.workItemId);
   if (parentItem) ctx.store.upsertFtsEntry(parentItem);
   hooks.triggerAutoSync();
   return comment;
}

/**
 * Get a comment by ID
 */
export function getComment(ctx: WorklogDatabaseContext, id: string): Comment | null {
  return ctx.store.getComment(id);
}

/**
 * Update a comment
 */
export function updateComment(
  ctx: WorklogDatabaseContext,
  hooks: WriteHooks,
  id: string,
  input: UpdateCommentInput,
): Comment | null {
  const comment = ctx.store.getComment(id);
  if (!comment) {
    return null;
  }

  let updatedAny: any = {
    ...comment,
    ...input,
  };

  // Normalize nullable github mapping fields: convert null -> undefined
  if (updatedAny.githubCommentId == null) {
    updatedAny.githubCommentId = undefined;
  }
  if (updatedAny.githubCommentUpdatedAt == null) {
    updatedAny.githubCommentUpdatedAt = undefined;
  }

  // Prevent changing immutable fields
  const updated: Comment = {
    ...updatedAny,
    id: comment.id,
    workItemId: comment.workItemId,
    createdAt: comment.createdAt,
  } as Comment;

   ctx.store.saveComment(updated);
   touchWorkItemActivityAt(ctx, comment.workItemId);
   // Re-index the parent work item in FTS to reflect updated comment text
   const parentItem = ctx.store.getWorkItem(comment.workItemId);
   if (parentItem) ctx.store.upsertFtsEntry(parentItem);
   hooks.triggerAutoSync();
   return updated;
}

/**
 * Delete a comment
 */
export function deleteComment(
  ctx: WorklogDatabaseContext,
  hooks: WriteHooks,
  id: string,
): boolean {
   const comment = ctx.store.getComment(id);
   if (!comment) {
     return false;
   }
   const result = ctx.store.deleteComment(id);
    if (result) {
      touchWorkItemActivityAt(ctx, comment.workItemId);
      // Re-index the parent work item in FTS to reflect removed comment
      const parentItem = ctx.store.getWorkItem(comment.workItemId);
      if (parentItem) ctx.store.upsertFtsEntry(parentItem);
      hooks.triggerAutoSync();
    }
    return result;
}

/**
 * Get all comments for a work item
 */
export function getCommentsForWorkItem(
  ctx: WorklogDatabaseContext,
  workItemId: string,
): Comment[] {
  return ctx.store.getCommentsForWorkItem(workItemId);
}

/**
 * Get all comments as an array
 */
export function getAllComments(ctx: WorklogDatabaseContext): Comment[] {
  return ctx.store.getAllComments();
}

/**
 * Upsert comments non-destructively (incremental-sync delta pull).
 * Unlike {@link importComments} this does NOT clear existing comments first:
 * each provided comment is saved via the store's INSERT OR REPLACE so local
 * comments absent from the incoming delta are preserved, while overlapping ids
 * converge to the merged value.
 *
 * Change detection: unchanged comments are not re-saved, and FTS upkeep is
 * restricted to the affected parent items — looked up by id instead of
 * scanning every work item, so a comment merge never re-indexes the whole
 * store.
 */
export function upsertComments(
  ctx: WorklogDatabaseContext,
  hooks: WriteHooks,
  comments: Comment[],
): void {
  const affectedItemIds = new Set<string>();
  for (const comment of comments) {
    const stored = ctx.store.getComment(comment.id);
    if (stored && !hasCommentChanged(stored, comment)) {
      continue;
    }
    ctx.store.saveComment(comment);
    affectedItemIds.add(comment.workItemId);
  }
  // Comment text is embedded in the parent item's FTS row, so refresh only
  // the affected parents.
  if (ctx.store.ftsAvailable && affectedItemIds.size > 0) {
    for (const id of affectedItemIds) {
      const item = ctx.store.getWorkItem(id);
      if (item) {
        ctx.store.upsertFtsEntry(item);
      }
    }
  }
  hooks.triggerAutoSync();
}

/**
 * Import comments destructively (full-snapshot sync).
 *
 * **Change detection**: comments absent from the incoming set are deleted,
 * unchanged comments are not re-saved, and FTS upkeep is restricted to the
 * parents whose comment text actually changed — a no-change comment import
 * performs zero `saveComment` writes and zero FTS writes instead of clearing
 * and re-indexing every item.
 */
export function importComments(
  ctx: WorklogDatabaseContext,
  hooks: WriteHooks,
  comments: Comment[],
): void {
  const existingById = new Map<string, Comment>();
  for (const stored of ctx.store.getAllComments()) {
    existingById.set(stored.id, stored);
  }
  const incomingIds = new Set(comments.map(comment => comment.id));
  // Parents whose FTS row (which embeds comment text) must be refreshed.
  const affectedItemIds = new Set<string>();

  // One transaction for the whole differential persist (clear/save/FTS), so
  // readers never observe a partially-applied comment snapshot.
  ctx.store.transaction(() => {
    for (const [id, stored] of existingById) {
      if (!incomingIds.has(id)) {
        ctx.store.deleteComment(id);
        affectedItemIds.add(stored.workItemId);
      }
    }
    for (const comment of comments) {
      const stored = existingById.get(comment.id);
      if (stored && !hasCommentChanged(stored, comment)) {
        continue;
      }
      ctx.store.saveComment(comment);
      affectedItemIds.add(comment.workItemId);
      // A comment that moved between items affects both parents.
      if (stored && stored.workItemId !== comment.workItemId) {
        affectedItemIds.add(stored.workItemId);
      }
    }

    // Re-index only the affected parents (FTS rows embed comment text).
    if (ctx.store.ftsAvailable) {
      for (const id of affectedItemIds) {
        const item = ctx.store.getWorkItem(id);
        if (item) {
          ctx.store.upsertFtsEntry(item);
        }
      }
    }
  });

  hooks.triggerAutoSync();
}

/**
 * Compare a stored comment with an incoming candidate and return true when
 * persisting the candidate would change the stored row.
 *
 * `saveComment()` stores comment text unescaped (`unescapeText`), so the
 * incoming text is normalised the same way before comparison — a re-import
 * of the identical snapshot must not look changed. Optional GitHub mapping
 * fields are normalised (null vs undefined are equivalent).
 */
export function hasCommentChanged(stored: Comment, incoming: Comment): boolean {
  return (
    stored.workItemId !== incoming.workItemId ||
    stored.author !== incoming.author ||
    stored.comment !== unescapeText(incoming.comment ?? '') ||
    stored.createdAt !== incoming.createdAt ||
    JSON.stringify(stored.references ?? []) !== JSON.stringify(incoming.references ?? []) ||
    (stored.githubCommentId ?? null) !== (incoming.githubCommentId ?? null) ||
    (stored.githubCommentUpdatedAt ?? null) !== (incoming.githubCommentUpdatedAt ?? null)
  );
}

/**
 * Record comment activity without moving the audit-relevant `updatedAt`.
 *
 * Comment create/update/delete bump `activityAt` only, so ordering/recency
 * features still observe the activity while audit freshness (computed
 * against the content timestamp `updatedAt`) is unaffected
 * (WL-0MUBVH6JM0093KVM). `saveWorkItem` keeps activityAt >= updatedAt.
 */
export function touchWorkItemActivityAt(
  ctx: WorklogDatabaseContext,
  workItemId: string,
): void {
  const item = ctx.store.getWorkItem(workItemId);
  if (!item) {
    return;
  }
  ctx.store.saveWorkItem({
    ...item,
    // updatedAt is intentionally preserved: comment activity must never
    // invalidate a valid audit (see isAuditFresh).
    activityAt: new Date().toISOString(),
  });
}
