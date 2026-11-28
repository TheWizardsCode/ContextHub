/**
 * Pure-function tests for the push-side identity guard
 * (WL-0MWGO58KL00187CO, child WL-0MWGO5IL3007JIFD).
 *
 * The push guard is the outbound mirror of the pull-side author-identity gate
 * (`checkAuthorIdentity`). These tests drive the *real* exported decision
 * function as a pure function over an input matrix — no git repository, no
 * remote, no network — so a drift in the guard order or in the sentinel set
 * fails here first (parent AC4 / child AC1–AC3).
 *
 * The function lives in `src/sync/author-identity.ts` (not the `src/sync.ts`
 * barrel, whose frozen 34-symbol surface is pinned by
 * `tests/sync/split-guard.test.ts`), so it is imported from its module path.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  INCIDENT_ERA_EMAILS,
  isIncidentEraEmail,
  checkPushAuthorIdentity,
} from '../../src/sync/author-identity.js';
import type { PushAuthorityOptions } from '../../src/sync/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The exact incident-era sentinel set (child AC2). MUST stay byte-identical to
 * the canonical source of truth,
 * `SorraAgents/scripts/check_git_identity.py::INCIDENT_ERA_EMAILS` — no
 * cross-language import exists, so this literal pin is the parity guard.
 */
const EXPECTED_SENTINELS = ['t@t.com', 't@t', 'test@test.com', 'test@test', 'cache test@test.com'];

const NON_SENTINEL = 'ross@example.com';
const ALLOW_LISTED = 'bot@example.com';
const FOREIGN = 'someone@elsewhere.test';

function decide(overrides: Partial<PushAuthorityOptions>) {
  return checkPushAuthorIdentity({ effectiveEmail: NON_SENTINEL, ...overrides });
}

describe('INCIDENT_ERA_EMAILS parity (child AC2)', () => {
  it('pins the exact sentinel set (byte-identical to check_git_identity.py)', () => {
    expect([...INCIDENT_ERA_EMAILS].sort()).toEqual([...EXPECTED_SENTINELS].sort());
    expect(INCIDENT_ERA_EMAILS.size).toBe(EXPECTED_SENTINELS.length);
  });

  it('matches the SorraAgents source of truth when that checkout is present', () => {
    const candidates = [
      path.resolve(__dirname, '../../../SorraAgents/scripts/check_git_identity.py'),
      path.resolve(process.cwd(), '../SorraAgents/scripts/check_git_identity.py'),
    ];
    const source = candidates.find((p) => fs.existsSync(p));
    if (!source) {
      // Cross-repo checkout absent (e.g. isolated CI): the literal pin above
      // already has us covered. Record the skip explicitly rather than faking
      // a pass.
      expect(source).toBeUndefined();
      return;
    }
    const text = fs.readFileSync(source, 'utf8');
    const match = text.match(/INCIDENT_ERA_EMAILS\s*=\s*frozenset\(\s*\{([^}]*)\}\s*\)/);
    expect(match, `INCIDENT_ERA_EMAILS not found in ${source}`).not.toBeNull();
    const pySet = [...match![1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]).sort();
    expect(pySet).toEqual([...INCIDENT_ERA_EMAILS].sort());
  });

  it('isIncidentEraEmail is exact-email (trimmed/lowercased), never substring', () => {
    for (const sentinel of EXPECTED_SENTINELS) {
      expect(isIncidentEraEmail(sentinel)).toBe(true);
      expect(isIncidentEraEmail(`  ${sentinel.toUpperCase()}  `)).toBe(true);
    }
    // No wildcard / substring match: a non-exact email that *contains* a
    // sentinel token passes.
    expect(isIncidentEraEmail('t@t.com.example.org')).toBe(false);
    expect(isIncidentEraEmail('not-t@t')).toBe(false);
    expect(isIncidentEraEmail('')).toBe(false);
  });
});

describe('checkPushAuthorIdentity — empty email (unconditional refusal)', () => {
  it('refuses an empty string under every flag/allow-list combination', () => {
    for (const allowSentinelAuthor of [false, true]) {
      for (const allowedAuthors of [[], [ALLOW_LISTED], null] as const) {
        const r = checkPushAuthorIdentity({ effectiveEmail: '', allowSentinelAuthor, allowedAuthors });
        expect(r.allowed, `empty email, allowSentinel=${allowSentinelAuthor}`).toBe(false);
        expect(r.reason).toBe('empty-email');
        expect(r.identity).toBe('');
        expect(r.bypassed).toBe(false);
        expect(r.message).toContain('git config user.email');
      }
    }
  });

  it('treats whitespace-only as empty', () => {
    const r = checkPushAuthorIdentity({ effectiveEmail: '   ' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('empty-email');
  });

  it('treats an undefined effective email as empty', () => {
    const r = checkPushAuthorIdentity({});
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('empty-email');
  });
});

describe('checkPushAuthorIdentity — exact incident-era sentinels', () => {
  it('refuses every exact sentinel by default (case/whitespace insensitive)', () => {
    for (const sentinel of EXPECTED_SENTINELS) {
      for (const variant of [sentinel, sentinel.toUpperCase(), `  ${sentinel}  `]) {
        const r = checkPushAuthorIdentity({ effectiveEmail: variant });
        expect(r.allowed, `sentinel variant '${variant}'`).toBe(false);
        expect(r.reason).toBe('sentinel-identity');
        expect(r.message).toContain('git config user.email');
        expect(r.message).toContain('--allow-sentinel-author');
      }
    }
  });

  it('a sentinel is refused even when it equals the configured identity or an allow-list entry', () => {
    // Absolute refusal (plan Q1): a state policy forbids, but if it existed the
    // sentinel must still be refused rather than silently allow-listed.
    for (const sentinel of EXPECTED_SENTINELS) {
      const asConfigured = checkPushAuthorIdentity({
        effectiveEmail: sentinel,
        configuredEmail: sentinel,
      });
      expect(asConfigured.allowed).toBe(false);
      expect(asConfigured.reason).toBe('sentinel-identity');

      const asAllowListed = checkPushAuthorIdentity({
        effectiveEmail: sentinel,
        allowedAuthors: [sentinel],
      });
      expect(asAllowListed.allowed).toBe(false);
      expect(asAllowListed.reason).toBe('sentinel-identity');
    }
  });

  it('allows a sentinel only with allowSentinelAuthor, flagging the bypass', () => {
    for (const sentinel of EXPECTED_SENTINELS) {
      const r = checkPushAuthorIdentity({ effectiveEmail: sentinel, allowSentinelAuthor: true });
      expect(r.allowed, `sentinel '${sentinel}' with flag`).toBe(true);
      expect(r.bypassed).toBe(true);
      expect(r.identity).toBe(sentinel.toLowerCase());
      expect(r.message).toBe('');
    }
  });
});

describe('checkPushAuthorIdentity — non-sentinel identities always pass', () => {
  it('passes configured / allow-listed / arbitrary non-sentinel identities', () => {
    for (const email of [NON_SENTINEL, ALLOW_LISTED, FOREIGN]) {
      for (const allowedAuthors of [[], [ALLOW_LISTED], null] as const) {
        for (const allowSentinelAuthor of [false, true]) {
          const r = checkPushAuthorIdentity({ effectiveEmail: email, allowedAuthors, allowSentinelAuthor });
          expect(r.allowed, `'${email}' allow=${JSON.stringify(allowedAuthors)}`).toBe(true);
          expect(r.reason).toBe('');
          expect(r.bypassed).toBe(false);
          expect(r.message).toBe('');
        }
      }
    }
  });
});

describe('checkPushAuthorIdentity — determinism (dry-run parity, child AC3)', () => {
  it('returns an identical decision on repeated calls for the same input', () => {
    const inputs: PushAuthorityOptions[] = [
      { effectiveEmail: '' },
      { effectiveEmail: 't@t.com' },
      { effectiveEmail: 't@t.com', allowSentinelAuthor: true },
      { effectiveEmail: NON_SENTINEL },
    ];
    for (const input of inputs) {
      const a = checkPushAuthorIdentity(input);
      const b = checkPushAuthorIdentity(input);
      expect(b).toEqual(a);
    }
  });

  it('the empty-email refusal is never bypassed by allowSentinelAuthor', () => {
    const r = decide({ effectiveEmail: '', allowSentinelAuthor: true });
    expect(r.allowed).toBe(false);
    expect(r.bypassed).toBe(false);
  });
});
