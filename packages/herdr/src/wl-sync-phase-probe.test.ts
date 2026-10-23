/**
 * `wl sync` persist-phase probe contract (F2 — WL-0MVJV2NNG00771C6).
 *
 * The probe exists so the sync breakdown is re-runnable rather than a one-off
 * measurement. Two properties matter and can regress silently:
 *
 *   1. SAFETY — the probe must never modify the store it is pointed at (it
 *      copies the SQLite file into a temp dir first). A broker/worklog store
 *      corrupted by a profiling tool would be far worse than the slow sync.
 *   2. COVERAGE — every phase of `performSync`'s persist pipeline
 *      (open → read-local → parse-jsonl → merge → persist-items →
 *      persist-comments → export-jsonl) is reported with wall and CPU time.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { generateLargeWorklog, LARGE_DB_PROFILES } from '../test/perf/large-db-harness.js';
import {
  formatSyncPhaseReport,
  parseProbeArgs,
  profileSyncPhases,
} from '../test/perf/wl-sync-phase-probe.js';

describe('wl sync persist-phase probe', () => {
  it('reports every persist phase without modifying the input store', async () => {
    const fixture = generateLargeWorklog(
      {
        ...LARGE_DB_PROFILES.default,
        items: 40,
        descriptionChars: 200,
        commentsPerItem: 1,
        commentChars: 80,
        parentGroups: 4,
        childrenPerParent: 2,
        grandchildrenPerParent: 1,
        expandedParents: 2,
      },
      { prefix: 'SYN' },
    );

    try {
      const before = fs.statSync(fixture.dbPath);

      const report = await profileSyncPhases({ worklogDir: fixture.worklogDir });

      // Safety: the profiled store is untouched (same size and mtime).
      const after = fs.statSync(fixture.dbPath);
      expect(after.size).toBe(before.size);
      expect(after.mtimeMs).toBe(before.mtimeMs);

      expect(report.phases.map((phase) => phase.phase)).toEqual([
        'sqlite-open',
        'read-local',
        'parse-jsonl',
        'merge',
        'persist-items',
        'persist-comments',
        'export-jsonl',
      ]);
      expect(report.dataset.items).toBe(fixture.itemCount);
      expect(report.dataset.comments).toBeGreaterThan(0);
      expect(report.dataset.jsonlBytes).toBeGreaterThan(0);
      expect(report.dataset.dbSizeMb).toBeGreaterThan(0);
      for (const phase of report.phases) {
        expect(phase.wallMs, phase.phase).toBeGreaterThanOrEqual(0);
        expect(phase.cpuMs, phase.phase).toBeGreaterThanOrEqual(0);
        expect(phase.note.length, phase.phase).toBeGreaterThan(0);
      }
      expect(report.totalWallMs).toBeCloseTo(
        Math.round(report.phases.reduce((total, phase) => total + phase.wallMs, 0) * 10) / 10,
        1,
      );

      const text = formatSyncPhaseReport(report);
      for (const phase of report.phases) expect(text).toContain(phase.phase);
      expect(text).toContain(`${report.dataset.items} items`);
    } finally {
      fixture.cleanup();
    }
  });

  it('parses and validates its CLI arguments', () => {
    expect(parseProbeArgs(['--worklog-dir', '/tmp/x/.worklog', '--json'])).toEqual({
      worklogDir: '/tmp/x/.worklog',
      keep: false,
      json: true,
    });
    expect(parseProbeArgs(['--jsonl', '/tmp/data.jsonl', '--keep'])).toEqual({
      jsonlPath: '/tmp/data.jsonl',
      keep: true,
      json: false,
    });
    expect(() => parseProbeArgs(['--worklog-dir'])).toThrow(/requires a path/);
    expect(() => parseProbeArgs(['--bogus'])).toThrow(/unknown option/);
    expect(path.isAbsolute('/tmp/x/.worklog')).toBe(true);
  });
});
