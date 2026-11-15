/**
 * packages/herdr/src/pane-label.test.ts — canonical pane-label parsing tests
 * (WL-0MWHWH1HV009C46C)
 *
 * Pins the settled conventions of the single canonical parser module
 * (`pane-label.ts`):
 *
 *  - `paneItemIdFromLabel` — validated trailing ` - ` suffix, `''` when
 *    absent (AC2: shape validation is authoritative, one absent-convention),
 *  - `paneKindFromLabel` — loose keyword scan over `PANE_KINDS`, `unknown`
 *    when absent,
 *  - `isDowntimePaneLabel` — the shared prefix predicate (AC3: no bare
 *    `startsWith(DOWNTIME_PANE_LABEL_PREFIX)` outside this module),
 *  - `extractWorkItemIdsFromText` — the deliberately different-granularity
 *    full-text scan over the shared `WORK_ITEM_ID_REGEX` (AC4).
 *
 * The former per-file parsers (`downtime-worker.pane.ts::paneLabelItemId`,
 * `pane-close-herdr.ts::paneItemIdFromLabel/paneKindFromLabel`,
 * `host-dispatch-budget.repair.ts` local copy) now delegate here; their
 * suites pin the same behaviour through the delegates
 * (`pane-close-herdr.test.ts`, `host-dispatch-budget.repair.test.ts`,
 * `downtime-worker.pane.test.ts`, `dispatched-pane-spawn.pin.test.ts`).
 */

import { describe, it, expect } from 'vitest';
import {
  DOWNTIME_PANE_LABEL_PREFIX,
  PANE_KINDS,
  WORK_ITEM_ID_SUFFIX_REGEX,
  extractWorkItemIdsFromText,
  isDowntimePaneLabel,
  paneItemIdFromLabel,
  paneKindFromLabel,
} from './pane-label.js';

describe('paneItemIdFromLabel — the settled validated suffix parse (AC2)', () => {
  it('extracts the token after the LAST ` - `, trimmed', () => {
    expect(paneItemIdFromLabel('Downtime triggered implement Some item - WL-ABC')).toBe('WL-ABC');
    expect(paneItemIdFromLabel('Downtime triggered plan A - B - WL-XYZ')).toBe('WL-XYZ');
    expect(paneItemIdFromLabel('Manually triggered implement Bar - CG-0XYZ')).toBe('CG-0XYZ');
  });

  it('is shape-validated: a non-ID suffix is NOT an id (authoritative safety net)', () => {
    expect(paneItemIdFromLabel('Downtime triggered implement Foo - not-an-id')).toBe('');
    expect(paneItemIdFromLabel('Downtime triggered implement Foo - WL-abc')).toBe('');
    expect(paneItemIdFromLabel('Downtime triggered implement Foo - 123')).toBe('');
    expect(paneItemIdFromLabel('foo - not an id')).toBe('');
  });

  it("returns '' when no id is present (the single absent-convention)", () => {
    expect(paneItemIdFromLabel('Downtime intake')).toBe('');
    expect(paneItemIdFromLabel('Downtime triggered implement Foo - ')).toBe('');
    expect(paneItemIdFromLabel('')).toBe('');
    expect(paneItemIdFromLabel(undefined)).toBe('');
  });

  it('the suffix validator matches the shapes real work-item ids take', () => {
    expect(WORK_ITEM_ID_SUFFIX_REGEX.test('WL-0MWHWH1HV009C46C')).toBe(true);
    expect(WORK_ITEM_ID_SUFFIX_REGEX.test('CG-0MT5Y1X5T001M4S6')).toBe(true);
    expect(WORK_ITEM_ID_SUFFIX_REGEX.test('WL-ABC')).toBe(true);
    expect(WORK_ITEM_ID_SUFFIX_REGEX.test('WL-abc')).toBe(false);
    expect(WORK_ITEM_ID_SUFFIX_REGEX.test('123')).toBe(false);
    expect(WORK_ITEM_ID_SUFFIX_REGEX.test('not-an-id')).toBe(false);
  });
});

describe('paneKindFromLabel — loose keyword scan (canonical)', () => {
  it('derives the kind from the launcher keyword for every PANE_KINDS entry', () => {
    for (const kind of PANE_KINDS) {
      expect(paneKindFromLabel(`Downtime triggered ${kind} Foo - WL-1`)).toBe(kind);
    }
  });

  it('matches on ANY substring occurrence, first kind wins in PANE_KINDS order', () => {
    // `audit` precedes `plan` in PANE_KINDS, so both-keyword labels classify audit.
    expect(paneKindFromLabel('a plan for audits')).toBe('audit');
    expect(paneKindFromLabel('Planning the migration schedule')).toBe('plan');
    expect(paneKindFromLabel('Intake form review')).toBe('intake');
  });

  it('returns unknown for unrelated/empty labels (fail-closed)', () => {
    expect(paneKindFromLabel('Work Items')).toBe('unknown');
    expect(paneKindFromLabel('')).toBe('unknown');
    expect(paneKindFromLabel(undefined)).toBe('unknown');
  });
});

describe('isDowntimePaneLabel — the shared prefix predicate (AC3)', () => {
  it('accepts only labels starting with the downtime prefix', () => {
    expect(DOWNTIME_PANE_LABEL_PREFIX).toBe('Downtime');
    expect(isDowntimePaneLabel('Downtime triggered implement Foo - WL-1')).toBe(true);
    expect(isDowntimePaneLabel('Downtime intake')).toBe(true);
    expect(isDowntimePaneLabel('Manually triggered implement Foo - WL-1')).toBe(false);
    expect(isDowntimePaneLabel('Command Output')).toBe(false);
    expect(isDowntimePaneLabel('')).toBe(false);
    expect(isDowntimePaneLabel(undefined)).toBe(false);
  });
});

describe('extractWorkItemIdsFromText — the different-granularity full-text scan (AC4)', () => {
  it('extracts every ID-shaped token, anywhere in the text, via the shared regex', () => {
    const text = `Manually triggered implement Foo - ${'WL-0MSOJLZD9004P8PI'} and AH-0MTVYBL2L0085G6G`;
    expect(extractWorkItemIdsFromText(text)).toEqual([
      'WL-0MSOJLZD9004P8PI',
      'AH-0MTVYBL2L0085G6G',
    ]);
  });

  it('uses the shared WORK_ITEM_ID_REGEX matcher (one regex, both consumers)', () => {
    expect(extractWorkItemIdsFromText('implement WL-AAA111111 AND AH-BBB222222')).toEqual([
      'WL-AAA111111',
      'AH-BBB222222',
    ]);
    // A long real-world-style id token survives the scan.
    expect(
      extractWorkItemIdsFromText(
        'Downtime triggered implement Evidence fix - WL-0MWHWH1HV009C46C',
      ),
    ).toEqual(['WL-0MWHWH1HV009C46C']);
  });

  it('returns [] for text with no ID-shaped token', () => {
    expect(extractWorkItemIdsFromText('Manually triggered implement Enable Main Street…')).toEqual([]);
    expect(extractWorkItemIdsFromText('wl-1234567890')).toEqual([]);
    expect(extractWorkItemIdsFromText('')).toEqual([]);
    expect(extractWorkItemIdsFromText(undefined as unknown as string)).toEqual([]);
  });
});

describe('canonical module is the single parse (AC1)', () => {
  it('exposes the four label-parsing primitives from one module', () => {
    expect(typeof paneItemIdFromLabel).toBe('function');
    expect(typeof paneKindFromLabel).toBe('function');
    expect(typeof isDowntimePaneLabel).toBe('function');
    expect(typeof extractWorkItemIdsFromText).toBe('function');
  });
});
