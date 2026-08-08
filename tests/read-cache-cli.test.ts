/**
 * Unit tests for the wl CLI read-cache wiring (F2 — WL-0MSGAEC5N006W5QA).
 *
 * Covers: cacheable-invocation classification (command set, JSON mode,
 * write-byproduct/non-deterministic flag exclusions), the ReadCacheCli
 * orchestration (lookup → serve / backfill → invalidate-on-write), and the
 * stable state-counter fingerprint used by the CLI.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  ReadCacheCli,
  shouldCacheReadInvocation,
  isCacheableReadCommand,
  argvIsJsonMode,
  hasNonCacheableReadFlags,
  invalidateCacheForWrite,
} from '../src/read-cache-cli.js';
import { readStateCounter, bumpStateCounter, counterFingerprint } from '../src/read-cache.js';
import { createTempDir, cleanupTempDir } from './test-utils.js';

describe('shouldCacheReadInvocation', () => {
  it('caches list/next/show/search/status in JSON mode (flag before or after command)', () => {
    for (const cmd of ['list', 'next', 'show', 'search', 'status']) {
      expect(shouldCacheReadInvocation(cmd, ['--json', cmd])).toBe(true);
      expect(shouldCacheReadInvocation(cmd, [cmd, '--json'])).toBe(true);
    }
  });

  it('never caches write commands even in JSON mode', () => {
    for (const cmd of ['create', 'update', 'close', 'delete', 'comment', 'dep', 'import', 'sync', 'init', 'migrate', 're-sort']) {
      expect(shouldCacheReadInvocation(cmd, [cmd, '--json'])).toBe(false);
    }
  });

  it('requires --json (text output is env/TTY dependent)', () => {
    expect(shouldCacheReadInvocation('list', ['list'])).toBe(false);
    expect(shouldCacheReadInvocation('list', ['list', '-F', 'concise'])).toBe(false);
    expect(shouldCacheReadInvocation('list', ['--verbose', 'list'])).toBe(false);
  });

  it('excludes write-byproduct and non-deterministic read flags', () => {
    expect(shouldCacheReadInvocation('search', ['search', 'foo', '--json', '--rebuild-index'])).toBe(false);
    expect(shouldCacheReadInvocation('search', ['search', 'foo', '--json', '--semantic'])).toBe(false);
    expect(shouldCacheReadInvocation('search', ['search', 'foo', '--json', '--semantic-only'])).toBe(false);
    // Plain search (FTS, deterministic given DB state) is cacheable.
    expect(shouldCacheReadInvocation('search', ['search', 'foo', '--json'])).toBe(true);
  });

  it('treats arg variants as separate entries (full argv participates)', () => {
    expect(shouldCacheReadInvocation('list', ['list', '--json'])).toBe(true);
    expect(shouldCacheReadInvocation('list', ['list', '--status', 'open', '--json'])).toBe(true);
    expect(shouldCacheReadInvocation('list', ['list', '--status', 'open', '-n', '1', '--json'])).toBe(true);
  });

  it('exposes the classification helpers it composes', () => {
    expect(isCacheableReadCommand('list')).toBe(true);
    expect(isCacheableReadCommand('create')).toBe(false);
    expect(argvIsJsonMode(['list', '--json'])).toBe(true);
    expect(argvIsJsonMode(['list'])).toBe(false);
    expect(hasNonCacheableReadFlags(['search', '--json', '--semantic'])).toBe(true);
    expect(hasNonCacheableReadFlags(['search', '--json'])).toBe(false);
  });
});

describe('ReadCacheCli', () => {
  let state: { tempDir: string; originalCwd: string; worklogDir: string; cacheDir: string };
  let cli: ReadCacheCli;

  beforeEach(() => {
    const tempDir = createTempDir();
    const originalCwd = process.cwd();
    const worklogDir = path.join(tempDir, '.worklog');
    fs.mkdirSync(worklogDir, { recursive: true });
    // A real-looking worklog DB file so fingerprints are meaningful.
    fs.writeFileSync(path.join(worklogDir, 'worklog.db'), 'dummy-db-bytes', 'utf-8');
    const cacheDir = path.join(tempDir, 'cache');
    process.env.WL_CACHE_DIR = cacheDir;
    process.chdir(tempDir);
    state = { tempDir, originalCwd, worklogDir, cacheDir };
    cli = new ReadCacheCli();
  });

  afterEach(() => {
    delete process.env.WL_CACHE_DIR;
    delete process.env.WL_SPAWN_COUNT_FILE;
    delete process.env.WL_SPAWN_COUNT;
    process.chdir(state.originalCwd);
    cleanupTempDir(state.tempDir);
  });

  it('serves a repeat read from cache (miss then hit, byte-identical value)', () => {
    const argv = ['list', '--json'];
    const first = cli.lookup('list', argv);
    expect(first.served).toBe(false);
    cli.onJsonOutput({ success: true, count: 0, workItems: [] });
    const second = cli.lookup('list', argv);
    expect(second.served).toBe(true);
    expect(second.value).toEqual({ success: true, count: 0, workItems: [] });
  });

  it('caches despite mid-action file churn (counter fingerprint ignores open/close rewrites)', () => {
    // The app rewrites the SQLite files on every open/close (WAL header
    // churn). A file change between lookup and output must NOT prevent
    // caching — that is why the CLI uses the stable state counter.
    const argv = ['list', '--json'];
    cli.lookup('list', argv);
    fs.writeFileSync(path.join(state.worklogDir, 'worklog.db'), 'dummy-db-bytes-changed', 'utf-8');
    cli.onJsonOutput({ success: true, count: 1, workItems: [] });
    expect(cli.lookup('list', argv).served).toBe(true);
  });

  it('does not backfill when a write bumped the state counter mid-action', () => {
    const argv = ['list', '--json'];
    cli.lookup('list', argv);
    bumpStateCounter(state.cacheDir, state.worklogDir); // a write lands
    cli.onJsonOutput({ success: true, count: 1, workItems: [] });
    const again = cli.lookup('list', argv);
    expect(again.served).toBe(false);
  });

  it('separates arg variants (distinct argv → distinct entries)', () => {
    cli.lookup('list', ['list', '--json']);
    cli.onJsonOutput({ success: true, count: 1, workItems: [] });
    cli.lookup('list', ['list', '--status', 'open', '--json']);
    cli.onJsonOutput({ success: true, count: 2, workItems: [] });
    // Each variant now hits independently.
    expect(cli.lookup('list', ['list', '--json']).served).toBe(true);
    expect(cli.lookup('list', ['list', '--status', 'open', '--json']).served).toBe(true);
  });

  it('invalidateOnWrite drops cached entries for the worklog dir', () => {
    cli.lookup('list', ['list', '--json']);
    cli.onJsonOutput({ success: true, count: 0, workItems: [] });
    expect(cli.lookup('list', ['list', '--json']).served).toBe(true);
    cli.invalidateOnWrite();
    expect(cli.lookup('list', ['list', '--json']).served).toBe(false);
  });

  it('does not cache text-mode invocations', () => {
    const r = cli.lookup('list', ['list']);
    expect(r.served).toBe(false);
    cli.onJsonOutput({ success: true, count: 0, workItems: [] });
    expect(cli.lookup('list', ['list']).served).toBe(false);
  });

  it('ignores JSON output with no armed backfill (write commands)', () => {
    cli.onJsonOutput({ success: true });
    expect(cli.lookup('list', ['list', '--json']).served).toBe(false);
  });

  it('never caches write-byproduct read flags (search --rebuild-index)', () => {
    const argv = ['search', 'foo', '--json', '--rebuild-index'];
    expect(cli.lookup('search', argv).served).toBe(false);
    cli.onJsonOutput({ success: true, count: 0, workItems: [] });
    expect(cli.lookup('search', argv).served).toBe(false);
  });

  it('tracks hit/miss stats for spawn-reduction reporting', () => {
    cli.lookup('list', ['list', '--json']); // miss
    cli.onJsonOutput({ success: true, count: 0, workItems: [] });
    cli.lookup('list', ['list', '--json']); // hit
    const s = cli.stats();
    expect(s.hits).toBe(1);
    expect(s.misses).toBe(1);
  });

  it('is immune to corrupt cache payloads (never throws, treats as miss)', () => {
    const argv = ['list', '--json'];
    cli.lookup('list', argv);
    cli.onJsonOutput({ success: true, count: 0, workItems: [] });
    // Corrupt the stored entry behind the cache's back.
    const entryDir = state.cacheDir;
    const files = fs.readdirSync(entryDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) fs.writeFileSync(path.join(entryDir, f), 'not-json{{', 'utf-8');
    expect(() => cli.lookup('list', argv)).not.toThrow();
    expect(cli.lookup('list', argv).served).toBe(false);
  });
});

describe('state counter', () => {
  let state: { tempDir: string; cacheDir: string; worklogDir: string };

  beforeEach(() => {
    const tempDir = createTempDir();
    const worklogDir = path.join(tempDir, '.worklog');
    fs.mkdirSync(worklogDir, { recursive: true });
    state = { tempDir, cacheDir: path.join(tempDir, 'cache'), worklogDir };
  });

  afterEach(() => {
    cleanupTempDir(state.tempDir);
  });

  it('starts at 0 and increments monotonically', () => {
    expect(readStateCounter(state.cacheDir, state.worklogDir)).toBe(0);
    expect(bumpStateCounter(state.cacheDir, state.worklogDir)).toBe(1);
    expect(bumpStateCounter(state.cacheDir, state.worklogDir)).toBe(2);
    expect(readStateCounter(state.cacheDir, state.worklogDir)).toBe(2);
  });

  it('persists across cache instances (same cache dir, same worklog dir)', () => {
    bumpStateCounter(state.cacheDir, state.worklogDir);
    expect(readStateCounter(state.cacheDir, state.worklogDir)).toBe(1);
  });

  it('is per-worklog-dir (different dirs have independent counters)', () => {
    const other = path.join(state.tempDir, 'other', '.worklog');
    bumpStateCounter(state.cacheDir, state.worklogDir);
    expect(readStateCounter(state.cacheDir, other)).toBe(0);
  });

  it('counterFingerprint is stable across file churn and changes only on bumps', () => {
    const fp1 = counterFingerprint(state.cacheDir, state.worklogDir);
    // File churn (open/close rewrites) must not change the fingerprint...
    fs.writeFileSync(path.join(state.worklogDir, 'worklog.db'), 'anything', 'utf-8');
    const fp2 = counterFingerprint(state.cacheDir, state.worklogDir);
    expect(fp1).toEqual(fp2);
    // ...but a write bump must.
    bumpStateCounter(state.cacheDir, state.worklogDir);
    const fp3 = counterFingerprint(state.cacheDir, state.worklogDir);
    expect(fp3).not.toEqual(fp2);
  });

  it('invalidateCacheForWrite bumps the counter for the resolved worklog dir', () => {
    process.chdir(state.tempDir);
    process.env.WL_CACHE_DIR = state.cacheDir;
    try {
      expect(readStateCounter(state.cacheDir, state.worklogDir)).toBe(0);
      invalidateCacheForWrite();
      expect(readStateCounter(state.cacheDir, state.worklogDir)).toBe(1);
    } finally {
      delete process.env.WL_CACHE_DIR;
    }
  });
});
