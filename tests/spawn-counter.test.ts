/**
 * Unit tests for the env-gated spawn counter (F2 — WL-0MSGAEC5N006W5QA).
 *
 * The counter records `wl` process spawns so the ≥60% spawn-reduction target
 * (parent AC7) can be measured from a simulated multi-pane refresh.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { recordSpawn, readSpawnRecords, countSpawnRecords } from '../src/spawn-counter.js';
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
  });

  it('is a no-op without env configuration (never throws)', () => {
    delete process.env.WL_SPAWN_COUNT_FILE;
    delete process.env.WL_SPAWN_COUNT;
    expect(() => recordSpawn('read-work')).not.toThrow();
    expect(fs.existsSync(file)).toBe(false);
  });
});
