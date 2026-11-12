/**
 * packages/herdr/src/index.downtime-dispatch.test.ts — `createDowntimeDeps`
 * implement/critical tier selection, end-to-end dispatch, claim and pane spawn
 * tests (work item WL-0MVOA238A0078J2H).
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDowntimeDeps } from './index.js';
import { DOWNTIME_WL_TIMEOUT_MS, dispatchDowntimeWork } from './downtime-worker.js';
import { DISPATCHER_ASSIGNEE } from './index.claim.js';
import { DOWNTIME_LOG_FILE, readDowntimeLogEntries } from './downtime-log.js';
import { freshCount, reserve } from './host-dispatch-budget.js';
import { resetExecFileAsync, setExecFileAsync, setWorklogDir } from './fetcher.js';
import { setupHostCpuPin, makeTempDir, useIsolatedCoordinationDir, criticalWlMock } from './index.fixtures.js';

setupHostCpuPin();

describe('createDowntimeDeps', () => {
  useIsolatedCoordinationDir();

  it('getNextImplementCandidate runs wl next plan_complete risk/effort batch and selects the first open item', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        count: 2,
        requested: 10,
        results: [
          { workItem: { id: 'WL-OPEN', title: 'Open low-risk', status: 'open', risk: 'low', effort: 'small' } },
          { workItem: { id: 'WL-DONE', title: 'Completed epic', status: 'completed', risk: 'low', effort: 'small' } },
        ],
        workItems: [
          { workItem: { id: 'WL-OPEN', title: 'Open low-risk', status: 'open', risk: 'low', effort: 'small' } },
          { workItem: { id: 'WL-DONE', title: 'Completed epic', status: 'completed', risk: 'low', effort: 'small' } },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const result = await deps.getNextImplementCandidate('/repo');

    // The invocation must carry the risk/effort filters and a generous batch
    // count (-n) so completed items can be filtered out client-side without
    // starving selection (WL-0MSMAYIKX005LLO4 AC2/AC3).
    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      ['next', '--stage', 'plan_complete', '--risk', 'medium', '--effort', 'medium', '-n', expect.any(String), '--json'],
      expect.anything(),
    );
    // wl next keeps completed items with a stage filter; the client-side
    // status=open filter drops the completed epic and selects WL-OPEN.
    expect(result).toEqual({ id: 'WL-OPEN', title: 'Open low-risk', stage: 'implement' });
  });

  it('getNextImplementCandidate relies on wl next default dependency-blocked exclusion (no --include-blocked)', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        count: 1,
        workItems: [
          { workItem: { id: 'WL-OPEN', title: 'Open low-risk', status: 'open', risk: 'low', effort: 'small' } },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    await deps.getNextImplementCandidate('/repo');

    const [, args] = mockExec.mock.calls[0];
    // Dependency-blocked exclusion is wl next's default (includeBlocked=false).
    // The implement tier must never opt into --include-blocked, or blocked
    // candidates would reach the dispatch layer (WL-0MSMAYIKX005LLO4 AC3).
    expect(args).not.toContain('--include-blocked');
  });

  it('getNextImplementCandidate returns null when no open candidate exists (all completed)', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        count: 1,
        workItems: [
          { workItem: { id: 'WL-DONE', title: 'Completed epic', status: 'completed', risk: 'low', effort: 'small' } },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    expect(await deps.getNextImplementCandidate('/repo')).toBeNull();
  });

  it('getNextImplementCandidate fails closed (null) when wl errors', async () => {
    setExecFileAsync(vi.fn().mockRejectedValue(new Error('wl boom')) as never);
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    expect(await deps.getNextImplementCandidate('/repo')).toBeNull();
  });

  it('getNextImplementCandidate fails closed (null) on malformed wl output', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: 'not json', stderr: '' });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    expect(await deps.getNextImplementCandidate('/repo')).toBeNull();
  });

  it('getNextImplementCandidate passes a bounded timeout so a hung wl fails closed', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ success: true, count: 0, workItems: [] }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    await deps.getNextImplementCandidate('/repo');

    const [, , options] = mockExec.mock.calls[0];
    expect(options).toMatchObject({ timeout: DOWNTIME_WL_TIMEOUT_MS });
  });

  it('getNextImplementCandidate excludes an item already dispatched for implement (kind implement marker)', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        count: 2,
        workItems: [
          { workItem: { id: 'WL-DUP', title: 'already dispatched', status: 'open', risk: 'low', effort: 'small' } },
          { workItem: { id: 'WL-FRESH', title: 'fresh slot', status: 'open', risk: 'low', effort: 'small' } },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const cwd = makeTempDir();
    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    writeFileSync(
      join(cwd, '.worklog', DOWNTIME_LOG_FILE),
      JSON.stringify({ itemId: 'WL-DUP', kind: 'implement', dispatchedAt: new Date(Date.now() - 3_600_000).toISOString(), cwd }) + '\n',
      'utf8',
    );

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const result = await deps.getNextImplementCandidate(cwd);
    expect(result).toEqual({ id: 'WL-FRESH', title: 'fresh slot', stage: 'implement' });
  });

  it('getNextImplementCandidate does not exclude audit/plan/intake markers (implement-tier-only scope guard)', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        count: 1,
        workItems: [
          { workItem: { id: 'WL-IMP', title: 'implementable', status: 'open', risk: 'low', effort: 'small' } },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const cwd = makeTempDir();
    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    writeFileSync(
      join(cwd, '.worklog', DOWNTIME_LOG_FILE),
      JSON.stringify({ itemId: 'WL-IMP', kind: 'audit', dispatchedAt: new Date(Date.now() - 3_600_000).toISOString(), cwd }) + '\n',
      'utf8',
    );

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const result = await deps.getNextImplementCandidate(cwd);
    expect(result).toEqual({ id: 'WL-IMP', title: 'implementable', stage: 'implement' });
  });

  it('getNextImplementCandidate treats a missing dispatch log as empty (fail-safe, dispatch still works)', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        count: 1,
        workItems: [
          { workItem: { id: 'WL-FRESHWORKLOG', title: 'fresh worklog', status: 'open', risk: 'low', effort: 'small' } },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const cwd = makeTempDir(); // no .worklog/downtime-dispatches.log
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const result = await deps.getNextImplementCandidate(cwd);
    expect(result).toEqual({ id: 'WL-FRESHWORKLOG', title: 'fresh worklog', stage: 'implement' });
  });

  it('getNextImplementCandidate applies --worklog-dir when the tab resolved a worklog root', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ success: true, count: 0, workItems: [] }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);
    setWorklogDir('/home/user/projects/SorraAgents/.worklog');

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    await deps.getNextImplementCandidate('/repo');

    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      [
        '--worklog-dir',
        '/home/user/projects/SorraAgents/.worklog',
        'next',
        '--stage',
        'plan_complete',
        '--risk',
        'medium',
        '--effort',
        'medium',
        '-n',
        expect.any(String),
        '--json',
      ],
      expect.anything(),
    );
  });

  it('getNextCriticalCandidate runs wl list --priority critical --status open across ALL stages', async () => {
    const mockExec = criticalWlMock([
      { id: 'WL-CRIT-IDEA', title: 'Critical idea', status: 'open', stage: 'idea', risk: 'low', effort: 'small', sortIndex: 100 },
      { id: 'WL-CRIT-READY', title: 'Critical ready', status: 'open', stage: 'intake_complete', risk: 'low', effort: 'small', sortIndex: 200 },
      { id: 'WL-CRIT-PLAN', title: 'Critical planned', status: 'open', stage: 'plan_complete', risk: 'medium', effort: 'medium', sortIndex: 300 },
    ]);
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const result = await deps.getNextCriticalCandidate('/repo');

    // The critical lookup must NOT be stage-gated: every open critical
    // stage is enumerated, and the lowest sortIndex wins deterministically.
    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      ['list', '--priority', 'critical', '--status', 'open', '-n', expect.any(String), '--json'],
      expect.anything(),
    );
    expect(result).toEqual({
      ok: true,
      candidate: { id: 'WL-CRIT-IDEA', title: 'Critical idea', stage: 'idea' },
    });
  });

  it('getNextCriticalCandidate includes dependency-blocked items (no wl next exclusion)', async () => {
    const mockExec = criticalWlMock([
      { id: 'WL-CRIT-BLOCKED', title: 'Blocked critical', status: 'open', stage: 'plan_complete', risk: 'low', effort: 'small', sortIndex: 10 },
    ]);
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    await deps.getNextCriticalCandidate('/repo');

    const [, args] = mockExec.mock.calls[0];
    // wl list does not exclude dependency-blocked items — the critical
    // lookup must never opt into wl next's --include-blocked machinery or
    // add a stage filter, or blocked critical items would vanish from the
    // dispatch queue (Q3 needs them for frontier resolution).
    expect(args).not.toContain('--include-blocked');
    expect(args).not.toContain('--stage');
  });

  it('getNextCriticalCandidate honors the plan_complete implement caps (Q2: above caps not selected)', async () => {
    const mockExec = criticalWlMock([
      { id: 'WL-CRIT-HIRISK', title: 'High-risk critical', status: 'open', stage: 'plan_complete', risk: 'high', effort: 'small', sortIndex: 10 },
      { id: 'WL-CRIT-READY', title: 'Critical ready', status: 'open', stage: 'intake_complete', risk: 'low', effort: 'small', sortIndex: 900 },
    ]);
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const result = await deps.getNextCriticalCandidate('/repo');

    // The plan_complete critical is above the risk cap → never
    // implement-dispatched; the intake_complete critical wins instead.
    expect(result).toEqual({
      ok: true,
      candidate: { id: 'WL-CRIT-READY', title: 'Critical ready', stage: 'intake_complete' },
    });
  });

  it('getNextCriticalCandidate excludes items still at their dispatched-at stage (change-guard)', async () => {
    const mockExec = criticalWlMock([
      { id: 'WL-CRIT-ONCE', title: 'already dispatched at idea', status: 'open', stage: 'idea', risk: 'low', effort: 'small', sortIndex: 5 },
      { id: 'WL-CRIT-NEXT', title: 'next critical', status: 'open', stage: 'intake_complete', risk: 'low', effort: 'small', sortIndex: 20 },
    ]);
    setExecFileAsync(mockExec as never);

    const cwd = makeTempDir();
    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    writeFileSync(
      join(cwd, '.worklog', DOWNTIME_LOG_FILE),
      JSON.stringify({ itemId: 'WL-CRIT-ONCE', kind: 'intake', stage: 'idea', dispatchedAt: new Date(Date.now() - 3_600_000).toISOString(), cwd }) + '\n',
      'utf8',
    );

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const result = await deps.getNextCriticalCandidate(cwd);

    // WL-CRIT-ONCE was dispatched for /skill:intake at idea and is still at
    // idea → excluded by the change-guard; the next critical is selected.
    expect(result).toEqual({
      ok: true,
      candidate: { id: 'WL-CRIT-NEXT', title: 'next critical', stage: 'intake_complete' },
    });
  });

  it('getNextCriticalCandidate releases an item whose stage advanced past its dispatched-at stage', async () => {
    const mockExec = criticalWlMock([
      { id: 'WL-CRIT-ADV', title: 'advanced critical', status: 'open', stage: 'plan_complete', risk: 'low', effort: 'small', sortIndex: 5 },
    ]);
    setExecFileAsync(mockExec as never);

    const cwd = makeTempDir();
    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    writeFileSync(
      join(cwd, '.worklog', DOWNTIME_LOG_FILE),
      JSON.stringify({ itemId: 'WL-CRIT-ADV', kind: 'plan', stage: 'intake_complete', dispatchedAt: new Date(Date.now() - 3_600_000).toISOString(), cwd }) + '\n',
      'utf8',
    );

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const result = await deps.getNextCriticalCandidate(cwd);

    // Marked at intake_complete, now at plan_complete → released.
    expect(result).toEqual({
      ok: true,
      candidate: { id: 'WL-CRIT-ADV', title: 'advanced critical', stage: 'plan_complete' },
    });
  });

  it('getNextCriticalCandidate treats a missing dispatch log as empty (fail-safe, dispatch still works)', async () => {
    const mockExec = criticalWlMock([
      { id: 'WL-CRIT-FRESH', title: 'fresh worklog critical', status: 'open', stage: 'idea', risk: 'low', effort: 'small', sortIndex: 5 },
    ]);
    setExecFileAsync(mockExec as never);

    const cwd = makeTempDir(); // no .worklog/downtime-dispatches.log
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const result = await deps.getNextCriticalCandidate(cwd);
    expect(result).toEqual({
      ok: true,
      candidate: { id: 'WL-CRIT-FRESH', title: 'fresh worklog critical', stage: 'idea' },
    });
  });

  it('getNextCriticalCandidate reports ok:true with no candidate when the critical tier is empty', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ success: true, count: 0, workItems: [] }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    expect(await deps.getNextCriticalCandidate('/repo')).toEqual({ ok: true, candidate: null });
  });

  it('getNextCriticalCandidate fails closed ({ok:false}) on wl error (never a silent empty)', async () => {
    setExecFileAsync(vi.fn().mockRejectedValue(new Error('wl boom')) as never);
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    expect(await deps.getNextCriticalCandidate('/repo')).toEqual({ ok: false, error: 'wl boom' });
  });

  it('getNextCriticalCandidate fails closed ({ok:false}) on malformed wl output', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: 'not json', stderr: '' });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    expect(await deps.getNextCriticalCandidate('/repo')).toEqual({ ok: false, error: 'critical parse error' });
  });

  it('getNextCriticalCandidate passes a bounded timeout so a hung wl fails closed', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ success: true, count: 0, workItems: [] }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    await deps.getNextCriticalCandidate('/repo');

    const [, , options] = mockExec.mock.calls[0];
    expect(options).toMatchObject({ timeout: DOWNTIME_WL_TIMEOUT_MS });
  });

  it('getNextCriticalCandidate applies --worklog-dir when the tab resolved a worklog root', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ success: true, count: 0, workItems: [] }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);
    setWorklogDir('/home/user/projects/SorraAgents/.worklog');

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    await deps.getNextCriticalCandidate('/repo');

    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      [
        '--worklog-dir',
        '/home/user/projects/SorraAgents/.worklog',
        'list',
        '--priority',
        'critical',
        '--status',
        'open',
        '-n',
        expect.any(String),
        '--json',
      ],
      expect.anything(),
    );
  });

  it('getNextCriticalCandidate returns the frontier blocker when the selected critical is dependency-blocked (F3 Q3)', async () => {
    // The selected critical item depends on an OPEN blocker (outbound
    // depends-on edge). Per decision Q3 the dep follows the blocking
    // chain and returns the nearest open blocker with ITS stage — the
    // dispatch tier then runs the blocker's stage-appropriate skill.
    const mockExec = criticalWlMock(
      [
        { id: 'WL-CRIT-CHILD', title: 'Critical child', status: 'open', stage: 'idea', risk: 'low', effort: 'small', sortIndex: 5 },
      ],
      {
        'WL-CRIT-CHILD': [
          { id: 'WL-BLOCKER', title: 'Blocking critical', status: 'open', priority: 'critical', direction: 'depends-on' },
        ],
      },
    );
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const result = await deps.getNextCriticalCandidate('/repo');

    // The dep queries the candidate's edges with `wl dep list`, then
    // enriches the blocker via `wl show` (dep edges lack stage/risk/
    // effort/sortIndex), and returns the frontier blocker — unblocked
    // BLOCKER resolves to itself, carrying its intake_complete stage.
    expect(result).toEqual({
      ok: true,
      candidate: { id: 'WL-BLOCKER', title: 'blocker', stage: 'intake_complete' },
    });
    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      ['dep', 'list', 'WL-CRIT-CHILD', '--json'],
      expect.anything(),
    );
    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      ['show', 'WL-BLOCKER', '--json'],
      expect.anything(),
    );
  });

  it('getNextCriticalCandidate returns null candidate when the blocking chain bottoms in a closed item (F3: fall through to tiers)', async () => {
    // The selected critical item's blocker is closed (completed) — the
    // frontier chain bottoms and the dep reports a null candidate so the
    // critical tier falls through to the normal tier order.
    const mockExec = criticalWlMock(
      [
        { id: 'WL-CRIT-CHILD', title: 'Critical child', status: 'open', stage: 'idea', risk: 'low', effort: 'small', sortIndex: 5 },
      ],
      {
        'WL-CRIT-CHILD': [
          { id: 'WL-CLOSED-BLOCKER', title: 'Closed blocker', status: 'completed', priority: 'critical', direction: 'depends-on' },
        ],
      },
      {
        'WL-CLOSED-BLOCKER': { id: 'WL-CLOSED-BLOCKER', title: 'Closed blocker', status: 'completed', stage: 'completed', risk: 'low', effort: 'small', sortIndex: 3 },
      },
    );
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const result = await deps.getNextCriticalCandidate('/repo');

    expect(result).toEqual({ ok: true, candidate: null });
  });

  it('getNextCriticalCandidate fails closed to a strike when wl dep list errors (F3 AC5: no silent fall-through)', async () => {
    const mockExec = vi.fn().mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === 'dep') return Promise.reject(new Error('wl dep boom'));
      return Promise.resolve({
        stdout: JSON.stringify({
          success: true,
          count: 1,
          workItems: [
            { id: 'WL-CRIT-CHILD', title: 'Critical child', status: 'open', stage: 'idea', risk: 'low', effort: 'small', sortIndex: 5 },
          ],
        }),
        stderr: '',
      });
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const result = await deps.getNextCriticalCandidate('/repo');

    // A dependency look-up failure must NOT look like an empty tier — it
    // is a wl-error strike.
    expect(result).toEqual({ ok: false, error: 'wl dep boom' });
  });

  it('end-to-end: two consecutive idle windows dispatch a single unaudited candidate exactly once', async () => {
    // AC5 (parent): with one unaudited completed/in_review candidate and two
    // consecutive idle windows (no audit recorded between), the worker
    // dispatches exactly once. The first dispatch writes the durable
    // per-worklog marker (kind:audit) AND reserves the machine-scoped audit
    // slot (WL-0MVXY0XPF006YUHA F2). The second window's PROXY-DERIVED audit
    // admission check (WL-0MWAMSDNW000SL0E) reads the proxy's availability,
    // which now holds the lease the first dispatch acquired, and skips the
    // audit tier outright — reporting the proxy's own token
    // 'audit-budget-saturated' (never 'no-candidate', so the no-candidate
    // cooldown is not entered while the audit runs) — so no second dispatch.
    const now = Date.now();
    const candidate = {
      id: 'WL-ONCE',
      title: 'dispatch me once',
      status: 'completed',
      stage: 'in_review',
      auditedAt: null,
      updatedAt: new Date(now - 60_000).toISOString(),
      sortIndex: 100,
    };
    // wl list always returns the same single candidate (both for the
    // audit-candidate lookup and, as the still-in_progress item, for the
    // active-audit check); wl next returns no candidate so a second (wrong)
    // audit dispatch would be the only path.
    const mockExec = vi.fn((_bin: string, args: string[]) => {
      if (args.includes('--status') && args.includes('in_progress')) {
        // Active-audit check: the dispatched item is still in_progress.
        return Promise.resolve({
          stdout: JSON.stringify({ success: true, count: 1, workItems: [candidate] }),
          stderr: '',
        });
      }
      if (args[0] === 'list') {
        return Promise.resolve({
          stdout: JSON.stringify({ success: true, count: 1, workItems: [candidate] }),
          stderr: '',
        });
      }
      return Promise.resolve({ stdout: JSON.stringify({ success: true, workItem: null }), stderr: '' });
    });
    setExecFileAsync(mockExec as never);
    const spawnFn = vi.fn(() => ({ unref: vi.fn(), once: vi.fn() }));
    // The real deps resolve the project workspace / item-ID tab / per-prefix
    // tab via the herdr CLI, which is absent in tests — inject stub resolvers
    // so the anchored spawn path is exercised without a live herdr session.
    // Project workspace + item-ID tab (WL-0MU321YK70035AYT): the PRIMARY
    // placement path — the worklog dispatch resolves the item's own project
    // workspace and anchors to the tab labelled with the exact work-item id.
    // The per-prefix Dispatcher tab and the legacy single anchor are fallbacks
    // (only when no project workspace resolves) — see WL-0MUR5FUWD00024XN.
    const anchorResolver = vi.fn().mockResolvedValue({ paneId: 'wD:FALLBACK', workspaceId: 'wD' });
    const projectWorkspaceResolver = vi
      .fn()
      .mockResolvedValue({ paneId: 'wC:pB', workspaceId: 'wC', tabId: 'wC:tPlugin' });
    const itemTabAnchorResolver = vi
      .fn()
      .mockResolvedValue({ tabId: 'wC:tWL-ONCE', paneId: 'wC:tWL-ONCE:pTEST' });
    const dispatcherTabAnchorResolver = vi
      .fn()
      .mockResolvedValue({ workspaceId: 'wD', tabId: 'wD:tWL', paneId: 'wD:tWL:pTEST' });
    const deps = createDowntimeDeps(
      '/path/to/send-to-pi.sh',
      DISPATCHER_ASSIGNEE,
      spawnFn,
      anchorResolver as never,
      undefined,
      projectWorkspaceResolver as never,
      itemTabAnchorResolver as never,
      dispatcherTabAnchorResolver as never,
    );
    const cwd = makeTempDir();

    // Proxy-managed audit budget (WL-0MWAMSDNW000SL0E): the proxy holds the
    // live audit lease, so it admits window 1 and reports saturation once the
    // first dispatch's lease is live. Flipped after window 1 below.
    let proxySaturated = false;
    deps.readAuditAvailability = vi.fn(async () => ({
      status: 'ok' as const,
      availability: {
        cap: 1,
        live: proxySaturated ? 1 : 0,
        available: !proxySaturated,
      },
    }));

    // Idle window 1: audit candidate selected and dispatched.
    const first = await dispatchDowntimeWork(deps, { model: 'plan', cwd });
    expect(first.dispatched).toBe(true);
    expect(first.kind).toBe('audit');
    expect(first.candidate?.id).toBe('WL-ONCE');
    // The resolved project-workspace item-ID tab anchor pane id is forwarded
    // to send-to-pi.sh as --anchor: the pane lands in the project workspace's
    // `WL-ONCE` tab. The per-prefix Dispatcher tab and the legacy single anchor
    // are NOT used (WL-0MUR5FUWD00024XN AC2/AC4).
    expect(projectWorkspaceResolver).toHaveBeenCalledWith(cwd);
    expect(itemTabAnchorResolver).toHaveBeenCalledWith(cwd, 'wC', 'WL-ONCE');
    expect(dispatcherTabAnchorResolver).not.toHaveBeenCalled();
    expect(anchorResolver).not.toHaveBeenCalled();
    const spawnArgs = (spawnFn as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string[] | undefined;
    expect(spawnArgs).toContain('--anchor');
    expect(spawnArgs).toContain('wC:tWL-ONCE:pTEST');

    // The durable marker landed in the shared log (kind:audit).
    const entries = await readDowntimeLogEntries(cwd);
    expect(entries.some((e) => e.itemId === 'WL-ONCE' && e.kind === 'audit')).toBe(true);
    // The machine-scoped ledger holds the audit slot — the state the second
    // tick refuses against.
    expect(freshCount('audit')).toMatchObject({ ok: true, count: 1 });

    // The proxy now reports the live audit lease: window 2 skips the tier.
    proxySaturated = true;

    // Idle window 2: the proxy-derived audit admission check skips the audit
    // tier (audit-budget-saturated); nothing else to dispatch.
    const second = await dispatchDowntimeWork(deps, { model: 'plan', cwd });
    expect(second.dispatched).toBe(false);
    expect(second.reason).toBe('audit-budget-saturated');
    expect(second.kind).toBeUndefined();
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it('claimItem runs wl update --status in_progress --assignee with CAS guards', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const result = await deps.claimItem('WL-ABC', { status: 'open', stage: 'intake_complete' });

    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      [
        'update',
        'WL-ABC',
        '--status',
        'in_progress',
        '--assignee',
        DISPATCHER_ASSIGNEE,
        '--if-status',
        'open',
        '--if-stage',
        'intake_complete',
        '--json',
      ],
      expect.anything(),
    );
    expect(result).toEqual({ ok: true });
  });

  it('claimItem resolves stale when the CAS guard fails (another pane won the race)', async () => {
    const mockExec = vi
      .fn()
      .mockRejectedValue(new Error('{"success":false,"error":"stale","message":"Conditional update skipped"}'));
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const result = await deps.claimItem('WL-ABC', { status: 'open', stage: 'idea' });

    expect(result).toEqual({ ok: false, reason: 'stale', error: '{"success":false,"error":"stale","message":"Conditional update skipped"}' });
  });

  it('claimItem resolves error (a strike) when wl fails for any other reason', async () => {
    setExecFileAsync(vi.fn().mockRejectedValue(new Error('wl boom')) as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const result = await deps.claimItem('WL-ABC', { status: 'open', stage: 'idea' });

    expect(result).toEqual({ ok: false, reason: 'error', error: 'wl boom' });
  });

  it('spawnAgentPane spawns send-to-pi.sh with the derived pane name and args', async () => {
    const spawnFn = vi.fn(() => ({ unref: vi.fn(), once: vi.fn() }));
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE, spawnFn);

    await deps.spawnAgentPane('Run /skill:plan WL-ABC — Some task.', {
      model: 'plan',
      cwd: '/repo',
    });

    expect(spawnFn).toHaveBeenCalledWith(
      '/path/to/send-to-pi.sh',
      [
        '--pane-name',
        'Downtime plan',
        '--no-focus',
        '--cwd',
        '/repo',
        '--model',
        'plan',
        'Run /skill:plan WL-ABC — Some task.',
      ],
      { cwd: '/repo' },
    );
    const handle = (spawnFn as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(handle.unref).toHaveBeenCalled();
  });

  it('spawnAgentPane derives the intake pane name from the prompt', async () => {
    const spawnFn = vi.fn(() => ({ unref: vi.fn(), once: vi.fn() }));
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE, spawnFn);

    await deps.spawnAgentPane('Run /skill:intake WL-DEF — An idea.', {
      model: 'plan',
      cwd: '/repo',
    });

    expect(spawnFn).toHaveBeenCalledWith(
      '/path/to/send-to-pi.sh',
      expect.arrayContaining(['--pane-name', 'Downtime intake']),
      expect.anything(),
    );
  });

  it('spawnAgentPane derives the audit pane name from the prompt', async () => {
    const spawnFn = vi.fn(() => ({ unref: vi.fn(), once: vi.fn() }));
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE, spawnFn);

    await deps.spawnAgentPane('Run /skill:audit WL-AUD — Audit me.', {
      model: 'plan',
      cwd: '/repo',
    });

    expect(spawnFn).toHaveBeenCalledWith(
      '/path/to/send-to-pi.sh',
      expect.arrayContaining(['--pane-name', 'Downtime audit']),
      expect.anything(),
    );
  });

  it('spawnAgentPane honours an explicit paneName (scheduled prompts run as Downtime <id>)', async () => {
    const spawnFn = vi.fn(() => ({ unref: vi.fn(), once: vi.fn() }));
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE, spawnFn);

    await deps.spawnAgentPane('/skill:refactor', {
      model: 'plan',
      cwd: '/repo',
      paneName: 'Downtime /skill:refactor',
    });

    expect(spawnFn).toHaveBeenCalledWith(
      '/path/to/send-to-pi.sh',
      [
        '--pane-name',
        'Downtime /skill:refactor',
        '--no-focus',
        '--cwd',
        '/repo',
        '--model',
        'plan',
        '/skill:refactor',
      ],
      { cwd: '/repo' },
    );
  });

});
