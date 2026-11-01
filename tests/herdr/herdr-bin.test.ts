/**
 * tests/herdr/herdr-bin.test.ts — shell CLI resolver + stale-binary regression
 * (WL-0MVXRZL9H001GQ7A).
 *
 * WHY: after an in-place `herdr update`, the running server injects its own
 * `/proc/self/exe` into every pane and plugin action. Linux renders the
 * replaced inode as `<path> (deleted)`, so every plugin action inherited a
 * path that can never be executed. `shared/herdr-bin.sh` strips that marker,
 * validates the result and falls back to `herdr` on PATH.
 *
 * These tests pin the shell resolver contract and prove the two entry points
 * that broke (prefix+l → open-worklog-tab.sh, dispatch → send-to-pi.sh) work
 * again with a stale HERDR_BIN_PATH.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const HERDR_PKG = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'packages',
  'herdr',
);
const RESOLVER = join(HERDR_PKG, 'shared', 'herdr-bin.sh');
const OPEN_WORKLOG_TAB = join(HERDR_PKG, 'scripts', 'open-worklog-tab.sh');
const SEND_TO_PI = join(HERDR_PKG, 'shared', 'send-to-pi.sh');

let root: string;
let mockHerdr: string;
let herdrLog: string;
let pathDir: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'herdr-bin-shell-'));
  herdrLog = join(root, 'herdr.log');
  mockHerdr = join(root, 'herdr');
  // Mock herdr CLI: logs every call and answers what the scripts need.
  writeFileSync(
    mockHerdr,
    `#!/usr/bin/env bash
echo "herdr:$*" >> "${herdrLog}"
case "$1" in
  pane)
    case "$2" in
      current)
        echo '{"result":{"pane":{"pane_id":"anchor-pane-9","cwd":"/mock/project"}}}'
        ;;
      process-info)
        echo '{"result":{"process_info":{"shell_pid":""}}}'
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  plugin)
    if [ "$2" = "pane" ] && [ "$3" = "open" ]; then
      echo '{"result":{"plugin_pane":{"pane":{"tab_id":"w9:tPE","pane_id":"w9:p1"}}}}'
      exit 0
    fi
    exit 1
    ;;
  tab)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
  );
  chmodSync(mockHerdr, 0o755);

  // A PATH directory that provides `herdr`, used for the fallback cases.
  pathDir = join(root, 'path-bin');
  mkdirSync(pathDir, { recursive: true });
  copyFileSync(mockHerdr, join(pathDir, 'herdr'));
  chmodSync(join(pathDir, 'herdr'), 0o755);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Source the resolver and run it with a controlled environment. */
function resolve(env: Record<string, string>): { status: number; stdout: string } {
  const result = spawnSync(
    'bash',
    ['-c', 'set -uo pipefail; . "$1"; resolve_herdr_bin', '_', RESOLVER],
    {
      encoding: 'utf-8',
      env: { PATH: '/usr/bin:/bin', ...env },
    },
  );
  return { status: result.status ?? -1, stdout: (result.stdout ?? '').trim() };
}

/** Run a plugin shell entry point with a controlled environment. */
function runScript(
  script: string,
  args: string[],
  env: Record<string, string>,
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('bash', [script, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, PATH: `/usr/bin:/bin:${pathDir}`, ...env },
    input: '',
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('resolve_herdr_bin', () => {
  it('returns "herdr" when HERDR_BIN_PATH is unset', () => {
    expect(resolve({})).toEqual({ status: 0, stdout: 'herdr' });
  });

  it('returns "herdr" when HERDR_BIN_PATH is empty', () => {
    expect(resolve({ HERDR_BIN_PATH: '' })).toEqual({ status: 0, stdout: 'herdr' });
  });

  it('uses an explicit, existing binary path unchanged', () => {
    expect(resolve({ HERDR_BIN_PATH: mockHerdr })).toEqual({
      status: 0,
      stdout: mockHerdr,
    });
  });

  it('strips a " (deleted)" suffix and uses the replaced binary', () => {
    expect(resolve({ HERDR_BIN_PATH: `${mockHerdr} (deleted)` })).toEqual({
      status: 0,
      stdout: mockHerdr,
    });
  });

  it('falls back to herdr on PATH when the stale path no longer exists', () => {
    expect(
      resolve({
        HERDR_BIN_PATH: join(root, 'gone', 'herdr (deleted)'),
        PATH: `/usr/bin:/bin:${pathDir}`,
      }),
    ).toEqual({ status: 0, stdout: join(pathDir, 'herdr') });
  });

  it('falls back to herdr on PATH when HERDR_BIN_PATH does not exist', () => {
    expect(
      resolve({
        HERDR_BIN_PATH: join(root, 'missing', 'herdr'),
        PATH: `/usr/bin:/bin:${pathDir}`,
      }),
    ).toEqual({ status: 0, stdout: join(pathDir, 'herdr') });
  });

  it('falls back to herdr on PATH when HERDR_BIN_PATH is not executable', () => {
    const notExecutable = join(root, 'not-executable');
    writeFileSync(notExecutable, 'not a program\n');
    chmodSync(notExecutable, 0o644);
    expect(
      resolve({
        HERDR_BIN_PATH: notExecutable,
        PATH: `/usr/bin:/bin:${pathDir}`,
      }),
    ).toEqual({ status: 0, stdout: join(pathDir, 'herdr') });
  });

  it('reports failure and names the stripped path when nothing resolves', () => {
    expect(
      resolve({
        HERDR_BIN_PATH: join(root, 'nowhere', 'herdr (deleted)'),
        PATH: '/usr/bin:/bin',
      }),
    ).toEqual({ status: 1, stdout: join(root, 'nowhere', 'herdr') });
  });
});

describe('plugin entry points with a stale HERDR_BIN_PATH', () => {
  it('open-worklog-tab.sh (prefix+l) still opens and renames the tab', () => {
    rmSync(herdrLog, { force: true });
    const result = runScript(OPEN_WORKLOG_TAB, [], {
      HERDR_BIN_PATH: `${mockHerdr} (deleted)`,
      HERDR_PANE_ID: '',
    });
    expect(result.status, result.stderr).toBe(0);
    // The success line is written to stderr (plugin log stream).
    expect(`${result.stdout}${result.stderr}`).toContain('Opened worklog tab');
    const log = execFileSync('cat', [herdrLog], { encoding: 'utf-8' });
    expect(log).toContain('plugin pane open');
    expect(log).toContain('tab rename w9:tPE Worklog');
  });

  it('send-to-pi.sh --check-cli accepts a stale HERDR_BIN_PATH', () => {
    const result = runScript(SEND_TO_PI, ['--check-cli', 'hello'], {
      HERDR_BIN_PATH: `${mockHerdr} (deleted)`,
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it('send-to-pi.sh --check-cli falls back to herdr on PATH', () => {
    const result = runScript(SEND_TO_PI, ['--check-cli', 'hello'], {
      HERDR_BIN_PATH: join(root, 'gone', 'herdr (deleted)'),
    });
    expect(result.status, result.stderr).toBe(0);
  });
});
