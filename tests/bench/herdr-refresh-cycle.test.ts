/**
 * Contract tests for the herdr-refresh-cycle harness's query-set selector
 * (WL-0MVI0HH740065Z2T, parent WL-0MVGYLU0S004WZUS AC3).
 *
 * The full 30 s / 4-pane benchmark is far too slow for the unit suite, so
 * these tests pin the selector plumbing that gates its behaviour:
 *
 *   1. Option parsing — `--query-set` accepts `legacy` (default) and
 *      `consolidated`; an invalid value is rejected with an error naming the
 *      valid values, and the harness exits non-zero on it.
 *   2. Consolidated tick shape — exactly ONE CLI invocation per tick
 *      (`queriesPerTick: 1`) via the shared argv constant.
 *   3. C1 degrade — with a stub CLI whose `worklist` invocation fails, the
 *      harness reports "not available yet" and exits 0, and exits non-zero
 *      only when `--fail-if-unavailable` is passed explicitly.
 *
 * The stub-CLI runs use a fake `dist/cli.js` substitute (a tiny Node script)
 * so no build or real `wl` binary is required.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..');

const TINY_ARGS = ['--panes', '1', '--cycle-seconds', '1', '--tick-seconds', '1', '--items', '0'];

/** Write a stub CLI in a temp dir; returns its path. */
function writeStubCli(exitCode: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cycle-stub-'));
  const cli = path.join(dir, 'cli.cjs');
  fs.writeFileSync(cli, `process.exit(${exitCode});\n`, 'utf-8');
  return cli;
}

/** Run the harness as a subprocess against a stub CLI. */
function runHarness(cli: string, extraArgs: string[]): { status: number | null; stdout: string; stderr: string } {
  const proc = spawnSync(
    'npx',
    ['tsx', 'bench/herdr-refresh-cycle.ts', '--cli', cli, ...TINY_ARGS, ...extraArgs, '--json'],
    { cwd: repoRoot, encoding: 'utf-8', timeout: 120_000 },
  );
  return { status: proc.status, stdout: String(proc.stdout ?? ''), stderr: String(proc.stderr ?? '') };
}

describe('herdr-refresh-cycle query-set selector', () => {
  it('validates the selector in-process (legacy default, consolidated accepted, invalid rejected)', async () => {
    const { parseOptions } = await import('../../bench/herdr-refresh-cycle.js');

    expect(parseOptions(['--query-set', 'legacy']).querySet).toBe('legacy');
    expect(parseOptions([]).querySet).toBe('legacy'); // default
    expect(parseOptions([]).failIfUnavailable).toBe(false);
    expect(parseOptions(['--query-set', 'consolidated']).querySet).toBe('consolidated');
    expect(parseOptions(['--query-set', 'consolidated', '--fail-if-unavailable']).failIfUnavailable).toBe(true);

    expect(() => parseOptions(['--query-set', 'bogus'])).toThrow(/legacy, consolidated/);
    expect(() => parseOptions(['--query-set'])).toThrow(/requires a value/);
    expect(() => parseOptions(['--query-set', '--json'])).toThrow(/requires a value/);
  });

  it('issues exactly one CLI invocation per tick in consolidated mode', async () => {
    const { WORKLIST_QUERY_SETS, CONSOLIDATED_WORKLIST_QUERY } = await import('../../bench/worklist-query-sets.js');
    expect(WORKLIST_QUERY_SETS.consolidated).toHaveLength(1);
    expect(WORKLIST_QUERY_SETS.consolidated[0]).toEqual(CONSOLIDATED_WORKLIST_QUERY);

    const cli = writeStubCli(0);
    const res = runHarness(cli, ['--query-set', 'consolidated']);
    const parsed = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
    expect(res.status).toBe(0);
    expect(parsed.success).toBe(true);
    expect(parsed.result.querySet).toBe('consolidated');
    expect(parsed.result.queriesPerTick).toBe(1);
    expect(parsed.result.available).toBe(true);
  }, 120_000);

  it('degrading consolidated mode exits 0 unless --fail-if-unavailable is requested', async () => {
    // Stub that fails every invocation — simulates `wl worklist` not existing
    // yet (it lands in WL-0MVI0HX58009JJRF).
    const failingCli = writeStubCli(1);

    const degraded = runHarness(failingCli, ['--query-set', 'consolidated']);
    const degradedParsed = JSON.parse(degraded.stdout.slice(degraded.stdout.indexOf('{')));
    expect(degraded.status).toBe(0);
    expect(degradedParsed.result.available).toBe(false);
    expect(degradedParsed.result.queriesPerTick).toBe(1);
    expect(degradedParsed.result.diagnostic).toContain('not available');

    const explicit = runHarness(failingCli, ['--query-set', 'consolidated', '--fail-if-unavailable']);
    expect(explicit.status).toBe(1);
  }, 120_000);

  it('rejects an invalid --query-set with a non-zero exit naming the valid values', async () => {

    const cli = writeStubCli(0);
    const res = runHarness(cli, ['--query-set', 'bogus']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('bogus');
    expect(res.stderr).toContain('legacy');
    expect(res.stderr).toContain('consolidated');
  }, 120_000);
});
