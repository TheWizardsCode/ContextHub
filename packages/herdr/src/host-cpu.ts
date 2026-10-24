/**
 * packages/herdr/src/host-cpu.ts — host CPU utilisation for the downtime
 * dispatcher's CPU-aware dispatch gate (WL-0MVK0UO3Q002TXW6).
 *
 * The dispatcher gates on local-LLM slot capacity, prefill pacing, code freeze
 * and pane state, but it had no host-CPU signal at all: many concurrent
 * implement/audit sessions could push the machine towards saturation while the
 * worker kept launching MORE panes. This module supplies the metric (a pure,
 * dependency-free leaf so settings/tests can import it without an import
 * cycle):
 *
 *  - {@link parseProcStatCpu} — aggregate `cpu` line of `/proc/stat`;
 *  - {@link cpuPercentFromSamples} — utilisation from two samples;
 *  - {@link loadPerCorePercent} — 1-min load-average fallback (% of cores);
 *  - {@link createHostCpuSampler} — in-memory previous sample + the < 1 s
 *    short-window rule, falling back to the load average, then fail-open;
 *  - {@link DEFAULT_DOWNTIME_CPU_GATE_PERCENT} /
 *    {@link clampDowntimeCpuGatePercent} — the setting default and clamp;
 *  - {@link isCpuGateActive} — the pure gate predicate (`0` disables).
 *
 * Fail-open by construction: nothing here throws, and an unreadable,
 * unparseable or unusable host-metrics environment yields `{ ok: false }`,
 * which every caller treats as "dispatch unchanged". The gate may only ever
 * REFUSE work it can measure; it must never block a tick it cannot evaluate.
 *
 * No new dependency: callers inject the file readers (`node:fs` in the
 * production seam in `index.ts`), so tests never read the real `/proc`.
 */

/**
 * Default CPU threshold (percent) for the dispatcher gate
 * (WL-0MVK0UO3Q002TXW6 AC5): at or above this measured utilisation new
 * implement/audit dispatch is refused. `0` disables the gate.
 */
export const DEFAULT_DOWNTIME_CPU_GATE_PERCENT = 75;

/**
 * Minimum sampling window (ms) for a `/proc/stat` delta to be meaningful
 * (AC1). Two dispatches inside one tick would otherwise measure a
 * near-zero window and produce a misleading 0 % reading that bypasses the
 * gate — those calls use the load-average fallback instead.
 */
export const HOST_CPU_MIN_SAMPLE_WINDOW_MS = 1_000;

/**
 * One aggregate `/proc/stat` CPU sample.
 *
 * `total` sums the busy + idle jiffy counters on the aggregate `cpu` line;
 * `busy` is `total` minus `idle` + `iowait`. Both are monotonic counters, so
 * utilisation comes from the DELTA between two samples.
 */
export interface CpuStatSample {
  /** Non-idle jiffies (total minus idle/iowait) across all cores. */
  busy: number;
  /** All counted jiffies across all cores. */
  total: number;
}

/** Where a CPU reading came from. */
export type HostCpuSource = 'proc-stat' | 'loadavg';

/**
 * One host-CPU reading. `{ ok: false }` means "cannot measure" and every
 * caller must fail open (dispatch unchanged).
 */
export type HostCpuReading =
  | { ok: true; percent: number; source: HostCpuSource }
  | { ok: false };

/**
 * Parse the aggregate `cpu` line of `/proc/stat`.
 *
 * Field order is `user nice system idle iowait irq softirq steal guest
 * guest_nice`. The first eight counters are summed (the `guest*` counters are
 * already included in `user`/`nice`, so counting them again would double
 * count); `idle` is `idle + iowait`. Per-CPU lines (`cpu0`, `cpu1`, …) are
 * ignored — the gate measures the whole host, not one core.
 *
 * @param text - Raw `/proc/stat` contents.
 * @returns The sample, or `null` when the aggregate line is absent or
 *          unusable (missing/negative/non-finite counters, zero total).
 */
export function parseProcStatCpu(text: string): CpuStatSample | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  for (const line of text.split('\n')) {
    if (!/^cpu\s/.test(line)) continue;
    const fields = line.trim().split(/\s+/).slice(1).map(Number);
    // user, nice, system, idle are the historical minimum.
    if (fields.length < 4) return null;
    if (fields.some((value) => !Number.isFinite(value) || value < 0)) return null;
    const counted = fields.slice(0, 8);
    const total = counted.reduce((sum, value) => sum + value, 0);
    if (!Number.isFinite(total) || total <= 0) return null;
    const idle = counted[3] + (counted[4] ?? 0);
    const busy = Math.max(total - idle, 0);
    return { busy, total };
  }
  return null;
}

/**
 * Utilisation percentage between two `/proc/stat` samples.
 *
 * @param prev - The earlier sample (or `null` when unavailable).
 * @param next - The later sample (or `null` when unavailable).
 * @returns `0–100`, or `null` when the total counter did not advance (no
 *          measurable window) or either sample is unusable.
 */
export function cpuPercentFromSamples(
  prev: CpuStatSample | null,
  next: CpuStatSample | null,
): number | null {
  if (prev === null || next === null) return null;
  if (
    !Number.isFinite(prev.busy) ||
    !Number.isFinite(prev.total) ||
    !Number.isFinite(next.busy) ||
    !Number.isFinite(next.total)
  ) {
    return null;
  }
  const totalDelta = next.total - prev.total;
  const busyDelta = next.busy - prev.busy;
  if (!Number.isFinite(totalDelta) || totalDelta <= 0) return null;
  if (!Number.isFinite(busyDelta) || busyDelta < 0) return null;
  const percent = (busyDelta / totalDelta) * 100;
  if (!Number.isFinite(percent)) return null;
  return Math.min(Math.max(percent, 0), 100);
}

/**
 * Parse the 1-minute load average from `/proc/loadavg` (first field).
 *
 * @param text - Raw `/proc/loadavg` contents.
 * @returns The load, or `null` when absent/unparseable/negative.
 */
export function parseLoadAvgLoad1(text: string): number | null {
  if (typeof text !== 'string') return null;
  const first = text.trim().split(/\s+/)[0];
  if (first === undefined || first.length === 0) return null;
  const load1 = Number(first);
  if (!Number.isFinite(load1) || load1 < 0) return null;
  return load1;
}

/**
 * Load-average fallback: 1-min load ÷ core count × 100, capped at 100.
 *
 * Load is not utilisation — run-queue waiters make it an upper-bound proxy —
 * but for a DISPATCH gate the conservative direction is the intended one.
 *
 * @param load1 - 1-minute load average.
 * @param cpuCount - Number of logical cores.
 * @returns `0–100`, or `null` when either input is unusable.
 */
export function loadPerCorePercent(load1: number, cpuCount: number): number | null {
  if (!Number.isFinite(load1) || load1 < 0) return null;
  if (!Number.isFinite(cpuCount) || cpuCount < 1) return null;
  const percent = (load1 / cpuCount) * 100;
  if (!Number.isFinite(percent)) return null;
  return Math.min(Math.max(percent, 0), 100);
}

/** Injectable I/O seams for {@link createHostCpuSampler}. */
export interface HostCpuSamplerDeps {
  /** Read `/proc/stat` (returning `null` when unreadable). */
  readProcStat?: () => string | null;
  /** Read `/proc/loadavg` (returning `null` when unreadable). */
  readLoadAvg?: () => string | null;
  /** Logical core count (defaults to `os.cpus().length`). */
  cpuCount?: () => number;
  /** Injectable clock (defaults to `Date.now`). */
  now?: () => number;
}

/** Read a seam, swallowing a thrown reader (fail-open). */
function safeRead(reader: (() => string | null) | undefined): string | null {
  if (typeof reader !== 'function') return null;
  try {
    const value = reader();
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/** Resolve the core count, swallowing a thrown seam (fail-open). */
function safeCpuCount(reader: (() => number) | undefined): number | null {
  if (typeof reader !== 'function') return null;
  try {
    const value = reader();
    return Number.isFinite(value) && value >= 1 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Create the production-oriented sampler: it holds the previous `/proc/stat`
 * sample IN MEMORY (no disk state) and computes utilisation from the delta
 * across the worker's poll interval.
 *
 * Degradation order (AC1):
 *  1. `/proc/stat` delta, when a previous sample exists and the window is at
 *     least {@link HOST_CPU_MIN_SAMPLE_WINDOW_MS};
 *  2. otherwise the 1-min load-average fallback (`load ÷ cores × 100`);
 *  3. otherwise `{ ok: false }` — fail open, dispatch unchanged.
 *
 * The production seam reads `/proc/stat` and `/proc/loadavg`; tests inject
 * both readers so they never depend on host state.
 *
 * @param deps - Injectable readers/clock (defaults read nothing, so an
 *               unwired sampler fails open).
 * @returns A function returning the current reading; never throws.
 */
export function createHostCpuSampler(
  deps: HostCpuSamplerDeps = {},
): () => HostCpuReading {
  const now = deps.now ?? (() => Date.now());
  let previous: { sample: CpuStatSample; at: number } | null = null;
  return function readHostCpu(): HostCpuReading {
    let at: number;
    try {
      at = now();
    } catch {
      at = Number.NaN;
    }

    const sampleText = safeRead(deps.readProcStat);
    const sample = sampleText === null ? null : parseProcStatCpu(sampleText);
    if (sample !== null) {
      let percent: number | null = null;
      if (
        previous !== null &&
        Number.isFinite(at) &&
        at - previous.at >= HOST_CPU_MIN_SAMPLE_WINDOW_MS
      ) {
        percent = cpuPercentFromSamples(previous.sample, sample);
      }
      // Always advance the stored sample so the next delta starts from this
      // observation (a short-window call must not leave a stale anchor).
      previous = { sample, at };
      if (percent !== null) return { ok: true, percent, source: 'proc-stat' };
    }

    // Fallback: 1-min load average normalised across cores.
    const loadText = safeRead(deps.readLoadAvg);
    const load1 = loadText === null ? null : parseLoadAvgLoad1(loadText);
    if (load1 !== null) {
      const cores = safeCpuCount(deps.cpuCount);
      const percent = cores === null ? null : loadPerCorePercent(load1, cores);
      if (percent !== null) return { ok: true, percent, source: 'loadavg' };
    }

    return { ok: false };
  };
}

/**
 * Clamp the `downtimeCpuGatePercent` setting to `[0, 100]` (AC5). `0`
 * disables the gate; a non-finite/missing/invalid value falls back to the
 * default (75) so a malformed setting can never silence the gate.
 *
 * @param value - Raw setting value.
 * @returns The clamped percentage, or the default when unusable.
 */
export function clampDowntimeCpuGatePercent(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_DOWNTIME_CPU_GATE_PERCENT;
  return Math.min(Math.max(Math.round(value), 0), 100);
}

/**
 * The pure gate predicate (AC2): the gate is active when the configured
 * threshold is positive and the measured utilisation is at or ABOVE it.
 *
 * `thresholdPercent <= 0` disables the gate; an unusable reading (non-finite,
 * negative) can never activate it (fail-open).
 *
 * @param percent - Measured host CPU utilisation (`0–100`).
 * @param thresholdPercent - Configured threshold (`0` disables).
 * @returns true when new implement/audit dispatch must be refused.
 */
export function isCpuGateActive(percent: number, thresholdPercent: number): boolean {
  if (!Number.isFinite(thresholdPercent) || thresholdPercent <= 0) return false;
  if (!Number.isFinite(percent) || percent < 0) return false;
  return percent >= thresholdPercent;
}
