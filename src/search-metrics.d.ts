/**
 * Simple search metrics collector for per-run counters.
 *
 * Tracks how often each ID-search path is exercised so operators can
 * monitor rollout health and debug ID-matching behaviour.
 *
 * Metric names follow the pattern `search.<path>`:
 *   search.exact_id       — full prefixed ID matched exactly
 *   search.prefix_resolved — bare token resolved via repo prefix
 *   search.partial_id     — substring match on work item ID
 *   search.fts            — FTS path used for text query
 *   search.fallback       — application-level fallback used
 *   search.total          — total search() invocations
 */
export declare function increment(metric: string, n?: number): void;
export declare function snapshot(): Record<string, number>;
export declare function reset(): void;
export declare function diff(before: Record<string, number>, after: Record<string, number>): Record<string, number>;
//# sourceMappingURL=search-metrics.d.ts.map