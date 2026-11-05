import { WorkItem, Comment, WorkItemRiskLevel, WorkItemEffortLevel } from './types.js';
import { theme } from './theme.js';
import {
  GithubConfig,
  GithubIssueRecord,
  GithubIssueComment,
  stripWorklogMarkers,
  extractWorklogId,
  extractWorklogCommentId,
  extractParentId,
  extractParentIssueNumber,
  extractChildIds,
  extractChildIssueNumbers,
  getIssueHierarchyAsync,
  addSubIssueLinkResult,
  addSubIssueLinkResultAsync,
  buildWorklogCommentMarker,
  workItemToIssuePayload,
  createGithubIssueAsync,
  updateGithubIssueAsync,
  getGithubIssueAsync,
  listGithubIssuesAsync,
  listGithubIssueCommentsAsync,
  createGithubIssueComment,
  createGithubIssueCommentAsync,
  updateGithubIssueComment,
  updateGithubIssueCommentAsync,
  normalizeGithubLabelPrefix,
  issueToWorkItemFields,
  LabelEventCache,
  fetchLabelEventsAsync,
  labelFieldsDiffer,
} from './github.js';
import throttler from './github-throttler.js';
import { increment, snapshot, diff } from './github-metrics.js';
import { mergeWorkItems } from './sync.js';
import { createProgressEmitter } from './github-sync/progress.js';
import { LABEL_FIELD_CATEGORIES, resolveAllLabelFields } from './github-sync/labels.js';
import type { FieldChange } from './github-sync/labels.js';
import {
  commentNeedsSync,
  maxIsoTimestamp,
  sortCommentsByCreatedAt,
  stableItemKeyForImport,
  truncateTitle,
} from './github-sync/util.js';

// The result/timing/progress type declarations moved to `./github-sync/types.js`
// (WL-0MW0JF5YE008LV1R) and the label-resolution declarations to
// `./github-sync/labels.js` (WL-0MW0JF7QN007E1JU); re-exporting them here keeps
// all of them importable from `'./github-sync.js'` unchanged. The local
// `import type` below supplies the names the flow functions still declared in
// this module use.
export type {
  SyncedItem,
  SyncErrorItem,
  GithubSyncResult,
  GithubSyncTiming,
  GithubProgress,
} from './github-sync/types.js';
export type { FieldChange } from './github-sync/labels.js';

import type {
  GithubSyncResult,
  GithubSyncTiming,
  GithubProgress,
} from './github-sync/types.js';

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

  const buildGithubCommentBody = (comment: Comment) => {
    const marker = buildWorklogCommentMarker(comment.id);
    const authorLabel = comment.author ? `**${comment.author}**` : '**worklog**';
    const body = stripWorklogMarkers(comment.comment);
    return `${marker}\n\n${authorLabel}\n\n${body}`.trim();
  };

    // Synchronous comment upsert helper removed. Use async helpers
    // `upsertGithubIssueCommentsAsync` (defined below) which schedule API calls
    // through the central throttler. The old synchronous helper used direct
    // sync GH API helpers and could bypass throttler/concurrency limits.
    // If synchronous behavior is required, wrap the async helper at the callsite.


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
        const commentSummary = await upsertGithubIssueCommentsAsync(config, issueNumber, itemComments, existingComments);
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

  // Helper async versions of comment upsert and list used by the mapper
  async function upsertGithubIssueCommentsAsync(
    issueConfig: GithubConfig,
    issueNumber: number,
    itemComments: Comment[],
    existingComments: GithubIssueComment[]
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
            try { persistComment(comment); } catch (err) { if (onVerboseLog) onVerboseLog && onVerboseLog(`[persist] failed to save comment mapping for ${comment.id}: ${(err as Error).message}`); }
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
        try { persistComment(comment); } catch (err) { if (onVerboseLog) onVerboseLog && onVerboseLog(`[persist] failed to save comment mapping for ${comment.id}: ${(err as Error).message}`); }
      }
      created += 1;
      latestUpdatedAt = maxIsoTimestamp(latestUpdatedAt, createdComment.updatedAt);
    }

    return { created, updated, latestUpdatedAt };
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

// Label-derived field resolution moved to `./github-sync/labels.js`
// (WL-0MW0JF7QN007E1JU). Re-exported here so the public functions stay
// importable from `'./github-sync.js'` unchanged; `LABEL_FIELD_CATEGORIES` is
// family-internal (the import flow iterates it) and is imported, not
// re-exported, at the top of this module.
export { resolveLabelField, resolveAllLabelFields } from './github-sync/labels.js';

export async function importIssuesToWorkItems(
  items: WorkItem[],
  config: GithubConfig,
  options?: { since?: string; createNew?: boolean; generateId?: () => string; generateCommentId?: () => string; onProgress?: (progress: GithubProgress) => void; skipCloseCheck?: boolean }
): Promise<{
  updatedItems: WorkItem[];
  createdItems: WorkItem[];
  issues: GithubIssueRecord[];
  updatedIds: Set<string>;
  mergedItems: WorkItem[];
  conflictDetails: { conflicts: string[]; conflictDetails: import('./types.js').ConflictDetail[] };
  markersFound: number;
  fieldChanges: FieldChange[];
  importedComments: Comment[];
}> {
  const since = options?.since;
  const createNew = options?.createNew === true;
  const generateId = options?.generateId;
  const generateCommentId = options?.generateCommentId;
  const onProgress = options?.onProgress;
  // Progress: one shared emitter bound to this flow's per-phase stats
  // (WL-0MW0JF6TH00749I2).
  const emitProgressImport = createProgressEmitter(() => {
    const t = throttler as any;
    return typeof throttler !== 'undefined' && t.getStats ? t.getStats() : undefined;
  });
  const skipCloseCheck = options?.skipCloseCheck ?? Boolean(since);
  if (onProgress) {
    emitProgressImport(onProgress, 'import', 0, 1, 'fetching issues');
  }
  const issues = await listGithubIssuesAsync(config, since);
  const byId = new Map(items.map(item => [item.id, item]));
  const byIssueNumber = new Map<number, WorkItem>();
  for (const item of items) {
    if (item.githubIssueNumber) {
      byIssueNumber.set(item.githubIssueNumber, item);
    }
  }

  const hierarchyByIssueNumber = new Map<number, { parentIssueNumber: number | null; childIssueNumbers: number[] }>();
  const parentIssueNumbers = issues
    .filter(issue => (issue.subIssuesSummary?.total ?? 0) > 0)
    .map(issue => issue.number);
  const parentByChildIssueNumber = new Map<number, number>();
  let hierarchyChecked = 0;
  for (const issueNumber of parentIssueNumbers) {
    if (onProgress) {
      emitProgressImport(onProgress, 'hierarchy', hierarchyChecked + 1, parentIssueNumbers.length || 1);
    }
    hierarchyChecked += 1;
    try {
      const hierarchy = await getIssueHierarchyAsync(config, issueNumber);
      hierarchyByIssueNumber.set(issueNumber, hierarchy);
      for (const childNumber of hierarchy.childIssueNumbers) {
        parentByChildIssueNumber.set(childNumber, issueNumber);
      }
    } catch {
      continue;
    }
  }

  const remoteItemsById = new Map<string, WorkItem>();
  const issueMetaById = new Map<string, { number: number; id: number; updatedAt: string }>();
  const parentHints = new Map<string, string>();
  const childHints = new Map<string, string[]>();
  const parentIssueHints = new Map<string, number>();
  const childIssueHints = new Map<string, number[]>();
  const seenIssueNumbers = new Set<number>();
  let markersFound = 0;
  const allFieldChanges: FieldChange[] = [];
  const labelEventCache = new LabelEventCache();

  // Track which issues need event-based resolution (issue number -> local item + label fields)
  const pendingResolutions: Array<{
    issueNumber: number;
    itemId: string;
    localItem: WorkItem;
    labelFields: { status: string; priority: string; stage: string; issueType: string; risk: string; effort: string };
    issueUpdatedAt: string;
  }> = [];

  // Track the authoritative GitHub issue state (open/closed) per work item ID.
  // GitHub issue state is NOT a label-derived field — it is authoritative and
  // must survive the timestamp-based mergeWorkItems resolution. This map is
  // populated during Phase 1 and Phase 2, then used after merge to enforce
  // the correct status regardless of which side "won" the timestamp comparison.
  const issueClosedById = new Map<string, boolean>();

  const shouldReplaceRemote = (existingUpdatedAt: string | null | undefined, nextUpdatedAt: string): boolean => {
    if (!existingUpdatedAt) {
      return true;
    }
    const existingTime = new Date(existingUpdatedAt).getTime();
    const nextTime = new Date(nextUpdatedAt).getTime();
    if (Number.isNaN(existingTime) && Number.isNaN(nextTime)) {
      return true;
    }
    if (Number.isNaN(existingTime)) {
      return true;
    }
    if (Number.isNaN(nextTime)) {
      return false;
    }
    return nextTime >= existingTime;
  };

  let processed = 0;
  for (const issue of issues) {
    if (onProgress) {
      emitProgressImport(onProgress, 'import', processed + 1, issues.length);
    }
    const markerId = extractWorklogId(issue.body);
    if (markerId) {
      markersFound += 1;
    }
    const parentId = extractParentId(issue.body);
    const childIds = extractChildIds(issue.body);
    const existingByMarker = markerId ? byId.get(markerId) : undefined;
    const existing = existingByMarker || byIssueNumber.get(issue.number);
    const updatedAt = issue.updatedAt;
    const labelFields = issueToWorkItemFields(issue, config.labelPrefix);
    const isClosed = issue.state === 'closed';

    if (!existing && isClosed) {
      processed += 1;
      continue;
    }

    if (!existing && !markerId && !createNew) {
      processed += 1;
      continue;
    }

    if (!existing && !markerId && createNew && !generateId) {
      processed += 1;
      continue;
    }

    const newId = existing?.id || markerId || generateId!();
    const base: WorkItem = existing
      ? { ...existing }
      : {
          id: newId,
          title: 'Untitled',
          description: '',
          status: 'open',
          priority: 'medium',
          sortIndex: 0,
          parentId: null,
          createdAt: updatedAt,
          updatedAt: updatedAt,
          tags: [],
          assignee: '',
          stage: '',
          issueType: '',
          createdBy: '',
          deletedBy: '',
          deleteReason: '',
          risk: '',
          effort: '',
        };

    const tags = labelFields.tags.length > 0
      ? Array.from(new Set([...(base.tags || []), ...labelFields.tags]))
      : base.tags;

    const remoteItem: WorkItem = {
      ...base,
      title: issue.title || base.title,
      description: issue.body ? stripWorklogMarkers(issue.body) : base.description,
      status: isClosed ? 'completed' : (labelFields.status || base.status),
      priority: labelFields.priority || base.priority,
      tags,
      risk: (labelFields.risk || base.risk) as WorkItemRiskLevel | '',
      effort: (labelFields.effort || base.effort) as WorkItemEffortLevel | '',
      stage: labelFields.stage || base.stage,
      issueType: labelFields.issueType || base.issueType,
      updatedAt: updatedAt,
    };

    const hierarchy = hierarchyByIssueNumber.get(issue.number);
    const parentIssueNumber = parentByChildIssueNumber.get(issue.number)
      ?? hierarchy?.parentIssueNumber
      ?? extractParentIssueNumber(issue.body);
    const childIssueNumbers = hierarchy?.childIssueNumbers ?? extractChildIssueNumbers(issue.body);

    const existingMeta = issueMetaById.get(remoteItem.id);
    const shouldReplace = existingMeta
      ? shouldReplaceRemote(existingMeta.updatedAt, issue.updatedAt)
      : true;
    if (existingMeta) {
      const removedIssueNumber = shouldReplace ? existingMeta.number : issue.number;
      const removedIssueUrl = `https://github.com/${config.repo}/issues/${removedIssueNumber}`;
       console.error(
         theme.text.error(
           `Duplicate Worklog marker detected for ${remoteItem.id}. `
           + `Duplicates should not occur. Ignoring ${removedIssueUrl} during sync. `
           + 'Remove the duplicate from GitHub after confirming it has no additional content of value.'
         )
       );
      if (!shouldReplace) {
        seenIssueNumbers.add(issue.number);
        processed += 1;
        continue;
      }
    }
    if (shouldReplace) {
      remoteItemsById.set(remoteItem.id, remoteItem);
      issueClosedById.set(remoteItem.id, isClosed);
      issueMetaById.set(remoteItem.id, {
        number: issue.number,
        id: issue.id,
        updatedAt: issue.updatedAt,
      });
      if (parentId) {
        parentHints.set(remoteItem.id, parentId);
      } else {
        parentHints.delete(remoteItem.id);
      }
      if (childIds.length > 0) {
        childHints.set(remoteItem.id, childIds);
      } else {
        childHints.delete(remoteItem.id);
      }
      if (parentIssueNumber) {
        parentIssueHints.set(remoteItem.id, parentIssueNumber);
      } else {
        parentIssueHints.delete(remoteItem.id);
      }
      if (childIssueNumbers.length > 0) {
        childIssueHints.set(remoteItem.id, childIssueNumbers);
      } else {
        childIssueHints.delete(remoteItem.id);
      }

      // Queue event-based resolution for items where label fields differ from local
      if (existing && labelFieldsDiffer(labelFields, existing)) {
        pendingResolutions.push({
          issueNumber: issue.number,
          itemId: remoteItem.id,
          localItem: existing,
          labelFields,
          issueUpdatedAt: issue.updatedAt,
        });
      }
    }
    seenIssueNumbers.add(issue.number);
    processed += 1;
  }

  if (!skipCloseCheck) {
    let checked = 0;
    for (const item of items) {
      if (!item.githubIssueNumber) {
        checked += 1;
        continue;
      }
      if (seenIssueNumbers.has(item.githubIssueNumber)) {
        checked += 1;
        continue;
      }
      if (onProgress) {
        emitProgressImport(onProgress, 'close-check', checked + 1, items.length);
      }
      try {
      const issue = await getGithubIssueAsync(config, item.githubIssueNumber);
      const hierarchy = hierarchyByIssueNumber.get(issue.number);
      const parentIssueNumber = parentByChildIssueNumber.get(issue.number)
        ?? hierarchy?.parentIssueNumber
        ?? extractParentIssueNumber(issue.body);
      const childIssueNumbers = hierarchy?.childIssueNumbers ?? extractChildIssueNumbers(issue.body);
        const parentId = extractParentId(issue.body);
        const childIds = extractChildIds(issue.body);
        const isClosed = issue.state === 'closed';

        // Skip open issues where the local item is also not completed (no state change)
        if (!isClosed && item.status !== 'completed') {
          checked += 1;
          continue;
        }

        const existingUpdatedAt = item.githubIssueUpdatedAt ? new Date(item.githubIssueUpdatedAt).getTime() : null;
        const issueUpdatedAt = new Date(issue.updatedAt).getTime();
        // Skip when the issue hasn't changed and the local status already matches
        // the expected state (completed for closed issues, non-completed for open)
        if (existingUpdatedAt !== null && existingUpdatedAt >= issueUpdatedAt) {
          if (isClosed && item.status === 'completed') {
            checked += 1;
            continue;
          }
          if (!isClosed && item.status !== 'completed') {
            checked += 1;
            continue;
          }
        }

        const labelFields = issueToWorkItemFields(issue, config.labelPrefix);
        const tags = labelFields.tags.length > 0
          ? Array.from(new Set([...item.tags, ...labelFields.tags]))
          : item.tags;
          remoteItemsById.set(item.id, {
            ...item,
            title: issue.title || item.title,
            description: issue.body ? stripWorklogMarkers(issue.body) : item.description,
            status: isClosed ? 'completed' : (labelFields.status || item.status),
            priority: labelFields.priority || item.priority,
            tags,
            risk: (labelFields.risk || item.risk) as WorkItemRiskLevel | '',
            effort: (labelFields.effort || item.effort) as WorkItemEffortLevel | '',
            stage: labelFields.stage || item.stage,
            issueType: labelFields.issueType || item.issueType,
            updatedAt: issue.updatedAt,
          });
        issueClosedById.set(item.id, isClosed);
        if (parentId) {
          parentHints.set(item.id, parentId);
        }
        if (childIds.length > 0) {
          childHints.set(item.id, childIds);
        }
        if (parentIssueNumber) {
          parentIssueHints.set(item.id, parentIssueNumber);
        }
        if (childIssueNumbers.length > 0) {
          childIssueHints.set(item.id, childIssueNumbers);
        }
        issueMetaById.set(item.id, {
          number: issue.number,
          id: issue.id,
          updatedAt: issue.updatedAt,
        });

        // Queue event-based resolution for close-check items where label fields differ
        if (labelFieldsDiffer(labelFields, item)) {
          pendingResolutions.push({
            issueNumber: issue.number,
            itemId: item.id,
            localItem: item,
            labelFields,
            issueUpdatedAt: issue.updatedAt,
          });
        }

        checked += 1;
      } catch {
        checked += 1;
        continue;
      }
    }
  }

  // Resolve label conflicts using event timelines for items where fields differ
  for (const pending of pendingResolutions) {
    const events = await fetchLabelEventsAsync(config, pending.issueNumber, labelEventCache);
    const { resolvedFields, fieldChanges } = resolveAllLabelFields(
      pending.localItem,
      pending.labelFields,
      events,
      config.labelPrefix,
      pending.issueUpdatedAt
    );

    // Apply resolved values to the remote item already stored in remoteItemsById
    const remoteItem = remoteItemsById.get(pending.itemId);
    if (remoteItem) {
      // Apply all resolved fields — this reverts fields to local values where
      // local is newer, and keeps remote values where remote is newer
      for (const { field, category } of LABEL_FIELD_CATEGORIES) {
        if (resolvedFields[field] !== undefined) {
          (remoteItem as any)[field] = resolvedFields[field];
        }
      }
      allFieldChanges.push(...fieldChanges);
    }
  }

  const remoteItems = Array.from(remoteItemsById.values());
  const mergeResult = mergeWorkItems(items, remoteItems, {
    defaultValueFields: ['status'],
    sameTimestampStrategy: 'local',
  });
  const mergedItems = mergeResult.merged.map(item => {
    const meta = issueMetaById.get(item.id);
    const parentId = parentHints.get(item.id) ?? null;
    if (!meta) {
      return parentId ? { ...item, parentId } : item;
    }
    return {
      ...item,
      parentId: parentId ?? item.parentId,
      githubIssueNumber: meta.number,
      githubIssueId: meta.id,
      githubIssueUpdatedAt: meta.updatedAt,
    };
  });

  // Re-apply label event resolutions that may have been overridden by mergeWorkItems.
  // Label event timestamps provide per-field precision that the item-level updatedAt
  // comparison in mergeWorkItems cannot capture. When a label event is newer than the
  // local updatedAt for a specific field, that resolution must take precedence even if
  // the overall item-level merge preferred local values.
  if (allFieldChanges.length > 0) {
    const mergedById = new Map(mergedItems.map(item => [item.id, item]));
    for (const change of allFieldChanges) {
      const item = mergedById.get(change.workItemId);
      if (item) {
        (item as any)[change.field] = change.newValue;
      }
    }
  }

  // Enforce authoritative GitHub issue state (open/closed) on the merged items.
  // Unlike label-derived fields (priority, stage, etc.) which are subject to
  // event-timestamp resolution, the issue state (open vs closed) is an
  // authoritative signal from GitHub that must always propagate regardless of
  // which side "won" the timestamp-based merge. Without this, a reopened issue
  // whose local updatedAt is newer than the issue updatedAt would remain
  // 'completed' after merge because mergeWorkItems prefers the newer local value.
  if (issueClosedById.size > 0) {
    const mergedById = new Map(mergedItems.map(item => [item.id, item]));
    for (const [itemId, isClosed] of issueClosedById.entries()) {
      const item = mergedById.get(itemId);
      if (!item) {
        continue;
      }
      const expectedStatus = isClosed ? 'completed' : 'open';
      if (isClosed && item.status !== 'completed') {
        item.status = 'completed';
      } else if (!isClosed && item.status === 'completed') {
        item.status = expectedStatus;
      }
    }
  }

  if (childHints.size > 0) {
    const itemsById = new Map(mergedItems.map(item => [item.id, item]));
    for (const [parentId, childIds] of childHints.entries()) {
      for (const childId of childIds) {
        const child = itemsById.get(childId);
        if (!child) {
          continue;
        }
        child.parentId = parentId;
      }
    }
  }

  if (parentIssueHints.size > 0) {
    const itemsByIssue = new Map<number, WorkItem>();
    for (const item of mergedItems) {
      if (item.githubIssueNumber) {
        itemsByIssue.set(item.githubIssueNumber, item);
      }
    }
    for (const [childId, parentIssueNumber] of parentIssueHints.entries()) {
      const child = mergedItems.find(item => item.id === childId);
      const parent = itemsByIssue.get(parentIssueNumber);
      if (!child || !parent) {
        continue;
      }
      child.parentId = parent.id;
    }
  }

  if (childIssueHints.size > 0) {
    const itemsByIssue = new Map<number, WorkItem>();
    for (const item of mergedItems) {
      if (item.githubIssueNumber) {
        itemsByIssue.set(item.githubIssueNumber, item);
      }
    }
    for (const [parentId, issueNumbers] of childIssueHints.entries()) {
      for (const issueNumber of issueNumbers) {
        const child = itemsByIssue.get(issueNumber);
        if (!child) {
          continue;
        }
        child.parentId = parentId;
      }
    }
  }

  const localById = new Map(items.map(item => [item.id, item]));
  const updatedItems: WorkItem[] = [];
  const createdItems: WorkItem[] = [];
  const updatedIds = new Set<string>();

  for (const item of mergedItems) {
    const local = localById.get(item.id);
    if (!local) {
      createdItems.push(item);
      continue;
    }
    if (stableItemKeyForImport(local) !== stableItemKeyForImport(item)) {
      updatedItems.push(item);
      updatedIds.add(item.id);
    }
  }

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
    const issueMeta = issueMetaById.get(workItemId);
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

  const commentIssueNumbers = [...seenIssueNumbers].filter(shouldFetchCommentsForIssue);
  const commentIssueTotal = commentIssueNumbers.length;
  let commentIssueIndex = 0;
  for (const issueNumber of commentIssueNumbers) {
    commentIssueIndex++;
    emitProgressImport(onProgress, 'comments', commentIssueIndex, commentIssueTotal || 1);
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

  return {
    updatedItems,
    createdItems,
    issues,
    updatedIds,
    mergedItems,
    conflictDetails: {
      conflicts: mergeResult.conflicts,
      conflictDetails: mergeResult.conflictDetails,
    },
    markersFound,
    fieldChanges: allFieldChanges,
    importedComments,
  };
}
