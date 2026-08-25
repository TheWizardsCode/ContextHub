/**
 * JSONL (JSON Lines) import/export functionality
 * This format is Git-friendly as each work item is on a separate line
 */

import * as fs from 'fs';
import * as path from 'path';
import { WorkItem, Comment, DependencyEdge, WorkItemDependency, AuditResult } from './types.js';
import { stripWorklogMarkers } from './github.js';
import { resolveWorklogDir } from './worklog-paths.js';
import { normalizeStatusValue } from './status-stage-rules.js';

function normalizeForStableJson(value: any): any {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(v => normalizeForStableJson(v));
  if (typeof value !== 'object') return value;

  const out: any = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = normalizeForStableJson(value[key]);
  }
  return out;
}

function stableStringify(value: any): string {
  return JSON.stringify(normalizeForStableJson(value));
}

interface JsonlRecord {
  type: 'workitem' | 'comment' | 'audit_result';
  data: WorkItem | Comment | AuditResult;
}

function normalizeDependencies(input: WorkItemDependency[] | undefined): WorkItemDependency[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter(edge => edge && typeof edge.from === 'string' && typeof edge.to === 'string')
    .map(edge => ({ from: edge.from, to: edge.to }));
}

export function dependenciesFromEdges(edges: DependencyEdge[], itemId: string): WorkItemDependency[] {
  return edges
    .filter(edge => edge.fromId === itemId)
    .map(edge => ({ from: edge.fromId, to: edge.toId }))
    .sort((a, b) => {
      const fromDiff = a.from.localeCompare(b.from);
      if (fromDiff !== 0) return fromDiff;
      return a.to.localeCompare(b.to);
    });
}

function mergeDependencyEdges(edges: DependencyEdge[]): DependencyEdge[] {
  const merged = new Map<string, DependencyEdge>();
  for (const edge of edges) {
    merged.set(`${edge.fromId}::${edge.toId}`, edge);
  }
  return Array.from(merged.values());
}

/**
 * Sync header metadata (incremental sync, WL-0MSAKUBKW006FN8Q).
 *
 * The first line of a sync JSONL identifies whether the rest of the file is a
 * full snapshot or a delta (subset) of records. The header is a single JSON
 * object so the parser can detect it before processing records, and so old
 * parsers that only know the workitem/comment/audit formats never treat the
 * header as a record (the `data`/`type` fields are absent).
 */
export interface SyncHeader {
  version: number;
  kind: 'full' | 'delta';
}

export const SYNC_HEADER_KEY = '__worklog_sync__';
export const SYNC_HEADER_VERSION = 1;

/**
 * Build the header line for a given sync kind. Returns null when no header is
 * requested (legacy callers keep producing plain files).
 */
export function buildSyncHeader(kind?: 'full' | 'delta'): string | null {
  if (!kind) return null;
  return stableStringify({ [SYNC_HEADER_KEY]: { version: SYNC_HEADER_VERSION, kind } });
}

/**
 * Parse a sync header line. Returns null when the line is not a known header.
 *
 * @param line - A single JSONL line (first line of a sync file).
 */
export function parseSyncHeader(line: string): SyncHeader | null {
  try {
    const parsed = JSON.parse(line);
    const h = parsed?.[SYNC_HEADER_KEY];
    if (!h || typeof h !== 'object') return null;
    const kind = h.kind;
    if (kind !== 'full' && kind !== 'delta') return null;
    return { version: typeof h.version === 'number' ? h.version : SYNC_HEADER_VERSION, kind };
  } catch {
    return null;
  }
}

function buildJsonlContent(
  items: WorkItem[],
  comments: Comment[],
  dependencyEdges: DependencyEdge[] = [],
  auditResults: AuditResult[] = [],
  kind?: 'full' | 'delta'
): string {
  const lines: string[] = [];

  const header = buildSyncHeader(kind);
  if (header) lines.push(header);

  const sortedItems = [...items].sort((a, b) => a.id.localeCompare(b.id));
  const normalizedEdges = mergeDependencyEdges(dependencyEdges);
  const sortedComments = [...comments].sort((a, b) => {
    const wi = a.workItemId.localeCompare(b.workItemId);
    if (wi !== 0) return wi;
    const ca = a.createdAt.localeCompare(b.createdAt);
    if (ca !== 0) return ca;
    return a.id.localeCompare(b.id);
  });
  const sortedAudits = [...auditResults].sort((a, b) => a.workItemId.localeCompare(b.workItemId));

  // Add work items
  sortedItems.forEach(item => {
    const dependencies = dependenciesFromEdges(normalizedEdges, item.id);
    const itemWithDeps: WorkItem = {
      ...item,
      dependencies: dependencies.length > 0 ? dependencies : [],
    };
    lines.push(stableStringify({ type: 'workitem', data: itemWithDeps }));
  });

  // Add comments
  sortedComments.forEach(comment => {
    // Ensure comment includes the new optional GitHub mapping fields when present
    const outComment = { ...comment } as any;
    if (outComment.githubCommentId === undefined) delete outComment.githubCommentId;
    if (outComment.githubCommentUpdatedAt === undefined) delete outComment.githubCommentUpdatedAt;
    lines.push(stableStringify({ type: 'comment', data: outComment }));
  });

  // Add audit results
  sortedAudits.forEach(audit => {
    lines.push(stableStringify({ type: 'audit_result', data: audit }));
  });

  return lines.join('\n') + '\n';
}


/**
 * Export work items, comments, and audit results to a JSONL file
 */
export function exportToJsonl(
  items: WorkItem[],
  comments: Comment[],
  filepath: string,
  dependencyEdges: DependencyEdge[] = [],
  auditResults: AuditResult[] = [],
  kind?: 'full' | 'delta'
): number {
  const content = buildJsonlContent(items, comments, dependencyEdges, auditResults, kind);

  // Ensure directory exists
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Atomic write: write to a temporary file in the same directory then rename
  // to avoid other processes reading a partially-written file.
  const tempName = `${path.basename(filepath)}.tmp-${Math.random().toString(36).slice(2, 10)}`;
  const tempPath = path.join(dir, tempName);

  fs.writeFileSync(tempPath, content, 'utf-8');
  // Rename is atomic on most POSIX filesystems when performed within same fs/dir
  fs.renameSync(tempPath, filepath);

  const stats = fs.statSync(filepath);
  return stats.mtimeMs;
}

/**
 * Asynchronously export work items and comments to a JSONL file.
 *
 * Uses non-blocking filesystem operations to avoid blocking the Node.js event
 * loop on large exports.
 */
export async function exportToJsonlAsync(
  items: WorkItem[],
  comments: Comment[],
  filepath: string,
  dependencyEdges: DependencyEdge[] = [],
  auditResults: AuditResult[] = [],
  options?: any
): Promise<number> {
  // Prefer worker_threads to move CPU-heavy JSONL building/writing off the
  // main event loop. If worker_threads are unavailable or worker construction
  // fails, fall back to the previous in-process async implementation.
  const onProgress = options?.onProgress;
  const kind: 'full' | 'delta' | undefined = options?.kind;
  // Build the header string ONCE (both for the worker path and the fallback).
  const headerLine = buildSyncHeader(kind);

  // Inline worker code that performs stable JSONL serialization and reports
  // progress back to the parent via parentPort.postMessage(). Using an
  // inline eval'd worker avoids having to manage a separate compiled worker
  // asset which keeps the change minimal.
  const tryWorker = async (): Promise<number> => {
    // Dynamically require to defer errors on unsupported environments
    let Worker: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
      Worker = require('worker_threads').Worker;
    } catch (err) {
      throw new Error('worker_threads unavailable');
    }

    // Serialize worker code; keep it small and self-contained to avoid
    // depending on the module system inside the worker.
    const workerCode = [
      "const { parentPort, workerData } = require('worker_threads');",
      "const fs = require('fs');",
      "const path = require('path');",
      "function normalizeForStableJson(value) {",
      "  if (value === null || value === undefined) return value;",
      "  if (Array.isArray(value)) return value.map(v => normalizeForStableJson(v));",
      "  if (typeof value !== 'object') return value;",
      "  const out = {};",
      "  for (const key of Object.keys(value).sort()) { out[key] = normalizeForStableJson(value[key]); }",
      "  return out;",
      "}",
      "function stableStringify(value) { return JSON.stringify(normalizeForStableJson(value)); }",
      "function mergeDependencyEdges(edges) { const merged = new Map(); for (const edge of edges || []) { merged.set(edge.fromId + '::' + edge.toId, edge); } return Array.from(merged.values()); }",
      "function dependenciesFromEdges(edges, itemId) { return (edges || []).filter(function(e){ return e.fromId === itemId; }).map(function(e){ return { from: e.fromId, to: e.toId }; }).sort(function(a,b){ const d = a.from.localeCompare(b.from); return d !== 0 ? d : a.to.localeCompare(b.to); }); }",
      "try {",
      "  const { items, comments, dependencyEdges, auditResults, filepath, headerLine } = workerData;",
      "  const dir = path.dirname(filepath); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });",
      "  const tempName = path.basename(filepath) + '.tmp-' + Math.random().toString(36).slice(2,10);",
      "  const tempPath = path.join(dir, tempName);",
      "  const out = fs.createWriteStream(tempPath, { encoding: 'utf8' });",
      "  if (headerLine) out.write(headerLine + '\\n');",
      "  const sortedItems = (items || []).slice().sort(function(a,b){ return a.id.localeCompare(b.id); });",
      "  const normalizedEdges = mergeDependencyEdges(dependencyEdges || []);",
      "  const sortedComments = (comments || []).slice().sort(function(a,b){ const wi = a.workItemId.localeCompare(b.workItemId); if (wi !== 0) return wi; const ca = a.createdAt.localeCompare(b.createdAt); if (ca !== 0) return ca; return a.id.localeCompare(b.id); });",
      "  const sortedAudits = (auditResults || []).slice().sort(function(a,b){ return a.workItemId.localeCompare(b.workItemId); });",
      "  const total = sortedItems.length + sortedComments.length + sortedAudits.length;",
      "  let processed = 0;",
      "  for (let i = 0; i < sortedItems.length; i++) { const item = sortedItems[i]; const deps = dependenciesFromEdges(normalizedEdges, item.id); const itemWithDeps = Object.assign({}, item, { dependencies: deps.length > 0 ? deps : [] }); out.write(stableStringify({ type: 'workitem', data: itemWithDeps }) + '\\n'); processed += 1; if (processed % 100 === 0 || processed === total) { const percent = total > 0 ? Math.floor((processed / total) * 100) : 100; parentPort.postMessage({ type: 'progress', percent: percent, itemsProcessed: processed }); } }",
      "  for (let i = 0; i < sortedComments.length; i++) { const comment = sortedComments[i]; const outComment = Object.assign({}, comment); if (outComment.githubCommentId === undefined) delete outComment.githubCommentId; if (outComment.githubCommentUpdatedAt === undefined) delete outComment.githubCommentUpdatedAt; out.write(stableStringify({ type: 'comment', data: outComment }) + '\\n'); processed += 1; if (processed % 100 === 0 || processed === total) { const percent = total > 0 ? Math.floor((processed / total) * 100) : 100; parentPort.postMessage({ type: 'progress', percent: percent, itemsProcessed: processed }); } }",
      "  for (let i = 0; i < sortedAudits.length; i++) { out.write(stableStringify({ type: 'audit_result', data: sortedAudits[i] }) + '\\n'); processed += 1; if (processed % 100 === 0 || processed === total) { const percent = total > 0 ? Math.floor((processed / total) * 100) : 100; parentPort.postMessage({ type: 'progress', percent: percent, itemsProcessed: processed }); } }",
      "  out.end(function() { try { fs.renameSync(tempPath, filepath); const stats = fs.statSync(filepath); parentPort.postMessage({ type: 'done', mtimeMs: stats.mtimeMs }); } catch (err) { try { fs.unlinkSync(tempPath); } catch (_) {} parentPort.postMessage({ type: 'error', error: String(err) }); } });",
      "} catch (err) { parentPort.postMessage({ type: 'error', error: String(err) }); }"
    ].join('\n');

    return new Promise<number>((resolve, reject) => {
      const worker = new Worker(workerCode, { eval: true, workerData: { items, comments, dependencyEdges, auditResults, filepath, headerLine } });

      worker.on('message', (msg: any) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'progress') {
          try { onProgress?.({ type: 'progress', percent: msg.percent, itemsProcessed: msg.itemsProcessed }); } catch (_) {}
        } else if (msg.type === 'done') {
          try { onProgress?.({ type: 'done', mtimeMs: msg.mtimeMs }); } catch (_) {}
          resolve(msg.mtimeMs);
        } else if (msg.type === 'error') {
          try { onProgress?.({ type: 'error', error: msg.error }); } catch (_) {}
          reject(new Error(msg.error));
        }
      });

      worker.on('error', (err: Error) => {
        try { onProgress?.({ type: 'error', error: err.message }); } catch (_) {}
        reject(err);
      });

      worker.on('exit', (code: number) => {
        if (code !== 0) {
          const errMsg = `Worker exited with code ${code}`;
          try { onProgress?.({ type: 'error', error: errMsg }); } catch (_) {}
          reject(new Error(errMsg));
        }
      });
    });
  };

  try {
    return await tryWorker();
  } catch (err) {
    // Worker-based export failed; fall back to previous in-process path.
    try {
      const content = buildJsonlContent(items, comments, dependencyEdges, auditResults, kind);
      const dir = path.dirname(filepath);
      const tempName = `${path.basename(filepath)}.tmp-${Math.random().toString(36).slice(2, 10)}`;
      const tempPath = path.join(dir, tempName);

      await fs.promises.mkdir(dir, { recursive: true });

      try {
        await fs.promises.writeFile(tempPath, content, 'utf-8');
        await fs.promises.rename(tempPath, filepath);
      } catch (error) {
        try {
          await fs.promises.unlink(tempPath);
        } catch {}
        throw error;
      }

      const stats = await fs.promises.stat(filepath);
      // Best-effort progress callback for the fallback path
      try { onProgress?.({ type: 'done', mtimeMs: stats.mtimeMs }); } catch (_) {}
      return stats.mtimeMs;
    } catch (finalErr) {
      throw finalErr;
    }
  }
}

/**
 * Import work items, comments, and audit results from a JSONL file
 */
export function importFromJsonl(filepath: string): { items: WorkItem[], comments: Comment[], dependencyEdges: DependencyEdge[], auditResults: AuditResult[] } {
  if (!fs.existsSync(filepath)) {
    throw new Error(`File not found: ${filepath}`);
  }

  const content = fs.readFileSync(filepath, 'utf-8');
  return importFromJsonlContent(content);
}

export function importFromJsonlContent(content: string): { items: WorkItem[], comments: Comment[], dependencyEdges: DependencyEdge[], auditResults: AuditResult[], kind?: 'full' | 'delta' } {
  const lines = content.split('\n').filter(line => line.trim() !== '');
  
  const items: WorkItem[] = [];
  const comments: Comment[] = [];
  const dependencyEdges: DependencyEdge[] = [];
  const auditResults: AuditResult[] = [];

  // Detect + consume a sync header on the FIRST line (incremental sync,
  // WL-0MSAKUBKW006FN8Q). The header is emitted by exportToJsonlAsync with
  // options.kind set. Files without a header are treated as `undefined` kind
  // (legacy full snapshot), preserving existing behavior.
  let kind: 'full' | 'delta' | undefined;
  if (lines.length > 0) {
    const header = parseSyncHeader(lines[0]);
    if (header) {
      kind = header.kind;
      lines.shift();
    }
  }
  
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      
      // Handle new format with type field
      if (parsed.type === 'workitem' && parsed.data) {
        const item = parsed.data as WorkItem;
        const dependencies = normalizeDependencies(item.dependencies);
        // Ensure backward compatibility
        if (item.assignee === undefined) {
          item.assignee = '';
        }
        if (item.stage === undefined) {
          item.stage = '';
        }
        if ((item as any).issueType === undefined) {
          (item as any).issueType = '';
        }
        if ((item as any).createdBy === undefined) {
          (item as any).createdBy = '';
        }
        if ((item as any).deletedBy === undefined) {
          (item as any).deletedBy = '';
        }
        if ((item as any).deleteReason === undefined) {
          (item as any).deleteReason = '';
        }
        if ((item as any).sortIndex === undefined) {
          (item as any).sortIndex = 0;
        }
        if ((item as any).risk === undefined) {
          (item as any).risk = '';
        }
        if ((item as any).effort === undefined) {
          (item as any).effort = '';
        }
        if ((item as any).githubIssueNumber === undefined) {
          (item as any).githubIssueNumber = undefined;
        }
        if ((item as any).githubIssueId === undefined) {
          (item as any).githubIssueId = undefined;
        }
        if ((item as any).githubIssueUpdatedAt === undefined) {
          (item as any).githubIssueUpdatedAt = undefined;
        }
      if ((item as any).githubIssueNumber !== undefined && (item as any).githubIssueNumber !== null) {
          (item as any).githubIssueNumber = Number((item as any).githubIssueNumber);
        }
        if ((item as any).githubIssueId !== undefined && (item as any).githubIssueId !== null) {
          (item as any).githubIssueId = Number((item as any).githubIssueId);
        }
        if (item.description) {
          item.description = stripWorklogMarkers(item.description);
        }
        // Preserve presence/absence of the new boolean field so round-trip
        // export/import does not introduce properties that weren't in the source.
        if ((item as any).needsProducerReview !== undefined) {
          (item as any).needsProducerReview = Boolean((item as any).needsProducerReview);
        }
        // Normalize status to canonical hyphenated form (e.g. in_progress -> in-progress)
        // on import so all downstream consumers see consistent values.
        item.status = (normalizeStatusValue(item.status) ?? item.status) as WorkItem['status'];
        item.dependencies = dependencies;
        items.push(item);
        for (const dep of dependencies) {
          dependencyEdges.push({ fromId: dep.from, toId: dep.to, createdAt: new Date().toISOString() });
        }
      } else if (parsed.type === 'comment' && parsed.data) {
        const comment = parsed.data as Comment;
        if (comment.comment) {
          comment.comment = stripWorklogMarkers(comment.comment);
        }
        // Preserve optional GitHub mapping fields when present in JSONL
        const normalized: any = { ...comment };
        if (normalized.githubCommentId === undefined) normalized.githubCommentId = undefined;
        if (normalized.githubCommentUpdatedAt === undefined) normalized.githubCommentUpdatedAt = undefined;
        comments.push(normalized as Comment);
      } else if (parsed.type === 'audit_result' && parsed.data) {
        const audit = parsed.data as AuditResult;
        auditResults.push(audit);
      } else if (parsed.type === undefined && !parsed.data) {
        // Handle old format (no type field, no data wrapper) - assume it's a work item
        console.warn(`Warning: Found entry without type field, assuming it's a work item. Consider migrating to the new format.`);
        const item = parsed as WorkItem;
        const dependencies = normalizeDependencies(item.dependencies);
        if (item.assignee === undefined) {
          item.assignee = '';
        }
        if (item.stage === undefined) {
          item.stage = '';
        }
        if ((item as any).issueType === undefined) {
          (item as any).issueType = '';
        }
        if ((item as any).createdBy === undefined) {
          (item as any).createdBy = '';
        }
        if ((item as any).deletedBy === undefined) {
          (item as any).deletedBy = '';
        }
        if ((item as any).deleteReason === undefined) {
          (item as any).deleteReason = '';
        }
        if ((item as any).sortIndex === undefined) {
          (item as any).sortIndex = 0;
        }
        if ((item as any).risk === undefined) {
          (item as any).risk = '';
        }
        if ((item as any).effort === undefined) {
          (item as any).effort = '';
        }
        if ((item as any).githubIssueNumber === undefined) {
          (item as any).githubIssueNumber = undefined;
        }
        if ((item as any).githubIssueId === undefined) {
          (item as any).githubIssueId = undefined;
        }
        if ((item as any).githubIssueUpdatedAt === undefined) {
          (item as any).githubIssueUpdatedAt = undefined;
        }
        if ((item as any).githubIssueNumber !== undefined && (item as any).githubIssueNumber !== null) {
          (item as any).githubIssueNumber = Number((item as any).githubIssueNumber);
        }
        if ((item as any).githubIssueId !== undefined && (item as any).githubIssueId !== null) {
          (item as any).githubIssueId = Number((item as any).githubIssueId);
        }
        if (item.description) {
          item.description = stripWorklogMarkers(item.description);
        }
        // Normalize status to canonical hyphenated form (legacy format path)
        item.status = (normalizeStatusValue(item.status) ?? item.status) as WorkItem['status'];
        item.dependencies = dependencies;
        items.push(item);
        for (const dep of dependencies) {
          dependencyEdges.push({ fromId: dep.from, toId: dep.to, createdAt: new Date().toISOString() });
        }
      }
    } catch (error) {
      console.error(`Error parsing line: ${line}`);
      throw error;
    }
  }
  
  return { items, comments, dependencyEdges, auditResults, kind };
}

/**
 * Get the default data file path
 */
export function getDefaultDataPath(): string {
  return path.join(resolveWorklogDir(), 'worklog-data.jsonl');
}
