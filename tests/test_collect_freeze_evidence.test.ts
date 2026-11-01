/**
 * Tests for scripts/collect-freeze-evidence.sh (WL-0MVY898D4007BZ28 AC-H)
 *
 * The evidence-bundle script gathers vmcore/crash-dmesg, HOSTWATCH samples and
 * the previous-boot kernel tail, then classifies the boot end against the
 * crash register: silent / mt7921e-timeout / NVRM-storm / panic-dump-available
 * (plus clean-shutdown). It emits SUMMARY.md whose first line is the
 * classification + confidence, and FAILS (exit 3) on an unrecognised shape —
 * it must never silently report "unknown".
 *
 * Tests run the real script with journal fixtures via env overrides
 * (BF_KLOGFILE, BF_DMESG_FILE) and assert the SUMMARY.md first line + exit code.
 *
 * AC coverage:
 *   AC-H — SUMMARY.md first line = "Classification: <class> (confidence: …)"
 *   AC-H — classes silent / mt7921e-timeout / NVRM-storm / panic-dump-available
 *   AC-H — unrecognised shape MUST fail with exit 3 (never "unknown")
 *   AC-H — clean-shutdown distinguishable from a silent freeze (AC-I input)
 *   AC-H — gathers vmcore + crash dmesg (panic-dump-available precedence)
 */
import { execaSync } from 'execa';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'collect-freeze-evidence.sh');

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string;
  summaryFirst?: string;
}

describe('collect-freeze-evidence.sh', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-evidence-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function run(
    opts: { klog?: string; dmesg?: string; hostwatch?: string } = {},
    outDir?: string,
  ): RunResult {
    const klogPath = path.join(tmp, 'klog');
    const dmesgPath = path.join(tmp, 'dmesg');
    const hostwatchPath = path.join(tmp, 'hostwatch');
    fs.writeFileSync(klogPath, opts.klog ?? '');
    fs.writeFileSync(dmesgPath, opts.dmesg ?? '');
    fs.writeFileSync(hostwatchPath, opts.hostwatch ?? '');
    const out = outDir ?? path.join(tmp, 'out');
    const env = {
      ...process.env,
      BF_KLOGFILE: klogPath,
      BF_DMESG_FILE: dmesgPath,
      BF_HOSTWATCH_FILE: hostwatchPath,
      BF_OUT_DIR: out,
    };
    try {
      const res = execaSync('bash', [SCRIPT, '--out', out], { env, encoding: 'utf-8' });
      const summary = path.join(out, 'SUMMARY.md');
      return {
        exitCode: res.exitCode,
        stdout: res.stdout,
        stderr: res.stderr,
        output: res.stdout + res.stderr,
        summaryFirst: fs.existsSync(summary)
          ? fs.readFileSync(summary, 'utf-8').split('\n')[0]
          : undefined,
      };
    } catch (err: any) {
      // execa throws on non-zero exit — that's the assertion point for FAIL.
      const summary = path.join(out, 'SUMMARY.md');
      return {
        exitCode: err.exitCode ?? 1,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? '',
        output: (err.stdout ?? '') + (err.stderr ?? ''),
        summaryFirst: fs.existsSync(summary)
          ? fs.readFileSync(summary, 'utf-8').split('\n')[0]
          : undefined,
      };
    }
  }

  it('classifies mt7921e timeout loops as mt7921e-timeout (medium)', () => {
    const res = run({
      klog: [
        'mt7921e 0000:03:00.0: driver own failed',
        'mt7921e 0000:03:00.0: Timeout for driver own',
        'mt7921e 0000:03:00.0: chip reset failed',
        'kernel: random: crng init done',
      ].join('\n'),
    });
    expect(res.exitCode).toBe(0);
    expect(res.summaryFirst).toMatch(/^Classification: mt7921e-timeout \(confidence: medium\)$/);
  });

  it('classifies an NVRM/Xid storm as NVRM-storm', () => {
    const res = run({
      klog: [
        'NVRM: GPU0 RmCheckForGcxSupportOnCurrentState: NVRM, Failed to get GCx pre-requisite',
        'NVRM: GPU0 Xid 79',
        'kernel: random: crng init done',
      ].join('\n'),
    });
    expect(res.exitCode).toBe(0);
    expect(res.summaryFirst).toMatch(/^Classification: NVRM-storm \(confidence: medium\)$/);
  });

  it('prefers a real panic dmesg over kernel-tail inference (panic-dump-available)', () => {
    const res = run({
      klog: ['mt7921e 0000:03:00.0: driver own failed', 'kernel: random: crng init done'].join('\n'),
      dmesg: [
        'Oops: 0002 [#1] SMP NOPTI',
        'RIP: 0010:mt76_dma_add_buf.isra.0+0x90/0x200 [mt76]',
        'Kernel panic - not syncing: Fatal exception',
      ].join('\n'),
    });
    expect(res.exitCode).toBe(0);
    expect(res.summaryFirst).toMatch(
      /^Classification: panic-dump-available \(confidence: high\)$/,
    );
  });

  it('distinguishes a deliberate clean shutdown from a silent freeze', () => {
    const clean = run(
      {
        klog: [
          'systemd[1]: Reached target shutdown.target',
          'systemd[1]: Powering off.',
        ].join('\n'),
      },
      path.join(tmp, 'out-clean'),
    );
    expect(clean.exitCode).toBe(0);
    expect(clean.summaryFirst).toMatch(/^Classification: clean-shutdown \(confidence: high\)$/);

    const silent = run(
      {
        klog: ['kernel: random: crng init done', 'systemd[1]: Started Daily apt download activities'].join('\n'),
      },
      path.join(tmp, 'out-silent'),
    );
    expect(silent.exitCode).toBe(0);
    expect(silent.summaryFirst).toMatch(/^Classification: silent \(confidence: low\)$/);
  });

  it('fails (exit 3) on an unrecognised shape — never silently "unknown"', () => {
    const res = run({}); // empty fixtures: no klog lines, no dmesg, no vmcore
    expect(res.exitCode).toBe(3);
    expect(res.summaryFirst ?? '').not.toMatch(/^Classification: unknown/);
    expect(res.summaryFirst ?? '').not.toMatch(/silent/);
  });

  it('writes a bundle with HOSTWATCH samples, boots list and kernel tail', () => {
    const res = run({
      klog: ['mt7921e: driver own failed', 'kernel: random: crng init done'].join('\n'),
      hostwatch: ['HOSTWATCH boot=b mt79_err_delta=0 level=info', 'HOSTWATCH boot=b mt79_err_delta=1 level=warning'].join('\n'),
    });
    expect(res.exitCode).toBe(0);
    for (const f of ['SUMMARY.md', 'hostwatch-samples.txt', 'previous-boot-kernel-tail.txt', 'boots.txt']) {
      expect(fs.existsSync(path.join(tmp, 'out', f)), f).toBe(true);
    }
  });

  it('emits --json output with classification fields', () => {
    const klog = path.join(tmp, 'klog');
    fs.writeFileSync(klog, 'mt7921e: driver own failed\n');
    const env = {
      ...process.env,
      BF_KLOGFILE: klog,
      BF_DMESG_FILE: path.join(tmp, 'dmesg'),
      BF_HOSTWATCH_FILE: path.join(tmp, 'hostwatch'),
    };
    fs.writeFileSync(path.join(tmp, 'dmesg'), '');
    fs.writeFileSync(path.join(tmp, 'hostwatch'), '');
    const res = execaSync('bash', [SCRIPT, '--json', '--out', path.join(tmp, 'outjson')], {
      env,
      encoding: 'utf-8',
    });
    expect(res.exitCode).toBe(0);
    const jsonLine = res.stdout.split('\n').find((l) => l.startsWith('{'));
    expect(jsonLine).toBeTruthy();
    const parsed = JSON.parse(jsonLine as string);
    expect(parsed.classification).toBe('mt7921e-timeout');
    expect(parsed.confidence).toBe('medium');
    expect(parsed.out_dir).toBe(path.join(tmp, 'outjson'));
  });
});
