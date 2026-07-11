/**
 * Simple GitHub API metrics collector for per-run counters.
 */

const counters: Map<string, number> = new Map();

export function increment(metric: string, n = 1): void {
  const prev = counters.get(metric) || 0;
  counters.set(metric, prev + n);
  // Optional debug tracing to stderr so it doesn't pollute normal stdout output.
  if (process.env.WL_GITHUB_TRACE === 'true') {
    try { process.stderr.write(`[github-metrics] ${metric} += ${n}\n`); } catch (_) {}
  }
}

export function snapshot(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of counters.entries()) out[k] = v;
  return out;
}

export function reset(): void {
  counters.clear();
}

export function diff(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const keys = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
  const out: Record<string, number> = {};
  for (const k of keys) {
    out[k] = (after[k] || 0) - (before[k] || 0);
  }
  return out;
}
