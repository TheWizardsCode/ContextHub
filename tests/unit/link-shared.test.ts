/**
 * tests/scripts/link-shared.test.ts — Behavioural regression tests for
 * packages/herdr/scripts/link-shared.mjs (WL-0MVAY631M004RZ3Q).
 *
 * The herdr plugin installs its `@worklog/shared` file: dependency as a
 * PACKAGED COPY inside packages/herdr/node_modules. That copy silently goes
 * stale whenever packages/shared changes: the plugin then imports a missing
 * export ('needsProducerReviewIcon' during the F2 restore) and the pane
 * dies on startup with an opaque ESM SyntaxError. linkSharedPackage() makes
 * the resolution LIVE instead — a relative symlink to the workspace
 * packages/shared — so no stale copy can survive a build.
 *
 * Every scenario runs against an isolated temp repo; nothing touches the
 * real checkout.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { linkSharedPackage, resolveSharedLinkTarget } from '../../packages/herdr/scripts/link-shared.mjs';

/** Build a minimal repo layout: `<root>/packages/{shared,herdr}`. */
function makeTempRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-link-shared-'));
  fs.mkdirSync(path.join(root, 'packages', 'shared', 'dist'), { recursive: true });
  fs.mkdirSync(path.join(root, 'packages', 'herdr'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'packages', 'shared', 'package.json'),
    JSON.stringify({ name: '@worklog/shared', version: '1.0.0' }, null, 2),
  );
  fs.writeFileSync(
    path.join(root, 'packages', 'shared', 'dist', 'icons.js'),
    'export const statusIcon = () => "live";\n',
  );
  return root;
}

/** Simulate npm's packaged copy of @worklog/shared (the stale-artifact form). */
function writeStaleCopy(root: string, version = '0.9.0'): string {
  const sharedDir = path.join(root, 'packages', 'herdr', 'node_modules', '@worklog', 'shared');
  fs.mkdirSync(path.join(sharedDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(sharedDir, 'package.json'), JSON.stringify({ name: '@worklog/shared', version }, null, 2));
  fs.writeFileSync(path.join(sharedDir, 'dist', 'icons.js'), 'export const statusIcon = () => "stale";\n');
  return sharedDir;
}

function removeTemp(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

describe('linkSharedPackage (packages/herdr/scripts/link-shared.mjs)', () => {
  it('replaces a stale packaged @worklog/shared copy with a symlink to the live workspace package', () => {
    const root = makeTempRepo();
    try {
      const herdrDir = path.join(root, 'packages', 'herdr');
      const staleCopy = writeStaleCopy(root);
      const linkPath = resolveSharedLinkTarget(herdrDir);

      // Sanity: before the refresh the vendored path is a real stale copy.
      expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(staleCopy, 'dist', 'icons.js'), 'utf8')).toContain('stale');

      const result = linkSharedPackage(herdrDir);

      expect(result).toBe('linked');
      expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
      // The link now resolves to the LIVE workspace package — not the copy.
      const resolved = fs.realpathSync(linkPath);
      expect(resolved).toBe(path.join(root, 'packages', 'shared'));
      expect(JSON.parse(fs.readFileSync(path.join(linkPath, 'package.json'), 'utf8')).version).toBe('1.0.0');
      expect(fs.readFileSync(path.join(linkPath, 'dist', 'icons.js'), 'utf8')).toContain('live');
    } finally {
      removeTemp(root);
    }
  });

  it('is idempotent: leaves an already-correct symlink untouched', () => {
    const root = makeTempRepo();
    try {
      const herdrDir = path.join(root, 'packages', 'herdr');
      const first = linkSharedPackage(herdrDir);
      expect(first).toBe('linked');

      const second = linkSharedPackage(herdrDir);
      expect(second).toBe('unchanged');
      expect(fs.lstatSync(resolveSharedLinkTarget(herdrDir)).isSymbolicLink()).toBe(true);
    } finally {
      removeTemp(root);
    }
  });

  it('creates the symlink when @worklog/shared is missing entirely (fresh install)', () => {
    const root = makeTempRepo();
    try {
      const herdrDir = path.join(root, 'packages', 'herdr');
      const linkPath = resolveSharedLinkTarget(herdrDir);
      expect(fs.existsSync(linkPath)).toBe(false);

      const result = linkSharedPackage(herdrDir);

      expect(result).toBe('linked');
      expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    } finally {
      removeTemp(root);
    }
  });

  it('repairs a symlink that points at the wrong target', () => {
    const root = makeTempRepo();
    try {
      const herdrDir = path.join(root, 'packages', 'herdr');
      const linkPath = resolveSharedLinkTarget(herdrDir);
      // Someone pointed @worklog/shared at an unrelated directory.
      fs.mkdirSync(path.dirname(linkPath), { recursive: true });
      const wrongTarget = path.join(root, 'nowhere');
      fs.mkdirSync(wrongTarget, { recursive: true });
      fs.symlinkSync(wrongTarget, linkPath, 'dir');

      const result = linkSharedPackage(herdrDir);
      expect(result).toBe('linked');
      expect(fs.realpathSync(linkPath)).toBe(path.join(root, 'packages', 'shared'));
    } finally {
      removeTemp(root);
    }
  });

  it('throws a clear error when the workspace shared package is absent', () => {
    const root = makeTempRepo();
    try {
      // Remove the workspace package so there is nothing to link to.
      fs.rmSync(path.join(root, 'packages', 'shared'), { recursive: true, force: true });
      const herdrDir = path.join(root, 'packages', 'herdr');
      expect(() => linkSharedPackage(herdrDir)).toThrow(/packages\/shared/);
    } finally {
      removeTemp(root);
    }
  });
});

/**
 * End-to-end wiring: `scripts/install-herdr.sh` must invoke the link step so
 * a stale copy left behind by npm is refreshed on every build/install. This
 * runs the REAL installer against an isolated temp repo with fakes for npm,
 * node's package install and herdr, so nothing touches the real checkout.
 */
describe('install-herdr.sh links @worklog/shared (integration)', () => {
  it('converts a stale copy left by npm into a symlink to the live workspace package', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-install-herdr-link-'));
    try {
      // Minimal repo layout the installer expects.
      fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
      fs.mkdirSync(path.join(root, 'packages', 'herdr', 'scripts'), { recursive: true });
      fs.mkdirSync(path.join(root, 'packages', 'shared', 'dist'), { recursive: true });
      fs.copyFileSync(
        path.join(repoRoot, 'scripts', 'install-herdr.sh'),
        path.join(root, 'scripts', 'install-herdr.sh'),
      );
      fs.copyFileSync(
        path.join(repoRoot, 'packages', 'herdr', 'scripts', 'link-shared.mjs'),
        path.join(root, 'packages', 'herdr', 'scripts', 'link-shared.mjs'),
      );
      fs.writeFileSync(
        path.join(root, 'packages', 'herdr', 'package.json'),
        JSON.stringify({ name: '@worklog/herdr-plugin', version: '0.1.0', private: true }),
      );
      fs.writeFileSync(
        path.join(root, 'packages', 'herdr', 'herdr-plugin.toml'),
        'id = "worklog-selection-list"\n',
      );
      fs.writeFileSync(
        path.join(root, 'packages', 'shared', 'package.json'),
        JSON.stringify({ name: '@worklog/shared', version: '1.0.0' }),
      );
      fs.writeFileSync(
        path.join(root, 'packages', 'shared', 'dist', 'icons.js'),
        'export const statusIcon = () => "live";\n',
      );
      // npm's packaged (stale) copy, as if a previous install left it behind.
      writeStaleCopy(root);

      // Fake npm: exit 0 without invoking the real installer (the stale copy
      // is left in place, exactly as the reported bug produced it).
      const fakeBin = path.join(root, 'bin');
      fs.mkdirSync(fakeBin);
      fs.writeFileSync(path.join(fakeBin, 'npm'), '#!/usr/bin/env bash\nexit 0\n');
      fs.chmodSync(path.join(fakeBin, 'npm'), 0o755);
      // Fake herdr: the plugin link is irrelevant to this test.
      fs.writeFileSync(path.join(fakeBin, 'herdr'), '#!/usr/bin/env bash\nexit 0\n');
      fs.chmodSync(path.join(fakeBin, 'herdr'), 0o755);

      // Keep the real git (worktree resolution) and node, but the fake npm /
      // herdr win. Exclude the test-suite git mock, which lacks `worktree`.
      const mockBinDir = path.resolve(repoRoot, 'tests', 'cli', 'mock-bin');
      const cleanPath = (process.env.PATH ?? '')
        .split(path.delimiter)
        .filter((d) => d !== '' && path.resolve(d) !== mockBinDir);
      const scriptPath = `${fakeBin}${path.delimiter}${cleanPath.join(path.delimiter)}`;

      const configPath = path.join(root, 'herdr', 'config.toml');
      const result = spawnSync('bash', [path.join(root, 'scripts', 'install-herdr.sh')], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, PATH: scriptPath, HERDR_CONFIG_PATH: configPath },
      });
      expect(result.status, `installer failed: ${result.stderr}`).toBe(0);

      const linkPath = resolveSharedLinkTarget(path.join(root, 'packages', 'herdr'));
      expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(linkPath)).toBe(path.join(root, 'packages', 'shared'));
    } finally {
      removeTemp(root);
    }
  });
});
