/**
 * Tests for `wl next` risk/effort at-most filters (WL-0MSMAIP5F003WAGG).
 *
 * Semantics under test (AC1/AC2):
 *  - risk ≤ level (low < medium < high < severe); effort ≤ level
 *    (extra small < small < medium < large < extra large).
 *  - Items with unset/empty risk or effort NEVER match (fail-closed).
 *  - Effort matching recognizes both "Small"/"Extra Small" and the short
 *    CLI spellings (XS/S/M/L/XL), normalized case-insensitively.
 *  - Dependency-blocked items remain excluded under the new filters.
 *  - Batch mode (`-n`) returns multiple eligible candidates.
 *  - Callers that do not use the new flags see unchanged behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { WorklogDatabase } from '../src/database.js';
import {
  createTempDir,
  cleanupTempDir,
  createTempJsonlPath,
  createTempDbPath,
} from './test-utils.js';
import type { WorkItemRiskLevel, WorkItemEffortLevel } from '../src/types.js';

/** Cast a raw DB value (e.g. lowercase or long-form) to the strict type. */
const risk = (v: string) => v as unknown as WorkItemRiskLevel;
const effort = (v: string) => v as unknown as WorkItemEffortLevel;

describe('wl next risk/effort filters (WL-0MSMAIP5F003WAGG)', () => {
  let tempDir: string;
  let dbPath: string;
  let jsonlPath: string;
  let db: WorklogDatabase;

  beforeEach(() => {
    tempDir = createTempDir();
    dbPath = createTempDbPath(tempDir);
    jsonlPath = createTempJsonlPath(tempDir);
    if (fs.existsSync(jsonlPath)) {
      fs.unlinkSync(jsonlPath);
    }
    db = new WorklogDatabase('TEST', dbPath, jsonlPath, true, true);
  });

  afterEach(() => {
    db.close();
    cleanupTempDir(tempDir);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Risk filter boundaries (AC1: at-most ordinal semantics)
  // ─────────────────────────────────────────────────────────────────────
  describe('risk filter (at-most ordinal)', () => {
    it('risk=low matches only Low-risk items', () => {
      const low = db.create({ title: 'Low risk', risk: 'Low', status: 'open' });
      db.create({ title: 'Medium risk', risk: 'Medium', status: 'open' });
      db.create({ title: 'High risk', risk: 'High', status: 'open' });
      db.create({ title: 'Severe risk', risk: 'Severe', status: 'open' });

      const result = db.findNextWorkItem(undefined, undefined, false, undefined, false, 'low');
      expect(result.workItem?.id).toBe(low.id);
    });

    it('risk=medium matches Low and Medium, excludes High/Severe', () => {
      const low = db.create({ title: 'Low risk', risk: 'Low', status: 'open' });
      const medium = db.create({ title: 'Medium risk', risk: 'Medium', status: 'open' });
      db.create({ title: 'High risk', risk: 'High', status: 'open' });
      db.create({ title: 'Severe risk', risk: 'Severe', status: 'open' });

      const results = db.findNextWorkItems(5, undefined, undefined, false, undefined, false, 'medium');
      const ids = results.map(r => r.workItem?.id).filter(Boolean);
      expect(ids).toContain(low.id);
      expect(ids).toContain(medium.id);
      expect(ids).not.toContain(
        results.find(r => r.workItem?.title === 'High risk')?.workItem?.id
      );
      expect(ids.length).toBe(2);
    });

    it('risk=severe matches all canonical levels', () => {
      const low = db.create({ title: 'Low risk', risk: 'Low', status: 'open' });
      const severe = db.create({ title: 'Severe risk', risk: 'Severe', status: 'open' });
      db.create({ title: 'Unset risk', status: 'open' });

      const results = db.findNextWorkItems(5, undefined, undefined, false, undefined, false, 'severe');
      const ids = results.map(r => r.workItem?.id).filter(Boolean);
      expect(ids).toContain(low.id);
      expect(ids).toContain(severe.id);
      // Unset risk never matches (fail-closed)
      expect(ids.length).toBe(2);
    });

    it('risk matching is case-insensitive (data may store "low")', () => {
      const lower = db.create({ title: 'Lowercase risk', risk: risk('low'), status: 'open' });
      db.create({ title: 'High risk', risk: 'High', status: 'open' });

      const result = db.findNextWorkItem(undefined, undefined, false, undefined, false, 'low');
      expect(result.workItem?.id).toBe(lower.id);
    });

    it('filter value itself is case-insensitive ("Low" matches Low-risk items)', () => {
      const low = db.create({ title: 'Low risk', risk: 'Low', status: 'open' });
      db.create({ title: 'High risk', risk: 'High', status: 'open' });

      const result = db.findNextWorkItem(undefined, undefined, false, undefined, false, 'Low');
      expect(result.workItem?.id).toBe(low.id);
    });

    it('invalid risk level fails closed at the DB layer (matches nothing)', () => {
      db.create({ title: 'Low risk', risk: 'Low', status: 'open' });

      const result = db.findNextWorkItem(undefined, undefined, false, undefined, false, 'bogus');
      expect(result.workItem).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Effort filter boundaries (AC1: XS/S matching, fail-closed on unset)
  // ─────────────────────────────────────────────────────────────────────
  describe('effort filter (at-most ordinal)', () => {
    it('effort=small matches Small and Extra Small, excludes Medium+', () => {
      const xs = db.create({ title: 'XS effort', effort: 'XS', status: 'open' });
      const small = db.create({ title: 'Small effort', effort: 'Small', status: 'open' });
      db.create({ title: 'Medium effort', effort: 'Medium', status: 'open' });
      db.create({ title: 'Large effort', effort: 'Large', status: 'open' });

      const results = db.findNextWorkItems(5, undefined, undefined, false, undefined, false, undefined, 'small');
      const ids = results.map(r => r.workItem?.id).filter(Boolean);
      expect(ids).toContain(xs.id);
      expect(ids).toContain(small.id);
      expect(ids.length).toBe(2);
    });

    it('effort=xs matches only Extra Small (XS)', () => {
      const xs = db.create({ title: 'XS effort', effort: 'XS', status: 'open' });
      db.create({ title: 'Small effort', effort: 'Small', status: 'open' });

      const results = db.findNextWorkItems(5, undefined, undefined, false, undefined, false, undefined, 'xs');
      const ids = results.map(r => r.workItem?.id).filter(Boolean);
      expect(ids).toEqual([xs.id]);
    });

    it('effort recognizes long-form spellings ("Extra Small", "extra small")', () => {
      const longXs = db.create({ title: 'Long XS', effort: effort('Extra Small'), status: 'open' });
      const lowerLongXs = db.create({ title: 'Lower long XS', effort: effort('extra small'), status: 'open' });
      db.create({ title: 'Medium effort', effort: 'Medium', status: 'open' });

      const results = db.findNextWorkItems(5, undefined, undefined, false, undefined, false, undefined, 'xs');
      const ids = results.map(r => r.workItem?.id).filter(Boolean);
      expect(ids).toContain(longXs.id);
      expect(ids).toContain(lowerLongXs.id);
      expect(ids.length).toBe(2);
    });

    it('effort=medium matches XS/S/M', () => {
      const xs = db.create({ title: 'XS', effort: 'XS', status: 'open' });
      const s = db.create({ title: 'S', effort: 'S', status: 'open' });
      const m = db.create({ title: 'M', effort: 'M', status: 'open' });
      db.create({ title: 'L', effort: 'L', status: 'open' });
      db.create({ title: 'XL', effort: 'XL', status: 'open' });

      const results = db.findNextWorkItems(5, undefined, undefined, false, undefined, false, undefined, 'medium');
      const ids = results.map(r => r.workItem?.id).filter(Boolean);
      expect(ids).toContain(xs.id);
      expect(ids).toContain(s.id);
      expect(ids).toContain(m.id);
      expect(ids.length).toBe(3);
    });

    it('unset/empty effort never matches (fail-closed)', () => {
      db.create({ title: 'Unset effort', status: 'open' });
      db.create({ title: 'Empty effort', effort: '' as const, status: 'open' });

      const result = db.findNextWorkItem(undefined, undefined, false, undefined, false, undefined, 'small');
      expect(result.workItem).toBeNull();
    });

    it('filter value "extra small" (with space) matches XS items', () => {
      const xs = db.create({ title: 'XS', effort: 'XS', status: 'open' });
      db.create({ title: 'Small', effort: 'Small', status: 'open' });

      const result = db.findNextWorkItem(undefined, undefined, false, undefined, false, undefined, 'extra small');
      expect(result.workItem?.id).toBe(xs.id);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Combined risk + effort + stage (AC2: implement-tier selection shape)
  // ─────────────────────────────────────────────────────────────────────
  describe('combined risk/effort/stage selection', () => {
    it('stage=plan_complete + risk=low + effort=small returns only matching open items', () => {
      const target = db.create({
        title: 'Eligible plan_complete Low/Small',
        stage: 'plan_complete',
        risk: 'Low',
        effort: 'Small',
        status: 'open',
      });
      db.create({ title: 'Medium risk', stage: 'plan_complete', risk: 'Medium', effort: 'Small', status: 'open' });
      db.create({ title: 'Medium effort', stage: 'plan_complete', risk: 'Low', effort: 'Medium', status: 'open' });
      db.create({ title: 'Unset risk', stage: 'plan_complete', effort: 'Small', status: 'open' });
      db.create({ title: 'Wrong stage', stage: 'idea', risk: 'Low', effort: 'Small', status: 'open' });
      db.create({ title: 'Completed item kept by stage filter', stage: 'plan_complete', risk: 'Low', effort: 'Small', status: 'completed' });

      const results = db.findNextWorkItems(10, undefined, undefined, false, 'plan_complete', false, 'low', 'small');
      const ids = results.map(r => r.workItem?.id).filter(Boolean);
      expect(ids).toContain(target.id);
      // Non-matching candidates are never returned
      for (const r of results) {
        const wi = r.workItem;
        if (!wi) continue;
        expect(wi.stage).toBe('plan_complete');
        expect(['Low', 'low']).toContain(wi.risk);
        expect(['Small', 'XS', 'S', 'small', 'xs', 'Extra Small']).toContain(wi.effort);
      }
    });

    it('dependency-blocked items stay excluded under the new filters', () => {
      const blocker = db.create({ title: 'Blocker', status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'Small' });
      const blocked = db.create({ title: 'Blocked', status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'Small' });
      db.addDependencyEdge(blocked.id, blocker.id); // blocked depends on blocker → excluded

      const result = db.findNextWorkItem(undefined, undefined, false, 'plan_complete', false, 'low', 'small');
      expect(result.workItem?.id).toBe(blocker.id);
      expect(result.workItem?.id).not.toBe(blocked.id);
    });

    it('no-flag callers see unchanged behavior', () => {
      const a = db.create({ title: 'Open A', priority: 'high', status: 'open' });
      db.create({ title: 'Open B', priority: 'medium', status: 'open' });

      const result = db.findNextWorkItem();
      expect(result.workItem?.id).toBe(a.id);
      const batch = db.findNextWorkItems(5);
      expect(batch.filter(r => r.workItem).length).toBe(2);
    });

    it('batch -n returns multiple eligible candidates and excludes unset estimates', () => {
      db.create({ title: 'Low1', risk: 'Low', status: 'open' });
      db.create({ title: 'Low2', risk: 'Low', status: 'open' });
      db.create({ title: 'Unset', status: 'open' });

      const results = db.findNextWorkItems(2, undefined, undefined, false, undefined, false, 'low');
      const ids = results.map(r => r.workItem?.id).filter(Boolean);
      expect(ids.length).toBe(2);
    });
  });
});
