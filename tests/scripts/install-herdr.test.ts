import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

// The exact keybinding block scripts/install-herdr.sh must insert.
const KEYBINDING_BLOCK = `[[keys.command]]
key = "prefix+l"
command = "herdr plugin action invoke worklog-selection-list.open-worklist"
description = "Open the Worklog work item selection pane in a new tab."
`;

// Marker the script uses for its existence check.
const COMMAND_MARKER = 'worklog-selection-list.open-worklist';

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
});
