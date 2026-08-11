import { WorkItem } from '../types.js';
import type { MergeOptions } from '../sync.js';
/**
 * Check if a value appears to be a default/empty value
 */
export declare function isDefaultValue(value: unknown, field: string, options?: MergeOptions): boolean;
export declare function stableValueKey(value: unknown): string;
export declare function stableItemKey(item: WorkItem): string;
export declare function mergeTags(a: string[] | undefined, b: string[] | undefined): string[];
//# sourceMappingURL=merge-utils.d.ts.map