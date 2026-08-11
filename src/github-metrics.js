/**
 * Simple GitHub API metrics collector for per-run counters.
 */
const counters = new Map();
export function increment(metric, n = 1) {
    const prev = counters.get(metric) || 0;
    counters.set(metric, prev + n);
    // Optional debug tracing to stderr so it doesn't pollute normal stdout output.
    if (process.env.WL_GITHUB_TRACE === 'true') {
        try {
            process.stderr.write(`[github-metrics] ${metric} += ${n}\n`);
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
//# sourceMappingURL=github-metrics.js.map