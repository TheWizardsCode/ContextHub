/**
 * Unit tests for db-change.ts — DB-change signal module (WL-0MTBWK01P000QO90 F1)
 *
 * Tests the DbChangeTracker's contract:
 *  - resolveCacheDir() precedence (WL_CACHE_DIR > XDG_CACHE_HOME > ~/.cache/wl)
 *  - readStateCounter() reads the per-worklog-dir counter file
 *  - DbChangeTracker first-call returns changed=true; unchanged counter returns false
 *  - Fail-open: read errors return changed=true
 *
 * Run: npx vitest run packages/herdr/src/db-change.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Partial mock: readFileSync is mocked, but mkdirSync/mkdtempSync are real
// ---------------------------------------------------------------------------

let mockFileSyncContents: Record<string, string> = {};
let mockFileSyncThrowFor: string | null = null;

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn((filePath: string): string => {
      if (mockFileSyncThrowFor === filePath) {
        throw new Error('EACCES: permission denied');
      }
      return mockFileSyncContents[filePath] ?? '';
    }),
  };
});

// ---------------------------------------------------------------------------
// Import the module under test (after fs mock)
// ---------------------------------------------------------------------------

import {
  resolveCacheDir,
  readStateCounter,
  DbChangeTracker,
  stateCounterFilePath,
} from './db-change.js';

// Re-import fs for real mkdtempSync
import * as fsReal from 'node:fs';

function stateCounterFile(cacheDir: string, worklogDir: string): string {
  const hash = createHash('sha256').update(path.resolve(worklogDir)).digest('hex');
  return path.join(cacheDir, 'state', `${hash}.json`);
}

// ---------------------------------------------------------------------------
// beforeEach / afterEach helpers
// ---------------------------------------------------------------------------

function tempDir(): string {
  return fsReal.mkdtempSync(path.join(os.tmpdir(), 'db-change-test-'));
}

beforeEach(() => {
  mockFileSyncContents = {};
  mockFileSyncThrowFor = null;
  vi.clearAllMocks();
});

afterEach(() => {
  // Clean up env vars
  delete process.env.WL_CACHE_DIR;
  delete process.env.XDG_CACHE_HOME;
});

// ---------------------------------------------------------------------------
// resolveCacheDir
// ---------------------------------------------------------------------------

describe('resolveCacheDir', () => {
  it('returns WL_CACHE_DIR when set', () => {
    process.env.WL_CACHE_DIR = '/custom/cache';
    expect(resolveCacheDir()).toBe('/custom/cache');
  });

  it('falls back to $XDG_CACHE_HOME/wl when WL_CACHE_DIR is not set', () => {
    process.env.XDG_CACHE_HOME = '/custom/xdg';
    expect(resolveCacheDir()).toBe('/custom/xdg/wl');
  });

  it('falls back to ~/.cache/wl when neither env var is set', () => {
    // Ensure both are unset
    delete process.env.WL_CACHE_DIR;
    delete process.env.XDG_CACHE_HOME;
    const home = os.homedir();
    expect(resolveCacheDir()).toBe(path.join(home, '.cache', 'wl'));
  });

  it('WL_CACHE_DIR takes precedence over XDG_CACHE_HOME', () => {
    process.env.WL_CACHE_DIR = '/override';
    process.env.XDG_CACHE_HOME = '/xdg';
    expect(resolveCacheDir()).toBe('/override');
  });
});

// ---------------------------------------------------------------------------
// readStateCounter
// ---------------------------------------------------------------------------

describe('readStateCounter', () => {
  it('reads a valid counter from the cache file', () => {
    const cacheDir = tempDir();
    const worklogDir = '/some/worklog';
    const file = stateCounterFile(cacheDir, worklogDir);

    mockFileSyncContents[file] = JSON.stringify({ state: 42 });
    expect(readStateCounter(cacheDir, worklogDir)).toBe(42);
  });

  it('returns 0 when the file does not exist', () => {
    const cacheDir = tempDir();
    const worklogDir = '/some/worklog';
    expect(readStateCounter(cacheDir, worklogDir)).toBe(0);
  });

  it('returns 0 when the JSON is unparseable', () => {
    const cacheDir = tempDir();
    const worklogDir = '/some/worklog';
    const file = stateCounterFile(cacheDir, worklogDir);

    mockFileSyncContents[file] = 'not json';
    expect(readStateCounter(cacheDir, worklogDir)).toBe(0);
  });

  it('returns 0 when the JSON has no state field', () => {
    const cacheDir = tempDir();
    const worklogDir = '/some/worklog';
    const file = stateCounterFile(cacheDir, worklogDir);

    mockFileSyncContents[file] = JSON.stringify({ foo: 'bar' });
    expect(readStateCounter(cacheDir, worklogDir)).toBe(0);
  });

  it('returns 0 when the state value is not a finite number', () => {
    const cacheDir = tempDir();
    const worklogDir = '/some/worklog';
    const file = stateCounterFile(cacheDir, worklogDir);

    mockFileSyncContents[file] = JSON.stringify({ state: 'abc' });
    expect(readStateCounter(cacheDir, worklogDir)).toBe(0);

    mockFileSyncContents[file] = JSON.stringify({ state: NaN });
    expect(readStateCounter(cacheDir, worklogDir)).toBe(0);

    mockFileSyncContents[file] = JSON.stringify({ state: Infinity });
    expect(readStateCounter(cacheDir, worklogDir)).toBe(0);
  });

  it('returns 0 for a negative state value', () => {
    const cacheDir = tempDir();
    const worklogDir = '/some/worklog';
    const file = stateCounterFile(cacheDir, worklogDir);

    mockFileSyncContents[file] = JSON.stringify({ state: -1 });
    expect(readStateCounter(cacheDir, worklogDir)).toBe(0);
  });

  it('returns the floor for a fractional state value', () => {
    const cacheDir = tempDir();
    const worklogDir = '/some/worklog';
    const file = stateCounterFile(cacheDir, worklogDir);

    mockFileSyncContents[file] = JSON.stringify({ state: 42.9 });
    expect(readStateCounter(cacheDir, worklogDir)).toBe(42);
  });

  it('returns 0 when the file cannot be read (fail-open at tracker level)', () => {
    const cacheDir = tempDir();
    const worklogDir = '/some/worklog';
    const file = stateCounterFile(cacheDir, worklogDir);

    mockFileSyncThrowFor = file;
    expect(readStateCounter(cacheDir, worklogDir)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DbChangeTracker
// ---------------------------------------------------------------------------

describe('DbChangeTracker', () => {
  it('first call returns changed=true when no prior counter exists', () => {
    const tracker = new DbChangeTracker('/test/cache', '/test/worklog');
    expect(tracker.dbChanged()).toBe(true);
  });

  it('returns changed=false when the counter has not changed since the first call', () => {
    const cacheDir = tempDir();
    const worklogDir = '/test/worklog';
    const file = stateCounterFile(cacheDir, worklogDir);

    mockFileSyncContents[file] = JSON.stringify({ state: 10 });

    const tracker = new DbChangeTracker(cacheDir, worklogDir);
    expect(tracker.dbChanged()).toBe(true); // first call: no prior value
    expect(tracker.dbChanged()).toBe(false); // second call: counter still 10
  });

  it('returns changed=true when the counter has been bumped between calls', () => {
    const cacheDir = tempDir();
    const worklogDir = '/test/worklog';
    const file = stateCounterFile(cacheDir, worklogDir);

    mockFileSyncContents[file] = JSON.stringify({ state: 10 });

    const tracker = new DbChangeTracker(cacheDir, worklogDir);
    expect(tracker.dbChanged()).toBe(true);

    // Simulate the counter being bumped externally
    mockFileSyncContents[file] = JSON.stringify({ state: 11 });
    expect(tracker.dbChanged()).toBe(true);
  });

  it('returns changed=false after a bump, on subsequent reads', () => {
    const cacheDir = tempDir();
    const worklogDir = '/test/worklog';
    const file = stateCounterFile(cacheDir, worklogDir);

    mockFileSyncContents[file] = JSON.stringify({ state: 10 });

    const tracker = new DbChangeTracker(cacheDir, worklogDir);
    expect(tracker.dbChanged()).toBe(true);

    mockFileSyncContents[file] = JSON.stringify({ state: 11 });
    expect(tracker.dbChanged()).toBe(true);

    // Now it should be stable again
    expect(tracker.dbChanged()).toBe(false);
  });

  it('fail-open: read errors return changed=true', () => {
    const cacheDir = tempDir();
    const worklogDir = '/test/worklog';
    const file = stateCounterFile(cacheDir, worklogDir);

    mockFileSyncThrowFor = file;

    const tracker = new DbChangeTracker(cacheDir, worklogDir);
    expect(tracker.dbChanged()).toBe(true); // fail-open on first read

    // Fix the read — should still be changed since we never got a valid prior value
    mockFileSyncThrowFor = null;
    mockFileSyncContents[file] = JSON.stringify({ state: 5 });
    expect(tracker.dbChanged()).toBe(true); // still true: prior call errored, no valid baseline

    // Now fix and bump
    mockFileSyncContents[file] = JSON.stringify({ state: 6 });
    expect(tracker.dbChanged()).toBe(true);

    expect(tracker.dbChanged()).toBe(false);
  });

  it('fail-open: after a successful read, read error returns changed=true', () => {
    const cacheDir = tempDir();
    const worklogDir = '/test/worklog';
    const file = stateCounterFile(cacheDir, worklogDir);

    mockFileSyncContents[file] = JSON.stringify({ state: 10 });

    const tracker = new DbChangeTracker(cacheDir, worklogDir);
    expect(tracker.dbChanged()).toBe(true);
    expect(tracker.dbChanged()).toBe(false);

    // Now simulate a read error — readStateCounter returns 0, tracker
    // sees counter 0 vs lastSeen 10 → changed=true. lastSeen is updated
    // to 0 (the error-returned value).
    mockFileSyncThrowFor = file;
    expect(tracker.dbChanged()).toBe(true); // fail-open: error returns 0, 0≠10

    // Recovery: error goes away, counter is 10 vs lastSeen 0 → still changed
    mockFileSyncThrowFor = null;
    mockFileSyncContents[file] = JSON.stringify({ state: 10 });
    expect(tracker.dbChanged()).toBe(true); // 10 ≠ 0 (lastSeen updated by error)

    // Next call: stable
    expect(tracker.dbChanged()).toBe(false);
  });

  it('zero counter is treated as a valid baseline (first call returns changed=true)', () => {
    const cacheDir = tempDir();
    const worklogDir = '/test/worklog';
    const file = stateCounterFile(cacheDir, worklogDir);

    mockFileSyncContents[file] = JSON.stringify({ state: 0 });

    const tracker = new DbChangeTracker(cacheDir, worklogDir);
    expect(tracker.dbChanged()).toBe(true); // first call, no prior baseline
    expect(tracker.dbChanged()).toBe(false); // still 0, no change
  });
});
