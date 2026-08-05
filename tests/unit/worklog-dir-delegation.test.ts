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
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';

vi.mock('@worklog/shared/worklog-paths', () => ({
  resolveWorklogRoot: vi.fn(),
  getGitRepoRoot: vi.fn(),
}));

import { resolveWorklogRoot } from '@worklog/shared/worklog-paths';

describe('resolveWorklogDir delegation to shared resolveWorklogRoot', () => {
  const cwd = '/tmp/wl-delegation-cwd';
  let origCwd: () => string;

  beforeEach(() => {
    origCwd = process.cwd;
    process.cwd = () => cwd;
    vi.mocked(resolveWorklogRoot).mockReset();
  });

  afterEach(() => {
    process.cwd = origCwd;
  });

  it('delegates to the shared resolver with no args (defaults to process.cwd)', async () => {
    const mod = await import('../../src/worklog-paths.js');
    vi.mocked(resolveWorklogRoot).mockReturnValue('/proj');
    expect(mod.resolveWorklogDir()).toBe('/proj/.worklog');
    expect(resolveWorklogRoot).toHaveBeenCalledTimes(1);
    expect(resolveWorklogRoot).toHaveBeenCalledWith();
  });

  it('falls back to <cwd>/.worklog when the shared resolver returns undefined', async () => {
    const mod = await import('../../src/worklog-paths.js');
    vi.mocked(resolveWorklogRoot).mockReturnValue(undefined);
    expect(mod.resolveWorklogDir()).toBe(join(cwd, '.worklog'));
    expect(resolveWorklogRoot).toHaveBeenCalledTimes(1);
  });

  it('falls back to <cwd>/.worklog when an invalid non-stub .worklog/ stops the walk (documented boundary)', async () => {
    // The shared resolver implements the documented invalid-cwd-stop
    // behavior change (WL-0MS7TQVK2001X4EG): an uninitialized .worklog/ in
    // cwd is a boundary → undefined → the CLI surfaces <cwd>/.worklog.
    const mod = await import('../../src/worklog-paths.js');
    vi.mocked(resolveWorklogRoot).mockReturnValue(undefined);
    expect(mod.resolveWorklogDir()).toBe(join(cwd, '.worklog'));
    expect(resolveWorklogRoot).toHaveBeenCalledTimes(1);
  });

  it('the --worklog-dir override wins before delegation', async () => {
    const mod = await import('../../src/worklog-paths.js');
    try {
      mod.setWorklogDirOverride('/override/.worklog');
      vi.mocked(resolveWorklogRoot).mockReturnValue('/proj');
      expect(mod.resolveWorklogDir()).toBe('/override/.worklog');
      expect(resolveWorklogRoot).not.toHaveBeenCalled();
    } finally {
      mod.setWorklogDirOverride(undefined);
    }
  });
});
