/**
 * Tests for scripts/wl-process-healthcheck.sh (WL-0MSBVYH3W0066KJS)
 *
 * The script counts concurrent node `wl`/`worklog` CLI processes via `ps`
 * and alerts when the count exceeds a threshold for a sustained number of
 * consecutive checks (see docs/dev/wl-process-spawning-investigation.md §6).
 *
 * These tests run the real script with a fake `ps` injected into PATH so the
 * process mix is deterministic and no real wl processes are required.
 */
import { execaSync } from 'execa';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'wl-process-healthcheck.sh');

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string; // stdout + stderr combined
}

/**
 * Install an executable fake `ps` in `dir` that serves lines from a fixture
 * file. Fixture lines follow `ps -eo pid,ppid,etime,args` output format:
 * `<pid> <ppid> <etime> <args...>`.
 */
function installFakePs(dir: string): void {
  const fakePs = path.join(dir, 'ps');
  fs.writeFileSync(
    fakePs,
    `#!/usr/bin/env bash
set -euo pipefail
# Fake ps for wl-process-healthcheck tests.
# Reads lines from \${PS_FIXTURE} in the format: <pid> <ppid> <etime> <args...>
if [[ "\${1:-}" != "-eo" ]]; then
  echo "fake ps: unsupported invocation: $*" >&2
  exit 1
fi
case "\${2:-}" in
  args) sed -E 's/^[0-9]+[[:space:]]+[0-9]+[[:space:]]+[^[:space:]]+[[:space:]]+//' "\$PS_FIXTURE" ;;
  pid,ppid,etime,args) cat "\$PS_FIXTURE" ;;
  *) echo "fake ps: unsupported columns: $*" >&2; exit 1 ;;
esac
`
  );
  fs.chmodSync(fakePs, 0o755);
}

describe('wl-process-healthcheck.sh', () => {
  let tmp: string;
  let countFile: string;
  let ticksFile: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-healthcheck-test-'));
    fs.mkdirSync(path.join(tmp, 'bin'), { recursive: true });
    installFakePs(path.join(tmp, 'bin'));
    countFile = path.join(tmp, 'count');
    ticksFile = path.join(tmp, 'ticks');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Run the real script against a fixture process list. */
  function run(fixtureLines: string[], args: string[] = []): RunResult {
    const fixture = path.join(tmp, 'ps-fixture');
    fs.writeFileSync(fixture, fixtureLines.join('\n') + '\n');
    const env = {
      ...process.env,
      PATH: `${path.join(tmp, 'bin')}:${process.env.PATH ?? ''}`,
      PS_FIXTURE: fixture,
    };
    try {
      const res = execaSync('bash', [SCRIPT, '--count-file', countFile, '--ticks-file', ticksFile, ...args], {
        env,
        encoding: 'utf-8',
      });
      return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr, output: res.stdout + res.stderr };
    } catch (err: any) {
      // execa throws on non-zero exit (the ALERT case exits 2)
      return {
        exitCode: err.exitCode ?? 1,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? '',
        output: (err.stdout ?? '') + (err.stderr ?? ''),
      };
    }
  }

  const wlLine = (pid: number, args: string) => `${pid} 1 05:32:01 ${args}`;
  const manyWl = (startPid: number, count: number) =>
    Array.from({ length: count }, (_, i) => wlLine(startPid + i, 'node /usr/local/bin/wl list --json'));

  it('reports OK and logs the count below the watch threshold', () => {
    const res = run([wlLine(1001, 'node /usr/local/bin/wl list --json')]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('OK');
    expect(res.stdout).toContain('1');
    expect(fs.readFileSync(countFile, 'utf-8').trim()).toBe('1');
    expect(fs.existsSync(ticksFile)).toBe(false);
  });

  it('reports WATCH between the watch and alert thresholds and logs the count', () => {
    const res = run(manyWl(2000, 30));

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('WATCH');
    expect(fs.readFileSync(countFile, 'utf-8').trim()).toBe('30');
    expect(fs.existsSync(ticksFile)).toBe(false);
  });

  it('logs the count on WATCH while above the alert threshold but not yet sustained', () => {
    const res = run(manyWl(3000, 60));

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('WATCH');
    expect(fs.readFileSync(countFile, 'utf-8').trim()).toBe('60');
    expect(fs.readFileSync(ticksFile, 'utf-8').trim()).toBe('1');
  });

  it('alerts with the process tree after N consecutive high readings and exits non-zero', () => {
    const lines = manyWl(4000, 60);

    const first = run(lines);
    expect(first.exitCode).toBe(0);
    expect(fs.readFileSync(ticksFile, 'utf-8').trim()).toBe('1');

    const second = run(lines);
    expect(second.exitCode).toBe(0);
    expect(fs.readFileSync(ticksFile, 'utf-8').trim()).toBe('2');

    const third = run(lines);
    expect(third.exitCode).toBe(2);
    expect(third.output).toContain('ALERT');
    // Process tree with pid/ppid/etime/args columns is emitted
    expect(third.output).toContain('node /usr/local/bin/wl list --json');
    expect(third.output).toContain('4000');
    // Tick counter resets after a completed alert
    expect(fs.existsSync(ticksFile)).toBe(false);
  });

  it('resets the tick counter when a later check drops below the alert threshold', () => {
    run(manyWl(5000, 60));
    expect(fs.readFileSync(ticksFile, 'utf-8').trim()).toBe('1');

    const res = run([wlLine(1001, 'node /usr/local/bin/wl list --json')]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('OK');
    expect(fs.existsSync(ticksFile)).toBe(false);
    expect(fs.readFileSync(countFile, 'utf-8').trim()).toBe('1');
  });

  it('alerts immediately when --sustained is 1', () => {
    const res = run(manyWl(6000, 7), ['--alert-threshold', '5', '--sustained', '1']);

    expect(res.exitCode).toBe(2);
    expect(res.output).toContain('ALERT');
  });

  it('honors a custom watch threshold via --watch-threshold', () => {
    const res = run(manyWl(7000, 12), ['--watch-threshold', '10']);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('WATCH');
  });

  it('emits machine-readable JSON with --json', () => {
    const res = run([wlLine(1001, 'node /usr/local/bin/wl list --json')], ['--json']);

    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.level).toBe('OK');
    expect(parsed.count).toBe(1);
    expect(parsed.watch_threshold).toBe(20);
    expect(parsed.alert_threshold).toBe(50);
    expect(parsed.sustained).toBe(3);
    expect(parsed.ticks).toBe(0);
  });

  it('emits an ALERT JSON payload with the process tree on stderr when sustained', () => {
    const lines = manyWl(8000, 60);
    run(lines, ['--json']);
    run(lines, ['--json']);
    const res = run(lines, ['--json']);

    expect(res.exitCode).toBe(2);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.level).toBe('ALERT');
    expect(parsed.count).toBe(60);
    expect(res.stderr).toContain('node /usr/local/bin/wl list --json');
  });

  it('counts direct node invocations of the worklog dist CLI', () => {
    const res = run([wlLine(1001, 'node /usr/local/lib/node_modules/worklog/dist/cli.js list --json')]);

    expect(res.exitCode).toBe(0);
    expect(fs.readFileSync(countFile, 'utf-8').trim()).toBe('1');
  });

  it('counts a bare worklog bin invocation', () => {
    const res = run([wlLine(1001, 'node /usr/local/bin/worklog sync')]);

    expect(res.exitCode).toBe(0);
    expect(fs.readFileSync(countFile, 'utf-8').trim()).toBe('1');
  });

  it('ignores unrelated node processes and ps/grep artifacts', () => {
    const res = run([
      wlLine(1001, 'node /usr/local/bin/other-server --port 3000'),
      wlLine(1002, 'grep -E ^node .*/(wl|worklog)([ /]|$)'),
      wlLine(1003, 'ps -eo args'),
      wlLine(1004, 'bash scripts/wl-process-healthcheck.sh --json'),
    ]);

    expect(res.exitCode).toBe(0);
    expect(fs.readFileSync(countFile, 'utf-8').trim()).toBe('0');
  });

  it('prints usage with --help and exits 0', () => {
    const res = run([], ['--help']);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Usage');
    expect(res.stdout).toContain('--alert-threshold');
  });
});
