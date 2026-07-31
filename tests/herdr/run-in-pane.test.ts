/**
 * tests/herdr/run-in-pane.test.ts — Tests for scripts/run-in-pane.sh
 *
 * Covers the `--exec` in-pane wrapper mode (WL-0MS9HIUE0002JAKQ):
 *  - exit 0  → pane is NOT auto-closed (no `herdr pane close` invocation);
 *              the script prints the exit status and a close hint.
 *  - non-zero → pane is NOT closed either (failure stays open), status reported.
 *  - empty command → usage error, exit 1.
 *
 * The herdr CLI is mocked via HERDR_BIN_PATH pointing at a fake `herdr`
 * binary that records every invocation to a log file.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
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
  tmpDir = mkdtempSync(join(tmpdir(), 'run-in-pane-test-'));
  logFile = join(tmpDir, 'herdr.log');

  // Fake herdr CLI: logs "$*" to the log file, exits 0.
  fakeHerdr = join(tmpDir, 'herdr');
  writeFileSync(fakeHerdr, `#!/usr/bin/env bash\necho "$*" >> "${logFile}"\nexit 0\n`);
  chmodSync(fakeHerdr, 0o755);
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function runExec(args: string[]): { status: number; stdout: string; stderr: string; log: string[] } {
  let status = 0;
  let stdout = '';
  let stderr = '';
  // The test runner itself may run inside a herdr pane (HERDR_PANE_ID set
  // in process.env); strip it so the wrapper takes the non-interactive path.
  const env = { ...process.env, HERDR_BIN_PATH: fakeHerdr };
  delete env.HERDR_PANE_ID;
  delete env.HERDR_ENV;
  try {
    stdout = execFileSync('bash', [SCRIPT, '--exec', ...args], {
      encoding: 'utf-8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'], // stdin not a TTY → non-interactive path
    });
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    status = e.status ?? 1;
    stdout = e.stdout ?? '';
    stderr = e.stderr ?? '';
  }
  const log = existsSync(logFile) ? readFileSync(logFile, 'utf-8').split('\n').filter(Boolean) : [];
  // Reset the log between runs
  rmSync(logFile, { force: true });
  return { status, stdout, stderr, log };
}

/**
 * Runs the wrapper with a PTY on stdin (simulating a real herdr pane) and
 * asserts the process does NOT exit on its own — it stays alive so the pane
 * remains open — until we send a newline to dismiss it.
 */
function runExecPty(args: string[]): { status: number; output: string } {
  const py = `
import os, pty, sys, time, select

pid, fd = pty.fork()
if pid == 0:
    os.environ['HERDR_BIN_PATH'] = ${JSON.stringify(fakeHerdr)}
    os.environ.pop('HERDR_PANE_ID', None)
    os.environ.pop('HERDR_ENV', None)
    os.execvp('bash', ['bash', ${JSON.stringify(SCRIPT)}, '--exec', *${JSON.stringify(args)}])
    os._exit(127)

output = b''
start = time.time()
alive = True
# Read for up to 3s: the process must NOT exit on its own (it is waiting).
while time.time() - start < 3.0:
    r, _, _ = select.select([fd], [], [], 0.1)
    if fd in r:
        try:
            data = os.read(fd, 4096)
        except OSError:
            data = b''
        if not data:
            break
        output += data
    # Check whether the child is still running
    wpid, status = os.waitpid(pid, os.WNOHANG)
    if wpid != 0:
        alive = False
        break

if not alive:
    print('EXITED_EARLY')
    print(output.decode(errors='replace'))
    sys.exit(2)

# Dismiss by pressing Enter
os.write(fd, b'\\n')
while True:
    r, _, _ = select.select([fd], [], [], 1.0)
    if fd in r:
        try:
            data = os.read(fd, 4096)
        except OSError:
            data = b''
        if data:
            output += data
    wpid, status = os.waitpid(pid, os.WNOHANG)
    if wpid != 0:
        break

os.close(fd)
if os.WIFEXITED(status):
    print('STATUS=%d' % os.WEXITSTATUS(status))
    print(output.decode(errors='replace'))
    sys.exit(0)
print('NON_ZERO_EXIT')
print(output.decode(errors='replace'))
sys.exit(3)
`;
  const stdout = execFileSync('python3', ['-c', py], { encoding: 'utf-8' });
  const m = stdout.match(/STATUS=(\d+)/);
  return { status: m ? Number(m[1]) : -1, output: stdout };
}

describe('run-in-pane.sh --exec', () => {
  it('does not close the pane on exit 0 (pane stays open for inspection)', () => {
    const { status, stdout, log } = runExec(['true', 'pane-123']);
    expect(status).toBe(0);
    expect(stdout).toContain('Command exited with status 0');
    expect(log).toEqual([]); // no `herdr pane close` call
  });

  it('does not close the pane on exit 0 for a real wl-style command', () => {
    const { status, stdout, log } = runExec(['echo hello world', 'pane-123']);
    expect(status).toBe(0);
    expect(stdout).toContain('hello world');
    expect(stdout).toContain('Command exited with status 0');
    expect(log).toEqual([]);
  });

  it('prints a close hint in an interactive (TTY) pane', () => {
    const { output } = runExecPty(['true', 'pane-123']);
    // Hint must mention closing the pane (Enter / prefix+x)
    expect(output).toMatch(/prefix\+x|close|Enter/i);
    expect(output).toContain('Command exited with status 0');
  });

  it('keeps the process alive (pane open) until the user dismisses it', () => {
    // In a PTY the wrapper must NOT exit on its own after the command; it
    // waits for Enter. runExecPty fails with EXITED_EARLY if it exits early.
    const { status, output } = runExecPty(['true', 'pane-123']);
    expect(status).toBe(0);
    expect(output).toContain('Command exited with status 0');
  });

  it('stays alive in a herdr pane with non-TTY stdin (HERDR_PANE_ID set)', () => {
    // Simulates a herdr pane without a terminal on stdin: the wrapper must
    // keep running so the pane stays open. Use `timeout` to prove it does
    // not exit on its own (exit 124 = killed by timeout, i.e. still alive).
    let status = 0;
    let out = '';
    try {
      out = execFileSync('timeout', ['2', 'bash', SCRIPT, '--exec', 'true', 'pane-123'], {
        encoding: 'utf-8',
        env: { ...process.env, HERDR_BIN_PATH: fakeHerdr, HERDR_PANE_ID: 'pane-123' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      status = e.status ?? 1;
      out = e.stdout ?? '';
    }
    expect(status).toBe(124); // timed out ⇒ wrapper stayed alive
    expect(out).toContain('Command exited with status 0');
    expect(out).toMatch(/prefix\+x|close/i);
  });

  it('keeps the pane open and reports the status on non-zero exit', () => {
    const { status, stdout, log } = runExec(['false', 'pane-123']);
    expect(status).toBe(1);
    expect(stdout).toContain('Command exited with status 1');
    expect(log).toEqual([]); // never closes the pane on failure
  });

  it('reports the exact exit status of the wrapped command', () => {
    const { status, stdout } = runExec(['exit 42', 'pane-123']);
    expect(status).toBe(42);
    expect(stdout).toContain('Command exited with status 42');
  });

  it('errors on an empty command (exit 1, no pane close)', () => {
    const { status, stdout, stderr, log } = runExec(['', 'pane-123']);
    expect(status).toBe(1);
    expect(stdout + stderr).toContain('Error');
    expect(log).toEqual([]);
  });
});
