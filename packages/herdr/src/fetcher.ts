/**
 * packages/herdr/src/fetcher.ts — Worklog data fetching via wl CLI
 *
 * Provides typed access to the `wl` command-line interface for fetching
 * work items, filtering by stage, and retrieving item details.
 * All functions return plain data objects and do NOT depend on the
 * Herdr runtime — they can be tested in isolation.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { selectWorkItems } from './smart-selection.js';
import { regroupWorkItems } from './grouping.js';
import type { AgentState } from './agent-tracker.js';

// ── Types ────────────────────────────────────────────────────────────

/**
 * Error response from the wl CLI.
 */
export interface WlError {
  success: false;
  initialized?: boolean;
  error?: string;
}

/**
 * Format a wl error into a user-facing message.
 */
export function formatWlError(err: WlError): string {
  if (err.initialized === false) {
    return 'Worklog not initialized. Run "worklog init" first.';
  }
  if (err.error) {
    return `Worklog error: ${err.error}`;
  }
  return 'Unknown worklog error';
}

/**
 * Injectable exec function for testing. Tests can replace this with
 * a mock to avoid calling the real wl CLI. See setExecFileAsync().
 */
let execFileAsync = promisify(execFile);

/**
 * Module-level --worklog-dir override used when the parent process
 * (e.g. herdr) has resolved the worklog root and wants all child wl CLI
 * invocations to target that specific directory without relying on CWD.
 */
let _worklogDir: string | undefined;

/**
 * Set the worklog directory path to pass as --worklog-dir to every wl CLI
 * invocation. The path should point to the .worklog/ subdirectory itself
 * (e.g. /path/to/project/.worklog).
 * Pass undefined to clear the override.
 */
export function setWorklogDir(dir: string | undefined): void {
  _worklogDir = dir;
  // Switching worklog dirs invalidates any in-flight fetch memo (F4): reads
  // racing against the old dir must never be shared with the new one.
  clearFetchMemo();
}

/**
 * Return the current --worklog-dir override (if any). Used by other modules
 * (e.g. auto-sync) so their `wl` invocations target the same worklog.
 */
export function getWorklogDir(): string | undefined {
  return _worklogDir;
}

/**
 * Build the argument vector for a wl CLI invocation, prepending the
 * `--worklog-dir` override when set (it is a global option that must appear
 * BEFORE the subcommand). Callers that invoke wl directly via
 * `getExecFileAsync()` (e.g. the downtime worker's `wl next` and
 * `wl comment add`) use this so their commands resolve against the same
 * worklog root as the worklist — without the override the argument vector is
 * returned unchanged (current behavior preserved).
 */
export function buildWlArgs(args: string[]): string[] {
  if (_worklogDir !== undefined) {
    return ['--worklog-dir', _worklogDir, ...args];
  }
  return args;
}

/**
 * Reset the worklog directory override.
 */
export function resetWorklogDir(): void {
  _worklogDir = undefined;
  clearFetchMemo();
}

/**
 * Replace the execFileAsync implementation. Used by tests to inject
 * mock implementations without mocking the child_process module.
 */
export function setExecFileAsync(mock: typeof execFileAsync): void {
  execFileAsync = mock;
}

/**
 * Return the current execFileAsync implementation. Lets other modules
 * (e.g. visibility.ts) share the same injectable exec seam used by tests,
 * so mocks installed via setExecFileAsync() apply to those modules too.
 */
export function getExecFileAsync(): typeof execFileAsync {
  return execFileAsync;
}

/**
 * Reset execFileAsync to the real implementation.
 */
export function resetExecFileAsync(): void {
  execFileAsync = promisify(execFile);
}

// ── Types ─────────────────────────────────────────────────────────────

export interface WorkItem {
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
  tags?: string[];
  issueType?: string;
  childCount?: number;
  createdAt?: string;
  updatedAt?: string;
  /** GitHub issue number (e.g., '#123'). */
  githubIssueNumber?: string;
  group?: number;
  groupLabel?: string;
  needsProducerReview?: boolean;
  auditResult?: boolean | null;
  auditedAt?: string | null;
  /** Child work items (populated on expand). */
  children?: WorkItem[];
  /** Depth in hierarchy (0 = top-level, 1 = child, etc.). Used by renderer. */
  depth?: number;
  /** Internal: whether the expand icon should show collapsed state. */
  _expanded?: boolean;
  /**
   * Current agent status for the worklist-spawned agent pane associated
   * with this item (merged by the agent tracker). `idle`/`working`/`blocked`
   * render an icon; `done`/`unknown`/absent render none (WL-0MSBQUJQX005RAT9).
   */
  agentState?: AgentState;
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Extract the first complete JSON object from a string that may contain
 * leading/trailing non-JSON text (e.g., log output mixed with JSON).
 */
function extractJson(raw: string): unknown {
  const start = raw.indexOf('{');
  if (start < 0) throw new Error('No JSON object in output');

  const trimmed = raw.trim();
  // Try full parse first
  const lastCloseBrace = trimmed.lastIndexOf('}');
  if (lastCloseBrace > trimmed.lastIndexOf('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through
    }
  }

  // Manual brace counting
  let depth = 0;
  let inString = false;
  for (let i = start; i < raw.length; i += 1) {
    const c = raw[i];
    if (c === '"') {
      let backslashes = 0;
      for (let j = i - 1; j >= start && raw[j] === '\\'; j -= 1) {
        backslashes += 1;
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

/**
 * Normalize a raw work item from the wl API into a consistent WorkItem.
 */
function normalizeItem(raw: any): WorkItem {
  return {
    id: String(raw?.id ?? ''),
    title: String(raw?.title ?? 'Untitled'),
    status: String(raw?.status ?? 'unknown'),
    priority: raw?.priority ? String(raw.priority) : undefined,
    stage: raw?.stage ? String(raw.stage) : undefined,
    parentId: raw?.parentId != null ? String(raw.parentId) : undefined,
    risk: raw?.risk ? String(raw.risk) : undefined,
    effort: raw?.effort ? String(raw.effort) : undefined,
    description: raw?.description ? String(raw.description) : undefined,
    tags: Array.isArray(raw?.tags) ? raw.tags.map(String) : undefined,
    issueType: raw?.issueType ? String(raw.issueType) : undefined,
    githubIssueNumber: raw?.githubIssueNumber ? String(raw.githubIssueNumber) : undefined,
    childCount: raw?.childCount !== undefined ? Number(raw.childCount) : undefined,
    createdAt: raw?.createdAt ? String(raw.createdAt) : undefined,
    updatedAt: raw?.updatedAt ? String(raw.updatedAt) : undefined,
    group: raw?.group !== undefined ? Number(raw.group) : undefined,
    groupLabel: raw?.groupLabel ? String(raw.groupLabel) : undefined,
    needsProducerReview: raw?.needsProducerReview !== undefined ? Boolean(raw.needsProducerReview) : undefined,
    auditResult: raw?.auditResult !== undefined ? raw.auditResult : null,
    auditedAt: raw?.auditedAt !== undefined ? String(raw.auditedAt) : undefined,
  };
}

/**
 * Extract work items from a wl CLI response, handling different response
 * shapes (direct array, { workItems: [...] }, { results: [...] }).
 */
function extractItems(payload: unknown): WorkItem[] {
  if (Array.isArray(payload)) {
    return payload.map(normalizeItem);
  }

  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;

    // Check `results` FIRST — when wl next is called with -n (count) the
    // response includes both an empty `workItems: []` AND a populated
    // `results` array. Order matters here.
    if (Array.isArray(obj.results) && obj.results.length > 0) {
      return (obj.results as any[])
        .map((entry: any) => {
          const item = entry?.workItem;
          if (!item) return null;
          if (entry.group !== undefined) item.group = entry.group;
          if (entry.groupLabel !== undefined) item.groupLabel = entry.groupLabel;
          return normalizeItem(item);
        })
        .filter(Boolean) as WorkItem[];
    }

    // Check `workItems` next — from wl list
    if (Array.isArray(obj.workItems) && obj.workItems.length > 0) {
      return (obj.workItems as any[]).map(normalizeItem);
    }

    // Single item under { workItem: {...} } — from wl next (no -n) or wl show
    if (obj && typeof obj === 'object' && obj.workItem && typeof obj.workItem === 'object') {
      return [normalizeItem(obj.workItem)];
    }

    // Direct single item: { id: "...", title: "..." }
    if (obj.id) {
      return [normalizeItem(obj)];
    }

    // Fallback: results might be empty but still present
    if (Array.isArray(obj.results)) {
      return [];
    }
    if (Array.isArray(obj.workItems)) {
      return [];
    }
  }

  return [];
}

// ── CLI execution ─────────────────────────────────────────────────────

const CLI_BINARIES = ['wl', 'worklog'];

// ── In-process fetch memoization (F4 — WL-0MSGAEPOJ002824S) ───────────

/**
 * Read commands whose results may be deduplicated in-process. Matches the
 * wl CLI read-cache command set (F2). Writes (update/create/sync/…) are
 * NEVER memoized — a deduped write would drop a mutation.
 */
const MEMOIZABLE_COMMANDS = new Set(['list', 'next', 'show', 'search', 'status']);

/** Cap on in-flight memo entries (bounded: entries are removed on settle, so
 * this caps only concurrent racing fetches, which is the dedupe window). */
const MEMO_MAX_ENTRIES = 64;

/**
 * In-flight promise memo: key → shared promise for an identical read that is
 * currently executing in this process. Racing identical fetches (overlapping
 * refresh ticks, duplicate pane queries) share the SAME promise, so `wl` is
 * spawned once instead of N times. Entries are deleted when the promise
 * settles — the memo never serves a settled result, so reads that begin
 * after a DB write always spawn fresh (never stale across writes).
 */
const inflightFetchMemo = new Map<string, Promise<string>>();

function fetchMemoKey(args: string[], includeJson: boolean): string {
  // Include the worklog-dir override so a dir change never cross-contaminates.
  return `${_worklogDir ?? ''}\u0000${includeJson ? '1' : '0'}\u0000${args.join('\u0000')}`;
}

/**
 * Drop all in-flight fetch memo entries (after a write or worklog-dir
 * change). Reads that started before the write keep their own result; reads
 * issued after the write will spawn fresh instead of sharing a pre-write
 * in-flight read.
 */
export function clearFetchMemo(): void {
  inflightFetchMemo.clear();
}

/**
 * Test helper: current number of in-flight memo entries. Used to verify the
 * memo stays bounded under many concurrent distinct fetches.
 */
export function _fetchMemoSize(): number {
  return inflightFetchMemo.size;
}

async function runWlInner(args: string[], includeJson: boolean, timeoutMs?: number): Promise<string> {
  let lastError: unknown;

  for (const binary of CLI_BINARIES) {
    try {
      let fullArgs: string[];
      if (includeJson) {
        fullArgs = [...args, '--json'];
      } else {
        fullArgs = args;
      }

      // Prepend --worklog-dir when set (global option before the subcommand).
      fullArgs = buildWlArgs(fullArgs);

      const result = await execFileAsync(binary, fullArgs, {
        maxBuffer: 1024 * 1024 * 5,
        ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
      });
      return result.stdout;
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        lastError = error;
        continue;
      }
      const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
      const stdout = typeof error?.stdout === 'string' ? error.stdout.trim() : '';
      const message = stderr || stdout || error?.message || String(error);

      // Re-throw with a clean message
      throw new Error(message);
    }
  }

  throw new Error(`wl CLI not found: ${String(lastError)}`);
}

async function runWl(args: string[], includeJson = true, timeoutMs?: number): Promise<string> {
  const command = args[0];

  // Writes must never be deduplicated or share pre-write read results: drop
  // any in-flight read memo so a read issued after this write spawns fresh.
  if (!MEMOIZABLE_COMMANDS.has(command)) {
    if (inflightFetchMemo.size > 0) inflightFetchMemo.clear();
    return runWlInner(args, includeJson, timeoutMs);
  }

  // Read: dedupe concurrent identical fetches within this process (F4).
  const key = fetchMemoKey(args, includeJson);
  const inFlight = inflightFetchMemo.get(key);
  if (inFlight) {
    return inFlight;
  }

  const promise = runWlInner(args, includeJson, timeoutMs).finally(() => {
    // Remove on settle: the memo only dedupes CONCURRENT fetches, so a
    // later identical read always spawns fresh (never stale across writes).
    if (inflightFetchMemo.get(key) === promise) {
      inflightFetchMemo.delete(key);
    }
  });

  // Bound: evict the oldest entry when over the cap (Map preserves insertion
  // order, so the first key is the oldest).
  if (inflightFetchMemo.size >= MEMO_MAX_ENTRIES) {
    const oldest = inflightFetchMemo.keys().next().value;
    if (oldest !== undefined) {
      inflightFetchMemo.delete(oldest);
    }
  }
  inflightFetchMemo.set(key, promise);
  return promise;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Check whether the wl CLI is available on PATH.
 */
export async function checkWlAvailable(): Promise<boolean> {
  for (const binary of CLI_BINARIES) {
    try {
      await execFileAsync(binary, ['--version'], { maxBuffer: 1024 });
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * Merge work item arrays, deduplicating by item ID (first occurrence wins).
 */
function mergeUniqueById(...arrays: WorkItem[][]): WorkItem[] {
  const seen = new Set<string>();
  const merged: WorkItem[] = [];
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
 * worklist: all critical items and all completed/in_review items (the
 * producer-review queue).
 *
 * These are fetched explicitly via `wl list` because `wl next -n N` hard-caps
 * at 32 items — even `-n 500` returns only 32, so a large superset cannot
 * capture all critical/in_review items. Runs the two queries in parallel to
 * mitigate refresh latency.
 */
async function fetchMandatorySubsets(): Promise<WorkItem[]> {
  // Root-only (WL-0MS964SIA0057ABR): child items are hidden from the
  // top-level worklist — they are only visible under their parent via expand.
  const [criticalOutput, reviewOutput] = await Promise.all([
    runWl(['list', '--priority', 'critical', '--root-only']),
    runWl(['list', '--status', 'completed', '--stage', 'in_review', '--root-only']),
  ]);
  const criticalItems = extractItems(extractJson(criticalOutput));
  const reviewItems = extractItems(extractJson(reviewOutput));
  return mergeUniqueById(criticalItems, reviewItems);
}

/**
 * Fetch the next available work items (via `wl next`).
 *
 * When a count is given, smart selection is applied: all critical and
 * completed/in_review items are always included (regardless of count) and
 * the count limits only the remaining "other" items. The mandatory subsets
 * are merged from explicit `wl list` queries (see fetchMandatorySubsets).
 */
export async function fetchNextItems(count?: number): Promise<WorkItem[]> {
  const args = ['next'];
  if (count !== undefined) {
    args.push('-n', String(count));
  }
  args.push('--include-in-progress');

  const output = await runWl(args);
  const payload = extractJson(output);
  const items = extractItems(payload);
  if (count === undefined) {
    return items;
  }

  // Smart selection: merge the mandatory subsets with the regular wl next
  // results (deduplicated by ID), then always show the mandatory set and
  // limit only the "other" items to fill the remaining count slots.
  const mandatory = await fetchMandatorySubsets();
  const merged = mergeUniqueById(items, mandatory);
  const selected = selectWorkItems(merged, count);
  // Regroup the final selected set so every displayed item (mandatory wl
  // list items included) receives a correct group assignment and no
  // duplicate section headings render (WL-0MSAK8YLB0025EGW).
  return regroupWorkItems(selected);
}

/**
 * Status set used per stage by the stage-filtered worklist fetch.
 *
 * Most stages show only open items (`status=open`) — the "every open item
 * in the stage" rule from WL-0MSDT8X1V003206G. The in_review stage is the
 * exception (WL-0MSKCRX730052IIW): per the project workflow, advancing an
 * item to in_review sets its status to `completed` (or leaves it
 * `in-progress` while it is being re-worked after review feedback), so
 * restricting to `status=open` would hide the entire review queue. `open`
 * is included for robustness (no in_review item carries it today).
 */
const STAGE_STATUS: Record<string, string> = {
  in_review: 'completed,in-progress,open',
};

/**
 * Fetch work items filtered by stage (via `wl list`).
 * Status per stage (WL-0MSKCRX730052IIW): the in_review stage fetches items
 * with status `completed`, `in-progress`, or `open` — in_review items carry
 * `completed`/`in-progress` status per the project workflow. All other
 * stages fetch open items only (WL-0MSDT8X1V003206G): items with status
 * `blocked`, `in-progress`, or `completed` are excluded even when their
 * stage matches.
 * Root-only (WL-0MS964SIA0057ABR): stage-filtered top-level lists hide
 * child items; children remain reachable via expand (wl list --parent).
 * Results are ordered by the standard list order (sortIndex).
 */
export async function fetchItemsByStage(stage: string): Promise<WorkItem[]> {
  const status = STAGE_STATUS[stage] ?? 'open';
  const output = await runWl(['list', '--status', status, '--stage', stage, '--root-only']);
  const payload = extractJson(output);
  return extractItems(payload);
}

/**
 * Fetch details for a single work item by ID (via `wl show`).
 */
export async function fetchItemDetails(id: string): Promise<WorkItem | null> {
  try {
    const output = await runWl(['show', id]);
    const payload = extractJson(output);
    const items = extractItems(payload);
    return items.length > 0 ? items[0] : null;
  } catch {
    return null;
  }
}

/**
 * Fetch the total count of actionable work items.
 */
export async function fetchActionableCount(): Promise<number | undefined> {
  try {
    const output = await runWl(['list', '--status', 'open,in-progress,blocked']);
    const payload = JSON.parse(output);
    if (payload && typeof payload === 'object' && typeof (payload as any).count === 'number') {
      return (payload as any).count;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run `wl sync` to synchronize local data with the remote.
 * Returns success status and optional error message.
 */
export async function runWlSync(): Promise<{ success: boolean; error?: string }> {
  try {
    const output = await runWl(['sync']);
    const payload = extractJson(output);
    const result = payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>)
      : {};
    return { success: result?.success !== false };
  } catch (err: any) {
    return { success: false, error: err.message ?? String(err) };
  }
}

/**
 * Fetch child work items for a given parent ID (via `wl list --parent`).
 *
 * Child items are returned with the given hierarchy `depth` for display
 * (default 1 = direct children of a top-level item). Nested expansion
 * passes the parent's depth + 1 so grandchildren render at depth 2, etc.
 * (WL-0MSQ3FH1K000MMJW) — depth is derived from the fetch path, never
 * hardcoded.
 */
export async function fetchChildrenForItem(parentId: string, depth = 1): Promise<WorkItem[]> {
  const output = await runWl(['list', '--parent', parentId]);
  const payload = extractJson(output);
  const items = extractItems(payload);
  return items.map((item) => ({ ...item, depth }));
}

// ── Work-item claiming ────────────────────────────────────────────────

/**
 * Result of a work-item claim (status → in_progress) attempt.
 */
export interface ClaimResult {
  success: boolean;
  error?: string;
}

/**
 * Timeout for claim status updates so a hung `wl` CLI cannot delay the
 * agent pane from opening (AC2: failures must not block the pane).
 */
const CLAIM_TIMEOUT_MS = 3000;

/**
 * Claim a work item before dispatching an agent command: set its status
 * to `in_progress` with the given assignee, matching the claim pattern
 * documented in AGENTS.md. Targets the configured worklog database via
 * `--worklog-dir` when set.
 *
 * Never throws — failures are returned so callers can log them without
 * blocking the agent pane from opening.
 */
export async function claimWorkItem(id: string, assignee: string): Promise<ClaimResult> {
  try {
    await runWl(
      ['update', id, '--status', 'in_progress', '--assignee', assignee],
      true,
      CLAIM_TIMEOUT_MS,
    );
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message ?? String(err) };
  }
}
