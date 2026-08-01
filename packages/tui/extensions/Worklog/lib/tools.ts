/**
 * lib/tools.ts — Work item tool functions
 *
 * CLI integration, JSON parsing, and list creation helpers extracted from the
 * monolithic index.ts. This module handles all wl/worklog CLI invocations
 * and response parsing.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { currentSettings } from './settings.js';
import { selectWorkItems } from './smart-selection.js';

// Promisify lazily inside the call site rather than at module scope.
// ESM named imports are live bindings, but `promisify(execFile)` snapshots
// the function reference at module-load time; tests that mock
// `node:child_process` (e.g. runWl-init-detection.test.ts) would otherwise
// keep seeing the pre-mock binding. Resolving per-call keeps the mock
// observable.

/**
 * Lazily load getWorklogDb so that tests can mock wl-integration.js
 * without being affected by this module's import side effects.
 */
async function getDb(): Promise<any | null> {
  try {
    const { getWorklogDb } = await import('../wl-integration.js');
    return getWorklogDb();
  } catch {
    return null;
  }
}

// ── Types ─────────────────────────────────────────────────────────────

export type RunWlFn = (args: string[], includeJson?: boolean) => Promise<string>;

// ── JSON parsing ──────────────────────────────────────────────────────

export function extractJsonObject(raw: string): unknown {
  const start = raw.indexOf('{');
  if (start < 0) throw new Error('No JSON object in output');

  // Try to parse the full output - it may be valid JSON already
  const trimmed = raw.trim();
  const lastOpenQuote = trimmed.lastIndexOf('"');
  const lastCloseBrace = trimmed.lastIndexOf('}');

  // If it looks like complete JSON, try to parse it
  if (lastCloseBrace > lastOpenQuote) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Fall through to manual extraction
    }
  }

  // Manual extraction: count braces while respecting string boundaries
  let depth = 0;
  let inString = false;
  for (let i = start; i < raw.length; i += 1) {
    const c = raw[i];
    if (c === '"') {
      // Count preceding backslashes to check if quote is escaped
      let backslashes = 0;
      for (let j = i - 1; j >= start && raw[j] === '\\'; j--) {
        backslashes++;
      }
      if (backslashes % 2 === 0) {
        inString = !inString;
      }
    }
    if (!inString) {
      if (c === '{') depth += 1;
      if (c === '}') depth -= 1;
      if (depth === 0) {
        return JSON.parse(raw.slice(start, i + 1));
      }
    }
  }

  throw new Error('Unterminated JSON object in output');
}

// ── Payload normalization ─────────────────────────────────────────────

export interface WorklogBrowseItem {
  id: string;
  title: string;
  status: string;
  priority?: string;
  stage?: string;
  /** Parent work item id; null/undefined for root items */
  parentId?: string | null;
  risk?: string;
  effort?: string;
  description?: string;
  auditResult?: boolean | null;
  auditedAt?: string | null;
  needsProducerReview?: boolean;
  updatedAt?: string;
  issueType?: string;
  childCount?: number;
  tags?: string[];
  githubIssueNumber?: number;
  group?: number;
  groupLabel?: string;
}

export function normalizeListPayload(payload: unknown): WorklogBrowseItem[] {
  const directItems = Array.isArray(payload)
    ? payload
    : (payload && typeof payload === 'object' && Array.isArray((payload as any).workItems)
      ? (payload as any).workItems
      : []);

  const nextItems = payload && typeof payload === 'object' && Array.isArray((payload as any).results)
    ? (payload as any).results.map((entry: any) => {
        const item = entry?.workItem;
        if (!item) return null;
        // Merge the `group` and `groupLabel` fields from the result entry into the workItem
        if (entry.group !== undefined) {
          item.group = entry.group;
        }
        if (entry.groupLabel !== undefined) {
          item.groupLabel = entry.groupLabel;
        }
        return item;
      }).filter(Boolean)
    : [];

  const itemList = [...directItems, ...nextItems];

  return itemList
    .map((item: any) => ({
      id: String(item?.id ?? ''),
      title: String(item?.title ?? 'Untitled'),
      status: String(item?.status ?? 'unknown'),
      priority: item?.priority ? String(item.priority) : undefined,
      stage: item?.stage ? String(item.stage) : undefined,
      parentId: item?.parentId != null ? String(item.parentId) : undefined,
      risk: item?.risk ? String(item.risk) : undefined,
      effort: item?.effort ? String(item.effort) : undefined,
      description: item?.description ? String(item.description) : undefined,
      auditResult: item?.auditResult !== undefined ? item.auditResult : undefined,
      auditedAt: item?.auditedAt !== undefined && item?.auditedAt !== null ? String(item.auditedAt) : undefined,
      needsProducerReview: item?.needsProducerReview !== undefined ? Boolean(item.needsProducerReview) : undefined,
      updatedAt: item?.updatedAt ? String(item.updatedAt) : undefined,
      issueType: item?.issueType ? String(item.issueType) : undefined,
      childCount: item?.childCount !== undefined ? Number(item.childCount) : undefined,
      tags: Array.isArray(item?.tags) ? item.tags.map(String) : undefined,
      githubIssueNumber: item?.githubIssueNumber !== undefined ? Number(item.githubIssueNumber) : undefined,
      group: item?.group !== undefined ? Number(item.group) : undefined,
      groupLabel: item?.groupLabel !== undefined ? String(item.groupLabel) : undefined,
    }))
    .filter(item => item.id.length > 0);
}

// ── "Not initialized" detection ───────────────────────────────────────

/**
 * Known error message pattern emitted by the wl/worklog CLI and post-pull/push
 * hooks when Worklog is not initialized in the current checkout or worktree.
 */
export const NOT_INITIALIZED_PATTERN = /worklog(?::\s*not initialized|\s+system\s+is\s+not\s+initialized)/i;

/**
 * Friendly, actionable message shown to users instead of the raw stderr
 * when the "not initialized" error is detected.
 */
export const NOT_INITIALIZED_FRIENDLY =
  'Worklog is not initialized in this checkout/worktree. Run "wl init" to set up this location.';

// ── CLI execution ─────────────────────────────────────────────────────

/**
 * Default timeout (ms) for `wl`/`worklog` CLI invocations via runWl.
 * A sync hung on the file lock previously hung forever (no timeout); this
 * bounds every call so a stuck `wl sync` cannot persist indefinitely
 * (lock-storm prevention, WL-0MSAB7ZUC004SK7E). Overridable via env.
 */
export const DEFAULT_WL_TIMEOUT_MS = Number(process.env.WL_RUN_TIMEOUT_MS) || 60_000;

export async function runWl(args: string[], includeJson = true, timeoutMs: number = DEFAULT_WL_TIMEOUT_MS): Promise<string> {
  const binaries = ['wl', 'worklog'];
  let lastError: unknown;

  for (const binary of binaries) {
    try {
      const fullArgs = includeJson ? [...args, '--json'] : args;
      const execFileAsync = promisify(execFile);
      const result = await execFileAsync(binary, fullArgs, {
        maxBuffer: 1024 * 1024 * 5,
        timeout: timeoutMs,
      });
      return result.stdout;
    } catch (error: any) {
      if (error && error.code === 'ENOENT') {
        lastError = error;
        continue;
      }

      // execFile kills the child and rejects with killed/signal set when the
      // timeout fires. Surface a clear, actionable message instead of the
      // raw "Command failed" error.
      if (error && (error.killed === true || error.signal || error.code === 'ETIMEDOUT')) {
        const cmd = `${binary} ${args.join(' ')}`;
        throw new Error(`Command timed out after ${timeoutMs}ms: ${cmd}. The worklog file lock may be contended; a sync may already be running.`);
      }

      const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
      const stdout = typeof error?.stdout === 'string' ? error.stdout.trim() : '';
      const message = stderr || stdout || error?.message || String(error);

      if (NOT_INITIALIZED_PATTERN.test(message)) {
        const friendlyError = new Error(NOT_INITIALIZED_FRIENDLY);
        (friendlyError as any).cause = error;
        throw friendlyError;
      }

      throw new Error(message);
    }
  }

  throw new Error(`Unable to execute wl/worklog CLI: ${String(lastError)}`);
}

// ── List helpers ──────────────────────────────────────────────────────

/**
 * Merge work item arrays, deduplicating by item ID (first occurrence wins).
 */
export function mergeUniqueById(...arrays: WorklogBrowseItem[][]): WorklogBrowseItem[] {
  const seen = new Set<string>();
  const merged: WorklogBrowseItem[] = [];
  for (const item of arrays.flat()) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      merged.push(item);
    }
  }
  return merged;
}

/**
 * Fetch the mandatory subsets that must ALWAYS be shown in the default
 * selection list: all critical items and all completed/in_review items (the
 * producer-review queue).
 *
 * These are fetched explicitly via `wl list` because `wl next -n N` hard-caps
 * at 32 items — even `-n 500` returns only 32, so a large superset cannot
 * capture all critical/in_review items. Runs the two queries in parallel to
 * mitigate refresh latency.
 */
async function fetchMandatorySubsets(run: RunWlFn): Promise<WorklogBrowseItem[]> {
  // Root-only (WL-0MS964SIA0057ABR): child items are hidden from the
  // top-level selection list — they are only visible under their parent via
  // drill-down (Tab).
  const [criticalOutput, reviewOutput] = await Promise.all([
    run(['list', '--priority', 'critical', '--root-only']),
    run(['list', '--status', 'completed', '--stage', 'in_review', '--root-only']),
  ]);
  const criticalItems = normalizeListPayload(extractJsonObject(criticalOutput));
  const reviewItems = normalizeListPayload(extractJsonObject(reviewOutput));
  return mergeUniqueById(criticalItems, reviewItems);
}

export function createDefaultListWorkItems(
  run: RunWlFn = runWl,
  count?: number,
): () => Promise<WorklogBrowseItem[]> {
  return async (): Promise<WorklogBrowseItem[]> => {
    const itemCount = count ?? currentSettings.browseItemCount;
    const output = await run(['next', '-n', String(itemCount), '--include-in-progress']);
    const payload = extractJsonObject(output);
    const items = normalizeListPayload(payload);

    // Smart selection: merge the mandatory subsets (critical + completed/in_review,
    // fetched explicitly via wl list because wl next caps at 32 items) with the
    // regular wl next results, then always show the mandatory set and limit only
    // the "other" items to fill the remaining count slots.
    const mandatory = await fetchMandatorySubsets(run);
    const merged = mergeUniqueById(items, mandatory);
    return selectWorkItems(merged, itemCount);
  };
}

export function createListWorkItemsWithStage(
  run: RunWlFn = runWl,
  count?: number,
): (stage: string) => Promise<WorklogBrowseItem[]> {
  return async (stage: string): Promise<WorklogBrowseItem[]> => {
    const itemCount = count ?? currentSettings.browseItemCount;
    const output = await run(['next', '-n', String(itemCount), '--stage', stage, '--include-in-progress']);
    const payload = extractJsonObject(output);
    return normalizeListPayload(payload).slice(0, itemCount);
  };
}

export async function defaultListWorkItems(run: RunWlFn = runWl): Promise<WorklogBrowseItem[]> {
  return createDefaultListWorkItems(run)();
}

export async function defaultListWorkItemsWithStage(stage: string, run: RunWlFn = runWl): Promise<WorklogBrowseItem[]> {
  return createListWorkItemsWithStage(run)(stage);
}

/**
 * Fetch the total count of actionable work items (open + in-progress + blocked).
 * Returns the count, or `undefined` if the fetch fails (graceful degradation).
 */
export async function fetchTotalActionableCount(run: RunWlFn = runWl): Promise<number | undefined> {
  try {
    const output = await run(['list', '--status', 'open,in-progress,blocked']);
    const payload = JSON.parse(output);
    if (payload && typeof payload === 'object' && typeof payload.count === 'number') {
      return payload.count;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// ── Database-backed read operations (Phase 2) ────────────────────

/**
 * Create a cached "next work items" list function using direct SQLite access.
 *
 * Smart selection is applied: all critical and completed/in_review items are
 * always shown (fetched via db.list filters — see fetchMandatorySubsets for
 * the CLI equivalent), and browseItemCount limits only the remaining items.
 */
export function createDefaultListWorkItemsDb(
  count?: number,
): () => Promise<WorklogBrowseItem[]> {
  return async (): Promise<WorklogBrowseItem[]> => {
    const itemCount = count ?? currentSettings.browseItemCount;
    const db = await getDb();
    if (!db) return defaultListWorkItems();
    try {
      // Regular next-equivalent: findNextWorkItems mirrors `wl next -n <count>
      // --include-in-progress` (stage undefined, includeInProgress true).
      const nextResults = db.findNextWorkItems(itemCount, undefined, undefined, false, undefined, true);
      const regular = (Array.isArray(nextResults) ? nextResults : [])
        .filter((r: any) => r.workItem)
        .map((r: any) => normalizeDbWorkItem(r.workItem));

      // Mandatory subsets via db.list filters (db.list supports priority /
      // status / stage filtering). Required because wl next caps at 32 items.
      // Root-only (WL-0MS964SIA0057ABR): children are hidden from the
      // top-level list; they remain visible via drill-down.
      const criticalItems = db.list({ priority: 'critical', rootOnly: true });
      const reviewItems = db.list({ status: ['completed'], stage: 'in_review', rootOnly: true });
      const mandatory = mergeUniqueById(
        (Array.isArray(criticalItems) ? criticalItems : []).map(normalizeDbWorkItem),
        (Array.isArray(reviewItems) ? reviewItems : []).map(normalizeDbWorkItem),
      );

      const merged = mergeUniqueById(regular, mandatory);
      return selectWorkItems(merged, itemCount);
    } catch {
      return defaultListWorkItems();
    }
  };
}

/**
 * Normalize a raw database WorkItem into a WorklogBrowseItem.
 */
function normalizeDbWorkItem(item: any): WorklogBrowseItem {
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    priority: item.priority || undefined,
    stage: item.stage || undefined,
    parentId: item.parentId != null ? String(item.parentId) : undefined,
    risk: item.risk || undefined,
    effort: item.effort || undefined,
    description: item.description,
    auditResult: item.auditResult !== undefined ? item.auditResult : undefined,
    auditedAt: item.auditedAt !== undefined && item.auditedAt !== null ? String(item.auditedAt) : undefined,
    needsProducerReview: item.needsProducerReview !== undefined ? Boolean(item.needsProducerReview) : undefined,
    updatedAt: item.updatedAt ? String(item.updatedAt) : undefined,
    issueType: item.issueType || undefined,
    tags: item.tags?.length ? item.tags : undefined,
    githubIssueNumber: item.githubIssueNumber,
  };
}

/**
 * Create a stage-filtered list function using direct SQLite access.
 */
export function createListWorkItemsWithStageDb(
  count?: number,
): (stage: string) => Promise<WorklogBrowseItem[]> {
  return async (stage: string): Promise<WorklogBrowseItem[]> => {
    const itemCount = count ?? currentSettings.browseItemCount;
    const db = await getDb();
    if (!db) return defaultListWorkItemsWithStage(stage);
    try {
      // Root-only (WL-0MS964SIA0057ABR): stage-filtered top-level lists hide
      // child items; children remain reachable via drill-down (wl list --parent).
      const items = db.list({ stage, rootOnly: true });
      if (!Array.isArray(items)) return defaultListWorkItemsWithStage(stage);
      return items
        .sort((a: any, b: any) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))
        .map((item: any) => ({
          id: item.id,
          title: item.title,
          status: item.status,
          priority: item.priority,
          stage: item.stage || undefined,
          risk: item.risk || undefined,
          effort: item.effort || undefined,
          description: item.description,
          auditResult: item.auditResult !== undefined ? item.auditResult : undefined,
          auditedAt: item.auditedAt !== undefined && item.auditedAt !== null ? String(item.auditedAt) : undefined,
          needsProducerReview: item.needsProducerReview !== undefined ? Boolean(item.needsProducerReview) : undefined,
          updatedAt: item.updatedAt ? String(item.updatedAt) : undefined,
          issueType: item.issueType || undefined,
          tags: item.tags?.length ? item.tags : undefined,
          githubIssueNumber: item.githubIssueNumber,
        }))
        .slice(0, itemCount);
    } catch {
      return defaultListWorkItemsWithStage(stage);
    }
  };
}

/**
 * Fetch the total actionable count using direct SQLite access.
 */
export async function fetchTotalActionableCountDb(): Promise<number | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  try {
    const all = db.getAll();
    if (!Array.isArray(all)) return undefined;
    return all.filter(
      (i: any) => i.status === 'open' || i.status === 'in-progress' || i.status === 'blocked'
    ).length;
  } catch {
    return undefined;
  }
}

// ── Database-backed write operations (Phase 3) ───────────────────

/**
 * Create a work item using direct SQLite access.
 * Returns the created item's ID, or null on failure.
 */
export async function createWorkItemDb(title: string, description?: string): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  try {
    const created = db.create({ title: title || 'Untitled', description: description || title });
    return created?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Update a work item using direct SQLite access.
 * Returns true on success, false on failure.
 */
export async function updateWorkItemDb(id: string, updates: Record<string, unknown>): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  try {
    const result = db.update(id, updates);
    return result !== null;
  } catch {
    return false;
  }
}

/**
 * Close a work item using direct SQLite access.
 * Returns true on success, false on failure.
 */
export async function closeWorkItemDb(id: string, reason?: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  try {
    const result = db.update(id, { status: 'completed', description: reason });
    return result !== null;
  } catch {
    return false;
  }
}

/**
 * Add a comment to a work item using direct SQLite access.
 * Returns the comment ID on success, or null on failure.
 */
export async function addCommentDb(workItemId: string, author: string, comment: string): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  try {
    const created = db.createComment({ workItemId, author, comment });
    return created?.id ?? null;
  } catch {
    return null;
  }
}
