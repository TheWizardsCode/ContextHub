/**
 * Whitelist tests for WL-0MTGDW58X007UJDS.
 * Covers AC1-AC4: empty-list strict, whitelist allow/reject (case-insensitive),
 * null/true allow-all, empty-email always refused, CLI flag override.
 */
import { describe, it, expect } from 'vitest';
import { checkAuthorIdentity } from '../src/sync.js';
import type { IncomingCommit } from '../src/sync.js';

const REF = 'refs/worklog/remotes/origin/worklog/data';
const OWN = 'me@example.com';
const ALICE = 'alice@company.com';
const BOB = 'bob@company.com';

function c(hash: string, email: string): IncomingCommit { return { hash, authorEmail: email }; }

describe('checkAuthorIdentity whitelist (WL-0MTGDW58X007UJDS)', () => {
  it('AC2: empty list (default) rejects foreign, allows own', () => {
    const r = checkAuthorIdentity([c('a','other@x')], { remoteTrackingRef: REF, expectedAuthorEmail: OWN, allowedAuthors: [] });
    expect(r.allowed).toBe(false);
    expect(checkAuthorIdentity([c('a', OWN)], { remoteTrackingRef: REF, expectedAuthorEmail: OWN, allowedAuthors: [] }).allowed).toBe(true);
  });
  it('AC2: undefined whitelist behaves like empty list (strict)', () => {
    const r = checkAuthorIdentity([c('a','other@x')], { remoteTrackingRef: REF, expectedAuthorEmail: OWN });
    expect(r.allowed).toBe(false);
  });
  it('AC2: non-empty whitelist allows listed (case-insensitive, trimmed) and rejects unlisted', () => {
    expect(checkAuthorIdentity([c('a', 'ALICE@company.com')], { remoteTrackingRef: REF, expectedAuthorEmail: OWN, allowedAuthors: [ALICE] }).allowed).toBe(true);
    expect(checkAuthorIdentity([c('a', ' alice@company.com ')], { remoteTrackingRef: REF, expectedAuthorEmail: OWN, allowedAuthors: [ALICE] }).allowed).toBe(true);
    expect(checkAuthorIdentity([c('a', BOB)], { remoteTrackingRef: REF, expectedAuthorEmail: OWN, allowedAuthors: [ALICE] }).allowed).toBe(false);
    expect(checkAuthorIdentity([c('a', OWN)], { remoteTrackingRef: REF, expectedAuthorEmail: OWN, allowedAuthors: [ALICE] }).allowed).toBe(true);
  });
  it('AC2: null and true allow any foreign author', () => {
    for (const allowAll of [null, true] as const) {
      expect(checkAuthorIdentity([c('a','any@x')], { remoteTrackingRef: REF, expectedAuthorEmail: OWN, allowedAuthors: allowAll }).allowed).toBe(true);
    }
  });
  it('AC2: empty-email always refused regardless of whitelist or allow-all', () => {
    for (const allowAll of [null, true, [ALICE]] as const) {
      const r = checkAuthorIdentity([c('a','')], { remoteTrackingRef: REF, expectedAuthorEmail: OWN, allowedAuthors: allowAll as any });
      expect(r.allowed).toBe(false);
      expect(r.violations[0].reason).toBe('empty-email');
    }
    const r2 = checkAuthorIdentity([c('a','')], { remoteTrackingRef: REF, expectedAuthorEmail: OWN, allowedAuthors: null, allowForeignAuthor: true });
    expect(r2.allowed).toBe(false);
  });
  it('AC3: CLI flag --allow-foreign-author overrides whitelist to allow-all (but not empty)', () => {
    const allowed = checkAuthorIdentity([c('a','other@x')], { remoteTrackingRef: REF, expectedAuthorEmail: OWN, allowedAuthors: [], allowForeignAuthor: true });
    expect(allowed.allowed).toBe(true);
    const stillRefused = checkAuthorIdentity([c('a','')], { remoteTrackingRef: REF, expectedAuthorEmail: OWN, allowedAuthors: [], allowForeignAuthor: true });
    expect(stillRefused.allowed).toBe(false);
  });
  it('expectedAuthorEmail comparison is case-insensitive', () => {
    expect(checkAuthorIdentity([c('a', 'ME@EXAMPLE.COM')], { remoteTrackingRef: REF, expectedAuthorEmail: OWN, allowedAuthors: [] }).allowed).toBe(true);
  });
});
