/**
 * Tests for scripts/crash-reporting-check.sh (WL-0MT1KJNMV0018SWP)
 *
 * The script verifies apport/whoopsie/kdump/retention/disk in one pass and
 * reports OK/WARN/ALERT. Tests run the real script with env overrides and a
 * fake `systemctl` injected into PATH so no sudo or real system state is
 * required. Disk checks use a temp crash dir with synthetic files.
 */
import { execaSync } from 'execa';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'crash-reporting-check.sh');

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string;
}

function installFakeSystemctl(
  dir: string,
  opts: { apportEnabled?: boolean; whoopsiePathEnabled?: boolean; kdumpActive?: boolean } = {},
): void {
  const { apportEnabled = true, whoopsiePathEnabled = false, kdumpActive = true } = opts;
  const fake = path.join(dir, 'systemctl');
  fs.writeFileSync(
    fake,
    `#!/usr/bin/env bash
set -euo pipefail
# Fake systemctl for crash-reporting-check tests.
# Supports: is-enabled apport|whoopsie.path, is-active kdump-tools.service, status ...
if [[ "$1" == "is-enabled" ]]; then
  case "$2" in
    apport) ${apportEnabled ? 'exit 0' : 'exit 1'} ;;
    whoopsie.path) ${whoopsiePathEnabled ? 'exit 0' : 'exit 1'} ;;
    *) exit 1 ;;
  esac
elif [[ "$1" == "is-active" ]]; then
  case "$2" in
    kdump-tools.service|kdump-tools) ${kdumpActive ? 'exit 0' : 'exit 1'} ;;
    *) exit 1 ;;
  esac
elif [[ "$1" == "status" ]]; then
  ${kdumpActive ? 'exit 0' : 'exit 1'}
else
  exit 1
fi
`,
  );
  fs.chmodSync(fake, 0o755);
}

describe('crash-reporting-check.sh', () => {
  let tmp: string;
  let binDir: string;
  let envBase: Record<string, string>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-check-test-'));
    binDir = path.join(tmp, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    envBase = { ...process.env } as Record<string, string>;
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeFile(p: string, content: string): void {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }

  function makeFs(opts: {
    enabled?: string;
    corePattern?: string;
    useKdump?: string;
    crashDir?: string;
    cronExists?: boolean;
    cronExecutable?: boolean;
    whoopsieEnabled?: boolean;
    kdumpActive?: boolean;
  } = {}): { env: Record<string, string>; crashDir: string } {
    const {
      enabled = '1',
      corePattern = '|/usr/share/apport/apport -p%p -s%s -c%c -d%d -P%P -u%u -g%g -F%F -- %E',
      useKdump = '1',
      cronExists = true,
      cronExecutable = true,
      whoopsieEnabled = true,
      kdumpActive = true,
    } = opts;

    const apportFile = path.join(tmp, 'apport-default');
    writeFile(apportFile, `enabled=${enabled}\n`);

    const coreFile = path.join(tmp, 'core_pattern');
    writeFile(coreFile, corePattern);

    const kdumpFile = path.join(tmp, 'kdump-default');
    writeFile(kdumpFile, `USE_KDUMP=${useKdump}\n`);

    const crashDir = opts.crashDir ?? path.join(tmp, 'crash');
    fs.mkdirSync(crashDir, { recursive: true });

    const kexecCmd = path.join(crashDir, 'kexec_cmd');
    writeFile(kexecCmd, '/sbin/kexec -p ...');

    const kdumpVmlinuz = path.join(tmp, 'vmlinuz');
    writeFile(kdumpVmlinuz, '');

    const cronFile = path.join(tmp, 'cron-apport');
    if (cronExists) {
      writeFile(cronFile, '#!/bin/sh\n');
      if (cronExecutable) fs.chmodSync(cronFile, 0o755);
      else fs.chmodSync(cronFile, 0o644);
    }

    installFakeSystemctl(binDir, {
      apportEnabled: true,
      whoopsiePathEnabled: whoopsieEnabled,
      kdumpActive,
    });

    const env: Record<string, string> = {
      ...envBase,
      PATH: `${binDir}:${envBase.PATH ?? ''}`,
      APPORT_DEFAULT_FILE: apportFile,
      CORE_PATTERN_FILE: coreFile,
      KDUMP_DEFAULT_FILE: kdumpFile,
      KEXEC_CMD_FILE: kexecCmd,
      KDUMP_VMLINUZ: kdumpVmlinuz,
      CRON_APPORT_FILE: cronFile,
      CRASH_DIR: crashDir,
    };

    return { env, crashDir };
  }

  function run(args: string[] = [], env: Record<string, string>): RunResult {
    try {
      const res = execaSync('bash', [SCRIPT, ...args], { env, encoding: 'utf-8' });
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

  it('reports OK when all checks pass', () => {
    const { env } = makeFs({ whoopsieEnabled: true });
    const res = run([], env);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('crash-reporting-check: OK');
    expect(res.stdout).toContain('apport:    OK');
    expect(res.stdout).toContain('whoopsie:  OK');
    expect(res.stdout).toContain('kdump:     OK');
    expect(res.stdout).toContain('retention: OK');
    expect(res.stdout).toContain('disk:      OK');
  });

  it('emits JSON with all sections when --json is used', () => {
    const { env } = makeFs({ whoopsieEnabled: true });
    const res = run(['--json'], env);
    expect(res.exitCode).toBe(0);
    const j = JSON.parse(res.stdout);
    expect(j.level).toBe('OK');
    expect(j.apport.status).toBe('OK');
    expect(j.whoopsie.status).toBe('OK');
    expect(j.kdump.status).toBe('OK');
    expect(j.retention.status).toBe('OK');
    expect(j.disk.status).toBe('OK');
    expect(j.apport.enabled).toBe('1');
    expect(j.kdump.use_kdump).toBe('1');
  });

  it('reports WARN when whoopsie.path is disabled (overall WARN, exit 0)', () => {
    const { env } = makeFs({ whoopsieEnabled: false });
    const res = run([], env);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('WARN');
    expect(res.stdout).toContain('whoopsie:  WARN');
    expect(res.stdout).toContain('whoopsie.path disabled');
    // JSON also reflects WARN
    const j = JSON.parse(run(['--json'], env).stdout);
    expect(j.level).toBe('WARN');
    expect(j.whoopsie.status).toBe('WARN');
  });

  it('reports ALERT (exit 2) when apport is disabled (enabled != 1)', () => {
    const { env } = makeFs({ enabled: '0', whoopsieEnabled: true });
    const res = run([], env);
    expect(res.exitCode).toBe(2);
    expect(res.stdout).toContain('ALERT');
    expect(res.stdout).toContain('apport:    ALERT');
    const j = JSON.parse(run(['--json'], env).stdout);
    expect(j.level).toBe('ALERT');
    expect(j.apport.status).toBe('ALERT');
  });

  it('reports ALERT (exit 2) when core_pattern is not piped to apport', () => {
    const { env } = makeFs({ corePattern: 'core', whoopsieEnabled: true });
    const res = run([], env);
    expect(res.exitCode).toBe(2);
    expect(res.stdout).toContain('ALERT');
    expect(res.stdout).toContain('core_pattern not piped to apport');
  });

  it('reports WARN when kdump USE_KDUMP=0', () => {
    const { env } = makeFs({ useKdump: '0', whoopsieEnabled: true });
    const res = run([], env);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('WARN');
    expect(res.stdout).toContain('kdump:     WARN');
    expect(res.stdout).toContain('USE_KDUMP=0');
  });

  it('reports WARN when kexec_cmd is missing', () => {
    const { env, crashDir } = makeFs({ whoopsieEnabled: true });
    fs.unlinkSync(path.join(crashDir, 'kexec_cmd'));
    const res = run([], env);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('kdump:     WARN');
    expect(res.stdout).toContain('kexec_cmd');
  });

  it('reports WARN when retention cron is missing', () => {
    const { env } = makeFs({ cronExists: false, whoopsieEnabled: true });
    const res = run([], env);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('retention: WARN');
  });

  it('reports WARN when retention cron is not executable', () => {
    const { env } = makeFs({ cronExists: true, cronExecutable: false, whoopsieEnabled: true });
    const res = run([], env);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('retention: WARN');
    expect(res.stdout).toContain('not executable');
  });

  it('reports WARN when /var/crash largest file exceeds --warn-file-mb', () => {
    const { env, crashDir } = makeFs({ whoopsieEnabled: true });
    // Create a ~2 MB file (over 1 MB threshold but under default 500 MB)
    const big = path.join(crashDir, '_usr_bin_node.1000.crash');
    fs.writeFileSync(big, Buffer.alloc(2 * 1024 * 1024, 0x41));
    const res = run(['--warn-file-mb', '1'], env);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('disk:      WARN');
    expect(res.stdout).toContain('largest file');
  });

  it('respects --crash-dir override', () => {
    const { env } = makeFs({ whoopsieEnabled: true });
    const alt = path.join(tmp, 'alt-crash');
    fs.mkdirSync(alt, { recursive: true });
    const big = path.join(alt, 'big.crash');
    fs.writeFileSync(big, Buffer.alloc(2 * 1024 * 1024, 0x41));
    const res = run(['--crash-dir', alt, '--warn-file-mb', '1'], env);
    expect(res.stdout).toContain('disk:      WARN');
    expect(res.stdout).toContain('largest file');
  });

  it('prints usage with --help and exits 0', () => {
    const { env } = makeFs({});
    const res = run(['--help'], env);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Usage');
    expect(res.stdout).toContain('--warn-file-mb');
  });
});
