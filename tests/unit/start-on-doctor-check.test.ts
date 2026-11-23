/**
 * `wl doctor` checks for `startOn` (WL-0MWMGEPY2004EDZ8, parent
 * WL-0MWM0FDZK007BAD0).
 *
 * Two checks, two shapes:
 *
 * - `startOn.missing` — one **global** finding built from the raw column
 *   (`WorklogDatabase.getItemIdsMissingStartOn()`), because a loaded item
 *   always reports the `createdAt` fallback and therefore cannot reveal that
 *   the back-fill has not run.
 * - `startOn.invalid` — one **per-item** finding for a stored value that is not
 *   a parseable instant (such an item fails open, so it is never hidden).
 *
 * The checks must be read-only and must not report a healthy store.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { WorklogDatabase } from '../../src/database.js';
import { isSoftDeleted } from '@worklog/shared/predicates';
import {
  START_ON_MISSING_CHECK_ID,
  START_ON_MISSING_TYPE,
  START_ON_INVALID_CHECK_ID,
  START_ON_INVALID_TYPE,
  MISSING_SAMPLE_LIMIT,
  isUnparseableStartOn,
  summariseMissingStartOn,
  validateStartOnInstants,
} from '../../src/doctor/start-on-check.js';
import { createFrozenClock } from '../helpers/frozen-clock.js';
import {
  createTempDir,
  cleanupTempDir,
  createTempJsonlPath,
  createTempDbPath,
} from '../test-utils.js';

const clock = createFrozenClock();

describe('wl doctor startOn checks', () => {
  let tempDir: string;
  let dbPath: string;
  let jsonlPath: string;
  let db: WorklogDatabase;
  let previousCacheEnv: string | undefined;

  beforeEach(() => {
    // Raw SQL writes below are the point of these tests; a cached read would
    // hide them.
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

  /** Simulate a store the back-fill migration has not reached. */
  function clearStoredStartOn(ids: string[]): void {
    const conn = new Database(dbPath);
    try {
      for (const id of ids) {
        conn.prepare('UPDATE workitems SET startOn = NULL WHERE id = ?').run(id);
      }
    } finally {
      conn.close();
    }
  }

  it('reports no missing-startOn finding for a fully populated store', () => {
    db.create({ title: 'Scheduled', startOn: clock.isoAt(60 * 60 * 1000) });
    db.create({ title: 'Defaulted' });

    expect(db.getItemIdsMissingStartOn()).toEqual([]);
    expect(summariseMissingStartOn(db.getItemIdsMissingStartOn())).toBeNull();
  });

  it('reports one global finding naming the un-back-filled rows', () => {
    const legacy = db.create({ title: 'Legacy row' });
    db.create({ title: 'Fine row' });
    clearStoredStartOn([legacy.id]);

    const finding = summariseMissingStartOn(db.getItemIdsMissingStartOn());

    expect(finding).not.toBeNull();
    expect(finding!.checkId).toBe(START_ON_MISSING_CHECK_ID);
    expect(finding!.type).toBe(START_ON_MISSING_TYPE);
    expect(finding!.severity).toBe('warning');
    expect(finding!.itemId).toBeNull();
    expect(finding!.safe).toBe(false);
    expect(finding!.proposedFix).toBeNull();
    expect(finding!.context).toMatchObject({
      missingCount: 1,
      sampleIds: [legacy.id],
    });
    expect(finding!.message).toContain(legacy.id);
    expect(finding!.message).toContain('wl doctor upgrade --confirm');
    expect(finding!.context.remediation).toContain('docs/migrations/start_on.md');
  });

  it('bounds the id sample and counts the omitted rows', () => {
    const ids = Array.from({ length: MISSING_SAMPLE_LIMIT + 3 }, (_, index) => `TEST-M${index}`);

    const finding = summariseMissingStartOn(ids);

    expect(finding!.context.missingCount).toBe(ids.length);
    expect(finding!.context.sampleIds).toHaveLength(MISSING_SAMPLE_LIMIT);
    expect(finding!.context.omittedIds).toBe(3);
    expect(finding!.message).toContain('(+3 more)');
  });

  it('does not report a soft-deleted row as missing', () => {
    const deleted = db.create({ title: 'Deleted row' });
    clearStoredStartOn([deleted.id]);
    db.delete(deleted.id, { deletedBy: 'tester', deleteReason: 'retired' });

    expect(isSoftDeleted(db.get(deleted.id)!)).toBe(true);
    expect(summariseMissingStartOn(db.getItemIdsMissingStartOn())).toBeNull();
  });

  it('reports a per-item finding for a stored value that is not an instant', () => {
    const broken = db.create({ title: 'Broken schedule' });
    db.create({ title: 'Healthy schedule', startOn: clock.isoAt(60 * 60 * 1000) });
    const conn = new Database(dbPath);
    try {
      conn.prepare('UPDATE workitems SET startOn = ? WHERE id = ?').run('next tuesday', broken.id);
    } finally {
      conn.close();
    }

    const findings = validateStartOnInstants(db.getAll());

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      checkId: START_ON_INVALID_CHECK_ID,
      type: START_ON_INVALID_TYPE,
      severity: 'warning',
      itemId: broken.id,
      proposedFix: null,
      safe: false,
    });
    expect(findings[0].message).toContain('next tuesday');
    expect(findings[0].context.requiresManualFix).toBe(true);
  });

  it('reports nothing for a healthy store', () => {
    db.create({ title: 'Scheduled', startOn: clock.isoAt(60 * 60 * 1000) });
    db.create({ title: 'Defaulted' });

    expect(validateStartOnInstants(db.getAll())).toEqual([]);
  });

  it('treats only non-empty unparseable values as invalid', () => {
    expect(isUnparseableStartOn(null)).toBe(false);
    expect(isUnparseableStartOn(undefined)).toBe(false);
    expect(isUnparseableStartOn('  ')).toBe(false);
    expect(isUnparseableStartOn(clock.nowIso())).toBe(false);
    expect(isUnparseableStartOn('2026-11-19T10:25:00+01:00')).toBe(false);
    expect(isUnparseableStartOn('soon')).toBe(true);
  });
});
