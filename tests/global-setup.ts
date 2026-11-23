/**
 * Vitest `globalSetup` — the run-once half of the shared-build freshness guard
 * (WL-0MWHD4GU3003ZE7Q, parent WL-0MW8G1X3V007CGAE; verdict logic lives in
 * `tests/shared-dist-guard.ts`, contract pinned by
 * `tests/unit/shared-dist-freshness.test.ts`).
 *
 * ## Why `globalSetup` and not `setupFiles`
 *
 * `setupFiles` runs **per test file** (344 of them), so a freshness check there
 * would add a `packages/shared/src` walk to every worker. `globalSetup` runs
 * **once per vitest invocation**, in the main process, before any test file is
 * collected — so a stale or missing `@worklog/shared` build aborts the whole
 * run with one diagnostic instead of failing 344 imports one by one.
 *
 * ## Never rebuild, never write
 *
 * The suite declares itself mutation-free (`_detect_live_repo_mutation` in the
 * pre-push path), so this setup only *judges*: it throws with the rebuild
 * command and leaves the checkout untouched. An implicit `npm run build:shared`
 * here would also make a green suite pass against a build the operator never
 * asked for.
 *
 * ## Fail-open
 *
 * Every "cannot judge" outcome in the guard (unresolvable package with no
 * discoverable repository root, a package outside a `packages/` workspace, an
 * unreadable directory) returns `null` and this setup proceeds silently — a
 * guard that fails a healthy checkout is worse than no guard.
 */

import { sharedDistFreshnessDiagnostic } from './shared-dist-guard';

/**
 * Guard signature — the pure verdict function is injected so tests can pin the
 * wiring without depending on the running checkout's build state.
 */
export type SharedDistGuard = () => string | null;

/** First line of the abort message: names the precondition, not a test. */
export const PREFLIGHT_HEADER =
  'Refusing to run the suite: the @worklog/shared build this run resolves is stale or missing.';

/**
 * Apply the guard's verdict, throwing the actionable diagnostic when the run
 * must not proceed.
 *
 * @param guard Injectable verdict function (defaults to the real guard).
 * @throws Error containing the guard's diagnostic verbatim when the resolved
 *   build is older than the newest shared source file, or absent entirely.
 */
export function runSharedDistPreflight(
  guard: SharedDistGuard = sharedDistFreshnessDiagnostic
): void {
  // One call per invocation: the walk must not repeat per test file.
  const diagnostic = guard();
  if (diagnostic === null) return;
  throw new Error(
    [
      PREFLIGHT_HEADER,
      '',
      diagnostic,
      '',
      'This preflight never rebuilds (the suite must not mutate the checkout);',
      'run the rebuild command above, then re-run the suite.',
    ].join('\n')
  );
}

/** Vitest `globalSetup` entry point — runs once, before any test file. */
export async function setup(): Promise<void> {
  runSharedDistPreflight();
}
