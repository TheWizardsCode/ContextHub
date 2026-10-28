/**
 * tests/unit/repo-file-walk.test.ts — Unit tests for the race-tolerant
 * repo-wide source-file walker shared by guard tests
 * (`tests/helpers/repo-file-walk.ts`).
 *
 * Regression pin (WL-0MVSLXT79008D4X6): the icons repo-wide grep guard
 * (`tests/unit/icons.test.ts`) walked the whole checkout and crashed with
 * ENOENT when a sibling agent's worktree was removed under
 * `.worklog/worktrees/` mid-walk. The walker must tolerate entries and
 * directories that vanish underneath it, while still surfacing genuine
 * filesystem failures instead of silently passing the guard.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  walkRepoSourceFiles,
  type RepoWalkFs,
  type RepoWalkDirent,
} from '../helpers/repo-file-walk.js';

function dirent(name: string, kind: 'file' | 'dir' | 'symlink'): RepoWalkDirent {
  return {
    name,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
    isSymbolicLink: () => kind === 'symlink',
  };
}

function fsError(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: simulated`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe('walkRepoSourceFiles', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wl-repo-walk-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('visits source files recursively and passes their contents', () => {
    mkdirSync(join(root, 'src', 'nested'), { recursive: true });
    writeFileSync(join(root, 'top.ts'), 'top');
    writeFileSync(join(root, 'src', 'nested', 'deep.mjs'), 'deep');
    writeFileSync(join(root, 'src', 'legacy.cjs'), 'legacy');
    writeFileSync(join(root, 'src', 'plain.js'), 'plain');
    writeFileSync(join(root, 'README.md'), 'ignored, not a source file');
    writeFileSync(join(root, 'src', 'notes.txt'), 'ignored too');

    const visited: Array<[string, string]> = [];
    walkRepoSourceFiles(root, (file, content) => visited.push([file, content]));

    expect(visited.map(([file]) => file.replace(`${root}/`, '')).sort()).toEqual([
      'src/legacy.cjs',
      'src/nested/deep.mjs',
      'src/plain.js',
      'top.ts',
    ]);
    expect(Object.fromEntries(visited.map(([file, content]) => [file.replace(`${root}/`, ''), content]))).toEqual({
      'src/legacy.cjs': 'legacy',
      'src/nested/deep.mjs': 'deep',
      'src/plain.js': 'plain',
      'top.ts': 'top',
    });
  });

  it('skips excluded directories such as node_modules, dist and .worklog', () => {
    for (const dir of ['node_modules', 'dist', '.git', '.worklog', 'coverage']) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, 'vendor.ts'), 'from a removed icons.js');
    }
    writeFileSync(join(root, 'app.ts'), 'clean');

    const visited: string[] = [];
    walkRepoSourceFiles(root, (file) => visited.push(file.replace(`${root}/`, '')));

    expect(visited).toEqual(['app.ts']);
  });

  it('skips symlinks, including dangling ones that would raise ENOENT', () => {
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'built.js'), 'built');
    writeFileSync(join(root, 'real.ts'), 'real');
    symlinkSync(join(root, 'dist', 'built.js'), join(root, 'shim.js'));
    symlinkSync(join(root, 'missing.js'), join(root, 'dangling.js'));

    const visited: string[] = [];
    walkRepoSourceFiles(root, (file) => visited.push(file.replace(`${root}/`, '')));

    expect(visited).toEqual(['real.ts']);
  });

  it('tolerates a directory that is removed after being listed (the concurrent-worktree race)', () => {
    // Simulates `.worklog/worktrees/wl-...` being pruned between readdir and
    // recursion: the entry is still listed but no longer exists.
    const injected: RepoWalkFs = {
      readdirSync: (dir) => {
        if (dir === root) return [dirent('worktree', 'dir'), dirent('keep.ts', 'file')];
        throw fsError('ENOENT');
      },
      readFileSync: () => 'checked',
      lstatSync: () => {
        throw fsError('ENOENT');
      },
    };

    const visited: string[] = [];
    expect(() => walkRepoSourceFiles(root, (file) => visited.push(file), injected)).not.toThrow();
    expect(visited).toEqual([join(root, 'keep.ts')]);
  });

  it('tolerates a file that is removed after being listed', () => {
    const injected: RepoWalkFs = {
      readdirSync: () => [dirent('vanished.ts', 'file')],
      readFileSync: () => {
        throw fsError('ENOENT');
      },
      lstatSync: () => ({ isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true }),
    };

    const visited: string[] = [];
    expect(() => walkRepoSourceFiles(root, (file) => visited.push(file), injected)).not.toThrow();
    expect(visited).toEqual([]);
  });

  it('still surfaces genuine filesystem errors instead of silently passing', () => {
    const injected: RepoWalkFs = {
      readdirSync: () => {
        throw fsError('EIO');
      },
      readFileSync: () => 'checked',
      lstatSync: () => ({ isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true }),
    };

    expect(() => walkRepoSourceFiles(root, () => undefined, injected)).toThrow(/EIO/);
  });
});
