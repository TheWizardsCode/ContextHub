/**
 * Tests for the canonical worklog-root resolver shared by the `wl` CLI
 * (`src/worklog-paths.ts`) and the herdr plugin (`packages/herdr`).
 *
 * The scenarios below were migrated from the herdr plugin's findWorklogRoot
 * tests and extended with the `wl` CLI's validation rules (config.yaml) and
 * git repo-root fallback. They pin the documented precedence order:
 *
 *   1. Nearest valid `.worklog/` wins (walk up from startDir).
 *   2. Invalid `.worklog/` dirs are skipped only when they are leftover
 *      worktree containers or the path is inside a managed worktree
 *      (`.worklog/worktrees/…`); otherwise they act as a boundary.
 *   3. Git repo-root fallback: only when the walk found nothing, the
 *      enclosing repo root's VALID `.worklog/` is preferred.
 *   4. `undefined` when no valid root exists.
 *
 * Run: npx vitest run packages/shared/src/worklog-paths.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
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
function makeValidWorklog(root: string, marker: 'worklog.db' | 'initialized' | 'config.yaml' = 'worklog.db'): void {
  mkdirSync(join(root, '.worklog'), { recursive: true });
  writeFileSync(join(root, '.worklog', marker), marker === 'config.yaml' ? 'projectName: test\nprefix: TEST\n' : '');
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
    it('returns startDir when .worklog/ contains worklog.db', () => {
      const root = makeTempDir();
      makeValidWorklog(root, 'worklog.db');
      expect(resolveWorklogRoot(root)).toBe(root);
    });

    it('returns startDir when .worklog/ contains initialized marker', () => {
      const root = makeTempDir();
      makeValidWorklog(root, 'initialized');
      expect(resolveWorklogRoot(root)).toBe(root);
    });

    it('returns startDir when .worklog/ contains config.yaml (wl CLI rule)', () => {
      const root = makeTempDir();
      makeValidWorklog(root, 'config.yaml');
      expect(resolveWorklogRoot(root)).toBe(root);
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
      // (empty .worklog/worktrees/, no config.yaml / initialized / worklog.db)
      const cwd = join(projectRoot, 'packages', 'herdr');
      mkdirSync(join(cwd, '.worklog', 'worktrees'), { recursive: true });

      expect(resolveWorklogRoot(cwd)).toBe(projectRoot);
    });
  });

  describe('Git repo-root fallback', () => {
    it('prefers the repo root VALID .worklog/ when startDir has an invalid non-stub .worklog/', () => {
      // Preserves the wl CLI's resolveWorklogDir behavior: an uninitialized
      // .worklog/ in a subdirectory must not shadow an initialized repo root.
      const base = makeTempDir();
      mkdirSync(join(base, '.git')); // mock-git top-level marker
      makeValidWorklog(base, 'worklog.db');

      const cwd = join(base, 'sub');
      mkdirSync(cwd, { recursive: true });
      mkdirSync(join(cwd, '.worklog')); // invalid, non-stub

      expect(resolveWorklogRoot(cwd)).toBe(base);
    });

    it('returns undefined when the repo root .worklog/ is also invalid', () => {
      const base = makeTempDir();
      mkdirSync(join(base, '.git'));
      mkdirSync(join(base, '.worklog')); // invalid at repo root too

      const cwd = join(base, 'sub');
      mkdirSync(cwd, { recursive: true });
      mkdirSync(join(cwd, '.worklog')); // invalid, non-stub

      expect(resolveWorklogRoot(cwd)).toBeUndefined();
    });

    it('walks up inside a nested repo to the outer repo root .worklog/ when the inner repo has none', () => {
      const base = makeTempDir();
      makeValidWorklog(base); // outer project root has a valid .worklog/

      const inner = join(base, 'inner-repo');
      mkdirSync(join(inner, '.git'), { recursive: true });
      const cwd = join(inner, 'src');
      mkdirSync(cwd, { recursive: true });

      // The walk passes the inner repo root (no .worklog/) and finds the
      // outer root's valid .worklog/ — nearest valid wins.
      expect(resolveWorklogRoot(cwd)).toBe(base);
    });
  });
});
