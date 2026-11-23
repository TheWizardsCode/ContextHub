/**
 * Wiring contract for the run-once shared-build preflight
 * (WL-0MWHD4GU3003ZE7Q, parent WL-0MW8G1X3V007CGAE).
 *
 * The freshness *verdicts* are pinned by `tests/unit/shared-dist-freshness.test.ts`;
 * this suite pins the other half of the contract: that the verdict is applied
 * from a vitest `globalSetup` (once per invocation, before any test file), that
 * the abort message is actionable, and that the setup never depends on (or
 * mutates) the running checkout's build state.
 *
 * The guard is mocked by module path so every spec runs deterministically on a
 * stale, fresh or missing build alike — no spec reads the real
 * `packages/shared` (the same rule the fixture suite follows).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  guard: vi.fn<() => string | null>(() => null),
}));

vi.mock('../shared-dist-guard', () => ({
  sharedDistFreshnessDiagnostic: mocks.guard,
}));

const {
  PREFLIGHT_HEADER,
  runSharedDistPreflight,
  setup,
} = await import('../global-setup');

/** A realistic stale-build diagnostic, in the guard's own wording. */
const STALE_DIAGNOSTIC = [
  'The @worklog/shared build is older than its sources — the test run',
  'would load stale shared code, so a red suite would not mean broken code.',
  '  Resolved package: /repo/packages/shared',
  '  Build artefact:   /repo/packages/shared/dist/worklog-paths.js',
  '  Artefact mtime:   2026-11-12T23:24:00.000Z',
  '  Newest source:    /repo/packages/shared/src/database.ts',
  '  Source mtime:     2026-11-14T00:23:00.000Z',
  '  Rebuild the shared workspace build, then re-run:',
  '    cd /repo && npm run build:shared',
].join('\n');

beforeEach(() => {
  mocks.guard.mockReset();
  mocks.guard.mockReturnValue(null);
});

describe('runSharedDistPreflight — verdict application', () => {
  it('returns silently when the guard reports a fresh build', () => {
    const guard = vi.fn(() => null);

    expect(() => runSharedDistPreflight(guard)).not.toThrow();
    expect(guard).toHaveBeenCalledTimes(1);
  });

  it('throws one error carrying the guard diagnostic verbatim', () => {
    const guard = vi.fn(() => STALE_DIAGNOSTIC);

    let message = '';
    try {
      runSharedDistPreflight(guard);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain(PREFLIGHT_HEADER);
    expect(message).toContain(STALE_DIAGNOSTIC);
    // The remedy must survive into what the operator actually reads.
    expect(message).toContain('npm run build:shared');
    // And must state the no-rebuild contract rather than implying one happened.
    expect(message).toContain('never rebuilds');
  });

  it('consults the guard exactly once per invocation', () => {
    const guard = vi.fn(() => null);
    runSharedDistPreflight(guard);
    expect(guard).toHaveBeenCalledTimes(1);

    // A second invocation (a re-run, not a second test file) calls it again —
    // the preflight is per-run, never cached across runs.
    runSharedDistPreflight(guard);
    expect(guard).toHaveBeenCalledTimes(2);
  });
});

describe('globalSetup entry point', () => {
  it('applies the real guard verdict — silent on a fresh build', async () => {
    mocks.guard.mockReturnValue(null);

    await expect(setup()).resolves.toBeUndefined();
    expect(mocks.guard).toHaveBeenCalledTimes(1);
  });

  it('applies the real guard verdict — aborts the run on a stale build', async () => {
    mocks.guard.mockReturnValue(STALE_DIAGNOSTIC);

    await expect(setup()).rejects.toThrow(/npm run build:shared/);
    expect(mocks.guard).toHaveBeenCalledTimes(1);
  });
});

describe('vitest.config.ts wiring', () => {
  it('registers the preflight as globalSetup, separate from setupFiles', async () => {
    const config = (await import('../../vitest.config')).default;
    const test = config.test ?? {};

    expect(test.globalSetup).toEqual(['./tests/global-setup.ts']);
    // setupFiles stays per-file work only — the walk must not move there.
    expect(test.setupFiles).toEqual(['./tests/setup-tests.ts']);
  });
});
