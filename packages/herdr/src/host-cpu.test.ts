/**
 * packages/herdr/src/host-cpu.test.ts — unit tests for the host-CPU metric
 * module (WL-0MVK0UO3Q002TXW6 AC1/AC5).
 *
 * Covers the `/proc/stat` parser, the delta maths, the short-window rule, the
 * load-average fallback, the fail-open paths, the settings clamp and the pure
 * gate predicate. The sampler never reads the real `/proc` — every seam is
 * injected, so the suite is deterministic on any host.
 */

import { describe, it, expect } from 'vitest';
import {
  parseProcStatCpu,
  cpuPercentFromSamples,
  loadPerCorePercent,
  parseLoadAvgLoad1,
  createHostCpuSampler,
  isCpuGateActive,
  clampDowntimeCpuGatePercent,
  DEFAULT_DOWNTIME_CPU_GATE_PERCENT,
  HOST_CPU_MIN_SAMPLE_WINDOW_MS,
  type CpuStatSample,
} from './host-cpu.js';

// ── parseProcStatCpu ──────────────────────────────────────────────────

describe('parseProcStatCpu', () => {
  it('parses the aggregate cpu line (idle+iowait are idle)', () => {
    // user=100 nice=50 system=25 idle=500 iowait=100 irq=5 softirq=10 steal=20
    const text = [
      'cpu  100 50 25 500 100 5 10 20 0 0',
      'cpu0 50 25 12 250 50 2 5 10 0 0',
      'intr 12345',
    ].join('\n');
    const sample = parseProcStatCpu(text);
    expect(sample).not.toBeNull();
    // total = first 8 fields; guest fields are NOT double counted.
    expect(sample!.total).toBe(100 + 50 + 25 + 500 + 100 + 5 + 10 + 20);
    // busy = total - idle - iowait.
    expect(sample!.busy).toBe(100 + 50 + 25 + 5 + 10 + 20);
  });

  it('handles a minimal 4-field aggregate line', () => {
    const sample = parseProcStatCpu('cpu  100 50 25 400\n');
    expect(sample).toEqual({ busy: 175, total: 575 });
  });

  it('ignores per-cpu lines and non-cpu lines', () => {
    // Only cpu0/cpu1 present → no aggregate → null.
    expect(parseProcStatCpu('cpu0 1 2 3 4\ncpu1 1 2 3 4\n')).toBeNull();
  });

  it('returns null for missing, empty or malformed input', () => {
    expect(parseProcStatCpu('')).toBeNull();
    expect(parseProcStatCpu('intr 12345\nctxt 99\n')).toBeNull();
    expect(parseProcStatCpu('cpu  not numbers here\n')).toBeNull();
    expect(parseProcStatCpu('cpu  1 2 3\n')).toBeNull(); // fewer than 4 fields
    expect(parseProcStatCpu('cpu  -1 2 3 4\n')).toBeNull(); // negative
    expect(parseProcStatCpu('cpu  1 2 3 4 5 6 7 8 9 10\n')).not.toBeNull();
  });

  it('returns null when the total is zero', () => {
    expect(parseProcStatCpu('cpu  0 0 0 0\n')).toBeNull();
  });
});

// ── cpuPercentFromSamples ─────────────────────────────────────────────

describe('cpuPercentFromSamples', () => {
  it('computes the busy/total delta percentage', () => {
    const prev: CpuStatSample = { busy: 100, total: 200 };
    const next: CpuStatSample = { busy: 150, total: 300 };
    expect(cpuPercentFromSamples(prev, next)).toBe(50);
  });

  it('returns 100 at full utilisation and null when nothing advanced', () => {
    const prev: CpuStatSample = { busy: 100, total: 200 };
    expect(cpuPercentFromSamples(prev, { busy: 200, total: 300 })).toBe(100);
    // A zero total delta is "no measurable window": utilisation is undefined,
    // so the sampler falls back to the load average (never a misleading 0 %).
    expect(cpuPercentFromSamples(prev, prev)).toBeNull();
  });

  it('clamps to the 0–100 range (defensive)', () => {
    const prev: CpuStatSample = { busy: 100, total: 200 };
    // busy advanced MORE than total (counter skew) → clamp to 100.
    expect(cpuPercentFromSamples(prev, { busy: 250, total: 260 })).toBe(100);
  });

  it('returns null when either sample is missing or unusable', () => {
    expect(cpuPercentFromSamples(null, { busy: 1, total: 2 })).toBeNull();
    expect(cpuPercentFromSamples({ busy: 1, total: 2 }, null)).toBeNull();
  });

  it('returns null when the total delta is zero (no measurable window)', () => {
    // Monotonic counters never go backwards; a non-positive delta is unusable.
    expect(cpuPercentFromSamples({ busy: 200, total: 300 }, { busy: 250, total: 300 })).toBeNull();
  });
});

// ── loadPerCorePercent / parseLoadAvgLoad1 ────────────────────────────

describe('loadPerCorePercent', () => {
  it('returns load1 ÷ cores × 100', () => {
    expect(loadPerCorePercent(2, 8)).toBe(25);
    expect(loadPerCorePercent(4, 4)).toBe(100);
  });

  it('caps at 100 (bound) and never exceeds it', () => {
    expect(loadPerCorePercent(12, 2)).toBe(100);
    expect(loadPerCorePercent(0, 4)).toBe(0);
  });

  it('returns null for unusable inputs (fail-open)', () => {
    expect(loadPerCorePercent(Number.NaN, 4)).toBeNull();
    expect(loadPerCorePercent(-1, 4)).toBeNull();
    expect(loadPerCorePercent(1, Number.NaN)).toBeNull();
    expect(loadPerCorePercent(1, 0)).toBeNull();
  });
});

describe('parseLoadAvgLoad1', () => {
  it('parses the first field', () => {
    expect(parseLoadAvgLoad1('1.50 0.75 0.50 2/345 12345\n')).toBe(1.5);
  });

  it('returns null for unusable input', () => {
    expect(parseLoadAvgLoad1('')).toBeNull();
    expect(parseLoadAvgLoad1('abc 1 2 3 4')).toBeNull();
    expect(parseLoadAvgLoad1('-2.5 1 2 3 4')).toBeNull();
  });
});

// ── createHostCpuSampler ──────────────────────────────────────────────

describe('createHostCpuSampler', () => {
  // A stat text whose busy counter advances by 10 jiffies per 100 total.
  const statAt = (busy: number, total: number): string =>
    `cpu  ${busy} 0 0 ${total - busy - 50} 50 0 0 0 0 0\n`;

  it('first call has no previous sample → falls back to the load average', () => {
    const sampler = createHostCpuSampler({
      readProcStat: () => statAt(100, 400),
      readLoadAvg: () => '2.00 1.00 0.50 1/4 99\n',
      cpuCount: () => 8,
    });
    const reading = sampler();
    expect(reading).toEqual({ ok: true, percent: 25, source: 'loadavg' });
  });

  it('a second call at least 1 s later reports the /proc/stat delta', () => {
    let at = 1_000;
    let stat = statAt(100, 400);
    const sampler = createHostCpuSampler({
      readProcStat: () => stat,
      readLoadAvg: () => '9.00 9.00 9.00 1/4 99\n', // fallback would be 112→100
      cpuCount: () => 1,
      now: () => at,
    });
    const first = sampler();
    expect(first).toEqual({ ok: true, percent: 100, source: 'loadavg' });
    // Advance to the next poll tick (10 s) with +100 busy of +400 total. The
    // load-average fallback would report 100, so 25 can only come from the
    // /proc/stat delta.
    at += 10_000;
    stat = statAt(200, 800);
    expect(sampler()).toEqual({ ok: true, percent: 25, source: 'proc-stat' });
  });

  it('a second call inside the 1 s window falls back to the load average', () => {
    let at = 1_000;
    const sampler = createHostCpuSampler({
      readProcStat: () => statAt(100, 400),
      readLoadAvg: () => '2.00 1.00 0.50 1/4 99\n',
      cpuCount: () => 8,
      now: () => at,
    });
    sampler(); // seeds the previous sample via the loadavg fallback
    at += 100; // < 1 s window
    const shortWindow = sampler();
    expect(shortWindow.source).toBe('loadavg');
  });

  it('falls back to the load average when /proc/stat is unreadable', () => {
    const sampler = createHostCpuSampler({
      readProcStat: () => null,
      readLoadAvg: () => '4.00 2.00 1.00 1/4 99\n',
      cpuCount: () => 4,
    });
    expect(sampler()).toEqual({ ok: true, percent: 100, source: 'loadavg' });
  });

  it('fails open when /proc/stat is unparseable and the load average is unreadable', () => {
    const sampler = createHostCpuSampler({
      readProcStat: () => 'garbage that cannot be parsed\n',
      readLoadAvg: () => null,
    });
    expect(sampler()).toEqual({ ok: false });
  });

  it('fails open when every seam throws or is unwired', () => {
    const throwing = () => {
      throw new Error('EPERM');
    };
    const sampler = createHostCpuSampler({
      readProcStat: throwing,
      readLoadAvg: throwing,
      cpuCount: throwing,
      now: throwing,
    });
    expect(sampler()).toEqual({ ok: false });
    // Unwired sampler (no seams at all) also fails open.
    expect(createHostCpuSampler()()).toEqual({ ok: false });
  });

  it('a stale stat delta (zero total delta) falls back to the load average (no misleading 0%)', () => {
    let at = 1_000;
    const stat = statAt(100, 300);
    const sampler = createHostCpuSampler({
      readProcStat: () => stat, // identical text on both calls → total delta 0
      readLoadAvg: () => '2.00 1.00 0.50 1/4 99\n',
      cpuCount: () => 4,
      now: () => at,
    });
    sampler();
    at += 10_000;
    const reading = sampler();
    expect(reading).toEqual({ ok: true, percent: 50, source: 'loadavg' });
  });
});

// ── clampDowntimeCpuGatePercent ───────────────────────────────────────

describe('clampDowntimeCpuGatePercent', () => {
  it('defaults to 75', () => {
    expect(DEFAULT_DOWNTIME_CPU_GATE_PERCENT).toBe(75);
    expect(clampDowntimeCpuGatePercent(Number.NaN)).toBe(75);
  });

  it('clamps to [0, 100] and preserves an in-range value', () => {
    expect(clampDowntimeCpuGatePercent(-10)).toBe(0);
    expect(clampDowntimeCpuGatePercent(150)).toBe(100);
    expect(clampDowntimeCpuGatePercent(80)).toBe(80);
    expect(clampDowntimeCpuGatePercent(0)).toBe(0); // 0 disables the gate
  });

  it('rounds fractional values', () => {
    expect(clampDowntimeCpuGatePercent(74.6)).toBe(75);
  });
});

// ── isCpuGateActive ───────────────────────────────────────────────────

describe('isCpuGateActive', () => {
  it('blocks at or above the threshold and allows just below it', () => {
    expect(isCpuGateActive(75, 75)).toBe(true);
    expect(isCpuGateActive(90, 75)).toBe(true);
    expect(isCpuGateActive(74.9, 75)).toBe(false);
    expect(isCpuGateActive(0, 100)).toBe(false);
  });

  it('threshold 0 disables the gate', () => {
    expect(isCpuGateActive(100, 0)).toBe(false);
  });

  it('never activates on an unusable threshold or reading (fail-open)', () => {
    expect(isCpuGateActive(Number.NaN, 75)).toBe(false);
    expect(isCpuGateActive(-1, 75)).toBe(false);
    expect(isCpuGateActive(90, Number.NaN)).toBe(false);
    expect(isCpuGateActive(90, -5)).toBe(false);
  });
});
