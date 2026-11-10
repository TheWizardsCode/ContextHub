/**
 * packages/herdr/src/index.downtime-select.test.ts — `createDowntimeDeps`
 * tier-selection tests: list head, next item, audit candidate, audit scope
 * (work item WL-0MVOA238A0078J2H).
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDowntimeDeps } from './index.js';
import { DOWNTIME_WL_TIMEOUT_MS, createAuditAvailabilityClient } from './downtime-worker.js';
import { DISPATCHER_ASSIGNEE } from './index.claim.js';
import { appendDowntimeLogEntry, DOWNTIME_LOG_FILE } from './downtime-log.js';
import { reserve } from './host-dispatch-budget.js';
import { classifyAuditScope } from './downtime-worker.gates.js';
import { resetExecFileAsync, resetWorklogDir, setExecFileAsync, setWorklogDir } from './fetcher.js';
import { setupHostCpuPin, makeTempDir, useIsolatedCoordinationDir } from './index.fixtures.js';

setupHostCpuPin();

describe('createDowntimeDeps', () => {
  useIsolatedCoordinationDir();

  // Herdr list head wiring (WL-0MUNS8X97007C9H9): callers (the dispatcher's
  // two selection paths) pass the live sprint-view `browseItemCount` limit,
  // which is forwarded verbatim so the head equals the rendered worklist. A
  // caller that passes no limit falls back to the sprint-view default (20) so
  // an unwindowed head is never produced.
  it('getHerdrListHead forwards the requested limit to wl next and defaults to the sprint-view default (20)', async () => {
    const mockExec = vi.fn().mockImplementation((_bin: string, args: string[]) => {
      if (args.includes('next')) {
        return Promise.resolve({ stdout: JSON.stringify({ success: true, results: [] }), stderr: '' });
      }
      return Promise.resolve({ stdout: JSON.stringify({ success: true, workItems: [] }), stderr: '' });
    });
    setExecFileAsync(mockExec as never);
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);

    await deps.getHerdrListHead('/repo');
    await deps.getHerdrListHead('/repo', 60);

    const nextCalls = mockExec.mock.calls.filter(([, a]) => (a as string[]).includes('next'));
    expect(nextCalls).toHaveLength(2);
    expect(nextCalls[0][1]).toEqual(expect.arrayContaining(['-n', '20']));
    expect(nextCalls[1][1]).toEqual(expect.arrayContaining(['-n', '60']));
  });

  // Registered-root sweep (WL-0MVR8GDJ3008WY3Y AC3): the canonical-ranking seam
  // is ROOT-AWARE. Reading a FOREIGN root must target `<root>/.worklog`
  // explicitly, never the leader pane's module-configured database.
  it('getHerdrListHead targets a foreign root explicitly via --worklog-dir', async () => {
    const leaderRoot = '/projects/leader';
    const foreignRoot = '/projects/other-root';
    setWorklogDir(join(leaderRoot, '.worklog'));
    const mockExec = vi.fn().mockImplementation((_bin: string, args: string[]) => {
      void args;
      // An unparsable `wl worklist` payload makes the read fall back to the
      // per-subset path, so every spawned command is observable.
      return Promise.resolve({ stdout: JSON.stringify({ success: true, results: [] }), stderr: '' });
    });
    setExecFileAsync(mockExec as never);
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);

    await deps.getHerdrListHead(foreignRoot, 5);

    const calls = mockExec.mock.calls.map(([, a]) => a as string[]);
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      expect(args.slice(0, 2)).toEqual(['--worklog-dir', join(foreignRoot, '.worklog')]);
    }
  });

  it('getHerdrListHead keeps the leader own root on the module-configured worklog dir', async () => {
    const leaderRoot = '/projects/leader';
    setWorklogDir(join(leaderRoot, '.worklog'));
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ success: true, results: [] }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);

    await deps.getHerdrListHead(leaderRoot, 5);

    const calls = mockExec.mock.calls.map(([, a]) => a as string[]);
    expect(calls.length).toBeGreaterThan(0);
    // The override is omitted, so the module-level `--worklog-dir` applies
    // exactly once per spawn (unchanged pre-sweep behaviour).
    for (const args of calls) {
      expect(args.filter((token) => token === '--worklog-dir')).toHaveLength(1);
      expect(args[0]).toBe('--worklog-dir');
      expect(args[1]).toBe(join(leaderRoot, '.worklog'));
    }
  });

  it('getNextItem runs wl next --stage -n 10 and parses the first workItem', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ success: true, workItem: { id: 'WL-ABC', title: 'Some task', status: 'open' } }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const result = await deps.getNextItem('intake_complete', '/repo');

    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      ['next', '--stage', 'intake_complete', '-n', '10', '--json'],
      expect.anything(),
    );
    expect(result).toEqual({
      ok: true,
      candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete', status: 'open', sortIndex: undefined },
    });
  });

  it('getNextItem parses the batch shape (wl next -n N) and preserves priority order', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        workItems: [
          { workItem: { id: 'WL-1', title: 'Second', status: 'open', sortIndex: 20 } },
          { workItem: { id: 'WL-2', title: 'First', status: 'open', sortIndex: 10 } },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const result = await deps.getNextItem('idea', '/repo');

    // selectNextCandidate: open-status guard + sortIndex ascending (wl next
    // priority order preserved).
    expect(result).toEqual({
      ok: true,
      candidate: { id: 'WL-2', title: 'First', stage: 'idea', status: 'open', sortIndex: 10 },
    });
  });

  it('getNextItem excludes a plan-dispatched candidate still at its dispatched stage (change-guard)', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        workItems: [
          { workItem: { id: 'WL-ONCE', title: 'Marked', status: 'open', sortIndex: 5 } },
          { workItem: { id: 'WL-NEXT', title: 'Next', status: 'open', sortIndex: 20 } },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);
    const cwd = makeTempDir();
    // Pre-write a plan marker for WL-ONCE at stage intake_complete (the same
    // stage the plan tier selects at).
    await appendDowntimeLogEntry(
      cwd,
      JSON.stringify({ itemId: 'WL-ONCE', kind: 'plan', stage: 'intake_complete', dispatchedAt: '2026-01-01T00:00:00.000Z' }),
    );

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const result = await deps.getNextItem('intake_complete', cwd);

    // The marked candidate is excluded; the next one is selected.
    expect(result).toEqual({
      ok: true,
      candidate: { id: 'WL-NEXT', title: 'Next', stage: 'intake_complete', status: 'open', sortIndex: 20 },
    });
  });

  it('getNextItem passes --worklog-dir when the tab resolved a worklog root', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ success: true, workItem: { id: 'SA-ABC', title: 'Sorra task', status: 'open' } }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);
    setWorklogDir('/home/user/projects/SorraAgents/.worklog');

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const result = await deps.getNextItem('intake_complete', '/repo');

    // The global option must appear BEFORE the subcommand, exactly as the
    // worklist's runWl() prepends it (WL-0MSI7DQL10016QYX).
    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      [
        '--worklog-dir',
        '/home/user/projects/SorraAgents/.worklog',
        'next',
        '--stage',
        'intake_complete',
        '-n',
        '10',
        '--json',
      ],
      expect.anything(),
    );
    expect(result).toEqual({ ok: true, candidate: { id: 'SA-ABC', title: 'Sorra task', stage: 'intake_complete', status: 'open', sortIndex: undefined } });
  });

  it('getNextItem reports ok:true with no candidate when wl reports no item', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ success: false, workItem: null, reason: 'none' }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    expect(await deps.getNextItem('idea', '/repo')).toEqual({ ok: true, candidate: null });
  });

  it('getNextItem fails closed ({ok:false}) when wl errors', async () => {
    setExecFileAsync(vi.fn().mockRejectedValue(new Error('wl boom')) as never);
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    expect(await deps.getNextItem('idea', '/repo')).toEqual({ ok: false, error: 'wl boom' });
  });

  it('getNextItem passes a bounded timeout so a hung wl fails closed', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ success: true, workItem: { id: 'WL-ABC', title: 'Some task', status: 'open' } }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    await deps.getNextItem('intake_complete', '/repo');

    // AC1: the invocation must carry the bounded timeout so a hung wl child
    // is killed by execFile instead of wedging the dispatch task.
    const [, , options] = mockExec.mock.calls[0];
    expect(options).toMatchObject({ timeout: DOWNTIME_WL_TIMEOUT_MS });
  });

  it('getNextItem fails closed within the timeout when wl hangs (AC4 hang path)', async () => {
    vi.useFakeTimers();
    try {
      // A hung wl child: the mock never resolves on its own — the bounded
      // timeout (enforced by execFile in production) rejects the invocation
      // after DOWNTIME_WL_TIMEOUT_MS, so the lookup fails closed to busy.
      const hungExec = vi.fn(
        (_bin: string, _args: string[], opts?: { timeout?: number }) =>
          new Promise((_resolve, reject) => {
            setTimeout(
              () => reject(Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' })),
              opts?.timeout ?? DOWNTIME_WL_TIMEOUT_MS,
            );
          }),
      );
      setExecFileAsync(hungExec as never);
      const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);

      const resultPromise = deps.getNextItem('idea', '/repo');
      await vi.advanceTimersByTimeAsync(DOWNTIME_WL_TIMEOUT_MS - 1);
      // Still pending just before the timeout — no premature resolution.
      await vi.advanceTimersByTimeAsync(1);
      await expect(resultPromise).resolves.toEqual({ ok: false, error: 'ETIMEDOUT' });

      // The hung invocation received the bounded timeout option.
      expect(hungExec.mock.calls[0][2]).toMatchObject({ timeout: DOWNTIME_WL_TIMEOUT_MS });
    } finally {
      vi.useRealTimers();
    }
  });

  it('getNextAuditCandidate runs wl list completed/in_review and selects the first stale-audit item', async () => {
    // Fixture times are relative to now so the 7-day recency filter passes
    // (selectAuditCandidate defaults to Date.now()).
    const now = Date.now();
    const HOUR_MS = 60 * 60 * 1000;
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        count: 2,
        workItems: [
          // Fresh per the one-sided isAuditFresh gate: the audit (30 min ago)
          // postdates the item's last update (1 h ago), so it covers the
          // current content (WL-0MUBVH7ZR009PP80).
          { id: 'WL-FRESH', title: 'Fresh audit', auditedAt: new Date(now - 30 * 60 * 1000).toISOString(), updatedAt: new Date(now - HOUR_MS).toISOString(), sortIndex: 100 },
          { id: 'WL-STALE', title: 'Stale audit', auditedAt: new Date(now - 2 * HOUR_MS).toISOString(), updatedAt: new Date(now - HOUR_MS).toISOString(), sortIndex: 200 },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const result = await deps.getNextAuditCandidate('/repo');

    // AC1 (WL-0MSTLFW14000KPEC): the audit tier must request --root-only so
    // completed/in_review CHILDREN are excluded server-side and only parent
    // items are audit candidates.
    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      ['list', '--status', 'completed', '--stage', 'in_review', '--root-only', '--json'],
      expect.anything(),
    );
    expect(result).toEqual({ ok: true, candidate: { id: 'WL-STALE', title: 'Stale audit', stage: 'audit' } });
  });

  it('getNextAuditCandidate requests root-only items so child items never enter the audit tier (WL-0MSTLFW14000KPEC)', async () => {
    // AC3: child items in completed/in_review must never be dispatched as
    // audit candidates — only parent (root) items belong in the producer
    // review queue. The exclusion is delegated to the wl server filter
    // (`--root-only`, WL-0MS964SIA0057ABR), so the client contract is that
    // the `wl list` invocation carries --root-only; the mock output below
    // simulates what `wl list --root-only` returns (the child with a
    // parentId is filtered out server-side and never reaches selection).
    const now = Date.now();
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        count: 2,
        workItems: [
          { id: 'WL-PARENT', title: 'Parent epic', auditedAt: null, updatedAt: new Date(now - 60_000).toISOString(), sortIndex: 100 },
          { id: 'WL-ROOT', title: 'Standalone root', auditedAt: null, updatedAt: new Date(now - 60_000).toISOString(), sortIndex: 200 },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const result = await deps.getNextAuditCandidate('/repo');

    // AC1/AC3: the invocation MUST carry --root-only — without it, a child
    // item sitting in completed/in_review would be returned by `wl list` and
    // dispatched independently, which is exactly the bug being fixed.
    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      ['list', '--status', 'completed', '--stage', 'in_review', '--root-only', '--json'],
      expect.anything(),
    );
    // Only root-level items (no parentId) can ever be candidates.
    expect(result).toEqual({ ok: true, candidate: { id: 'WL-PARENT', title: 'Parent epic', stage: 'audit' } });
  });

  it('never dispatches a covered or uncovered child even if a leaking response includes one (AC2, WL-0MUBVH8QG0020H9L)', async () => {
    // Belt-and-suspenders: the query is root-only, but a faulty/legacy
    // response could still include a child. Neither a covered child (parent
    // has a fresh audit) nor an uncovered child (parent demoted/stale) may
    // ever be selected as an independent audit candidate.
    const now = Date.now();
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        count: 3,
        workItems: [
          {
            id: 'WL-PARENT',
            title: 'Parent',
            auditedAt: null,
            updatedAt: new Date(now - 60_000).toISOString(),
            sortIndex: 100,
          },
          {
            id: 'WL-COVERED-CHILD',
            title: 'Covered child',
            parentId: 'WL-PARENT',
            auditedAt: null,
            updatedAt: new Date(now - 60_000).toISOString(),
            sortIndex: 50,
          },
          {
            id: 'WL-UNCOVERED-CHILD',
            title: 'Uncovered child',
            parentId: 'WL-DEMOTED-PARENT',
            auditedAt: null,
            updatedAt: new Date(now - 60_000).toISOString(),
            sortIndex: 10,
          },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const result = await deps.getNextAuditCandidate('/repo');

    // The query must stay root-only...
    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      ['list', '--status', 'completed', '--stage', 'in_review', '--root-only', '--json'],
      expect.anything(),
    );
    // ...and the child candidates (lowest sortIndex, so they'd win without the
    // guard) are excluded client-side too.
    expect(result).toEqual({ ok: true, candidate: { id: 'WL-PARENT', title: 'Parent', stage: 'audit' } });
  });

  it('getNextAuditCandidate returns ok:true with no candidate when no stale/missing-audit item exists', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        count: 1,
        workItems: [
          { id: 'WL-FRESH', title: 'Fresh audit', auditedAt: '2026-01-01T00:00:30.000Z', updatedAt: '2026-01-01T00:00:00.000Z', sortIndex: 100 },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    expect(await deps.getNextAuditCandidate('/repo')).toEqual({ ok: true, candidate: null });
  });

  it('getNextAuditCandidate resolves ok:false when wl errors (a strike, never a null empty tier)', async () => {
    setExecFileAsync(vi.fn().mockRejectedValue(new Error('wl boom')) as never);
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    expect(await deps.getNextAuditCandidate('/repo')).toEqual({ ok: false, error: 'wl boom' });
  });

  it('getNextAuditCandidate passes a bounded timeout so a hung wl fails closed', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ success: true, count: 0, workItems: [] }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    await deps.getNextAuditCandidate('/repo');

    // AC1: the audit-tier invocation must carry the bounded timeout too.
    const [, , options] = mockExec.mock.calls[0];
    expect(options).toMatchObject({ timeout: DOWNTIME_WL_TIMEOUT_MS });
  });

  it('getNextAuditCandidate resolves ok:false within the timeout when wl hangs', async () => {
    vi.useFakeTimers();
    try {
      const hungExec = vi.fn(
        (_bin: string, _args: string[], opts?: { timeout?: number }) =>
          new Promise((_resolve, reject) => {
            setTimeout(
              () => reject(Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' })),
              opts?.timeout ?? DOWNTIME_WL_TIMEOUT_MS,
            );
          }),
      );
      setExecFileAsync(hungExec as never);
      const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);

      const resultPromise = deps.getNextAuditCandidate('/repo');
      await vi.advanceTimersByTimeAsync(DOWNTIME_WL_TIMEOUT_MS);
      await expect(resultPromise).resolves.toEqual({ ok: false, error: 'ETIMEDOUT' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('getNextAuditCandidate resolves ok:false on malformed wl output', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: 'not json', stderr: '' });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    expect(await deps.getNextAuditCandidate('/repo')).toEqual({ ok: false, error: 'audit parse error' });
  });

  it('getNextAuditCandidate excludes an item already dispatched for audit (marker in the log, no fresh audit)', async () => {
    // Regression (WL-0MSGTLSUT002NF29): a completed/in_review item present in
    // the shared dispatch log with kind:audit and no fresh audit is excluded
    // from audit-tier selection even though it is otherwise selectable.
    const now = Date.now();
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        count: 2,
        workItems: [
          { id: 'WL-DUP', title: 'already dispatched', auditedAt: null, updatedAt: new Date(now - 60_000).toISOString(), sortIndex: 100 },
          { id: 'WL-OTHER', title: 'fresh slot', auditedAt: null, updatedAt: new Date(now - 60_000).toISOString(), sortIndex: 200 },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    // A real dispatch log under a temp worklog root with an audit marker.
    const cwd = makeTempDir();
    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    writeFileSync(
      join(cwd, '.worklog', DOWNTIME_LOG_FILE),
      JSON.stringify({ itemId: 'WL-DUP', kind: 'audit', dispatchedAt: new Date(now - 3_600_000).toISOString(), cwd }) + '\n',
      'utf8',
    );

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const result = await deps.getNextAuditCandidate(cwd);
    expect(result).toEqual({ ok: true, candidate: { id: 'WL-OTHER', title: 'fresh slot', stage: 'audit' } });
  });

  it('getNextAuditCandidate does not exclude plan/intake markers (audit-tier-only scope guard)', async () => {
    const now = Date.now();
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        count: 1,
        workItems: [
          { id: 'WL-PLANNED', title: 'planned before', auditedAt: null, updatedAt: new Date(now - 60_000).toISOString(), sortIndex: 100 },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const cwd = makeTempDir();
    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    writeFileSync(
      join(cwd, '.worklog', DOWNTIME_LOG_FILE),
      JSON.stringify({ itemId: 'WL-PLANNED', kind: 'plan', dispatchedAt: new Date(now - 3_600_000).toISOString(), cwd }) + '\n',
      'utf8',
    );

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const result = await deps.getNextAuditCandidate(cwd);
    expect(result).toEqual({ ok: true, candidate: { id: 'WL-PLANNED', title: 'planned before', stage: 'audit' } });
  });

  it('getNextAuditCandidate treats a missing dispatch log as empty (fail-safe, dispatch still works)', async () => {
    const now = Date.now();
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        count: 1,
        workItems: [
          { id: 'WL-FRESHWORKLOG', title: 'fresh worklog', auditedAt: null, updatedAt: new Date(now - 60_000).toISOString(), sortIndex: 100 },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    // cwd with no .worklog/downtime-dispatches.log at all.
    const cwd = makeTempDir();
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const result = await deps.getNextAuditCandidate(cwd);
    expect(result).toEqual({ ok: true, candidate: { id: 'WL-FRESHWORKLOG', title: 'fresh worklog', stage: 'audit' } });
  });

  it('getNextAuditCandidate skips malformed log lines without failing the lookup', async () => {
    const now = Date.now();
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        count: 1,
        workItems: [
          { id: 'WL-OK', title: 'ok item', auditedAt: null, updatedAt: new Date(now - 60_000).toISOString(), sortIndex: 100 },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const cwd = makeTempDir();
    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    writeFileSync(
      join(cwd, '.worklog', DOWNTIME_LOG_FILE),
      'not-json\n{"broken":\n' + JSON.stringify({ itemId: 'WL-DUP', kind: 'audit', dispatchedAt: new Date(now - 3_600_000).toISOString(), cwd }) + '\n',
      'utf8',
    );

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const result = await deps.getNextAuditCandidate(cwd);
    expect(result).toEqual({ ok: true, candidate: { id: 'WL-OK', title: 'ok item', stage: 'audit' } });
  });

  // Audit-candidate scope lookup (parent WL-0MSORQ8Y4004YT63 AC1, child C2
  // WL-0MVV1EZ8G006PSBE): `wl show <id> --children --json` is the only
  // trustworthy leaf-vs-parent signal for the audit tier. The dep must use
  // the same wl discipline as every other wl-backed seam (per-root targeting,
  // bounded timeout, transient retry) and fail closed on ANY untrustworthy
  // result.
  it('getAuditCandidateScope runs wl show <id> --children --json for the candidate root and classifies a leaf', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        workItem: { id: 'WL-LEAF', title: 'Root leaf', parentId: '' },
        children: [],
        ancestors: [],
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const result = await deps.getAuditCandidateScope('WL-LEAF', '/repo');

    // Per-root targeting (WL-0MTQ14W7L003II5A): the candidate lives in ITS
    // OWN worklog root, so the lookup resolves against <cwd>/.worklog rather
    // than the pane's module-level override.
    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      ['--worklog-dir', '/repo/.worklog', 'show', 'WL-LEAF', '--children', '--json'],
      expect.anything(),
    );
    expect(result).toEqual({ ok: true, scope: 'leaf' });
  });

  it('getAuditCandidateScope reports a parent when the candidate has children', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        workItem: { id: 'WL-EPIC', title: 'Epic', parentId: '' },
        children: [{ id: 'WL-CHILD-1' }, { id: 'WL-CHILD-2' }],
        ancestors: [],
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    await expect(deps.getAuditCandidateScope('WL-EPIC', '/repo')).resolves.toEqual({
      ok: true,
      scope: 'parent',
    });
  });

  it('getAuditCandidateScope passes a bounded timeout so a hung wl fails closed', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ success: true, workItem: { id: 'WL-X', parentId: '' }, children: [] }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    await deps.getAuditCandidateScope('WL-X', '/repo');

    // Same bounded-timeout discipline as the other wl-backed deps
    // (WL-0MSJIPHD0001L1J9): a hung wl child is killed and the lookup fails
    // closed instead of wedging the dispatch tick.
    const [, , options] = mockExec.mock.calls[0];
    expect(options).toMatchObject({ timeout: DOWNTIME_WL_TIMEOUT_MS });
  });

  it('getAuditCandidateScope fails closed on a wl error — a missing lookup never relaxes the gate', async () => {
    setExecFileAsync(vi.fn().mockRejectedValue(new Error('wl boom')) as never);
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);

    const result = await deps.getAuditCandidateScope('WL-X', '/repo');

    expect(result).toEqual({ ok: false });
    // Every caller maps an untrustworthy lookup to the conservative parent
    // gate (all-slots style) — never to a leaf.
    expect(classifyAuditScope(result)).toBe('parent');
  });

  it('getAuditCandidateScope fails closed on an unparseable payload', async () => {
    setExecFileAsync(
      vi.fn().mockResolvedValue({ stdout: 'not json', stderr: '' }) as never,
    );
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);

    const result = await deps.getAuditCandidateScope('WL-X', '/repo');

    expect(result).toEqual({ ok: false });
    expect(classifyAuditScope(result)).toBe('parent');
  });

  it('getAuditCandidateScope fails closed for a NON-ROOT candidate (audit tier is root-only)', async () => {
    // `wl list --root-only` should never surface a child, but the scope
    // lookup is the last line of defence: an epic-grandchild payload whose
    // children array is empty must NOT be read as a leaf.
    setExecFileAsync(
      vi.fn().mockResolvedValue({
        stdout: JSON.stringify({
          success: true,
          workItem: { id: 'WL-CHILD', parentId: 'WL-PARENT' },
          children: [],
        }),
        stderr: '',
      }) as never,
    );
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);

    const result = await deps.getAuditCandidateScope('WL-CHILD', '/repo');

    expect(result).toEqual({ ok: false });
    expect(classifyAuditScope(result)).toBe('parent');
  });

  // Proxy audit-availability seam (WL-0MWAMSDNW000SL0E): main() wires
  // `createAuditAvailabilityClient(runSettings.downtimeProxyUrl)` onto the
  // deps object at the SAME point as `reserveLocalCapacity`. This pins that
  // `getActiveAudit` consumes that injected client (not a hard-wired read), so
  // the audit tier's decision is the proxy's shared-resource verdict.
  it('getActiveAudit consumes the injected proxy availability client (seam wiring)', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ cap: 2, live: 2, available: false }),
    });
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    deps.readAuditAvailability = createAuditAvailabilityClient(
      'http://proxy:8000',
      fetcher as never,
    );

    const result = await deps.getActiveAudit(makeTempDir());

    expect(fetcher).toHaveBeenCalledWith(
      'http://proxy:8000/llama/local/audit/status',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result).toEqual({
      ok: true,
      active: true,
      source: 'proxy',
      reason: 'audit-budget-saturated',
      budget: { live: 2, max: 2 },
    });
  });

});
