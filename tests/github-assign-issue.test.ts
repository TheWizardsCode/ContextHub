/**
 * Tests for assignGithubIssue and assignGithubIssueAsync helpers in github.ts
 *
 * Validates that:
 * - assignGithubIssueAsync calls `gh issue edit --add-assignee` and returns { ok: true } on success
 * - assignGithubIssueAsync returns { ok: false, error } on failure without throwing
 * - assignGithubIssueAsync retries on rate-limit / 403 errors with backoff
 * - assignGithubIssueAsync returns { ok: false, error: 'Max retries exceeded' } after exhausting retries
 * - assignGithubIssue (sync) returns { ok: true } on success
 * - assignGithubIssue (sync) returns { ok: false, error } on failure without throwing
 * - Both functions construct the correct gh CLI command with repo, issue number, and assignee
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

// Mock child_process.spawn (async) and child_process.execSync (sync) for
// the underlying runGhDetailedAsync / runGhDetailed wrappers.
const { mockSpawn, mockExecSync } = vi.hoisted(() => {
  return { mockSpawn: vi.fn(), mockExecSync: vi.fn() };
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: mockSpawn, execSync: mockExecSync };
});

import {
  assignGithubIssueAsync,
  assignGithubIssue,
} from '../src/github.js';
import type { GithubConfig, AssignGithubIssueResult } from '../src/github.js';

const defaultConfig: GithubConfig = { repo: 'owner/repo', labelPrefix: 'wl:' };

function createMockSpawnImpl(
  stdout: string,
  exitCode: number = 0,
  stderr: string = ''
) {
  return (_cmd: string, _args: string[], _opts: any) => {
    const proc = new EventEmitter() as any;
    proc.stdin = new Writable({ write: (_c: any, _e: any, cb: () => void) => cb() });
    proc.stdout = new Readable({
      read() {
        this.push(stdout);
        this.push(null);
      },
    });
    proc.stdout.setEncoding = () => proc.stdout;
    proc.stderr = new Readable({
      read() {
        this.push(stderr);
        this.push(null);
      },
    });
    proc.stderr.setEncoding = () => proc.stderr;
    proc.exitCode = exitCode;
    proc.kill = () => {};

    // Emit close asynchronously to simulate real process
    setImmediate(() => {
      proc.emit('close', exitCode);
    });

    return proc;
  };
}

describe('assignGithubIssueAsync', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it('returns { ok: true } on successful assignment', async () => {
    mockSpawn.mockImplementation(createMockSpawnImpl('', 0));

    const result = await assignGithubIssueAsync(defaultConfig, 42, 'copilot');

    expect(result).toEqual({ ok: true });
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    // Verify the command contains the correct issue number and assignee
    const command = mockSpawn.mock.calls[0][1][1]; // spawn('/bin/sh', ['-c', command])
    expect(command).toContain('gh issue edit 42');
    expect(command).toContain('--add-assignee');
    expect(command).toContain('copilot');
    expect(command).toContain('--repo owner/repo');
  });

  it('returns { ok: false, error } on gh failure without throwing', async () => {
    mockSpawn.mockImplementation(
      createMockSpawnImpl('', 1, 'user copilot is not assignable to this issue')
    );

    const result = await assignGithubIssueAsync(defaultConfig, 42, 'copilot');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('copilot is not assignable');
  });

  it('retries on rate-limit errors', async () => {
    let callCount = 0;
    mockSpawn.mockImplementation((_cmd: string, _args: string[], _opts: any) => {
      callCount++;
      if (callCount <= 2) {
        return createMockSpawnImpl('', 1, 'API rate limit exceeded')(_cmd, _args, _opts);
      }
      return createMockSpawnImpl('', 0)(_cmd, _args, _opts);
    });

    const result = await assignGithubIssueAsync(defaultConfig, 42, 'copilot', 3);

    expect(result.ok).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(3);
  });

  it('retries on 403 errors', async () => {
    let callCount = 0;
    mockSpawn.mockImplementation((_cmd: string, _args: string[], _opts: any) => {
      callCount++;
      if (callCount <= 1) {
        return createMockSpawnImpl('', 1, '403 Forbidden')(_cmd, _args, _opts);
      }
      return createMockSpawnImpl('', 0)(_cmd, _args, _opts);
    });

    const result = await assignGithubIssueAsync(defaultConfig, 42, 'copilot', 3);

    expect(result.ok).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('returns error after exhausting retries on persistent rate limit', async () => {
    mockSpawn.mockImplementation(
      createMockSpawnImpl('', 1, 'API rate limit exceeded')
    );

    const result = await assignGithubIssueAsync(defaultConfig, 42, 'copilot', 2);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('rate limit');
    // Should have tried 3 times (initial + 2 retries)
    expect(mockSpawn).toHaveBeenCalledTimes(3);
  });

  it('does not retry on non-rate-limit failures', async () => {
    mockSpawn.mockImplementation(
      createMockSpawnImpl('', 1, 'repository not found')
    );

    const result = await assignGithubIssueAsync(defaultConfig, 42, 'copilot', 3);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('repository not found');
    // Should not retry
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('returns fallback error when stderr is empty', async () => {
    mockSpawn.mockImplementation(
      createMockSpawnImpl('', 1, '')
    );

    const result = await assignGithubIssueAsync(defaultConfig, 42, 'copilot');

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('assignGithubIssue (sync)', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it('returns { ok: true } on successful assignment', () => {
    // execSync returns stdout as string on success
    mockExecSync.mockReturnValue('');

    const result = assignGithubIssue(defaultConfig, 42, 'copilot');

    expect(result).toEqual({ ok: true });
    expect(mockExecSync).toHaveBeenCalledTimes(1);
  });

  it('returns { ok: false, error } on gh failure without throwing', () => {
    // execSync throws on non-zero exit code; runGhDetailed catches it
    const err: any = new Error('Command failed');
    err.stderr = 'user copilot is not assignable to this issue';
    err.stdout = '';
    mockExecSync.mockImplementation(() => { throw err; });

    const result = assignGithubIssue(defaultConfig, 42, 'copilot');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('copilot is not assignable');
  });

  it('returns fallback error when stderr is empty on failure', () => {
    const err: any = new Error('Command failed');
    err.stderr = '';
    err.stdout = '';
    mockExecSync.mockImplementation(() => { throw err; });

    const result = assignGithubIssue(defaultConfig, 42, 'copilot');

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('constructs correct gh command with repo, issue number, and assignee', () => {
    mockExecSync.mockReturnValue('');

    assignGithubIssue({ repo: 'myorg/myrepo', labelPrefix: 'wl:' }, 123, 'some-user');

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    // execSync is called with (command, options)
    const command = mockExecSync.mock.calls[0][0];
    expect(command).toContain('gh issue edit 123');
    expect(command).toContain('--add-assignee');
    expect(command).toContain('some-user');
    expect(command).toContain('--repo myorg/myrepo');
  });
});
