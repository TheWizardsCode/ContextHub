/**
 * `wl sync` phase-timing observability regression tests (WL-0MVK6SD5O001K901).
 *
 * Parent epic WL-0MVK3WRY9009KV6P AC5 requires the pull/persist-items/
 * persist-comments/export/push timings of `performSync` to be observable so
 * the F2 stage harness can produce a before/after breakdown with the
 * documented commands (`packages/herdr/test/perf/wl-sync-phase-probe.ts` uses
 * the SAME phase names as the CLI — the shared `SYNC_PHASE_NAMES` constants in
 * `src/sync-phase-timings.ts`).
 *
 * These tests pin:
 *
 *   1. the timer contract — every phase name is always present (0 when
 *      skipped), windows of the same phase accumulate, async work is timed,
 *      and the log line is parseable;
 *   2. `performSync`'s dry run — per-phase timings on `SyncResult` and the
 *      `Sync phase timings:` line in `.worklog/logs/sync.log`;
 *   3. the `--json sync` response — the existing shape is unchanged apart from
 *      the added `summary.phaseTimings` field, and every timing field is
 *      present and numeric.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

import { writeConfig, writeInitSemaphore } from './cli-helpers.js';
import { cliInvocation } from './cli-bundle.js';
import { performSync } from '../../src/commands/sync.js';
import { WorklogDatabase } from '../../src/database.js';
import {
  SYNC_PHASE_NAMES,
  createSyncPhaseTimer,
  formatSyncPhaseTimings,
} from '../../src/sync-phase-timings.js';

const mockBinDir = path.join(path.dirname(new URL(import.meta.url).pathname), 'mock-bin');

/**
 * PATH without the test mock-bin so subprocesses run the real git binary
 * (mirrors tests/cli/sync-delta-push.test.ts: a real bare remote push needs
 * real git, not the minimal mock).
 */
function realGitEnv(): Record<string, string> {
  const pathVal = (process.env.PATH || '')
    .split(path.delimiter)
    .filter((p) => path.resolve(p) !== path.resolve(mockBinDir))
    .join(path.delimiter);
  return { ...(process.env as Record<string, string>), PATH: pathVal };
}

/** git helper mirroring tests/cli/sync-delta-push.test.ts (real git). */
function git(cwd: string, ...args: string[]): string {
  const res = spawnSync('git', args, { cwd, encoding: 'utf-8', env: realGitEnv() });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
  }
  return res.stdout.trim();
}

function runCli(cwd: string, ...args: string[]): { stdout: string; stderr: string; status: number } {
  const [command, entry] = cliInvocation();
  const res = spawnSync(command, [entry, ...args], {
    cwd,
    encoding: 'utf-8',
    env: realGitEnv(),
  });
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status ?? -1 };
}

describe('wl sync phase timings (WL-0MVK6SD5O001K901)', () => {
  describe('phase timer', () => {
    it('always reports every phase name, starting at 0, and accumulates windows', () => {
      let clock = 0;
      const timer = createSyncPhaseTimer(() => clock);

      // Unmeasured phases are 0, never missing: the shape stays stable for
      // dry runs / zero-change fast paths / --no-push.
      const initial = timer.timings();
      expect(Object.keys(initial).sort()).toEqual([...SYNC_PHASE_NAMES].sort());
      for (const value of Object.values(initial)) expect(value).toBe(0);

      timer.start('pull');
      clock += 5;
      timer.end('pull');

      // Re-entrant windows of the same phase accumulate (delta persist paths
      // interleave items and audits).
      timer.start('persist-items');
      clock += 7;
      timer.end('persist-items');
      timer.start('persist-items');
      clock += 3;
      timer.end('persist-items');

      expect(timer.timings()).toEqual({
        pull: 5,
        'persist-items': 10,
        'persist-comments': 0,
        export: 0,
        push: 0,
      });
    });

    it('times async work and formats the single log line used by performSync', async () => {
      let clock = 0;
      const timer = createSyncPhaseTimer(() => clock);
      await timer.measureAsync('export', async () => {
        clock += 4;
      });

      const line = formatSyncPhaseTimings(timer.timings());
      expect(line).toContain('export=4ms');
      expect(line).toContain('pull=0ms');
      for (const name of SYNC_PHASE_NAMES) expect(line).toContain(`${name}=`);
    });
  });

  describe('performSync dry run', () => {
    it('emits numeric per-phase timings on the result and a sync.log line', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-sync-timing-unit-'));
      const originalCwd = process.cwd();
      const originalPath = process.env.PATH;
      try {
        // performSync shells out to git via execAsync: run the real binary, not
        // the test mock-bin that setup-tests prepends to PATH.
        process.env.PATH = realGitEnv().PATH;
        git(root, 'init', '-q');
        git(root, 'config', 'user.email', 'test@example.com');
        git(root, 'config', 'user.name', 'Test User');
        writeConfig(root, 'Phase Timing Unit', 'PTU');
        writeInitSemaphore(root);

        const dbPath = path.join(root, '.worklog', 'worklog.db');
        const dataPath = path.join(root, '.worklog', 'worklog-data.jsonl');
        // A store must exist for the pulls to open: an empty store is enough —
        // the pull phase still measures the real read/merge path for it.
        const seed = new WorklogDatabase('PTU', dbPath, dataPath, true, false);
        seed.close();

        process.chdir(root);
        const result = await performSync(
          dataPath,
          () => new WorklogDatabase('PTU', dbPath, dataPath, true, false),
          {
            file: dataPath,
            prefix: 'PTU',
            gitRemote: 'origin',
            gitBranch: 'refs/worklog/data',
            push: false,
            dryRun: true,
            silent: true,
          }
        );

        expect(result.phaseTimings).toBeDefined();
        for (const name of SYNC_PHASE_NAMES) {
          expect(typeof result.phaseTimings![name]).toBe('number');
          expect(result.phaseTimings![name]).toBeGreaterThanOrEqual(0);
        }
        // A dry run persists nothing, so only the pull window ran; the other
        // phases must be present (0) rather than absent.
        expect(result.phaseTimings!['persist-comments']).toBe(0);

        // The phase-timing line is written to the sync log (silent by default:
        // log file only — never machine-readable stdout).
        const log = fs.readFileSync(path.join(root, '.worklog', 'logs', 'sync.log'), 'utf-8');
        expect(log).toContain('Sync phase timings:');
        for (const name of SYNC_PHASE_NAMES) expect(log).toContain(`${name}=`);
      } finally {
        process.chdir(originalCwd);
        process.env.PATH = originalPath;
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('--json sync output shape', () => {
    it('adds summary.phaseTimings without changing the existing response shape', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-sync-timing-cli-'));
      try {
        const remote = path.join(root, 'remote.git');
        const local = path.join(root, 'local');
        git(root, 'init', '--bare', '-q', remote);
        git(root, 'init', '-q', local);
        git(local, 'config', 'user.email', 'test@example.com');
        git(local, 'config', 'user.name', 'Test User');
        git(local, 'remote', 'add', 'origin', remote);
        writeConfig(local, 'Phase Timing Cli', 'PTC');
        writeInitSemaphore(local);
        fs.writeFileSync(path.join(local, 'README.md'), '# timing\n', 'utf8');
        git(local, 'add', '-A');
        git(local, 'commit', '-q', '-m', 'init');

        const created = runCli(local, '--json', 'create', '-t', 'Timing item');
        expect(created.status, created.stderr).toBe(0);

        const res = runCli(local, '--json', 'sync');
        expect(res.status, res.stderr).toBe(0);
        const out = JSON.parse(res.stdout);
        expect(out.success).toBe(true);

        // Existing top-level shape is untouched: the added timing fields live
        // inside summary.phaseTimings.
        expect(Object.keys(out.sync).sort()).toEqual(
          ['claimHolds', 'file', 'pushed', 'store', 'summary'].sort()
        );
        // The pre-existing summary fields are still present and unchanged.
        expect(typeof out.sync.summary.itemsAdded).toBe('number');
        expect(typeof out.sync.summary.itemsUpdated).toBe('number');

        // Every phase name is present and numeric.
        const timings = out.sync.summary.phaseTimings as Record<string, number>;
        expect(timings).toBeDefined();
        for (const name of SYNC_PHASE_NAMES) {
          expect(typeof timings[name]).toBe('number');
          expect(timings[name]).toBeGreaterThanOrEqual(0);
        }

        // The sync log carries the same per-phase line (verbosity-independent).
        const log = fs.readFileSync(path.join(local, '.worklog', 'logs', 'sync.log'), 'utf-8');
        expect(log).toContain('Sync phase timings:');
        for (const name of SYNC_PHASE_NAMES) expect(log).toContain(`${name}=`);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
