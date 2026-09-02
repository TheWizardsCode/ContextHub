/**
 * packages/herdr/src/downtime-round-robin-by-root.test.ts — Global per-worklogRoot
 * round-robin cursor tests.
 *
 * Parent: WL-0MTJ7IEI80055V2V (Fair round-robin work scheduling with priority
 * override).
 * Child:  WL-0MTJDX4M4007YH5U (Implement: global round-robin cursor module).
 *
 * Tests cover:
 * 1. Fail-open: load returns {} on missing file, empty file, corrupt JSON
 * 2. Atomic persistence: save/load round-trip via tmp+rename
 * 3. Selection: least-recently-served root is selected among known roots
 * 4. New roots: unknown roots sort first (never penalised)
 * 5. Cursor advance: selected root's timestamp is updated and persisted
 * 6. Concurrent access: lock contention returns first root (fail-open)
 * 7. Machine-dir resolution: all paths resolve relative to coordination dir
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadRoundRobinCursor,
  saveRoundRobinCursor,
  selectLeastRecentlyServed,
  advanceRoot,
  ROUND_ROBIN_BY_ROOT_FILE_NAME,
} from './downtime-round-robin-by-root';

// ── Helper: in-memory tmp directory ──────────────────────────────────────

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rr-root-test-'));
}

function cleanupDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── Test 1: Fail-open on missing file ───────────────────────────────────

describe('fail-open: missing file', () => {
  it('returns empty object when cursor file does not exist', () => {
    const tmpDir = mkTmpDir();
    try {
      const data = loadRoundRobinCursor(tmpDir);
      expect(data).toEqual({});
    } finally {
      cleanupDir(tmpDir);
    }
  });

  it('returns first root when no cursor exists (selectLeastRecentlyServed)', () => {
    const tmpDir = mkTmpDir();
    try {
      const result = selectLeastRecentlyServed(tmpDir, ['alpha', 'beta', 'gamma'], Date.now());
      expect(result).toBe('alpha'); // first root in original order
    } finally {
      cleanupDir(tmpDir);
    }
  });
});

// ── Test 2: Fail-open on empty file ─────────────────────────────────────

describe('fail-open: empty file', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkTmpDir();
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it('returns empty object on empty file', () => {
    const filePath = path.join(tmpDir, ROUND_ROBIN_BY_ROOT_FILE_NAME);
    fs.writeFileSync(filePath, '');
    const data = loadRoundRobinCursor(tmpDir);
    expect(data).toEqual({});
  });

  it('treats empty file as no history for selection', () => {
    const filePath = path.join(tmpDir, ROUND_ROBIN_BY_ROOT_FILE_NAME);
    fs.writeFileSync(filePath, '');
    const result = selectLeastRecentlyServed(tmpDir, ['alpha', 'beta'], Date.now());
    expect(result).toBe('alpha'); // unknown roots sort first
  });
});

// ── Test 3: Fail-open on corrupt JSON ───────────────────────────────────

describe('fail-open: corrupt JSON', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkTmpDir();
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it('returns empty object on invalid JSON', () => {
    const filePath = path.join(tmpDir, ROUND_ROBIN_BY_ROOT_FILE_NAME);
    fs.writeFileSync(filePath, 'not valid json{{{');
    const data = loadRoundRobinCursor(tmpDir);
    expect(data).toEqual({});
  });

  it('returns empty object on non-object JSON (array)', () => {
    const filePath = path.join(tmpDir, ROUND_ROBIN_BY_ROOT_FILE_NAME);
    fs.writeFileSync(filePath, '[1, 2, 3]');
    const data = loadRoundRobinCursor(tmpDir);
    expect(data).toEqual({});
  });

  it('returns empty object on null JSON', () => {
    const filePath = path.join(tmpDir, ROUND_ROBIN_BY_ROOT_FILE_NAME);
    fs.writeFileSync(filePath, 'null');
    const data = loadRoundRobinCursor(tmpDir);
    expect(data).toEqual({});
  });

  it('skips entries with invalid timestamps', () => {
    const filePath = path.join(tmpDir, ROUND_ROBIN_BY_ROOT_FILE_NAME);
    fs.writeFileSync(filePath, JSON.stringify({
      'alpha': 'not-a-date',
      'beta': '2026-09-02T00:00:00.000Z',
      'gamma': 12345,
      '': '2026-09-02T00:00:00.000Z', // empty key
    }));
    const data = loadRoundRobinCursor(tmpDir);
    expect(data).toEqual({ 'beta': '2026-09-02T00:00:00.000Z' });
  });

  it('does not throw on binary garbage', () => {
    const filePath = path.join(tmpDir, ROUND_ROBIN_BY_ROOT_FILE_NAME);
    fs.writeFileSync(filePath, Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    expect(() => loadRoundRobinCursor(tmpDir)).not.toThrow();
  });
});

// ── Test 4: Atomic persistence (save/load round-trip) ───────────────────

describe('atomic persistence', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkTmpDir();
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it('saves and loads cursor via JSON round-trip', () => {
    const data = { 'alpha': '2026-09-02T00:00:00.000Z' };
    saveRoundRobinCursor(tmpDir, data);
    const loaded = loadRoundRobinCursor(tmpDir);
    expect(loaded).toEqual(data);
  });

  it('persists multiple root entries', () => {
    const data = {
      'alpha': '2026-09-02T00:00:00.000Z',
      'beta': '2026-09-02T01:00:00.000Z',
      'gamma': '2026-09-02T02:00:00.000Z',
    };
    saveRoundRobinCursor(tmpDir, data);
    const loaded = loadRoundRobinCursor(tmpDir);
    expect(loaded).toEqual(data);
  });

  it('the cursor file exists on disk after save', () => {
    const filePath = path.join(tmpDir, ROUND_ROBIN_BY_ROOT_FILE_NAME);
    saveRoundRobinCursor(tmpDir, { 'alpha': '2026-09-02T00:00:00.000Z' });
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('overwrites previous state on re-save', () => {
    saveRoundRobinCursor(tmpDir, { 'alpha': '2026-09-02T00:00:00.000Z' });
    saveRoundRobinCursor(tmpDir, { 'beta': '2026-09-02T01:00:00.000Z' });
    const loaded = loadRoundRobinCursor(tmpDir);
    expect(loaded).toEqual({ 'beta': '2026-09-02T01:00:00.000Z' });
  });
});

// ── Test 5: Selection — least-recently-served ───────────────────────────

describe('selection: least-recently-served', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkTmpDir();
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it('selects the root with the oldest timestamp among known roots', () => {
    saveRoundRobinCursor(tmpDir, {
      'alpha': '2026-09-02T02:00:00.000Z', // newest
      'beta': '2026-09-02T00:00:00.000Z', // oldest
      'gamma': '2026-09-02T01:00:00.000Z',
    });
    const result = selectLeastRecentlyServed(
      tmpDir,
      ['alpha', 'beta', 'gamma'],
      Date.now(),
    );
    expect(result).toBe('beta'); // oldest
  });

  it('selects alphabetically on timestamp tie', () => {
    saveRoundRobinCursor(tmpDir, {
      'gamma': '2026-09-02T00:00:00.000Z',
      'alpha': '2026-09-02T00:00:00.000Z',
      'beta': '2026-09-02T00:00:00.000Z',
    });
    const result = selectLeastRecentlyServed(
      tmpDir,
      ['gamma', 'alpha', 'beta'],
      Date.now(),
    );
    expect(result).toBe('alpha'); // tie-break: alphabetical
  });

  it('selects from a single root', () => {
    saveRoundRobinCursor(tmpDir, { 'alpha': '2026-09-02T00:00:00.000Z' });
    const result = selectLeastRecentlyServed(tmpDir, ['alpha'], Date.now());
    expect(result).toBe('alpha');
  });

  it('returns null when no roots provided', () => {
    const result = selectLeastRecentlyServed(tmpDir, [], Date.now());
    expect(result).toBeNull();
  });
});

// ── Test 6: New / unknown roots sort first ──────────────────────────────

describe('new roots sort first', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkTmpDir();
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it('selects unknown root before any known root', () => {
    saveRoundRobinCursor(tmpDir, {
      'alpha': '2026-09-02T00:00:00.000Z',
    });
    // beta is unknown
    const result = selectLeastRecentlyServed(
      tmpDir,
      ['alpha', 'beta'],
      Date.now(),
    );
    expect(result).toBe('beta'); // unknown sorts first
  });

  it('multiple unknown roots sorted alphabetically', () => {
    saveRoundRobinCursor(tmpDir, {
      'alpha': '2026-09-02T00:00:00.000Z',
    });
    // beta and gamma are unknown
    const result = selectLeastRecentlyServed(
      tmpDir,
      ['alpha', 'gamma', 'beta'],
      Date.now(),
    );
    expect(result).toBe('beta'); // unknown roots: alpha-sort
  });

  it('all unknown roots — alphabetically first selected', () => {
    const result = selectLeastRecentlyServed(
      tmpDir,
      ['gamma', 'alpha', 'beta'],
      Date.now(),
    );
    expect(result).toBe('alpha'); // all unknown → alpha-sort
  });
});

// ── Test 7: Cursor advance on selection ─────────────────────────────────

describe('cursor advance on selection', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkTmpDir();
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it('updates the selected root\'s timestamp after selection', () => {
    saveRoundRobinCursor(tmpDir, {
      'alpha': '2026-09-02T00:00:00.000Z',
      'beta': '2026-09-02T01:00:00.000Z',
    });
    const before = loadRoundRobinCursor(tmpDir);
    const selected = selectLeastRecentlyServed(
      tmpDir,
      ['alpha', 'beta'],
      1_700_000_000_000, // fixed timestamp
    );
    expect(selected).toBe('alpha'); // oldest
    const after = loadRoundRobinCursor(tmpDir);
    expect(after['alpha']).toBe(new Date(1_700_000_000_000).toISOString());
    expect(after['beta']).toBe('2026-09-02T01:00:00.000Z'); // unchanged
  });

  it('unknown root gets a timestamp after first selection', () => {
    const result = selectLeastRecentlyServed(
      tmpDir,
      ['alpha', 'beta'],
      1_700_000_000_000,
    );
    expect(result).toBe('alpha'); // unknown, alpha-sort
    const data = loadRoundRobinCursor(tmpDir);
    expect(data['alpha']).toBe(new Date(1_700_000_000_000).toISOString());
    expect(data['beta']).toBeUndefined(); // beta still unknown
  });

  it('consecutive selections cycle through roots', () => {
    // First dispatch: alpha is unknown → selected
    const first = selectLeastRecentlyServed(
      tmpDir,
      ['alpha', 'beta'],
      1_700_000_000_000,
    );
    expect(first).toBe('alpha');

    // Second dispatch: beta is now the only unknown → selected
    const second = selectLeastRecentlyServed(
      tmpDir,
      ['alpha', 'beta'],
      1_700_000_001_000,
    );
    expect(second).toBe('beta'); // beta was never served, alpha was

    // Third dispatch: both known, alpha is oldest → selected
    const third = selectLeastRecentlyServed(
      tmpDir,
      ['alpha', 'beta'],
      1_700_000_002_000,
    );
    expect(third).toBe('alpha'); // alpha was served at 000, beta at 001
  });
});

// ── Test 8: advanceRoot helper ──────────────────────────────────────────

describe('advanceRoot', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkTmpDir();
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it('records a root as served without selecting', () => {
    advanceRoot(tmpDir, 'gamma', 1_700_000_000_000);
    const data = loadRoundRobinCursor(tmpDir);
    expect(data['gamma']).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it('updates existing root timestamp', () => {
    saveRoundRobinCursor(tmpDir, { 'alpha': '2026-09-02T00:00:00.000Z' });
    advanceRoot(tmpDir, 'alpha', 1_700_000_000_000);
    const data = loadRoundRobinCursor(tmpDir);
    expect(data['alpha']).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it('does nothing on empty root', () => {
    saveRoundRobinCursor(tmpDir, { 'alpha': '2026-09-02T00:00:00.000Z' });
    advanceRoot(tmpDir, '', 1_700_000_000_000);
    const data = loadRoundRobinCursor(tmpDir);
    expect(data).toEqual({ 'alpha': '2026-09-02T00:00:00.000Z' });
    expect(Object.keys(data).length).toBe(1);
  });

  it('presents a new root for selection after advance', () => {
    // beta is newly introduced after alpha, so beta's advance is newer than alpha.
    saveRoundRobinCursor(tmpDir, { 'alpha': '2026-09-02T00:00:00.000Z' });
    const betaAdvanceMs = new Date('2026-09-02T01:00:00.000Z').getTime();
    const selectMs = new Date('2026-09-02T02:00:00.000Z').getTime();
    advanceRoot(tmpDir, 'beta', betaAdvanceMs);
    const result = selectLeastRecentlyServed(tmpDir, ['alpha', 'beta'], selectMs);
    // alpha at 00:00 (older), beta at 01:00 (newer) → alpha selected (oldest)
    expect(result).toBe('alpha');
  });
});

// ── Test 9: Cursor persistence across restart ───────────────────────────

describe('cursor persists across restart', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkTmpDir();
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it('cursor state survives a simulated leader restart', () => {
    // First "leader instance": selects and advances cursor
    const first = selectLeastRecentlyServed(
      tmpDir,
      ['alpha', 'beta', 'gamma'],
      1_700_000_000_000,
    );
    expect(first).toBe('alpha'); // unknown, alpha-sort

    // Simulate restart: reload from disk
    const data = loadRoundRobinCursor(tmpDir);
    expect(data['alpha']).toBe(new Date(1_700_000_000_000).toISOString());
    expect(data['beta']).toBeUndefined();

    // Second "leader instance": beta should be selected next (only unknown)
    const second = selectLeastRecentlyServed(
      tmpDir,
      ['alpha', 'beta', 'gamma'],
      1_700_000_001_000,
    );
    expect(second).toBe('beta'); // unknown
  });

  it('oldest-root selection persists across restarts', () => {
    // Pre-populate cursor: alpha oldest, gamma newest.
    saveRoundRobinCursor(tmpDir, {
      'alpha': '2026-09-02T00:00:00.000Z',
      'beta': '2026-09-02T01:00:00.000Z',
      'gamma': '2026-09-02T02:00:00.000Z',
    });

    const firstMs = new Date('2026-09-02T03:00:00.000Z').getTime();
    const secondMs = new Date('2026-09-02T04:00:00.000Z').getTime();

    // Restart 1: alpha is oldest → selected, advanced to 03:00
    const first = selectLeastRecentlyServed(tmpDir, ['alpha', 'beta', 'gamma'], firstMs);
    expect(first).toBe('alpha'); // oldest known

    // Restart 2: alpha now at 03:00 (newest), beta at 01:00 (oldest) → beta
    const second = selectLeastRecentlyServed(tmpDir, ['alpha', 'beta', 'gamma'], secondMs);
    expect(second).toBe('beta'); // beta is now oldest after alpha advanced
  });
});

// ── Test 10: Machine-dir resolution ─────────────────────────────────────

describe('machine-dir resolution', () => {
  it('all file paths resolve relative to coordination directory', () => {
    const tmpDir = mkTmpDir();
    try {
      const filePath = path.join(tmpDir, ROUND_ROBIN_BY_ROOT_FILE_NAME);
      saveRoundRobinCursor(tmpDir, { 'alpha': '2026-09-02T00:00:00.000Z' });
      expect(fs.existsSync(filePath)).toBe(true);

      const data = loadRoundRobinCursor(tmpDir);
      expect(data['alpha']).toBe('2026-09-02T00:00:00.000Z');
    } finally {
      cleanupDir(tmpDir);
    }
  });

  it('creates the coordination directory if it does not exist', () => {
    const nestedDir = path.join(mkTmpDir(), 'sub', 'coord-dir');
    try {
      saveRoundRobinCursor(nestedDir, { 'alpha': '2026-09-02T00:00:00.000Z' });
      const filePath = path.join(nestedDir, ROUND_ROBIN_BY_ROOT_FILE_NAME);
      expect(fs.existsSync(filePath)).toBe(true);
    } finally {
      cleanupDir(nestedDir);
    }
  });
});

// ── Test 11: Concurrent access (lock contention) ────────────────────────

describe('concurrent access safety', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkTmpDir();
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it('returns first root when lock is contended (fail-open)', async () => {
    const { tryAcquireCoordLock: tryLock } = await import('./coordination.js');
    const release = tryLock(tmpDir);
    expect(release).not.toBeNull();

    // Now selectLeastRecentlyServed should fail-open to first root.
    const result = selectLeastRecentlyServed(
      tmpDir,
      ['beta', 'alpha'],
      Date.now(),
    );
    expect(result).toBe('beta'); // fail-open: original order, first root
    release!();
  });

  it('advanceRoot is safe under lock contention', async () => {
    const { tryAcquireCoordLock: tryLock } = await import('./coordination.js');
    const release = tryLock(tmpDir);
    expect(release).not.toBeNull();

    // advanceRoot should silently fail (not throw).
    expect(() => advanceRoot(tmpDir, 'alpha', Date.now())).not.toThrow();
    release!();
  });
});

// ── Test 12: Round-robin alternation (integration-level proof) ──────────

describe('round-robin alternation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkTmpDir();
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it('two non-critical entries from different projects alternate', () => {
    const roots = ['contexthub', 'sorraagents'];
    const results: string[] = [];

    // Simulate consecutive dispatch cycles.
    for (let i = 0; i < 6; i++) {
      const selected = selectLeastRecentlyServed(
        tmpDir,
        roots,
        1_700_000_000_000 + i * 1000,
      );
      results.push(selected!);
    }

    // Should alternate: contexthub, sorraagents, contexthub, sorraagents, ...
    expect(results[0]).toBe('contexthub');
    expect(results[1]).toBe('sorraagents');
    expect(results[2]).toBe('contexthub');
    expect(results[3]).toBe('sorraagents');
    expect(results[4]).toBe('contexthub');
    expect(results[5]).toBe('sorraagents');
  });
});
