/**
 * Unit tests for the shared not-yet-started read filter
 * (WL-0MWMGET8N009KG33, parent WL-0MWM0FDZK007BAD0).
 *
 * The filter is the single definition every CLI search surface applies, so the
 * tests pin the *semantics* here (boundary inclusive, `in_progress` exemption,
 * opt-in window composition, fail-open) with a **frozen clock** — the filter
 * takes `now` as an explicit value, so nothing here depends on the wall clock.
 *
 * The browse-feed half (`selectBrowseFeed`) is covered here too: it is the
 * choke point `wl next`, `wl worklist` and the Herdr fetchers share, and it
 * must select the *next eligible* item when a future-dated item would
 * otherwise win on priority.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { createFrozenClock } from '../helpers/frozen-clock.js';
import {
  filterNotStarted,
  isInProgressStatus,
  isMarkedNotStarted,
  markNotStarted,
  notStartedMarker,
  notStartedSuffix,
  resolveNotStartedFilter,
  resolveNotStartedFilterFromFlags,
} from '../../src/not-started.js';
import { selectBrowseFeed } from '../../src/worklist-selection.js';
import { WorklogDatabase } from '../../src/database.js';
import {
  createTempDir,
  cleanupTempDir,
  createTempJsonlPath,
  createTempDbPath,
} from '../test-utils.js';

/** Frozen "now" for every assertion in this file. */
const clock = createFrozenClock('2026-11-18T12:00:00.000Z');

/** A future item (`startOn` after the frozen instant). */
const FUTURE = { status: 'open', createdAt: clock.isoAt(-86_400_000), startOn: clock.isoAt(3_600_000) };

/** A started item (`startOn` before the frozen instant). */
const STARTED = { status: 'open', createdAt: clock.isoAt(-86_400_000), startOn: clock.isoAt(-60_000) };

describe('resolveNotStartedFilter — default exclusion', () => {
  it('hides an item whose effective start instant is in the future', () => {
    const filter = resolveNotStartedFilter({ now: clock.now() });
    expect(filter.isNotStarted(FUTURE)).toBe(true);
    expect(filter.hides(FUTURE)).toBe(true);
  });

  it('keeps an item that has already started', () => {
    const filter = resolveNotStartedFilter({ now: clock.now() });
    expect(filter.isNotStarted(STARTED)).toBe(false);
    expect(filter.hides(STARTED)).toBe(false);
  });

  it('treats the start instant itself as started (boundary is inclusive)', () => {
    const atBoundary = { status: 'open', startOn: clock.nowIso() };
    const filter = resolveNotStartedFilter({ now: clock.now() });
    expect(filter.isNotStarted(atBoundary)).toBe(false);
    expect(filter.hides(atBoundary)).toBe(false);
  });

  it('falls back to createdAt when startOn is absent', () => {
    const filter = resolveNotStartedFilter({ now: clock.now() });
    expect(filter.hides({ status: 'open', createdAt: clock.isoAt(60_000) })).toBe(true);
    expect(filter.hides({ status: 'open', createdAt: clock.isoAt(-60_000) })).toBe(false);
  });

  it('never hides an in-progress item, even with a future startOn', () => {
    const filter = resolveNotStartedFilter({ now: clock.now() });
    const inProgress = { ...FUTURE, status: 'in-progress' };
    expect(filter.isNotStarted(inProgress)).toBe(true);
    expect(filter.hides(inProgress)).toBe(false);
    expect(isInProgressStatus(inProgress)).toBe(true);
    // The normalised spelling is exempt too.
    expect(filter.hides({ ...FUTURE, status: 'in_progress' })).toBe(false);
  });

  it('fails open when the effective instant cannot be read', () => {
    const filter = resolveNotStartedFilter({ now: clock.now() });
    expect(filter.hides({ status: 'open', createdAt: clock.isoAt(-1), startOn: 'not-a-date' })).toBe(false);
    expect(filter.hides({ status: 'open', createdAt: 'garbage' })).toBe(false);
  });
});

describe('resolveNotStartedFilter — opt-in window', () => {
  const soon = { status: 'open', startOn: '2050-01-01T00:00:00.000Z' };
  const later = { status: 'open', startOn: '2100-01-01T00:00:00.000Z' };

  it('includeNotStarted shows every not-yet-started item', () => {
    const filter = resolveNotStartedFilter({ includeNotStarted: true, now: clock.now() });
    expect(filter.optedIn).toBe(true);
    expect(filter.hides(FUTURE)).toBe(false);
    expect(filter.hides(later)).toBe(false);
  });

  it('startsBefore is an opt-in and bounds the window (strictly before)', () => {
    const bound = Date.parse('2150-01-01T00:00:00.000Z');
    const filter = resolveNotStartedFilter({ startsBefore: bound, now: clock.now() });
    expect(filter.optedIn).toBe(true);
    expect(filter.hides(soon)).toBe(false);
    expect(filter.hides(later)).toBe(false);
    // At (not before) the bound: hidden.
    expect(filter.hides({ status: 'open', startOn: '2150-01-01T00:00:00.000Z' })).toBe(true);
    expect(filter.hides({ status: 'open', startOn: '2200-01-01T00:00:00.000Z' })).toBe(true);
  });

  it('composes --include-not-started with --starts-before as "not started AND before"', () => {
    const bound = Date.parse('2150-01-01T00:00:00.000Z');
    const filter = resolveNotStartedFilter({
      includeNotStarted: true,
      startsBefore: bound,
      now: clock.now(),
    });
    expect(filter.hides(later)).toBe(false);
    expect(filter.hides({ status: 'open', startOn: '2200-01-01T00:00:00.000Z' })).toBe(true);
  });

  it('keeps started items regardless of the window bound', () => {
    const filter = resolveNotStartedFilter({ startsBefore: Date.parse('2000-01-01T00:00:00Z'), now: clock.now() });
    expect(filter.hides(STARTED)).toBe(false);
  });
});

describe('filterNotStarted / markNotStarted', () => {
  it('filters without reordering the survivors', () => {
    const filter = resolveNotStartedFilter({ now: clock.now() });
    const kept = filterNotStarted([STARTED, FUTURE, { ...STARTED, status: 'in-progress' }], filter);
    expect(kept).toHaveLength(2);
    expect(kept[0]).toBe(STARTED);
  });

  it('marks only the not-yet-started rows with notStarted: true', () => {
    const filter = resolveNotStartedFilter({ includeNotStarted: true, now: clock.now() });
    const marked = markNotStarted([STARTED, FUTURE], filter);
    expect(isMarkedNotStarted(marked[0])).toBe(false);
    expect((marked[1] as { notStarted?: true }).notStarted).toBe(true);
    // The input is untouched (the marker is a read-time enrichment).
    expect(isMarkedNotStarted(FUTURE)).toBe(false);
  });

  it('renders the trailing marker in UTC Z form of the effective instant', () => {
    expect(notStartedMarker(FUTURE)).toBe('[not started until 2026-11-18T13:00:00.000Z]');
    // An offset startOn normalises to the same UTC instant.
    expect(notStartedMarker({ startOn: '2026-11-18T14:00:00+01:00' })).toBe(
      '[not started until 2026-11-18T13:00:00.000Z]',
    );
    // A defaulted startOn marks via createdAt.
    expect(notStartedMarker({ createdAt: '2030-01-01T00:00:00.000Z' })).toBe(
      '[not started until 2030-01-01T00:00:00.000Z]',
    );
    // Unreadable instants never produce a marker.
    expect(notStartedMarker({ startOn: 'nonsense' })).toBeNull();
  });

  it('only suffixes items that carry the marker flag', () => {
    expect(notStartedSuffix(FUTURE)).toBe('');
    expect(notStartedSuffix({ ...FUTURE, notStarted: true })).toBe(
      ' [not started until 2026-11-18T13:00:00.000Z]',
    );
  });
});

describe('resolveNotStartedFilterFromFlags', () => {
  it('defaults to exclusion with no flags', () => {
    const result = resolveNotStartedFilterFromFlags({}, clock.now());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.filter.optedIn).toBe(false);
    expect(result.filter.hides(FUTURE)).toBe(true);
  });

  it('accepts --include-not-started', () => {
    const result = resolveNotStartedFilterFromFlags({ includeNotStarted: true }, clock.now());
    expect(result.ok && result.filter.optedIn).toBe(true);
  });

  it('parses --starts-before as a full ISO instant', () => {
    const result = resolveNotStartedFilterFromFlags(
      { startsBefore: '2150-01-01T11:25:00+01:00' },
      clock.now(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.filter.startsBeforeMs).toBe(Date.parse('2150-01-01T10:25:00.000Z'));
  });

  it('treats a blank --starts-before as no upper bound', () => {
    const result = resolveNotStartedFilterFromFlags({ startsBefore: '' }, clock.now());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.filter.startsBeforeMs).toBeNull();
    expect(result.filter.optedIn).toBe(false);
  });

  it('rejects a bare date with an actionable message naming the flag', () => {
    const result = resolveNotStartedFilterFromFlags({ startsBefore: '2150-01-01' }, clock.now());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('--starts-before');
    expect(result.message).toContain('2150-01-01');
  });
});

describe('selectBrowseFeed — shared browse-feed filter (frozen clock)', () => {
  let tempDir: string;
  let db: WorklogDatabase;

  beforeEach(() => {
    tempDir = createTempDir();
    const dbPath = createTempDbPath(tempDir);
    const jsonlPath = createTempJsonlPath(tempDir);
    if (fs.existsSync(jsonlPath)) fs.unlinkSync(jsonlPath);
    db = new WorklogDatabase('TEST', dbPath, jsonlPath, true, true);
  });

  afterEach(() => {
    db.close();
    cleanupTempDir(tempDir);
  });

  it('selects the next eligible (started) item instead of a future high-priority one', () => {
    const started = db.create({ title: 'Started low', priority: 'low', startOn: clock.isoAt(-60_000) });
    const future = db.create({ title: 'Future critical', priority: 'critical', startOn: clock.isoAt(3_600_000) });

    const feed = selectBrowseFeed(db, { count: 1, now: clock.now() });
    expect(feed.items.map(entry => entry.workItem?.id)).toEqual([started.id]);

    const optedIn = selectBrowseFeed(db, { count: 1, includeNotStarted: true, now: clock.now() });
    expect(optedIn.items.map(entry => entry.workItem?.id)).toEqual([future.id]);
    expect(optedIn.items[0].workItem?.notStarted).toBe(true);
  });

  it('never drops an in-progress item for a future startOn', () => {
    const inProgress = db.create({
      title: 'In-progress but scheduled ahead',
      status: 'in-progress',
      startOn: clock.isoAt(3_600_000),
    });

    const feed = selectBrowseFeed(db, { count: 5, includeInProgress: true, now: clock.now() });
    const ids = feed.items.map(entry => entry.workItem?.id);
    expect(ids).toContain(inProgress.id);
    expect(feed.items.find(entry => entry.workItem?.id === inProgress.id)?.workItem?.notStarted).toBe(true);
  });

  it('applies the --starts-before window inside selection', () => {
    const soon = db.create({ title: 'Soon', priority: 'critical', startOn: '2050-01-01T00:00:00.000Z' });
    db.create({ title: 'Far', priority: 'high', startOn: '2200-01-01T00:00:00.000Z' });

    const feed = selectBrowseFeed(db, {
      count: 5,
      startsBefore: Date.parse('2150-01-01T00:00:00.000Z'),
      now: clock.now(),
    });
    expect(feed.items.map(entry => entry.workItem?.id)).toEqual([soon.id]);
    expect(feed.items[0].workItem?.notStarted).toBe(true);
  });
});
