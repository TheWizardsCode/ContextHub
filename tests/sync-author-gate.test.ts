/**
 * Unit tests for the sync author-identity gate (WL-0MSOYWWS4009HTCB).
 *
 * TDD RED phase (C1): the gate is NOT implemented yet, so this module fails
 * to load with "does not provide an export named 'checkAuthorIdentity'" from
 * src/sync.js. This is the expected, documented red state — the tests go
 * green when C2 implements `checkAuthorIdentity` in src/sync.ts.
 *
 * ── Contract under test (implemented by C2) ──────────────────────────────
 *
 *   export interface IncomingCommit {
 *     hash: string;         // short commit hash (e.g. '5fc880a')
 *     authorEmail: string;  // may be '' when the commit has an empty author email
 *   }
 *
 *   export interface AuthorIdentityOptions {
 *     remoteTrackingRef: string;     // e.g. refs/worklog/remotes/origin/worklog/data
 *     expectedAuthorEmail?: string;  // repo `git config user.email`; undefined = not configured
 *     allowForeignAuthor?: boolean;  // `wl sync --allow-foreign-author`
 *   }
 *
 *   export interface AuthorIdentityViolation {
 *     commit: string;
 *     authorEmail: string;
 *     reason: 'empty-email' | 'foreign-email';
 *   }
 *
 *   export interface AuthorIdentityResult {
 *     allowed: boolean;
 *     violations: AuthorIdentityViolation[];
 *     message: string;   // refusal message naming the offending commit(s) + remote ref; '' when allowed
 *   }
 *
 *   export function checkAuthorIdentity(
 *     commits: IncomingCommit[],
 *     options: AuthorIdentityOptions
 *   ): AuthorIdentityResult
 *
 * ── Gate rules (parent ACs + plan resolutions) ───────────────────────────
 *   (a) only own-author commits → allowed.
 *   (b) an incoming commit with an EMPTY author email → refused UNCONDITIONALLY
 *       (Q3: `--allow-foreign-author` never bypasses the empty-email gate).
 *   (c) a commit whose author email differs from expectedAuthorEmail → refused
 *       by default; allowed when allowForeignAuthor=true.
 *   (d) deterministic: the same input always yields the same result (this is
 *       what makes dry-run report the same refusal as a real sync).
 *   (Q2) when expectedAuthorEmail is undefined (user.email unset) only the
 *       empty-email gate applies; the foreign-email comparison is skipped.
 *   (AC2) the refusal message names the offending commit(s) and the remote ref.
 *
 * The git-log invocation shape (`git log <ref> --format=... --not <lastSyncedRef>`)
 * is exercised at the CLI level in tests/cli/sync-author-gate.test.ts against
 * the mock git (tests/cli/mock-bin/git), which supports both `--format=%ae`
 * and combined `--format=%h%x09%ae` shapes plus `--not <ref>`.
 */

import { describe, it, expect } from 'vitest';
import { checkAuthorIdentity } from '../src/sync.js';
import type { IncomingCommit, AuthorIdentityOptions } from '../src/sync.js';

const REMOTE_REF = 'refs/worklog/remotes/origin/worklog/data';
const OWN_EMAIL = 'ross@example.com';
const FOREIGN_EMAIL = 'other@example.com';

function own(hash: string, email: string = OWN_EMAIL): IncomingCommit {
  return { hash, authorEmail: email };
}

function emptyEmail(hash: string): IncomingCommit {
  return { hash, authorEmail: '' };
}

function options(overrides: Partial<AuthorIdentityOptions> = {}): AuthorIdentityOptions {
  return {
    remoteTrackingRef: REMOTE_REF,
    expectedAuthorEmail: OWN_EMAIL,
    ...overrides,
  };
}

describe('checkAuthorIdentity (WL-0MSOYWWS4009HTCB)', () => {
  // (a) only own-author commits → allowed
  it('allows when every incoming commit is authored by the store identity', () => {
    const result = checkAuthorIdentity(
      [own('a1b2c3d'), own('e4f5a6b')],
      options()
    );
    expect(result.allowed).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.message).toBe('');
  });

  it('allows an empty incoming commit set (no new commits since last sync)', () => {
    const result = checkAuthorIdentity([], options());
    expect(result.allowed).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.message).toBe('');
  });

  // (b) one empty-email commit → refused
  it('refuses a single empty-email commit, naming the commit and the remote ref', () => {
    const result = checkAuthorIdentity([emptyEmail('5fc880a')], options());

    expect(result.allowed).toBe(false);
    expect(result.violations).toEqual([
      { commit: '5fc880a', authorEmail: '', reason: 'empty-email' },
    ]);
    expect(result.message).toContain('5fc880a');
    expect(result.message).toContain(REMOTE_REF);
  });

  it('refuses when ANY commit in the batch has an empty email', () => {
    const result = checkAuthorIdentity(
      [own('a1b2c3d'), emptyEmail('5fc880a'), own('e4f5a6b')],
      options()
    );

    expect(result.allowed).toBe(false);
    expect(result.violations.map(v => v.commit)).toEqual(['5fc880a']);
    expect(result.violations[0].reason).toBe('empty-email');
  });

  // (Q3) --allow-foreign-author never bypasses the empty-email gate
  it('refuses an empty-email commit even when allowForeignAuthor=true (Q3)', () => {
    const result = checkAuthorIdentity(
      [emptyEmail('5fc880a')],
      options({ allowForeignAuthor: true })
    );

    expect(result.allowed).toBe(false);
    expect(result.violations[0].reason).toBe('empty-email');
  });

  // (c) different-email commit → refused by default
  it('refuses a different-email commit by default, naming the commit and the remote ref', () => {
    const result = checkAuthorIdentity(
      [own('6b9e493', FOREIGN_EMAIL)],
      options()
    );

    expect(result.allowed).toBe(false);
    expect(result.violations).toEqual([
      { commit: '6b9e493', authorEmail: FOREIGN_EMAIL, reason: 'foreign-email' },
    ]);
    expect(result.message).toContain('6b9e493');
    expect(result.message).toContain(REMOTE_REF);
  });

  // (c) different-email commit → allowed when allowForeignAuthor=true
  it('allows a different-email commit when allowForeignAuthor=true', () => {
    const result = checkAuthorIdentity(
      [own('6b9e493', FOREIGN_EMAIL)],
      options({ allowForeignAuthor: true })
    );

    expect(result.allowed).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.message).toBe('');
  });

  it('allows mixed own + foreign emails when allowForeignAuthor=true, but still refuses empty emails', () => {
    const result = checkAuthorIdentity(
      [own('a1b2c3d'), own('6b9e493', FOREIGN_EMAIL), emptyEmail('5fc880a')],
      options({ allowForeignAuthor: true })
    );

    expect(result.allowed).toBe(false);
    expect(result.violations).toEqual([
      { commit: '5fc880a', authorEmail: '', reason: 'empty-email' },
    ]);
  });

  // (Q2) expectedAuthorEmail undefined → only the empty-email gate applies
  it('skips the foreign-email comparison when expectedAuthorEmail is undefined (Q2)', () => {
    const result = checkAuthorIdentity(
      [own('6b9e493', FOREIGN_EMAIL)],
      options({ expectedAuthorEmail: undefined })
    );

    expect(result.allowed).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('still enforces the empty-email gate when expectedAuthorEmail is undefined (Q2)', () => {
    const result = checkAuthorIdentity(
      [emptyEmail('5fc880a')],
      options({ expectedAuthorEmail: undefined })
    );

    expect(result.allowed).toBe(false);
    expect(result.violations[0].reason).toBe('empty-email');
  });

  // (d) deterministic: identical input → identical result (dry-run parity)
  it('is deterministic: the same input yields the same result on every call', () => {
    const commits = [own('a1b2c3d'), emptyEmail('5fc880a')];
    const first = checkAuthorIdentity(commits, options());
    const second = checkAuthorIdentity(commits, options());

    expect(second).toEqual(first);
    expect(second.allowed).toBe(false);
    expect(second.violations).toEqual(first.violations);
    expect(second.message).toBe(first.message);
  });

  // (AC2) message naming: multiple offenders all named
  it('names every offending commit in the refusal message', () => {
    const result = checkAuthorIdentity(
      [own('6b9e493', FOREIGN_EMAIL), emptyEmail('5fc880a'), own('a1b2c3d')],
      options()
    );

    expect(result.allowed).toBe(false);
    expect(result.message).toContain('6b9e493');
    expect(result.message).toContain('5fc880a');
    expect(result.message).toContain(REMOTE_REF);
  });

  it('does not name allowed commits as violations', () => {
    const result = checkAuthorIdentity(
      [own('a1b2c3d'), emptyEmail('5fc880a')],
      options()
    );

    const namedCommits = result.violations.map(v => v.commit);
    expect(namedCommits).toEqual(['5fc880a']);
    expect(namedCommits).not.toContain('a1b2c3d');
  });
});
