/**
 * Unit tests for the env-gated spawn counter (F2 — WL-0MSGAEC5N006W5QA;
 * CPU/RSS extension — WL-0MVFRR98A008MM19).
 *
 * The counter records `wl` process spawns so the ≥60% spawn-reduction target
 * (parent AC7) can be measured from a simulated multi-pane refresh. Each
 * record also carries the process' own CPU time and peak RSS so a coordinator
 * can total CPU-seconds per refresh cycle without an external sampler.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  recordSpawn,
  readSpawnRecords,
  countSpawnRecords,
  summariseSpawnRecords,
} from '../src/spawn-counter.js';
import { createTempDir, cleanupTempDir } from './test-utils.js';

describe('spawn counter', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = createTempDir();
    file = path.join(dir, 'spawns.log');
    process.env.WL_SPAWN_COUNT_FILE = file;
  });

  afterEach(() => {
    delete process.env.WL_SPAWN_COUNT_FILE;
    delete process.env.WL_SPAWN_COUNT;
    vi.restoreAllMocks();
    cleanupTempDir(dir);
  });

  it('records spawn lines with kind, timestamp and pid', () => {
    recordSpawn('read-work');
    recordSpawn('cache-hit');
    const recs = readSpawnRecords(file);
    expect(recs).toHaveLength(2);
    expect(recs[0].kind).toBe('read-work');
    expect(recs[1].kind).toBe('cache-hit');
    expect(recs[0].pid).toBe(process.pid);
    expect(Number.isFinite(recs[0].ts)).toBe(true);
  });

  it('records CPU time and peak RSS for the process', () => {
    recordSpawn('read-work');
    const [rec] = readSpawnRecords(file);
    expect(rec.cpuMs).not.toBeNull();
    expect(rec.cpuMs).toBeGreaterThan(0);
    expect(rec.maxRssKb).not.toBeNull();
    // Any live Node process has a resident set well above 1 MiB.
    expect(rec.maxRssKb).toBeGreaterThan(1024);
  });

  it('writes the five-field line shape', () => {
    recordSpawn('cache-hit');
    const line = fs.readFileSync(file, 'utf-8').trimEnd();
    const fields = line.split('\t');
    expect(fields).toHaveLength(5);
    expect(fields[0]).toBe('cache-hit');
    expect(Number(fields[1])).toBeGreaterThan(0);
    expect(Number(fields[2])).toBe(process.pid);
    expect(Number(fields[3])).toBeGreaterThan(0); // cpuMs
    expect(Number(fields[4])).toBeGreaterThan(1024); // maxRssKb
  });

  it('parses legacy three-field lines with CPU/RSS reported as null', () => {
    fs.writeFileSync(file, `read-work\t1700000000000\t4242\n`, 'utf-8');
    const [rec] = readSpawnRecords(file);
    expect(rec).toEqual({
      kind: 'read-work',
      ts: 1700000000000,
      pid: 4242,
      cpuMs: null,
      maxRssKb: null,
    });
  });

  it('treats blank CPU/RSS fields as unknown rather than zero', () => {
    fs.writeFileSync(file, `cache-hit\t1700000000000\t4242\t\t\n`, 'utf-8');
    const [rec] = readSpawnRecords(file);
    expect(rec.cpuMs).toBeNull();
    expect(rec.maxRssKb).toBeNull();
  });

  it('counts records, optionally filtered by kind', () => {
    recordSpawn('read-work');
    recordSpawn('cache-hit');
    recordSpawn('read-work');
    expect(countSpawnRecords(file)).toBe(3);
    expect(countSpawnRecords(file, 'read-work')).toBe(2);
    expect(countSpawnRecords(file, 'cache-hit')).toBe(1);
  });

  it('handles an empty or missing file', () => {
    expect(readSpawnRecords(file)).toEqual([]);
    expect(countSpawnRecords(file)).toBe(0);
    expect(summariseSpawnRecords(file)).toEqual({
      total: 0,
      byKind: {},
      cpuSeconds: 0,
      maxRssKb: null,
      missingCpu: 0,
      missingRss: 0,
    });
  });

  it('is a no-op without env configuration (never throws)', () => {
    delete process.env.WL_SPAWN_COUNT_FILE;
    delete process.env.WL_SPAWN_COUNT;
    expect(() => recordSpawn('read-work')).not.toThrow();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('never throws when the record file is unwritable', () => {
    process.env.WL_SPAWN_COUNT_FILE = path.join(dir, 'missing-dir', 'spawns.log');
    expect(() => recordSpawn('read-work')).not.toThrow();
    expect(() => recordSpawn('cache-hit')).not.toThrow();
  });

  it('reports CPU and RSS on the stderr path', () => {
    delete process.env.WL_SPAWN_COUNT_FILE;
    process.env.WL_SPAWN_COUNT = '1';
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(() => recordSpawn('read-work')).not.toThrow();
    const output = write.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('[wl:spawn] read-work');
    expect(output).toMatch(/cpuMs=\d+/);
    expect(output).toMatch(/maxRssKb=\d+/);
  });
});

describe('summariseSpawnRecords', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = createTempDir();
    file = path.join(dir, 'spawns.log');
  });

  afterEach(() => {
    cleanupTempDir(dir);
  });

  it('totals records, per-kind counts, CPU-seconds and peak RSS', () => {
    fs.writeFileSync(
      file,
      [
        'read-work\t1700000000000\t100\t120\t80000',
        'cache-hit\t1700000000001\t101\t40\t60000',
        'read-work\t1700000000002\t102\t260\t120000',
        '',
      ].join('\n'),
      'utf-8'
    );
    const summary = summariseSpawnRecords(file);
    expect(summary.total).toBe(3);
    expect(summary.byKind).toEqual({ 'read-work': 2, 'cache-hit': 1 });
    expect(summary.cpuSeconds).toBeCloseTo(0.42, 3);
    expect(summary.maxRssKb).toBe(120000);
    expect(summary.missingCpu).toBe(0);
    expect(summary.missingRss).toBe(0);
  });

  it('counts unknown CPU/RSS separately instead of under-reporting silently', () => {
    fs.writeFileSync(
      file,
      ['read-work\t1700000000000\t100\t500\t90000', 'cache-hit\t1700000000001\t101'].join('\n'),
      'utf-8'
    );
    const summary = summariseSpawnRecords(file);
    expect(summary.total).toBe(2);
    expect(summary.cpuSeconds).toBeCloseTo(0.5, 3);
    expect(summary.maxRssKb).toBe(90000);
    expect(summary.missingCpu).toBe(1);
    expect(summary.missingRss).toBe(1);
  });

  it('aggregates a file produced by recordSpawn in this process', () => {
    process.env.WL_SPAWN_COUNT_FILE = file;
    try {
      recordSpawn('read-work');
      recordSpawn('read-work');
      recordSpawn('cache-hit');
    } finally {
      delete process.env.WL_SPAWN_COUNT_FILE;
    }
    const summary = summariseSpawnRecords(file);
    expect(summary.total).toBe(3);
    expect(summary.byKind).toEqual({ 'read-work': 2, 'cache-hit': 1 });
    expect(summary.cpuSeconds).toBeGreaterThan(0);
    expect(summary.maxRssKb).toBeGreaterThan(1024);
    expect(summary.missingCpu).toBe(0);
    expect(summary.missingRss).toBe(0);
  });
});
