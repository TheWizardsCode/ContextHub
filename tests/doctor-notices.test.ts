/**
 * Unit tests for the shared doctor notices module
 * (`src/commands/doctor/notices.ts`, WL-0MW0841DG009640H).
 *
 * The pending-upgrade/read-cache notices are covered end-to-end by
 * `tests/cli/doctor-upgrade-notice.test.ts` and `tests/cli/doctor-cache.test.ts`;
 * this file pins the byte-formatting contract those notices and the `cache`
 * subcommand share, including its defensive handling of invalid input.
 */

import { describe, it, expect } from 'vitest';
import { DAY_MS, formatCacheBytes } from '../src/commands/doctor/notices.js';

describe('formatCacheBytes', () => {
  it('renders sub-KiB sizes as whole bytes', () => {
    expect(formatCacheBytes(0)).toBe('0 B');
    expect(formatCacheBytes(1)).toBe('1 B');
    expect(formatCacheBytes(1023)).toBe('1023 B');
  });

  it('escalates through KiB, MiB and GiB with one decimal place', () => {
    expect(formatCacheBytes(1024)).toBe('1.0 KiB');
    expect(formatCacheBytes(1536)).toBe('1.5 KiB');
    expect(formatCacheBytes(1024 * 1024)).toBe('1.0 MiB');
    expect(formatCacheBytes(1024 * 1024 * 1024)).toBe('1.0 GiB');
  });

  it('treats negative and non-finite input as zero bytes', () => {
    expect(formatCacheBytes(-1)).toBe('0 B');
    expect(formatCacheBytes(Number.NaN)).toBe('0 B');
    expect(formatCacheBytes(Number.POSITIVE_INFINITY)).toBe('0 B');
  });

  it('keeps the shared day constant in milliseconds', () => {
    expect(DAY_MS).toBe(24 * 60 * 60 * 1000);
  });
});
