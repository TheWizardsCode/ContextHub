/**
 * JSONL (JSON Lines) import/export functionality
 * This format is Git-friendly as each work item is on a separate line
 */
import { WorkItem, Comment, DependencyEdge, WorkItemDependency, AuditResult } from './types.js';
export declare function dependenciesFromEdges(edges: DependencyEdge[], itemId: string): WorkItemDependency[];
/**
 * Export work items, comments, and audit results to a JSONL file
 */
export declare function exportToJsonl(items: WorkItem[], comments: Comment[], filepath: string, dependencyEdges?: DependencyEdge[], auditResults?: AuditResult[]): number;
/**
 * Asynchronously export work items and comments to a JSONL file.
 *
 * Uses non-blocking filesystem operations to avoid blocking the Node.js event
 * loop on large exports.
 */
export declare function exportToJsonlAsync(items: WorkItem[], comments: Comment[], filepath: string, dependencyEdges?: DependencyEdge[], auditResults?: AuditResult[], options?: any): Promise<number>;
/**
 * Import work items, comments, and audit results from a JSONL file
 */
export declare function importFromJsonl(filepath: string): {
    items: WorkItem[];
    comments: Comment[];
    dependencyEdges: DependencyEdge[];
    auditResults: AuditResult[];
};
export declare function importFromJsonlContent(content: string): {
    items: WorkItem[];
    comments: Comment[];
    dependencyEdges: DependencyEdge[];
    auditResults: AuditResult[];
};
/**
 * Get the default data file path
 */
export declare function getDefaultDataPath(): string;
//# sourceMappingURL=jsonl.d.ts.map