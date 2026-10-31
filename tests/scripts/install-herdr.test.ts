import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

// The exact keybinding block scripts/install-herdr.sh must insert.
const KEYBINDING_BLOCK = `[[keys.command]]
key = "prefix+l"
command = "herdr plugin action invoke worklog-selection-list.open-worklog-tab"
description = "Open the Worklog tab (Worklog work item selection pane)."
`;

// Marker the script uses for its existence check.
const COMMAND_MARKER = 'worklog-selection-list.open-worklog-tab';

// Legacy bindings that prefix+l previously pointed at; install-herdr.sh
// migrates each in-place to the new action (never duplicates the key):
//   - open-worklist: the original v0.1.x action
//   - open-podcast-editor-tab: the intermediate (misnamed) action
const LEGACY_BINDING = 'herdr plugin action invoke worklog-selection-list.open-worklist';
const LEGACY_PODCAST_BINDING = 'herdr plugin action invoke worklog-selection-list.open-podcast-editor-tab';

// ── Hermetic script subprocess environment (WL-0MVWL88MO002SQ2B) ──────────
//
// These tests spawn bash + scripts/install-herdr.sh, whose step 0 installs
// packages/herdr's dependencies (`npm ci`). A real install is both slow under
// load and destructive to the tree it runs in: npm deletes node_modules
// before reinstalling. Running the suite from a linked worktree used to point
// that install at the SHARED main checkout (WL-0MVWJ4IKT005SAHT, now skipped
// for worktree builds) and, under concurrent host load, blew vitest's 30 s
// default `testTimeout` — the flake this file's migration test reported
// ("Test timed out in 30000ms" at load average 30-43; green on a fresh rerun).
//
// These tests verify keybinding migration, plugin linking and config reload —
// never the dependency install — so a hermetic `npm`/`node` stub keeps them
// fast, side-effect free and independent of the checkout they run in: no real
// install, no `link-shared.mjs` rewrite of the executing checkout. The npm
// stub records its invocations so a test can prove the install is intercepted.
const SCRIPT_TEST_TIMEOUT_MS = 60_000;

let scriptStubDirCache: string | undefined;

function scriptStubDir(): string {
  if (scriptStubDirCache) return scriptStubDirCache;
  const dir = makeTempDir('worklog-herdr-stub-');
  const logPath = path.join(dir, 'npm-invocations.log');
  const stubs: Record<string, string> = {
    npm: `#!/usr/bin/env bash\necho "npm $*" >> "${logPath}"\nexit 0\n`,
    node: '#!/usr/bin/env bash\nexit 0\n',
  };
  for (const [name, body] of Object.entries(stubs)) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, body);
    fs.chmodSync(file, 0o755);
  }
  scriptStubDirCache = dir;
  return dir;
}

/** Invocations recorded by the hermetic npm stub, oldest first. */
function npmInvocations(): string[] {
  const logPath = path.join(scriptStubDir(), 'npm-invocations.log');
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
}

/**
 * `it` with the explicit subprocess budget these tests need. Every test here
 * spawns bash + scripts/install-herdr.sh (and several spawn real `git`), so
 * each gets the 60 s window vitest.config.ts prescribes for subprocess tests
 * (45-60 s): a safety net under concurrent host load, on top of the hermetic
 * stubs above (WL-0MVWL88MO002SQ2B).
 */
function itScript(name: string, fn: () => void): void {
  it(name, fn, SCRIPT_TEST_TIMEOUT_MS);
}

function runScript(env: Record<string, string>): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const scriptPath = path.join(repoRoot, 'scripts', 'install-herdr.sh');
  const result = spawnSync('bash', [scriptPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      // Keep PATH minimal so `herdr` is deterministically absent (the
      // plugin-link path is not stubbed in these tests), and put the hermetic
      // npm/node stubs first so the dependency-install step never touches a
      // real install or the executing checkout (WL-0MVWL88MO002SQ2B).
      PATH: `${scriptStubDir()}${path.delimiter}/usr/bin:/bin`,
      ...env,
    },
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function countOccurrences(content: string, needle: string): number {
  return content.split(needle).length - 1;
}

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Run a git command, asserting success. Identity and HOME are pinned so the
 * temp repo is fully hermetic (no dependency on the developer's global git
 * config). `gitBin` is the REAL git binary — see {@link realGitBin}.
 */
function git(gitBin: string, args: string[], cwd: string, tempHome: string) {
  const result = spawnSync(gitBin, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: tempHome },
  });
  expect(result.status, `git ${args.join(' ')} failed: ${result.stderr}`).toBe(0);
  return result;
}

/**
 * The vitest setup (tests/setup-tests.ts) prepends tests/cli/mock-bin to
 * PATH, which ships a git mock that does NOT implement `worktree list`.
 * The worktree-scenario test needs REAL git worktree mechanics, so resolve
 * the real git binary by searching PATH with the mock-bin entries removed.
 */
function realGitBin(): string {
  const mockBinDir = path.resolve(__dirname, '..', 'cli', 'mock-bin');
  const candidates = (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter((dir) => dir !== '' && path.resolve(dir) !== mockBinDir);
  for (const dir of candidates) {
    const candidate = path.join(dir, 'git');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error('real git binary not found on PATH (needed for worktree-scenario test)');
}

describe('install-herdr script', () => {
  itScript('inserts the keybinding block exactly once when run twice (idempotent)', () => {
    const tempDir = makeTempDir('worklog-herdr-idempotent-');
    const configPath = path.join(tempDir, 'config.toml');

    const first = runScript({ HERDR_CONFIG_PATH: configPath });
    expect(first.status).toBe(0);
    const afterFirst = fs.readFileSync(configPath, 'utf8');
    expect(countOccurrences(afterFirst, COMMAND_MARKER)).toBe(1);
    expect(afterFirst).toBe(KEYBINDING_BLOCK);

    const second = runScript({ HERDR_CONFIG_PATH: configPath });
    expect(second.status).toBe(0);
    const afterSecond = fs.readFileSync(configPath, 'utf8');
    expect(countOccurrences(afterSecond, COMMAND_MARKER)).toBe(1);
    expect(countOccurrences(afterSecond, '[[keys.command]]')).toBe(1);
    expect(afterSecond).toBe(KEYBINDING_BLOCK);
  });

  itScript('creates the parent directory and file when the config path does not exist', () => {
    const tempDir = makeTempDir('worklog-herdr-missing-');
    const configPath = path.join(tempDir, 'herdr', 'config.toml');

    const result = runScript({ HERDR_CONFIG_PATH: configPath });
    expect(result.status).toBe(0);
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(KEYBINDING_BLOCK);
  });

  itScript('skips insertion when the config already contains the binding', () => {
    const tempDir = makeTempDir('worklog-herdr-existing-');
    const configPath = path.join(tempDir, 'config.toml');
    const original = '# hand-edited config\n' + KEYBINDING_BLOCK;
    fs.writeFileSync(configPath, original);

    const result = runScript({ HERDR_CONFIG_PATH: configPath });
    expect(result.status).toBe(0);
    const content = fs.readFileSync(configPath, 'utf8');
    expect(content).toBe(original); // untouched — no duplicates, no other edits
    expect(countOccurrences(content, COMMAND_MARKER)).toBe(1);
  });

  itScript('honours HERDR_CONFIG_PATH and leaves the default config untouched', () => {
    const tempHome = makeTempDir('worklog-herdr-home-');
    const overridePath = path.join(tempHome, 'override.toml');

    const result = runScript({ HOME: tempHome, HERDR_CONFIG_PATH: overridePath });
    expect(result.status).toBe(0);
    expect(fs.existsSync(overridePath)).toBe(true);
    expect(fs.readFileSync(overridePath, 'utf8')).toBe(KEYBINDING_BLOCK);
    expect(fs.existsSync(path.join(tempHome, '.config', 'herdr', 'config.toml'))).toBe(false);
  });

  itScript('warns and exits 0 when herdr is not on PATH, still inserting the binding', () => {
    const tempDir = makeTempDir('worklog-herdr-noherdr-');
    const configPath = path.join(tempDir, 'config.toml');

    const result = runScript({ HERDR_CONFIG_PATH: configPath });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('herdr');
    expect(result.stderr.toLowerCase()).toContain('warn');
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(KEYBINDING_BLOCK);
  });

  itScript('warns and exits 0 when the config directory cannot be written', () => {
    const tempDir = makeTempDir('worklog-herdr-readonly-');
    fs.chmodSync(tempDir, 0o555);
    const configPath = path.join(tempDir, 'config.toml');

    try {
      const result = runScript({ HERDR_CONFIG_PATH: configPath });
      expect(result.status).toBe(0);
      expect(result.stderr.toLowerCase()).toContain('warn');
      expect(fs.existsSync(configPath)).toBe(false);
    } finally {
      fs.chmodSync(tempDir, 0o755);
    }
  });

  itScript('appends the block on a fresh line when the existing config lacks a trailing newline', () => {
    const tempDir = makeTempDir('worklog-herdr-newline-');
    const configPath = path.join(tempDir, 'config.toml');
    fs.writeFileSync(configPath, 'existing = true'); // no trailing newline

    const result = runScript({ HERDR_CONFIG_PATH: configPath });
    expect(result.status).toBe(0);
    const content = fs.readFileSync(configPath, 'utf8');
    expect(content).toBe('existing = true\n' + KEYBINDING_BLOCK);
    expect(countOccurrences(content, COMMAND_MARKER)).toBe(1);
  });

  itScript('migrates a legacy open-worklist binding in-place to the new action', () => {
    const tempDir = makeTempDir('worklog-herdr-migrate-');
    const configPath = path.join(tempDir, 'config.toml');
    const legacyBlock = `[[keys.command]]\nkey = "prefix+l"\ncommand = "${LEGACY_BINDING}"\ndescription = "Open the Worklog work item selection pane in a new tab."\n`;
    fs.writeFileSync(configPath, legacyBlock);

    const result = runScript({ HERDR_CONFIG_PATH: configPath });
    expect(result.status).toBe(0);
    const content = fs.readFileSync(configPath, 'utf8');
    // Legacy command replaced in-place; no duplicate keybinding inserted.
    expect(countOccurrences(content, LEGACY_BINDING)).toBe(0);
    expect(countOccurrences(content, COMMAND_MARKER)).toBe(1);
    expect(countOccurrences(content, '[[keys.command]]')).toBe(1);
    expect(content).toContain('command = "herdr plugin action invoke ' + COMMAND_MARKER + '"');
  });

  itScript('migrates a legacy open-podcast-editor-tab binding in-place to the new action', () => {
    const tempDir = makeTempDir('worklog-herdr-migrate-podcast-');
    const configPath = path.join(tempDir, 'config.toml');
    const legacyBlock = `[[keys.command]]\nkey = "prefix+l"\ncommand = "${LEGACY_PODCAST_BINDING}"\ndescription = "Open the Podcast Editing tab (Worklog work item selection pane)."\n`;
    fs.writeFileSync(configPath, legacyBlock);

    const result = runScript({ HERDR_CONFIG_PATH: configPath });
    expect(result.status).toBe(0);
    const content = fs.readFileSync(configPath, 'utf8');
    // Intermediate misnamed action replaced in-place; no duplicate keybinding.
    expect(countOccurrences(content, LEGACY_PODCAST_BINDING)).toBe(0);
    expect(countOccurrences(content, COMMAND_MARKER)).toBe(1);
    expect(countOccurrences(content, '[[keys.command]]')).toBe(1);
    expect(content).toContain('command = "herdr plugin action invoke ' + COMMAND_MARKER + '"');
    // The stale "Podcast Editing" description is normalised too.
    expect(content).not.toContain('Podcast Editing');
    expect(content).toContain('description = "Open the Worklog tab (Worklog work item selection pane)."');
  });

  itScript('removes a stale legacy open-podcast-editor-tab binding when the new binding is already present', () => {
    // WL-0MSRG4828007ITI4: an earlier installer could add the new binding
    // while a legacy prefix+l binding was still present, because the
    // "already present" fast path exited before the legacy migration ran.
    // That left two prefix+l bindings, one pointing at the removed
    // open-podcast-editor-tab action. Re-running the installer must purge
    // the stale legacy block so exactly one prefix+l binding remains.
    const tempDir = makeTempDir('worklog-herdr-dedupe-podcast-');
    const configPath = path.join(tempDir, 'config.toml');
    const legacyBlock = `[[keys.command]]\nkey = "prefix+l"\ncommand = "${LEGACY_PODCAST_BINDING}"\ndescription = "Open the Worklog tab (Worklog work item selection pane)."\n`;
    fs.writeFileSync(configPath, KEYBINDING_BLOCK + '\n' + legacyBlock);

    const result = runScript({ HERDR_CONFIG_PATH: configPath });
    expect(result.status).toBe(0);
    const content = fs.readFileSync(configPath, 'utf8');
    expect(countOccurrences(content, LEGACY_PODCAST_BINDING)).toBe(0);
    expect(countOccurrences(content, COMMAND_MARKER)).toBe(1);
    expect(countOccurrences(content, '[[keys.command]]')).toBe(1);
    expect(content).not.toContain('Podcast Editing');
  });

  itScript('removes a stale legacy open-worklist binding when the new binding is already present', () => {
    const tempDir = makeTempDir('worklog-herdr-dedupe-worklist-');
    const configPath = path.join(tempDir, 'config.toml');
    const legacyBlock = `[[keys.command]]\nkey = "prefix+l"\ncommand = "${LEGACY_BINDING}"\ndescription = "Open the Worklog work item selection pane in a new tab."\n`;
    fs.writeFileSync(configPath, KEYBINDING_BLOCK + '\n' + legacyBlock);

    const result = runScript({ HERDR_CONFIG_PATH: configPath });
    expect(result.status).toBe(0);
    const content = fs.readFileSync(configPath, 'utf8');
    expect(countOccurrences(content, LEGACY_BINDING)).toBe(0);
    expect(countOccurrences(content, COMMAND_MARKER)).toBe(1);
    expect(countOccurrences(content, '[[keys.command]]')).toBe(1);
  });

  itScript('preserves unrelated keybindings when purging a stale legacy binding', () => {
    const tempDir = makeTempDir('worklog-herdr-dedupe-preserve-');
    const configPath = path.join(tempDir, 'config.toml');
    const otherBlock = `[[keys.command]]\nkey = "prefix+n"\ncommand = "herdr plugin action invoke herdr-notes.new-note"\ndescription = "New note."\n`;
    const legacyBlock = `[[keys.command]]\nkey = "prefix+l"\ncommand = "${LEGACY_PODCAST_BINDING}"\ndescription = "Open the Worklog tab (Worklog work item selection pane)."\n`;
    fs.writeFileSync(configPath, otherBlock + KEYBINDING_BLOCK + '\n' + legacyBlock);

    const result = runScript({ HERDR_CONFIG_PATH: configPath });
    expect(result.status).toBe(0);
    const content = fs.readFileSync(configPath, 'utf8');
    // The unrelated herdr-notes keybinding must survive the purge untouched.
    expect(content).toContain('prefix+n');
    expect(content).toContain('herdr-notes.new-note');
    expect(content).toContain('New note.');
    expect(countOccurrences(content, LEGACY_PODCAST_BINDING)).toBe(0);
    expect(countOccurrences(content, '[[keys.command]]')).toBe(2);
  });

  itScript('links the plugin from the main checkout when run inside a linked worktree', () => {
    // Reproduce the /skill:implement build: the postbuild hook runs
    // scripts/install-herdr.sh from a linked git worktree. The script must
    // register the global herdr plugin from the MAIN checkout, never the
    // worktree — a worktree-based link dangles once implement.py finish
    // deletes the worktree (WL-0MSRG481O007QVEA), silently breaking the
    // prefix+l keybinding.
    const tempBase = makeTempDir('worklog-herdr-wt-');
    const repoDir = path.join(tempBase, 'repo');
    const wtDir = path.join(tempBase, 'worktree');
    fs.mkdirSync(path.join(repoDir, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'packages', 'herdr'), { recursive: true });

    // Minimal repo layout mirroring this repository: the script plus the
    // plugin manifest it links.
    const repoRoot = path.resolve(__dirname, '..', '..');
    fs.writeFileSync(
      path.join(repoDir, 'scripts', 'install-herdr.sh'),
      fs.readFileSync(path.join(repoRoot, 'scripts', 'install-herdr.sh'), 'utf8'),
    );
    fs.writeFileSync(
      path.join(repoDir, 'packages', 'herdr', 'herdr-plugin.toml'),
      'id = "worklog-selection-list"\n',
    );

    const gitBin = realGitBin();
    git(gitBin, ['init', '-q', repoDir], tempBase, tempBase);
    git(gitBin, ['-C', repoDir, 'config', 'user.email', 'test@example.com'], tempBase, tempBase);
    git(gitBin, ['-C', repoDir, 'config', 'user.name', 'Worklog Test'], tempBase, tempBase);
    git(gitBin, ['-C', repoDir, 'add', '-A'], tempBase, tempBase);
    git(gitBin, ['-C', repoDir, 'commit', '-q', '-m', 'init'], tempBase, tempBase);
    git(gitBin, ['-C', repoDir, 'worktree', 'add', '--detach', wtDir, 'HEAD'], tempBase, tempBase);

    // Fake herdr CLI that records the manifest path it is asked to link.
    const fakeBinDir = path.join(tempBase, 'bin');
    fs.mkdirSync(fakeBinDir);
    const linkLog = path.join(tempBase, 'herdr-link.log');
    fs.writeFileSync(
      path.join(fakeBinDir, 'herdr'),
      '#!/usr/bin/env bash\necho "$@" >> "' + linkLog + '"\nexit 0\n',
    );
    fs.chmodSync(path.join(fakeBinDir, 'herdr'), 0o755);

    // The script must see the REAL git (not the test-suite mock, which does
    // not implement `worktree list`) so its main-checkout resolution runs
    // against genuine worktree metadata. Build a PATH that has the fake
    // herdr first, then the real git's directory, with mock-bin removed.
    const realGitDir = path.dirname(gitBin);
    const mockBinDir = path.resolve(__dirname, '..', 'cli', 'mock-bin');
    const cleanPath = (process.env.PATH ?? '')
      .split(path.delimiter)
      .filter((dir) => dir !== '' && path.resolve(dir) !== mockBinDir);
    const scriptPath = `${fakeBinDir}${path.delimiter}${realGitDir}${path.delimiter}${cleanPath.join(path.delimiter)}`;

    const configPath = path.join(tempBase, 'herdr', 'config.toml');
    const result = spawnSync('bash', [path.join(wtDir, 'scripts', 'install-herdr.sh')], {
      cwd: wtDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: scriptPath,
        HERDR_CONFIG_PATH: configPath,
      },
    });
    expect(result.status, `script failed: ${result.stderr}`).toBe(0);

    // The fake herdr must have been asked to link the MAIN checkout's
    // manifest — never the worktree's (the worktree may be deleted at any
    // time, which is exactly the regression this guards against).
    const log = fs.readFileSync(linkLog, 'utf8').trim();
    const expectedManifest = path.join(repoDir, 'packages', 'herdr', 'herdr-plugin.toml');
    expect(log).toContain(expectedManifest);
    expect(log).not.toContain(wtDir);
  });

  itScript('skips the dependency install in a linked worktree, leaving the @worklog/shared link live', () => {
    // WL-0MVWJ4IKT005SAHT AC1+AC3: the /skill:implement build runs
    // install-herdr.sh from a linked worktree. The script must NOT run
    // `npm ci` there — the worktree's node_modules is symlinked to the main
    // checkout's, so an install would delete the shared tree and replace
    // the @worklog/shared workspace link with an empty real directory (the
    // reported bug: 113 failing CLI tests whose only error was empty
    // stdout). A worktree build reuses the main checkout's installed
    // dependencies, and the link must still resolve to the live workspace
    // package afterwards.
    const tempBase = makeTempDir('worklog-herdr-wt-skip-');
    try {
      const repoDir = path.join(tempBase, 'repo');
      const wtDir = path.join(tempBase, 'worktree');
      const repoRoot = path.resolve(__dirname, '..', '..');

      // Minimal repo mirroring this repository: installer, herdr package
      // with the real link-shared.mjs, and a shared workspace package.
      const herdrDir = path.join(repoDir, 'packages', 'herdr');
      fs.mkdirSync(path.join(repoDir, 'scripts'), { recursive: true });
      fs.mkdirSync(path.join(herdrDir, 'scripts'), { recursive: true });
      fs.mkdirSync(path.join(repoDir, 'packages', 'shared', 'dist'), { recursive: true });
      fs.copyFileSync(
        path.join(repoRoot, 'scripts', 'install-herdr.sh'),
        path.join(repoDir, 'scripts', 'install-herdr.sh'),
      );
      fs.copyFileSync(
        path.join(repoRoot, 'packages', 'herdr', 'scripts', 'link-shared.mjs'),
        path.join(herdrDir, 'scripts', 'link-shared.mjs'),
      );
      fs.writeFileSync(
        path.join(herdrDir, 'package.json'),
        JSON.stringify({ name: '@worklog/herdr-plugin', version: '0.1.0', private: true }),
      );
      // A lockfile means the installer would choose `npm ci` were it to run.
      fs.writeFileSync(
        path.join(herdrDir, 'package-lock.json'),
        JSON.stringify({ lockfileVersion: 3 }),
      );
      fs.writeFileSync(path.join(herdrDir, 'herdr-plugin.toml'), 'id = "worklog-selection-list"\n');
      fs.writeFileSync(
        path.join(repoDir, 'packages', 'shared', 'package.json'),
        JSON.stringify({ name: '@worklog/shared', version: '1.0.0' }),
      );
      fs.writeFileSync(
        path.join(repoDir, 'packages', 'shared', 'dist', 'icons.js'),
        'export const statusIcon = () => "live";\n',
      );
      // node_modules is gitignored in the real repo; keep the fixture hermetic.
      fs.writeFileSync(path.join(repoDir, '.gitignore'), 'node_modules/\n');

      const gitBin = realGitBin();
      git(gitBin, ['init', '-q', repoDir], tempBase, tempBase);
      git(gitBin, ['-C', repoDir, 'config', 'user.email', 'test@example.com'], tempBase, tempBase);
      git(gitBin, ['-C', repoDir, 'config', 'user.name', 'Worklog Test'], tempBase, tempBase);
      git(gitBin, ['-C', repoDir, 'add', '-A'], tempBase, tempBase);
      git(gitBin, ['-C', repoDir, 'commit', '-q', '-m', 'init'], tempBase, tempBase);

      // The MAIN checkout's @worklog/shared link is WIPED — an empty real
      // directory, exactly the state a concurrent/unfixed `npm ci` leaves
      // (the reported bug). The worktree build must NOT run the install and
      // must leave the link resolving to the live workspace package again.
      const linkPath = path.join(herdrDir, 'node_modules', '@worklog', 'shared');
      fs.mkdirSync(linkPath, { recursive: true });
      git(gitBin, ['-C', repoDir, 'worktree', 'add', '--detach', wtDir, 'HEAD'], tempBase, tempBase);

      // The worktree's herdr node_modules is symlinked to the main
      // checkout's, exactly as implement.py start creates it for every
      // worktree build (SA-0MSGS763C006SM1B).
      const wtHerdrDir = path.join(wtDir, 'packages', 'herdr');
      fs.mkdirSync(wtHerdrDir, { recursive: true });
      fs.symlinkSync(path.join(herdrDir, 'node_modules'), path.join(wtHerdrDir, 'node_modules'), 'dir');

      // Fake npm that WOULD wipe the link (npm ci deletes node_modules
      // first) and a fake herdr that records the manifest it links. If the
      // script ran the install from the worktree, the npm log would be
      // written and the link assertions below would fail.
      const fakeBinDir = path.join(tempBase, 'bin');
      fs.mkdirSync(fakeBinDir);
      const npmLog = path.join(tempBase, 'npm.log');
      const linkLog = path.join(tempBase, 'herdr-link.log');
      fs.writeFileSync(
        path.join(fakeBinDir, 'npm'),
        `#!/usr/bin/env bash\necho "npm invoked" >> "${npmLog}"\nrm -rf "${linkPath}"\nmkdir -p "${linkPath}"\nexit 0\n`,
      );
      fs.chmodSync(path.join(fakeBinDir, 'npm'), 0o755);
      fs.writeFileSync(
        path.join(fakeBinDir, 'herdr'),
        '#!/usr/bin/env bash\necho "$@" >> "' + linkLog + '"\nexit 0\n',
      );
      fs.chmodSync(path.join(fakeBinDir, 'herdr'), 0o755);

      // Real git for the worktree resolution, fake npm/herdr for the rest,
      // with the test-suite git mock (no `worktree list`) excluded.
      const realGitDir = path.dirname(gitBin);
      const mockBinDir = path.resolve(__dirname, '..', 'cli', 'mock-bin');
      const cleanPath = (process.env.PATH ?? '')
        .split(path.delimiter)
        .filter((dir) => dir !== '' && path.resolve(dir) !== mockBinDir);
      const scriptPath = `${fakeBinDir}${path.delimiter}${realGitDir}${path.delimiter}${cleanPath.join(path.delimiter)}`;

      const configPath = path.join(tempBase, 'herdr', 'config.toml');
      const result = spawnSync('bash', [path.join(wtDir, 'scripts', 'install-herdr.sh')], {
        cwd: wtDir,
        encoding: 'utf8',
        env: { ...process.env, PATH: scriptPath, HERDR_CONFIG_PATH: configPath },
      });
      expect(result.status, `script failed: ${result.stderr}`).toBe(0);

      // AC1: npm must never have been invoked from the worktree build.
      expect(fs.existsSync(npmLog)).toBe(false);

      // AC3: the @worklog/shared link still resolves to the LIVE workspace
      // package — in the main checkout and through the worktree's symlinked
      // node_modules.
      expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(linkPath)).toBe(path.join(repoDir, 'packages', 'shared'));
      expect(fs.realpathSync(path.join(wtHerdrDir, 'node_modules', '@worklog', 'shared'))).toBe(
        path.join(repoDir, 'packages', 'shared'),
      );

      // Scope note (WL-0MVWJ4IKT005SAHT): the plugin link must still target
      // the MAIN checkout from a worktree build — never the worktree.
      const log = fs.readFileSync(linkLog, 'utf8').trim();
      const expectedManifest = path.join(repoDir, 'packages', 'herdr', 'herdr-plugin.toml');
      expect(log).toContain(expectedManifest);
      expect(log).not.toContain(wtDir);
    } finally {
      fs.rmSync(tempBase, { recursive: true, force: true });
    }
  });

  itScript('calls `herdr server reload-config` after inserting a new keybinding', () => {
    // WL-0MSHND11O007FKOU: after inserting the keybinding, the running herdr
    // server must be told to reload its config so the new binding is active
    // without a manual restart.
    const tempBase = makeTempDir('worklog-herdr-reload-');
    const fakeBinDir = path.join(tempBase, 'bin');
    fs.mkdirSync(fakeBinDir);
    const herdrLog = path.join(tempBase, 'herdr-log.txt');
    fs.writeFileSync(
      path.join(fakeBinDir, 'herdr'),
      `#!/usr/bin/env bash\necho "$@" >> "${herdrLog}"\nexit 0\n`,
    );
    fs.chmodSync(path.join(fakeBinDir, 'herdr'), 0o755);

    const repoRoot = path.resolve(__dirname, '..', '..');
    const configPath = path.join(tempBase, 'herdr', 'config.toml');
    const result = spawnSync('bash', [
      path.join(repoRoot, 'scripts', 'install-herdr.sh'),
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBinDir}${path.delimiter}${scriptStubDir()}${path.delimiter}/usr/bin:/bin`,
        HERDR_CONFIG_PATH: configPath,
      },
    });
    expect(result.status, `script failed: ${result.stderr}`).toBe(0);
    expect(fs.existsSync(configPath)).toBe(true);

    // Verify the script called `herdr server reload-config` after insertion.
    const log = fs.readFileSync(herdrLog, 'utf8').trim();
    expect(log).toContain('plugin');
    expect(log).toContain('link');
    expect(log).toContain('server reload-config');

    // The stdout should mention the reload.
    expect(result.stdout).toContain('reload');
  });

  itScript('reloads config even when the keybinding already exists', () => {
    // AC: re-running the installer makes the binding active. A previous
    // installer run may have written the binding without activating it (the
    // running server keeps startup keybindings in memory), so the already
    // present path must also request a reload.
    const tempBase = makeTempDir('worklog-herdr-already-reload-');
    const fakeBinDir = path.join(tempBase, 'bin');
    fs.mkdirSync(fakeBinDir);
    const herdrLog = path.join(tempBase, 'herdr-log.txt');
    fs.writeFileSync(
      path.join(fakeBinDir, 'herdr'),
      `#!/usr/bin/env bash\necho "$@" >> "${herdrLog}"\nexit 0\n`,
    );
    fs.chmodSync(path.join(fakeBinDir, 'herdr'), 0o755);

    const repoRoot = path.resolve(__dirname, '..', '..');
    const configPath = path.join(tempBase, 'herdr', 'config.toml');
    // Pre-populate with the binding so the script skips insertion.
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, KEYBINDING_BLOCK);

    const result = spawnSync('bash', [
      path.join(repoRoot, 'scripts', 'install-herdr.sh'),
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBinDir}${path.delimiter}${scriptStubDir()}${path.delimiter}/usr/bin:/bin`,
        HERDR_CONFIG_PATH: configPath,
      },
    });
    expect(result.status).toBe(0);

    // The script did not modify the config, but it must still have asked
    // the running server to reload so the binding is active.
    expect(fs.readFileSync(configPath, 'utf8')).toBe(KEYBINDING_BLOCK);
    const log = fs.readFileSync(herdrLog, 'utf8');
    expect(log).toContain('server reload-config');
  });

  itScript('exits 0 even when `herdr server reload-config` fails', () => {
    // Best-effort reload: if the herdr server is not running or reload
    // fails for any reason, the script must still succeed.
    const tempBase = makeTempDir('worklog-herdr-reload-fail-');
    const fakeBinDir = path.join(tempBase, 'bin');
    fs.mkdirSync(fakeBinDir);
    // Fake herdr that fails on the reload-config subcommand but succeeds on plugin link.
    fs.writeFileSync(
      path.join(fakeBinDir, 'herdr'),
      `#!/usr/bin/env bash\nif [ "$1" = "server" ] && [ "$2" = "reload-config" ]; then\n  exit 1\nfi\nexit 0\n`,
    );
    fs.chmodSync(path.join(fakeBinDir, 'herdr'), 0o755);

    const repoRoot = path.resolve(__dirname, '..', '..');
    const configPath = path.join(tempBase, 'herdr', 'config.toml');
    const result = spawnSync('bash', [
      path.join(repoRoot, 'scripts', 'install-herdr.sh'),
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBinDir}${path.delimiter}${scriptStubDir()}${path.delimiter}/usr/bin:/bin`,
        HERDR_CONFIG_PATH: configPath,
      },
    });
    // Script must exit 0 despite reload failure.
    expect(result.status).toBe(0);
    expect(fs.existsSync(configPath)).toBe(true);
  });

  itScript('intercepts the dependency install with a stub from a main checkout (hermetic)', () => {
    // WL-0MVWL88MO002SQ2B: a real `npm ci` in this suite is both slow under
    // load (the flake's root cause) and destructive (npm deletes
    // node_modules first). Running the installer from a MAIN checkout — as CI
    // and a plain `npm test` do — still reaches the install step, so the test
    // environment must intercept it. This test fails loudly if the stub wiring
    // regresses and a real install would happen again.
    const tempBase = makeTempDir('worklog-herdr-install-stub-');
    const repoDir = path.join(tempBase, 'repo');
    const herdrDir = path.join(repoDir, 'packages', 'herdr');
    fs.mkdirSync(path.join(repoDir, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(herdrDir, 'node_modules'), { recursive: true });

    const repoRoot = path.resolve(__dirname, '..', '..');
    fs.copyFileSync(
      path.join(repoRoot, 'scripts', 'install-herdr.sh'),
      path.join(repoDir, 'scripts', 'install-herdr.sh'),
    );
    fs.writeFileSync(
      path.join(herdrDir, 'package.json'),
      JSON.stringify({ name: '@worklog/herdr-plugin', version: '0.1.0', private: true }),
    );
    // A lockfile means the installer chooses `npm ci`.
    fs.writeFileSync(
      path.join(herdrDir, 'package-lock.json'),
      JSON.stringify({ lockfileVersion: 3 }),
    );
    fs.writeFileSync(path.join(herdrDir, 'herdr-plugin.toml'), 'id = "worklog-selection-list"\n');
    // A real `npm ci` deletes node_modules; this marker must survive.
    const markerPath = path.join(herdrDir, 'node_modules', 'installed.txt');
    fs.writeFileSync(markerPath, 'installed\n');

    const gitBin = realGitBin();
    git(gitBin, ['init', '-q', repoDir], tempBase, tempBase);
    git(gitBin, ['-C', repoDir, 'config', 'user.email', 'test@example.com'], tempBase, tempBase);
    git(gitBin, ['-C', repoDir, 'config', 'user.name', 'Worklog Test'], tempBase, tempBase);
    git(gitBin, ['-C', repoDir, 'add', '-A'], tempBase, tempBase);
    git(gitBin, ['-C', repoDir, 'commit', '-q', '-m', 'init'], tempBase, tempBase);

    const installsBefore = npmInvocations().length;
    const configPath = path.join(tempBase, 'herdr', 'config.toml');
    // Run from the fixture's own checkout: the script's main-checkout
    // resolution keeps REPO_ROOT here, so this is the install path, not the
    // linked-worktree skip path.
    const result = spawnSync('bash', [path.join(repoDir, 'scripts', 'install-herdr.sh')], {
      cwd: repoDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${scriptStubDir()}${path.delimiter}/usr/bin:/bin`,
        HERDR_CONFIG_PATH: configPath,
      },
    });
    expect(result.status, `script failed: ${result.stderr}`).toBe(0);

    // The stub — not a real npm — served the install.
    const installs = npmInvocations().slice(installsBefore);
    expect(installs.some((line) => line.includes('ci --prefix'))).toBe(true);
    // …and nothing was actually installed or wiped.
    expect(fs.readFileSync(markerPath, 'utf8')).toBe('installed\n');
    expect(fs.existsSync(configPath)).toBe(true);
  });

});
