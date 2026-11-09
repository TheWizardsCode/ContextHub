/**
 * packages/herdr/src/downtime-worker.clamps.test.ts — `clampDowntimeWorklogRoots`
 * contract (test-first WL-0MW4ZNYSV002LJDZ, parent WL-0MVR8GDJ3008WY3Y AC6/AC9).
 *
 * The additive `downtimeWorklogRoots: string[]` setting registers extra
 * worklog roots the downtime leader may sweep. Its PURE half is a clamp living
 * beside the other `clampDowntime*` helpers: it bounds the element count and
 * rejects every non-string / blank / duplicate entry deterministically, with
 * no filesystem access (the load-time `.worklog/worklog.db` validation and
 * realpath normalisation live in `settings.ts` — see `settings.test.ts`).
 *
 * RED WITNESS. Neither the setting nor the clamp exists yet, so every target
 * spec is committed with `it(...)` — the suite stays GREEN while the
 * assertions are RED (the repo's documented TDD pattern, see
 * `packages/herdr/src/index.test.ts`, test-first WL-0MVF3PYO3000EVJ3).
 * Implementation child WL-0MW4ZOIJE001ROA4 flips each `it.fails` to `it` when
 * the clamp lands.
 *
 * Frozen contract:
 *  1. absent / non-array → `[]` (fail-safe; never throws, never coerces)
 *  2. non-string entries are dropped (numbers, booleans, null, objects)
 *  3. surrounding whitespace is trimmed; blank entries are dropped
 *  4. duplicates collapse, first-seen order is preserved
 *  5. the element count is bounded by `MAX_DOWNTIME_WORKLOG_ROOTS`
 *     (excess dropped from the tail; the surviving prefix keeps its order)
 *  6. idempotent — clamping an already-clamped registry is a fixed point
 */

import { describe, it, expect } from 'vitest';
import * as clampsModule from './downtime-worker.clamps.js';

/**
 * The clamp surface I1 must add. Reached through a namespace cast so this
 * file compiles (and the suite stays green) before the export exists.
 */
const futureClamps = clampsModule as unknown as {
  clampDowntimeWorklogRoots?: (value: unknown) => string[];
  MAX_DOWNTIME_WORKLOG_ROOTS?: number;
};

const clamp = (value: unknown): string[] => futureClamps.clampDowntimeWorklogRoots!(value);

/** A registry of `count` distinct, plausible root paths. */
function roots(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `/repo/root-${index}`);
}

describe('clampDowntimeWorklogRoots — fail-safe default (parent AC6)', () => {
  it('defaults an absent registry to an empty array', () => {
    expect(clamp(undefined)).toEqual([]);
  });

  it('defaults a null registry to an empty array', () => {
    expect(clamp(null)).toEqual([]);
  });

  it('treats an explicit empty registry as an empty array', () => {
    expect(clamp([])).toEqual([]);
  });

  it('rejects a non-array registry deterministically', () => {
    // A string is the tempting "single root" shorthand — it is NOT an entry:
    // the setting is an array and every other shape falls through to [].
    expect(clamp('/repo/only')).toEqual([]);
    expect(clamp(42)).toEqual([]);
    expect(clamp(true)).toEqual([]);
    expect(clamp({ 0: '/repo/a' })).toEqual([]);
  });
});

describe('clampDowntimeWorklogRoots — deterministic entry validation (parent AC9)', () => {
  it('drops every non-string entry and keeps the string entries', () => {
    expect(
      clamp(['/repo/a', 1, true, null, undefined, {}, ['/repo/b'], '/repo/c']),
    ).toEqual(['/repo/a', '/repo/c']);
  });

  it('drops blank and whitespace-only entries', () => {
    expect(clamp(['', '   ', '\t\n', '/repo/a'])).toEqual(['/repo/a']);
  });

  it('trims surrounding whitespace off each entry', () => {
    expect(clamp(['  /repo/a  ', '\t/repo/b\n'])).toEqual(['/repo/a', '/repo/b']);
  });

  it('collapses duplicates while preserving first-seen order', () => {
    expect(clamp(['/repo/b', '/repo/a', '/repo/b', ' /repo/a '])).toEqual([
      '/repo/b',
      '/repo/a',
    ]);
  });

  it('returns an empty array when every entry is rejected', () => {
    expect(clamp([1, null, '', '  '])).toEqual([]);
  });
});

describe('clampDowntimeWorklogRoots — element-count bound (parent risk: config size)', () => {
  it('exports MAX_DOWNTIME_WORKLOG_ROOTS as a positive integer bound', () => {
    expect(Number.isInteger(futureClamps.MAX_DOWNTIME_WORKLOG_ROOTS)).toBe(true);
    expect(futureClamps.MAX_DOWNTIME_WORKLOG_ROOTS).toBeGreaterThan(0);
  });

  it('accepts a registry at the bound unchanged', () => {
    const max = futureClamps.MAX_DOWNTIME_WORKLOG_ROOTS!;
    expect(clamp(roots(max))).toEqual(roots(max));
  });

  it('bounds an over-long registry to the bound, keeping the leading entries', () => {
    const max = futureClamps.MAX_DOWNTIME_WORKLOG_ROOTS!;
    const oversized = roots(max + 5);
    const clamped = clamp(oversized);
    expect(clamped).toHaveLength(max);
    expect(clamped).toEqual(oversized.slice(0, max));
  });

  it('applies the bound AFTER rejecting invalid entries (junk never consumes a slot)', () => {
    const max = futureClamps.MAX_DOWNTIME_WORKLOG_ROOTS!;
    const oversized = roots(max + 5);
    const padded = oversized.flatMap((root) => [root, '', 1 as unknown as string]);
    expect(clamp(padded)).toEqual(oversized.slice(0, max));
  });
});

describe('clampDowntimeWorklogRoots — determinism', () => {
  it('is idempotent (clamping a clamped registry is a fixed point)', () => {
    const once = clamp(['  /repo/b ', '/repo/a', '/repo/b', 7]);
    expect(clamp(once)).toEqual(once);
  });

  it('produces the same result for the same input on every call', () => {
    const input = ['/repo/a', '/repo/b', '/repo/a'] as unknown[];
    expect(clamp(input)).toEqual(clamp(input));
  });
});
