/**
 * Tests for the shared downtime-worker test scaffolding
 * (WL-0MV4V0V8Z003PBQ2).
 *
 * Pins the behaviour every split downtime test file depends on: `makeDeps`
 * default/override semantics, the temporary-directory helpers' create and
 * cleanup contract, and the downtime-log writers' on-disk shape. These are
 * the primitives the split suite imports, so a regression here would silently
 * weaken every consumer.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ago,
  createTempDirTracker,
  makeDeps,
  makeTempDir,
  writeDowntimeLog,
  writeRawDowntimeLog,
} from './downtime-worker.fixtures.js';

describe('makeDeps', () => {
  it('returns neutral default deps that resolve to "nothing to do"', async () => {
    const deps = makeDeps();
    const cwd = '/repo';

    await expect(deps.getHerdrListHead(cwd)).resolves.toEqual({ ok: true, items: [] });
    await expect(deps.getNextItem('intake_complete', cwd)).resolves.toEqual({
      ok: true,
      candidate: null,
    });
    await expect(deps.getNextAuditCandidate(cwd)).resolves.toEqual({ ok: true, candidate: null });
    await expect(deps.getNextCriticalCandidate(cwd)).resolves.toEqual({
      ok: true,
      candidate: null,
    });
    await expect(deps.getNextImplementCandidate(cwd)).resolves.toBeNull();
    expect(deps.readCodeFreezeStatus(cwd)).toBe('not-frozen');
    await expect(deps.hasFreshAudit('WL-1', cwd)).resolves.toBe(false);
    await expect(deps.getReviewQueueCount(cwd)).resolves.toBe(0);
  });

  it('merges overrides over the defaults without dropping unspecified deps', async () => {
    const custom = vi.fn().mockResolvedValue({ ok: true, candidate: null });
    const deps = makeDeps({ getNextItem: custom });

    expect(deps.getNextItem).toBe(custom);
    // An unspecified dep keeps its default.
    await expect(deps.getNextImplementCandidate('/repo')).resolves.toBeNull();
  });

  it('produces independent mock instances per call', () => {
    expect(makeDeps().claimItem).not.toBe(makeDeps().claimItem);
  });
});

describe('temporary-directory helpers', () => {
  it('makeTempDir creates a fresh existing directory per call', () => {
    const first = makeTempDir('fixtures-test-');
    const second = makeTempDir('fixtures-test-');
    try {
      expect(existsSync(first)).toBe(true);
      expect(existsSync(second)).toBe(true);
      expect(first).not.toBe(second);
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  it('createTempDirTracker cleanup removes every tracked directory and is idempotent', () => {
    const tracker = createTempDirTracker();
    const a = tracker.make('fixtures-tracker-');
    const b = tracker.make('fixtures-tracker-');

    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);

    tracker.cleanup();
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    // A second cleanup is a no-op rather than a throw.
    expect(() => tracker.cleanup()).not.toThrow();
  });
});

describe('downtime log writers', () => {
  const tempDir = createTempDirTracker();
  afterEach(() => tempDir.cleanup());

  it('writeDowntimeLog creates .worklog and writes one JSON object per line', () => {
    const cwd = tempDir.make('fixtures-log-');
    writeDowntimeLog(cwd, [
      { itemId: 'WL-1', kind: 'implement' },
      { itemId: 'WL-2', kind: 'audit' },
    ]);

    const raw = readFileSync(join(cwd, '.worklog', 'downtime-dispatches.log'), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    const lines = raw.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ itemId: 'WL-1', kind: 'implement' });
    expect(JSON.parse(lines[1])).toEqual({ itemId: 'WL-2', kind: 'audit' });
  });

  it('writeRawDowntimeLog writes the raw string verbatim', () => {
    const cwd = tempDir.make('fixtures-rawlog-');
    writeRawDowntimeLog(cwd, 'not json\n');

    expect(readFileSync(join(cwd, '.worklog', 'downtime-dispatches.log'), 'utf8')).toBe(
      'not json\n',
    );
  });
});

describe('ago', () => {
  it('returns an ISO timestamp at roughly the requested age in the past', () => {
    const before = Date.now();
    const parsed = Date.parse(ago(60_000));
    const after = Date.now();

    expect(parsed).toBeGreaterThanOrEqual(before - 60_000);
    expect(parsed).toBeLessThanOrEqual(after - 60_000);
  });
});
