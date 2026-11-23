/**
 * Build-freshness contracts for the shared workspace package
 * (`@worklog/shared`) — RED-FIRST SLICE (WL-0MWHD4932006D6GO, parent
 * WL-0MW8G1X3V007CGAE).
 *
 * ## Why
 *
 * `tests/**` resolve `@worklog/shared` through the package `exports` map to
 * `packages/shared/dist/` — gitignored build output. A checkout whose build
 * predates a change under `packages/shared/src` therefore exercises OLD
 * shared code, and a full-suite run reports failures for work that is already
 * correct and merged. Nothing in the run says the build is stale, so the red
 * looks like a code defect. The sibling implementation item
 * (WL-0MWHD4CYF008J4LB) introduces a run-once guard; this suite pins its
 * contract *before* that guard exists.
 *
 * ## Contract pinned here
 *
 * `sharedDistFreshnessDiagnostic(options)` in `tests/shared-dist-guard.ts`
 * returns `null` when the run may proceed, or one actionable diagnostic
 * string when the resolved shared build is stale or missing. The diagnostic
 * names:
 *
 *   1. the resolved `packages/shared` directory,
 *   2. the stale/missing artefact and the newest source path with their
 *      mtimes (ISO 8601, `Date#toISOString()`),
 *   3. the exact rebuild command from the owning repository root:
 *      `cd <repoRoot> && npm run build:shared`.
 *
 * Semantics:
 *
 *   - `options.resolve(specifier)` mirrors runtime module resolution and
 *     returns the absolute path (or `file://` URL) of the build artefact the
 *     run actually loads. It receives `@worklog/shared/worklog-paths`, the
 *     the same specifier `src/cli.ts` resolves. The guard judges *that*
 *     package (following the resolution, including a linked-worktree
 *     `node_modules/@worklog/shared` symlink into the main checkout) and
 *     never a worktree-local `packages/shared` mirror.
 *   - `options.moduleUrl` anchors repository-root discovery when the artefact
 *     cannot be resolved (a wiped build) and is the fail-open boundary for
 *     the no-root case.
 *   - Equal mtimes count as fresh; a missing `dist/` produces the same
 *     actionable failure shape instead of a raw `ERR_MODULE_NOT_FOUND`.
 *   - Fail-open: an unresolvable package with no discoverable repository root
 *     returns `null` — silent, never a false failure.
 *
 * ## Red-first and self-activation
 *
 * Every spec below is RED-pinned with `it.fails(...)` *while the guard module
 * is absent*: the dynamic import rejects, so each spec fails as expected and
 * the tree stays green. The pin is self-activating — once
 * `tests/shared-dist-guard.ts` exists (the implementation item
 * WL-0MWHD4CYF008J4LB), the same specs run as plain `it(...)` and genuinely
 * enforce the contract, so the guard can never pass vacuously. Importing the
 * guard dynamically (rather than a static value import) is what lets the file
 * load before the module exists, mirroring
 * `tests/unit/doctor-prefix-check.test.ts`.
 *
 * Red-first evidence (recorded on the work item): with the pins temporarily
 * unwrapped, the suite fails against the absent guard, and an always-fresh
 * (`return null`) stub fails the stale case on its own assertion — proving the
 * stale fixture does not pass vacuously.
 *
 * Fixtures are temp directories with explicitly set mtimes (the pattern of
 * `tests/unit/startup-target-freshness.test.ts`), so the assertions never
 * depend on this checkout's real `packages/shared` build.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The guard's options shape (declared locally: the module is absent today). */
interface SharedBuildFreshnessOptions {
  moduleUrl?: string;
  resolve?: (specifier: string) => string;
}

interface SharedBuildGuardModule {
  sharedDistFreshnessDiagnostic: (
    options?: SharedBuildFreshnessOptions
  ) => string | null;
}

/** Resolve the guard module once the implementation item adds it (throws today). */
async function loadGuard(): Promise<SharedBuildGuardModule> {
  return (await import('../shared-dist-guard.js')) as SharedBuildGuardModule;
}

/** Specifier the guard resolves, mirroring `src/cli.ts`'s preflight. */
const SHARED_SPECIFIER = '@worklog/shared/worklog-paths';

/** Fixed epoch seconds keep the mtime ordering unambiguous. */
const OLDER = 1_700_000_000;
const MID = OLDER + 60;
const NEWEST = OLDER + 120;

/**
 * Self-activating red pins: `it.fails` until the guard module lands, plain
 * `it` afterwards. Presence is a filesystem check (no async import at module
 * load) against the sibling implementation item's module path.
 */
const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const GUARD_PRESENT = ['shared-dist-guard.ts', 'shared-dist-guard.js'].some(
  (name) => fs.existsSync(path.join(TESTS_DIR, '..', name))
);
const spec = GUARD_PRESENT ? it : it.fails;

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

function fileUrl(p: string): string {
  return pathToFileURL(p).href;
}

interface SeededPackage {
  root: string;
  packageDir: string;
  artefactPath: string;
  newestSourcePath: string;
}

/**
 * Seed `<root>/packages/shared` with controlled-mtime sources and, unless
 * `artefactMtime` is `null`, a `dist/worklog-paths.js` build artefact. Root
 * markers (`package.json`, `packages/shared/package.json`) mirror a real
 * checkout so root discovery is never guessed.
 */
function seedSharedPackage(
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

  let newestSourcePath = '';
  let newestSourceMtime = Number.NEGATIVE_INFINITY;
  for (const [relative, mtime] of Object.entries(options.sources)) {
    const full = writeAtMtime(
      root,
      path.join('packages', 'shared', 'src', relative),
      mtime
    );
    if (mtime > newestSourceMtime) {
      newestSourceMtime = mtime;
      newestSourcePath = full;
    }
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

  return {
    root,
    packageDir: path.join(root, 'packages', 'shared'),
    artefactPath,
    newestSourcePath,
  };
}

/** An injected resolver that pins the specifier and the resolved artefact. */
function resolveTo(artefactPath: string): (specifier: string) => string {
  return (specifier) => {
    expect(specifier).toBe(SHARED_SPECIFIER);
    return fileUrl(artefactPath);
  };
}

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-shared-freshness-'));
});

afterEach(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('sharedDistFreshnessDiagnostic — stale build', () => {
  spec(
    'names the resolved directory, both mtimes and the exact rebuild command',
    async () => {
      const { sharedDistFreshnessDiagnostic } = await loadGuard();
      const seeded = seedSharedPackage(path.join(fixtureRoot, 'repo'), {
        artefactMtime: OLDER,
        sources: { 'old.ts': MID, 'newest.ts': NEWEST },
      });

      const diagnostic = sharedDistFreshnessDiagnostic({
        resolve: resolveTo(seeded.artefactPath),
      });

      expect(diagnostic, 'a stale build must not pass silently').not.toBeNull();
      // (a) The resolved packages/shared directory.
      expect(diagnostic).toContain(seeded.packageDir);
      // The artefact and the *newest* source file (not merely any source).
      expect(diagnostic).toContain(seeded.artefactPath);
      expect(diagnostic).toContain(seeded.newestSourcePath);
      // (b) Stale artefact mtime versus the newest source mtime.
      expect(diagnostic).toContain(
        fs.statSync(seeded.artefactPath).mtime.toISOString()
      );
      expect(diagnostic).toContain(
        fs.statSync(seeded.newestSourcePath).mtime.toISOString()
      );
      // (c) The exact rebuild command from the owning repository root.
      expect(diagnostic).toContain(
        `cd ${seeded.root} && npm run build:shared`
      );
      // One actionable message, not a module-resolution stack.
      expect(diagnostic).not.toContain('ERR_MODULE_NOT_FOUND');
    }
  );
});

describe('sharedDistFreshnessDiagnostic — fresh build', () => {
  spec(
    'returns null when the artefact and the newest source share an mtime',
    async () => {
      const { sharedDistFreshnessDiagnostic } = await loadGuard();
      const seeded = seedSharedPackage(path.join(fixtureRoot, 'repo'), {
        artefactMtime: NEWEST,
        sources: { 'old.ts': OLDER, 'newest.ts': NEWEST },
      });

      expect(
        sharedDistFreshnessDiagnostic({
          resolve: resolveTo(seeded.artefactPath),
        })
      ).toBeNull();
    }
  );
});

describe('sharedDistFreshnessDiagnostic — missing build output', () => {
  spec(
    'reports the same actionable failure instead of a raw ERR_MODULE_NOT_FOUND',
    async () => {
      const { sharedDistFreshnessDiagnostic } = await loadGuard();
      const seeded = seedSharedPackage(path.join(fixtureRoot, 'repo'), {
        artefactMtime: null, // packages/shared/dist is absent
        sources: { 'newest.ts': NEWEST },
      });

      const diagnostic = sharedDistFreshnessDiagnostic({
        resolve: resolveTo(seeded.artefactPath),
      });

      expect(diagnostic, 'a missing build must not pass silently').not.toBeNull();
      expect(diagnostic).toContain(seeded.packageDir);
      expect(diagnostic).toContain(seeded.artefactPath);
      expect(diagnostic).toContain(
        `cd ${seeded.root} && npm run build:shared`
      );
      // The whole point: the operator sees the rebuild command, not
      // `Cannot find module '@worklog/shared/...'`.
      expect(diagnostic).not.toContain('ERR_MODULE_NOT_FOUND');
    }
  );
});

describe('sharedDistFreshnessDiagnostic — fail-open', () => {
  spec(
    'returns null when no repository root can be discovered',
    async () => {
      const { sharedDistFreshnessDiagnostic } = await loadGuard();
      // Outside any checkout: no packages/shared marker on any ancestor.
      const outside = path.join(fixtureRoot, 'not-a-repo');
      const appModule = writeAtMtime(outside, 'app.mjs', OLDER);

      const diagnostic = sharedDistFreshnessDiagnostic({
        moduleUrl: fileUrl(appModule),
        resolve: () => {
          throw new Error('ERR_MODULE_NOT_FOUND');
        },
      });

      expect(diagnostic).toBeNull();
    }
  );
});

describe('sharedDistFreshnessDiagnostic — linked-worktree resolution', () => {
  spec(
    'judges the resolved main-checkout package, not a worktree-local mirror',
    async () => {
      const { sharedDistFreshnessDiagnostic } = await loadGuard();
      // Main checkout: stale. Worktree mirror: looks fresh.
      const main = seedSharedPackage(path.join(fixtureRoot, 'main'), {
        artefactMtime: OLDER,
        sources: { 'newest.ts': NEWEST },
      });
      const worktree = seedSharedPackage(path.join(fixtureRoot, 'worktree'), {
        artefactMtime: NEWEST,
        sources: { 'newest.ts': OLDER },
      });
      const worktreeModule = writeAtMtime(
        worktree.root,
        path.join('tests', 'global-setup.ts'),
        OLDER
      );

      const diagnostic = sharedDistFreshnessDiagnostic({
        // The run lives in the worktree...
        moduleUrl: fileUrl(worktreeModule),
        // ...but resolves the main checkout's build through the symlinked
        // node_modules/@worklog/shared (what the guard must judge).
        resolve: resolveTo(main.artefactPath),
      });

      expect(diagnostic, 'the main checkout build is stale').not.toBeNull();
      expect(diagnostic).toContain(main.packageDir);
      // The mirror-image false positive: the worktree-local copy looks fresh
      // and must never be what the guard reports on.
      expect(diagnostic).not.toContain(worktree.packageDir);
    }
  );

  spec(
    'returns null when the resolved main-checkout package is fresh even though the worktree mirror is stale',
    async () => {
      const { sharedDistFreshnessDiagnostic } = await loadGuard();
      const main = seedSharedPackage(path.join(fixtureRoot, 'main'), {
        artefactMtime: NEWEST,
        sources: { 'newest.ts': OLDER },
      });
      const worktree = seedSharedPackage(path.join(fixtureRoot, 'worktree'), {
        artefactMtime: OLDER,
        sources: { 'newest.ts': NEWEST },
      });
      const worktreeModule = writeAtMtime(
        worktree.root,
        path.join('tests', 'global-setup.ts'),
        OLDER
      );

      const diagnostic = sharedDistFreshnessDiagnostic({
        moduleUrl: fileUrl(worktreeModule),
        resolve: resolveTo(main.artefactPath),
      });

      // Judging the worktree-local stale mirror would be a false failure.
      expect(diagnostic).toBeNull();
    }
  );
});
