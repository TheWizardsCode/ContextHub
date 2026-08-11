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
const counters = new Map();
export function increment(metric, n = 1) {
    const prev = counters.get(metric) || 0;
    counters.set(metric, prev + n);
    if (process.env.WL_SEARCH_TRACE === 'true') {
        try {
            process.stderr.write(`[search-metrics] ${metric} += ${n}\n`);
        }
        catch (_) { }
    }
}
export function snapshot() {
    const out = {};
    for (const [k, v] of counters.entries())
        out[k] = v;
    return out;
}
export function reset() {
    counters.clear();
}
export function diff(before, after) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const out = {};
    for (const k of keys) {
        out[k] = (after[k] || 0) - (before[k] || 0);
    }
    return out;
}
//# sourceMappingURL=search-metrics.js.map