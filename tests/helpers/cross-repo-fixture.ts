/**
 * tests/helpers/cross-repo-fixture.ts — a temporary *projects root* holding
 * sibling project stores plus the decoys that must never be discovered.
 *
 * Parent: WL-0MVWABT2Z001XMSD (cross-repo dependencies) — child F1,
 * WL-0MVWEEK24000S3TW (fixture harness and discovery spec).
 *
 * `makeProjectsRoot()` builds this layout under a fresh `os.tmpdir()`
 * directory (the real checkout and any home-directory store are never
 * touched):
 *
 *   <root>/alpha-project/     genuine store, has `tests/`   → ALPHA
 *   <root>/beta-project/      genuine store, no `tests/`    → BETA
 *   <root>/stray-worktree/    `.worklog/config.yaml` only   → STUB  (excluded)
 *   <root>/not-a-repo/        genuine store, no `.git`      → NOGIT (excluded)
 *   <root>/.hidden-project/   genuine store, hidden name    → HIDE  (excluded)
 *   <root>/dup-one/           genuine store                 → DUP   (ambiguous)
 *   <root>/dup-two/           genuine store                 → DUP   (ambiguous)
 *
 * A *genuine* store is `.worklog/config.yaml` plus at least one of the
 * markers `isGenuineWorklogStore()` (`src/worklog-paths.ts`) accepts —
 * `initialized` or `worklog.db`. Every genuine store built here gets both,
 * plus a real SQLite database, so later children (F3/F5/F7) can record and
 * evaluate foreign edges against real items and hash the sibling store.
 *
 * The decoys are deliberately discriminating:
 *
 *   - `stray-worktree` is a real git repository whose `.worklog/` holds only
 *     the tracked `config.yaml` a worktree checkout materialises — it is
 *     excluded because it holds no data, not because it is not a repository;
 *   - `not-a-repo` holds a *genuine* store but has no `.git`, so it is
 *     excluded by the repository rule alone;
 *   - `.hidden-project` holds a genuine store, so it is excluded by the
 *     hidden-name rule alone.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorklogDatabase } from '../../packages/shared/src/database.js';
import type { WorkItemStatus } from '../../packages/shared/src/types.js';
import { cleanupTempDir, createTempDir } from '../test-utils.js';
import { fixtureGitEnv } from '../cli/git-helpers.js';

/** Prefixes of the standard layout; the discovery spec asserts against them. */
export const FIXTURE_PREFIXES = {
  /** Genuine store that also ships a `tests/` directory. */
  withTests: 'ALPHA',
  /** Genuine store without `tests/` support. */
  withoutTests: 'BETA',
  /** Two genuine stores declaring the same prefix. */
  duplicate: 'DUP',
  /** Worktree-shaped stub: `.worklog/config.yaml` only. */
  worktreeStub: 'STUB',
  /** Genuine store in a folder that is not a git repository. */
  nonGit: 'NOGIT',
  /** Genuine store in a hidden folder. */
  hidden: 'HIDE',
} as const;

/** A work item to seed into a fixture store (a foreign edge target, usually). */
export interface SeedItem {
  title: string;
  status?: WorkItemStatus;
  stage?: string;
}

/** Options accepted by every store builder. */
export interface StoreOptions {
  /** Directory name under the projects root (default: lower-cased prefix). */
  name?: string;
  /** Create a `tests/` directory inside the project (default: false). */
  withTests?: boolean;
  /** Work items to create in the store's database (default: none). */
  items?: SeedItem[];
  /** `projectName` written to `config.yaml` (default: `<PREFIX> Project`). */
  projectName?: string;
  /**
   * Create a git repository in the project directory (default: true).
   * `false` builds a store in a non-git folder.
   */
  git?: boolean;
}

/** A project that holds a worklog store. */
export interface StoreHandle {
  /** Directory name under the projects root. */
  name: string;
  /** Project root — the directory that holds `.worklog/`. */
  dir: string;
  /** Absolute path of the `.worklog` directory. */
  worklogDir: string;
  /** Absolute path of the store's SQLite database. */
  dbPath: string;
  /** Prefix declared in the store's `config.yaml`. */
  prefix: string;
}

/** A directory that is not a project store. */
export interface FolderHandle {
  name: string;
  dir: string;
}

/** Handles to the standard layout, built by `makeProjectsRoot()`. */
export interface StandardLayout {
  withTests: StoreHandle;
  withoutTests: StoreHandle;
  worktreeStub: FolderHandle;
  nonGitFolder: StoreHandle;
  hiddenFolder: StoreHandle;
  /** The two stores that both declare `FIXTURE_PREFIXES.duplicate`. */
  duplicates: [StoreHandle, StoreHandle];
}

/** The fixture returned by `makeProjectsRoot()`. */
export interface ProjectsRootFixture {
  /** Absolute path of the temporary projects root. */
  root: string;
  /** The standard layout, or `null` when `standard: false` was requested. */
  layout: StandardLayout | null;
  /** Add a genuine (data-holding) store to the projects root. */
  addStore(prefix: string, options?: StoreOptions): StoreHandle;
  /** Add a worktree-shaped stub: `.worklog/config.yaml` only, no data. */
  addWorktreeStub(options?: { name?: string; prefix?: string }): FolderHandle;
  /** Add a genuine store in a folder that is not a git repository. */
  addNonGitFolder(options?: { name?: string; prefix?: string }): StoreHandle;
  /** Add a genuine store under a hidden (dot-prefixed) folder. */
  addHiddenFolder(options?: { name?: string; prefix?: string }): StoreHandle;
  /** Add two genuine stores that both declare `prefix`. */
  addDuplicatePrefix(prefix?: string): [StoreHandle, StoreHandle];
  /** Names of the immediate entries this fixture created (creation order). */
  entries(): string[];
  /** Delete the temporary tree. Idempotent; only root it created itself. */
  cleanup(): void;
}

/** Options for `writeProjectConfig()`. */
export interface ProjectConfigOptions {
  prefix: string;
  projectName?: string;
  /** `projectsRoot` override written to the project's `config.yaml`. */
  projectsRoot?: string;
  /** Create a git repository (default: true). */
  git?: boolean;
}

/**
 * Write a project's `.worklog/config.yaml` (and optionally `git init` it).
 *
 * Exported so a spec can build a *consumer checkout* that declares a
 * `projectsRoot` override without duplicating the config shape.
 *
 * @returns The project directory.
 */
export function writeProjectConfig(
  projectDir: string,
  options: ProjectConfigOptions,
): string {
  const worklogDir = path.join(projectDir, '.worklog');
  fs.mkdirSync(worklogDir, { recursive: true });
  const lines = [
    `projectName: ${options.projectName ?? `${options.prefix} Project`}`,
    `prefix: ${options.prefix}`,
  ];
  if (options.projectsRoot !== undefined) {
    lines.push(`projectsRoot: "${options.projectsRoot}"`);
  }
  fs.writeFileSync(path.join(worklogDir, 'config.yaml'), `${lines.join('\n')}\n`, 'utf-8');
  if (options.git !== false) {
    initialiseGitRepo(projectDir);
  }
  return projectDir;
}

// ── git origin fixture (F7 — clone remediation) ─────────────────────────

/** Options for {@link createGitOriginRepo}. */
export interface GitOriginOptions {
  /** Prefix declared in the origin's `.worklog/config.yaml` (default: `GAMMA`). */
  prefix?: string;
}

/** A real, local git repository usable as a `git clone` source. */
export interface GitOriginRepo {
  /** Working tree of the origin repository. */
  dir: string;
  /** `file://` URL suitable for `git clone` — never touches the network. */
  url: string;
  /** Prefix declared in the origin's `.worklog/config.yaml`. */
  prefix: string;
  /** Remove the origin (idempotent). */
  cleanup(): void;
}

/**
 * Build a **real** git repository to clone from — `git init`, one commit, a
 * tracked `.worklog/config.yaml` declaring `prefix`, and a `README.md` marker
 * that proves a later clone actually copied the repository.
 *
 * The URL is a `file://` URL, so the spec needs no network access and no git
 * credentials (parent D4 assumption). The fixture git environment is scrubbed
 * through the shared `fixtureGitEnv()` helper so the suite's mock `git` on
 * `PATH` (whose `clone` only copies a local directory) cannot silently stand
 * in for the real binary while the origin is being built.
 *
 * The origin is deliberately **not** a genuine worklog store (it has no
 * `initialized` marker and no database): a real project repository tracks
 * only `.worklog/config.yaml`, which is exactly what the clone-prefix
 * validation in `wl project add` must read.
 */
export function createGitOriginRepo(options: GitOriginOptions = {}): GitOriginRepo {
  const prefix = (options.prefix ?? 'GAMMA').toUpperCase();
  const parentDir = createTempDir();

  const dir = path.join(parentDir, `${prefix.toLowerCase()}-origin`);
  fs.mkdirSync(dir, { recursive: true });

  writeProjectConfig(dir, {
    prefix,
    projectName: `${prefix} Origin`,
    git: false,
  });
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${prefix} origin fixture\n`, 'utf-8');

  commitOriginRepo(dir, `${prefix} origin fixture`);

  let cleaned = false;
  return {
    dir,
    url: pathToFileURL(dir).href,
    prefix,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      cleanupTempDir(parentDir);
    },
  };
}

/**
 * `git init` + one commit in `dir`, using the real git binary and a scrubbed
 * environment so an inherited `GIT_*` override can never redirect the commit.
 */
function commitOriginRepo(dir: string, message: string): void {
  const env = fixtureGitEnv();
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', env });
  };
  git(['-c', 'init.defaultBranch=main', 'init', '--quiet']);
  git(['add', '-A', '-f']);
  git([
    '-c',
    'user.name=Worklog Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    message,
  ]);
}

/** Options for `makeProjectsRoot()`. */
export interface MakeProjectsRootOptions {
  /** Build in `root` instead of a fresh temp dir (default: fresh temp dir). */
  root?: string;
  /** Build the standard layout (default: true). */
  standard?: boolean;
}

/**
 * Build a projects root. By default it contains the full standard layout
 * documented at the top of this file.
 */
export function makeProjectsRoot(
  options: MakeProjectsRootOptions = {},
): ProjectsRootFixture {
  const ownsRoot = options.root === undefined;
  const root = options.root ?? createTempDir();
  fs.mkdirSync(root, { recursive: true });

  const created: string[] = [];
  const track = <T extends { name: string }>(handle: T): T => {
    created.push(handle.name);
    return handle;
  };

  const layout: StandardLayout | null =
    options.standard === false
      ? null
      : {
          withTests: track(
            createStore(root, FIXTURE_PREFIXES.withTests, {
              name: 'alpha-project',
              withTests: true,
            }),
          ),
          withoutTests: track(
            createStore(root, FIXTURE_PREFIXES.withoutTests, { name: 'beta-project' }),
          ),
          worktreeStub: track(createWorktreeStub(root)),
          nonGitFolder: track(createNonGitStore(root)),
          hiddenFolder: track(createHiddenStore(root)),
          duplicates: createDuplicatePair(root, FIXTURE_PREFIXES.duplicate).map((store) =>
            track(store),
          ) as [StoreHandle, StoreHandle],
        };

  let cleaned = false;

  return {
    root,
    layout,
    addStore(prefix, storeOptions = {}) {
      return track(createStore(root, prefix, storeOptions));
    },
    addWorktreeStub(stubOptions = {}) {
      return track(createWorktreeStub(root, stubOptions));
    },
    addNonGitFolder(folderOptions = {}) {
      return track(createNonGitStore(root, folderOptions));
    },
    addHiddenFolder(folderOptions = {}) {
      return track(createHiddenStore(root, folderOptions));
    },
    addDuplicatePrefix(prefix = FIXTURE_PREFIXES.duplicate) {
      return createDuplicatePair(root, prefix).map((store) => track(store)) as [
        StoreHandle,
        StoreHandle,
      ];
    },
    entries() {
      return [...created];
    },
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      if (ownsRoot) {
        cleanupTempDir(root);
      }
    },
  };
}

// ── internals ───────────────────────────────────────────────────────────

/** Create a genuine store: config, `initialized` semaphore and real database. */
function createStore(root: string, prefix: string, options: StoreOptions = {}): StoreHandle {
  const name = options.name ?? prefix.toLowerCase();
  const dir = path.join(root, name);
  const worklogDir = path.join(dir, '.worklog');

  writeProjectConfig(dir, {
    prefix,
    projectName: options.projectName,
    git: options.git,
  });
  fs.writeFileSync(
    path.join(worklogDir, 'initialized'),
    JSON.stringify({ version: 'test-fixture', initializedAt: '2026-01-01T00:00:00.000Z' }),
    'utf-8',
  );
  if (options.withTests) {
    fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  }

  seedStore(prefix, worklogDir, options.items ?? []);

  return { name, dir, worklogDir, dbPath: path.join(worklogDir, 'worklog.db'), prefix };
}

/** Create the store's SQLite database (empty or seeded) and close it cleanly. */
function seedStore(prefix: string, worklogDir: string, items: SeedItem[]): void {
  const dbPath = path.join(worklogDir, 'worklog.db');
  const db = new WorklogDatabase(
    prefix,
    dbPath,
    path.join(worklogDir, 'data.jsonl'),
    true,
    false,
  );
  try {
    for (const item of items) {
      db.create({ title: item.title, status: item.status, stage: item.stage });
    }
  } finally {
    db.close();
  }
  removeTransientSqliteFiles(worklogDir);
}

/**
 * Remove SQLite sidecars (`-wal`, `-shm`) and the JSONL lock file so the store
 * directory is deterministic: later children (F3) snapshot the sibling
 * `.worklog/` before/after a foreign edge and would otherwise see fixture
 * leftovers rather than what the code under test created.
 */
function removeTransientSqliteFiles(worklogDir: string): void {
  for (const transient of ['worklog.db-wal', 'worklog.db-shm', '.lock']) {
    fs.rmSync(path.join(worklogDir, transient), { force: true });
  }
}

/** A git repository holding only the tracked `.worklog/config.yaml`. */
function createWorktreeStub(
  root: string,
  options: { name?: string; prefix?: string } = {},
): FolderHandle {
  const name = options.name ?? 'stray-worktree';
  const prefix = options.prefix ?? FIXTURE_PREFIXES.worktreeStub;
  const dir = path.join(root, name);
  writeProjectConfig(dir, { prefix, projectName: `${prefix} Stray Worktree` });
  return { name, dir };
}

/** A genuine store in a directory that is not a git repository. */
function createNonGitStore(
  root: string,
  options: { name?: string; prefix?: string } = {},
): StoreHandle {
  return createStore(root, options.prefix ?? FIXTURE_PREFIXES.nonGit, {
    name: options.name ?? 'not-a-repo',
    git: false,
  });
}

/** A genuine store in a hidden (dot-prefixed) directory. */
function createHiddenStore(
  root: string,
  options: { name?: string; prefix?: string } = {},
): StoreHandle {
  return createStore(root, options.prefix ?? FIXTURE_PREFIXES.hidden, {
    name: options.name ?? '.hidden-project',
  });
}

/** Two genuine stores that both declare `prefix`. */
function createDuplicatePair(root: string, prefix: string): [StoreHandle, StoreHandle] {
  const slug = prefix.toLowerCase();
  return [
    createStore(root, prefix, { name: `${slug}-one`, projectName: `${prefix} One` }),
    createStore(root, prefix, { name: `${slug}-two`, projectName: `${prefix} Two` }),
  ];
}

/** `git init` a project directory, falling back to a bare `.git` marker. */
function initialiseGitRepo(dir: string): void {
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'ignore' });
  } catch {
    // git is unavailable — discovery only needs the repository marker.
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  }
}
