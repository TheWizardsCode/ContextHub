/**
 * Simple GitHub API metrics collector for per-run counters.
 */
export declare function increment(metric: string, n?: number): void;
export declare function snapshot(): Record<string, number>;
export declare function reset(): void;
export declare function diff(before: Record<string, number>, after: Record<string, number>): Record<string, number>;
//# sourceMappingURL=github-metrics.d.ts.map