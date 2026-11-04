/**
 * tests/cross-repo-project-add.test.ts
 *
 * AC4 specification for **missing-project remediation and clone** — parent
 * WL-0MVWABT2Z001XMSD, child F7 (WL-0MVWEER72000TT6G). F8
 * (WL-0MVWEES9J0035SG6) implements `wl project add` and turns the RED pins
 * below green.
 *
 * ## The contract this file pins
 *
 * Today a dependency id whose prefix has no discovered store reports a bare
 * `Work item not found`, which an agent cannot act on. Parent design
 * constraint D4 replaces that with an actionable, machine-readable result and
 * a new `wl project add` command:
 *
 * ### 1. Unknown dependency prefix (`wl dep add`)
 *
 * `wl --json dep add <local-id> <PREFIX>-<id>` where `<PREFIX>` is not the
 * local prefix and **no** discovered project declares it exits non-zero and
 * emits:
 *
 * ```jsonc
 * {
 *   "success": false,
 *   "error_code": "unknown_project",
 *   "prefix": "GHOST",
 *   "projects_root": "<the projects root that was scanned>",
 *   "remediation": "… wl project add GHOST --git-url <url> …"
 * }
 * ```
 *
 * The `remediation` string carries the **exact** command form
 * `wl project add <PREFIX> --git-url <url>` so an agent can act on it
 * verbatim. A *same-project* missing id keeps the plain not-found payload —
 * the remediation is only for a foreign prefix (harness control below).
 *
 * Error payloads follow the CLI's existing JSON convention: `output.error`
 * writes `success: false` JSON to **stderr**, so the failure specs read
 * stdout when it holds JSON and otherwise stderr.
 *
 * ### 2. `wl project add <PREFIX> --git-url <url> [--path <path>]`
 *
 * - Clones `<url>` into the projects root (default target: a directory under
 *   the projects root; `--path` overrides it), records the mapping in the
 *   **consumer's** `.worklog/config.yaml`, and validates that the cloned
 *   `.worklog/config.yaml` declares the requested prefix.
 * - Success (`--json`):
 *
 *   ```jsonc
 *   {
 *     "success": true,
 *     "prefix": "GAMMA",
 *     "path": "<absolute path of the clone>",
 *     "gitUrl": "file:///…",
 *     "cloned": true      // false when an existing correct clone is reused
 *   }
 *   ```
 *
 * - The mapping is recorded as
 *
 *   ```yaml
 *   projects:
 *     GAMMA:
 *       path: <absolute path of the clone>
 *       gitUrl: file:///…
 *   ```
 *
 *   (the parent plan's assumption 2 — `projectsRoot` plus a `projects:` map in
 *   `.worklog/config.yaml`; no new config file).
 * - **Idempotent:** a second run against the correct clone exits 0, reports
 *   `cloned: false`, leaves the mapping unchanged and does not recreate the
 *   clone (an untracked marker written into the clone survives).
 * - **Prefix mismatch** (the clone declares another prefix) exits non-zero
 *   with `error_code: "prefix_mismatch"`, names both prefixes in the message,
 *   and leaves **no** mapping behind.
 * - **Clone failure** (an unreachable `file://` URL) exits non-zero with
 *   `error_code: "clone_failed"` and leaves **no** mapping behind.
 * - **No stdin read without `--interactive`:** a run without `--git-url`
 *   terminates deterministically (never blocks on a prompt), exits non-zero
 *   and emits `error_code: "missing_git_url"` naming `--git-url`. An explicit
 *   `--interactive` may prompt; every default path must not (agents cannot
 *   answer prompts).
 *
 * ## Fixtures
 *
 * The clone source is a **real local git repository** built by
 * `createGitOriginRepo()` (`tests/helpers/cross-repo-fixture.ts`): `git init`,
 * one commit, a tracked `.worklog/config.yaml` and a `README.md` marker that
 * proves the clone copied the repository. The URL is a `file://` URL, so the
 * spec needs no network access and no credentials (parent D4 assumption).
 *
 * The CLI under test is spawned with the **real** git binary on `PATH`
 * (`realGitPath()`): the suite's mock `git clone` only copies a local
 * directory and cannot clone a `file://` URL, so it could not exercise the
 * behaviour this spec pins.
 *
 * ## Pinning (F8 landed)
 *
 * The remediation/clone blocks were written as `it.fails(...)` while the
 * behaviour did not exist, so the suite stayed green until F8 landed. F8
 * flipped `it.fails(` to `it(`, so a regression now fails the suite instead of
 * passing as an expected failure. Every pin asserts the *feature exists* (a
 * JSON payload / `cloned` field), never just "exit non-zero and no mapping",
 * so a command that is simply absent cannot pass as an expected failure. The
 * harness controls at the bottom are plain `it(...)` so a broken fixture
 * cannot hide behind a pin.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as yaml from 'js-yaml';
import { runCliProcess } from './cli/cli-bundle.js';
import { writeInitSemaphore } from './cli/cli-helpers.js';
import { fixtureGitEnv, realGitPath } from './cli/git-helpers.js';
import { cleanupTempDir, createTempDir } from './test-utils.js';
import {
  createGitOriginRepo,
  makeProjectsRoot,
  writeProjectConfig,
  type GitOriginRepo,
  type ProjectsRootFixture,
  type SeedItem,
} from './helpers/cross-repo-fixture.js';
import { WorklogDatabase } from '../packages/shared/src/database.js';
import type { WorkItem } from '../packages/shared/src/types.js';

/** Prefix of the consumer checkout that records the mapping. */
const CONSUMER_PREFIX = 'CONS';
/** Prefix requested from `wl project add`; no fixture project declares it. */
const ADDED_PREFIX = 'GAMMA';
/** Prefix that no fixture project declares and no mapping records. */
const UNKNOWN_PREFIX = 'GHOST';

/** A consumer checkout (the local store) built for one test. */
interface Consumer {
  dir: string;
  worklogDir: string;
  dbPath: string;
  jsonlPath: string;
}

/** One captured CLI invocation. */
interface CapturedRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** The mapping a `wl project add` run records for one prefix. */
interface ProjectMapping {
  path?: string;
  gitUrl?: string;
}

/** `wl project add --json` success payload (the fields this spec asserts). */
interface ProjectAddSuccess {
  success: boolean;
  prefix?: string;
  path?: string;
  gitUrl?: string;
  cloned?: boolean;
}

/** `wl project add --json` failure payload (the fields this spec asserts). */
interface ProjectAddFailure {
  success: boolean;
  error_code?: string;
  error?: string;
}

/** `wl dep add --json` unknown-project payload. */
interface UnknownProjectPayload {
  success: boolean;
  error_code?: string;
  prefix?: string;
  projects_root?: string;
  remediation?: string;
  errors?: string[];
}

/**
 * A fresh per-invocation cache directory.
 *
 * `discoverProjects()` memoises per process and the CLI is a short-lived
 * subprocess, but the read cache lives on disk: a cold directory per
 * invocation keeps a `wl project list` capture from being served by a previous
 * test's cached payload.
 */
let cacheSequence = 0;

// ── fixture / store helpers ──────────────────────────────────────────────

/** A consumer checkout whose config points discovery at `projectsRoot`. */
function makeConsumer(projectsRoot: string): Consumer {
  const dir = createTempDir();
  writeProjectConfig(dir, {
    prefix: CONSUMER_PREFIX,
    projectName: 'Consumer',
    projectsRoot,
  });
  writeInitSemaphore(dir);
  const worklogDir = path.join(dir, '.worklog');
  return {
    dir,
    worklogDir,
    dbPath: path.join(worklogDir, 'worklog.db'),
    jsonlPath: path.join(worklogDir, 'worklog-data.jsonl'),
  };
}

/** Seed local work items (setup only) and return the persisted records. */
function seedLocalItems(consumer: Consumer, items: SeedItem[]): WorkItem[] {
  const db = new WorklogDatabase(
    CONSUMER_PREFIX,
    consumer.dbPath,
    consumer.jsonlPath,
    true,
    false,
  );
  try {
    return items.map((item) =>
      db.create({ title: item.title, status: item.status, stage: item.stage }),
    );
  } finally {
    db.close();
  }
}

/**
 * Run the real CLI in the consumer checkout.
 *
 * `PATH` is pinned to the real git binary so the `git clone` performed by the
 * command under test is a genuine clone of the `file://` origin rather than
 * the suite mock's directory copy.
 */
function run(
  consumer: Consumer,
  args: string[],
  options: { input?: string; timeout?: number } = {},
): CapturedRun {
  const result = runCliProcess(args, {
    cwd: consumer.dir,
    encoding: 'utf-8',
    timeout: options.timeout ?? 60_000,
    input: options.input,
    env: {
      ...process.env,
      NO_COLOR: '1',
      PATH: realGitPath(),
      WL_CACHE_DIR: path.join(consumer.dir, 'cache', String(cacheSequence++)),
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Parse a `--json` success invocation's stdout, asserting it is valid JSON. */
function parseJson<T = Record<string, unknown>>(captured: CapturedRun): T {
  return JSON.parse(captured.stdout) as T;
}

/**
 * Parse a `--json` **error** payload.
 *
 * The CLI's JSON error convention (`output.error`) writes the payload to
 * **stderr**, so a failure spec reads stdout when it holds JSON and falls back
 * to stderr — the same convention `tests/cli/issue-management.test.ts` uses.
 */
function parseJsonOutput<T = Record<string, unknown>>(captured: CapturedRun): T {
  const text = captured.stdout.trim() === '' ? captured.stderr : captured.stdout;
  return JSON.parse(text) as T;
}

/** Read the consumer's `.worklog/config.yaml` (empty object when absent). */
function readConsumerConfig(consumer: Consumer): Record<string, unknown> {
  const configPath = path.join(consumer.worklogDir, 'config.yaml');
  if (!fs.existsSync(configPath)) return {};
  return (yaml.load(fs.readFileSync(configPath, 'utf-8')) ?? {}) as Record<string, unknown>;
}

/** The recorded mapping for `prefix`, or `undefined` when none is recorded. */
function projectMapping(consumer: Consumer, prefix: string): ProjectMapping | undefined {
  const projects = readConsumerConfig(consumer).projects as
    | Record<string, ProjectMapping>
    | undefined;
  return projects?.[prefix];
}

/** The prefix declared by a project's `.worklog/config.yaml`. */
function readPrefix(projectDir: string): string | undefined {
  const configPath = path.join(projectDir, '.worklog', 'config.yaml');
  if (!fs.existsSync(configPath)) return undefined;
  const config = yaml.load(fs.readFileSync(configPath, 'utf-8')) as
    | { prefix?: string }
    | undefined;
  return config?.prefix;
}

/** Canonical form for path comparisons (`os.tmpdir()` may be a symlink). */
function real(target: string): string {
  return fs.realpathSync(target);
}

// ── suite ────────────────────────────────────────────────────────────────

describe('cross-repo missing-project remediation (AC4)', () => {
  const disposables: Array<() => void> = [];
  let fixture: ProjectsRootFixture | undefined;

  afterEach(() => {
    while (disposables.length > 0) {
      disposables.pop()!();
    }
    fixture?.cleanup();
    fixture = undefined;
  });

  /** A projects root + consumer checkout, with no project declaring GAMMA. */
  function setup(): Consumer {
    fixture = makeProjectsRoot({ standard: false });
    const consumer = makeConsumer(fixture.root);
    disposables.push(() => cleanupTempDir(consumer.dir));
    return consumer;
  }

  it(
    'reports an unknown dependency prefix with the exact project-add remediation (F8)',
    () => {
      const consumer = setup();
      const [dependent] = seedLocalItems(consumer, [{ title: 'Local dependent' }]);
      const unknownId = `${UNKNOWN_PREFIX}-0000000000000000`;

      const captured = run(consumer, ['--json', 'dep', 'add', dependent.id, unknownId]);

      expect(typeof captured.status).toBe('number');
      expect(captured.status).not.toBe(0);

      const payload = parseJsonOutput<UnknownProjectPayload>(captured);
      expect(payload.success).toBe(false);
      expect(payload.error_code).toBe('unknown_project');
      expect(payload.prefix).toBe(UNKNOWN_PREFIX);
      expect(real(String(payload.projects_root))).toBe(real(fixture!.root));

      // The exact command form an agent can run verbatim.
      expect(String(payload.remediation)).toContain(
        `wl project add ${UNKNOWN_PREFIX} --git-url <url>`,
      );
    },
    60_000,
  );

  it(
    'clones a file:// origin into the projects root and records the mapping (F8)',
    () => {
      const consumer = setup();
      const origin = createGitOriginRepo({ prefix: ADDED_PREFIX });
      disposables.push(() => origin.cleanup());

      const captured = run(consumer, [
        '--json',
        'project',
        'add',
        ADDED_PREFIX,
        '--git-url',
        origin.url,
      ]);
      expect(captured.status, captured.stderr).toBe(0);

      const payload = parseJson<ProjectAddSuccess>(captured);
      expect(payload.success).toBe(true);
      expect(payload.prefix).toBe(ADDED_PREFIX);
      expect(payload.gitUrl).toBe(origin.url);
      expect(payload.cloned).toBe(true);

      // The default target lives directly under the projects root (no --path
      // was supplied), and it is a git working tree.
      const clonePath = path.resolve(String(payload.path));
      expect(fs.existsSync(clonePath)).toBe(true);
      expect(real(path.dirname(clonePath))).toBe(real(fixture!.root));
      expect(fs.existsSync(path.join(clonePath, '.git'))).toBe(true);

      // It is a clone of the origin — not a fabricated directory — and the
      // cloned config.yaml declares the requested prefix (the CLI validates
      // this; the assertion re-reads the clone independently).
      expect(fs.readFileSync(path.join(clonePath, 'README.md'), 'utf-8')).toContain(
        `# ${ADDED_PREFIX} origin fixture`,
      );
      expect(readPrefix(clonePath)).toBe(ADDED_PREFIX);

      // The mapping is recorded in the consumer's project config.
      const mapping = projectMapping(consumer, ADDED_PREFIX);
      expect(mapping).toBeDefined();
      expect(real(String(mapping?.path))).toBe(real(clonePath));
      expect(mapping?.gitUrl).toBe(origin.url);
    },
    60_000,
  );

  it(
    'is idempotent: a second run clones nothing and leaves the mapping unchanged (F8)',
    () => {
      const consumer = setup();
      const origin = createGitOriginRepo({ prefix: ADDED_PREFIX });
      disposables.push(() => origin.cleanup());

      const addArgs = ['--json', 'project', 'add', ADDED_PREFIX, '--git-url', origin.url];

      const first = run(consumer, addArgs);
      expect(first.status, first.stderr).toBe(0);
      const firstPayload = parseJson<ProjectAddSuccess>(first);
      expect(firstPayload.success).toBe(true);
      expect(firstPayload.cloned).toBe(true);

      const clonePath = path.resolve(String(firstPayload.path));
      // An untracked marker inside the clone: a re-clone (or a wipe-and-clone)
      // destroys it, so its survival proves the second run was a no-op.
      const marker = path.join(clonePath, 'untracked-marker.txt');
      fs.writeFileSync(marker, 'survives a no-op re-run\n', 'utf-8');
      const mappingBefore = projectMapping(consumer, ADDED_PREFIX);
      expect(mappingBefore).toBeDefined();

      const second = run(consumer, addArgs);
      expect(second.status, second.stderr).toBe(0);

      const secondPayload = parseJson<ProjectAddSuccess>(second);
      expect(secondPayload.success).toBe(true);
      // `cloned: false` is the machine-readable "no second clone" signal.
      expect(secondPayload.cloned).toBe(false);
      expect(path.resolve(String(secondPayload.path))).toBe(clonePath);

      expect(fs.existsSync(marker)).toBe(true);
      expect(projectMapping(consumer, ADDED_PREFIX)).toEqual(mappingBefore);
    },
    90_000,
  );

  it(
    'refuses a prefix mismatch and leaves no mapping behind (F8)',
    () => {
      const consumer = setup();
      // The origin declares DELTA; the command asks for GAMMA.
      const origin = createGitOriginRepo({ prefix: 'DELTA' });
      disposables.push(() => origin.cleanup());

      const captured = run(consumer, [
        '--json',
        'project',
        'add',
        ADDED_PREFIX,
        '--git-url',
        origin.url,
      ]);

      expect(typeof captured.status).toBe('number');
      expect(captured.status).not.toBe(0);

      const payload = parseJsonOutput<ProjectAddFailure>(captured);
      expect(payload.success).toBe(false);
      expect(payload.error_code).toBe('prefix_mismatch');

      // The message names both the requested and the declared prefix so the
      // producer can fix the URL instead of guessing.
      const message = String(payload.error ?? '');
      expect(message).toContain(ADDED_PREFIX);
      expect(message).toContain('DELTA');

      // A failed validation never records a mapping (parent D4).
      expect(projectMapping(consumer, ADDED_PREFIX)).toBeUndefined();
    },
    60_000,
  );

  it(
    'refuses a failed clone and leaves no mapping behind (F8)',
    () => {
      const consumer = setup();
      const missingParent = createTempDir();
      disposables.push(() => cleanupTempDir(missingParent));
      const missingUrl = pathToFileURL(
        path.join(missingParent, 'does-not-exist'),
      ).href;

      const captured = run(consumer, [
        '--json',
        'project',
        'add',
        ADDED_PREFIX,
        '--git-url',
        missingUrl,
      ]);

      expect(typeof captured.status).toBe('number');
      expect(captured.status).not.toBe(0);

      const payload = parseJsonOutput<ProjectAddFailure>(captured);
      expect(payload.success).toBe(false);
      expect(payload.error_code).toBe('clone_failed');
      expect(String(payload.error ?? '').toLowerCase()).toContain('clone');

      // A failed clone leaves no config mapping behind (parent D4).
      expect(projectMapping(consumer, ADDED_PREFIX)).toBeUndefined();
    },
    60_000,
  );

  it(
    'never reads stdin without --interactive: a missing --git-url fails deterministically (F8)',
    () => {
      const consumer = setup();

      // stdin is closed (`input: ''`), and the explicit timeout turns a
      // blocking prompt into a hard failure (`status: null`) rather than a
      // hung suite. Agents cannot answer prompts, so this must terminate.
      const captured = run(consumer, ['--json', 'project', 'add', ADDED_PREFIX], {
        input: '',
        timeout: 15_000,
      });

      expect(typeof captured.status).toBe('number');
      expect(captured.status).not.toBe(0);

      const payload = parseJsonOutput<ProjectAddFailure>(captured);
      expect(payload.success).toBe(false);
      expect(payload.error_code).toBe('missing_git_url');
      expect(String(payload.error ?? '')).toContain('--git-url');

      expect(projectMapping(consumer, ADDED_PREFIX)).toBeUndefined();
    },
    30_000,
  );

  it(
    'reports the unknown_project remediation from `wl dep list` too (F8)',
    () => {
      const consumer = setup();
      const unknownId = `${UNKNOWN_PREFIX}-0000000000000000`;

      const captured = run(consumer, ['--json', 'dep', 'list', unknownId]);

      expect(typeof captured.status).toBe('number');
      expect(captured.status).not.toBe(0);

      const payload = parseJsonOutput<UnknownProjectPayload>(captured);
      expect(payload.success).toBe(false);
      expect(payload.error_code).toBe('unknown_project');
      expect(payload.prefix).toBe(UNKNOWN_PREFIX);
      expect(real(String(payload.projects_root))).toBe(real(fixture!.root));
      expect(String(payload.remediation)).toContain(
        `wl project add ${UNKNOWN_PREFIX} --git-url <url>`,
      );
    },
    60_000,
  );

  it(
    'honours --path: clones into the requested directory and records that path (F8)',
    () => {
      const consumer = setup();
      const origin = createGitOriginRepo({ prefix: ADDED_PREFIX });
      disposables.push(() => origin.cleanup());
      const customPath = path.join(fixture!.root, 'custom-gamma-checkout');

      const captured = run(consumer, [
        '--json',
        'project',
        'add',
        ADDED_PREFIX,
        '--git-url',
        origin.url,
        '--path',
        customPath,
      ]);
      expect(captured.status, captured.stderr).toBe(0);

      const payload = parseJson<ProjectAddSuccess>(captured);
      expect(payload.success).toBe(true);
      expect(payload.cloned).toBe(true);
      expect(real(String(payload.path))).toBe(real(customPath));
      expect(fs.existsSync(path.join(customPath, '.git'))).toBe(true);

      const mapping = projectMapping(consumer, ADDED_PREFIX);
      expect(real(String(mapping?.path))).toBe(real(customPath));
      expect(mapping?.gitUrl).toBe(origin.url);
    },
    60_000,
  );

  it(
    'prompts for the URL only with --interactive (F8)',
    () => {
      const consumer = setup();
      const origin = createGitOriginRepo({ prefix: ADDED_PREFIX });
      disposables.push(() => origin.cleanup());

      // No --git-url: the URL arrives on stdin because --interactive was
      // explicitly requested. Without the flag the previous pin proves the
      // command never reads stdin.
      const captured = run(consumer, ['--json', 'project', 'add', ADDED_PREFIX, '--interactive'], {
        input: `${origin.url}\n`,
        timeout: 60_000,
      });
      expect(captured.status, captured.stderr).toBe(0);

      const payload = parseJson<ProjectAddSuccess>(captured);
      expect(payload.success).toBe(true);
      expect(payload.cloned).toBe(true);
      expect(payload.gitUrl).toBe(origin.url);

      const mapping = projectMapping(consumer, ADDED_PREFIX);
      expect(mapping?.gitUrl).toBe(origin.url);
    },
    60_000,
  );
});

// ── always-green harness controls ─────────────────────────────────────────

describe('cross-repo project-add spec harness controls', () => {
  const disposables: Array<() => void> = [];
  let fixture: ProjectsRootFixture | undefined;

  afterEach(() => {
    while (disposables.length > 0) {
      disposables.pop()!();
    }
    fixture?.cleanup();
    fixture = undefined;
  });

  function setup(): Consumer {
    fixture = makeProjectsRoot({ standard: false });
    const consumer = makeConsumer(fixture.root);
    disposables.push(() => cleanupTempDir(consumer.dir));
    return consumer;
  }

  it('creates a real git origin repository with one commit and a tracked config.yaml', () => {
    const origin: GitOriginRepo = createGitOriginRepo({ prefix: ADDED_PREFIX });
    disposables.push(() => origin.cleanup());

    const head = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: origin.dir,
      encoding: 'utf-8',
      env: fixtureGitEnv(),
    }).trim();
    expect(head).toMatch(/^[0-9a-f]{40}$/);

    expect(origin.url.startsWith('file://')).toBe(true);
    expect(readPrefix(origin.dir)).toBe(ADDED_PREFIX);
    expect(fs.readFileSync(path.join(origin.dir, 'README.md'), 'utf-8')).toContain(
      `# ${ADDED_PREFIX} origin fixture`,
    );
  });

  it('reports the projects root and does not list the prefix before it is added', () => {
    const consumer = setup();

    const captured = run(consumer, ['--json', 'project', 'list']);
    expect(captured.status, captured.stderr).toBe(0);

    const payload = parseJson<{
      success: boolean;
      projectsRoot: string;
      projects: Array<{ prefix: string }>;
    }>(captured);
    expect(payload.success).toBe(true);
    expect(real(payload.projectsRoot)).toBe(real(fixture!.root));
    expect(payload.projects.map((project) => project.prefix)).not.toContain(ADDED_PREFIX);
    expect(payload.projects.map((project) => project.prefix)).not.toContain(UNKNOWN_PREFIX);
  });

  it('keeps the plain not-found payload for a same-project missing id', () => {
    const consumer = setup();
    const [dependent] = seedLocalItems(consumer, [{ title: 'Local dependent' }]);
    const missingLocalId = `${CONSUMER_PREFIX}-0000000000000000`;

    const captured = run(consumer, ['--json', 'dep', 'add', dependent.id, missingLocalId]);
    expect(typeof captured.status).toBe('number');
    expect(captured.status).not.toBe(0);

    const payload = parseJsonOutput<UnknownProjectPayload>(captured);
    expect(payload.success).toBe(false);
    // Remediation is only for a *foreign* prefix: a local missing id keeps the
    // existing not-found contract.
    expect(payload.error_code).toBeUndefined();
    expect(payload.errors?.join(' ')).toContain('Work item not found');
  });

  it('reads no project mapping from a consumer that never ran project add', () => {
    const consumer = setup();

    expect(projectMapping(consumer, ADDED_PREFIX)).toBeUndefined();
    expect(real(String(readConsumerConfig(consumer).projectsRoot))).toBe(
      real(fixture!.root),
    );
  });
});
