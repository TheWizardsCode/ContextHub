/**
 * `startOn` data model — type/field registry, storage invariant, index and
 * schema versioning (WL-0MWMGEPY2004EDZ8, parent WL-0MWM0FDZK007BAD0).
 *
 * These tests pin the *storage* half of AC1: `startOn` is a first-class,
 * always-populated column whose default is the item's `createdAt`. The
 * predicate's own behaviour is locked by `tests/unit/start-on-predicate.test.ts`
 * (slice 1); here the frozen clock is used wherever an instant is compared, so
 * no assertion depends on the wall clock.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import Database from 'better-sqlite3';
import { WorklogDatabase } from '../../src/database.js';
import { CURRENT_SCHEMA_VERSION } from '../../src/migrations/index.js';
import { VALID_FIELDS, pickFields } from '@worklog/shared/fields';
import { normalizeStartOn } from '@worklog/shared/predicates';
import { isNotStarted } from '@worklog/shared/predicates';
import { createFrozenClock } from '../helpers/frozen-clock.js';
import {
  createTempDir,
  cleanupTempDir,
  createTempJsonlPath,
  createTempDbPath,
} from '../test-utils.js';

describe('startOn data model', () => {
  let tempDir: string;
  let dbPath: string;
  let jsonlPath: string;
  let db: WorklogDatabase;
  /** Previous `WL_CACHE_ENABLED` value, restored after each test. */
  let previousCacheEnv: string | undefined;

  beforeEach(() => {
    // Several tests mutate a row with raw SQL to reproduce a legacy store;
    // only an uncached read can observe that, so the row cache is disabled
    // exactly as a fresh `wl` process runs it (see bench/start-on-filter-baseline.ts).
    previousCacheEnv = process.env.WL_CACHE_ENABLED;
    process.env.WL_CACHE_ENABLED = '0';
    tempDir = createTempDir();
    dbPath = createTempDbPath(tempDir);
    jsonlPath = createTempJsonlPath(tempDir);
    db = new WorklogDatabase('TEST', dbPath, jsonlPath, false, false);
  });

  afterEach(() => {
    db.close();
    cleanupTempDir(tempDir);
    if (previousCacheEnv === undefined) delete process.env.WL_CACHE_ENABLED;
    else process.env.WL_CACHE_ENABLED = previousCacheEnv;
  });

  /** Raw SQL read/write, bypassing the store's read-path defaulting. */
  function raw<T>(fn: (conn: Database.Database) => T): T {
    const conn = new Database(dbPath);
    try {
      return fn(conn);
    } finally {
      conn.close();
    }
  }

  it('defaults startOn to the item created instant', () => {
    const item = db.create({ title: 'Unscheduled item' });

    expect(item.startOn).toBe(item.createdAt);
    // The stored row agrees with the returned item.
    expect(db.get(item.id)?.startOn).toBe(item.createdAt);
  });

  it('stores an explicit startOn, normalising an offset to UTC', () => {
    const item = db.create({
      title: 'Scheduled item',
      startOn: '2026-11-19T10:25:00+01:00',
    });

    expect(item.startOn).toBe('2026-11-19T09:25:00.000Z');
    expect(db.get(item.id)?.startOn).toBe('2026-11-19T09:25:00.000Z');
    expect(item.createdAt).not.toBe(item.startOn);
  });

  it('clears an explicit startOn back to createdAt on update', () => {
    const item = db.create({ title: 'Scheduled item', startOn: '2026-11-19T10:25:00Z' });

    const cleared = db.update(item.id, { startOn: '' });

    expect(cleared?.startOn).toBe(item.createdAt);
    expect(db.get(item.id)?.startOn).toBe(item.createdAt);
  });

  it('keeps an explicit startOn when an unrelated update leaves it out', () => {
    const scheduled = '2026-11-19T10:25:00.000Z';
    const item = db.create({ title: 'Scheduled item', startOn: scheduled });

    const updated = db.update(item.id, { title: 'Renamed item' });

    expect(updated?.startOn).toBe(scheduled);
    expect(db.get(item.id)?.startOn).toBe(scheduled);
  });

  it('bumps updatedAt for a scheduling-only change so sync sees it as the newest write', () => {
    const clock = createFrozenClock();
    const item = db.create({ title: 'Scheduled item' });
    // Anchor the stored write time an hour in the frozen past, so "did the
    // scheduling edit bump updatedAt?" cannot depend on the wall clock
    // happening to tick between create() and update().
    raw((conn) => {
      conn
        .prepare('UPDATE workitems SET updatedAt = ?, startOn = ? WHERE id = ?')
        .run(clock.isoAt(-60 * 60 * 1000), clock.nowIso(), item.id);
    });

    const scheduled = clock.isoAt(60 * 60 * 1000);
    const updated = db.update(item.id, { startOn: scheduled });

    expect(updated?.startOn).toBe(scheduled);
    expect(updated!.updatedAt > clock.isoAt(-60 * 60 * 1000)).toBe(true);
    // Frozen-clock sanity: the scheduling instant is genuinely in the future.
    expect(isNotStarted(updated!, clock.now())).toBe(true);
  });

  it('reads a stored NULL startOn as createdAt (legacy row back-compat)', () => {
    const item = db.create({ title: 'Legacy row' });
    raw((conn) => {
      conn.prepare('UPDATE workitems SET startOn = NULL WHERE id = ?').run(item.id);
    });

    const reloaded = db.get(item.id);

    expect(reloaded?.startOn).toBe(item.createdAt);
    // …and the item is therefore not treated as scheduled into the future.
    const clock = createFrozenClock(item.createdAt);
    expect(isNotStarted(reloaded!, clock.now())).toBe(false);
  });

  it('reports rows whose stored startOn is still NULL (the doctor input)', () => {
    const backFilled = db.create({ title: 'Back-filled row' });
    const legacy = db.create({ title: 'Legacy row' });
    raw((conn) => {
      conn.prepare('UPDATE workitems SET startOn = NULL WHERE id = ?').run(legacy.id);
    });

    expect(db.getItemIdsMissingStartOn()).toEqual([legacy.id]);
    expect(db.getItemIdsMissingStartOn()).not.toContain(backFilled.id);
  });

  it('excludes soft-deleted rows from the missing-startOn set', () => {
    const item = db.create({ title: 'Deleted row' });
    raw((conn) => {
      conn.prepare('UPDATE workitems SET startOn = NULL WHERE id = ?').run(item.id);
    });
    db.delete(item.id, { deletedBy: 'tester', deleteReason: 'retired' });

    expect(db.getItemIdsMissingStartOn()).toEqual([]);
  });

  it('creates an index on startOn that a range query actually uses', () => {
    const indexes = raw((conn) =>
      (conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'workitems'")
        .all() as Array<{ name: string }>).map((row) => row.name),
    );
    expect(indexes).toContain('idx_workitems_startOn');

    const plan = raw((conn) =>
      (conn
        .prepare('EXPLAIN QUERY PLAN SELECT id FROM workitems WHERE startOn <= ?')
        .all('2026-11-19T00:00:00.000Z') as Array<{ detail: string }>).map((row) => row.detail),
    );
    expect(plan.join(' | ')).toContain('idx_workitems_startOn');
  });

  it('records the schema version this build writes at CURRENT_SCHEMA_VERSION', () => {
    // `SCHEMA_VERSION` (shared store) and `CURRENT_SCHEMA_VERSION` (migrations)
    // must be bumped together; the store records the shared one, so comparing it
    // with the migration constant catches a half-done bump.
    expect(raw((conn) => (conn.prepare("SELECT value FROM metadata WHERE key = 'schemaVersion'").get() as any).value))
      .toBe(CURRENT_SCHEMA_VERSION);
  });

  it('exposes startOn through VALID_FIELDS and pickFields', () => {
    expect(VALID_FIELDS).toContain('startOn');

    const item = db.create({ title: 'Projected item', startOn: '2026-11-19T10:25:00Z' });
    const projected = pickFields(item, ['id', 'startOn']);

    expect(projected).toEqual({ id: item.id, startOn: '2026-11-19T10:25:00.000Z' });
  });
});

describe('normalizeStartOn', () => {
  const clock = createFrozenClock();

  it('defaults an absent value to createdAt', () => {
    expect(normalizeStartOn(undefined, clock.nowIso())).toBe(clock.nowIso());
    expect(normalizeStartOn(null, clock.nowIso())).toBe(clock.nowIso());
    expect(normalizeStartOn('   ', clock.nowIso())).toBe(clock.nowIso());
  });

  it('normalises a parseable instant to canonical UTC', () => {
    expect(normalizeStartOn('2026-11-19T10:25:00+01:00', clock.nowIso())).toBe(
      '2026-11-19T09:25:00.000Z',
    );
  });

  it('preserves an unparseable value verbatim rather than dropping scheduling data', () => {
    expect(normalizeStartOn('next tuesday', clock.nowIso())).toBe('next tuesday');
  });

  it('returns null when neither value carries anything to store', () => {
    expect(normalizeStartOn(undefined, undefined)).toBeNull();
    expect(normalizeStartOn('', '')).toBeNull();
  });

  it('is exported through the predicates subpath used by the CLI', () => {
    expect(typeof normalizeStartOn).toBe('function');
  });
});
