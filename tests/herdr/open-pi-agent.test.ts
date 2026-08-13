/**
 * tests/herdr/open-pi-agent.test.ts — Tests for shared/open-pi-agent.sh
 *
 * Verifies that an interactive pi agent pane is created in the correct
 * project directory (WL-0MS8SVY7P0094K6D): when a target CWD is available
 * (--cwd arg, HERDR_RESOLVED_CWD env, or $PWD), the script passes
 * `--cwd <target>` to `herdr pane split` so the new pane inherits the
 * correct project root instead of the source pane's CWD.
 *
 * The herdr CLI is mocked via HERDR_BIN_PATH pointing at a fake `herdr`
 * binary that records every invocation to a log file and returns a valid
 * pane_id for the split call.
 *
 * These tests exercise the PLAIN split path (--no-resize): the `--cwd`
 * propagation is implemented on `herdr pane split`, which resize mode
 * (the default) delegates to grid.py instead. Resize-mode behavior is
 * covered by packages/herdr/shared/tests/test_scripts.sh.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'packages',
  'herdr',
  'shared',
  'open-pi-agent.sh',
);

let tmpDir: string;
let logFile: string;
let fakeHerdr: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'open-pi-agent-test-'));
  logFile = join(tmpDir, 'herdr.log');

  // Fake herdr CLI: logs "$*" to the log file. For `pane split` it returns
  // a valid pane_id so the script proceeds; all other commands exit 0.
  fakeHerdr = join(tmpDir, 'herdr');
  writeFileSync(
    fakeHerdr,
    `#!/usr/bin/env bash
echo "$*" >> "${logFile}"
if [ "$1" = "pane" ] && [ "$2" = "split" ]; then
  echo '{"pane_id":"pane-123"}'
fi
exit 0
`,
  );
  chmodSync(fakeHerdr, 0o755);
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Run the script with the given args and env overrides.
 * Returns the exit status plus the recorded herdr invocations.
 */
function runScript(
  args: string[],
  envOverrides: Record<string, string> = {},
): { status: number; log: string[] } {
  let status = 0;
  const env: Record<string, string | undefined> = {
    ...process.env,
    HERDR_BIN_PATH: fakeHerdr,
  };
  delete env.HERDR_PANE_ID;
  delete env.HERDR_ENV;
  delete env.HERDR_RESOLVED_CWD;
  Object.assign(env, envOverrides);
  try {
    execFileSync('bash', [SCRIPT, ...args], {
      encoding: 'utf-8',
      env: env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as { status?: number };
    status = e.status ?? 1;
  }
  const log = existsSync(logFile) ? readFileSync(logFile, 'utf-8').split('\n').filter(Boolean) : [];
  rmSync(logFile, { force: true });
  return { status, log };
}

/** Return the `pane split` invocation (if any) from the recorded log. */
function splitInvocation(log: string[]): string | undefined {
  return log.find((line) => line.includes('pane split'));
}

describe('open-pi-agent.sh --cwd propagation', () => {
  it('passes --cwd to pane split when --cwd arg is provided', () => {
    const { status, log } = runScript(['--no-resize', '--cwd', '/tmp/project-root']);
    expect(status).toBe(0);
    const split = splitInvocation(log);
    expect(split).toBeDefined();
    expect(split).toContain('--cwd');
    expect(split).toContain('/tmp/project-root');
  });

  it('passes HERDR_RESOLVED_CWD to pane split when set', () => {
    const { status, log } = runScript(['--no-resize'], {
      HERDR_RESOLVED_CWD: '/home/user/projects/podcast',
    });
    expect(status).toBe(0);
    const split = splitInvocation(log);
    expect(split).toBeDefined();
    expect(split).toContain('--cwd');
    expect(split).toContain('/home/user/projects/podcast');
  });

  it('falls back to the script PWD when no target CWD is available', () => {
    const cwd = join(tmpDir, 'workdir');
    mkdirSync(cwd, { recursive: true });
    let status = 0;
    try {
      execFileSync('bash', [SCRIPT, '--no-resize'], {
        encoding: 'utf-8',
        cwd,
        env: {
          ...process.env,
          HERDR_BIN_PATH: fakeHerdr,
          HERDR_PANE_ID: '',
          HERDR_ENV: '',
          HERDR_RESOLVED_CWD: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const e = err as { status?: number };
      status = e.status ?? 1;
    }
    const log = existsSync(logFile) ? readFileSync(logFile, 'utf-8').split('\n').filter(Boolean) : [];
    rmSync(logFile, { force: true });
    expect(status).toBe(0);
    const split = splitInvocation(log);
    expect(split).toBeDefined();
    expect(split).toContain('--cwd');
    expect(split).toContain(cwd);
  });

  it('starts pi interactively in the new pane via the lease-release wrapper', () => {
    const { status, log } = runScript(['--no-resize', '--cwd', '/tmp/project-root']);
    expect(status).toBe(0);
    // The pane runs the lease-release wrapper (run-pi-agent.sh) with a
    // deterministic --session-id so the Local Proxy lease can be released
    // when the interactive pi session ends (WL-0MSGI7UIH008USVB).
    expect(log.some((line) => line.includes('pane run') && line.includes('run-pi-agent.sh'))).toBe(true);
    expect(log.some((line) => line.includes('pane run') && /herdr-\d+-\d+-\d+/.test(line))).toBe(true);
  });
});
