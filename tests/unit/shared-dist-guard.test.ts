/**
 * Guard-internal contracts for `sharedDistFreshnessDiagnostic`
 * (WL-0MWHD4CYF008J4LB, parent WL-0MW8G1X3V007CGAE).
 *
 * The sibling red-first suite (`shared-dist-freshness.test.ts`) pins the
 * diagnostic's shape: stale, equal-mtime fresh, missing-dist, no-repo-root and
 * linked-worktree resolution. This file pins the remaining acceptance criteria
 * that suite leaves implicit:
 *
 * 1. **Symlinked resolution.** A worktree's `node_modules/@worklog/shared` is a
 *    symlink into the owning checkout; the guard must follow it and name that
 *    checkout's `packages/shared` (and its rebuild command), never the link.
 * 2. **The rebuild root follows the resolved package.** The command is
 *    `cd <owning checkout> && npm run build:shared`, not the worktree's.
 * 3. **Generated/declaration sources are excluded**, mirroring `isDistFresh`'s
 *    documented rule: a regenerated `src/version.ts` or a `*.d.ts` newer than
 *    the build must not report a false failure.
 * 4. **Unreadable directory fails open** (`ENOTDIR` here) instead of inventing
 *    a missing-build failure.
 * 5. **Wiped build with an unresolvable specifier is still actionable** when a
 *    repository root is discoverable from the module URL — the diagnostic names
 *    the expected artefact and the rebuild command rather than staying silent.
 *
 * Fixtures are temp directories with controlled mtimes, so no assertion
 * depends on this checkout's real `packages/shared` build.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'node:url';
import { sharedDistFreshnessDiagnostic } from '../shared-dist-guard.js';

/** Fixed epoch seconds keep the mtime ordering unambiguous. */
const OLDER = 1_700_000_000;
const MID = OLDER + 60;
const NEWEST = OLDER + 120;

const SHARED_SPECIFIER = '@worklog/shared/worklog-paths';

let fixtureRoot: string;

/** Write `content` at `relativePath` under `baseDir` with an explicit mtime. */
function writeAtMtime(
  baseDir: string,
  relativePath: string,
  epochSeconds: number,
  content = `// ${relativePath}\n`
): string {
  const full = path.join(baseDir, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  fs.utimesSync(full, epochSeconds, epochSeconds);
  return full;
}

interface SeededPackage {
  root: string;
  packageDir: string;
  artefactPath: string;
}

/** Seed `<root>/packages/shared` with root markers, sources and a build. */
function seedPackage(
  root: string,
  options: { artefactMtime: number | null; sources: Record<string, number> }
): SeededPackage {
  writeAtMtime(
    root,
    'package.json',
    OLDER,
    JSON.stringify({
      name: 'worklog',
      dependencies: { '@worklog/shared': 'file:./packages/shared' },
    })
  );
  writeAtMtime(
    root,
    path.join('packages', 'shared', 'package.json'),
    OLDER,
    JSON.stringify({ name: '@worklog/shared', main: './dist/worklog-paths.js' })
  );
  for (const [relative, mtime] of Object.entries(options.sources)) {
    writeAtMtime(
      root,
      path.join('packages', 'shared', 'src', relative),
      mtime
    );
  }

  const artefactPath = path.join(
    root,
    'packages',
    'shared',
    'dist',
    'worklog-paths.js'
  );
  if (options.artefactMtime !== null) {
    writeAtMtime(
      root,
      path.join('packages', 'shared', 'dist', 'worklog-paths.js'),
      options.artefactMtime
    );
  }

  return { root, packageDir: path.join(root, 'packages', 'shared'), artefactPath };
}

/** A resolver that pins the specifier and returns the given artefact URL. */
function resolveTo(artefactPath: string): (specifier: string) => string {
  return (specifier) => {
    expect(specifier).toBe(SHARED_SPECIFIER);
    return pathToFileURL(artefactPath).href;
  };
}

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-shared-guard-'));
});

afterEach(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('sharedDistFreshnessDiagnostic — symlinked resolution', () => {
  it('follows node_modules/@worklog/shared into the owning checkout', () => {
    const main = seedPackage(path.join(fixtureRoot, 'main'), {
      artefactMtime: OLDER,
      sources: { 'newest.ts': NEWEST },
    });
    const worktree = seedPackage(path.join(fixtureRoot, 'worktree'), {
      artefactMtime: NEWEST,
      sources: { 'newest.ts': OLDER },
    });
    // The worktree's node_modules link, exactly as the runtime sees it.
    const linkDir = path.join(worktree.root, 'node_modules', '@worklog', 'shared');
    fs.mkdirSync(path.dirname(linkDir), { recursive: true });
    fs.symlinkSync(main.packageDir, linkDir, 'dir');

    const diagnostic = sharedDistFreshnessDiagnostic({
      resolve: resolveTo(path.join(linkDir, 'dist', 'worklog-paths.js')),
    });

    expect(diagnostic, 'the owning checkout build is stale').not.toBeNull();
    // The realpath, not the symlink path the resolver returned.
    const realPackageDir = fs.realpathSync(main.packageDir);
    expect(diagnostic).toContain(realPackageDir);
    expect(diagnostic).not.toContain(linkDir);
    expect(diagnostic).not.toContain(worktree.packageDir);
  });

  it('names the owning checkout, not the worktree, in the rebuild command', () => {
    const main = seedPackage(path.join(fixtureRoot, 'main'), {
      artefactMtime: OLDER,
      sources: { 'newest.ts': NEWEST },
    });
    const worktree = seedPackage(path.join(fixtureRoot, 'worktree'), {
      artefactMtime: NEWEST,
      sources: { 'newest.ts': OLDER },
    });
    const linkDir = path.join(worktree.root, 'node_modules', '@worklog', 'shared');
    fs.mkdirSync(path.dirname(linkDir), { recursive: true });
    fs.symlinkSync(main.packageDir, linkDir, 'dir');

    const diagnostic = sharedDistFreshnessDiagnostic({
      resolve: resolveTo(path.join(linkDir, 'dist', 'worklog-paths.js')),
    });

    expect(diagnostic).toContain(
      `cd ${fs.realpathSync(main.root)} && npm run build:shared`
    );
    expect(diagnostic).not.toContain(`cd ${worktree.root} `);
  });
});

describe('sharedDistFreshnessDiagnostic — generated sources', () => {
  it('ignores a regenerated src/version.ts and declaration files', () => {
    const seeded = seedPackage(path.join(fixtureRoot, 'repo'), {
      artefactMtime: MID,
      sources: {
        'index.ts': OLDER,
        // Rewritten after tsc / compiler output only — never build inputs.
        'version.ts': NEWEST,
        'types.d.ts': NEWEST,
      },
    });

    expect(
      sharedDistFreshnessDiagnostic({
        resolve: resolveTo(seeded.artefactPath),
      })
    ).toBeNull();
  });
});

describe('sharedDistFreshnessDiagnostic — unreadable build directory', () => {
  it('degrades to null instead of inventing a missing-build failure', () => {
    const seeded = seedPackage(path.join(fixtureRoot, 'repo'), {
      artefactMtime: null,
      sources: { 'newest.ts': NEWEST },
    });
    // `dist` exists but is not a directory: stat fails with ENOTDIR, i.e.
    // "cannot read", not "build output absent".
    writeAtMtime(
      seeded.root,
      path.join('packages', 'shared', 'dist'),
      OLDER,
      'not a directory\n'
    );

    expect(
      sharedDistFreshnessDiagnostic({
        resolve: resolveTo(seeded.artefactPath),
      })
    ).toBeNull();
  });
});

describe('sharedDistFreshnessDiagnostic — wiped build, unresolvable specifier', () => {
  it('still names the expected artefact and rebuild command when a root is discoverable', () => {
    const seeded = seedPackage(path.join(fixtureRoot, 'repo'), {
      artefactMtime: null, // wiped build
      sources: { 'newest.ts': NEWEST },
    });
    const appModule = writeAtMtime(
      seeded.root,
      path.join('tests', 'global-setup.ts'),
      OLDER
    );

    const diagnostic = sharedDistFreshnessDiagnostic({
      moduleUrl: pathToFileURL(appModule).href,
      resolve: () => {
        throw new Error('ERR_MODULE_NOT_FOUND');
      },
    });

    expect(diagnostic).not.toBeNull();
    expect(diagnostic).toContain(seeded.packageDir);
    expect(diagnostic).toContain(seeded.artefactPath);
    expect(diagnostic).toContain(`cd ${seeded.root} && npm run build:shared`);
  });
});
