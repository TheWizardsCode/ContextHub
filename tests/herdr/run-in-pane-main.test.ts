/**
 * tests/herdr/run-in-pane-main.test.ts — Tests for scripts/run-in-pane.sh main mode
 *
 * Covers the main (split) mode of run-in-pane.sh, specifically the CWD
 * propagation fix (WL-0MS8SVY7P0094K6D): the script must pass `--cwd
 * <target>` to `herdr pane split` so the new pane starts in the correct
 * project directory instead of inheriting the source pane's CWD.
 *
 * The herdr CLI is mocked via HERDR_BIN_PATH pointing at a fake `herdr`
 * binary that records every invocation to a log file and returns a valid
 * pane_id for the split call.
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
  'scripts',
  'run-in-pane.sh',
);

let tmpDir: string;
let logFile: string;
let fakeHerdr: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'run-in-pane-main-test-'));
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
 * Run the script in main mode with the given args and env overrides.
 * Returns the exit status plus the recorded herdr invocations.
 */
function runMain(
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

describe('run-in-pane.sh main mode --cwd propagation', () => {
  it('passes HERDR_RESOLVED_CWD to pane split when set', () => {
    const { status, log } = runMain(['!!wl update <id> --priority high'], {
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
      execFileSync('bash', [SCRIPT, 'wl update <id> --priority high'], {
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

  it('runs the command through bash in the new pane', () => {
    const { status, log } = runMain(['--cwd', '/tmp/project-root', 'wl update <id> --priority high']);
    expect(status).toBe(0);
    // The command is bash-escaped (printf %q) when forwarded, so match on
    // escaped tokens rather than the exact string.
    const runLine = log.find((line) => line.includes('pane run') && line.includes('bash'));
    expect(runLine).toBeDefined();
    expect(runLine).toContain('wl\\ update');
    expect(runLine).toContain('--priority');
  });
});
