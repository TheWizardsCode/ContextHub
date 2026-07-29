/**
 * Unit tests for stripCommandPrefix and findWorklogRoot in index.ts
 *
 * Run: npx vitest run packages/herdr/src/index.test.ts
 */

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { stripCommandPrefix } from './index.js';

// ---------------------------------------------------------------------------
// stripCommandPrefix tests
// ---------------------------------------------------------------------------

describe('stripCommandPrefix', () => {
  describe('double-bang prefix (!!)', () => {
    it('strips !! from commands starting with !!', () => {
      expect(stripCommandPrefix('!!wl update <id> --priority high')).toBe(
        'wl update <id> --priority high',
      );
    });

    it('strips !! from multi-command sequences', () => {
      expect(
        stripCommandPrefix(
          '!!wl reviewed <id> false && wl audit-set <id> --ready-to-close yes',
        ),
      ).toBe(
        'wl reviewed <id> false && wl audit-set <id> --ready-to-close yes',
      );
    });

    it('strips !! from search command', () => {
      expect(stripCommandPrefix('!!wl search ')).toBe('wl search ');
    });
  });

  describe('single-bang prefix (!)', () => {
    it('strips ! from commands starting with single !', () => {
      expect(stripCommandPrefix('!some shell command')).toBe('some shell command');
    });

    it('leaves !! commands unaffected by the single-bang rule', () => {
      expect(stripCommandPrefix('!!double-bang')).toBe('double-bang');
    });
  });

  describe('no prefix', () => {
    it('leaves agent commands unchanged (/skill:*)', () => {
      expect(stripCommandPrefix('/skill:implement <id>')).toBe(
        '/skill:implement <id>',
      );
    });

    it('leaves agent commands unchanged (/intake)', () => {
      expect(stripCommandPrefix('/intake')).toBe('/intake');
    });

    it('leaves agent commands unchanged (/plan)', () => {
      expect(stripCommandPrefix('/plan <id>')).toBe('/plan <id>');
    });

    it('leaves /wl filter commands unchanged', () => {
      expect(stripCommandPrefix('/wl idea')).toBe('/wl idea');
      expect(stripCommandPrefix('/wl review')).toBe('/wl review');
    });

    it('leaves plain commands without bang unchanged', () => {
      expect(stripCommandPrefix('echo hello')).toBe('echo hello');
    });

    it('leaves empty string unchanged', () => {
      expect(stripCommandPrefix('')).toBe('');
    });
  });

  describe('edge cases', () => {
    it('strips !! from !!wl close <id>', () => {
      expect(stripCommandPrefix('!!wl close <id>')).toBe('wl close <id>');
    });

    it('strips !! from !!wl delete <id>', () => {
      expect(stripCommandPrefix('!!wl delete <id>').trim()).toBe('wl delete <id>');
    });

    it('strips !! from !!wl update <id> --status <status> --stage <stage>', () => {
      expect(stripCommandPrefix('!!wl update <id> --status <status> --stage <stage> ')).toBe(
        'wl update <id> --status <status> --stage <stage> ',
      );
      expect(stripCommandPrefix('!!wl update <id> --status <status> --stage <stage>')).toBe(
        'wl update <id> --status <status> --stage <stage>',
      );
    });

    it('strips !! from !!wl update <id> --title ', () => {
      expect(stripCommandPrefix('!!wl update <id> --title ')).toBe(
        'wl update <id> --title ',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// findWorklogRoot integration tests
// Use real temp directories to avoid vi.mock hoisting issues with node:fs.
// Each test imports the module via dynamic import to get a fresh reference.
// ---------------------------------------------------------------------------

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('findWorklogRoot', () => {
  let originalCwd: () => string;
  const tempDirs: string[] = [];

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

  /**
   * Create a temp directory for testing. Automatically cleaned up.
   */
  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'wlroot-test-'));
    tempDirs.push(dir);
    return dir;
  }

  describe('CWD has a valid .worklog/', () => {
    it('returns CWD when .worklog/ contains worklog.db', async () => {
      const { findWorklogRoot } = await import('./index.js');
      const root = makeTempDir();
      mkdirSync(join(root, '.worklog'));
      writeFileSync(join(root, '.worklog', 'worklog.db'), '');
      vi.spyOn(process, 'cwd').mockReturnValue(root);

      expect(findWorklogRoot()).toBe(root);
    });

    it('returns CWD when .worklog/ contains initialized marker', async () => {
      const { findWorklogRoot } = await import('./index.js');
      const root = makeTempDir();
      mkdirSync(join(root, '.worklog'));
      writeFileSync(join(root, '.worklog', 'initialized'), '');
      vi.spyOn(process, 'cwd').mockReturnValue(root);

      expect(findWorklogRoot()).toBe(root);
    });
  });

  describe('CWD has no valid .worklog/ and not in worktree', () => {
    it('returns undefined when CWD has no .worklog/ at all', async () => {
      const { findWorklogRoot } = await import('./index.js');
      const root = makeTempDir();
      vi.spyOn(process, 'cwd').mockReturnValue(root);

      expect(findWorklogRoot()).toBeUndefined();
    });

    it('returns undefined when .worklog/ exists but is invalid (no markers)', async () => {
      const { findWorklogRoot } = await import('./index.js');
      const root = makeTempDir();
      mkdirSync(join(root, '.worklog')); // Empty - no worklog.db or initialized
      vi.spyOn(process, 'cwd').mockReturnValue(root);

      expect(findWorklogRoot()).toBeUndefined();
    });

    it('does NOT walk up to parent directories when CWD has no .worklog/', async () => {
      const { findWorklogRoot } = await import('./index.js');
      const base = makeTempDir();
      // Create ContextHub-like .worklog/ at a parent level (sibling)
      const contextHubRoot = join(base, 'context-hub');
      mkdirSync(join(contextHubRoot, '.worklog'), { recursive: true });
      writeFileSync(join(contextHubRoot, '.worklog', 'worklog.db'), '');

      // CWD is a separate directory at the same level, no .worklog/
      const cwd = join(base, 'unrelated-dir');
      mkdirSync(cwd, { recursive: true });
      vi.spyOn(process, 'cwd').mockReturnValue(cwd);

      // Should NOT find ContextHub's .worklog/ by walking up
      expect(findWorklogRoot()).toBeUndefined();
    });

    it('walks up to parent when it has valid .worklog/', async () => {
      const { findWorklogRoot } = await import('./index.js');
      const base = makeTempDir();
      // Create a parent dir with valid .worklog/
      mkdirSync(join(base, '.worklog'), { recursive: true });
      writeFileSync(join(base, '.worklog', 'worklog.db'), '');

      // CWD is a subdirectory with no .worklog/
      const cwd = join(base, 'subdir');
      mkdirSync(cwd, { recursive: true });
      vi.spyOn(process, 'cwd').mockReturnValue(cwd);

      // Should find the parent's .worklog/ by walking up
      expect(findWorklogRoot()).toBe(base);
    });
  });

  describe('Inside a worktree (.worklog/worktrees/ in path)', () => {
    it('walks up from worktree directory to find project root .worklog/', async () => {
      const { findWorklogRoot } = await import('./index.js');
      const base = makeTempDir();
      const projectRoot = join(base, 'context-hub');

      // Create a valid .worklog/ at the project root
      mkdirSync(join(projectRoot, '.worklog'), { recursive: true });
      writeFileSync(join(projectRoot, '.worklog', 'worklog.db'), '');

      // Create a worktree deep inside the project
      const worktreeDir = join(projectRoot, '.worklog', 'worktrees', 'wl-XYZ-feature', 'src');
      mkdirSync(worktreeDir, { recursive: true });

      vi.spyOn(process, 'cwd').mockReturnValue(worktreeDir);

      expect(findWorklogRoot()).toBe(projectRoot);
    });

    it('skips past invalid .worklog/ inside worktree to find project root', async () => {
      const { findWorklogRoot } = await import('./index.js');
      const base = makeTempDir();
      const projectRoot = join(base, 'context-hub');

      // Create a valid .worklog/ at the project root
      mkdirSync(join(projectRoot, '.worklog'), { recursive: true });
      writeFileSync(join(projectRoot, '.worklog', 'worklog.db'), '');

      // Create a worktree with an invalid .worklog/ (empty dir)
      const worktreeDir = join(projectRoot, '.worklog', 'worktrees', 'wl-XYZ-feature');
      mkdirSync(worktreeDir, { recursive: true });
      mkdirSync(join(worktreeDir, '.worklog')); // No worklog.db, no initialized

      vi.spyOn(process, 'cwd').mockReturnValue(worktreeDir);

      expect(findWorklogRoot()).toBe(projectRoot);
    });

    it('returns undefined when no project root .worklog/ found above worktree', async () => {
      const { findWorklogRoot } = await import('./index.js');
      const base = makeTempDir();

      // Create a worktree but NO valid .worklog/ at the project root
      const worktreeDir = join(base, 'project', '.worklog', 'worktrees', 'wl-XYZ-feature');
      mkdirSync(worktreeDir, { recursive: true });

      vi.spyOn(process, 'cwd').mockReturnValue(worktreeDir);

      expect(findWorklogRoot()).toBeUndefined();
    });

    it('walks up from deeply nested worktree path', async () => {
      const { findWorklogRoot } = await import('./index.js');
      const base = makeTempDir();
      const projectRoot = join(base, 'context-hub');

      // Create a valid .worklog/ at the project root
      mkdirSync(join(projectRoot, '.worklog'), { recursive: true });
      writeFileSync(join(projectRoot, '.worklog', 'worklog.db'), '');

      // Deeply nested worktree path
      const worktreeDir = join(
        projectRoot, '.worklog', 'worktrees', 'wl-XYZ-feature',
        'packages', 'herdr', 'src',
      );
      mkdirSync(worktreeDir, { recursive: true });

      vi.spyOn(process, 'cwd').mockReturnValue(worktreeDir);

      expect(findWorklogRoot()).toBe(projectRoot);
    });
  });

  describe('Edge cases', () => {
    it('stops at filesystem root without infinite loop', async () => {
      const { findWorklogRoot } = await import('./index.js');
      vi.spyOn(process, 'cwd').mockReturnValue('/');
      expect(findWorklogRoot()).toBeUndefined();
    });

    it('prefers CWD .worklog/ over worktree walking', async () => {
      const { findWorklogRoot } = await import('./index.js');
      const base = makeTempDir();
      const projectRoot = join(base, 'context-hub');

      // Create valid .worklog/ at project root
      mkdirSync(join(projectRoot, '.worklog'), { recursive: true });
      writeFileSync(join(projectRoot, '.worklog', 'worklog.db'), '');

      // Create worktree with its OWN valid .worklog/
      const worktreeDir = join(projectRoot, '.worklog', 'worktrees', 'wl-XYZ-feature');
      mkdirSync(join(worktreeDir, '.worklog'), { recursive: true });
      writeFileSync(join(worktreeDir, '.worklog', 'worklog.db'), '');

      vi.spyOn(process, 'cwd').mockReturnValue(worktreeDir);

      expect(findWorklogRoot()).toBe(worktreeDir);
    });
  });
});
