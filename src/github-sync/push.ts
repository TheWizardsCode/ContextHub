/**
 * src/github-sync/push.ts — the worklog→GitHub push flow.
 *
 * Concern: pushing work items and their comments to GitHub — creating/updating
 * issues, skipping unchanged items, guarding deleted items without an issue,
 * upserting an issue's comments and linking parent/child issues as sub-issues
 * (with a per-parent hierarchy cache and a self-link guard). The flow
 * accumulates the `GithubSyncResult` counters/errors and the `GithubSyncTiming`
 * breakdown its callers report.
 *
 * Moved out of `src/github-sync.ts` (WL-0MW0JF9QG008E791, child 6 of 8 of the
 * WL-0MVGKH9Z900178UF `src/github-sync.ts` decomposition). Move-only: the skip
 * decisions, ordering, error strings, `__lastStartTime` / `__lastEndTime`
 * diagnostics, event-loop yields and timing metrics are unchanged.
 *
 * This module depends on the github barrel (`../github.js`), the shared
 * `./util.js` / `./progress.js` / `./comments.js` helpers, the central
 * throttler and the metrics sink; it never imports the `../github-sync.js`
 * barrel. All GitHub calls are scheduled through the central throttler — there
 * is no local worker pool here.
 */

import type { WorkItem, Comment } from '../types.js';
import {
  GithubConfig,
  GithubIssueRecord,
  getIssueHierarchyAsync,
  addSubIssueLinkResult,
  addSubIssueLinkResultAsync,
  workItemToIssuePayload,
  createGithubIssueAsync,
  updateGithubIssueAsync,
  listGithubIssueCommentsAsync,
  normalizeGithubLabelPrefix,
} from '../github.js';
import throttler from '../github-throttler.js';
import { increment, snapshot, diff } from '../github-metrics.js';
import { createProgressEmitter } from './progress.js';
import { commentNeedsSync, maxIsoTimestamp, truncateTitle } from './util.js';
import { upsertGithubIssueCommentsAsync } from './comments.js';
import type {
  GithubSyncResult,
  GithubSyncTiming,
  GithubProgress,
} from './types.js';

export async function upsertIssuesFromWorkItems(
  items: WorkItem[],
  comments: Comment[],
  config: GithubConfig,
  onProgress?: (progress: GithubProgress) => void,
  onVerboseLog?: (message: string) => void,
  // Optional callback to persist comment mapping changes (githubCommentId/UpdatedAt)
  persistComment?: (comment: Comment) => void
): Promise<{ updatedItems: WorkItem[]; result: GithubSyncResult; timing: GithubSyncTiming }> {
  const startTime = Date.now();
  // Instrumentation hooks for callers that enable verbose logging — record
  // coarse-grained timings at start so the TUI can surface progress and
  // detect long-running sync operations that block the main thread.
  try {
    (upsertIssuesFromWorkItems as any).__lastStartTime = startTime;
  } catch (_) {}
  const beforeMetrics = snapshot();
  const labelPrefix = normalizeGithubLabelPrefix(config.labelPrefix);
  // Note: deleted items without githubIssueNumber are excluded by the
  // pre-filter (filterItemsForPush) before items reach this function.
  // A defensive guard inside upsertMapper() also skips deleted items
  // without githubIssueNumber in case items arrive unfiltered (e.g. --all).
  const linkedPairs = new Set<string>();
  let linkedCount = 0;
  const nodeIdCache = new Map<number, string>();
  const timing = {
    totalMs: 0,
    upsertMs: 0,
    commentListMs: 0,
    commentUpsertMs: 0,
    hierarchyCheckMs: 0,
    hierarchyLinkMs: 0,
    hierarchyVerifyMs: 0,
  };
  const byItemId = new Map<string, Comment[]>();
  for (const comment of comments) {
    const list = byItemId.get(comment.workItemId) || [];
    list.push(comment);
    byItemId.set(comment.workItemId, list);
  }

  // Progress: one shared emitter bound to this flow's per-phase stats. The
  // factory owns the rate/ETA arithmetic and the throttler snapshot
  // (WL-0MW0JF6TH00749I2).
  const emitProgress = createProgressEmitter(() => {
    const t = throttler as any;
    return typeof throttler !== 'undefined' && t.getStats ? t.getStats() : undefined;
  });

  const updatedItems: WorkItem[] = [...items];
  const result: GithubSyncResult = { updated: 0, created: 0, closed: 0, skipped: 0, errors: [], syncedItems: [], errorItems: [] };
  const updatedById = new Map<string, WorkItem>();
  let completed = 0;
  let skippedUpdates = 0;

  // Comment body rendering and the GitHub comment upsert moved to
  // `./github-sync/comments.js` (WL-0MW0JF8R6006HUA6); the push flow below
  // still orchestrates which issues are listed and when comments are synced.
  // Note: the old synchronous comment-upsert helper is gone — use the async
  // helper, which schedules its API calls through the central throttler, to
  // avoid bypassing throttler/concurrency limits.


  // Concurrency: upsert issues and comments with a bounded concurrency pool
  // The central throttler enforces concurrency/rate limits. Do not rely on
  // a local worker pool here; schedule GitHub API calls through `throttler`.
  // Keep the env var available to the throttler implementation.
  // (local upsertConcurrency removed)

  async function upsertMapper(item: WorkItem, idx: number) {
    try {
      // Guard: skip deleted items that have no GitHub issue (prevent accidental creation)
      if (item.status === 'deleted' && !item.githubIssueNumber) {
        if (onVerboseLog) {
          onVerboseLog(`[upsert] skip deleted item ${item.id} (no githubIssueNumber)`);
        }
        skippedUpdates += 1;
        return;
      }
      const itemComments = byItemId.get(item.id) || [];
      const shouldSyncComments = commentNeedsSync(item, itemComments);
      increment('items.processed');
      if (
        item.githubIssueNumber &&
        item.githubIssueUpdatedAt &&
        new Date(item.updatedAt).getTime() <= new Date(item.githubIssueUpdatedAt).getTime() &&
        !shouldSyncComments
      ) {
        if (onVerboseLog) {
          onVerboseLog(`[upsert] skip ${item.id} (no issue or comment changes)`);
        }
        skippedUpdates += 1;
        return;
      }
      const payload = workItemToIssuePayload(item, itemComments, labelPrefix, items);

      let issue: GithubIssueRecord | null = null;
      let issueNumber = item.githubIssueNumber;
      let issueUpdatedAt = item.githubIssueUpdatedAt || null;
      const shouldUpdateIssue = !item.githubIssueNumber
        || !item.githubIssueUpdatedAt
        || new Date(item.updatedAt).getTime() > new Date(item.githubIssueUpdatedAt).getTime();
      if (shouldUpdateIssue) {
        const upsertStart = Date.now();
        if (onVerboseLog) {
          onVerboseLog(`[upsert] ${item.githubIssueNumber ? 'update' : 'create'} ${item.id}`);
        }
        if (item.githubIssueNumber) {
          increment('api.issue.update');
          // updateGithubIssueAsync already schedules via the central throttler
          // internally (see src/github.ts). Avoid double-scheduling here.
          issue = await updateGithubIssueAsync(config, item.githubIssueNumber!, payload);
          if (item.status === 'deleted') {
            result.closed += 1;
            result.syncedItems.push({
              action: 'closed',
              id: item.id,
              title: truncateTitle(item.title),
              issueNumber: item.githubIssueNumber,
            });
          } else {
            result.updated += 1;
            result.syncedItems.push({
              action: 'updated',
              id: item.id,
              title: truncateTitle(item.title),
              issueNumber: item.githubIssueNumber,
            });
          }
        } else {
          increment('api.issue.create');
          // createGithubIssueAsync schedules via the central throttler itself.
          issue = await createGithubIssueAsync(config, {
            title: payload.title,
            body: payload.body,
            labels: payload.labels,
          });
          result.created += 1;
          result.syncedItems.push({
            action: 'created',
            id: item.id,
            title: truncateTitle(item.title),
            issueNumber: issue.number,
          });
        }
        timing.upsertMs += Date.now() - upsertStart;
        // Yield to the event loop occasionally when processing many items so
        // a busy sync doesn't completely starve the TUI. This is a best-effort
        // yield that keeps the implementation compatible with tests that run
        // the sync inline.
        if (idx % 10 === 0) {
          await new Promise((res) => setImmediate(res));
        }
        if (onVerboseLog) {
          onVerboseLog(`[upsert] ${item.id} completed in ${Date.now() - upsertStart}ms`);
        }
        issueNumber = issue.number;
        issueUpdatedAt = issue.updatedAt;
      } else if (onVerboseLog) {
        onVerboseLog(`[upsert] issue unchanged for ${item.id}`);
      }

      const shouldSyncCommentsNow = itemComments.length > 0 && (shouldSyncComments || shouldUpdateIssue);
      if (shouldSyncCommentsNow && issueNumber) {
        const commentListStart = Date.now();
        increment('api.comment.list');
        // listGithubIssueCommentsAsync now schedules internally via the throttler
        // (see src/github.ts). Call it directly to avoid double-scheduling.
        const existingComments = await listGithubIssueCommentsAsync(config, issueNumber!);
        timing.commentListMs += Date.now() - commentListStart;
        const commentUpsertStart = Date.now();
        const commentSummary = await upsertGithubIssueCommentsAsync(
          config,
          issueNumber,
          itemComments,
          existingComments,
          persistComment,
          onVerboseLog
        );
        timing.commentUpsertMs += Date.now() - commentUpsertStart;
        // small yield after comment work
        if (idx % 5 === 0) await new Promise((res) => setImmediate(res));
        increment('api.comment.create', commentSummary.created || 0);
        increment('api.comment.update', commentSummary.updated || 0);
        result.commentsCreated = (result.commentsCreated || 0) + commentSummary.created;
        result.commentsUpdated = (result.commentsUpdated || 0) + commentSummary.updated;
        issueUpdatedAt = maxIsoTimestamp(issueUpdatedAt, commentSummary.latestUpdatedAt);
      } else if (onVerboseLog && itemComments.length > 0) {
        onVerboseLog(`[upsert] comments unchanged for ${item.id}`);
      }

      updatedById.set(item.id, {
        ...item,
        githubIssueNumber: issueNumber ?? item.githubIssueNumber,
        githubIssueId: issue?.id ?? item.githubIssueId,
        githubIssueUpdatedAt: issueUpdatedAt ?? item.githubIssueUpdatedAt,
      });
    } catch (error) {
      result.errors.push(`${item.id}: ${(error as Error).message}`);
      result.errorItems.push({
        id: item.id,
        title: truncateTitle(item.title),
        error: (error as Error).message,
      });
      updatedById.set(item.id, item);
    } finally {
      completed += 1;
      if (onProgress) {
        emitProgress(onProgress, 'push', completed, items.length);
      }
    }
  }

  // Launch upsert mappers without a local worker pool; schedule external
  // GitHub API calls through the central throttler. The throttler enforces
  // WL_GITHUB_CONCURRENCY and rate limits configured in src/github-throttler.ts.
  // Run mapper tasks concurrently but await in a way that preserves the
  // ability to yield back to the event loop during batches. Using
  // Promise.all on an array of async functions is fine because the mapper
  // already yields periodically; keep behavior unchanged but surface a
  // lastStartTime/lastEndTime pair for diagnostic consumption.
  await Promise.all(items.map((it, idx) => upsertMapper(it, idx)));

  try { (upsertIssuesFromWorkItems as any).__lastEndTime = Date.now(); } catch (_) {}

  result.skipped = skippedUpdates;

  for (let idx = 0; idx < updatedItems.length; idx += 1) {
    const item = updatedItems[idx];
    const updated = updatedById.get(item.id);
    if (updated) {
      updatedItems[idx] = updated;
    }
  }

  const issueById = new Map(updatedItems.map(item => [item.id, item]));
  for (const item of updatedItems) {
    if (item.status === 'deleted' || !item.parentId) {
      continue;
    }
    const parent = issueById.get(item.parentId);
    if (!parent || parent.status === 'deleted') {
      continue;
    }
    if (parent.githubIssueNumber && item.githubIssueNumber) {
      if (parent.githubIssueNumber === item.githubIssueNumber) {
        if (onVerboseLog) onVerboseLog(`[hierarchy] skipping self-link: item ${item.id} and parent ${parent.id} both map to GitHub issue #${item.githubIssueNumber}`);
      } else {
        linkedPairs.add(`${parent.githubIssueNumber}:${item.githubIssueNumber}`);
      }
    }
  }

  const pairs = Array.from(linkedPairs.values());
  if (onVerboseLog) {
    onVerboseLog(`[hierarchy] ${pairs.length} parent-child pair(s) to verify`);
  }

  // Concurrency is enforced by the central throttler (WL_GITHUB_CONCURRENCY).
  // Do not use a separate local concurrency default here to avoid surprising
  // behaviour when the env var is unset.

  const hierarchyCache = new Map<number, { parentIssueNumber: number | null; childIssueNumbers: number[] }>();

  async function mapper(pair: string, idx: number) {
    if (onProgress) {
      emitProgress(onProgress, 'hierarchy', idx + 1, pairs.length || 1);
    }
    const [parentNumberRaw, childNumberRaw] = pair.split(':');
    const parentNumber = Number(parentNumberRaw);
    const childNumber = Number(childNumberRaw);
      try {
        if (onVerboseLog) {
          onVerboseLog(`[hierarchy] ${idx + 1}/${pairs.length} checking ${parentNumber} -> ${childNumber}`);
        }

        // Fetch hierarchy for the parent once and cache it. This reduces GraphQL calls
        // so checks scale by number of parents, not parent-child pairs.
        let hierarchy = hierarchyCache.get(parentNumber);
        if (!hierarchy) {
          const checkStart = Date.now();
          increment('api.hierarchy.fetch');
          hierarchy = await getIssueHierarchyAsync(config, parentNumber);
          timing.hierarchyCheckMs += Date.now() - checkStart;
          hierarchyCache.set(parentNumber, hierarchy);
          if (onVerboseLog) {
            onVerboseLog(`[hierarchy] fetched ${parentNumber} in ${Date.now() - checkStart}ms (children: ${hierarchy.childIssueNumbers.length})`);
          }
        }

        if (hierarchy.childIssueNumbers.includes(childNumber)) {
          linkedCount += 1;
          if (onVerboseLog) onVerboseLog(`[hierarchy] already linked ${parentNumber} -> ${childNumber}`);
          return;
        }

        const linkStart = Date.now();
        increment('api.hierarchy.link');
        const linkResult = typeof (addSubIssueLinkResultAsync) === 'function'
          ? await addSubIssueLinkResultAsync(config, parentNumber, childNumber, nodeIdCache)
          : addSubIssueLinkResult(config, parentNumber, childNumber, nodeIdCache);
        timing.hierarchyLinkMs += Date.now() - linkStart;
        if (onVerboseLog) onVerboseLog(`[hierarchy] link ${parentNumber} -> ${childNumber} ${linkResult.ok ? 'ok' : 'failed'} in ${Date.now() - linkStart}ms`);

        if (!linkResult.ok) {
          result.errors.push(`link ${parentNumber}->${childNumber}: ${linkResult.error || 'sub-issue link not created'}`);
          return;
        }

        // Link mutation reported success — update cached hierarchy instead of
        // re-fetching from GitHub. Treat this as verification to avoid redundant requests.
        const cached = hierarchyCache.get(parentNumber);
        if (cached) {
          if (!cached.childIssueNumbers.includes(childNumber)) cached.childIssueNumbers.push(childNumber);
        } else {
          // In rare case cache was evicted between fetch and link, add a minimal entry.
          hierarchyCache.set(parentNumber, { parentIssueNumber: null, childIssueNumbers: [childNumber] });
        }

        linkedCount += 1;
        if (onVerboseLog) onVerboseLog(`[hierarchy] verified ${parentNumber} -> ${childNumber} (cached)`);
        return;
      } catch (error) {
        result.errors.push(`link ${parentNumber}->${childNumber}: ${(error as Error).message}`);
      }
    }

  // Process hierarchy pairs concurrently and let the throttler limit GitHub
  // requests. Avoid a local worker pool — schedule linking/fetch calls via
  // the central throttler inside `mapper`.
  await Promise.all(pairs.map((p, idx) => mapper(p, idx)));

  result.updated += linkedCount;
  timing.totalMs = Date.now() - startTime;
  const afterMetrics = snapshot();
  const metricDiff = diff(beforeMetrics, afterMetrics);
  // Attach some metric deltas to timing via a custom field by exposing
  // additional properties on timing so callers (CLI) can log them.
  (timing as any).__metrics = metricDiff;
  return { updatedItems, result, timing };
}
