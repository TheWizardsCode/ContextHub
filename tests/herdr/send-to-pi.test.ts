/**
 * tests/herdr/send-to-pi.test.ts — Tests for shared/send-to-pi.sh
 *
 * Verifies that the new pi agent pane is created in the correct project
 * directory (WL-0MS8SVY7P0094K6D): when a target CWD is available
 * (--cwd arg, HERDR_RESOLVED_CWD env, or $PWD), the script passes
 * `--cwd <target>` to `herdr pane split` so the new pane inherits the
 * correct project root instead of the source pane's CWD.
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
  'shared',
  'send-to-pi.sh',
);

let tmpDir: string;
let logFile: string;
let fakeHerdr: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'send-to-pi-test-'));
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
  // Strip herdr-related env from the test runner itself so the script
  // uses only what we explicitly pass.
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
  // Reset the log between runs
  rmSync(logFile, { force: true });
  return { status, log };
}

/** Return the `pane split` invocation (if any) from the recorded log. */
function splitInvocation(log: string[]): string | undefined {
  return log.find((line) => line.includes('pane split'));
}

describe('send-to-pi.sh --cwd propagation', () => {
  it('passes --cwd to pane split when --cwd arg is provided', () => {
    const { status, log } = runScript(['--cwd', '/tmp/project-root', '/skill:audit <id>']);
    expect(status).toBe(0);
    const split = splitInvocation(log);
    expect(split).toBeDefined();
    expect(split).toContain('--cwd');
    expect(split).toContain('/tmp/project-root');
  });

  it('passes HERDR_RESOLVED_CWD to pane split when set', () => {
    const { status, log } = runScript(['/skill:audit <id>'], {
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
      execFileSync('bash', [SCRIPT, '/skill:audit <id>'], {
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

  it('still sends the command to the pi pane', () => {
    const { status, log } = runScript(['--cwd', '/tmp/project-root', '/skill:audit <id>']);
    expect(status).toBe(0);
    // The command is bash-escaped (printf %q) when forwarded, so match on
    // the unescaped token rather than the exact string.
    expect(log.some((line) => line.includes('pane run') && line.includes('/skill:audit'))).toBe(true);
  });
});

describe('send-to-pi.sh --model forwarding', () => {
  it('passes --model to the pi invocation when --model is provided', () => {
    const { status, log } = runScript(['--cwd', '/tmp/project-root', '--model', 'code', '/skill:implement <id>']);
    expect(status).toBe(0);
    const run = log.find((line) => line.includes('pane run'));
    expect(run).toBeDefined();
    expect(run).toContain('--model');
    expect(run).toContain('code');
    expect(run).toContain('/skill:implement');
  });

  it('supports the --model=<pattern> syntax', () => {
    const { status, log } = runScript(['--cwd', '/tmp/project-root', '--model=code', '/skill:implement <id>']);
    expect(status).toBe(0);
    const run = log.find((line) => line.includes('pane run'));
    expect(run).toBeDefined();
    expect(run).toContain('--model');
    expect(run).toContain('code');
  });

  it('omits --model from the pi invocation when not provided', () => {
    const { status, log } = runScript(['--cwd', '/tmp/project-root', '/skill:implement <id>']);
    expect(status).toBe(0);
    const run = log.find((line) => line.includes('pane run'));
    expect(run).toBeDefined();
    expect(run).not.toContain('--model');
    expect(run).not.toContain('code');
  });
});
