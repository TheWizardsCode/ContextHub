/**
 * Lazy command registry, help and plugin fidelity (F5 — WL-0MVFRREMZ0085G7I).
 *
 * Test-first coverage for F6 (WL-0MVFRRMX3003UPP3), which replaces the eager
 * `import XCommand` list in `src/cli-main.ts` with a name → dynamic-import
 * registry. These specs pin the observable contracts:
 *
 *   1. HELP FIDELITY — `wl --help`, bare `wl` and `wl <cmd> --help` keep the
 *      grouped layout, every built-in command stays in its documented group,
 *      and global options still appear on subcommand help.
 *   2. PLUGIN FIDELITY — plugins are still discovered and loaded on the heavy
 *      path (`loadPlugins`) and their commands appear under "Plugins".
 *   3. ERROR PARITY — an unknown command keeps the exact error and exit code.
 *   4. LAZY ISOLATION — a single-command invocation resolves only
 *      that command's module, verified through the registry's `onLoad`
 *      observer rather than by inspecting source.
 *   5. FALLBACK (parent AC5) — when a registry import rejects the
 *      CLI warns once, eagerly registers the full set and still dispatches, so
 *      lazy loading can never make a command unusable.
 *
 * Specs 4 and 5 were RED-pinned with `it.fails(...)` while the registry did not
 * exist yet; F6 (WL-0MVFRRMX3003UPP3) flipped them to plain `it(...)` when
 * `src/command-registry.ts` landed (same pattern as F3 → F4).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { writeConfig, writeInitSemaphore } from './cli-helpers.js';
import { createTempDir, cleanupTempDir } from '../test-utils.js';
import { buildStartupInvocation, resolveStartupTarget } from '../../bench/wl-startup-perf.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const entryInvocation = buildStartupInvocation(resolveStartupTarget('auto', repoRoot), repoRoot);

/** The grouped layout this suite pins (F5 AC2), in display order. */
const EXPECTED_GROUPS: Record<string, string[]> = {
  'Issue Management': ['create', 'update', 'delete', 'comment', 'close', 'dep', 'reviewed', 'audit'],
  Status: ['list', 'show', 'next', 'in-progress', 'recent', 'search'],
  Team: ['export', 'import', 'sync', 'github'],
  Maintenance: ['migrate', 're-sort', 'doctor', 'unlock'],
  Other: [
    'init',
    'status',
    'interview',
    'audit-show',
    'audit-set',
    'audit-waive',
    'audit-unwaive',
    'cleanup-worktree',
    'completion',
    'help',
  ],
};

interface CliResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

function runCli(args: string[], cwd: string, env: NodeJS.ProcessEnv): CliResult {
  const result = spawnSync(entryInvocation[0], [...entryInvocation.slice(1), ...args], {
    cwd,
    env,
    encoding: 'utf-8',
    timeout: 90_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

/** Isolated cache/plugin/config environment for one temp worklog. */
function isolatedEnv(tempDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WL_TUI_MODE: '1',
    WL_CACHE_DIR: path.join(tempDir, 'cache'),
    XDG_CONFIG_HOME: path.join(tempDir, 'xdg-config'),
  };
  delete env.WL_CACHE_DISABLED;
  delete env.WORKLOG_PLUGIN_DIR;
  delete env.WL_PLUGIN_CANARY_MARKER;
  return env;
}

/**
 * Parse the custom grouped help output into `group -> command names`.
 *
 * The renderer emits `Group:` headings followed by `  <term> <description>`
 * lines; command terms may carry aliases (`audit-show|audit show`) and
 * argument syntax (`create [options]`), so only the leading command token is
 * kept.
 */
function parseHelpGroups(output: string): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  let current: string | null = null;
  for (const rawLine of output.split('\n')) {
    const heading = /^([A-Z][A-Za-z ]+):\s*$/.exec(rawLine);
    if (heading) {
      current = heading[1];
      groups[current] = [];
      continue;
    }
    if (current === null) continue;
    if (/^\s*$/.test(rawLine)) {
      if ((groups[current] ?? []).length > 0) current = null;
      continue;
    }
    const entry = /^\s{2}(\S+)/.exec(rawLine);
    if (!entry) continue;
    const token = entry[1].split('|')[0];
    if (!/^[a-z][a-z0-9-]*$/.test(token)) continue;
    groups[current].push(token);
  }
  return groups;
}

/** Write a plugin module that records that it was imported and adds a command. */
function writePluginCanary(pluginDir: string): void {
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'canary.mjs'),
    [
      "import * as fs from 'node:fs';",
      "fs.writeFileSync(process.env.WL_PLUGIN_CANARY_MARKER, 'plugin-loaded\\n');",
      'export default function register(ctx) {',
      "  ctx.program.command('canary-cmd').description('Canary command from a plugin').action(() => {});",
      '}',
      '',
    ].join('\n'),
    'utf-8'
  );
}

describe('lazy command registry — help and registration fidelity', { timeout: 300_000 }, () => {
  let tempDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tempDir = createTempDir();
    writeConfig(tempDir, 'Lazy Registry Help', 'LRH');
    writeInitSemaphore(tempDir);
    env = isolatedEnv(tempDir);
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('keeps every built-in command in its documented help group', () => {
    const { stdout, stderr, status } = runCli(['--help'], tempDir, env);
    expect(status, `wl --help failed: ${stderr}`).toBe(0);

    const groups = parseHelpGroups(stdout);
    const mismatches: string[] = [];
    for (const [group, expected] of Object.entries(EXPECTED_GROUPS)) {
      const actual = groups[group];
      if (!actual) {
        mismatches.push(`group '${group}' is missing from help`);
        continue;
      }
      const missing = expected.filter((name) => !actual.includes(name));
      if (missing.length > 0) mismatches.push(`${group}: missing ${missing.join(', ')}`);
    }
    expect(mismatches, `grouped help layout changed:\n${mismatches.join('\n')}`).toEqual([]);

    // Alias-bearing commands keep their aliases in help (audit-show|audit show).
    expect(stdout).toContain('audit-show|audit show');
    expect(stdout).toContain('audit-set|audit set');
    expect(stdout).toContain('github|gh');
  });

  it('bare wl prints the same grouped help and exits non-zero', () => {
    const withFlag = runCli(['--help'], tempDir, env);
    const bare = runCli([], tempDir, env);

    expect(bare.status).toBe(1); // Commander's "no command" exit code
    // Commander writes the implicit help to stderr when no command was given.
    const bareOutput = `${bare.stdout}${bare.stderr}`;
    const withFlagGroups = parseHelpGroups(withFlag.stdout);
    const bareGroups = parseHelpGroups(bareOutput);
    expect(bareGroups['Issue Management']).toEqual(withFlagGroups['Issue Management']);
    expect(bareGroups['Status']).toEqual(withFlagGroups['Status']);
    expect(bareOutput).toContain('Usage:');
  });

  it('shows global options on subcommand help, not just the program help', () => {
    const { stdout, status } = runCli(['show', '--help'], tempDir, env);
    expect(status).toBe(0);
    expect(stdout).toContain('--json');
    expect(stdout).toContain('--worklog-dir');
  });

  it('loads plugins on the heavy path and lists their commands under Plugins', () => {
    const pluginDir = path.join(tempDir, 'plugins');
    const marker = path.join(tempDir, 'plugin-loaded.txt');
    writePluginCanary(pluginDir);
    env.WORKLOG_PLUGIN_DIR = pluginDir;
    env.WL_PLUGIN_CANARY_MARKER = marker;

    const { stdout, status } = runCli(['--help'], tempDir, env);
    expect(status).toBe(0);

    // The plugin module really was imported (top-level side effect), not just
    // discovered on disk.
    expect(fs.existsSync(marker), 'the plugin canary was not imported by the heavy path').toBe(true);

    const groups = parseHelpGroups(stdout);
    expect(groups['Plugins'], 'plugin commands must stay in the Plugins group').toContain('canary-cmd');
    expect(groups['Plugins']).toContain('plugins');
    // Built-in commands must not leak into the Plugins group.
    expect(groups['Plugins']).not.toContain('list');
  });

  it('keeps the unknown-command error message and exit code', () => {
    const { stdout, stderr, status } = runCli(['nope-cmd'], tempDir, env);
    expect(status).toBe(1);
    expect(stderr).toContain("unknown command 'nope-cmd'");
    expect(stdout.trim()).toBe('');
  });
});

describe('lazy command registry — isolation and fallback', () => {
  /** Minimal PluginContext stand-in: only `program` is used by the registry. */
  function fakeContext() {
    const registered: string[] = [];
    return {
      registered,
      ctx: {
        program: {
          command: (name: string) => ({ description: () => ({ action: () => {} }), name }),
          commands: [],
        },
      } as any,
    };
  }

  it('loads only the requested command module for a single-command invocation', async () => {
    const registry = await import('../../src/command-registry.js');
    const { ctx } = fakeContext();
    const loaded: string[] = [];

    await registry.registerBuiltInCommands(ctx, ['show', 'WI-1', '--json'], {
      loaders: registry.createCommandLoaders(() => Promise.resolve({ default: () => {} } as any)),
      onLoad: (name: string) => loaded.push(name),
    });

    expect(loaded, 'a single-command invocation must load only that command module').toEqual(['show']);
  });

  it('falls back to eager full registration when a registry import rejects (parent AC5)', async () => {
    const registry = await import('../../src/command-registry.js');
    const { ctx } = fakeContext();
    const loaded: string[] = [];
    const warnings: string[] = [];

    const baseLoaders = registry.createCommandLoaders((name: string) => {
      if (name === 'show') return Promise.reject(new Error('simulated missing module'));
      return Promise.resolve({ default: () => {} } as any);
    });

    await registry.registerBuiltInCommands(ctx, ['show', 'WI-1', '--json'], {
      loaders: baseLoaders,
      onLoad: (name: string) => loaded.push(name),
      warn: (message: string) => warnings.push(message),
    });

    // One warning, then every command module is registered so dispatch works.
    expect(warnings.length).toBe(1);
    expect(loaded).toContain('show');
    // `BUILT_IN_COMMAND_NAMES` is an ordered array (registration order drives
    // the grouped help), so compare against its length.
    expect(loaded.length).toBeGreaterThanOrEqual(registry.BUILT_IN_COMMAND_NAMES.length);
  });
});
