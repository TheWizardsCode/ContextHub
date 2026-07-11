import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockStream = EventEmitter & {
  setEncoding: (encoding: string) => void;
  write: (chunk: string) => boolean;
  end: () => void;
};

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(() => {
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
  }),
}));

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: spawnMock,
    execSync: vi.fn(),
    spawnSync: vi.fn(),
  };
});

import throttler from '../../src/github-throttler.js';
import { createGithubIssueCommentAsync } from '../../src/github.js';

describe('github async spawn stdin errors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not crash when child stdin emits async EPIPE after write', async () => {
    vi.spyOn(throttler, 'schedule').mockImplementation(async (fn: any) => await fn());

    const comment = await createGithubIssueCommentAsync(
      { repo: 'owner/repo', labelPrefix: 'wl:' },
      42,
      'hello from test',
    );

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(comment.id).toBe(99);
    expect(comment.author).toBe('bot');
  });
});
