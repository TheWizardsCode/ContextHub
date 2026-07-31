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
  try {
    stdout = execFileSync('bash', [SCRIPT, '--exec', ...args], {
      encoding: 'utf-8',
      env: { ...process.env, HERDR_BIN_PATH: fakeHerdr },
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

  it('prints a hint telling the user the pane is left open', () => {
    const { stdout } = runExec(['true', 'pane-123']);
    // Hint must mention closing the pane manually (prefix+x / close_pane)
    expect(stdout).toMatch(/close|prefix\+x|pane/i);
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
