/**
 * Tests for the `wl completion` command.
 *
 * Verifies that completion scripts for bash and zsh are generated
 * correctly, cover all subcommands and options, and include dynamic
 * completion logic for work-item IDs.
 */

import { spawnSync } from 'child_process';
import { resolve } from 'path';
import { test, expect, describe } from 'vitest';

const CLI_PATH = resolve(__dirname, '../../dist/cli.js');

// Known subcommands that should appear in completion scripts
const KNOWN_COMMANDS = [
  'init', 'status', 'create', 'list', 'show', 'update', 'delete',
  'export', 'import', 'next', 'in-progress', 'sync', 'github',
  'comment', 'close', 'recent', 'plugins', 'migrate', 'dep',
  're-sort', 'doctor', 'reviewed', 'search', 'unlock', 'audit',
  'completion',
];

// Known global options that should appear in completion scripts
const KNOWN_GLOBAL_OPTIONS = [
  '--json', '--verbose', '--format', '--help', '--version',
];

function runCompletion(shell: string): { stdout: string; stderr: string; exitCode: number | null } {
  const res = spawnSync(process.execPath, [CLI_PATH, 'completion', shell], {
    encoding: 'utf8',
    timeout: 10000,
  });
  return {
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    exitCode: res.status,
  };
}

describe('wl completion bash', () => {
  test('outputs a bash completion script when shell=bash', () => {
    const result = runCompletion('bash');
    expect(result.exitCode).toBe(0);

    // Must be a bash completion script
    expect(result.stdout).toContain('#/usr/bin/env bash');
    expect(result.stdout).toContain('_wl_completions');
    expect(result.stdout).toContain('complete -F _wl_completions');
    // The complete line registers both 'wl' and 'worklog'
    expect(result.stdout).toContain('wl worklog');
  });

  test('contains all known subcommands', () => {
    const result = runCompletion('bash');
    for (const cmd of KNOWN_COMMANDS) {
      expect(result.stdout).toContain(cmd);
    }
  });

  test('contains global options like --json, --format, --help', () => {
    const result = runCompletion('bash');
    for (const opt of KNOWN_GLOBAL_OPTIONS) {
      expect(result.stdout).toContain(opt);
    }
  });

  test('includes dynamic completion for work-item IDs (calls wl list)', () => {
    const result = runCompletion('bash');
    // Should attempt to fetch work-item IDs dynamically
    expect(result.stdout).toContain('wl list');
    expect(result.stdout).toContain('--json');
  });

  test('creates completions for completion subcommand itself', () => {
    const result = runCompletion('bash');
    expect(result.stdout).toContain('completion');
    expect(result.stdout).toContain('bash');
    expect(result.stdout).toContain('zsh');
  });

  test('errors gracefully for unknown shell', () => {
    const result = spawnSync(process.execPath, [CLI_PATH, 'completion', 'fish'], {
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(result.status).toBe(1);
    expect((result.stderr || '') + (result.stdout || '')).toMatch(/fish|unknown|not supported/i);
  });

  test('supports --json output', () => {
    const res = spawnSync(process.execPath, [CLI_PATH, '--json', 'completion', 'bash'], {
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout || '{}');
    expect(parsed.success).toBe(true);
    expect(parsed.shell).toBe('bash');
    expect(parsed.script).toBeDefined();
    expect(typeof parsed.script).toBe('string');
    expect(parsed.script.length).toBeGreaterThan(100);
  });
});

describe('wl completion zsh', () => {
  test('outputs a zsh completion script when shell=zsh', () => {
    const result = runCompletion('zsh');
    expect(result.exitCode).toBe(0);

    // Must be a zsh completion script
    expect(result.stdout).toContain('#compdef');
    expect(result.stdout).toContain('_wl');
    expect(result.stdout).toContain('compdef');
  });

  test('contains all known subcommands', () => {
    const result = runCompletion('zsh');
    for (const cmd of KNOWN_COMMANDS) {
      expect(result.stdout).toContain(cmd);
    }
  });

  test('contains global options', () => {
    const result = runCompletion('zsh');
    for (const opt of KNOWN_GLOBAL_OPTIONS) {
      expect(result.stdout).toContain(opt);
    }
  });

  test('includes dynamic completion for work-item IDs', () => {
    const result = runCompletion('zsh');
    // Should include mechanism to fetch IDs dynamically
    expect(result.stdout).toContain('wl');
    expect(result.stdout).toContain('list');
    expect(result.stdout).toContain('--json');
  });

  test('supports --json output', () => {
    const res = spawnSync(process.execPath, [CLI_PATH, '--json', 'completion', 'zsh'], {
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout || '{}');
    expect(parsed.success).toBe(true);
    expect(parsed.shell).toBe('zsh');
    expect(parsed.script).toBeDefined();
    expect(typeof parsed.script).toBe('string');
    expect(parsed.script.length).toBeGreaterThan(100);
  });
});

describe('wl completion without arguments', () => {
  test('shows usage when no shell is specified', () => {
    const res = spawnSync(process.execPath, [CLI_PATH, 'completion'], {
      encoding: 'utf8',
      timeout: 10000,
    });
    // Should show help or usage text
    const output = (res.stdout || '') + (res.stderr || '');
    expect(output).toMatch(/usage|available|shell|bash|zsh/i);
    expect(res.status).toBe(0);
  });
});
