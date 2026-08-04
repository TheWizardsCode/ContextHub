/**
 * Tests for the canonical worklog-root resolver shared by the `wl` CLI
 * (`src/worklog-paths.ts`) and the herdr plugin (`packages/herdr`).
 *
 * The scenarios below were migrated from the herdr plugin's findWorklogRoot
 * tests and extended with the `wl` CLI's validation rules (config.yaml) and
 * the git repo-root boundary. They pin the documented precedence order
 * (producer-approved, see WL-0MS7TQVK2001X4EG):
 *
 *   1. Nearest valid `.worklog/` wins (walk up from startDir). A
 *      `.worklog/` is valid when it contains `config.yaml` OR `initialized`;
 *      a `worklog.db`-only dir is INVALID.
 *   2. Invalid `.worklog/` dirs are skipped only when they are leftover
 *      worktree containers or the path is inside a managed worktree
 *      (`.worklog/worktrees/…`); otherwise they act as a boundary.
 *   3. The walk never passes the nearest git repo root (`git rev-parse
 *      --show-toplevel`, worktree-aware).
 *   4. `undefined` when no valid root exists.
 *
 * Run: npx vitest run packages/shared/src/worklog-paths.test.ts
 */

import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveWorklogRoot } from './worklog-paths.js';

const tempDirs: string[] = [];

/** Create a temp directory for testing. Automatically cleaned up. */
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wlroot-shared-test-'));
  tempDirs.push(dir);
  return dir;
}

/** Create a valid `.worklog/` in the given project root. */
function makeValidWorklog(root: string, marker: 'config.yaml' | 'initialized' = 'config.yaml'): void {
  mkdirSync(join(root, '.worklog'), { recursive: true });
  writeFileSync(join(root, '.worklog', marker), marker === 'config.yaml' ? 'projectName: test\nprefix: TEST\n' : '');
}

/** Create a git repository marker (`.git` dir) at the given directory. */
function makeGitRepo(dir: string): void {
  mkdirSync(join(dir, '.git'), { recursive: true });
}

describe('resolveWorklogRoot', () => {
  let originalCwd: () => string;

  beforeAll(() => {
    originalCwd = process.cwd;
  });

  afterEach(() => {
    process.cwd = originalCwd;
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    }
    tempDirs.length = 0;
  });

  describe('startDir has a valid .worklog/', () => {
    it('returns startDir when .worklog/ contains config.yaml (wl CLI rule)', () => {
      const root = makeTempDir();
      makeValidWorklog(root, 'config.yaml');
      expect(resolveWorklogRoot(root)).toBe(root);
    });

    it('returns startDir when .worklog/ contains initialized marker', () => {
      const root = makeTempDir();
      makeValidWorklog(root, 'initialized');
      expect(resolveWorklogRoot(root)).toBe(root);
    });

    it('treats a worklog.db-only .worklog/ as INVALID (returns undefined)', () => {
      // Producer-approved rule: valid = config.yaml OR initialized. A
      // directory containing only worklog.db is a partial/legacy state.
      const root = makeTempDir();
      mkdirSync(join(root, '.worklog'), { recursive: true });
      writeFileSync(join(root, '.worklog', 'worklog.db'), '');
      expect(resolveWorklogRoot(root)).toBeUndefined();
    });
  });

  describe('startDir has no valid .worklog/ and not in a worktree', () => {
    it('returns undefined when startDir has no .worklog/ at all', () => {
      const root = makeTempDir();
      expect(resolveWorklogRoot(root)).toBeUndefined();
    });

    it('returns undefined when .worklog/ exists but is invalid (no markers)', () => {
      const root = makeTempDir();
      mkdirSync(join(root, '.worklog')); // Empty - no markers
      expect(resolveWorklogRoot(root)).toBeUndefined();
    });

    it('does NOT walk up to sibling parent directories when startDir has no .worklog/', () => {
      const base = makeTempDir();
      // Create a ContextHub-like .worklog/ at a parent level (sibling)
      const contextHubRoot = join(base, 'context-hub');
      makeValidWorklog(contextHubRoot);

      // startDir is a separate directory at the same level, no .worklog/
      const cwd = join(base, 'unrelated-dir');
      mkdirSync(cwd, { recursive: true });

      // Should NOT find the sibling's .worklog/ by walking up
      expect(resolveWorklogRoot(cwd)).toBeUndefined();
    });

    it('walks up to parent when it has valid .worklog/', () => {
      const base = makeTempDir();
      makeValidWorklog(base);

      // startDir is a subdirectory with no .worklog/
      const cwd = join(base, 'subdir');
      mkdirSync(cwd, { recursive: true });

      expect(resolveWorklogRoot(cwd)).toBe(base);
    });

    it('uses process.cwd() when no startDir is given', () => {
      const root = makeTempDir();
      makeValidWorklog(root);
      vi.spyOn(process, 'cwd').mockReturnValue(root);
      expect(resolveWorklogRoot()).toBe(root);
    });
  });

  describe('Inside a managed worktree (.worklog/worktrees/ in path)', () => {
    it('walks up from worktree directory to find project root .worklog/', () => {
      const base = makeTempDir();
      const projectRoot = join(base, 'context-hub');
      makeValidWorklog(projectRoot);

      const worktreeDir = join(projectRoot, '.worklog', 'worktrees', 'wl-XYZ-feature', 'src');
      mkdirSync(worktreeDir, { recursive: true });

      expect(resolveWorklogRoot(worktreeDir)).toBe(projectRoot);
    });

    it('skips past invalid .worklog/ inside worktree to find project root', () => {
      const base = makeTempDir();
      const projectRoot = join(base, 'context-hub');
      makeValidWorklog(projectRoot);

      // Worktree with an invalid .worklog/ (empty dir)
      const worktreeDir = join(projectRoot, '.worklog', 'worktrees', 'wl-XYZ-feature');
      mkdirSync(worktreeDir, { recursive: true });
      mkdirSync(join(worktreeDir, '.worklog')); // No markers

      expect(resolveWorklogRoot(worktreeDir)).toBe(projectRoot);
    });

    it('returns undefined when no project root .worklog/ found above worktree', () => {
      const base = makeTempDir();
      const worktreeDir = join(base, 'project', '.worklog', 'worktrees', 'wl-XYZ-feature');
      mkdirSync(worktreeDir, { recursive: true });

      expect(resolveWorklogRoot(worktreeDir)).toBeUndefined();
    });

    it('walks up from deeply nested worktree path', () => {
      const base = makeTempDir();
      const projectRoot = join(base, 'context-hub');
      makeValidWorklog(projectRoot);

      const worktreeDir = join(
        projectRoot, '.worklog', 'worktrees', 'wl-XYZ-feature',
        'packages', 'herdr', 'src',
      );
      mkdirSync(worktreeDir, { recursive: true });

      expect(resolveWorklogRoot(worktreeDir)).toBe(projectRoot);
    });

    it('prefers worktree-local .worklog/ over walking up', () => {
      const base = makeTempDir();
      const projectRoot = join(base, 'context-hub');
      makeValidWorklog(projectRoot);

      // Worktree with its OWN valid .worklog/
      const worktreeDir = join(projectRoot, '.worklog', 'worktrees', 'wl-XYZ-feature');
      makeValidWorklog(worktreeDir);

      expect(resolveWorklogRoot(worktreeDir)).toBe(worktreeDir);
    });

    it('lifts the git boundary inside a managed worktree (real git worktree root)', () => {
      // A managed worktree is itself a git repo, so its own git top-level
      // must NOT stop the walk — the main project's .worklog/ is above it.
      const base = makeTempDir();
      const projectRoot = join(base, 'context-hub');
      makeValidWorklog(projectRoot);

      const worktreeDir = join(projectRoot, '.worklog', 'worktrees', 'wl-XYZ-feature');
      mkdirSync(worktreeDir, { recursive: true });
      makeGitRepo(worktreeDir); // the worktree is its own git checkout

      expect(resolveWorklogRoot(worktreeDir)).toBe(projectRoot);
    });
  });

  describe('Edge cases', () => {
    it('stops at filesystem root without infinite loop', () => {
      expect(resolveWorklogRoot('/')).toBeUndefined();
    });

    it('walks past a leftover .worklog/worktrees container stub to find the real project worklog', () => {
      // Regression: a stray `.worklog/worktrees/` container (created by the
      // implement tool's worktree lifecycle, e.g. inside packages/herdr)
      // must not block upward resolution to the real project root.
      const base = makeTempDir();
      const projectRoot = join(base, 'context-hub');
      makeValidWorklog(projectRoot);

      // startDir is a plugin dir that contains a leftover worktree container
      // (empty .worklog/worktrees/, no config.yaml / initialized)
      const cwd = join(projectRoot, 'packages', 'herdr');
      mkdirSync(join(cwd, '.worklog', 'worktrees'), { recursive: true });

      expect(resolveWorklogRoot(cwd)).toBe(projectRoot);
    });
  });

  describe('Git repo-root boundary', () => {
    it('finds the repo root .worklog/ when walking up inside a repo', () => {
      const base = makeTempDir();
      makeGitRepo(base);
      makeValidWorklog(base, 'config.yaml');

      const cwd = join(base, 'sub');
      mkdirSync(cwd, { recursive: true });

      expect(resolveWorklogRoot(cwd)).toBe(base);
    });

    it('stops at the git repo root — nested repo with a valid parent-repo .worklog/ returns undefined', () => {
      // The walk must never pass the nearest git repo root, even when an
      // outer project has a valid .worklog/ above it.
      const base = makeTempDir();
      makeValidWorklog(base); // outer project root has a valid .worklog/

      const inner = join(base, 'inner-repo');
      makeGitRepo(inner); // nested repo, no .worklog/
      const cwd = join(inner, 'src');
      mkdirSync(cwd, { recursive: true });

      expect(resolveWorklogRoot(cwd)).toBeUndefined();
    });

    it('stops at an invalid non-stub .worklog/ even when the repo root has a valid one', () => {
      // Documented behavior change (WL-0MS7TQVK2001X4EG): an uninitialized
      // .worklog/ in a subdirectory is a boundary — it must NOT fall back
      // to the initialized repo root. Callers surface the fallback.
      const base = makeTempDir();
      makeGitRepo(base);
      makeValidWorklog(base, 'config.yaml');

      const cwd = join(base, 'sub');
      mkdirSync(cwd, { recursive: true });
      mkdirSync(join(cwd, '.worklog')); // invalid, non-stub

      expect(resolveWorklogRoot(cwd)).toBeUndefined();
    });

    it('returns undefined when the repo root .worklog/ is also invalid', () => {
      const base = makeTempDir();
      makeGitRepo(base);
      mkdirSync(join(base, '.worklog')); // invalid at repo root too

      const cwd = join(base, 'sub');
      mkdirSync(cwd, { recursive: true });
      mkdirSync(join(cwd, '.worklog')); // invalid, non-stub

      expect(resolveWorklogRoot(cwd)).toBeUndefined();
    });
  });
});
