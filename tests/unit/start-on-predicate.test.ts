/**
 * Unit tests for the shared `isNotStarted(item, now)` predicate
 * (WL-0MWMGEL5R003IH71, parent WL-0MWM0FDZK007BAD0).
 *
 * `startOn` is the temporal scheduling dimension: the earliest instant at
 * which a work item may proceed. This predicate is the single definition every
 * later slice consumes — the CLI search filter, the Herdr dispatch gate and the
 * claim guard — so its contract is pinned here:
 *
 *   1. the effective start instant is `startOn ?? createdAt`, so an item with
 *      no `startOn` behaves exactly as it did before the field existed
 *      (back-compat is the default, never "blocked");
 *   2. the boundary is **inclusive** — `startOn === now` counts as started;
 *   3. `now` is an explicit millisecond parameter, never `Date.now()` inside
 *      the predicate, so a test can compare any instant deterministically;
 *   4. it **fails open**: an unreadable or absent instant reads as "started",
 *      because a scheduling hint must never hide an item.
 *
 * Every comparison goes through the shared frozen clock
 * (`tests/helpers/frozen-clock.ts`) — no wall-clock dependency anywhere.
 *
 * Why this file lives in `tests/unit/` rather than beside the module: the
 * plan's Key Files listed `packages/shared/src/predicates.test.ts`, but
 * `packages/shared/tsconfig.json` compiles `src/**\/*` with `rootDir: ./src`,
 * so a test there cannot import the repo-level frozen-clock helper (tsc
 * TS6059) and `npm run build:shared` would fail. The repo-level `tests/unit/`
 * home keeps both the shared helper and the shared build intact.
 */

import { describe, it, expect } from 'vitest';
import { isNotStarted, type StartOnFields } from '@worklog/shared/predicates';
import { createFrozenClock } from '../helpers/frozen-clock.js';

/** The frozen "now" every case compares against. */
const clock = createFrozenClock('2026-11-19T10:25:00.000Z');

/** A minimal item carrying only the fields the predicate reads. */
function item(fields: StartOnFields): StartOnFields {
  return fields;
}

describe('isNotStarted — effective instant is startOn ?? createdAt', () => {
  it('treats a startOn in the future as not started', () => {
    const subject = item({ createdAt: clock.isoAt(-86_400_000), startOn: clock.isoAt(1) });
    expect(isNotStarted(subject, clock.now())).toBe(true);
  });

  it('treats a startOn in the past as started', () => {
    const subject = item({ createdAt: clock.isoAt(-86_400_000), startOn: clock.isoAt(-1) });
    expect(isNotStarted(subject, clock.now())).toBe(false);
  });

  it('treats startOn exactly equal to now as started (boundary is inclusive)', () => {
    const subject = item({ createdAt: clock.isoAt(-86_400_000), startOn: clock.nowIso() });
    expect(isNotStarted(subject, clock.now())).toBe(false);
  });

  it('lets a future startOn override a past createdAt', () => {
    const subject = item({ createdAt: clock.isoAt(-365 * 86_400_000), startOn: clock.isoAt(3_600_000) });
    expect(isNotStarted(subject, clock.now())).toBe(true);
  });

  it('lets a past startOn override a future createdAt', () => {
    const subject = item({ createdAt: clock.isoAt(3_600_000), startOn: clock.isoAt(-3_600_000) });
    expect(isNotStarted(subject, clock.now())).toBe(false);
  });
});

describe('isNotStarted — back-compat default (no startOn)', () => {
  it('treats an absent startOn with a past createdAt as started', () => {
    expect(isNotStarted(item({ createdAt: clock.isoAt(-1) }), clock.now())).toBe(false);
  });

  it('treats an absent startOn with a future createdAt as not started', () => {
    expect(isNotStarted(item({ createdAt: clock.isoAt(1) }), clock.now())).toBe(true);
  });

  it('treats an absent createdAt and startOn as started', () => {
    expect(isNotStarted(item({}), clock.now())).toBe(false);
  });

  it('treats an explicitly null startOn as absent', () => {
    expect(isNotStarted(item({ createdAt: clock.isoAt(-1), startOn: null }), clock.now())).toBe(false);
  });

  it('treats an empty-string startOn (the --start-on "" clear) as absent', () => {
    expect(isNotStarted(item({ createdAt: clock.isoAt(-1), startOn: '' }), clock.now())).toBe(false);
    expect(isNotStarted(item({ createdAt: clock.isoAt(1), startOn: '   ' }), clock.now())).toBe(true);
  });
});

describe('isNotStarted — fail-open on unreadable values', () => {
  it('treats an unparseable startOn as started', () => {
    expect(isNotStarted(item({ createdAt: clock.isoAt(-1), startOn: 'not-a-date' }), clock.now())).toBe(false);
  });

  it('does not fall back to createdAt when startOn is present but unreadable', () => {
    // Falling back here would hide an item behind a future createdAt purely
    // because its scheduling hint is corrupt — the opposite of fail-open.
    expect(isNotStarted(item({ createdAt: clock.isoAt(3_600_000), startOn: '2026-13-45' }), clock.now())).toBe(
      false,
    );
  });

  it('treats an unparseable createdAt as started', () => {
    expect(isNotStarted(item({ createdAt: 'garbage' }), clock.now())).toBe(false);
  });

  it('never reads the wall clock — a frozen `now` decides the outcome', () => {
    // `createdAt` 2099 is in the future for the frozen now and in the past for
    // a wall-clock read today: only an injected `now` can produce `true`.
    const subject = item({ createdAt: '2099-01-01T00:00:00.000Z' });
    expect(isNotStarted(subject, clock.now())).toBe(true);
    expect(isNotStarted(subject, Date.parse('2100-01-01T00:00:00.000Z'))).toBe(false);
  });
});

describe('isNotStarted — ISO-8601 offset handling', () => {
  it('reads a UTC offset (+01:00) and a Z suffix identically', () => {
    // 2026-11-19T11:25:00+01:00 === 2026-11-19T10:25:00Z — exactly `now`.
    const withOffset = item({ createdAt: clock.nowIso(), startOn: '2026-11-19T11:25:00+01:00' });
    const withZulu = item({ createdAt: clock.nowIso(), startOn: '2026-11-19T10:25:00Z' });
    expect(isNotStarted(withOffset, clock.now())).toBe(isNotStarted(withZulu, clock.now()));
    expect(isNotStarted(withOffset, clock.now())).toBe(false);
  });

  it('compares an offset instant in the future against a Z-suffix now', () => {
    // 2026-11-19T12:25:00+01:00 === 2026-11-19T11:25:00Z — one hour ahead.
    expect(isNotStarted(item({ startOn: '2026-11-19T12:25:00+01:00' }), clock.now())).toBe(true);
  });

  it('treats a millisecond-less ISO instant as the start of that second', () => {
    // 2026-11-19T10:25:00Z is 0 ms into the second `now` sits at, so the
    // boundary is already reached.
    expect(isNotStarted(item({ startOn: '2026-11-19T10:25:00Z' }), clock.now())).toBe(false);
    expect(isNotStarted(item({ startOn: '2026-11-19T10:25:01Z' }), clock.now())).toBe(true);
  });
});

describe('frozen clock helper', () => {
  it('starts at the documented default instant and only moves on request', () => {
    const fixed = createFrozenClock();
    expect(fixed.nowIso()).toBe('2026-06-01T12:00:00.000Z');
    expect(fixed.now()).toBe(fixed.startMs);
    expect(fixed.isoAt(60_000)).toBe('2026-06-01T12:01:00.000Z');
    fixed.advance(60_000);
    expect(fixed.nowIso()).toBe('2026-06-01T12:01:00.000Z');
    fixed.set('2026-06-01T11:59:00.000Z');
    expect(fixed.nowIso()).toBe('2026-06-01T11:59:00.000Z');
  });
});
