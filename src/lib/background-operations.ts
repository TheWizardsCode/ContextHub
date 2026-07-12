/**
 * Background operations — reusable background tasks that use WorklogRuntime.
 *
 * Each function in this module wraps a concrete background operation (sync,
 * validation, metrics collection, etc.) as a labelled runtime task so callers
 * can fire-and-forget via `getRuntime().launchTask(label, work)`.
 *
 * Example:
 *
 *   import { getRuntime } from './lib/runtime.js';
 *   import { backgroundSyncToJsonl } from './lib/background-operations.js';
 *
 *   getRuntime().launchTask('auto-sync', () => backgroundSyncToJsonl(dataPath));
 *
 * To add a new background operation:
 *
 *   1. Write an async function here that accepts the minimal dependencies it
 *      needs (db instance, config, etc.).
 *   2. Call it via `getRuntime().launchTask('my-operation', () => myOp(...))`.
 *   3. The runtime's single-flight guard prevents duplicate launches of the
 *      same label while one is already in-flight.
 */

import { getDefaultDataPath, exportToJsonlAsync } from '../jsonl.js';
import type { WorkItem, Comment, DependencyEdge, AuditResult } from '../types.js';

// ---------------------------------------------------------------------------
// Background: sync-to-JSONL
// ---------------------------------------------------------------------------

/**
 * Export worklog data to JSONL in the background.
 *
 * This is a lightweight operation suitable for calling after work-item
 * mutations so the JSONL file stays relatively current without blocking
 * the CLI command flow.
 *
 * @param items           All work items to export.
 * @param comments        All comments to export.
 * @param dependencyEdges Dependency edges (optional).
 * @param auditResults    Audit results (optional).
 * @param dataPath        Path to write the JSONL file (optional; defaults to
 *                        the standard data path).
 */
export async function backgroundSyncToJsonl(
  items: WorkItem[],
  comments: Comment[],
  dataPath?: string,
  dependencyEdges: DependencyEdge[] = [],
  auditResults: AuditResult[] = [],
): Promise<void> {
  const path = dataPath ?? getDefaultDataPath();
  try {
    await exportToJsonlAsync(items, comments, path, dependencyEdges, auditResults);
  } catch {
    // Errors are already logged by the runtime; swallow here.
  }
}
