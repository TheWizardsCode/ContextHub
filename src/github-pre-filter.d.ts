import { WorkItem, Comment } from './types.js';
export interface PreFilterResult {
    filteredItems: WorkItem[];
    filteredComments: Comment[];
    totalCandidates: number;
    skippedCount: number;
    deletedWithoutIssueCount: number;
}
export declare function readLastPushTimestamp(db?: {
    getMetadata?: (k: string) => string | null;
}, repo?: string | null): string | null;
export declare function writeLastPushTimestamp(ts: string, db?: {
    setMetadata?: (k: string, v: string) => void;
}, repo?: string | null): void;
export declare function filterItemsForPush(items: WorkItem[], comments: Comment[], lastPushTimestamp: string | null): PreFilterResult;
//# sourceMappingURL=github-pre-filter.d.ts.map