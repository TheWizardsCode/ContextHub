/**
 * tests/github/comments.test.ts — behaviour gate for `src/github/comments.ts`.
 *
 * Parent: WL-0MVGKGR2H006MNVG (decompose the `src/github.ts` god class).
 * Extraction item: WL-0MVVLXZFN00994LW — child 6 of 8, moves the issue-comment
 * CRUD out of the barrel.
 *
 * ## What this file protects
 *
 * The extraction is move-only, so the family's existing suites (which mock the
 * barrel wholesale) prove the *wiring* but never the comment functions
 * themselves. These tests drive the eight public functions through the barrel —
 * the path consumers use — and assert the observable contract the move must not
 * change:
 *
 * | Concern | Assertion |
 * |---|---|
 * | REST paths and flags | `repos/<owner>/<name>/issues/<n>/comments --paginate`, `-X POST`/`-X PATCH`, `-F body=@-`, `--json id,body,updatedAt,user` |
 * | body transport | the body travels on stdin (never on the command line) for create and update |
 * | response normalisation | `body ?? null` (an empty string survives), `updated_at` before `updatedAt`, `user.login` before `author.login`, an ISO fallback timestamp |
 * | failure behaviour | the sync and async list paths degrade to `[]` instead of throwing |
 * | throttling | every async call is scheduled through the central throttler exactly once |
 *
 * ## How the `gh` calls are intercepted
 *
 * The suite drives the *real* transport (`src/github/transport.ts`) and replaces
 * `child_process` with the repo-wide shared mocks installed by
 * `tests/setup-tests.ts` (see `tests/child-process-mocks.ts`, the same pattern as
 * `tests/github/hierarchy.test.ts`). Mocking `child_process` — a stable builtin
 * id — is deliberate: mocking the family's own transport module is not reliable
 * when the barrel and the extracted module resolve it through different module
 * instances in a full parallel run (WL-0MVVLXYRO006WP2I).
 */

import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';
import * as fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', () => {
  const store = (globalThis as any).__sharedChildProcessMocks;
  return {
    spawn: store?.mockSpawn ?? vi.fn(),
    execSync: store?.mockExecSync ?? vi.fn(),
    spawnSync: store?.mockSpawnSync ?? vi.fn(),
  };
});

import { initChildProcessMocks } from '../child-process-mocks.js';
import throttler from '../../src/github-throttler.js';
import {
  createGithubIssueComment,
  createGithubIssueCommentAsync,
  getGithubIssueComment,
  getGithubIssueCommentAsync,
  listGithubIssueComments,
  listGithubIssueCommentsAsync,
  updateGithubIssueComment,
  updateGithubIssueCommentAsync,
} from '../../src/github.js';

const { mockSpawn, mockExecSync, mockSpawnSync } = initChildProcessMocks();

const config = { repo: 'acme/widgets', labelPrefix: 'wl:' };

/** Command string of the nth recorded `execSync` call and its options. */
function execSyncCall(call = 0): { command: string; options: any } {
  const [command, options] = mockExecSync.mock.calls[call] ?? [];
  return { command: String(command), options };
}

/** Command string of the nth recorded `spawn` (async transport) call. */
function spawnCommandOf(call = 0): { command: string; stdin: () => string } {
  const args = mockSpawn.mock.calls[call]?.[1] as string[] | undefined;
  const proc = mockSpawn.mock.results[call]?.value as any;
  return {
    command: String(args?.[1] ?? ''),
    stdin: () => (proc?.capturedStdin ? String(proc.capturedStdin) : ''),
  };
}

/** A fake child process that streams the given stdout/stderr and then closes. */
function fakeProc(stdout: string, exitCode = 0, stderr = '') {
  const proc = new EventEmitter() as any;
  proc.capturedStdin = '';
  proc.stdin = new Writable({
    write(chunk: any, _enc: any, cb: () => void) {
      proc.capturedStdin += String(chunk);
      cb();
    },
  });
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
  setImmediate(() => proc.emit('close', exitCode));
  return proc;
}

/** Route every `spawn` (async transport) through a command -> stdout resolver. */
function mockAsyncGh(resolve: (command: string) => string): void {
  mockSpawn.mockImplementation((_file: string, args: string[]) =>
    fakeProc(resolve(String(args?.[1] ?? ''))),
  );
}

/** Route every `execSync` (sync transport) through a command -> stdout resolver. */
function mockSyncGh(resolve: (command: string) => string): void {
  mockExecSync.mockImplementation((command: string) => resolve(String(command)));
}

/**
 * Route the paginated *sync* transport, which streams stdout into a temporary
 * file descriptor, by writing the payload into that descriptor ourselves.
 */
function mockSyncPaginatedGh(payload: unknown, status = 0): void {
  mockSpawnSync.mockImplementation((_file: string, _args: string[], options: any) => {
    const outFd = options?.stdio?.[1];
    if (typeof outFd === 'number') fs.writeSync(outFd, JSON.stringify(payload));
    return { status };
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockSpawn.mockReset();
  mockExecSync.mockReset();
  mockSpawnSync.mockReset();
});

describe('listGithubIssueComments (sync)', () => {
  it('paginates the issue comment endpoint and normalises every response field', () => {
    mockSyncPaginatedGh([
      { id: 11, body: 'hello', updated_at: '2026-01-02T03:04:05Z', user: { login: 'octocat' } },
      { id: 12, body: '', updatedAt: '2026-02-03T04:05:06Z', author: { login: 'hubot' } },
      { id: 13 },
      { id: 14, body: 'both', updated_at: '2026-03-04T05:06:07Z', updatedAt: '1999-01-01T00:00:00Z' },
    ]);

    expect(listGithubIssueComments(config, 42)).toEqual([
      { id: 11, body: 'hello', updatedAt: '2026-01-02T03:04:05Z', author: 'octocat' },
      // `body ?? null`: an empty string is a real body and must survive.
      { id: 12, body: '', updatedAt: '2026-02-03T04:05:06Z', author: 'hubot' },
      { id: 13, body: null, updatedAt: expect.any(String), author: undefined },
      // `updated_at` wins over the camelCase spelling.
      { id: 14, body: 'both', updatedAt: '2026-03-04T05:06:07Z', author: undefined },
    ]);

    const args = mockSpawnSync.mock.calls[0]?.[1] as string[];
    expect(String(args?.[1])).toBe('gh api repos/acme/widgets/issues/42/comments --paginate');
  });

  it('degrades to an empty list when the paginated call fails', () => {
    mockSyncPaginatedGh({ message: 'boom' }, 1);

    expect(listGithubIssueComments(config, 42)).toEqual([]);
  });
});

describe('listGithubIssueCommentsAsync', () => {
  it('paginates the issue comment endpoint and normalises the response', async () => {
    mockAsyncGh(() =>
      JSON.stringify([
        { id: 21, body: 'async', updated_at: '2026-04-05T06:07:08Z', user: { login: 'octocat' } },
      ]),
    );

    await expect(listGithubIssueCommentsAsync(config, 42)).resolves.toEqual([
      { id: 21, body: 'async', updatedAt: '2026-04-05T06:07:08Z', author: 'octocat' },
    ]);
    expect(spawnCommandOf().command).toBe(
      'gh api repos/acme/widgets/issues/42/comments --paginate',
    );
  });

  it('degrades to an empty list instead of propagating a transport failure', async () => {
    mockAsyncGh(() => 'not json');

    await expect(listGithubIssueCommentsAsync(config, 42)).resolves.toEqual([]);
  });
});

describe('createGithubIssueComment (sync)', () => {
  it('posts the body on stdin to the issue comment endpoint', () => {
    mockSyncGh(() => JSON.stringify({ id: 31, body: 'posted', updated_at: '2026-05-06T07:08:09Z' }));

    expect(createGithubIssueComment(config, 42, 'posted')).toEqual({
      id: 31,
      body: 'posted',
      updatedAt: '2026-05-06T07:08:09Z',
      author: undefined,
    });

    const { command, options } = execSyncCall();
    expect(command).toBe('gh api -X POST repos/acme/widgets/issues/42/comments -F body=@-');
    // The body is never interpolated into the command line.
    expect(command).not.toContain('posted');
    expect(options?.input).toBe('posted');
  });
});

describe('createGithubIssueCommentAsync', () => {
  it('posts the body on stdin through the throttled async path', async () => {
    const scheduleSpy = vi.spyOn(throttler, 'schedule');
    mockAsyncGh(() =>
      JSON.stringify({ id: 41, body: 'posted', updatedAt: '2026-06-07T08:09:10Z', author: { login: 'bot' } }),
    );

    await expect(createGithubIssueCommentAsync(config, 42, 'posted')).resolves.toEqual({
      id: 41,
      body: 'posted',
      updatedAt: '2026-06-07T08:09:10Z',
      author: 'bot',
    });

    const { command, stdin } = spawnCommandOf();
    expect(command).toBe('gh api -X POST repos/acme/widgets/issues/42/comments -F body=@-');
    expect(stdin()).toBe('posted');
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
  });
});

describe('updateGithubIssueComment (sync)', () => {
  it('patches the single-comment endpoint with the body on stdin', () => {
    mockSyncGh(() => JSON.stringify({ id: 555, body: 'edited', updated_at: '2026-07-08T09:10:11Z' }));

    expect(updateGithubIssueComment(config, 555, 'edited')).toEqual({
      id: 555,
      body: 'edited',
      updatedAt: '2026-07-08T09:10:11Z',
      author: undefined,
    });

    const { command, options } = execSyncCall();
    expect(command).toBe('gh api -X PATCH repos/acme/widgets/issues/comments/555 -F body=@-');
    expect(options?.input).toBe('edited');
  });
});

describe('updateGithubIssueCommentAsync', () => {
  it('patches the single-comment endpoint through the throttled async path', async () => {
    const scheduleSpy = vi.spyOn(throttler, 'schedule');
    mockAsyncGh(() => JSON.stringify({ id: 556, body: 'edited' }));

    const updated = await updateGithubIssueCommentAsync(config, 556, 'edited');
    expect(updated.id).toBe(556);
    expect(updated.body).toBe('edited');
    // A missing timestamp is filled with a fresh ISO string, as before the move.
    expect(Number.isNaN(Date.parse(updated.updatedAt))).toBe(false);

    const { command, stdin } = spawnCommandOf();
    expect(command).toBe('gh api -X PATCH repos/acme/widgets/issues/comments/556 -F body=@-');
    expect(stdin()).toBe('edited');
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
  });
});

describe('getGithubIssueComment (sync)', () => {
  it('requests exactly the normalised field list for a single comment', () => {
    mockSyncGh(() =>
      JSON.stringify({ id: 77, body: 'one', updatedAt: '2026-08-09T10:11:12Z', user: { login: 'octocat' } }),
    );

    expect(getGithubIssueComment(config, 77)).toEqual({
      id: 77,
      body: 'one',
      updatedAt: '2026-08-09T10:11:12Z',
      author: 'octocat',
    });

    expect(execSyncCall().command).toBe(
      'gh api repos/acme/widgets/issues/comments/77 --json id,body,updatedAt,user',
    );
  });
});

describe('getGithubIssueCommentAsync', () => {
  it('requests the same field list through the throttled async path', async () => {
    const scheduleSpy = vi.spyOn(throttler, 'schedule');
    mockAsyncGh(() => JSON.stringify({ id: 78, body: null, user: { login: 'octocat' } }));

    const comment = await getGithubIssueCommentAsync(config, 78);
    // `body ?? null`: an explicit null response stays null (not '').
    expect(comment.body).toBeNull();
    expect(comment.author).toBe('octocat');
    expect(Number.isNaN(Date.parse(comment.updatedAt))).toBe(false);

    expect(spawnCommandOf().command).toBe(
      'gh api repos/acme/widgets/issues/comments/78 --json id,body,updatedAt,user',
    );
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
  });
});
