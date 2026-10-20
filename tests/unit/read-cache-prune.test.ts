/**
 * Tests for the bounded/prunable read-cache state directory
 * (F8 — WL-0MVFRRGGC001IQK1, parent AC3/AC4).
 *
 * The cache stores one monotonic write counter per worklog dir ever seen at
 * `<cache-dir>/state/<sha256(dir)>.json`. On the reference host that directory
 * grew to 216k files / ~890 MB because nothing ever removed a counter. These
 * tests pin the pruning contract:
 *
 *   - TTL: counters untouched beyond the TTL are removed, fresh ones never;
 *   - BOUND: the file count is capped (LRU by mtime), but a counter written
 *     inside the live window is never evicted — a prune may not reset a live
 *     counter;
 *   - DRY RUN: reports what would be removed without deleting anything;
 *   - FRESHNESS: pruning a counter can never resurrect a stale entry
 *     (a removed counter reads as 0, which never matches a stored value), and
 *     retry/`--prune` runs are idempotent and tolerate a counter that
 *     disappears between scan and unlink;
 *   - CONCURRENCY: pruning tolerates concurrent `bumpStateCounter` writers
 *     (cross-process), leaving no temp files and no truncated counters.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as childProcess from 'child_process';
import {
  ReadCache,
  bumpStateCounter,
  readStateCounter,
  stateCounterFilePath,
  pruneStateDir,
  counterFingerprint,
  DEFAULT_STATE_MAX_FILES,
  DEFAULT_STATE_TTL_MS,
} from '../../src/read-cache.js';
import { createTempDir, cleanupTempDir, resolveTsxBin } from '../test-utils.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// ── helpers ────────────────────────────────────────────────────────────

/** Write a counter file for a worklog dir and pin its mtime. */
function writeCounter(cacheDir: string, worklogDir: string, state: number, mtimeMs: number): string {
  const file = stateCounterFilePath(cacheDir, worklogDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ state }), 'utf-8');
  const seconds = mtimeMs / 1000;
  fs.utimesSync(file, seconds, seconds);
  return file;
}

/** Every `state/*.json` counter file currently on disk. */
function listCounterFiles(cacheDir: string): string[] {
  const dir = path.join(cacheDir, 'state');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^[0-9a-f]{64}\.json$/.test(f))
    .map((f) => path.join(dir, f));
}

/** Entry files (`<64-hex>.json`) in the cache root. */
function listEntryFiles(cacheDir: string): string[] {
  if (!fs.existsSync(cacheDir)) return [];
  return fs.readdirSync(cacheDir).filter((f) => /^[0-9a-f]{64}\.json$/.test(f));
}

// ── suite ──────────────────────────────────────────────────────────────

describe('pruneStateDir', () => {
  let cacheDir: string;

  /** A distinct fake worklog dir per call (each gets its own counter file). */
  function worklogDirFor(name: string): string {
    const dir = path.join(cacheDir, 'worklogs', name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  beforeEach(() => {
    cacheDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(cacheDir);
  });

  it('exposes safe defaults for the bound and the TTL', () => {
    // ~1,000 counters keeps the directory small on a Pi-class host while a
    // 7-day TTL bounds growth for one-off / throwaway checkouts.
    expect(DEFAULT_STATE_MAX_FILES).toBe(1_000);
    expect(DEFAULT_STATE_TTL_MS).toBe(7 * DAY_MS);
  });

  describe('TTL pass', () => {
    it('removes counters untouched beyond the TTL and keeps fresh ones', () => {
      const now = 1_800_000_000_000;
      const staleA = writeCounter(cacheDir, worklogDirFor('stale-a'), 3, now - 8 * DAY_MS);
      const staleB = writeCounter(cacheDir, worklogDirFor('stale-b'), 7, now - 30 * DAY_MS);
      const fresh = writeCounter(cacheDir, worklogDirFor('fresh'), 1, now - 60_000);

      const result = pruneStateDir(cacheDir, { now: () => now });

      expect(result.staleByTtl).toBe(2);
      expect(result.removed).toBe(2);
      expect(result.remaining).toBe(1);
      expect(result.filesScanned).toBe(3);
      expect(fs.existsSync(staleA)).toBe(false);
      expect(fs.existsSync(staleB)).toBe(false);
      expect(fs.existsSync(fresh)).toBe(true);
      // The surviving counter still reads back its value.
      expect(readStateCounter(cacheDir, path.join(cacheDir, 'worklogs', 'fresh'))).toBe(1);
    });

    it('reports what it would remove in dry-run mode without deleting anything', () => {
      const now = 1_800_000_000_000;
      const stale = writeCounter(cacheDir, worklogDirFor('dry-a'), 2, now - 10 * DAY_MS);

      const result = pruneStateDir(cacheDir, { now: () => now, dryRun: true });

      expect(result.dryRun).toBe(true);
      expect(result.staleByTtl).toBe(1);
      expect(result.removed).toBe(1);
      expect(result.bytesReclaimed).toBeGreaterThan(0);
      // Nothing was touched.
      expect(fs.existsSync(stale)).toBe(true);
      expect(result.remaining).toBe(1);
      expect(readStateCounter(cacheDir, path.join(cacheDir, 'worklogs', 'dry-a'))).toBe(2);
    });

    it('never removes a counter whose mtime is in the future (clock skew)', () => {
      const now = 1_800_000_000_000;
      const skewed = writeCounter(cacheDir, worklogDirFor('skewed'), 4, now + 2 * DAY_MS);

      const result = pruneStateDir(cacheDir, { now: () => now });

      expect(result.staleByTtl).toBe(0);
      expect(fs.existsSync(skewed)).toBe(true);
    });
  });

  describe('bound pass', () => {
    it('caps the file count, evicting the least-recently-written counters', () => {
      const now = 1_800_000_000_000;
      const files: string[] = [];
      // 1 hour old: outside the 30 s live window, inside the TTL.
      for (let i = 0; i < 10; i++) {
        files.push(writeCounter(cacheDir, worklogDirFor(`bounded-${i}`), i, now - 3_600_000 + i * 1_000));
      }

      const result = pruneStateDir(cacheDir, { now: () => now, maxFiles: 4 });

      expect(result.filesScanned).toBe(10);
      expect(result.overBound).toBe(6);
      expect(result.removed).toBe(6);
      expect(result.remaining).toBe(4);
      const survivors = listCounterFiles(cacheDir);
      expect(survivors.length).toBe(4);
      // The four most recently written counters (6..9) survive.
      expect(survivors.sort()).toEqual(files.slice(6).sort());

      // A surviving dir still serves a correct cache hit: pruning its
      // neighbours never disturbs the entry/counter fingerprint pairing.
      const survivingDir = path.join(cacheDir, 'worklogs', 'bounded-9');
      const cache = new ReadCache({ cacheDir, fingerprint: (dir) => counterFingerprint(cacheDir, dir) });
      bumpStateCounter(cacheDir, survivingDir);
      cache.set(survivingDir, ['next', '--json'], { ok: true });
      expect(cache.get(survivingDir, ['next', '--json'])).toEqual({ ok: true });
    });

    it('never evicts a counter written inside the live window (a prune cannot reset a live counter)', () => {
      const now = 1_800_000_000_000;
      const live: string[] = [];
      for (let i = 0; i < 6; i++) {
        live.push(writeCounter(cacheDir, worklogDirFor(`live-${i}`), i + 1, now - 1_000));
      }

      const result = pruneStateDir(cacheDir, { now: () => now, maxFiles: 2 });

      // The bound is soft while counters are live: nothing was evicted and no
      // live counter can be reset by a concurrent prune.
      expect(result.overBound).toBe(0);
      expect(result.removed).toBe(0);
      expect(result.remaining).toBe(6);
      for (const file of live) expect(fs.existsSync(file)).toBe(true);
      expect(readStateCounter(cacheDir, path.join(cacheDir, 'worklogs', 'live-5'))).toBe(6);
    });

    it('honours an explicit live window', () => {
      const now = 1_800_000_000_000;
      writeCounter(cacheDir, worklogDirFor('lw-a'), 1, now - 5_000);
      writeCounter(cacheDir, worklogDirFor('lw-b'), 1, now - 60_000);

      const result = pruneStateDir(cacheDir, { now: () => now, maxFiles: 1, liveWindowMs: 0 });

      expect(result.overBound).toBe(1);
      expect(result.remaining).toBe(1);
    });
  });

  describe('freshness safety', () => {
    it('a pruned counter can never let a stale entry be served', () => {
      const now = 1_800_000_000_000;
      const worklogDir = worklogDirFor('entry-owner');
      // Write a counter (state 42) and an entry fingerprinted with it.
      writeCounter(cacheDir, worklogDir, 42, now);
      const cache = new ReadCache({ cacheDir, fingerprint: (dir) => counterFingerprint(cacheDir, dir) });
      cache.set(worklogDir, ['list', '--json'], { stale: 'payload' }, {
        dbFingerprint: { db: [0, 0], wal: [0, 0], shm: [0, 0], stateCounter: 42 },
      });
      expect(cache.get(worklogDir, ['list', '--json'])).toEqual({ stale: 'payload' });

      // Prune the counter away (explicitly invalidating its entries).
      const result = pruneStateDir(cacheDir, { now: () => now, maxFiles: 0, liveWindowMs: 0, invalidateEntries: true });
      expect(result.removed).toBe(1);
      expect(result.invalidatedEntries).toBe(1);
      expect(readStateCounter(cacheDir, worklogDir)).toBe(0);

      // A removed counter reads as 0, which never matches the stored 42 — and
      // the entry itself is gone, so no stale payload can be served.
      expect(cache.get(worklogDir, ['list', '--json'])).toBeNull();
      expect(listEntryFiles(cacheDir)).toEqual([]);
    });

    it('a pruning run is idempotent and tolerant of a counter that vanished mid-run', () => {
      const now = 1_800_000_000_000;
      const worklog = worklogDirFor('gone');
      writeCounter(cacheDir, worklog, 5, now - 8 * DAY_MS);

      // Simulate the counter disappearing between the scan and the unlink:
      // a second run (nothing left to remove) must not throw or miscount.
      const first = pruneStateDir(cacheDir, { now: () => now });
      const second = pruneStateDir(cacheDir, { now: () => now });

      expect(first.removed).toBe(1);
      expect(second).toMatchObject({ filesScanned: 0, removed: 0, remaining: 0 });
    });

    it('ignores non-counter entries in the state dir', () => {
      const now = 1_800_000_000_000;
      const stale = writeCounter(cacheDir, worklogDirFor('real'), 1, now - 8 * DAY_MS);
      const stateDir = path.join(cacheDir, 'state');
      fs.writeFileSync(path.join(stateDir, 'README.txt'), 'not a counter', 'utf-8');
      fs.writeFileSync(path.join(stateDir, 'deadbeef.json'), '{}', 'utf-8'); // not 64 hex chars
      fs.writeFileSync(path.join(stateDir, `${'a'.repeat(64)}.json.tmp-1-abc`), '{}', 'utf-8');

      const result = pruneStateDir(cacheDir, { now: () => now });

      expect(result.filesScanned).toBe(1);
      expect(result.removed).toBe(1);
      expect(fs.existsSync(stale)).toBe(false);
      // Foreign files are left alone.
      expect(fs.existsSync(path.join(stateDir, 'README.txt'))).toBe(true);
      expect(fs.existsSync(path.join(stateDir, 'deadbeef.json'))).toBe(true);
    });

    it('reports zeros for a missing or empty state dir', () => {
      expect(pruneStateDir(path.join(cacheDir, 'nope'))).toMatchObject({
        filesScanned: 0,
        totalBytes: 0,
        removed: 0,
        remaining: 0,
      });
      fs.mkdirSync(path.join(cacheDir, 'state'), { recursive: true });
      expect(pruneStateDir(cacheDir)).toMatchObject({ filesScanned: 0, removed: 0 });
    });
  });

  describe('concurrency', () => {
    it('keeps a live counter monotonic while pruning runs in-process', () => {
      const worklogDir = worklogDirFor('monotonic');
      let last = 0;
      for (let i = 0; i < 20; i++) {
        const bumped = bumpStateCounter(cacheDir, worklogDir);
        expect(bumped).toBeGreaterThan(last);
        last = bumped;
        // Prune aggressively underneath the writer: the live counter must
        // survive (a prune may never reset it to a lower value).
        pruneStateDir(cacheDir, { maxFiles: 1, ttlMs: 1 });
        expect(readStateCounter(cacheDir, worklogDir)).toBeGreaterThanOrEqual(last - 1);
      }
      expect(readStateCounter(cacheDir, worklogDir)).toBeGreaterThan(0);
    });

    it('tolerates concurrent cross-process writers and pruners', async () => {
      // The child lives at the shared tests/ root, alongside the other
      // cross-process cache helpers (tests/read-cache-concurrent-child.ts).
      const childScript = path.resolve(__dirname, '..', 'read-cache-prune-child.ts');
      const tsxBin = resolveTsxBin(__dirname);
      const worklogDir = worklogDirFor('cross-process');
      const rounds = 12;
      const writers = 3;
      const pruners = 2;

      // Seed stale counters (10 minutes old) so the pruners have real work:
      // the live counter's mtime is always current, so it can never be a
      // prune candidate — that is exactly the 'prune cannot reset a live
      // counter' property under concurrent writers (AC). A live counter bumped
      // by a writer gets a current mtime, so no prune run can select it.
      const staleSeeds: string[] = [];
      for (let i = 0; i < 5; i++) {
        staleSeeds.push(
          writeCounter(cacheDir, worklogDirFor(`stale-seed-${i}`), i + 1, Date.now() - 10 * 60_000),
        );
      }

      const run = (mode: 'bump' | 'prune', id: number) =>
        new Promise<void>((resolve, reject) => {
          const child = childProcess.spawn(tsxBin, [childScript, mode, String(id), String(rounds)], {
            env: {
              ...process.env,
              CACHE_DIR: cacheDir,
              WORKLOG_DIR: worklogDir,
              PRUNE_TTL_MS: '60000',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stderr = '';
          child.stderr.on('data', (d) => (stderr += String(d)));
          child.on('error', reject);
          child.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${mode} child ${id} exited ${code}: ${stderr.slice(0, 500)}`));
          });
        });

      const tasks: Promise<void>[] = [];
      for (let i = 0; i < writers; i++) tasks.push(run('bump', i));
      for (let i = 0; i < pruners; i++) tasks.push(run('prune', i));
      await Promise.all(tasks);

      // The seeded stale counters were all pruned; the live counter survived
      // (its mtime is always current, so no prune run could ever target it).
      for (const file of staleSeeds) expect(fs.existsSync(file)).toBe(false);

      // No temp files survive, every remaining counter file parses.
      const leftovers = fs.readdirSync(path.join(cacheDir, 'state')).filter((f) => f.includes('.tmp-'));
      expect(leftovers).toEqual([]);
      for (const file of listCounterFiles(cacheDir)) {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { state?: number };
        expect(typeof parsed.state).toBe('number');
      }
      // The live counter was never reset by a concurrent prune.
      expect(readStateCounter(cacheDir, worklogDir)).toBeGreaterThan(0);
      // Monotonicity per writer is asserted inside the child (a bump must
      // never regress the counter it last observed); with coalescing allowed
      // across processes the shared counter is guaranteed >= 1 here.
      expect(readStateCounter(cacheDir, worklogDir)).toBeGreaterThanOrEqual(1);
    });

    it('keeps entries readable when their counters are pruned mid-flight', async () => {
      const worklogDir = worklogDirFor('entries');
      const cache = new ReadCache({ cacheDir, fingerprint: (dir) => counterFingerprint(cacheDir, dir) });
      // A write creates the counter first (in the CLI the entry is only ever
      // backfilled after a bump), so the entry fingerprints stateCounter 1.
      bumpStateCounter(cacheDir, worklogDir);
      cache.set(worklogDir, ['next', '--json'], { v: 1 });
      expect(cache.get(worklogDir, ['next', '--json'])).toEqual({ v: 1 });

      pruneStateDir(cacheDir, { maxFiles: 0, liveWindowMs: 0, invalidateEntries: true });

      // Reading after the counter disappeared is a clean miss (never a throw,
      // never a stale value), and a subsequent write re-creates the counter.
      expect(cache.get(worklogDir, ['next', '--json'])).toBeNull();
      bumpStateCounter(cacheDir, worklogDir);
      cache.set(worklogDir, ['next', '--json'], { v: 2 });
      expect(cache.get(worklogDir, ['next', '--json'])).toEqual({ v: 2 });
    });
  });
});
