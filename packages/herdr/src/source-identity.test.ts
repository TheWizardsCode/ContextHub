/**
 * packages/herdr/src/source-identity.test.ts — running-code freshness unit
 * tests (WL-0MWWMPDVM009LTQR).
 *
 * Pins the identity resolution contract: the process start time is derived
 * from `process.uptime()`, a `git log` payload is parsed strictly, a runtime
 * that predates the checkout's `HEAD` is flagged stale, and every failure
 * path is fail-open (`null`, never a throw). The ambient dispatcher identity
 * is process-scoped and defaults to `null` so an unwired caller keeps the
 * pre-feature log shape.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  configureDispatcherSourceIdentity,
  dispatchSourceFields,
  formatStaleSourceWarning,
  getDispatcherSourceIdentity,
  parseGitHead,
  processStartMs,
  resetDispatcherSourceIdentityForTests,
  resolveSourceIdentity,
  sourceIdentityFields,
  type RuntimeSourceIdentity,
} from './source-identity.js';

const COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const COMMITTED_AT = '2026-11-24T12:19:00.000Z';
const COMMITTED_MS = Date.parse(COMMITTED_AT);

/** A resolved identity with overridable fields. */
function identity(overrides: Partial<RuntimeSourceIdentity> = {}): RuntimeSourceIdentity {
  return {
    commit: COMMIT,
    shortCommit: COMMIT.slice(0, 9),
    committedAt: COMMITTED_AT,
    startedAt: '2026-11-24T12:00:00.000Z',
    stale: false,
    ...overrides,
  };
}

afterEach(() => {
  resetDispatcherSourceIdentityForTests();
});

describe('processStartMs', () => {
  it('subtracts the process uptime from "now"', () => {
    expect(processStartMs(1_000_000, 12.7)).toBe(987_300);
  });

  it('never reports a start after "now" (clock-skew guard)', () => {
    // A negative uptime is synthetic, but the clamp must still hold.
    expect(processStartMs(1_000, -5)).toBe(1_000);
  });
});

describe('parseGitHead', () => {
  it('parses the two-line %H%n%cI payload', () => {
    expect(parseGitHead(`${COMMIT}\n${COMMITTED_AT}\n`)).toEqual({
      commit: COMMIT,
      committedAt: COMMITTED_AT,
    });
  });

  it('tolerates surrounding whitespace and blank lines', () => {
    expect(parseGitHead(`\n  ${COMMIT}  \n\n ${COMMITTED_AT} \n`)).toEqual({
      commit: COMMIT,
      committedAt: COMMITTED_AT,
    });
  });

  it('rejects a non-hash first line', () => {
    expect(parseGitHead(`not-a-hash\n${COMMITTED_AT}`)).toBeNull();
  });

  it('rejects an unparseable timestamp', () => {
    expect(parseGitHead(`${COMMIT}\nnot-a-date`)).toBeNull();
  });

  it('rejects a truncated payload', () => {
    expect(parseGitHead(COMMIT)).toBeNull();
    expect(parseGitHead('')).toBeNull();
  });
});

describe('resolveSourceIdentity', () => {
  it('flags a runtime that started before the checkout HEAD commit', () => {
    const identityResult = resolveSourceIdentity({
      repoRoot: '/repo',
      processStartMs: COMMITTED_MS - 60_000,
      nowMs: COMMITTED_MS + 600_000,
      runGit: () => `${COMMIT}\n${COMMITTED_AT}\n`,
    });
    expect(identityResult).toEqual({
      commit: COMMIT,
      shortCommit: 'a1b2c3d4e',
      committedAt: COMMITTED_AT,
      startedAt: new Date(COMMITTED_MS - 60_000).toISOString(),
      stale: true,
    });
  });

  it('does not flag a runtime started at or after the HEAD commit', () => {
    expect(
      resolveSourceIdentity({
        processStartMs: COMMITTED_MS + 1,
        nowMs: COMMITTED_MS + 1_000,
        runGit: () => `${COMMIT}\n${COMMITTED_AT}\n`,
      })?.stale,
    ).toBe(false);
    expect(
      resolveSourceIdentity({
        processStartMs: COMMITTED_MS,
        nowMs: COMMITTED_MS + 1_000,
        runGit: () => `${COMMIT}\n${COMMITTED_AT}\n`,
      })?.stale,
    ).toBe(false);
  });

  it('passes the repo root to git and stays fail-open on an exception', () => {
    const calls: (readonly string[])[] = [];
    expect(
      resolveSourceIdentity({
        repoRoot: '/some/checkout',
        processStartMs: 1,
        nowMs: 2,
        runGit: (args) => {
          calls.push(args);
          throw new Error('not a git repository');
        },
      }),
    ).toBeNull();
    expect(calls).toEqual([['-C', '/some/checkout', 'log', '-1', '--format=%H%n%cI']]);
  });

  it('is fail-open on a malformed git payload', () => {
    expect(
      resolveSourceIdentity({
        processStartMs: 1,
        nowMs: 2,
        runGit: () => 'garbage',
      }),
    ).toBeNull();
  });
});

describe('formatStaleSourceWarning', () => {
  it('names both timestamps and the restart remedy for a stale runtime', () => {
    const warning = formatStaleSourceWarning(identity({ stale: true }));
    expect(warning).not.toBeNull();
    expect(warning).toContain('stale code');
    expect(warning).toContain('a1b2c3d4e');
    expect(warning).toContain('2026-11-24T12:00:00.000Z');
    expect(warning).toContain('2026-11-24T12:19:00.000Z');
    expect(warning).toContain('Restart the Worklog plugin pane');
  });

  it('returns null for a current runtime', () => {
    expect(formatStaleSourceWarning(identity())).toBeNull();
  });
});

describe('sourceIdentityFields / ambient identity', () => {
  it('projects a resolved identity onto log fields', () => {
    expect(sourceIdentityFields(identity({ stale: true }))).toEqual({
      sourceCommit: COMMIT,
      sourceStartedAt: '2026-11-24T12:00:00.000Z',
      sourceStale: true,
    });
  });

  it('projects an unresolved identity to no fields', () => {
    expect(sourceIdentityFields(null)).toEqual({});
  });

  it('defaults the ambient identity to null (tests/unwired callers unchanged)', () => {
    expect(getDispatcherSourceIdentity()).toBeNull();
    expect(dispatchSourceFields()).toEqual({});
  });

  it('exposes the configured ambient identity to log writers', () => {
    configureDispatcherSourceIdentity(identity());
    expect(getDispatcherSourceIdentity()).not.toBeNull();
    expect(dispatchSourceFields()).toEqual({
      sourceCommit: COMMIT,
      sourceStartedAt: '2026-11-24T12:00:00.000Z',
      sourceStale: false,
    });
  });
});
