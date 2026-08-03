/**
 * Unit tests for foreign-item classification used by `wl doctor foreign-items`.
 *
 * A work item is *foreign* when its ID prefix (substring before the first
 * '-') does not match the project's configured prefix. IDs without a '-'
 * separator cannot be classified and are treated as NOT foreign.
 */

import { describe, it, expect } from 'vitest';
import {
  extractIdPrefix,
  isForeignItem,
  buildForeignItemReport,
} from '../src/doctor/foreign-items-check.js';

describe('extractIdPrefix', () => {
  it('returns the prefix before the first dash', () => {
    expect(extractIdPrefix('WL-0MSAH2A71000MUA3')).toBe('WL');
    expect(extractIdPrefix('SA-1234')).toBe('SA');
    expect(extractIdPrefix('OB-0MN9CZ48N0053L9Q')).toBe('OB');
  });

  it('returns null for IDs without a dash separator (cannot be classified)', () => {
    expect(extractIdPrefix('NODASH123')).toBeNull();
    expect(extractIdPrefix('12345')).toBeNull();
    expect(extractIdPrefix('')).toBeNull();
  });
});

describe('isForeignItem', () => {
  it('returns false when the prefix matches the project prefix (own item)', () => {
    expect(isForeignItem('WL-0MSAH2A71000MUA3', 'WL')).toBe(false);
    expect(isForeignItem('TEST-001', 'TEST')).toBe(false);
  });

  it('returns true when the prefix does not match (foreign item)', () => {
    // WL item in SorraAgents (SA prefix)
    expect(isForeignItem('WL-0MSAH2A71000MUA3', 'SA')).toBe(true);
    // WL item in Tableau-Card-Engine (CG prefix)
    expect(isForeignItem('WL-0MSAH2A71000MUA3', 'CG')).toBe(true);
    // WL item in open_source_llm (OSL prefix)
    expect(isForeignItem('WL-0MSAH2A71000MUA3', 'OSL')).toBe(true);
  });

  it('flags the OB- fixture as foreign in any project', () => {
    // The OB- item leaked into every project's DB including ContextHub core
    expect(isForeignItem('OB-0MN9CZ48N0053L9Q', 'WL')).toBe(true);
    expect(isForeignItem('OB-0MN9CZ48N0053L9Q', 'SA')).toBe(true);
    expect(isForeignItem('OB-0MN9CZ48N0053L9Q', 'CG')).toBe(true);
    expect(isForeignItem('OB-0MN9CZ48N0053L9Q', 'OSL')).toBe(true);
  });

  it('flags SA- items in Tableau-Card-Engine (CG prefix) as foreign', () => {
    expect(isForeignItem('SA-1234', 'CG')).toBe(true);
  });

  it('classifies deleted items the same as non-deleted (deletion is orthogonal)', () => {
    expect(isForeignItem('WL-0MSAH2A71000MUA3', 'SA')).toBe(true);
    // The classification is on the ID alone; the report builder tracks
    // deleted vs non-deleted counts separately.
  });

  it('returns false for IDs without a dash (cannot be classified -> left alone)', () => {
    expect(isForeignItem('NODASH123', 'WL')).toBe(false);
    expect(isForeignItem('12345', 'WL')).toBe(false);
    expect(isForeignItem('', 'WL')).toBe(false);
  });

  it('is case-insensitive for the configured prefix', () => {
    expect(isForeignItem('wl-abc', 'WL')).toBe(false);
    expect(isForeignItem('WL-abc', 'wl')).toBe(false);
    expect(isForeignItem('sa-abc', 'WL')).toBe(true);
  });
});

describe('buildForeignItemReport', () => {
  const baseItem = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    title: `item ${id}`,
    description: '',
    status: 'open',
    priority: 'medium',
    sortIndex: 0,
    parentId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    tags: [],
    assignee: '',
    stage: '',
    issueType: '',
    createdBy: '',
    deletedBy: '',
    deleteReason: '',
    risk: '',
    effort: '',
    ...overrides,
  });

  it('reports foreign items grouped by prefix with deleted/non-deleted breakdown', () => {
    const items = [
      baseItem('TEST-001'),                            // own
      baseItem('WL-101'),                              // foreign, active
      baseItem('WL-102', { status: 'deleted' }),       // foreign, deleted
      baseItem('OB-0MN9CZ48N0053L9Q'),                 // foreign fixture, active
      baseItem('SA-1234', { status: 'deleted' }),      // foreign, deleted
      baseItem('NODASH123'),                           // unclassifiable -> not foreign
    ];

    const report = buildForeignItemReport(items, 'TEST', true);

    expect(report.dryRun).toBe(true);
    expect(report.prefix).toBe('TEST');
    expect(report.totalItems).toBe(6);
    expect(report.foreignCount).toBe(4);

    // Grouped by prefix
    expect(report.byPrefix.WL).toEqual({
      count: 2,
      deleted: 1,
      nonDeleted: 1,
      ids: ['WL-101', 'WL-102'],
    });
    expect(report.byPrefix.OB).toEqual({
      count: 1,
      deleted: 0,
      nonDeleted: 1,
      ids: ['OB-0MN9CZ48N0053L9Q'],
    });
    expect(report.byPrefix.SA).toEqual({
      count: 1,
      deleted: 1,
      nonDeleted: 0,
      ids: ['SA-1234'],
    });
    // Own-prefix and unclassifiable items are not reported
    expect(report.byPrefix.TEST).toBeUndefined();
    expect(report.byPrefix.NODASH).toBeUndefined();

    // Deleted vs non-deleted breakdown
    expect(report.deletedForeignCount).toBe(2);
    expect(report.nonDeletedForeignCount).toBe(2);

    // Full ID list
    expect(report.foreignIds).toEqual(['WL-101', 'WL-102', 'OB-0MN9CZ48N0053L9Q', 'SA-1234']);
  });

  it('reports zero foreign items when every item matches the prefix', () => {
    const items = [
      baseItem('TEST-001'),
      baseItem('TEST-002', { status: 'deleted' }),
    ];
    const report = buildForeignItemReport(items, 'TEST', true);
    expect(report.foreignCount).toBe(0);
    expect(report.totalItems).toBe(2);
    expect(report.byPrefix).toEqual({});
    expect(report.foreignIds).toEqual([]);
  });

  it('honors a --prefix override for classification', () => {
    const items = [
      baseItem('WL-101'),
      baseItem('TEST-001'),
      baseItem('OB-1'),
    ];
    const report = buildForeignItemReport(items, 'WL', true);
    expect(report.foreignCount).toBe(2);
    expect(report.byPrefix.TEST).toEqual({ count: 1, deleted: 0, nonDeleted: 1, ids: ['TEST-001'] });
    expect(report.byPrefix.OB).toEqual({ count: 1, deleted: 0, nonDeleted: 1, ids: ['OB-1'] });
    expect(report.byPrefix.WL).toBeUndefined();
  });
});
