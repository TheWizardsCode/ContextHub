/**
 * Tests for scripts/hostwatch.sh (WL-0MVY898D4007BZ28 AC-G)
 *
 * The sampler writes one structured `HOSTWATCH` journald line per tick with
 * k10temp/acpitz/MT7921e temps, loadavg, MemAvailable, wlp3s0 operstate and
 * mt7921e/NVRM error deltas since the previous sample. Tests inject fixture
 * kernel logs (HOSTWATCH_KLOG_FILE), a state file, and --dry-run to capture
 * output without touching the host.
 *
 * AC coverage:
 *   AC-G — structured HOSTWATCH line (boot/k10/acpit/load1/memavail_kb/
 *          wl_operstate/mt79_err_delta/nvrm_err_delta)
 *   AC-G — per-sample `info`, change-only `warning`
 *   AC-G — mt7921e/NVRM error counts since the previous sample (delta)
 *   AC-G — no nmcli/iw calls (script contains none — verified by the line shape)
 *   AC-G — reads sysfs/procfs only, timer-driven oneshot, no daemon
 */
import { execaSync } from 'execa';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'hostwatch.sh');

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string;
  state: string; // state file content after the run
}

describe('hostwatch.sh', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hostwatch-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function run(
    klogContent: string,
    state: string | null = null,
    extraArgs: string[] = [],
    bootId = 'boottest-123',
  ): RunResult {
    const klogPath = path.join(tmp, 'klog');
    fs.writeFileSync(klogPath, klogContent);
    const statePath = path.join(tmp, 'state');
    if (state !== null) fs.writeFileSync(statePath, state);
    fs.writeFileSync(path.join(tmp, 'boot'), bootId + '\n');
    const env = {
      ...process.env,
      HOSTWATCH_KLOG_FILE: klogPath,
      HOSTWATCH_STATE_FILE: statePath,
      HOSTWATCH_DRY_RUN: '1',
      // Deterministic boot id for delta tests.
      HOSTWATCH_BOOT_ID_FILE: path.join(tmp, 'boot'),
    };
    try {
      const res = execaSync('bash', [SCRIPT, '--dry-run', ...extraArgs], {
        env,
        encoding: 'utf-8',
      });
      return {
        exitCode: res.exitCode,
        stdout: res.stdout,
        stderr: res.stderr,
        output: res.stdout + res.stderr,
        state: fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf-8') : '',
      };
    } catch (err: any) {
      return {
        exitCode: err.exitCode ?? 1,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? '',
        output: (err.stdout ?? '') + (err.stderr ?? ''),
        state: fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf-8') : '',
      };
    }
  }

  it('emits one structured HOSTWATCH line with the required fields', () => {
    const res = run('');
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('HOSTWATCH ');
    expect(res.stdout).toContain('boot=');
    expect(res.stdout).toContain('k10=');
    expect(res.stdout).toContain('acpit=');
    expect(res.stdout).toContain('load1=');
    expect(res.stdout).toContain('memavail_kb=');
    expect(res.stdout).toContain('wl_operstate=');
    expect(res.stdout).toContain('mt79_err_delta=');
    expect(res.stdout).toContain('nvrm_err_delta=');
    expect(res.stdout).toContain('level=');
  });

  it('logs at info when nothing changed (no error delta, same boot)', () => {
    const first = run('');
    expect(first.stdout).toContain('level=info');
    const second = run('', first.state);
    expect(second.stdout).toContain('level=info');
    expect(second.stdout).toContain('mt79_err_delta=0');
    expect(second.stdout).toContain('nvrm_err_delta=0');
  });

  it('promotes to warning when mt7921e/mt76 error count increases', () => {
    // First sample: empty kernel log (baseline, delta 0).
    const baseline = run('');
    expect(baseline.stdout).toContain('mt79_err_delta=0');
    // Second sample: mt7921e driver timeout lines appear → delta 2, warning.
    const klog = [
      'mt7921e 0000:03:00.0: driver own failed',
      'mt7921e 0000:03:00.0: Timeout for driver own',
    ].join('\n');
    const second = run(klog, baseline.state);
    expect(second.stdout).toContain('mt79_err_delta=2');
    expect(second.stdout).toContain('level=warning');
  });

  it('promotes to warning when NVRM/Xid error count increases', () => {
    const baseline = run('');
    expect(baseline.stdout).toContain('nvrm_err_delta=0');
    const second = run('NVRM: GPU0 Xid 79\n', baseline.state);
    expect(second.stdout).toContain('nvrm_err_delta=1');
    expect(second.stdout).toContain('level=warning');
  });

  it('logs at info again when the error counts stop increasing', () => {
    const klog = ['mt7921e: driver own failed', 'mt7921e: Timeout for driver own'].join('\n');
    const baseline = run(''); // delta baseline (empty kernel log)
    const first = run(klog, baseline.state);
    expect(first.stdout).toContain('mt79_err_delta=2');
    expect(first.stdout).toContain('level=warning');
    // Same counts again → delta 0 → info.
    const second = run(klog, first.state);
    expect(second.stdout).toContain('mt79_err_delta=0');
    expect(second.stdout).toContain('level=info');
  });

  it('promotes to warning when the boot id changed between samples', () => {
    const first = run('');
    expect(first.stdout).toContain('level=info');
    // Simulate a reboot: different boot id.
    const bootChanged = run('', first.state, [], 'boottest-456');
    expect(bootChanged.stdout).toContain('level=warning');
  });

  it('reads sysfs/procfs sources and cannot perturb the Wi-Fi link', () => {
    const src = fs.readFileSync(SCRIPT, 'utf-8');
    // Sampler sources are sysfs/procfs paths (AC-G constraint).
    expect(src).toMatch(/\/sys\/class\/hwmon/);
    expect(src).toMatch(/\/sys\/class\/thermal/);
    expect(src).toMatch(/\/proc\/loadavg/);
    expect(src).toMatch(/\/proc\/meminfo/);
    // No command that could perturb the fragile Wi-Fi link (AC-G). The script
    // may mention the names only in comments/docstrings, never as commands.
    expect(src).not.toMatch(/\bnmcli[[:space:]]/);
    expect(src).not.toMatch(/\biw[[:space:]]dev/);
    expect(src).not.toMatch(/\bip[[:space:]]link/);
    // Writes go to the state file and journald only — no arbitrary file writes.
    expect(src).not.toMatch(/>>\s*\/(?!dev\/null)/);
    expect(src).not.toMatch(/>\s*\/(?!dev\/null)[a-zA-Z]/);
  });

  it('--json emits machine-readable output', () => {
    const res = run('', null, ['--json']);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout.split('\n')[0]);
    expect(parsed).toHaveProperty('boot');
    expect(parsed).toHaveProperty('k10');
    expect(parsed).toHaveProperty('mt79_err_delta');
    expect(parsed).toHaveProperty('level');
  });
});
