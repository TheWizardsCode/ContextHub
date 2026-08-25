import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

// The exact keybinding block scripts/install-herdr.sh must insert.
const KEYBINDING_BLOCK = `[[keys.command]]
key = "prefix+l"
command = "herdr plugin action invoke worklog-selection-list.open-podcast-editor-tab"
description = "Open the Worklog tab (Worklog work item selection pane)."
`;

// Marker the script uses for its existence check.
const COMMAND_MARKER = 'worklog-selection-list.open-podcast-editor-tab';

// Legacy v0.1.x binding that prefix+l previously pointed at; install-herdr.sh
// migrates it in-place to the new action (never duplicates the key).
const LEGACY_BINDING = 'herdr plugin action invoke worklog-selection-list.open-worklist';

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
      // plugin-link path is not stubbed — see plan Q2 answer b).
      PATH: '/usr/bin:/bin',
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
  it('inserts the keybinding block exactly once when run twice (idempotent)', () => {
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

  it('creates the parent directory and file when the config path does not exist', () => {
    const tempDir = makeTempDir('worklog-herdr-missing-');
    const configPath = path.join(tempDir, 'herdr', 'config.toml');

    const result = runScript({ HERDR_CONFIG_PATH: configPath });
    expect(result.status).toBe(0);
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(KEYBINDING_BLOCK);
  });

  it('skips insertion when the config already contains the binding', () => {
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

  it('honours HERDR_CONFIG_PATH and leaves the default config untouched', () => {
    const tempHome = makeTempDir('worklog-herdr-home-');
    const overridePath = path.join(tempHome, 'override.toml');

    const result = runScript({ HOME: tempHome, HERDR_CONFIG_PATH: overridePath });
    expect(result.status).toBe(0);
    expect(fs.existsSync(overridePath)).toBe(true);
    expect(fs.readFileSync(overridePath, 'utf8')).toBe(KEYBINDING_BLOCK);
    expect(fs.existsSync(path.join(tempHome, '.config', 'herdr', 'config.toml'))).toBe(false);
  });

  it('warns and exits 0 when herdr is not on PATH, still inserting the binding', () => {
    const tempDir = makeTempDir('worklog-herdr-noherdr-');
    const configPath = path.join(tempDir, 'config.toml');

    const result = runScript({ HERDR_CONFIG_PATH: configPath });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('herdr');
    expect(result.stderr.toLowerCase()).toContain('warn');
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(KEYBINDING_BLOCK);
  });

  it('warns and exits 0 when the config directory cannot be written', () => {
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

  it('appends the block on a fresh line when the existing config lacks a trailing newline', () => {
    const tempDir = makeTempDir('worklog-herdr-newline-');
    const configPath = path.join(tempDir, 'config.toml');
    fs.writeFileSync(configPath, 'existing = true'); // no trailing newline

    const result = runScript({ HERDR_CONFIG_PATH: configPath });
    expect(result.status).toBe(0);
    const content = fs.readFileSync(configPath, 'utf8');
    expect(content).toBe('existing = true\n' + KEYBINDING_BLOCK);
    expect(countOccurrences(content, COMMAND_MARKER)).toBe(1);
  });

  it('migrates a legacy open-worklist binding in-place to the new action', () => {
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

  it('links the plugin from the main checkout when run inside a linked worktree', () => {
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
});
