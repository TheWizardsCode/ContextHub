/**
 * src/sync/author-identity.ts — the sync author-identity gate.
 *
 * Concern: refusing to merge worklog data when the remote ref contains
 * commits authored by an identity other than the store's configured identity
 * (WL-0MSOYWWS4009HTCB) — a second store with an empty/foreign git identity
 * can otherwise silently overwrite work items and invalidate audits. Pure +
 * deterministic: the same input always yields the same result, so dry-run and
 * normal syncs report the same refusal.
 *
 * Extracted verbatim from `src/sync.ts` (WL-0MVP9R3PU004EGYE, child 4 of 6 of
 * the WL-0MVGKGMU400631VZ `src/sync.ts` decomposition). The four public
 * functions are re-exported from the barrel; `normalizeEmail`,
 * `isAllowAllAuthors`, `isEmailWhitelisted` and `buildIdentityRefusalMessage`
 * are module-private helpers and are NOT part of the `./sync.js` public
 * surface.
 */

import { gitExecAsync, execGitCaptureStdout } from './git-exec.js';
import type {
  IncomingCommit,
  SyncAllowedAuthors,
  AuthorIdentityOptions,
  AuthorIdentityViolation,
  AuthorIdentityResult,
  PushAuthorityOptions,
  PushAuthorityResult,
} from './types.js';
import { readLastSyncedRef } from './refs.js';

/** Normalize email for comparison: trimmed, lowercased. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Incident-era sentinel identities that must NEVER author a worklog-data
 * commit — the 2026-09-26 / 2026-10-22 / 2026-10-23 leaked-`GIT_DIR`
 * incidents (host `RossGameDev` pushed `T <t@t.com>`, every other clone then
 * refused to sync).
 *
 * CANONICAL SOURCE OF TRUTH: SorraAgents `scripts/check_git_identity.py`
 * (`INCIDENT_ERA_EMAILS`). There is no cross-language import, so this set MUST
 * stay byte-identical to that `frozenset`; keep both in sync and pin the
 * parity with a unit test. Comparison is exact-email (trimmed, lowercased) —
 * never a wildcard/substring match.
 */
export const INCIDENT_ERA_EMAILS: ReadonlySet<string> = new Set([
  't@t.com',
  't@t',
  'test@test.com',
  'test@test',
  'cache test@test.com',
]);

/** True when `email` is an exact (trimmed, lowercased) incident-era sentinel. */
export function isIncidentEraEmail(email: string): boolean {
  return INCIDENT_ERA_EMAILS.has(normalizeEmail(email));
}

/** Build the operator-facing push-guard refusal message + remedy. */
function buildPushRefusalMessage(
  identity: string,
  reason: 'empty-email' | 'sentinel-identity'
): string {
  if (reason === 'empty-email') {
    return (
      `Refusing to push worklog data: git user.email is not set, so the worklog ` +
      `commit would have no author identity. Configure a real identity and re-run ` +
      `'wl sync':\n` +
      `  git config user.email you@example.com`
    );
  }
  return (
    `Refusing to push worklog data: the effective git user.email '${identity}' is ` +
    `an incident-era sentinel identity and must never author a worklog commit.\n` +
    `Fix your identity and re-run 'wl sync':\n` +
    `  git config user.email you@example.com\n` +
    `Incident remediation only: pass --allow-sentinel-author to override the guard ` +
    `for a single run (sentinel identities can never be added to syncAllowedAuthors).`
  );
}

/**
 * Pure push-side identity decision (WL-0MWGO58KL00187CO) — the outbound
 * mirror of {@link checkAuthorIdentity}. Deterministic: identical input yields
 * an identical verdict on every call (dry-run parity).
 *
 * Guard order (parent AC1/AC2, plan Q1):
 *   1. Empty effective email → refuse unconditionally. `allowSentinelAuthor`
 *      never bypasses this (symmetry with `--allow-foreign-author`).
 *   2. Exact incident-era sentinel → refuse unless `allowSentinelAuthor`.
 *   3. Otherwise pass — non-sentinel configured/allow-listed identities are
 *      never refused (exact-email rule, no wildcards).
 *
 * The sentinel refusal is absolute: it fires even if the sentinel email also
 * equalled the configured identity or an allow-list entry — a state project
 * policy forbids (SorraAgents `tests/test_author_gate_allowlist.py`).
 */
export function checkPushAuthorIdentity(options: PushAuthorityOptions): PushAuthorityResult {
  const normalized = normalizeEmail(options.effectiveEmail ?? '');

  if (normalized === '') {
    return {
      allowed: false,
      reason: 'empty-email',
      identity: '',
      bypassed: false,
      message: buildPushRefusalMessage('', 'empty-email'),
    };
  }

  if (INCIDENT_ERA_EMAILS.has(normalized)) {
    if (options.allowSentinelAuthor) {
      return { allowed: true, reason: '', identity: normalized, bypassed: true, message: '' };
    }
    return {
      allowed: false,
      reason: 'sentinel-identity',
      identity: normalized,
      bypassed: false,
      message: buildPushRefusalMessage(normalized, 'sentinel-identity'),
    };
  }

  // Exact-email rule: any non-sentinel identity (configured, allow-listed or
  // otherwise) passes the push guard — the pull-side gate owns foreign-email
  // decisions; the push guard only stops sentinels and empty identities.
  return { allowed: true, reason: '', identity: normalized, bypassed: false, message: '' };
}

/**
 * Read the effective identity and enforce the push guard: throw with the
 * identity named and the `git config user.email …` remedy when the identity
 * may not author a worklog commit. Returns the decision so a caller can
 * audit-log a deliberate `allowSentinelAuthor` bypass (AC3).
 *
 * `effectiveEmail` defaults to the repo's `git config user.email` — the same
 * identity git will commit with (the temp push worktree shares the repo's
 * config, including local overrides).
 */
export async function enforcePushAuthorIdentity(
  options: PushAuthorityOptions = {}
): Promise<PushAuthorityResult> {
  const effectiveEmail = options.effectiveEmail ?? (await getConfiguredUserEmail());
  const result = checkPushAuthorIdentity({ ...options, effectiveEmail });
  if (!result.allowed) {
    throw new Error(result.message);
  }
  return result;
}

/** Resolve whether whitelist allows all authors. */
function isAllowAllAuthors(allowedAuthors: SyncAllowedAuthors | undefined, allowForeignAuthor: boolean): boolean {
  if (allowForeignAuthor) return true;
  if (allowedAuthors === null || allowedAuthors === true) return true;
  return false;
}

/** Check if email is in whitelist (case-insensitive, trimmed). Always false for empty/allow-all. */
function isEmailWhitelisted(email: string, allowedAuthors: SyncAllowedAuthors | undefined): boolean {
  if (!Array.isArray(allowedAuthors) || allowedAuthors.length === 0) return false;
  const normalized = normalizeEmail(email);
  return allowedAuthors.some((entry) => typeof entry === 'string' && normalizeEmail(entry) === normalized);
}


/**
 * Inspect the author emails of commits on the remote tracking ref since the
 * last-known sync point (parent AC1):
 *
 *   git log <remoteTrackingRef> --format=%h%x09%ae [--not <lastSyncedRef>]
 *
 * The combined `%h%x09%ae` format carries both the short hash and the author
 * email per line (a superset of `--format=%ae`) so the gate can name offending
 * commits in its refusal message. When `lastSyncedRef` is absent/invalid the
 * whole remote ref history is scanned (no `--not` exclusion).
 */
export async function getRemoteAuthorCommits(
  remoteTrackingRef: string,
  lastSyncedRef?: string
): Promise<IncomingCommit[]> {
  const args = ['log', remoteTrackingRef, '--format=%h%x09%ae'];
  if (lastSyncedRef && lastSyncedRef.trim()) {
    args.push('--not', lastSyncedRef.trim());
  }

  let stdout: string;
  try {
    stdout = await execGitCaptureStdout(args);
  } catch {
    // Unreadable/missing ref → no incoming commits to gate.
    return [];
  }

  const commits: IncomingCommit[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [hash, email] = line.split('\t');
    commits.push({ hash: hash || '', authorEmail: email ?? '' });
  }
  return commits;
}

/**
 * Pure gate decision over the incoming commits (parent AC2/AC3 + plan Q2/Q3):
 *
 *   - EMPTY author email → unconditional refusal. `allowForeignAuthor` never
 *     bypasses the empty-email gate (Q3).
 *   - email differs from `expectedAuthorEmail` → refused by default; allowed
 *     when `allowForeignAuthor=true`.
 *   - `expectedAuthorEmail` undefined (user.email unset) → only the
 *     empty-email gate applies; the foreign-email comparison is skipped (Q2).
 *
 * The refusal message names the offending commit(s) and the remote ref.
 */
export function checkAuthorIdentity(
  commits: IncomingCommit[],
  options: AuthorIdentityOptions
): AuthorIdentityResult {
  const { remoteTrackingRef, expectedAuthorEmail, allowForeignAuthor = false, allowedAuthors } = options;
  const violations: AuthorIdentityViolation[] = [];
  const allowAll = isAllowAllAuthors(allowedAuthors, allowForeignAuthor);

  for (const commit of commits) {
    const email = (commit.authorEmail || '').trim();
    if (email === '') {
      violations.push({ commit: commit.hash, authorEmail: '', reason: 'empty-email' });
    } else if (allowAll) {
      // allow-all (whitelist null/true or CLI flag) — skip foreign check, empty already handled
      continue;
    } else if (expectedAuthorEmail !== undefined) {
      const matchesExpected = normalizeEmail(email) === normalizeEmail(expectedAuthorEmail);
      const whitelisted = isEmailWhitelisted(email, allowedAuthors);
      if (!matchesExpected && !whitelisted) {
        violations.push({ commit: commit.hash, authorEmail: email, reason: 'foreign-email' });
      }
    }
    // expectedAuthorEmail undefined -> only empty gate applies (already handled)
  }

  const allowed = violations.length === 0;
  const message = allowed ? '' : buildIdentityRefusalMessage(remoteTrackingRef, violations, expectedAuthorEmail);
  return { allowed, violations, message };
}

function buildIdentityRefusalMessage(
  remoteTrackingRef: string,
  violations: AuthorIdentityViolation[],
  expectedAuthorEmail: string | undefined
): string {
  const detailLines = violations.map(v =>
    v.reason === 'empty-email'
      ? `- ${v.commit}: empty author email`
      : `- ${v.commit}: author email '${v.authorEmail}' does not match configured user.email '${expectedAuthorEmail}'`
  );
  return (
    `Refusing to merge worklog data from ${remoteTrackingRef}: ` +
    `${violations.length} incoming commit(s) fail the author-identity gate.\n` +
    detailLines.join('\n')
  );
}

/**
 * Read the repo's configured `user.email` (the store identity the gate
 * compares incoming commit authors against). Returns undefined when the key
 * is unset or git is unavailable — the caller then skips the foreign-email
 * comparison entirely (plan Q2) while still enforcing the empty-email gate.
 */
export async function getConfiguredUserEmail(): Promise<string | undefined> {
  try {
    const { stdout } = await gitExecAsync('git config user.email');
    const email = stdout.trim();
    return email || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Wire the author-identity gate into a sync flow (parent AC4): inspect the
 * incoming commits on the remote tracking ref since the last sync point and
 * throw a refusal error naming the offending commit(s) + remote ref when the
 * gate fails. Runs after the remote fetch, before any merge/import
 * side-effects. Dry-run and normal modes report the refusal identically.
 */
export async function enforceAuthorIdentityGate(
  remoteTrackingRef: string,
  dataFilePath: string,
  options: { expectedAuthorEmail?: string; allowForeignAuthor?: boolean; allowedAuthors?: SyncAllowedAuthors }
): Promise<void> {
  const lastSyncedRef = readLastSyncedRef(dataFilePath);
  const commits = await getRemoteAuthorCommits(remoteTrackingRef, lastSyncedRef);
  const result = checkAuthorIdentity(commits, {
    remoteTrackingRef,
    expectedAuthorEmail: options.expectedAuthorEmail,
    allowForeignAuthor: options.allowForeignAuthor,
    allowedAuthors: options.allowedAuthors,
  });
  if (!result.allowed) {
    throw new Error(result.message);
  }
}
