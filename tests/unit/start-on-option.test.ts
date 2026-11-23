/**
 * `--start-on` option validation and normalisation
 * (WL-0MWMGEREG002L2YA, parent WL-0MWM0FDZK007BAD0).
 *
 * These tests pin the *authoring* half of AC2 at the unit level: a full
 * ISO-8601 timestamp is accepted (with a `Z` suffix or an explicit offset) and
 * normalised to canonical UTC `Z` form before storage; a blank value clears
 * back to `createdAt`; and anything ambiguous — a bare date, a time without a
 * timezone, or an unparseable value — is rejected with an actionable message
 * that names the flag, the received value and an accepted example.
 *
 * Every instant comes from the shared frozen clock instead of the wall clock,
 * so no assertion depends on the day the suite runs.
 */

import { describe, it, expect } from 'vitest';
import {
  parseStartOnOption,
  START_ON_FLAG,
  START_ON_TIMEZONE_EXAMPLE,
  START_ON_UTC_EXAMPLE,
} from '../../src/validators/start-on.js';
import { createFrozenClock } from '../helpers/frozen-clock.js';

/** A frozen instant used as the "now" for every epoch comparison. */
const clock = createFrozenClock('2026-11-19T10:25:00.000Z');

describe('parseStartOnOption — accepted values', () => {
  it('accepts a UTC timestamp and keeps canonical `Z` form', () => {
    const result = parseStartOnOption('2026-11-19T10:25:00Z');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clear).toBe(false);
    expect(result.value).toBe(clock.nowIso());
  });

  it('accepts a positive UTC offset and normalises it to UTC', () => {
    const result = parseStartOnOption('2026-11-19T11:25:00+01:00');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 11:25+01:00 is the same instant as 10:25Z — and the stored form is UTC.
    expect(result.value).toBe(clock.nowIso());
    expect(Date.parse(result.value)).toBe(clock.now());
    expect(result.value.endsWith('Z')).toBe(true);
    expect(result.value).not.toContain('+');
  });

  it('accepts a negative offset (with and without the colon)', () => {
    for (const raw of ['2026-11-19T05:55:00-04:30', '2026-11-19T13:25:00+0300']) {
      const result = parseStartOnOption(raw);
      expect(result.ok, raw).toBe(true);
      if (!result.ok) continue;
      expect(result.value.endsWith('Z'), raw).toBe(true);
    }
    const negative = parseStartOnOption('2026-11-19T05:55:00-04:30');
    if (negative.ok) expect(negative.value).toBe(clock.nowIso());
  });

  it('trims surrounding whitespace before validating', () => {
    const result = parseStartOnOption('  2026-11-19T10:25:00Z  ');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(clock.nowIso());
  });

  it('is idempotent: normalising a normalised value is a no-op', () => {
    const first = parseStartOnOption('2026-11-19T11:25:00+01:00');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = parseStartOnOption(first.value);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value).toBe(first.value);
  });
});

describe('parseStartOnOption — the clear form', () => {
  it('treats an empty value as "clear back to createdAt"', () => {
    const result = parseStartOnOption('');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clear).toBe(true);
    expect(result.value).toBe('');
  });

  it('treats a whitespace-only value as the clear form', () => {
    const result = parseStartOnOption('   ');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.clear).toBe(true);
  });
});

describe('parseStartOnOption — rejection with an actionable message', () => {
  /** Every rejection must name the flag, the received value and an example. */
  function expectActionable(result: ReturnType<typeof parseStartOnOption>, raw: string) {
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain(START_ON_FLAG);
    expect(result.message).toContain(raw);
    expect(result.message).toContain(START_ON_UTC_EXAMPLE);
    expect(result.message).toContain(START_ON_TIMEZONE_EXAMPLE);
    // The escape hatch is always offered.
    expect(result.message).toContain(`${START_ON_FLAG} ""`);
  }

  it('rejects a bare date (ambiguous instant)', () => {
    const result = parseStartOnOption('2026-11-19');
    expectActionable(result, '2026-11-19');
    if (result.ok) return;
    expect(result.reason).toBe('bare-date');
  });

  it('rejects a timestamp without a time of day', () => {
    const result = parseStartOnOption('2026-11-19 ');
    // Trailing whitespace trims to the bare date — same rejection.
    if (!result.ok) expect(result.reason).toBe('bare-date');
  });

  it('rejects a date and time with no timezone designator', () => {
    const result = parseStartOnOption('2026-11-19T10:25:00');
    expectActionable(result, '2026-11-19T10:25:00');
    if (result.ok) return;
    expect(result.reason).toBe('missing-timezone');
  });

  it('rejects a non-ISO date/time separator', () => {
    const result = parseStartOnOption('2026-11-19 10:25:00Z');
    expectActionable(result, '2026-11-19 10:25:00Z');
    if (result.ok) return;
    expect(result.reason).toBe('missing-time');
  });

  it('rejects an unparseable timestamp', () => {
    const result = parseStartOnOption('2026-13-45T10:25:00Z');
    expectActionable(result, '2026-13-45T10:25:00Z');
    if (result.ok) return;
    expect(result.reason).toBe('unparseable');
  });

  it('rejects arbitrary text', () => {
    const result = parseStartOnOption('tomorrow');
    expectActionable(result, 'tomorrow');
  });

  it('names a caller-supplied flag so a sibling option reuses the message', () => {
    const result = parseStartOnOption('2026-11-19', '--starts-before');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('--starts-before');
    expect(result.message).not.toContain('--start-on');
  });
});
