/**
 * Entry-point split contracts (F3 — WL-0MVFRRCP7007UWS7).
 *
 * Test-first coverage for F4 (WL-0MVFRRKKN00544PQ): `src/cli.ts` becomes a
 * thin bootstrap (argv scan + read-cache fast path + `--version`) that only
 * dynamically imports the heavy graph (`src/cli-main.ts`) when the fast path
 * did not serve the invocation. These specs are written BEFORE the split so
 * it is driven by observable contracts rather than implementation details:
 *
 *   1. DISPATCH PARITY — every built-in command in the registration list is
 *      still reachable through the split entry point. Each command's
 *      `--help` must exit 0 and name the command, which proves the command's
 *      module loaded and registered (a component of the lazy registry F6
 *      must keep honouring).
 *   2. FAST PATH — a warm cache hit is served with no read work (F1 spawn
 *      record kind `cache-hit`, never `read-work`) and `--version` records a
 *      `version` spawn. Both must exit BEFORE `loadPlugins()` runs (F4's
 *      "cache hits and `--version` exit before commander/DB/plugins load"),
 *      observed with a plugin canary rather than source inspection.
 *   3. RESOLUTION PARITY — `--worklog-dir` and worktree/prefix resolution
 *      stay identical through the split (parent constraint: "keep working
 *      from any worktree/`--worklog-dir`"). The cache-hit half of the
 *      `--worklog-dir` contract lives in `read-cache-e2e.test.ts`.
 *
 * RED-pinned tests use `it.fails(...)` so the suite stays green while the
 * contract is unmet; F4 flips each `it.fails(` to `it(` as the split lands.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { writeConfig, writeInitSemaphore, getPackageVersion } from './cli-helpers.js';
import { createTempDir, cleanupTempDir } from '../test-utils.js';
import { buildStartupInvocation, resolveStartupTarget } from '../../bench/wl-startup-perf.js';
import { countSpawnRecords } from '../../src/spawn-counter.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The command registration list this suite pins (F3 AC1). Keep it in the
 * same order as `src/cli.ts`'s `builtInCommandNames` so a missing or renamed
 * command is named precisely in the failure message.
 */
const BUILT_IN_COMMANDS = [
  'init',
  'status',
  'create',
  'list',
  'show',
  'update',
  'delete',
  'export',
  'import',
  'next',
  'in-progress',
  'sync',
  'github',
  'comment',
  'close',
  'recent',
  'plugins',
  'migrate',
  'dep',
  're-sort',
  'doctor',
  'reviewed',
  'interview',
  'search',
  'unlock',
  'audit',
  'audit-show',
  'audit-set',
  'audit-waive',
  'audit-unwaive',
  'completion',
  'cleanup-worktree',
];

/**
 * The CLI under test: the built `dist/cli.js` (what `/usr/local/bin/wl`
 * runs) when present, otherwise the tsx entry. F3 must hold for both, and
 * `resolveStartupTarget('auto', …)` keeps the suite runnable on a checkout
 * that has not been built yet.
 */
const entryInvocation = buildStartupInvocation(resolveStartupTarget('auto', repoRoot), repoRoot);

interface CliResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

/** Run the real CLI entry point as a subprocess. */
function runCli(args: string[], cwd: string, env: NodeJS.ProcessEnv): CliResult {
  const result = spawnSync(entryInvocation[0], [...entryInvocation.slice(1), ...args], {
    cwd,
    env,
    encoding: 'utf-8',
    timeout: 60_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

/**
 * Isolated environment for one temp worklog: its own cache, spawn-record
 * file, plugin dir and XDG config home, so host plugins/cache state can
 * never leak into (or be mutated by) these tests.
 */
function isolatedEnv(tempDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WL_TUI_MODE: '1',
    WL_CACHE_DIR: path.join(tempDir, 'cache'),
    WL_SPAWN_COUNT_FILE: path.join(tempDir, 'spawns.log'),
    XDG_CONFIG_HOME: path.join(tempDir, 'xdg-config'),
  };
  delete env.WL_CACHE_DISABLED;
  delete env.WORKLOG_PLUGIN_DIR;
  delete env.WL_PLUGIN_CANARY_MARKER;
  return env;
}

/** Write a plugin whose module top-level code proves it was imported. */
function writePluginCanary(pluginDir: string): void {
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'canary.mjs'),
    [
      "import * as fs from 'node:fs';",
      "fs.writeFileSync(process.env.WL_PLUGIN_CANARY_MARKER, 'plugin-loaded\\n');",
      'export default function register() {}',
      '',
    ].join('\n'),
    'utf-8'
  );
}

describe('entry-point split — dispatch parity', { timeout: 300_000 }, () => {
  it('keeps every built-in command dispatchable', () => {
    const tempDir = createTempDir();
    try {
      writeConfig(tempDir, 'Entry Split Dispatch', 'ESD');
      writeInitSemaphore(tempDir);
      const env = isolatedEnv(tempDir);

      const failures: string[] = [];
      for (const command of BUILT_IN_COMMANDS) {
        const res = runCli([command, '--help'], tempDir, env);
        const output = `${res.stdout}${res.stderr}`;
        if (res.status !== 0) {
          failures.push(
            `wl ${command} --help exited ${res.status} — command '${command}' is not ` +
              `dispatchable after the entry-point split:\n${output.trim().slice(0, 400)}`
          );
        } else if (!/Usage:/.test(output)) {
          failures.push(
            `wl ${command} --help printed no usage text — command '${command}' did not register`
          );
        } else if (!output.includes(command)) {
          failures.push(
            `wl ${command} --help did not name command '${command}' in its usage output`
          );
        }
      }

      expect(failures, `commands lost by the entry-point split:\n${failures.join('\n')}`).toEqual(
        []
      );
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it('lists every built-in command in the grouped help output', () => {
    const tempDir = createTempDir();
    try {
      writeConfig(tempDir, 'Entry Split Help', 'ESH');
      writeInitSemaphore(tempDir);
      const res = runCli(['--help'], tempDir, isolatedEnv(tempDir));
      expect(res.status, `wl --help exited ${res.status}: ${res.stderr}`).toBe(0);

      const output = `${res.stdout}${res.stderr}`;
      const missing = BUILT_IN_COMMANDS.filter((command) => !output.includes(command));
      expect(missing, `built-in commands missing from 'wl --help': ${missing.join(', ')}`).toEqual(
        []
      );
    } finally {
      cleanupTempDir(tempDir);
    }
  });
});

describe('entry-point split — fast path', { timeout: 180_000 }, () => {
  let tempDir: string;
  let env: NodeJS.ProcessEnv;
  let spawnFile: string;
  let pluginDir: string;
  let canaryMarker: string;

  beforeEach(() => {
    tempDir = createTempDir();
    writeConfig(tempDir, 'Entry Split Fast Path', 'ESF');
    writeInitSemaphore(tempDir);
    env = isolatedEnv(tempDir);
    spawnFile = env.WL_SPAWN_COUNT_FILE as string;
    pluginDir = path.join(tempDir, 'plugins');
    canaryMarker = path.join(tempDir, 'plugin-loaded.txt');
    writePluginCanary(pluginDir);
    env.WORKLOG_PLUGIN_DIR = pluginDir;
    env.WL_PLUGIN_CANARY_MARKER = canaryMarker;

    // Seed one item through the normal (heavy) path; the canary marker it
    // leaves behind is cleared so each assertion observes its own run.
    const seed = runCli(['--json', 'create', '-t', 'Alpha'], tempDir, env);
    expect(seed.status, `seed create failed: ${seed.stderr}`).toBe(0);
    fs.rmSync(canaryMarker, { force: true });
    fs.rmSync(spawnFile, { force: true });
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('serves a warm cache hit without any read work (spawn-record evidence)', () => {
    const first = runCli(['list', '--json'], tempDir, env);
    expect(first.status, `cold list failed: ${first.stderr}`).toBe(0);

    // Only the second (warm) invocation is measured.
    fs.rmSync(spawnFile, { force: true });
    const second = runCli(['list', '--json'], tempDir, env);
    expect(second.status, `cache-hit list failed: ${second.stderr}`).toBe(0);
    expect(second.stdout).toBe(first.stdout);

    expect(
      countSpawnRecords(spawnFile, 'read-work'),
      'a served cache hit must not perform read work (no read-work spawn record)'
    ).toBe(0);
    expect(
      countSpawnRecords(spawnFile, 'cache-hit'),
      'a served cache hit must record exactly one cache-hit spawn record'
    ).toBe(1);
  });

  it.fails('exits a cache hit before plugins are loaded', () => {
    // Prime the cache and clear the marker the priming (heavy) run wrote.
    const prime = runCli(['list', '--json'], tempDir, env);
    expect(prime.status, `priming list failed: ${prime.stderr}`).toBe(0);
    fs.rmSync(canaryMarker, { force: true });

    const hit = runCli(['list', '--json'], tempDir, env);
    expect(hit.status, `cache-hit list failed: ${hit.stderr}`).toBe(0);

    expect(
      fs.existsSync(canaryMarker),
      'the cache-hit fast path must exit before loadPlugins() runs — the plugin ' +
        'canary was imported'
    ).toBe(false);
  });

  it('records --version as a version spawn and prints the package version', () => {
    const res = runCli(['--version'], tempDir, env);
    expect(res.status, `wl --version failed: ${res.stderr}`).toBe(0);
    expect(res.stdout.trim()).toBe(getPackageVersion());

    expect(
      countSpawnRecords(spawnFile, 'version'),
      '--version must record exactly one version spawn record'
    ).toBe(1);
    expect(
      countSpawnRecords(spawnFile, 'read-work'),
      '--version must not perform read work (no read-work spawn record)'
    ).toBe(0);
  });

  it.fails('exits --version before plugins are loaded', () => {
    fs.rmSync(canaryMarker, { force: true });
    const res = runCli(['--version'], tempDir, env);
    expect(res.status, `wl --version failed: ${res.stderr}`).toBe(0);

    expect(
      fs.existsSync(canaryMarker),
      'the --version fast path must exit before loadPlugins() runs — the plugin ' +
        'canary was imported'
    ).toBe(false);
  });
});

describe('entry-point split — worklog resolution parity', { timeout: 180_000 }, () => {
  it('resolves the main worklog and project prefix from a managed worktree', () => {
    const tempDir = createTempDir();
    try {
      writeConfig(tempDir, 'Worktree Prefix', 'WTP');
      writeInitSemaphore(tempDir);
      const worktreeCwd = path.join(tempDir, '.worklog', 'worktrees', 'wt-split-contract');
      fs.mkdirSync(worktreeCwd, { recursive: true });
      const env = isolatedEnv(tempDir);

      const created = runCli(['--json', 'create', '-t', 'From the worktree'], worktreeCwd, env);
      expect(created.status, `create from worktree failed: ${created.stderr}`).toBe(0);
      const createdItem = JSON.parse(created.stdout) as { workItem: { id: string } };
      const id = createdItem.workItem.id;
      expect(
        id.startsWith('WTP-'),
        `create inside .worklog/worktrees must use the project prefix (WTP), got '${id}'`
      ).toBe(true);

      // The item lives in the main project's worklog, not a worktree-local one.
      const fromRoot = runCli(['list', '--json'], tempDir, env);
      expect(fromRoot.status, `list from project root failed: ${fromRoot.stderr}`).toBe(0);
      const titles = (JSON.parse(fromRoot.stdout) as { workItems: Array<{ title: string }> })
        .workItems.map((item) => item.title);
      expect(titles, 'the worktree-created item must live in the main worklog').toContain(
        'From the worktree'
      );

      // A bare id resolves via the project prefix when run from the worktree.
      const bareId = id.slice('WTP-'.length);
      const shown = runCli(['show', bareId, '--json'], worktreeCwd, env);
      expect(shown.status, `show ${bareId} from worktree failed: ${shown.stderr}`).toBe(0);
      const shownItem = JSON.parse(shown.stdout) as { workItem: { id: string } };
      expect(shownItem.workItem.id).toBe(id);
    } finally {
      cleanupTempDir(tempDir);
    }
  });
});
