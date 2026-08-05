/**
 * Tests for the wl read-cache module (src/read-cache.ts)
 *
 * Covers the F1 acceptance criteria from WL-0MSGAE35E001557V:
 *   - deterministic key derivation (dir + argv + version) with no collisions
 *   - WAL-aware freshness (worklog.db / -wal / -shm fingerprint invalidation)
 *   - TTL staleness bounding
 *   - bounded LRU purge
 *   - concurrent readers/writers (in-process + cross-process)
 *   - atomic writes (temp-file + rename, no partial entries)
 *   - invalidate()/clear() helpers (used by sync/write invalidation in F2/F3)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as childProcess from 'child_process';
import {
  ReadCache,
  deriveCacheKey,
  computeDbFingerprint,
  resolveCacheDir,
  dbFilesForWorklogDir,
  fingerprintsEqual,
  DEFAULT_TTL_MS,
  DEFAULT_MAX_ENTRIES,
} from '../src/read-cache.js';
import { createTempDir, cleanupTempDir } from './test-utils.js';

// ── helpers ────────────────────────────────────────────────────────────

/** Create a fake WAL-mode worklog dir with db/-wal/-shm files (empty). */
function createFakeWorklogDir(dir: string): void {
  const files = dbFilesForWorklogDir(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(files.db, '');
  fs.writeFileSync(files.wal, '');
  fs.writeFileSync(files.shm, '');
}

/** Simulate a SQLite WAL-mode write by appending to the -wal file (size+mtime change). */
function simulateWalWrite(dir: string): void {
  const files = dbFilesForWorklogDir(dir);
  fs.appendFileSync(files.wal, 'WAL-CHUNK-' + Math.random());
}

/** Simulate a checkpoint that rewrites worklog.db (mtime+size change). */
function simulateDbWrite(dir: string): void {
  const files = dbFilesForWorklogDir(dir);
  fs.appendFileSync(files.db, 'DB-CHUNK-' + Math.random());
}

function listEntryFiles(cacheDir: string): string[] {
  if (!fs.existsSync(cacheDir)) return [];
  return fs.readdirSync(cacheDir).filter((f) => /^[0-9a-f]{64}\.json$/.test(f));
}

// ── suite ──────────────────────────────────────────────────────────────

describe('read-cache', () => {
  let worklogDir: string;
  let cacheDir: string;

  beforeEach(() => {
    worklogDir = createTempDir();
    cacheDir = createTempDir();
    createFakeWorklogDir(worklogDir);
  });

  afterEach(() => {
    cleanupTempDir(worklogDir);
    cleanupTempDir(cacheDir);
  });

  describe('resolveCacheDir', () => {
    const saved = { xdg: process.env.XDG_CACHE_HOME, wl: process.env.WL_CACHE_DIR };

    afterEach(() => {
      if (saved.xdg === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = saved.xdg;
      if (saved.wl === undefined) delete process.env.WL_CACHE_DIR;
      else process.env.WL_CACHE_DIR = saved.wl;
    });

    it('honors XDG_CACHE_HOME and appends wl', () => {
      vi.stubEnv('XDG_CACHE_HOME', '/xdg/cache');
      expect(resolveCacheDir()).toBe(path.join('/xdg/cache', 'wl'));
    });

    it('defaults to ~/.cache/wl when XDG_CACHE_HOME is unset', () => {
      delete process.env.XDG_CACHE_HOME;
      delete process.env.WL_CACHE_DIR;
      expect(resolveCacheDir()).toBe(path.join(os.homedir(), '.cache', 'wl'));
    });

    it('WL_CACHE_DIR takes precedence over XDG_CACHE_HOME', () => {
      vi.stubEnv('XDG_CACHE_HOME', '/xdg/cache');
      vi.stubEnv('WL_CACHE_DIR', '/custom/wl-cache');
      expect(resolveCacheDir()).toBe(path.resolve('/custom/wl-cache'));
    });
  });

  describe('deriveCacheKey', () => {
    it('is deterministic for identical inputs', () => {
      const argv = ['list', '--json', '--priority', 'critical'];
      expect(deriveCacheKey(worklogDir, argv, '1.0.0')).toBe(deriveCacheKey(worklogDir, argv, '1.0.0'));
    });

    it('separates different worklog dirs (no collisions)', () => {
      const otherDir = createTempDir();
      try {
        const argv = ['list', '--json'];
        const a = deriveCacheKey(worklogDir, argv, '1.0.0');
        const b = deriveCacheKey(otherDir, argv, '1.0.0');
        expect(a).not.toBe(b);
        expect(a).toMatch(/^[0-9a-f]{64}$/);
      } finally {
        cleanupTempDir(otherDir);
      }
    });

    it('separates arg variants (argv is part of the key)', () => {
      const k1 = deriveCacheKey(worklogDir, ['list', '--json'], '1.0.0');
      const k2 = deriveCacheKey(worklogDir, ['list', '--json', '--root-only'], '1.0.0');
      const k3 = deriveCacheKey(worklogDir, ['list', '--status', 'open'], '1.0.0');
      const k4 = deriveCacheKey(worklogDir, ['list', '--status', 'blocked'], '1.0.0');
      expect(new Set([k1, k2, k3, k4]).size).toBe(4);
    });

    it('separates wl versions (schema-drift guard)', () => {
      const argv = ['list', '--json'];
      expect(deriveCacheKey(worklogDir, argv, '1.0.7')).not.toBe(deriveCacheKey(worklogDir, argv, '1.0.8'));
    });

    it('orders argv (arg order matters, byte-identical output depends on it)', () => {
      expect(deriveCacheKey(worklogDir, ['list', '--json'], '1.0.0')).not.toBe(
        deriveCacheKey(worklogDir, ['--json', 'list'], '1.0.0'),
      );
    });

    it('resolves relative worklog dirs to absolute paths', () => {
      const abs = deriveCacheKey(worklogDir, ['list'], '1.0.0');
      const rel = deriveCacheKey(path.relative(process.cwd(), worklogDir), ['list'], '1.0.0');
      expect(rel).toBe(abs);
    });
  });

  describe('computeDbFingerprint (WAL-aware)', () => {
    it('reflects db, wal and shm mtime+size', () => {
      const fp = computeDbFingerprint(worklogDir);
      expect(fp.db).toEqual([expect.any(Number), expect.any(Number)]);
      expect(fp.wal).toEqual([expect.any(Number), expect.any(Number)]);
      expect(fp.shm).toEqual([expect.any(Number), expect.any(Number)]);
    });

    it('treats missing DB files as zeros (empty/never-initialized dir)', () => {
      const emptyDir = createTempDir();
      try {
        const fp = computeDbFingerprint(emptyDir);
        expect(fp).toEqual({ db: [0, 0], wal: [0, 0], shm: [0, 0] });
      } finally {
        cleanupTempDir(emptyDir);
      }
    });

    it('changes when the -wal file changes (WAL-mode write)', () => {
      const before = computeDbFingerprint(worklogDir);
      simulateWalWrite(worklogDir);
      const after = computeDbFingerprint(worklogDir);
      expect(fingerprintsEqual(before, after)).toBe(false);
    });

    it('changes when worklog.db changes (checkpoint/rewrite)', () => {
      const before = computeDbFingerprint(worklogDir);
      simulateDbWrite(worklogDir);
      const after = computeDbFingerprint(worklogDir);
      expect(fingerprintsEqual(before, after)).toBe(false);
    });

    it('changes when the -shm file changes', () => {
      const before = computeDbFingerprint(worklogDir);
      const files = dbFilesForWorklogDir(worklogDir);
      fs.appendFileSync(files.shm, 'SHM-CHUNK');
      const after = computeDbFingerprint(worklogDir);
      expect(fingerprintsEqual(before, after)).toBe(false);
    });
  });

  describe('get/set round-trip', () => {
    it('returns null on a cache miss', () => {
      const cache = new ReadCache({ cacheDir });
      expect(cache.get(worklogDir, ['list', '--json'])).toBeNull();
      expect(cache.stats().misses).toBe(1);
      expect(cache.stats().hits).toBe(0);
    });

    it('round-trips a JSON value', () => {
      const cache = new ReadCache({ cacheDir });
      const value = { success: true, count: 2, workItems: [{ id: 'WI-1' }, { id: 'WI-2' }] };
      cache.set(worklogDir, ['list', '--json'], value);
      expect(cache.get(worklogDir, ['list', '--json'])).toEqual(value);
      expect(cache.stats().hits).toBe(1);
    });

    it('round-trips a string value (exact CLI JSON output)', () => {
      const cache = new ReadCache({ cacheDir });
      const output = '{"success":true,"count":1,"workItems":[]}';
      cache.set(worklogDir, ['list', '--json'], output);
      expect(cache.get(worklogDir, ['list', '--json'])).toBe(output);
    });

    it('keeps arg variants separated (no cross-contamination)', () => {
      const cache = new ReadCache({ cacheDir });
      cache.set(worklogDir, ['list', '--json'], { scope: 'all' });
      cache.set(worklogDir, ['list', '--json', '--root-only'], { scope: 'root-only' });
      cache.set(worklogDir, ['list', '--status', 'open'], { scope: 'open' });
      expect(cache.get(worklogDir, ['list', '--json'])).toEqual({ scope: 'all' });
      expect(cache.get(worklogDir, ['list', '--json', '--root-only'])).toEqual({ scope: 'root-only' });
      expect(cache.get(worklogDir, ['list', '--status', 'open'])).toEqual({ scope: 'open' });
    });

    it('keeps different worklog dirs separated', () => {
      const otherDir = createTempDir();
      try {
        createFakeWorklogDir(otherDir);
        const cache = new ReadCache({ cacheDir });
        cache.set(worklogDir, ['next', '--json'], { dir: 'A' });
        cache.set(otherDir, ['next', '--json'], { dir: 'B' });
        expect(cache.get(worklogDir, ['next', '--json'])).toEqual({ dir: 'A' });
        expect(cache.get(otherDir, ['next', '--json'])).toEqual({ dir: 'B' });
      } finally {
        cleanupTempDir(otherDir);
      }
    });

    it('creates the cache dir on demand', () => {
      const nested = path.join(cacheDir, 'nested', 'deep');
      const cache = new ReadCache({ cacheDir: nested });
      cache.set(worklogDir, ['list'], { ok: true });
      expect(fs.existsSync(nested)).toBe(true);
      expect(cache.get(worklogDir, ['list'])).toEqual({ ok: true });
    });
  });

  describe('WAL-aware invalidation', () => {
    it('invalidates when the -wal file changes (write-then-read is fresh)', () => {
      const cache = new ReadCache({ cacheDir });
      cache.set(worklogDir, ['list', '--json'], { v: 1 });

      // A write lands in the WAL: cached entry must NOT be served.
      simulateWalWrite(worklogDir);
      expect(cache.get(worklogDir, ['list', '--json'])).toBeNull();

      // New data is cached and served immediately.
      cache.set(worklogDir, ['list', '--json'], { v: 2 });
      expect(cache.get(worklogDir, ['list', '--json'])).toEqual({ v: 2 });
    });

    it('invalidates when worklog.db changes (checkpoint)', () => {
      const cache = new ReadCache({ cacheDir });
      cache.set(worklogDir, ['show', 'WI-1', '--json'], { title: 'old' });
      simulateDbWrite(worklogDir);
      expect(cache.get(worklogDir, ['show', 'WI-1', '--json'])).toBeNull();
    });

    it('invalidates when -shm changes', () => {
      const cache = new ReadCache({ cacheDir });
      cache.set(worklogDir, ['search', 'bug'], { n: 1 });
      const files = dbFilesForWorklogDir(worklogDir);
      fs.appendFileSync(files.shm, 'SHM-CHUNK');
      expect(cache.get(worklogDir, ['search', 'bug'])).toBeNull();
    });

    it('invalidates when the DB files first appear (fresh DB creation)', () => {
      const emptyDir = createTempDir();
      try {
        const cache = new ReadCache({ cacheDir });
        cache.set(emptyDir, ['list', '--json'], { v: 1 });
        expect(cache.get(emptyDir, ['list', '--json'])).toEqual({ v: 1 });

        // DB appears → fingerprint goes from zeros to real values → invalidate.
        createFakeWorklogDir(emptyDir);
        expect(cache.get(emptyDir, ['list', '--json'])).toBeNull();
      } finally {
        cleanupTempDir(emptyDir);
      }
    });

    it('only invalidates entries for the touched worklog dir', () => {
      const otherDir = createTempDir();
      try {
        createFakeWorklogDir(otherDir);
        const cache = new ReadCache({ cacheDir });
        cache.set(worklogDir, ['list', '--json'], { dir: 'A' });
        cache.set(otherDir, ['list', '--json'], { dir: 'B' });

        simulateWalWrite(worklogDir);
        expect(cache.get(worklogDir, ['list', '--json'])).toBeNull();
        expect(cache.get(otherDir, ['list', '--json'])).toEqual({ dir: 'B' });
      } finally {
        cleanupTempDir(otherDir);
      }
    });

    it('stores a caller-provided fingerprint (captured before the query)', () => {
      const cache = new ReadCache({ cacheDir });
      const fpBefore = computeDbFingerprint(worklogDir);
      const value = { v: 1 };
      cache.set(worklogDir, ['list', '--json'], value, { dbFingerprint: fpBefore });

      // Still served while the DB is unchanged…
      expect(cache.get(worklogDir, ['list', '--json'])).toEqual(value);
      // …and invalidated the moment the DB changes (write-then-read is fresh).
      simulateWalWrite(worklogDir);
      expect(cache.get(worklogDir, ['list', '--json'])).toBeNull();
    });
  });

  describe('TTL staleness', () => {
    it('serves entries within TTL and rejects after expiry', () => {
      let now = 1_000_000;
      const cache = new ReadCache({ cacheDir, ttlMs: 30_000, now: () => now });
      cache.set(worklogDir, ['list', '--json'], { v: 1 });

      now += 29_999;
      expect(cache.get(worklogDir, ['list', '--json'])).toEqual({ v: 1 });

      now += 2; // 30_001ms elapsed → past TTL
      expect(cache.get(worklogDir, ['list', '--json'])).toBeNull();
      expect(cache.stats().misses).toBe(1);
    });

    it('a hit does not extend the TTL window (createdAt is the base)', () => {
      let now = 1_000_000;
      const cache = new ReadCache({ cacheDir, ttlMs: 10_000, now: () => now });
      cache.set(worklogDir, ['list'], { v: 1 });

      now += 9_000;
      expect(cache.get(worklogDir, ['list'])).toEqual({ v: 1 }); // hit, touches access time
      now += 2_000;
      expect(cache.get(worklogDir, ['list'])).toBeNull(); // 11s since creation → stale
    });

    it('defaults TTL to 30s and max entries to 1000', () => {
      expect(DEFAULT_TTL_MS).toBe(30_000);
      expect(DEFAULT_MAX_ENTRIES).toBe(1_000);
    });
  });

  describe('bounded cache (LRU purge)', () => {
    it('purges oldest entries when over the bound', () => {
      const cache = new ReadCache({ cacheDir, maxEntries: 5, ttlMs: 60_000 });
      for (let i = 0; i < 8; i++) {
        cache.set(worklogDir, ['list', '--json', '--page', String(i)], { i });
      }
      const files = listEntryFiles(cacheDir);
      expect(files.length).toBeLessThanOrEqual(5);
    });

    it('keeps recently accessed entries and evicts least-recently used', () => {
      // Each set advances the injected clock so accessedAt ordering is deterministic.
      let now = 1_000_000;
      const cache = new ReadCache({ cacheDir, maxEntries: 5, ttlMs: 60_000, now: () => now });
      const setP = (i: number) => {
        now += 1;
        cache.set(worklogDir, ['list', '--p', String(i)], { i });
      };
      for (let i = 0; i < 5; i++) setP(i); // accessedAt 1_000_001..1_000_005

      // Touch entry 0 (most recent access) then add 3 more: with maxEntries=5,
      // adding 5,6,7 evicts the three oldest untouched entries 1,2,3.
      now += 1_000;
      expect(cache.get(worklogDir, ['list', '--p', '0'])).toEqual({ i: 0 }); // accessedAt → 1_001_005
      for (let i = 5; i < 8; i++) setP(i); // accessedAt 1_001_006..1_001_008

      expect(cache.get(worklogDir, ['list', '--p', '0'])).toEqual({ i: 0 }); // touched → survived
      expect(cache.get(worklogDir, ['list', '--p', '1'])).toBeNull(); // oldest → evicted
      expect(cache.get(worklogDir, ['list', '--p', '4'])).toEqual({ i: 4 }); // newest of the originals → survived
      expect(cache.get(worklogDir, ['list', '--p', '7'])).toEqual({ i: 7 });
    });

    it('evicts TTL-expired entries during purge', () => {
      // maxEntries=1: B's set pushes the count over the bound, forcing a purge
      // in which the TTL-expired entry A is removed.
      let now = 1_000_000;
      const cache = new ReadCache({ cacheDir, maxEntries: 1, ttlMs: 10_000, now: () => now });
      cache.set(worklogDir, ['list', '--a'], { a: 1 });
      now += 11_000; // entry A expires
      cache.set(worklogDir, ['list', '--b'], { b: 2 }); // triggers purge; expired A removed
      const files = listEntryFiles(cacheDir);
      expect(files.length).toBe(1);
      expect(cache.get(worklogDir, ['list', '--a'])).toBeNull();
      expect(cache.get(worklogDir, ['list', '--b'])).toEqual({ b: 2 });
    });
  });

  describe('atomicity and corruption handling', () => {
    it('leaves no temp files behind after set', () => {
      const cache = new ReadCache({ cacheDir });
      cache.set(worklogDir, ['list', '--json'], { ok: true });
      const leftovers = fs.readdirSync(cacheDir).filter((f) => f.includes('.tmp-') || f.endsWith('.tmp'));
      expect(leftovers).toEqual([]);
    });

    it('serves a partial/corrupt entry as a miss and removes it', () => {
      const cache = new ReadCache({ cacheDir });
      cache.set(worklogDir, ['list', '--json'], { ok: true });
      const files = listEntryFiles(cacheDir);
      expect(files.length).toBe(1);
      fs.writeFileSync(path.join(cacheDir, files[0]), '{"key": "truncated');

      expect(cache.get(worklogDir, ['list', '--json'])).toBeNull();
      expect(listEntryFiles(cacheDir).length).toBe(0); // corrupt file removed
    });

    it('treats a header mismatch (foreign/other-key file) as a miss', () => {
      const cache = new ReadCache({ cacheDir });
      // Write an entry, then tamper with the stored key header.
      cache.set(worklogDir, ['list', '--json'], { ok: true });
      const files = listEntryFiles(cacheDir);
      const p = path.join(cacheDir, files[0]);
      const entry = JSON.parse(fs.readFileSync(p, 'utf-8'));
      entry.key = 'f'.repeat(64);
      fs.writeFileSync(p, JSON.stringify(entry));

      expect(cache.get(worklogDir, ['list', '--json'])).toBeNull();
      expect(listEntryFiles(cacheDir).length).toBe(0);
    });
  });

  describe('invalidate/clear', () => {
    it('invalidate(worklogDir) removes only that dir entries', () => {
      const otherDir = createTempDir();
      try {
        createFakeWorklogDir(otherDir);
        const cache = new ReadCache({ cacheDir });
        cache.set(worklogDir, ['list'], { a: 1 });
        cache.set(worklogDir, ['next'], { a: 2 });
        cache.set(otherDir, ['list'], { b: 1 });

        const removed = cache.invalidate(worklogDir);
        expect(removed).toBe(2);
        expect(cache.get(worklogDir, ['list'])).toBeNull();
        expect(cache.get(worklogDir, ['next'])).toBeNull();
        expect(cache.get(otherDir, ['list'])).toEqual({ b: 1 }); // untouched
      } finally {
        cleanupTempDir(otherDir);
      }
    });

    it('clear() removes all entries', () => {
      const cache = new ReadCache({ cacheDir });
      cache.set(worklogDir, ['list'], { a: 1 });
      cache.set(worklogDir, ['next'], { a: 2 });
      const removed = cache.clear();
      expect(removed).toBe(2);
      expect(listEntryFiles(cacheDir).length).toBe(0);
    });
  });

  describe('concurrency', () => {
    it('survives concurrent in-process readers/writers across instances', async () => {
      // Multiple cache instances = separate "processes" sharing one cache dir.
      const instances = Array.from({ length: 6 }, () => new ReadCache({ cacheDir }));
      const tasks: Promise<void>[] = [];
      for (let inst = 0; inst < instances.length; inst++) {
        const cache = instances[inst];
        for (let round = 0; round < 25; round++) {
          tasks.push(
            Promise.resolve().then(() => {
              const argv = ['list', '--json', '--inst', String(inst), '--round', String(round)];
              cache.set(worklogDir, argv, { inst, round });
              const got = cache.get(worklogDir, argv);
              expect(got).toEqual({ inst, round });
            }),
          );
        }
      }
      await Promise.all(tasks);
      // All entries written atomically — every file parses and has a valid key.
      for (const f of listEntryFiles(cacheDir)) {
        const entry = JSON.parse(fs.readFileSync(path.join(cacheDir, f), 'utf-8'));
        expect(entry.key).toBe(f.replace(/\.json$/, ''));
        expect(typeof entry.value).toBe('object');
      }
    });

    it('survives concurrent cross-process readers/writers (spawned via tsx)', async () => {
      const childScript = path.resolve(__dirname, 'read-cache-concurrent-child.ts');
      const tsxBin = path.resolve(__dirname, '..', 'node_modules', '.bin', 'tsx');
      const workers = 4;
      const rounds = 15;
      const run = (id: number) =>
        new Promise<void>((resolve, reject) => {
          const child = childProcess.spawn(tsxBin, [childScript, String(id), String(rounds)], {
            env: {
              ...process.env,
              CACHE_DIR: cacheDir,
              WORKLOG_DIR: worklogDir,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stderr = '';
          child.stderr.on('data', (d) => (stderr += String(d)));
          child.on('error', reject);
          child.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`child ${id} exited ${code}: ${stderr.slice(0, 500)}`));
          });
        });

      await Promise.all(Array.from({ length: workers }, (_, i) => run(i)));

      // Post-conditions: no temp files, every entry parses, unique keys round-tripped.
      const leftovers = fs.readdirSync(cacheDir).filter((f) => f.includes('.tmp-'));
      expect(leftovers).toEqual([]);
      for (const f of listEntryFiles(cacheDir)) {
        const entry = JSON.parse(fs.readFileSync(path.join(cacheDir, f), 'utf-8'));
        expect(entry.key).toBe(f.replace(/\.json$/, ''));
        expect(typeof entry.value).toBe('object');
      }
      // The shared key entry was written by all workers — final file must be valid.
      const shared = new ReadCache({ cacheDir }).get(worklogDir, ['list', '--json']);
      expect(shared).not.toBeNull();
      expect(typeof (shared as any).writer).toBe('string');
    });
  });

  describe('version guard', () => {
    it('does not serve entries written under a different wl version', () => {
      const cacheV1 = new ReadCache({ cacheDir, version: '1.0.7' });
      const cacheV2 = new ReadCache({ cacheDir, version: '1.0.8' });
      cacheV1.set(worklogDir, ['list', '--json'], { v: 'old-schema' });
      expect(cacheV2.get(worklogDir, ['list', '--json'])).toBeNull();
      expect(cacheV1.get(worklogDir, ['list', '--json'])).toEqual({ v: 'old-schema' });
    });
  });
});
