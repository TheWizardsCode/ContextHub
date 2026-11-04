/**
 * tests/github/hierarchy.test.ts — behaviour gate for `src/github/hierarchy.ts`.
 *
 * Parent: WL-0MVGKGR2H006MNVG (decompose the `src/github.ts` god class).
 * Extraction item: WL-0MVVLXYRO006WP2I — child 5 of 8, moves the issue-hierarchy
 * plumbing out of the barrel.
 *
 * ## What this file protects
 *
 * The extraction is move-only, so the family's existing suites (which mock the
 * barrel wholesale) prove the *wiring* but never the hierarchy functions
 * themselves. These tests drive the eight public functions through the barrel —
 * the path consumers use — and assert the observable contract the move must not
 * change:
 *
 * | Concern | Assertion |
 * |---|---|
 * | GraphQL documents | the query/mutation text consumers rely on (`subIssues(first: 100)`, `addSubIssue`) |
 * | load-bearing `-F` vs `-f` flags | `-F number=<n>` (integer) and `-f owner=`/`-f name=`/`-f parent=`/`-f child=` |
 * | response unwrapping | sync reads the `{ data: { repository … } }` envelope; async accepts the plain and double-wrapped shapes |
 * | error messages | `Unable to resolve GitHub issue node ID for #<n>`, the link failures, propagated GraphQL errors |
 * | node-id cache | a primed cache issues the mutation alone; an empty cache resolves each issue once |
 * | result wrappers | `{ ok, error }` instead of throwing, for both sync and async |
 * | timeline parent lookup | only `added_to_parent` events contribute; non-array payloads yield `[]` |
 *
 * ## How the `gh` calls are intercepted
 *
 * The suite drives the *real* transport (`src/github/transport.ts`) and replaces
 * `child_process` with the repo-wide shared mocks installed by
 * `tests/setup-tests.ts` (see `tests/child-process-mocks.ts`, the same pattern as
 * `tests/github-assign-issue.test.ts`). Mocking `child_process` — a stable
 * builtin id — is deliberate: mocking the family's own transport module is not
 * reliable when the barrel and the extracted module resolve it through different
 * module instances in a full parallel run (WL-0MVVLXYRO006WP2I).
 */

import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';
import * as fs from 'fs';
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
import {
  addSubIssueLink,
  addSubIssueLinkAsync,
  addSubIssueLinkResult,
  addSubIssueLinkResultAsync,
  getIssueHierarchy,
  getIssueHierarchyAsync,
  getIssueNodeIdAsync,
  listParentIssueNumbersFromTimeline,
} from '../../src/github.js';

const { mockSpawn, mockExecSync, mockSpawnSync } = initChildProcessMocks();

const config = { repo: 'acme/widgets', labelPrefix: 'wl:' };

/** Command string of the nth recorded `execSync` / `spawn` / `spawnSync` call. */
function execSyncCommand(call = 0): string {
  return String(mockExecSync.mock.calls[call]?.[0]);
}

function spawnCommandOf(call = 0): string {
  const args = mockSpawn.mock.calls[call]?.[1] as string[] | undefined;
  return String(args?.[1] ?? '');
}

/** A fake child process that streams the given stdout/stderr and then closes. */
function fakeProc(stdout: string, exitCode = 0, stderr = '') {
  const proc = new EventEmitter() as any;
  proc.stdin = new Writable({ write: (_chunk: any, _enc: any, cb: () => void) => cb() });
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
  mockSpawn.mockImplementation((_file: string, args: string[]) => fakeProc(resolve(String(args?.[1] ?? ''))));
}

/** Route every `execSync` (sync transport) through a command -> stdout resolver. */
function mockSyncGh(resolve: (command: string) => string): void {
  mockExecSync.mockImplementation((command: string) => resolve(String(command)));
}

beforeEach(() => {
  mockExecSync.mockReset();
  mockSpawn.mockReset();
  mockSpawnSync.mockReset();
});

describe('getIssueHierarchy (sync)', () => {
  it('unwraps the response envelope and filters non-numeric sub-issue nodes', () => {
    mockSyncGh(() =>
      JSON.stringify({
        data: {
          repository: {
            issue: {
              parent: { number: 12 },
              subIssues: { nodes: [{ number: 3 }, { number: 4 }, {}] },
            },
          },
        },
      }),
    );

    expect(getIssueHierarchy(config, 42)).toEqual({
      parentIssueNumber: 12,
      childIssueNumbers: [3, 4],
    });

    const command = execSyncCommand();
    expect(command).toContain('gh api graphql');
    expect(command).toContain('subIssues(first: 100)');
    // `-F number=` is the integer flag; `-f` would send a string and break the
    // `Int!` variable, so the move must preserve it exactly.
    expect(command).toContain('-F number=42');
    expect(command).toContain("-f owner='acme'");
    expect(command).toContain("-f name='widgets'");
  });

  it('reports a missing parent as null when the issue has no parent', () => {
    mockSyncGh(() => JSON.stringify({ data: { repository: { issue: { subIssues: { nodes: [] } } } } }));

    expect(getIssueHierarchy(config, 7)).toEqual({
      parentIssueNumber: null,
      childIssueNumbers: [],
    });
  });

  it('propagates a GraphQL error returned in the response body', () => {
    mockSyncGh(() => JSON.stringify({ errors: [{ message: 'no access to repository' }] }));

    expect(() => getIssueHierarchy(config, 42)).toThrow('no access to repository');
  });
});

describe('getIssueHierarchyAsync', () => {
  it('unwraps the plain { data: { repository } } envelope and keeps the integer flag', async () => {
    mockAsyncGh(() =>
      JSON.stringify({
        data: {
          repository: { issue: { parent: { number: 5 }, subIssues: { nodes: [{ number: 6 }] } } },
        },
      }),
    );

    await expect(getIssueHierarchyAsync(config, 42)).resolves.toEqual({
      parentIssueNumber: 5,
      childIssueNumbers: [6],
    });
    expect(spawnCommandOf()).toContain('-F number=42');
    expect(spawnCommandOf()).toContain('parent { number }');
  });

  it('also accepts the double-wrapped envelope', async () => {
    mockAsyncGh(() =>
      JSON.stringify({
        data: {
          data: { repository: { issue: { parent: null, subIssues: { nodes: [{ number: 9 }] } } } },
        },
      }),
    );

    await expect(getIssueHierarchyAsync(config, 42)).resolves.toEqual({
      parentIssueNumber: null,
      childIssueNumbers: [9],
    });
  });
});

describe('getIssueNodeIdAsync', () => {
  it('returns the node id and resolves it with an integer number variable', async () => {
    mockAsyncGh(() => JSON.stringify({ data: { repository: { issue: { id: 'ISSUE_NODE_42' } } } }));

    await expect(getIssueNodeIdAsync(config, 42)).resolves.toBe('ISSUE_NODE_42');
    expect(spawnCommandOf()).toContain('issue(number: $number) { id }');
    expect(spawnCommandOf()).toContain('-F number=42');
  });

  it('throws the documented message when the id is absent', async () => {
    mockAsyncGh(() => JSON.stringify({ data: { repository: { issue: {} } } }));

    await expect(getIssueNodeIdAsync(config, 42)).rejects.toThrow(
      'Unable to resolve GitHub issue node ID for #42',
    );
  });
});

describe('addSubIssueLink (sync)', () => {
  /** Node lookups answer with an id; the mutation answers with linked ids. */
  function mockLinkGraph(options: { mutate?: () => string } = {}): void {
    mockSyncGh((command) => {
      if (command.includes('addSubIssue')) {
        return options.mutate ? options.mutate() : JSON.stringify({
          data: { addSubIssue: { issue: { id: 'P5' }, subIssue: { id: 'C6' } } },
        });
      }
      const id = command.includes('-F number=5') ? 'P5' : 'C6';
      return JSON.stringify({ data: { repository: { issue: { id } } } });
    });
  }

  it('resolves each node id once, then issues the mutation with -f id flags', () => {
    mockLinkGraph();

    addSubIssueLink(config, 5, 6);

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    const mutation = execSyncCommand(2);
    expect(mutation).toContain('addSubIssue(input: { issueId: $parent, subIssueId: $child })');
    // Node ids are GraphQL `ID!`, so they travel as `-f` string flags.
    expect(mutation).toContain("-f parent='P5'");
    expect(mutation).toContain("-f child='C6'");
  });

  it('reuses a primed node-id cache instead of re-querying node ids', () => {
    mockLinkGraph();

    addSubIssueLink(config, 5, 6, new Map([[5, 'P5'], [6, 'C6']]));

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(execSyncCommand(0)).toContain('addSubIssue');
  });

  it('throws the documented failure when the mutation is rejected', () => {
    mockLinkGraph({ mutate: () => JSON.stringify({ errors: [{ message: 'sub-issues disabled' }] }) });

    expect(() => addSubIssueLink(config, 5, 6, new Map([[5, 'P5'], [6, 'C6']]))).toThrow(
      'sub-issues disabled',
    );

    mockLinkGraph({ mutate: () => JSON.stringify({ data: { addSubIssue: {} } }) });
    expect(() => addSubIssueLink(config, 5, 6, new Map([[5, 'P5'], [6, 'C6']]))).toThrow(
      'addSubIssue returned no data (sub-issues may be disabled for this repo/org)',
    );
  });

  it('wraps failures as { ok: false, error } instead of throwing', () => {
    mockLinkGraph({ mutate: () => JSON.stringify({ data: { addSubIssue: {} } }) });

    expect(addSubIssueLinkResult(config, 5, 6, new Map([[5, 'P5'], [6, 'C6']]))).toEqual({
      ok: false,
      error: 'addSubIssue returned no data (sub-issues may be disabled for this repo/org)',
    });
  });

  it('returns { ok: true } on success', () => {
    mockLinkGraph();

    expect(addSubIssueLinkResult(config, 5, 6)).toEqual({ ok: true });
  });
});

describe('addSubIssueLinkAsync', () => {
  it('resolves node ids asynchronously and issues the throttled mutation', async () => {
    mockAsyncGh((command) => {
      if (command.includes('addSubIssue')) {
        return JSON.stringify({
          data: { addSubIssue: { issue: { id: 'P5' }, subIssue: { id: 'C6' } } },
        });
      }
      const id = command.includes('-F number=5') ? 'P5' : 'C6';
      return JSON.stringify({ data: { repository: { issue: { id } } } });
    });

    await addSubIssueLinkAsync(config, 5, 6);

    expect(mockSpawn).toHaveBeenCalledTimes(3);
    const mutation = spawnCommandOf(2);
    expect(mutation).toContain('addSubIssue');
    expect(mutation).toContain("-f parent='P5'");
    expect(mutation).toContain("-f child='C6'");
  });

  it('wraps async failures as { ok: false, error }', async () => {
    mockAsyncGh((command) =>
      command.includes('addSubIssue')
        ? JSON.stringify({ data: { addSubIssue: {} } })
        : JSON.stringify({ data: { repository: { issue: { id: 'ID' } } } }),
    );

    await expect(
      addSubIssueLinkResultAsync(config, 5, 6, new Map([[5, 'P5'], [6, 'C6']])),
    ).resolves.toEqual({
      ok: false,
      error: 'addSubIssue returned no data (sub-issues may be disabled for this repo/org)',
    });
  });
});

describe('listParentIssueNumbersFromTimeline', () => {
  it('keeps only added_to_parent events and returns their parent numbers', () => {
    const events = [
      { event: 'added_to_parent', parent_issue: { number: 11 } },
      { event: 'labeled', parent_issue: { number: 99 } },
      { event: 'added_to_parent', parent_issue: { number: 'nope' } },
      { event: 'added_to_parent', parent_issue: { number: 12 } },
    ];
    // `--paginate` streams stdout to the file descriptor transport opened.
    mockSpawnSync.mockImplementation((_file: string, _args: string[], options: any) => {
      fs.writeSync(options.stdio[1], JSON.stringify(events));
      return { status: 0, error: null };
    });

    expect(listParentIssueNumbersFromTimeline(config, 42)).toEqual([11, 12]);
    expect(String(mockSpawnSync.mock.calls[0]?.[1]?.[1])).toBe(
      'gh api repos/acme/widgets/issues/42/timeline --paginate',
    );
  });

  it('returns an empty list when the timeline payload is not an array', () => {
    mockSpawnSync.mockImplementation((_file: string, _args: string[], options: any) => {
      fs.writeSync(options.stdio[1], JSON.stringify({ message: 'Not Found' }));
      return { status: 0, error: null };
    });

    expect(listParentIssueNumbersFromTimeline(config, 42)).toEqual([]);
  });
});
