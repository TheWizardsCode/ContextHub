import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Shared child_process mock (stored on globalThis by setup-tests.ts).
// The factory reads from the global store directly — no vi.hoisted needed.
// Only test files that need the mock register it here.
vi.mock('child_process', () => {
  const store = (globalThis as any).__sharedChildProcessMocks;
  return {
    spawn: store?.mockSpawn ?? vi.fn(),
    execSync: vi.fn(),
    spawnSync: vi.fn(),
  };
});

// Import shared mock instances for use in test bodies.
import { initChildProcessMocks } from '../child-process-mocks.js';
const { mockSpawn } = initChildProcessMocks();

type MockStream = EventEmitter & {
  setEncoding: (encoding: string) => void;
  write: (chunk: string) => boolean;
  end: () => void;
};

import throttler from '../../src/github-throttler.js';
import { createGithubIssueCommentAsync } from '../../src/github.js';

describe('github async spawn stdin errors', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Set up the spawn mock to return a child process that emits data + EPIPE
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter & { setEncoding: (encoding: string) => void };
        stderr: EventEmitter & { setEncoding: (encoding: string) => void };
        stdin: MockStream;
        exitCode: number | null;
        kill: () => void;
      };

      const stdout = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void };
      stdout.setEncoding = vi.fn();

      const stderr = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void };
      stderr.setEncoding = vi.fn();

      const stdin = new EventEmitter() as MockStream;
      stdin.setEncoding = vi.fn();
      stdin.write = vi.fn(() => {
        setImmediate(() => {
          stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
        });
        return true;
      });
      stdin.end = vi.fn();

      child.stdout = stdout;
      child.stderr = stderr;
      child.stdin = stdin;
      child.exitCode = null;
      child.kill = vi.fn();

      setImmediate(() => {
        child.stdout.emit(
          'data',
          JSON.stringify({ id: 99, body: 'ok', updatedAt: '2026-05-26T00:00:00.000Z', user: { login: 'bot' } }),
        );
        child.exitCode = 0;
        child.emit('close', 0);
      });

      return child;
    });
  });

  it('does not crash when child stdin emits async EPIPE after write', async () => {
    vi.spyOn(throttler, 'schedule').mockImplementation(async (fn: any) => await fn());

    const comment = await createGithubIssueCommentAsync(
      { repo: 'owner/repo', labelPrefix: 'wl:' },
      42,
      'hello from test',
    );

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(comment.id).toBe(99);
    expect(comment.author).toBe('bot');
  });
});
