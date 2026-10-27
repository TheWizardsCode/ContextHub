/**
 * Missing shared build output diagnostic (WL-0MVPADZ1Z000FOSG AC4).
 *
 * `wl` resolves `@worklog/shared/*` through the workspace link into
 * `packages/shared/dist` — gitignored build output. When that output is
 * missing (the 2026-10-26 wipe), the CLI used to die with a bare
 * `ERR_MODULE_NOT_FOUND` stack trace. `src/cli.ts` now runs a preflight and
 * prints one actionable diagnostic naming the missing artifact, the absolute
 * path checked and the exact remediation (`npm run build:shared`).
 *
 * The preflight mirrors the runtime resolution (`import.meta.resolve` from the
 * CLI module, then an existence check) so a linked worktree without its own
 * `dist/` — where the runtime resolves the main checkout's build output via
 * the symlinked `node_modules` — is never a false positive.
 *
 * Coverage:
 * - unit tests for the resolver/diagnostic helpers (injected resolver, no
 *   CLI spawn, no live-checkout mutation),
 * - a CLI test running a temporary copy of the **built** CLI (the tsc `dist/`
 *   tree) whose shared output is removed,
 * - a healthy control: `--version` / `--help` keep working with the output
 *   present.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import {
  expectedSharedDistArtifactPath,
  missingSharedDistDiagnostic,
  sharedDistPreflight,
  SHARED_DIST_ARTIFACT_RELPATH,
  SHARED_DIST_SPECIFIER,
} from '../../src/cli.js';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliSourcePath = path.join(repoRoot, 'src', 'cli.ts');
const sharedPackageDir = path.join(repoRoot, 'packages', 'shared');

/** Scratch space under the gitignored `.worklog/`, so nothing dirties the tree. */
function scratchDir(name: string): string {
  const dir = path.join(
    repoRoot,
    '.worklog',
    'test-missing-shared-dist',
    `${name}-${process.pid}`
  );
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  process.once('exit', () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });
  return dir;
}

function fileUrl(filePath: string): string {
  return new URL(`file://${filePath}`).href;
}

/**
 * The tsc build output (`dist/cli.js`) — this checkout's when built, otherwise
 * the main checkout's (agent worktrees do not carry the gitignored build).
 */
function findBuiltCli(): string | null {
  const roots = [repoRoot];
  // Agent worktrees do not carry the gitignored `dist/`; derive the main
  // checkout from the documented `<main>/.worklog/worktrees/<name>` layout.
  const marker = `${path.sep}.worklog${path.sep}worktrees${path.sep}`;
  const index = repoRoot.indexOf(marker);
  if (index > 0) roots.push(repoRoot.slice(0, index));
  const candidates = roots.map((root) => path.join(root, 'dist', 'cli.js'));
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

/** Locate the built shared package (`packages/shared/dist`) to copy. */
function findSharedDist(): string | null {
  const local = path.join(sharedPackageDir, 'dist');
  if (fs.existsSync(path.join(local, 'worklog-paths.js'))) return local;
  const builtCli = findBuiltCli();
  if (!builtCli) return null;
  // <root>/dist/cli.js → <root>/packages/shared/dist
  const candidate = path.join(path.dirname(path.dirname(builtCli)), 'packages', 'shared', 'dist');
  return fs.existsSync(path.join(candidate, 'worklog-paths.js')) ? candidate : null;
}

/** Copy the built CLI + workspace layout into `<dir>/app`, optionally with dist. */
function stageBuiltCli(dir: string, options: { withSharedDist: boolean }): string {
  const builtCli = findBuiltCli();
  if (!builtCli) throw new Error('no built CLI (run `npm run build` first)');
  const distSource = path.dirname(builtCli);
  const appRoot = path.join(dir, 'app');
  fs.mkdirSync(appRoot, { recursive: true });
  fs.cpSync(distSource, path.join(appRoot, 'dist'), { recursive: true });
  // The copied tree may predate this change (agent worktrees do not carry a
  // current build), so transpile the CURRENT `src/cli.ts` over the copied
  // `dist/cli.js`. Transpiling (not bundling) keeps cli.ts's module boundaries
  // — which the preflight depends on — exactly as the real build does.
  const esbuild = require('esbuild') as typeof import('esbuild');
  esbuild.buildSync({
    entryPoints: [cliSourcePath],
    bundle: false,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: path.join(appRoot, 'dist', 'cli.js'),
    logLevel: 'silent',
  });

  const sharedPkg = path.join(appRoot, 'packages', 'shared');
  fs.mkdirSync(sharedPkg, { recursive: true });
  fs.copyFileSync(
    path.join(sharedPackageDir, 'package.json'),
    path.join(sharedPkg, 'package.json')
  );
  if (options.withSharedDist) {
    const sharedDist = findSharedDist();
    if (!sharedDist) throw new Error('no built shared package (run `npm run build:shared`)');
    fs.cpSync(sharedDist, path.join(sharedPkg, 'dist'), { recursive: true });
  }

  // Workspace install shape: node_modules/@worklog/shared → packages/shared.
  fs.mkdirSync(path.join(appRoot, 'node_modules', '@worklog'), { recursive: true });
  fs.symlinkSync(
    sharedPkg,
    path.join(appRoot, 'node_modules', '@worklog', 'shared'),
    'dir'
  );
  return path.join(appRoot, 'dist', 'cli.js');
}

// ---------------------------------------------------------------------------
// Unit tests: the resolver + diagnostic helpers
// ---------------------------------------------------------------------------

describe('shared build-output preflight resolver', () => {
  it('resolves the expected artifact path from this checkout', () => {
    const artifact = expectedSharedDistArtifactPath();
    expect(artifact).toBe(
      path.join(repoRoot, ...SHARED_DIST_ARTIFACT_RELPATH.split('/'))
    );
  });

  it('proceeds when the runtime resolves an existing artifact', () => {
    const fixture = path.join(scratchDir('healthy'), 'dist', 'worklog-paths.js');
    fs.mkdirSync(path.dirname(fixture), { recursive: true });
    fs.writeFileSync(fixture, '');
    const diagnostic = sharedDistPreflight({
      resolve: (specifier) => {
        expect(specifier).toBe(SHARED_DIST_SPECIFIER);
        return fileUrl(fixture);
      },
    });
    expect(diagnostic).toBeNull();
  });

  it('reports the resolved path when the resolved file does not exist', () => {
    const missing = path.join(
      scratchDir('broken'),
      'packages',
      'shared',
      'dist',
      'worklog-paths.js'
    );
    const diagnostic = sharedDistPreflight({
      resolve: () => fileUrl(missing),
    });
    expect(diagnostic).not.toBeNull();
    expect(diagnostic).toContain(`Missing artifact: ${missing}`);
    expect(diagnostic).toContain('npm run build:shared');
  });

  it('reports the expected path when resolution throws', () => {
    const diagnostic = sharedDistPreflight({
      resolve: () => {
        throw new Error('ERR_MODULE_NOT_FOUND');
      },
    });
    expect(diagnostic).not.toBeNull();
    expect(diagnostic).toContain(
      path.join(repoRoot, ...SHARED_DIST_ARTIFACT_RELPATH.split('/'))
    );
  });

  it('stays silent when no repository root is discoverable (no guessing)', () => {
    // Outside any checkout: walking up finds no packages/shared/package.json.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-no-shared-root-'));
    try {
      const moduleFile = path.join(root, 'cli.mjs');
      fs.writeFileSync(moduleFile, '');
      expect(expectedSharedDistArtifactPath(fileUrl(moduleFile))).toBeNull();
      expect(
        sharedDistPreflight({
          moduleUrl: fileUrl(moduleFile),
          resolve: () => {
            throw new Error('missing');
          },
        })
      ).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('diagnostic names the artifact, the path checked and the remediation', () => {
    const artifact = path.join('/tmp/repo', ...SHARED_DIST_ARTIFACT_RELPATH.split('/'));
    const diagnostic = missingSharedDistDiagnostic(artifact);
    expect(diagnostic).toContain('cannot start');
    expect(diagnostic).toContain(`Missing artifact: ${artifact}`);
    expect(diagnostic).toContain('packages/shared/dist');
    expect(diagnostic).toContain('npm run build:shared');
    expect(diagnostic).toContain('/tmp/repo');
    // One actionable block, not a stack trace.
    expect(diagnostic).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(diagnostic.split('\n').length).toBeLessThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// CLI tests: a temporary copy of the built CLI
// ---------------------------------------------------------------------------

const builtCliAvailable = findBuiltCli() !== null;

describe('wl missing shared build output diagnostic (CLI)', () => {
  it.skipIf(!builtCliAvailable)(
    'prints one actionable diagnostic and exits non-zero when dist is missing',
    () => {
      const dir = scratchDir('broken-cli');
      // A temporary copy of the built CLI whose shared output is absent.
      const cliEntry = stageBuiltCli(dir, { withSharedDist: false });

      const result = spawnSync(process.execPath, [cliEntry, 'list', '--json'], {
        encoding: 'utf-8',
        timeout: 120_000,
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('cannot start');
      expect(result.stderr).toContain('Missing artifact:');
      expect(result.stderr).toContain('npm run build:shared');
      expect(result.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
      expect(result.stderr).not.toContain('\n    at ');
      // The diagnostic names the absolute path this install resolved (via
      // node_modules/@worklog/shared) and the missing artifact.
      expect(result.stderr).toContain(path.join(dir, 'app'));
      expect(result.stderr).toContain(
        SHARED_DIST_ARTIFACT_RELPATH.split('/').slice(-1)[0]
      );
    }
  );

  it.skipIf(!builtCliAvailable)(
    'keeps --version and --help working when the build output is present',
    () => {
      const dir = scratchDir('healthy-cli');
      const cliEntry = stageBuiltCli(dir, { withSharedDist: true });

      const version = spawnSync(process.execPath, [cliEntry, '--version'], {
        encoding: 'utf-8',
        timeout: 120_000,
      });
      expect(version.status).toBe(0);
      expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
      expect(version.stderr).not.toContain('cannot start');

      const help = spawnSync(process.execPath, [cliEntry, '--help'], {
        encoding: 'utf-8',
        timeout: 120_000,
      });
      expect(help.status).toBe(0);
      expect(help.stdout).toContain('Usage:');
      expect(help.stderr).not.toContain('cannot start');
    }
  );
});
