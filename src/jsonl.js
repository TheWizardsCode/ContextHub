/**
 * JSONL (JSON Lines) import/export functionality
 * This format is Git-friendly as each work item is on a separate line
 */
import * as fs from 'fs';
import * as path from 'path';
import { stripWorklogMarkers } from './github.js';
import { resolveWorklogDir } from './worklog-paths.js';
import { normalizeStatusValue } from './status-stage-rules.js';
function normalizeForStableJson(value) {
    if (value === null || value === undefined)
        return value;
    if (Array.isArray(value))
        return value.map(v => normalizeForStableJson(v));
    if (typeof value !== 'object')
        return value;
    const out = {};
    for (const key of Object.keys(value).sort()) {
        out[key] = normalizeForStableJson(value[key]);
    }
    return out;
}
function stableStringify(value) {
    return JSON.stringify(normalizeForStableJson(value));
}
function normalizeDependencies(input) {
    if (!Array.isArray(input))
        return [];
    return input
        .filter(edge => edge && typeof edge.from === 'string' && typeof edge.to === 'string')
        .map(edge => ({ from: edge.from, to: edge.to }));
}
export function dependenciesFromEdges(edges, itemId) {
    return edges
        .filter(edge => edge.fromId === itemId)
        .map(edge => ({ from: edge.fromId, to: edge.toId }))
        .sort((a, b) => {
        const fromDiff = a.from.localeCompare(b.from);
        if (fromDiff !== 0)
            return fromDiff;
        return a.to.localeCompare(b.to);
    });
}
function mergeDependencyEdges(edges) {
    const merged = new Map();
    for (const edge of edges) {
        merged.set(`${edge.fromId}::${edge.toId}`, edge);
    }
    return Array.from(merged.values());
}
function buildJsonlContent(items, comments, dependencyEdges = [], auditResults = []) {
    const lines = [];
    const sortedItems = [...items].sort((a, b) => a.id.localeCompare(b.id));
    const normalizedEdges = mergeDependencyEdges(dependencyEdges);
    const sortedComments = [...comments].sort((a, b) => {
        const wi = a.workItemId.localeCompare(b.workItemId);
        if (wi !== 0)
            return wi;
        const ca = a.createdAt.localeCompare(b.createdAt);
        if (ca !== 0)
            return ca;
        return a.id.localeCompare(b.id);
    });
    const sortedAudits = [...auditResults].sort((a, b) => a.workItemId.localeCompare(b.workItemId));
    // Add work items
    sortedItems.forEach(item => {
        const dependencies = dependenciesFromEdges(normalizedEdges, item.id);
        const itemWithDeps = {
            ...item,
            dependencies: dependencies.length > 0 ? dependencies : [],
        };
        lines.push(stableStringify({ type: 'workitem', data: itemWithDeps }));
    });
    // Add comments
    sortedComments.forEach(comment => {
        // Ensure comment includes the new optional GitHub mapping fields when present
        const outComment = { ...comment };
        if (outComment.githubCommentId === undefined)
            delete outComment.githubCommentId;
        if (outComment.githubCommentUpdatedAt === undefined)
            delete outComment.githubCommentUpdatedAt;
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
export function exportToJsonl(items, comments, filepath, dependencyEdges = [], auditResults = []) {
    const content = buildJsonlContent(items, comments, dependencyEdges, auditResults);
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
export async function exportToJsonlAsync(items, comments, filepath, dependencyEdges = [], auditResults = [], options) {
    // Prefer worker_threads to move CPU-heavy JSONL building/writing off the
    // main event loop. If worker_threads are unavailable or worker construction
    // fails, fall back to the previous in-process async implementation.
    const onProgress = options?.onProgress;
    // Inline worker code that performs stable JSONL serialization and reports
    // progress back to the parent via parentPort.postMessage(). Using an
    // inline eval'd worker avoids having to manage a separate compiled worker
    // asset which keeps the change minimal.
    const tryWorker = async () => {
        // Dynamically require to defer errors on unsupported environments
        let Worker;
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
            Worker = require('worker_threads').Worker;
        }
        catch (err) {
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
            "  const { items, comments, dependencyEdges, auditResults, filepath } = workerData;",
            "  const dir = path.dirname(filepath); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });",
            "  const tempName = path.basename(filepath) + '.tmp-' + Math.random().toString(36).slice(2,10);",
            "  const tempPath = path.join(dir, tempName);",
            "  const out = fs.createWriteStream(tempPath, { encoding: 'utf8' });",
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
        return new Promise((resolve, reject) => {
            const worker = new Worker(workerCode, { eval: true, workerData: { items, comments, dependencyEdges, auditResults, filepath } });
            worker.on('message', (msg) => {
                if (!msg || typeof msg !== 'object')
                    return;
                if (msg.type === 'progress') {
                    try {
                        onProgress?.({ type: 'progress', percent: msg.percent, itemsProcessed: msg.itemsProcessed });
                    }
                    catch (_) { }
                }
                else if (msg.type === 'done') {
                    try {
                        onProgress?.({ type: 'done', mtimeMs: msg.mtimeMs });
                    }
                    catch (_) { }
                    resolve(msg.mtimeMs);
                }
                else if (msg.type === 'error') {
                    try {
                        onProgress?.({ type: 'error', error: msg.error });
                    }
                    catch (_) { }
                    reject(new Error(msg.error));
                }
            });
            worker.on('error', (err) => {
                try {
                    onProgress?.({ type: 'error', error: err.message });
                }
                catch (_) { }
                reject(err);
            });
            worker.on('exit', (code) => {
                if (code !== 0) {
                    const errMsg = `Worker exited with code ${code}`;
                    try {
                        onProgress?.({ type: 'error', error: errMsg });
                    }
                    catch (_) { }
                    reject(new Error(errMsg));
                }
            });
        });
    };
    try {
        return await tryWorker();
    }
    catch (err) {
        // Worker-based export failed; fall back to previous in-process path.
        try {
            const content = buildJsonlContent(items, comments, dependencyEdges, auditResults);
            const dir = path.dirname(filepath);
            const tempName = `${path.basename(filepath)}.tmp-${Math.random().toString(36).slice(2, 10)}`;
            const tempPath = path.join(dir, tempName);
            await fs.promises.mkdir(dir, { recursive: true });
            try {
                await fs.promises.writeFile(tempPath, content, 'utf-8');
                await fs.promises.rename(tempPath, filepath);
            }
            catch (error) {
                try {
                    await fs.promises.unlink(tempPath);
                }
                catch { }
                throw error;
            }
            const stats = await fs.promises.stat(filepath);
            // Best-effort progress callback for the fallback path
            try {
                onProgress?.({ type: 'done', mtimeMs: stats.mtimeMs });
            }
            catch (_) { }
            return stats.mtimeMs;
        }
        catch (finalErr) {
            throw finalErr;
        }
    }
}
/**
 * Import work items, comments, and audit results from a JSONL file
 */
export function importFromJsonl(filepath) {
    if (!fs.existsSync(filepath)) {
        throw new Error(`File not found: ${filepath}`);
    }
    const content = fs.readFileSync(filepath, 'utf-8');
    return importFromJsonlContent(content);
}
export function importFromJsonlContent(content) {
    const lines = content.split('\n').filter(line => line.trim() !== '');
    const items = [];
    const comments = [];
    const dependencyEdges = [];
    const auditResults = [];
    for (const line of lines) {
        try {
            const parsed = JSON.parse(line);
            // Handle new format with type field
            if (parsed.type === 'workitem' && parsed.data) {
                const item = parsed.data;
                const dependencies = normalizeDependencies(item.dependencies);
                // Ensure backward compatibility
                if (item.assignee === undefined) {
                    item.assignee = '';
                }
                if (item.stage === undefined) {
                    item.stage = '';
                }
                if (item.issueType === undefined) {
                    item.issueType = '';
                }
                if (item.createdBy === undefined) {
                    item.createdBy = '';
                }
                if (item.deletedBy === undefined) {
                    item.deletedBy = '';
                }
                if (item.deleteReason === undefined) {
                    item.deleteReason = '';
                }
                if (item.sortIndex === undefined) {
                    item.sortIndex = 0;
                }
                if (item.risk === undefined) {
                    item.risk = '';
                }
                if (item.effort === undefined) {
                    item.effort = '';
                }
                if (item.githubIssueNumber === undefined) {
                    item.githubIssueNumber = undefined;
                }
                if (item.githubIssueId === undefined) {
                    item.githubIssueId = undefined;
                }
                if (item.githubIssueUpdatedAt === undefined) {
                    item.githubIssueUpdatedAt = undefined;
                }
                if (item.githubIssueNumber !== undefined && item.githubIssueNumber !== null) {
                    item.githubIssueNumber = Number(item.githubIssueNumber);
                }
                if (item.githubIssueId !== undefined && item.githubIssueId !== null) {
                    item.githubIssueId = Number(item.githubIssueId);
                }
                if (item.description) {
                    item.description = stripWorklogMarkers(item.description);
                }
                // Preserve presence/absence of the new boolean field so round-trip
                // export/import does not introduce properties that weren't in the source.
                if (item.needsProducerReview !== undefined) {
                    item.needsProducerReview = Boolean(item.needsProducerReview);
                }
                // Normalize status to canonical hyphenated form (e.g. in_progress -> in-progress)
                // on import so all downstream consumers see consistent values.
                item.status = (normalizeStatusValue(item.status) ?? item.status);
                item.dependencies = dependencies;
                items.push(item);
                for (const dep of dependencies) {
                    dependencyEdges.push({ fromId: dep.from, toId: dep.to, createdAt: new Date().toISOString() });
                }
            }
            else if (parsed.type === 'comment' && parsed.data) {
                const comment = parsed.data;
                if (comment.comment) {
                    comment.comment = stripWorklogMarkers(comment.comment);
                }
                // Preserve optional GitHub mapping fields when present in JSONL
                const normalized = { ...comment };
                if (normalized.githubCommentId === undefined)
                    normalized.githubCommentId = undefined;
                if (normalized.githubCommentUpdatedAt === undefined)
                    normalized.githubCommentUpdatedAt = undefined;
                comments.push(normalized);
            }
            else if (parsed.type === 'audit_result' && parsed.data) {
                const audit = parsed.data;
                auditResults.push(audit);
            }
            else if (parsed.type === undefined && !parsed.data) {
                // Handle old format (no type field, no data wrapper) - assume it's a work item
                console.warn(`Warning: Found entry without type field, assuming it's a work item. Consider migrating to the new format.`);
                const item = parsed;
                const dependencies = normalizeDependencies(item.dependencies);
                if (item.assignee === undefined) {
                    item.assignee = '';
                }
                if (item.stage === undefined) {
                    item.stage = '';
                }
                if (item.issueType === undefined) {
                    item.issueType = '';
                }
                if (item.createdBy === undefined) {
                    item.createdBy = '';
                }
                if (item.deletedBy === undefined) {
                    item.deletedBy = '';
                }
                if (item.deleteReason === undefined) {
                    item.deleteReason = '';
                }
                if (item.sortIndex === undefined) {
                    item.sortIndex = 0;
                }
                if (item.risk === undefined) {
                    item.risk = '';
                }
                if (item.effort === undefined) {
                    item.effort = '';
                }
                if (item.githubIssueNumber === undefined) {
                    item.githubIssueNumber = undefined;
                }
                if (item.githubIssueId === undefined) {
                    item.githubIssueId = undefined;
                }
                if (item.githubIssueUpdatedAt === undefined) {
                    item.githubIssueUpdatedAt = undefined;
                }
                if (item.githubIssueNumber !== undefined && item.githubIssueNumber !== null) {
                    item.githubIssueNumber = Number(item.githubIssueNumber);
                }
                if (item.githubIssueId !== undefined && item.githubIssueId !== null) {
                    item.githubIssueId = Number(item.githubIssueId);
                }
                if (item.description) {
                    item.description = stripWorklogMarkers(item.description);
                }
                // Normalize status to canonical hyphenated form (legacy format path)
                item.status = (normalizeStatusValue(item.status) ?? item.status);
                item.dependencies = dependencies;
                items.push(item);
                for (const dep of dependencies) {
                    dependencyEdges.push({ fromId: dep.from, toId: dep.to, createdAt: new Date().toISOString() });
                }
            }
        }
        catch (error) {
            console.error(`Error parsing line: ${line}`);
            throw error;
        }
    }
    return { items, comments, dependencyEdges, auditResults };
}
/**
 * Get the default data file path
 */
export function getDefaultDataPath() {
    return path.join(resolveWorklogDir(), 'worklog-data.jsonl');
}
//# sourceMappingURL=jsonl.js.map