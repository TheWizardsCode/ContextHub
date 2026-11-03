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
 * themselves. These tests exercise the eight public hierarchy functions through
 * the barrel — the path consumers actually use — with the `gh` transport
 * replaced by spies, and assert the observable contract the move must not
 * change:
 *
 * | Concern | Assertion |
 * |---|---|
 * | outlined GraphQL documents | the query/mutation text consumers rely on (`subIssues(first: 100)`, `addSubIssue`) |
 * | load-bearing `-F` vs `-f` flags | `-F number=<n>` (integer) and `-f owner=`/`-f name=`/`-f parent=`/`-f child=` |
 * | response unwrapping | sync reads `data.data.repository…`; async accepts `data.repository…` and the nested shape |
 * | error messages | `Unable to resolve GitHub issue node ID for #<n>`, `Unable to query issue hierarchy`, the link failures |
 * | node-id cache | a primed cache issues the mutation alone; an empty cache resolves each issue once |
 * | result wrappers | `{ ok, error }` instead of throwing, for both sync and async |
 * | timeline parent lookup | only `added_to_parent` events contribute; non-array payloads yield `[]` |
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/github/transport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/github/transport.js')>();
  return {
    ...actual,
    runGhJsonDetailed: vi.fn(),
    runGhJsonDetailedAsync: vi.fn(),
    ghApiJsonScheduled: vi.fn(),
    ghApiJsonDetailedScheduled: vi.fn(),
    runGhSafeJson: vi.fn(),
  };
});

import {
  ghApiJsonDetailedScheduled,
  ghApiJsonScheduled,
  runGhJsonDetailed,
  runGhSafeJson,
} from '../../src/github/transport.js';
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

const config = { repo: 'acme/widgets', labelPrefix: 'wl:' };

const runGhJsonDetailedMock = vi.mocked(runGhJsonDetailed);
const ghApiJsonScheduledMock = vi.mocked(ghApiJsonScheduled);
const ghApiJsonDetailedScheduledMock = vi.mocked(ghApiJsonDetailedScheduled);
const runGhSafeJsonMock = vi.mocked(runGhSafeJson);

/** The resolved GraphQL document of the nth recorded call. */
function commandOf(call: number): string {
  return String(runGhJsonDetailedMock.mock.calls[call]?.[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getIssueHierarchy (sync)', () => {
  it('unwraps data.data.repository.issue and filters non-numeric sub-issue nodes', () => {
    runGhJsonDetailedMock.mockReturnValue({
      ok: true,
      data: {
        data: {
          repository: {
            issue: {
              parent: { number: 12 },
              subIssues: { nodes: [{ number: 3 }, { number: 4 }, {}] },
            },
          },
        },
      },
    });

    expect(getIssueHierarchy(config, 42)).toEqual({
      parentIssueNumber: 12,
      childIssueNumbers: [3, 4],
    });

    const command = commandOf(0);
    expect(command).toContain('gh api graphql');
    expect(command).toContain('subIssues(first: 100)');
    // `-F number=` is the integer flag; `-f` would send a string and break the
    // `Int!` variable, so the move must preserve it exactly.
    expect(command).toContain('-F number=42');
    expect(command).toContain("-f owner='acme'");
    expect(command).toContain("-f name='widgets'");
  });

  it('reports a missing parent as null when the issue has no parent', () => {
    runGhJsonDetailedMock.mockReturnValue({
      ok: true,
      data: { data: { repository: { issue: { subIssues: { nodes: [] } } } } },
    });

    expect(getIssueHierarchy(config, 7)).toEqual({
      parentIssueNumber: null,
      childIssueNumbers: [],
    });
  });

  it('surfaces the transport error, falling back to the hierarchy error message', () => {
    runGhJsonDetailedMock.mockReturnValueOnce({ ok: false, error: 'boom' });
    expect(() => getIssueHierarchy(config, 42)).toThrow('boom');

    runGhJsonDetailedMock.mockReturnValueOnce({ ok: false });
    expect(() => getIssueHierarchy(config, 42)).toThrow('Unable to query issue hierarchy');
  });
});

describe('getIssueHierarchyAsync', () => {
  it('accepts the throttler-unwrapped data.repository shape', async () => {
    ghApiJsonScheduledMock.mockResolvedValue({
      data: {
        repository: {
          issue: { parent: { number: 5 }, subIssues: { nodes: [{ number: 6 }] } },
        },
      },
    });

    await expect(getIssueHierarchyAsync(config, 42)).resolves.toEqual({
      parentIssueNumber: 5,
      childIssueNumbers: [6],
    });
    expect(String(ghApiJsonScheduledMock.mock.calls[0]?.[0])).toContain('-F number=42');
  });

  it('also accepts the nested data.data.repository shape', async () => {
    ghApiJsonScheduledMock.mockResolvedValue({
      data: {
        data: {
          repository: {
            issue: { parent: null, subIssues: { nodes: [{ number: 9 }] } },
          },
        },
      },
    });

    await expect(getIssueHierarchyAsync(config, 42)).resolves.toEqual({
      parentIssueNumber: null,
      childIssueNumbers: [9],
    });
  });

  it('rejects an empty response with the hierarchy error message', async () => {
    ghApiJsonScheduledMock.mockResolvedValue(undefined);

    await expect(getIssueHierarchyAsync(config, 42)).rejects.toThrow(
      'Unable to query issue hierarchy',
    );
  });
});

describe('getIssueNodeIdAsync', () => {
  it('returns the node id and resolves it with an integer number variable', async () => {
    ghApiJsonScheduledMock.mockResolvedValue({
      data: { repository: { issue: { id: 'ISSUE_NODE_42' } } },
    });

    await expect(getIssueNodeIdAsync(config, 42)).resolves.toBe('ISSUE_NODE_42');
    const command = String(ghApiJsonScheduledMock.mock.calls[0]?.[0]);
    expect(command).toContain('issue(number: $number) { id }');
    expect(command).toContain('-F number=42');
  });

  it('throws the documented message when the id is absent', async () => {
    ghApiJsonScheduledMock.mockResolvedValue({ data: { repository: { issue: {} } } });

    await expect(getIssueNodeIdAsync(config, 42)).rejects.toThrow(
      'Unable to resolve GitHub issue node ID for #42',
    );
  });
});

describe('addSubIssueLink (sync)', () => {
  function primeNodeLookups(): void {
    runGhJsonDetailedMock.mockImplementation((command: string) => {
      if (command.includes('addSubIssue')) {
        return {
          ok: true,
          data: { data: { addSubIssue: { issue: { id: 'P5' }, subIssue: { id: 'C6' } } } },
        };
      }
      const id = command.includes('-F number=5') ? 'P5' : 'C6';
      return { ok: true, data: { data: { repository: { issue: { id } } } } };
    });
  }

  it('resolves each node id once, then issues the mutation with -f id flags', () => {
    primeNodeLookups();

    addSubIssueLink(config, 5, 6);

    expect(runGhJsonDetailedMock).toHaveBeenCalledTimes(3);
    const mutation = commandOf(2);
    expect(mutation).toContain('addSubIssue(input: { issueId: $parent, subIssueId: $child })');
    // Node ids are GraphQL `ID!`, so they travel as `-f` string flags.
    expect(mutation).toContain("-f parent='P5'");
    expect(mutation).toContain("-f child='C6'");
  });

  it('reuses a primed node-id cache instead of re-querying node ids', () => {
    primeNodeLookups();

    addSubIssueLink(config, 5, 6, new Map([[5, 'P5'], [6, 'C6']]));

    expect(runGhJsonDetailedMock).toHaveBeenCalledTimes(1);
    expect(commandOf(0)).toContain('addSubIssue');
  });

  it('throws an actionable error when the mutation fails or returns no data', () => {
    runGhJsonDetailedMock.mockReturnValue({ ok: false });
    expect(() => addSubIssueLink(config, 5, 6, new Map([[5, 'P5'], [6, 'C6']]))).toThrow(
      'Failed to link #6 as sub-issue of #5',
    );

    runGhJsonDetailedMock.mockReturnValue({ ok: true, data: { data: { addSubIssue: {} } } });
    expect(() => addSubIssueLink(config, 5, 6, new Map([[5, 'P5'], [6, 'C6']]))).toThrow(
      'addSubIssue returned no data (sub-issues may be disabled for this repo/org)',
    );
  });

  it('wraps failures as { ok: false, error } instead of throwing', () => {
    runGhJsonDetailedMock.mockReturnValue({
      ok: true,
      data: { data: { addSubIssue: {} } },
    });

    expect(addSubIssueLinkResult(config, 5, 6, new Map([[5, 'P5'], [6, 'C6']]))).toEqual({
      ok: false,
      error: 'addSubIssue returned no data (sub-issues may be disabled for this repo/org)',
    });
  });
});

describe('addSubIssueLinkAsync', () => {
  it('schedules node resolution and the mutation through the throttled helpers', async () => {
    ghApiJsonScheduledMock.mockImplementation(async (command: string) => ({
      data: { repository: { issue: { id: command.includes('-F number=5') ? 'P5' : 'C6' } } },
    }));
    ghApiJsonDetailedScheduledMock.mockResolvedValue({
      ok: true,
      data: { data: { addSubIssue: { issue: { id: 'P5' }, subIssue: { id: 'C6' } } } },
    });

    await addSubIssueLinkAsync(config, 5, 6);

    expect(ghApiJsonScheduledMock).toHaveBeenCalledTimes(2);
    expect(ghApiJsonDetailedScheduledMock).toHaveBeenCalledTimes(1);
    const mutation = String(ghApiJsonDetailedScheduledMock.mock.calls[0]?.[0]);
    expect(mutation).toContain('addSubIssue');
    expect(mutation).toContain("-f parent='P5'");
    expect(mutation).toContain("-f child='C6'");
  });

  it('wraps async failures as { ok: false, error }', async () => {
    ghApiJsonDetailedScheduledMock.mockResolvedValue({
      ok: true,
      data: { data: { addSubIssue: {} } },
    });

    await expect(
      addSubIssueLinkResultAsync(config, 5, 6, new Map([[5, 'P5'], [6, 'C6']])),
    ).resolves.toEqual({
      ok: false,
      error: 'addSubIssue returned no data (sub-issues may be disabled for this repo/org)',
    });

    ghApiJsonDetailedScheduledMock.mockResolvedValue({ ok: false, error: 'graphql down' });
    await expect(
      addSubIssueLinkResultAsync(config, 5, 6, new Map([[5, 'P5'], [6, 'C6']])),
    ).resolves.toEqual({ ok: false, error: 'graphql down' });
  });
});

describe('listParentIssueNumbersFromTimeline', () => {
  it('keeps only added_to_parent events and returns their parent numbers', () => {
    runGhSafeJsonMock.mockReturnValue([
      { event: 'added_to_parent', parent_issue: { number: 11 } },
      { event: 'labeled', parent_issue: { number: 99 } },
      { event: 'added_to_parent', parent_issue: { number: 'nope' } },
      { event: 'added_to_parent', parent_issue: { number: 12 } },
    ]);

    expect(listParentIssueNumbersFromTimeline(config, 42)).toEqual([11, 12]);
    expect(String(runGhSafeJsonMock.mock.calls[0]?.[0])).toBe(
      'gh api repos/acme/widgets/issues/42/timeline --paginate',
    );
  });

  it('returns an empty list when the timeline payload is not an array', () => {
    runGhSafeJsonMock.mockReturnValue(null);

    expect(listParentIssueNumbersFromTimeline(config, 42)).toEqual([]);
  });
});
