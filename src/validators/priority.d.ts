import type { WorkItemPriority } from '../types.js';
export declare const CANONICAL_PRIORITIES: readonly WorkItemPriority[];
export declare const PRIORITY_MAP: Record<string, WorkItemPriority>;
export declare function normalizePriority(raw: string): WorkItemPriority | null;
export declare function isValidPriority(raw: string): boolean;
export declare function isMappablePriority(raw: string): boolean;
//# sourceMappingURL=priority.d.ts.map