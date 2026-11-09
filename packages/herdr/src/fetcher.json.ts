/**
 * packages/herdr/src/fetcher.json.ts — `wl`-payload JSON extraction and normalisation.
 *
 * Single responsibility: turn raw `wl` CLI output and payloads into typed
 * `WorkItem` arrays — locate the JSON object in noisy output (`extractJson`),
 * normalise one raw item into a complete `WorkItem` (`normalizeItem`) and
 * dispatch the documented response shapes (`extractItems`). Leaf module: it
 * imports only the `WorkItem` *type* from `./fetcher.types.js` with
 * `import type`, never the `./fetcher.js` barrel (parent AC4). Moved verbatim
 * out of `fetcher.ts` (parent WL-0MVGKH47T007GKN1; extraction
 * WL-0MW08VUKQ005BU1B). `normalizeItem` is exported for the in-process
 * enrichment path in `fetcher.ts` (`enrichInProcessItems`) but is not
 * re-exported from the barrel, so the public surface is unchanged. No
 * behaviour change.
 */

import type { WorkItem } from './fetcher.types.js';

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Extract the first complete JSON object from a string that may contain
 * leading/trailing non-JSON text (e.g., log output mixed with JSON).
 */
/**
 * Extract the first complete JSON object from a string that may contain
 * leading/trailing non-JSON text (e.g., log output mixed with JSON).
 * Exported for use by the downtime worker's review-queue gate.
 */
export function extractJson(raw: string): unknown {
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
export function normalizeItem(raw: any): WorkItem {
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
    deletedBy: raw?.deletedBy ? String(raw.deletedBy) : undefined,
    assignee: raw?.assignee ? String(raw.assignee) : undefined,
    auditResult: raw?.auditResult !== undefined ? raw.auditResult : null,
    auditedAt: raw?.auditedAt == null ? (raw?.auditedAt as null | undefined) : String(raw.auditedAt),
    fingerprint: raw?.fingerprint == null ? (raw?.fingerprint as null | undefined) : String(raw.fingerprint),
    currentFingerprint: raw?.currentFingerprint == null ? (raw?.currentFingerprint as null | undefined) : String(raw.currentFingerprint),
  };
}

/**
 * Extract work items from a wl CLI response, handling different response
 * shapes (direct array, { workItems: [...] }, { results: [...] }).
 */
/**
 * Extract work items from a wl CLI response, handling different response
 * shapes (direct array, { workItems: [...] }, { results: [...] }).
 * Exported for use by the downtime worker's review-queue gate.
 */
export function extractItems(payload: unknown): WorkItem[] {
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

