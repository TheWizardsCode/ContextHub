/**
 * Tests for resolveWorklogDir() delegation to the shared resolveWorklogRoot
 * (packages/shared/src/worklog-paths.ts) — the unification contract of
 * WL-0MS7TQVK2001X4EG (child WL-0MSAWAR1U008VRY3 AC5).
 *
 * These tests mock @worklog/shared/worklog-paths so the CLI wrapper's
 * delegation logic is verified in isolation:
 *
 *   - --worklog-dir override wins before delegation
 *   - shared root → join(root, '.worklog')
 *   - shared undefined (incl. the documented invalid-cwd-stop boundary) →
 *     <cwd>/.worklog fallback
 *
 * Run: npx vitest run tests/unit/worklog-dir-delegation.test.ts
 *
 * NOTE (WL-0MT1KLQYD004MOQT): the module under test is imported STATICALLY
 * at the top of the file (after the vi.mock), never via `await import()`
 * inside a test. The previous dynamic-import pattern intermittently bound
 * the REAL @worklog/shared/worklog-paths inside src/worklog-paths.js under
 * vitest's forks+isolate module caching — the top-level import got the mock
 * while the dynamic import path resolved the real module (~1 in 3-4 full
 * tests/unit runs), failing the first three delegation tests. The mock
 * functions are created once via vi.hoisted and reset per-test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  resolveWorklogRoot: vi.fn(),
  getGitRepoRoot: vi.fn(),
}));

vi.mock('@worklog/shared/worklog-paths', () => mocks);

import { resolveWorklogRoot } from '@worklog/shared/worklog-paths';
import { resolveWorklogDir, setWorklogDirOverride } from '../../src/worklog-paths.js';

describe('resolveWorklogDir delegation to shared resolveWorklogRoot', () => {
  const cwd = '/tmp/wl-delegation-cwd';
  let origCwd: () => string;

  beforeEach(() => {
    origCwd = process.cwd;
    process.cwd = () => cwd;
    mocks.resolveWorklogRoot.mockReset();
  });

  afterEach(() => {
    process.cwd = origCwd;
  });

  it('delegates to the shared resolver with no args (defaults to process.cwd)', () => {
    mocks.resolveWorklogRoot.mockReturnValue('/proj');
    expect(resolveWorklogDir()).toBe('/proj/.worklog');
    expect(resolveWorklogRoot).toHaveBeenCalledTimes(1);
    expect(resolveWorklogRoot).toHaveBeenCalledWith();
  });

  it('falls back to <cwd>/.worklog when the shared resolver returns undefined', () => {
    mocks.resolveWorklogRoot.mockReturnValue(undefined);
    expect(resolveWorklogDir()).toBe(join(cwd, '.worklog'));
    expect(resolveWorklogRoot).toHaveBeenCalledTimes(1);
  });

  it('falls back to <cwd>/.worklog when an invalid non-stub .worklog/ stops the walk (documented boundary)', () => {
    // The shared resolver implements the documented invalid-cwd-stop
    // behavior change (WL-0MS7TQVK2001X4EG): an uninitialized .worklog/ in
    // cwd is a boundary → undefined → the CLI surfaces <cwd>/.worklog.
    mocks.resolveWorklogRoot.mockReturnValue(undefined);
    expect(resolveWorklogDir()).toBe(join(cwd, '.worklog'));
    expect(resolveWorklogRoot).toHaveBeenCalledTimes(1);
  });

  it('the --worklog-dir override wins before delegation', () => {
    try {
      setWorklogDirOverride('/override/.worklog');
      mocks.resolveWorklogRoot.mockReturnValue('/proj');
      expect(resolveWorklogDir()).toBe('/override/.worklog');
      expect(resolveWorklogRoot).not.toHaveBeenCalled();
    } finally {
      setWorklogDirOverride(undefined);
    }
  });
});
