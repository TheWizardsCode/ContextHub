/**
 * tests/cross-repo-discovery.test.ts
 *
 * AC1 specification for cross-repo project discovery — parent
 * WL-0MVWABT2Z001XMSD, child F1 (WL-0MVWEEK24000S3TW).
 *
 * ## The contract this file pins
 *
 * `discoverProjects({ projectsRoot?, cwd? })` in
 * `src/cross-repo/project-registry.ts` (built by F2, WL-0MVWEELAW005SDLU):
 *
 *   type DiscoveredProject = {
 *     prefix: string;
 *     // Project root — the directory holding `.worklog/`; `null` when the
 *     // prefix is ambiguous (never guessed).
 *     path: string | null;
 *     // Present and `true` when several projects declare this prefix.
 *     ambiguous?: boolean;
 *     // Every declaring project root, sorted — set only when ambiguous.
 *     candidates?: string[];
 *   };
 *   type DiscoveryResult = {
 *     projectsRoot: string;           // the directory actually scanned
 *     projects: DiscoveredProject[];  // sorted by prefix
 *     warnings: string[];             // never a throw: a missing or
 *                                     // unreadable root yields an empty
 *                                     // list plus a warning
 *   };
 *
 * Precedence for the projects root: explicit `projectsRoot` option, then the
 * `projectsRoot` key in `<cwd>/.worklog/config.yaml`, then the parent
 * directory of the checkout (its git root when `cwd` is inside a repository).
 *
 * Only immediate subdirectories holding a *genuine* store
 * (`isGenuineWorklogStore()`: `.worklog/initialized` or `.worklog/worklog.db`)
 * are discovered; hidden directories, non-git directories and worktree-shaped
 * stubs (`.worklog/config.yaml` only) are excluded. The scan is one `readdir`
 * of the projects root plus at most two `existsSync` probes per candidate —
 * no repository-wide walk.
 *
 * ## Implementation
 *
 * F2 (WL-0MVWEELAW005SDLU) creates `src/cross-repo/project-registry.ts` and
 * makes these assertions pass; the discovery blocks were RED-pinned with
 * `it(...)` while the module did not exist and are now plain `it(...)`.
 * The fixture-harness assertions were always plain `it(...)` so a broken
 * fixture could not hide behind the RED pin.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import {
  FIXTURE_PREFIXES,
  makeProjectsRoot,
  writeProjectConfig,
  type ProjectsRootFixture,
  type StoreHandle,
} from './helpers/cross-repo-fixture.js';
import { cleanupTempDir, createTempDir } from './test-utils.js';
import { isGenuineWorklogStore } from '../src/worklog-paths.js';
import { WorklogDatabase } from '../packages/shared/src/database.js';

// ── fs probe recording (AC: one readdir, two existsSync probes/candidate) ──

const fsProbe = vi.hoisted(() => {
  const log = { readdir: [] as string[], exists: [] as string[] };
  const wrap = (actual: Record<string, unknown>): Record<string, unknown> => {
    const mocked: Record<string, unknown> = { ...actual };
    mocked.readdirSync = (...args: unknown[]): unknown => {
      log.readdir.push(String(args[0]));
      return (actual.readdirSync as (...a: unknown[]) => unknown)(...args);
    };
    mocked.existsSync = (...args: unknown[]): unknown => {
      log.exists.push(String(args[0]));
      return (actual.existsSync as (...a: unknown[]) => unknown)(...args);
    };
    mocked.default = mocked;
    return mocked;
  };
  return { log, wrap };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return fsProbe.wrap(actual as unknown as Record<string, unknown>);
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return fsProbe.wrap(actual as unknown as Record<string, unknown>);
});

// ── discovery contract types (the module under test does not exist yet) ────

interface DiscoveredProject {
  prefix: string;
  path: string | null;
  ambiguous?: boolean;
  candidates?: string[];
}

interface DiscoveryResult {
  projectsRoot: string;
  projects: DiscoveredProject[];
  warnings?: string[];
}

type DiscoverProjects = (options?: { projectsRoot?: string; cwd?: string }) => DiscoveryResult;

/** Load `discoverProjects` lazily so this file loads before F2 exists. */
async function loadDiscoverProjects(): Promise<DiscoverProjects> {
  const mod = (await import('../src/cross-repo/project-registry.js')) as Record<string, unknown>;
  const discover = mod.discoverProjects;
  if (typeof discover !== 'function') {
    throw new Error('src/cross-repo/project-registry.ts must export discoverProjects()');
  }
  return discover as DiscoverProjects;
}

/** Canonical form for path comparisons (`os.tmpdir()` may be a symlink). */
function real(target: string): string {
  return fs.realpathSync(target);
}

/** Read the `prefix` a project declares in its own `config.yaml`. */
function declaredPrefix(projectDir: string): string {
  const configPath = path.join(projectDir, '.worklog', 'config.yaml');
  const config = yaml.load(fs.readFileSync(configPath, 'utf-8')) as { prefix?: string };
  return String(config?.prefix ?? '');
}

/** Sorted prefixes discovery is expected to report for the standard layout. */
const STANDARD_DISCOVERED_PREFIXES = [
  FIXTURE_PREFIXES.withTests,
  FIXTURE_PREFIXES.withoutTests,
  FIXTURE_PREFIXES.duplicate,
];

/** Prefixes the standard layout deliberately hides behind a decoy. */
const STANDARD_EXCLUDED_PREFIXES = [
  FIXTURE_PREFIXES.worktreeStub,
  FIXTURE_PREFIXES.nonGit,
  FIXTURE_PREFIXES.hidden,
];

describe('cross-repo fixture harness (F1)', () => {
  let fixture: ProjectsRootFixture;

  beforeEach(() => {
    fixture = makeProjectsRoot();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('builds two genuine sibling stores, one with tests support', () => {
    const layout = fixture.layout!;
    expect(layout).not.toBeNull();

    for (const store of [layout.withTests, layout.withoutTests]) {
      expect(isGenuineWorklogStore(store.worklogDir)).toBe(true);
      expect(fs.existsSync(path.join(store.worklogDir, 'config.yaml'))).toBe(true);
      expect(fs.existsSync(path.join(store.worklogDir, 'initialized'))).toBe(true);
      expect(fs.existsSync(store.dbPath)).toBe(true);
      expect(store.prefix).toBe(declaredPrefix(store.dir));
    }

    expect(layout.withTests.prefix).toBe(FIXTURE_PREFIXES.withTests);
    expect(layout.withoutTests.prefix).toBe(FIXTURE_PREFIXES.withoutTests);
    expect(fs.existsSync(path.join(layout.withTests.dir, 'tests'))).toBe(true);
    expect(fs.existsSync(path.join(layout.withoutTests.dir, 'tests'))).toBe(false);
  });

  it('builds decoys that a genuine-store probe must reject', () => {
    const layout = fixture.layout!;

    // Worktree-shaped stub: a real git repo whose `.worklog/` holds the
    // tracked config only — excluded because it holds no data.
    const stub = layout.worktreeStub;
    expect(fs.existsSync(path.join(stub.dir, '.worklog', 'config.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(stub.dir, '.git'))).toBe(true);
    expect(isGenuineWorklogStore(path.join(stub.dir, '.worklog'))).toBe(false);
    expect(declaredPrefix(stub.dir)).toBe(FIXTURE_PREFIXES.worktreeStub);

    // Non-git folder: a genuine store excluded by the repository rule alone.
    const nonGit = layout.nonGitFolder;
    expect(isGenuineWorklogStore(nonGit.worklogDir)).toBe(true);
    expect(fs.existsSync(path.join(nonGit.dir, '.git'))).toBe(false);
    expect(nonGit.prefix).toBe(FIXTURE_PREFIXES.nonGit);

    // Hidden folder: a genuine store excluded by the hidden-name rule alone.
    const hidden = layout.hiddenFolder;
    expect(path.basename(hidden.dir).startsWith('.')).toBe(true);
    expect(isGenuineWorklogStore(hidden.worklogDir)).toBe(true);
    expect(hidden.prefix).toBe(FIXTURE_PREFIXES.hidden);
  });

  it('builds two distinct projects declaring the same prefix', () => {
    const [first, second] = fixture.layout!.duplicates;

    expect(first.prefix).toBe(FIXTURE_PREFIXES.duplicate);
    expect(second.prefix).toBe(FIXTURE_PREFIXES.duplicate);
    expect(declaredPrefix(first.dir)).toBe(FIXTURE_PREFIXES.duplicate);
    expect(declaredPrefix(second.dir)).toBe(FIXTURE_PREFIXES.duplicate);
    expect(first.dir).not.toBe(second.dir);
    expect(first.name).not.toBe(second.name);
  });

  it('seeds real items so later children can target foreign edges', () => {
    const store: StoreHandle = fixture.addStore('SEED', {
      name: 'seeded-project',
      items: [
        { title: 'Upstream blocker', status: 'open' },
        { title: 'Upstream review', status: 'completed', stage: 'in_review' },
      ],
    });

    const db = new WorklogDatabase(
      store.prefix,
      store.dbPath,
      path.join(store.worklogDir, 'data.jsonl'),
      true,
      false,
    );
    try {
      const items = db.getAll();
      expect(items.map((item) => item.title)).toEqual([
        'Upstream blocker',
        'Upstream review',
      ]);
      expect(items.map((item) => item.status)).toEqual(['open', 'completed']);
    } finally {
      db.close();
    }

    expect(fixture.entries()).toContain('seeded-project');
  });

  it('keeps everything inside a temp tree and never in the checkout or home store', () => {
    const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
    const root = real(fixture.root);

    expect(root.startsWith(real(os.tmpdir()) + path.sep)).toBe(true);
    expect(root === repoRoot || root.startsWith(repoRoot + path.sep)).toBe(false);

    for (const entry of fixture.entries()) {
      expect(fs.existsSync(path.join(fixture.root, entry))).toBe(true);
      expect(real(path.join(fixture.root, entry)).startsWith(root + path.sep)).toBe(true);
    }
  });

  it('cleans up its temp tree and is safe to call twice', () => {
    const disposable = makeProjectsRoot();
    const disposableRoot = disposable.root;
    const root = real(disposableRoot);

    disposable.cleanup();
    expect(fs.existsSync(root)).toBe(false);
    expect(() => disposable.cleanup()).not.toThrow();
  });
});

describe('cross-repo discovery (AC1 — RED until F2)', () => {
  let fixture: ProjectsRootFixture;

  beforeEach(() => {
    fixture = makeProjectsRoot();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('discovers only genuine stores, sorted by prefix (F2)', async () => {
    const discoverProjects = await loadDiscoverProjects();
    const layout = fixture.layout!;

    const result = discoverProjects({ projectsRoot: fixture.root });

    expect(real(result.projectsRoot)).toBe(real(fixture.root));
    expect(result.projects.map((project) => project.prefix)).toEqual(
      STANDARD_DISCOVERED_PREFIXES,
    );

    const discovered = new Map(result.projects.map((p) => [p.prefix, p]));
    expect(real(discovered.get(FIXTURE_PREFIXES.withTests)!.path!)).toBe(
      real(layout.withTests.dir),
    );
    expect(real(discovered.get(FIXTURE_PREFIXES.withoutTests)!.path!)).toBe(
      real(layout.withoutTests.dir),
    );
    expect(discovered.get(FIXTURE_PREFIXES.withTests)?.ambiguous ?? false).toBe(false);
    expect(discovered.get(FIXTURE_PREFIXES.withoutTests)?.ambiguous ?? false).toBe(false);

    // The decoys must never appear — the stub holds no data, the non-git
    // folder and the hidden folder are excluded on their own rules.
    for (const excluded of STANDARD_EXCLUDED_PREFIXES) {
      expect(discovered.has(excluded)).toBe(false);
    }
  });

  it('reports a duplicate prefix as ambiguous with both paths, never guessing (F2)', async () => {
    const discoverProjects = await loadDiscoverProjects();
    const [first, second] = fixture.layout!.duplicates;

    const result = discoverProjects({ projectsRoot: fixture.root });
    const duplicates = result.projects.filter(
      (project) => project.prefix === FIXTURE_PREFIXES.duplicate,
    );

    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].ambiguous).toBe(true);
    expect(duplicates[0].path).toBeNull();
    expect((duplicates[0].candidates ?? []).map(real).sort()).toEqual(
      [real(first.dir), real(second.dir)].sort(),
    );
  });

  it('is deterministic across calls and sorted by prefix (F2)', async () => {
    const discoverProjects = await loadDiscoverProjects();

    const first = discoverProjects({ projectsRoot: fixture.root });
    const second = discoverProjects({ projectsRoot: fixture.root });

    expect(second).toEqual(first);
    const prefixes = first.projects.map((project) => project.prefix);
    expect(prefixes).toEqual([...prefixes].sort());
  });

  it('honours a projectsRoot config override on the checkout (F2)', async () => {
    const discoverProjects = await loadDiscoverProjects();
    const checkout = createTempDir();
    try {
      writeProjectConfig(checkout, {
        prefix: 'CONS',
        projectName: 'Consumer',
        projectsRoot: fixture.root,
      });

      const result = discoverProjects({ cwd: checkout });

      expect(real(result.projectsRoot)).toBe(real(fixture.root));
      expect(result.projects.map((project) => project.prefix)).toEqual(
        STANDARD_DISCOVERED_PREFIXES,
      );
    } finally {
      cleanupTempDir(checkout);
    }
  });

  it('defaults the projects root to the checkout parent (F2)', async () => {
    const discoverProjects = await loadDiscoverProjects();
    // A consumer checkout that is itself a genuine project under the root.
    // A config-only stub is never discovered (see the worktree-stub decoy),
    // so the consumer is built as a real store through the fixture.
    const consumer = fixture.addStore('CONS', { name: 'consumer-project' }).dir;

    const result = discoverProjects({ cwd: consumer });

    expect(real(result.projectsRoot)).toBe(real(fixture.root));
    expect(result.projects.map((project) => project.prefix)).toEqual(
      [...STANDARD_DISCOVERED_PREFIXES, 'CONS'].sort(),
    );
  });

  it('warns instead of throwing when the projects root is missing or unreadable (F2)', async () => {
    const discoverProjects = await loadDiscoverProjects();

    const missingRoot = path.join(fixture.root, 'does-not-exist');
    const missing = discoverProjects({ projectsRoot: missingRoot });
    expect(missing.projects).toEqual([]);
    expect((missing.warnings ?? []).length).toBeGreaterThan(0);

    // A file where a directory is expected raises ENOTDIR on `readdir` — the
    // same fail-open path, without relying on permission bits (tests may run
    // as root, where `chmod 000` is not unreadable).
    const notADirectory = path.join(fixture.layout!.withTests.worklogDir, 'config.yaml');
    const unreadable = discoverProjects({ projectsRoot: notADirectory });
    expect(unreadable.projects).toEqual([]);
    expect((unreadable.warnings ?? []).length).toBeGreaterThan(0);
  });

  it('scans with one readdir and at most two existsSync probes per candidate (F2)', async () => {
    const discoverProjects = await loadDiscoverProjects();
    const root = real(fixture.root);
    const candidates = fixture.entries().length;

    fsProbe.log.readdir.length = 0;
    fsProbe.log.exists.length = 0;

    const result = discoverProjects({ projectsRoot: fixture.root });

    expect(result.projects.map((project) => project.prefix)).toEqual(
      STANDARD_DISCOVERED_PREFIXES,
    );

    const readdirRoots = fsProbe.log.readdir.map((p) => real(p));
    const readdirOutsideRoot = readdirRoots.filter((p) => p !== root);
    expect(readdirRoots.filter((p) => p === root)).toHaveLength(1);
    expect(readdirOutsideRoot).toEqual([]);

    const probesInsideRoot = fsProbe.log.exists.filter((p) => {
      const resolved = path.resolve(p);
      return resolved === root || resolved.startsWith(root + path.sep);
    });
    expect(probesInsideRoot.length).toBeLessThanOrEqual(2 * candidates);
  });
});
