/**
 * packages/herdr/src/herdr-bin.test.ts — CLI resolver regression tests
 * (WL-0MVXRZL9H001GQ7A).
 *
 * The bug: after an in-place `herdr update`, the running server injects its
 * own `/proc/self/exe` into every pane — the stale inode path, suffixed with
 * ` (deleted)`. Every caller spawned that literal string and failed, breaking
 * all herdr-backed plugin actions while the server was stale.
 *
 * These tests pin the resolver contract:
 *   - no HERDR_BIN_PATH            → `herdr`
 *   - a valid executable path      → used as-is
 *   - ` (deleted)` suffix          → stripped and used when the binary exists
 *   - stale/missing/non-executable → falls back to `herdr` on PATH
 *   - nothing resolvable           → the (stripped) attempted path, for
 *                                    actionable diagnostics
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_HERDR_BIN,
  resolveHerdrBin,
  stripDeletedSuffix,
} from './herdr-bin.js';

const isWindows = process.platform === 'win32';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'herdr-bin-resolver-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Create an executable file and return its path. */
function makeExecutable(dir: string, name = DEFAULT_HERDR_BIN): string {
  const path = join(dir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
  return path;
}

/** Build an env object from scratch so the real process env never leaks in. */
function env(options: { bin?: string; path?: string } = {}): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  if (options.bin !== undefined) result.HERDR_BIN_PATH = options.bin;
  if (options.path !== undefined) result.PATH = options.path;
  return result;
}

describe('stripDeletedSuffix', () => {
  it('removes only the trailing stale-inode marker', () => {
    expect(stripDeletedSuffix('/opt/herdr (deleted)')).toBe('/opt/herdr');
  });

  it('leaves a normal path untouched (including spaces in directories)', () => {
    expect(stripDeletedSuffix('/opt/my tools/herdr')).toBe('/opt/my tools/herdr');
  });

  it('does not strip the marker when it is not at the end', () => {
    expect(stripDeletedSuffix('/opt/herdr (deleted)/bin')).toBe('/opt/herdr (deleted)/bin');
  });
});

describe('resolveHerdrBin', () => {
  it('returns "herdr" when HERDR_BIN_PATH is unset', () => {
    expect(resolveHerdrBin(env({ path: '/nonexistent' }))).toBe(DEFAULT_HERDR_BIN);
  });

  it('returns "herdr" when HERDR_BIN_PATH is empty or whitespace', () => {
    expect(resolveHerdrBin(env({ bin: '', path: '/nonexistent' }))).toBe(DEFAULT_HERDR_BIN);
    expect(resolveHerdrBin(env({ bin: '   ', path: '/nonexistent' }))).toBe(DEFAULT_HERDR_BIN);
  });

  it('uses an explicit, existing HERDR_BIN_PATH unchanged', () => {
    const bin = makeExecutable(join(root, 'explicit'));
    expect(resolveHerdrBin(env({ bin, path: '/nonexistent' }))).toBe(bin);
  });

  it('strips the " (deleted)" suffix and uses the replaced binary in place', () => {
    // The exact production scenario: the server's /proc/self/exe names the
    // old inode while the new binary sits at the un-suffixed path.
    const bin = makeExecutable(join(root, 'in-place'));
    expect(resolveHerdrBin(env({ bin: `${bin} (deleted)`, path: '/nonexistent' }))).toBe(bin);
  });

  it('falls back to "herdr" on PATH when the stale path no longer exists', () => {
    const pathDir = join(root, 'fallback-path');
    const onPath = makeExecutable(pathDir);
    const stale = join(root, 'gone', `${DEFAULT_HERDR_BIN} (deleted)`);
    expect(resolveHerdrBin(env({ bin: stale, path: pathDir }))).toBe(onPath);
  });

  it('falls back to "herdr" on PATH when HERDR_BIN_PATH does not exist', () => {
    const pathDir = join(root, 'missing-path');
    const onPath = makeExecutable(pathDir);
    const missing = join(root, 'missing', DEFAULT_HERDR_BIN);
    expect(resolveHerdrBin(env({ bin: missing, path: pathDir }))).toBe(onPath);
  });

  it.skipIf(isWindows)('falls back to PATH when HERDR_BIN_PATH is not executable', () => {
    const pathDir = join(root, 'non-exec-path');
    const onPath = makeExecutable(pathDir);
    const notExecutable = join(root, 'non-exec', DEFAULT_HERDR_BIN);
    mkdirSync(join(root, 'non-exec'), { recursive: true });
    writeFileSync(notExecutable, 'not a program\n');
    chmodSync(notExecutable, 0o644);
    expect(resolveHerdrBin(env({ bin: notExecutable, path: pathDir }))).toBe(onPath);
  });

  it('ignores PATH entries that are not executable files', () => {
    const goodDir = join(root, 'path-good');
    const onPath = makeExecutable(goodDir);
    const dirEntry = join(root, 'path-dir-entry');
    mkdirSync(join(dirEntry, DEFAULT_HERDR_BIN), { recursive: true });
    // A directory named `herdr` earlier on PATH must not win over the real one.
    expect(
      resolveHerdrBin(env({ bin: join(root, 'nope', DEFAULT_HERDR_BIN), path: `${dirEntry}:${goodDir}` })),
    ).toBe(onPath);
  });

  it('ignores empty PATH segments', () => {
    const pathDir = join(root, 'empty-segments');
    const onPath = makeExecutable(pathDir);
    expect(
      resolveHerdrBin(env({ bin: `${join(root, 'nope')} (deleted)`, path: `:${pathDir}:` })),
    ).toBe(onPath);
  });

  it('returns the stripped attempted path when nothing resolves (diagnostics)', () => {
    expect(
      resolveHerdrBin(env({ bin: '/no/such/dir/herdr (deleted)', path: '/also/not/here' })),
    ).toBe('/no/such/dir/herdr');
    expect(
      resolveHerdrBin(env({ bin: '/no/such/dir/herdr', path: '/also/not/here' })),
    ).toBe('/no/such/dir/herdr');
  });

  it('reads the injected env, not the real process environment', () => {
    const real = process.env.HERDR_BIN_PATH;
    process.env.HERDR_BIN_PATH = '/from/real/env/herdr';
    try {
      expect(resolveHerdrBin(env({ bin: '/from/injected/env/herdr', path: '/nonexistent' }))).toBe(
        '/from/injected/env/herdr',
      );
    } finally {
      if (real === undefined) delete process.env.HERDR_BIN_PATH;
      else process.env.HERDR_BIN_PATH = real;
    }
  });

  describe('with the real process environment', () => {
    let saved: NodeJS.ProcessEnv;

    beforeEach(() => {
      saved = {
        HERDR_BIN_PATH: process.env.HERDR_BIN_PATH,
        PATH: process.env.PATH,
      };
    });

    afterEach(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it('defaults to process.env', () => {
      delete process.env.HERDR_BIN_PATH;
      expect(resolveHerdrBin()).toBe(DEFAULT_HERDR_BIN);
    });

    it('resolves a stale process env path to an existing binary', () => {
      const bin = makeExecutable(join(root, 'process-env'));
      process.env.HERDR_BIN_PATH = `${bin} (deleted)`;
      expect(resolveHerdrBin()).toBe(bin);
    });
  });
});
