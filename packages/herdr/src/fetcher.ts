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

/**
 * Injectable exec function for testing. Tests can replace this with
 * a mock to avoid calling the real wl CLI. See setExecFileAsync().
 */
let execFileAsync = promisify(execFile);

/**
 * Replace the execFileAsync implementation. Used by tests to inject
 * mock implementations without mocking the child_process module.
 */
export function setExecFileAsync(mock: typeof execFileAsync): void {
  execFileAsync = mock;
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
  risk?: string;
  effort?: string;
  description?: string;
  tags?: string[];
  issueType?: string;
  childCount?: number;
  createdAt?: string;
  updatedAt?: string;
  group?: number;
  groupLabel?: string;
  needsProducerReview?: boolean;
  auditResult?: boolean | null;
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
    risk: raw?.risk ? String(raw.risk) : undefined,
    effort: raw?.effort ? String(raw.effort) : undefined,
    description: raw?.description ? String(raw.description) : undefined,
    tags: Array.isArray(raw?.tags) ? raw.tags.map(String) : undefined,
    issueType: raw?.issueType ? String(raw.issueType) : undefined,
    childCount: raw?.childCount !== undefined ? Number(raw.childCount) : undefined,
    createdAt: raw?.createdAt ? String(raw.createdAt) : undefined,
    updatedAt: raw?.updatedAt ? String(raw.updatedAt) : undefined,
    group: raw?.group !== undefined ? Number(raw.group) : undefined,
    groupLabel: raw?.groupLabel ? String(raw.groupLabel) : undefined,
    needsProducerReview: raw?.needsProducerReview !== undefined ? Boolean(raw.needsProducerReview) : undefined,
    auditResult: raw?.auditResult !== undefined ? raw.auditResult : null,
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
    if (Array.isArray(obj.workItems)) {
      return (obj.workItems as any[]).map(normalizeItem);
    }
    if (Array.isArray(obj.results)) {
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
    if (obj.id) {
      return [normalizeItem(obj)];
    }
  }

  return [];
}

// ── CLI execution ─────────────────────────────────────────────────────

const CLI_BINARIES = ['wl', 'worklog'];

async function runWl(args: string[], includeJson = true): Promise<string> {
  let lastError: unknown;

  for (const binary of CLI_BINARIES) {
    try {
      const fullArgs = includeJson ? [...args, '--json'] : args;
      const result = await execFileAsync(binary, fullArgs, {
        maxBuffer: 1024 * 1024 * 5,
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
 * Fetch the next available work items (via `wl next`).
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
  if (count !== undefined) {
    return items.slice(0, count);
  }
  return items;
}

/**
 * Fetch work items filtered by stage (via `wl list --stage`).
 */
export async function fetchItemsByStage(stage: string): Promise<WorkItem[]> {
  const output = await runWl(['list', '--stage', stage]);
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
