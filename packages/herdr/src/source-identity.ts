/**
 * packages/herdr/src/source-identity.ts — running-code freshness for the
 * downtime dispatcher (WL-0MWWMPDVM009LTQR).
 *
 * The Herdr plugin runs from the live checkout (`npx tsx src/start.ts`), so a
 * long-lived worklist pane keeps executing the module graph it loaded at
 * process start. Checkout advances (commits, `git pull`, a rebased `dev`) are
 * therefore invisible to the running dispatcher until the pane is restarted —
 * the 2026-11-25 dependency-blocked dispatch incident could not tell "the fix
 * is wrong" from "the fix is not loaded".
 *
 * This module answers the question the incident could not: **which source
 * commit is this process actually running, and when did it start?** It records
 *
 *  - the checkout's `HEAD` commit hash and committer timestamp observed at
 *    dispatcher start, and
 *  - the process start time (`process.uptime()`-derived), so a long-lived
 *    process is distinguishable from one started after the checkout moved.
 *
 * Every coordination-log entry written while the identity is configured
 * carries `sourceCommit` / `sourceStartedAt` / `sourceStale` (see
 * `dispatchSourceFields`), so a dispatch record can be tied to the commit that
 * produced it without `ps` archaeology. The dispatcher-start record and the
 * one-off staleness warning are emitted by `dispatcher-start-log.ts`.
 *
 * Fail-open by construction: an unavailable/foreign git checkout, a malformed
 * `git log` payload or a clock skew yields `null` (no identity) and never an
 * exception, so freshness observability can never break a dispatch.
 */

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Module directory (`…/packages/herdr/src` or `…/packages/herdr/dist`). */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Default checkout searched for the running source: the plugin repository
 * root. The plugin package lives at `<repo>/packages/herdr`, so three parents
 * from this module's directory is the repository root under both `src/` (tsx)
 * and `dist/` (compiled).
 */
export const DEFAULT_PLUGIN_REPO_ROOT = resolve(MODULE_DIR, '..', '..', '..');

/** Upper bound for the one-off `git log` read; a hung git must not block startup. */
export const SOURCE_IDENTITY_GIT_TIMEOUT_MS = 3_000;

/** Shape of the source identity recorded for one dispatcher process. */
export interface RuntimeSourceIdentity {
  /** Full 40-character commit hash of the checkout `HEAD` seen at start. */
  commit: string;
  /** Abbreviated commit hash for human-readable warnings. */
  shortCommit: string;
  /** ISO-8601 committer timestamp of that `HEAD` commit. */
  committedAt: string;
  /** ISO-8601 process start time. */
  startedAt: string;
  /**
   * True when this process began BEFORE the recorded `HEAD` commit was
   * committed — i.e. the running module graph predates the checkout and a
   * pane restart is needed to load the current code.
   */
  stale: boolean;
}

/** Injectable seams for {@link resolveSourceIdentity} (tests and callers). */
export interface SourceIdentityDeps {
  /** Checkout searched for `HEAD`; defaults to the plugin repo root. */
  repoRoot?: string;
  /** Process start time in epoch milliseconds; defaults to {@link processStartMs}. */
  processStartMs?: number;
  /** "Now" in epoch milliseconds; defaults to `Date.now()`. */
  nowMs?: number;
  /** Runs `git` with the given arguments and returns stdout; defaults to `execFileSync`. */
  runGit?: (args: readonly string[]) => string;
}

/** The identity fields attached to coordination-log entries. */
export interface SourceIdentityFields {
  /** Full commit hash of the running source (absent when unresolved). */
  sourceCommit?: string;
  /** ISO-8601 process start time (absent when unresolved). */
  sourceStartedAt?: string;
  /** Whether the running source predates the recorded `HEAD` (absent when unresolved). */
  sourceStale?: boolean;
}

/**
 * The process start time in epoch milliseconds, derived from
 * `process.uptime()` so it reflects the real process lifetime rather than the
 * moment this module happened to be imported.
 */
export function processStartMs(
  nowMs: number = Date.now(),
  uptimeSeconds: number = process.uptime(),
): number {
  const start = nowMs - Math.round(uptimeSeconds * 1000);
  // A start in the future means clock skew (or a synthetic test input); never
  // report a nonsensical future process start.
  return Math.min(start, nowMs);
}

/**
 * Parse `git log -1 --format=%H%n%cI` output into its commit hash and ISO
 * committer timestamp. Returns `null` when either line is missing or
 * malformed — a partial identity is never trusted.
 */
export function parseGitHead(output: string): { commit: string; committedAt: string } | null {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 2) return null;
  const commit = lines[0];
  const committedAt = lines[1];
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) return null;
  if (Number.isNaN(Date.parse(committedAt))) return null;
  return { commit, committedAt };
}

/** Default git runner: bounded, non-interactive, stdout only. */
function defaultRunGit(args: readonly string[]): string {
  return execFileSync('git', args as string[], {
    encoding: 'utf8',
    timeout: SOURCE_IDENTITY_GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * Resolve the running source identity from the checkout's `HEAD` plus the
 * process start time.
 *
 * `stale` is true when the `HEAD` commit was committed AFTER this process
 * started: the process cannot have loaded that commit, so the checkout has
 * advanced past the running code. Everything is fail-open — any git/parse
 * failure resolves `null`.
 */
export function resolveSourceIdentity(
  deps: SourceIdentityDeps = {},
): RuntimeSourceIdentity | null {
  const repoRoot = deps.repoRoot ?? DEFAULT_PLUGIN_REPO_ROOT;
  const started = deps.processStartMs ?? processStartMs();
  const nowMs = deps.nowMs ?? Date.now();
  const runGit = deps.runGit ?? defaultRunGit;
  let output: string;
  try {
    output = runGit(['-C', repoRoot, 'log', '-1', '--format=%H%n%cI']);
  } catch {
    return null; // no checkout / no git / timeout → no identity (fail-open)
  }
  const head = parseGitHead(output);
  if (head === null) return null;
  const committedMs = Date.parse(head.committedAt);
  // Guard the comparison against a future-dated process start (clock skew):
  // a process cannot have started after "now".
  const startMs = Math.min(started, nowMs);
  return {
    commit: head.commit,
    shortCommit: head.commit.slice(0, 9),
    committedAt: head.committedAt,
    startedAt: new Date(startMs).toISOString(),
    stale: committedMs > startMs,
  };
}

/**
 * The one-line, actionable startup warning for a stale runtime, or `null`
 * when the running source is current. The message names both timestamps and
 * the exact remedy (restart the Worklog pane), so it can be acted on without
 * further investigation.
 */
export function formatStaleSourceWarning(identity: RuntimeSourceIdentity): string | null {
  if (!identity.stale) return null;
  return (
    `[worklog-plugin] Downtime dispatcher is running stale code: this process started `
    + `${identity.startedAt}, before checkout HEAD ${identity.shortCommit} was committed `
    + `(${identity.committedAt}). Restart the Worklog plugin pane to load the current checkout.`
  );
}

/** Project an identity onto the coordination-log entry fields (null → `{}`). */
export function sourceIdentityFields(
  identity: RuntimeSourceIdentity | null,
): SourceIdentityFields {
  if (identity === null) return {};
  return {
    sourceCommit: identity.commit,
    sourceStartedAt: identity.startedAt,
    sourceStale: identity.stale,
  };
}

// ── Ambient dispatcher identity ───────────────────────────────────────
// The identity is process-scoped: one dispatcher runs per plugin pane
// process. An ambient holder (configured ONCE by the production wiring in
// `index.ts`) keeps the dozens of coordination-log write sites free of a
// threaded parameter, and defaults to `null` so tests and any unwired caller
// see the exact pre-feature log shape.

let dispatcherIdentity: RuntimeSourceIdentity | null = null;

/**
 * Configure the identity attached to every coordination-log entry written by
 * this process. Production calls this once at dispatcher start; tests may set
 * it to pin the fields (and must restore it with
 * {@link resetDispatcherSourceIdentityForTests}).
 */
export function configureDispatcherSourceIdentity(identity: RuntimeSourceIdentity | null): void {
  dispatcherIdentity = identity;
}

/** The configured ambient identity (null when freshness logging is off). */
export function getDispatcherSourceIdentity(): RuntimeSourceIdentity | null {
  return dispatcherIdentity;
}

/** The fields to spread into a coordination-log entry for this process. */
export function dispatchSourceFields(): SourceIdentityFields {
  return sourceIdentityFields(dispatcherIdentity);
}

/** Reset the ambient identity to its default (tests). */
export function resetDispatcherSourceIdentityForTests(): void {
  dispatcherIdentity = null;
}
