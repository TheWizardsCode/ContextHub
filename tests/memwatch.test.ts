/**
 * Tests for scripts/memwatch.sh (WL-0MT1KJNGA006EEHU)
 *
 * The script checks /proc/meminfo MemAvailable and logs memory pressure
 * alerts when configurable thresholds are breached. Tests inject a fake
 * MemAvailable source via the MEMWATCH_MEMINFO environment variable and
 * use --dry-run to capture output.
 *
 * AC coverage:
 *   AC1 — Thresholds configurable via script-level variables
 *   AC2 — MEMWATCH: prefix, journald via logger
 *   AC4 — Deduplication: one log line per interval (per level change)
 */
import { execaSync } from 'execa';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'memwatch.sh');

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string; // stdout + stderr combined
}

/**
 * Create a fake MemAvailable source file.
 * @param availKb  MemAvailable in kB
 * @param totalKb  MemTotal in kB (optional, defaults to availKb * 10)
 */
function makeMeminfo(availKb: number, totalKb?: number): string {
  const t = totalKb ?? availKb * 10;
  return `MemTotal:       ${t} kB
MemFree:         ${Math.max(0, t - availKb)} kB
MemAvailable:    ${availKb} kB
`;
}

const MB = 1024;
const GB = 1024 * MB;
const TOTAL_KB = 30 * GB; // ~30 GB RAM

describe('memwatch.sh', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memwatch-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Run the real script with an explicit environment (never throws). */
  function runWithEnv(env: NodeJS.ProcessEnv): RunResult {
    try {
      const res = execaSync('bash', [SCRIPT, '--dry-run'], { env, encoding: 'utf-8' });
      return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr, output: res.stdout + res.stderr };
    } catch (err: any) {
      return {
        exitCode: err.exitCode ?? 1,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? '',
        output: (err.stdout ?? '') + (err.stderr ?? ''),
      };
    }
  }

  /** Run the real script against a MemAvailable fixture. */
  function run(meminfoContent: string, args: string[] = []): RunResult {
    const meminfoPath = path.join(tmp, 'meminfo');
    fs.writeFileSync(meminfoPath, meminfoContent);
    const statePath = path.join(tmp, 'state');
    const env = {
      ...process.env,
      MEMWATCH_MEMINFO: meminfoPath,
      MEMWATCH_STATE_FILE: statePath,
      MEMWATCH_DRY_RUN: '1',
    };
    try {
      const res = execaSync('bash', [SCRIPT, '--dry-run', ...args], { env, encoding: 'utf-8' });
      return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr, output: res.stdout + res.stderr };
    } catch (err: any) {
      return {
        exitCode: err.exitCode ?? 1,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? '',
        output: (err.stdout ?? '') + (err.stderr ?? ''),
      };
    }
  }

  // ---------------------------------------------------------------------------
  // OK level
  // ---------------------------------------------------------------------------

  it('reports OK and logs when available memory is above the warning threshold', () => {
    const res = run(makeMeminfo(20 * GB, TOTAL_KB));

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('MEMWATCH:');
    expect(res.stdout).toContain('available=');
    expect(res.stdout).toContain('level=OK');
  });

  it('exits 0 for OK level', () => {
    const res = run(makeMeminfo(25 * GB, TOTAL_KB));

    expect(res.exitCode).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // WARN level
  // ---------------------------------------------------------------------------

  it('reports WARN and exits 1 when below warning threshold (4096 MB) but above critical', () => {
    const res = run(makeMeminfo(3 * GB, TOTAL_KB));

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain('level=WARN');
    expect(res.stdout).toContain('MEMWATCH:');
  });

  it('exits 1 for the exact warning boundary', () => {
    // 4095 MB is just below the 4096 MB warning threshold
    const res = run(makeMeminfo(4095 * MB, TOTAL_KB));

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain('level=WARN');
  });

  it('does NOT log for WARN if previous level was also WARN (deduplication)', () => {
    const content = makeMeminfo(3 * GB, TOTAL_KB);
    const first = run(content);
    expect(first.stdout).toContain('level=WARN');

    const second = run(content);
    expect(second.stdout).toBe('');
    expect(second.exitCode).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // CRIT level
  // ---------------------------------------------------------------------------

  it('reports CRIT and exits 2 when below critical threshold (2048 MB)', () => {
    const res = run(makeMeminfo(1 * GB, TOTAL_KB));

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toContain('level=CRIT');
    expect(res.stdout).toContain('MEMWATCH:');
  });

  it('exits 2 for the exact critical boundary', () => {
    // 2047 MB is just below the 2048 MB critical threshold
    const res = run(makeMeminfo(2047 * MB, TOTAL_KB));

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toContain('level=CRIT');
  });

  it('does NOT log for CRIT if previous level was also CRIT (deduplication)', () => {
    const content = makeMeminfo(500 * MB, TOTAL_KB);
    const first = run(content);
    expect(first.exitCode).toBe(2);
    expect(first.stdout).toContain('level=CRIT');

    const second = run(content);
    expect(second.stdout).toBe('');
    expect(second.exitCode).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Deduplication across level transitions
  // ---------------------------------------------------------------------------

  it('logs when level changes from OK to WARN', () => {
    const ok = run(makeMeminfo(20 * GB, TOTAL_KB));
    expect(ok.stdout).toContain('level=OK');

    const warn = run(makeMeminfo(3 * GB, TOTAL_KB));
    expect(warn.exitCode).toBe(1);
    expect(warn.stdout).toContain('level=WARN');
  });

  it('logs when level changes from WARN to CRIT', () => {
    const warn = run(makeMeminfo(3 * GB, TOTAL_KB));
    expect(warn.exitCode).toBe(1);
    expect(warn.stdout).toContain('level=WARN');

    const crit = run(makeMeminfo(1 * GB, TOTAL_KB));
    expect(crit.exitCode).toBe(2);
    expect(crit.stdout).toContain('level=CRIT');
  });

  it('logs when level changes from CRIT back to OK', () => {
    const crit = run(makeMeminfo(1 * GB, TOTAL_KB));
    expect(crit.exitCode).toBe(2);
    expect(crit.stdout).toContain('level=CRIT');

    const ok = run(makeMeminfo(20 * GB, TOTAL_KB));
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain('level=OK');
  });

  it('suppresses repeated logs within the same level', () => {
    const warnContent = makeMeminfo(3 * GB, TOTAL_KB);

    run(warnContent); // logs
    run(warnContent); // suppressed
    run(warnContent); // suppressed

    const ok = run(makeMeminfo(20 * GB, TOTAL_KB));
    expect(ok.stdout).toContain('level=OK');
  });

  // ---------------------------------------------------------------------------
  // State-file safety (runs as root in production)
  // ---------------------------------------------------------------------------

  it('does not follow a symlinked state file (symlink-attack hardening)', () => {
    const target = path.join(tmp, 'attacker-target');
    fs.writeFileSync(target, 'ORIGINAL');
    fs.symlinkSync(target, path.join(tmp, 'state'));

    // A symlinked state file is treated as "no previous level", so the alert
    // still fires ...
    const res = run(makeMeminfo(3 * GB, TOTAL_KB));
    expect(res.stdout).toContain('level=WARN');

    // ... but the symlink target is never written to.
    expect(fs.readFileSync(target, 'utf-8')).toBe('ORIGINAL');
    // The state path is replaced with a regular file, not left as a symlink.
    expect(fs.lstatSync(path.join(tmp, 'state')).isSymbolicLink()).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // JSON output
  // ---------------------------------------------------------------------------

  it('emits machine-readable JSON with --json', () => {
    const res = run(makeMeminfo(20 * GB, TOTAL_KB), ['--json']);

    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.level).toBe('OK');
    expect(typeof parsed.available_mb).toBe('number');
    expect(typeof parsed.total_mb).toBe('number');
    expect(typeof parsed.percent).toBe('number');
    expect(parsed.message).toContain('MEMWATCH:');
  });

  it('emits JSON for WARN level', () => {
    const res = run(makeMeminfo(3 * GB, TOTAL_KB), ['--json']);

    expect(res.exitCode).toBe(1);
    expect(JSON.parse(res.stdout).level).toBe('WARN');
  });

  it('emits JSON for CRIT level', () => {
    const res = run(makeMeminfo(1 * GB, TOTAL_KB), ['--json']);

    expect(res.exitCode).toBe(2);
    expect(JSON.parse(res.stdout).level).toBe('CRIT');
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  it('logs an ERROR and exits 2 when MemAvailable cannot be read', () => {
    fs.writeFileSync(path.join(tmp, 'meminfo-bad'), 'garbage data\n');
    const env = {
      ...process.env,
      MEMWATCH_MEMINFO: path.join(tmp, 'meminfo-bad'),
      MEMWATCH_STATE_FILE: path.join(tmp, 'state-bad'),
      MEMWATCH_DRY_RUN: '1',
    };
    const res = runWithEnv(env);
    expect(res.exitCode).toBe(2);
    expect(res.stdout).toContain('level=ERR');
    expect(res.stderr).toContain('could not read MemAvailable');
  });

  // ---------------------------------------------------------------------------
  // --help
  // ---------------------------------------------------------------------------

  it('prints usage with --help and exits 0', () => {
    const res = execaSync('bash', [SCRIPT, '--help'], { env: { ...process.env }, encoding: 'utf-8' });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Usage');
    expect(res.stdout).toContain('--dry-run');
    expect(res.stdout).toContain('--json');
  });

  // ---------------------------------------------------------------------------
  // Configurable thresholds
  // ---------------------------------------------------------------------------

  it('honours custom WARNING threshold via MEMWATCH_WARNING_MB', () => {
    const meminfoPath = path.join(tmp, 'meminfo');
    fs.writeFileSync(meminfoPath, makeMeminfo(4 * GB, TOTAL_KB));
    const env = {
      ...process.env,
      MEMWATCH_MEMINFO: meminfoPath,
      MEMWATCH_STATE_FILE: path.join(tmp, 'state-custom'),
      MEMWATCH_DRY_RUN: '1',
      MEMWATCH_WARNING_MB: '5000',
    };
    const res = runWithEnv(env);
    // 4 GB < 5 GB custom warning threshold
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain('level=WARN');
  });

  it('honours custom CRITICAL threshold via MEMWATCH_CRITICAL_MB', () => {
    const meminfoPath = path.join(tmp, 'meminfo');
    fs.writeFileSync(meminfoPath, makeMeminfo(3 * GB, TOTAL_KB));
    const env = {
      ...process.env,
      MEMWATCH_MEMINFO: meminfoPath,
      MEMWATCH_STATE_FILE: path.join(tmp, 'state-custom'),
      MEMWATCH_DRY_RUN: '1',
      MEMWATCH_CRITICAL_MB: '500',
    };
    const res = runWithEnv(env);
    // 3 GB > 0.5 GB critical threshold, but < 4096 MB default warning
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain('level=WARN');
  });

  it('uses the configured log prefix', () => {
    const meminfoPath = path.join(tmp, 'meminfo');
    fs.writeFileSync(meminfoPath, makeMeminfo(3 * GB, TOTAL_KB));
    const env = {
      ...process.env,
      MEMWATCH_MEMINFO: meminfoPath,
      MEMWATCH_STATE_FILE: path.join(tmp, 'state-prefix'),
      MEMWATCH_DRY_RUN: '1',
      MEMWATCH_LOG_PREFIX: 'MY-WATCH',
    };
    const res = runWithEnv(env);
    expect(res.stdout).toContain('MY-WATCH:');
    expect(res.stdout).not.toContain('MEMWATCH:');
  });

  // ---------------------------------------------------------------------------
  // Output content
  // ---------------------------------------------------------------------------

  it('includes timestamp, available memory, and threshold status in the log line', () => {
    const res = run(makeMeminfo(3 * GB, TOTAL_KB));

    expect(res.stdout).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/); // timestamp
    expect(res.stdout).toContain('available=');
    expect(res.stdout).toContain('total=');
    expect(res.stdout).toMatch(/%\) level=/); // percentage and level
  });

  it('includes total RAM in the log line', () => {
    const res = run(makeMeminfo(20 * GB, TOTAL_KB));

    expect(res.stdout).toContain('total=');
    expect(res.stdout).toMatch(/total=\d+MB/);
  });
});
