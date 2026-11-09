/**
 * packages/herdr/src/index.downtime-record.test.ts — host-wide audit
 * admission and `createDowntimeDeps` record* tests (work item
 * WL-0MVOA238A0078J2H).
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDowntimeDeps } from './index.js';
import { DISPATCHER_ASSIGNEE } from './index.claim.js';
import { appendDowntimeLogEntry, DOWNTIME_LOG_FILE } from './downtime-log.js';
import { readActiveAuditMarker, isHostAuditActive } from './machine-coordination.js';
import {
  freshCount,
  HOST_BUDGET_CONFIG_FILE,
  liveCount,
  reserve,
  type HostBudgetLivePane,
} from './host-dispatch-budget.js';
import { resetExecFileAsync, resetWorklogDir, setExecFileAsync, setWorklogDir } from './fetcher.js';
import { setupHostCpuPin, makeTempDir, resetTempDirs } from './index.fixtures.js';

setupHostCpuPin();

// ---------------------------------------------------------------------------
// Host-wide audit admission (WL-0MUIVE0YG000UVIA marker → WL-0MVXY0XPF006YUHA F2
// ledger)
//
// End-to-end coverage of the real `createDowntimeDeps` wiring: the
// machine-scoped dispatch-budget ledger (machine coordination dir, resolved via
// HERDR_COORDINATION_DIR) must make `getActiveAudit` report a host-wide skip for
// ANY project on the host, a non-stale legacy `active-audit` marker must be
// counted as ONE synthetic audit entry (read-compatibility), and the legacy
// marker must never be written or removed again.
// ---------------------------------------------------------------------------

describe('host-wide audit admission (WL-0MVXY0XPF006YUHA F2)', () => {
  const originalCoordinationDir = process.env.HERDR_COORDINATION_DIR;

  /** Write the legacy marker verbatim, as an older herdr instance would. */
  function writeLegacyMarker(dir: string, instanceId = 'other-instance'): void {
    writeFileSync(
      join(dir, 'active-audit'),
      JSON.stringify({ instanceId, dispatchedAt: new Date().toISOString() }),
    );
  }

  /** Write `<machine dir>/budget.json` with an explicit `maxAudit`. */
  function writeMaxAudit(dir: string, maxAudit: number): void {
    writeFileSync(join(dir, HOST_BUDGET_CONFIG_FILE), JSON.stringify({ maxAudit }));
  }

  /**
   * `wl` invocations of the stubbed exec. The host-wide fast path must not
   * issue a worklog query; a `herdr pane list` (only on the unreadable-ledger
   * repair path) is not a `wl` call.
   */
  function wlCalls(mockExec: ReturnType<typeof vi.fn>): unknown[][] {
    return mockExec.mock.calls.filter(([bin]) => bin === 'wl');
  }

  afterEach(() => {
    resetExecFileAsync();
    resetWorklogDir();
    if (originalCoordinationDir !== undefined) {
      process.env.HERDR_COORDINATION_DIR = originalCoordinationDir;
    } else {
      delete process.env.HERDR_COORDINATION_DIR;
    }
    resetTempDirs();
  });

  it('getActiveAudit counts a non-stale LEGACY marker as one synthetic audit entry (AC2 read-compatibility)', async () => {
    // Simulates a SECOND, older herdr instance on the same host: it still
    // writes the retired `active-audit` marker. The marker must keep blocking
    // this instance (mixed-version safety), i.e. it is counted as exactly one
    // audit entry against the default `maxAudit: 1`.
    const coordinationDir = makeTempDir();
    process.env.HERDR_COORDINATION_DIR = coordinationDir;
    writeLegacyMarker(coordinationDir, 'older-instance');

    const mockExec = vi.fn().mockResolvedValue({ stdout: '{}', stderr: '' });
    setExecFileAsync(mockExec as never);
    const cwd = makeTempDir();

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const result = await deps.getActiveAudit(cwd);

    // maxAudit defaults to 1 → the legacy single-flight token is preserved.
    expect(result).toEqual({
      ok: true,
      active: true,
      source: 'host-wide',
      reason: 'audit-host-saturated',
      budget: { live: 1, max: 1 },
    });
    // The host-wide fast path short-circuits before any wl query.
    expect(wlCalls(mockExec)).toEqual([]);
  });

  it('getActiveAudit reads the ledger cap: one live audit against maxAudit=2 still admits (AC3)', async () => {
    const coordinationDir = makeTempDir();
    process.env.HERDR_COORDINATION_DIR = coordinationDir;
    writeMaxAudit(coordinationDir, 2);
    expect(
      reserve({
        kind: 'audit',
        itemId: 'WL-RUNNING',
        instanceId: 'other-instance',
        root: '/repo/other',
        paneId: 'pane-1',
      }).ok,
    ).toBe(true);

    // No per-worklog marker → the per-worklog check runs and answers none.
    const mockExec = vi.fn().mockResolvedValue({ stdout: '{}', stderr: '' });
    setExecFileAsync(mockExec as never);
    const cwd = makeTempDir();

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const result = await deps.getActiveAudit(cwd);

    // One of two permitted audits is running: this tick may dispatch the second.
    expect(result).toEqual({ ok: true, active: false, source: 'per-worklog' });
  });

  it('getActiveAudit refuses the third audit with host-budget-audit at maxAudit=2 (AC3)', async () => {
    const coordinationDir = makeTempDir();
    process.env.HERDR_COORDINATION_DIR = coordinationDir;
    writeMaxAudit(coordinationDir, 2);
    for (const itemId of ['WL-A', 'WL-B']) {
      expect(
        reserve({
          kind: 'audit',
          itemId,
          instanceId: 'other-instance',
          root: '/repo/other',
          paneId: `pane-${itemId}`,
        }).ok,
      ).toBe(true);
    }

    const mockExec = vi.fn().mockResolvedValue({ stdout: '{}', stderr: '' });
    setExecFileAsync(mockExec as never);
    const cwd = makeTempDir();

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const result = await deps.getActiveAudit(cwd);

    expect(result).toEqual({
      ok: true,
      active: true,
      source: 'host-wide',
      reason: 'host-budget-audit',
      budget: { live: 2, max: 2 },
    });
    expect(wlCalls(mockExec)).toEqual([]);
  });

  it('getActiveAudit refuses every audit at maxAudit=0 with 0/0 evidence (AC3)', async () => {
    const coordinationDir = makeTempDir();
    process.env.HERDR_COORDINATION_DIR = coordinationDir;
    writeMaxAudit(coordinationDir, 0);

    const mockExec = vi.fn().mockResolvedValue({ stdout: '{}', stderr: '' });
    setExecFileAsync(mockExec as never);
    const cwd = makeTempDir();

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const result = await deps.getActiveAudit(cwd);

    // The kill switch reports the same token at every live count, with 0/0.
    expect(result).toEqual({
      ok: true,
      active: true,
      source: 'host-wide',
      reason: 'host-budget-audit',
      budget: { live: 0, max: 0 },
    });
  });

  it('getActiveAudit fails closed on an unreadable ledger and repairs it from live panes (AC6)', async () => {
    const coordinationDir = makeTempDir();
    process.env.HERDR_COORDINATION_DIR = coordinationDir;
    writeFileSync(join(coordinationDir, 'dispatch-budget.json'), '{ not json');

    setExecFileAsync(vi.fn().mockResolvedValue({ stdout: '{}', stderr: '' }) as never);
    const cwd = makeTempDir();

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const result = await deps.getActiveAudit(cwd);

    expect(result).toEqual({
      ok: true,
      active: true,
      source: 'host-wide',
      reason: 'host-budget-unknown',
      budget: { live: 0, max: 1 },
    });
    // Self-healing: the unreadable document was rewritten from live state (no
    // downtime panes here, so an empty but VALID ledger).
    expect(freshCount('audit')).toMatchObject({ ok: true, count: 0 });
  });

  it('getActiveAudit falls back to the per-worklog check when the host-wide marker is absent (AC1, backward compatible)', async () => {
    // No machine-wide marker: the legacy per-worklog check still runs and
    // reports its own source, so existing single-project behaviour is intact.
    const coordinationDir = makeTempDir();
    process.env.HERDR_COORDINATION_DIR = coordinationDir;

    const cwd = makeTempDir();
    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    writeFileSync(
      join(cwd, '.worklog', DOWNTIME_LOG_FILE),
      JSON.stringify({
        itemId: 'WL-AUD',
        kind: 'audit',
        dispatchedAt: new Date().toISOString(),
        cwd,
      }) + '\n',
      'utf8',
    );
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        count: 1,
        workItems: [{ id: 'WL-AUD', title: 'audited', status: 'in_progress' }],
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const result = await deps.getActiveAudit(cwd);

    expect(result).toEqual({ ok: true, active: true, source: 'per-worklog' });
  });

  it('a stale host-wide marker is ignored and the audit slot is released (AC1)', async () => {
    const coordinationDir = makeTempDir();
    process.env.HERDR_COORDINATION_DIR = coordinationDir;
    // Write a marker far in the past (simulating a crashed audit pane whose
    // cleanup never ran); it must be treated as released.
    const markerPath = join(coordinationDir, 'active-audit');
    mkdirSync(coordinationDir, { recursive: true });
    writeFileSync(
      markerPath,
      JSON.stringify({
        instanceId: 'crashed-instance',
        dispatchedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      }),
      'utf8',
    );

    const mockExec = vi.fn().mockResolvedValue({ stdout: '{}', stderr: '' });
    setExecFileAsync(mockExec as never);
    const cwd = makeTempDir();

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const result = await deps.getActiveAudit(cwd);

    // No in_progress item either → no active audit, and source is the
    // per-worklog fallback (the stale host marker was released).
    expect(result).toEqual({ ok: true, active: false, source: 'per-worklog' });
    expect(isHostAuditActive(coordinationDir)).toBe(false);
  });

  it('recordDispatch never writes the retired host-wide marker for an audit dispatch (AC2)', async () => {
    const coordinationDir = makeTempDir();
    process.env.HERDR_COORDINATION_DIR = coordinationDir;
    setExecFileAsync(vi.fn().mockResolvedValue({ stdout: '{}', stderr: '' }) as never);
    const cwd = makeTempDir();

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    await deps.recordDispatch({
      itemId: 'WL-AUD',
      kind: 'audit',
      dispatchedAt: new Date().toISOString(),
      cwd,
    });

    // The ledger (reserved in the claim pipeline) is the authority now; the
    // legacy file is never created again.
    expect(readActiveAuditMarker(coordinationDir)).toBeNull();
  });

  it('recordPaneClose releases the audit ledger reservation (AC5)', async () => {
    const coordinationDir = makeTempDir();
    process.env.HERDR_COORDINATION_DIR = coordinationDir;
    const cwd = makeTempDir();
    expect(
      reserve({
        kind: 'audit',
        itemId: 'WL-AUD',
        instanceId: 'this-instance',
        root: cwd,
        paneId: 'w1:p2',
      }).ok,
    ).toBe(true);
    expect(freshCount('audit')).toMatchObject({ ok: true, count: 1 });

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    await deps.recordPaneClose(
      {
        entryType: 'pane-close',
        timestamp: new Date().toISOString(),
        itemId: 'WL-AUD',
        itemTitle: 'Audited item',
        paneId: 'w1:p2',
        kind: 'audit',
        outcome: 'audit-passed',
        reasonCode: 'none',
        closed: true,
      },
      cwd,
    );

    // The host-wide audit slot is given back: the ledger no longer holds the
    // reservation, whatever the lifecycle outcome.
    expect(freshCount('audit')).toMatchObject({ ok: true, count: 0 });
  });

  it('recordPaneClose never removes a legacy marker file (AC2)', async () => {
    const coordinationDir = makeTempDir();
    process.env.HERDR_COORDINATION_DIR = coordinationDir;
    writeLegacyMarker(coordinationDir, 'older-instance');
    const cwd = makeTempDir();

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    for (const kind of ['audit', 'plan'] as const) {
      await deps.recordPaneClose(
        {
          entryType: 'pane-close',
          timestamp: new Date().toISOString(),
          itemId: 'WL-AUD',
          itemTitle: 'Audited item',
          paneId: 'w1:p2',
          kind,
          outcome: kind === 'audit' ? 'audit-passed' : 'closed-as-plan-complete',
          reasonCode: 'none',
          closed: true,
        },
        cwd,
      );
    }

    // Retirement: this version does not remove the file either — read-
    // compatibility lasts until the file goes stale.
    expect(isHostAuditActive(coordinationDir)).toBe(true);
  });

  it('recordPaneClose releases the host dispatch-budget reservation (F3 AC3)', async () => {
    const coordinationDir = makeTempDir();
    process.env.HERDR_COORDINATION_DIR = coordinationDir;
    const cwd = makeTempDir();
    // An in-flight implement reserved on the machine-scoped ledger.
    const reserved = reserve({
      kind: 'implement',
      itemId: 'WL-IMP',
      instanceId: 'this-instance',
      root: cwd,
      paneId: 'w1:p9',
    });
    expect(reserved.ok).toBe(true);
    const livePanes: HostBudgetLivePane[] = [
      { paneId: 'w1:p9', title: 'Downtime triggered implement Do it - WL-IMP' },
    ];
    expect(liveCount('implement', livePanes)).toMatchObject({ ok: true, count: 1 });

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    await deps.recordPaneClose(
      {
        entryType: 'pane-close',
        timestamp: new Date().toISOString(),
        itemId: 'WL-IMP',
        itemTitle: 'Do it',
        paneId: 'w1:p9',
        kind: 'implement',
        outcome: 'closed-as-implemented',
        reasonCode: 'none',
        closed: true,
      },
      cwd,
    );

    // The machine-wide slot is given back: the pane is still live but the
    // ledger no longer holds the reservation.
    expect(liveCount('implement', livePanes)).toMatchObject({ ok: true, count: 0 });
  });

  it('recordDispatchFailure never removes a legacy marker file (AC2)', async () => {
    const coordinationDir = makeTempDir();
    process.env.HERDR_COORDINATION_DIR = coordinationDir;
    writeLegacyMarker(coordinationDir, 'older-instance');
    const cwd = makeTempDir();

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    await deps.recordDispatchFailure({
      itemId: 'WL-AUD',
      kind: 'audit',
      dispatchedAt: new Date().toISOString(),
      cwd,
      error: 'spawn ENOENT',
      exitCode: null,
    });

    // The ledger reservation is released by the claim pipeline's spawn-failure
    // path (asserted in downtime-worker.dispatch.test.ts); the legacy file is
    // left to go stale.
    expect(isHostAuditActive(coordinationDir)).toBe(true);
  });
});

describe('createDowntimeDeps recordDispatch', () => {
  afterEach(() => {
    resetExecFileAsync();
    resetWorklogDir();
    resetTempDirs();
  });

  it('adds an audit comment via wl comment add with the herdr-downtime author', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: '{}', stderr: '' });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    await deps.recordDispatch({
      itemId: 'WL-ABC',
      kind: 'plan',
      dispatchedAt: '2026-01-01T00:00:00.000Z',
      cwd: '/repo',
    });

    // The comment is targeted at the dispatch root (event.cwd) via stateless
    // buildWlArgsForRoot — the item's own DB, never the ambient override.
    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      [
        '--worklog-dir',
        '/repo/.worklog',
        'comment',
        'add',
        'WL-ABC',
        '--comment',
        expect.stringContaining('/skill:plan WL-ABC'),
        '--author',
        'herdr-downtime',
        '--json',
      ],
      expect.anything(),
    );
  });

  it('targets the comment at event.cwd (the item root) even when the module override points elsewhere', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: '{}', stderr: '' });
    setExecFileAsync(mockExec as never);
    setWorklogDir('/home/user/projects/SorraAgents/.worklog');

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    await deps.recordDispatch({
      itemId: 'SA-ABC',
      kind: 'plan',
      dispatchedAt: '2026-01-01T00:00:00.000Z',
      cwd: '/home/user/projects/SorraAgents',
    });

    // The audit comment must land on the item in ITS project's DB — the
    // dispatch root event.cwd (WL-0MSI7DQL10016QYX semantics preserved;
    // cross-root leader dispatches target the offer's root, WL-0MTQ14W7L003II5A).
    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      [
        '--worklog-dir',
        '/home/user/projects/SorraAgents/.worklog',
        'comment',
        'add',
        'SA-ABC',
        '--comment',
        expect.stringContaining('/skill:plan SA-ABC'),
        '--author',
        'herdr-downtime',
        '--json',
      ],
      expect.anything(),
    );
  });

  it('writes a JSONL entry to .worklog/downtime-dispatches.log under the cwd', async () => {
    setExecFileAsync(vi.fn().mockResolvedValue({ stdout: '{}', stderr: '' }) as never);
    const cwd = makeTempDir();

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    await deps.recordDispatch({
      itemId: 'WL-ABC',
      kind: 'intake',
      dispatchedAt: '2026-01-01T00:00:00.000Z',
      cwd,
    });

    const raw = readFileSync(join(cwd, '.worklog', DOWNTIME_LOG_FILE), 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.itemId).toBe('WL-ABC');
    expect(entry.kind).toBe('intake');
    expect(entry.dispatchedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('resolves true even when wl comment add fails (comment is not the marker)', async () => {
    setExecFileAsync(vi.fn().mockRejectedValue(new Error('wl boom')) as never);
    const cwd = makeTempDir();
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);

    // The comment write failing must NOT abort the dispatch — the rolling-log
    // marker is the dispatch-suppression source. The log write succeeds, so
    // recordDispatch resolves true (no throw, dispatch proceeds).
    await expect(
      deps.recordDispatch({
        itemId: 'WL-ABC',
        kind: 'plan',
        dispatchedAt: '2026-01-01T00:00:00.000Z',
        cwd,
      }),
    ).resolves.toBe(true);
    // The marker still landed even though the comment failed.
    const raw = readFileSync(join(cwd, '.worklog', DOWNTIME_LOG_FILE), 'utf8');
    expect(raw).toContain('WL-ABC');
  });

  it('resolves false (marker write failed → dispatch aborts) when the log write fails', async () => {
    setExecFileAsync(vi.fn().mockResolvedValue({ stdout: '{}', stderr: '' }) as never);
    const cwd = makeTempDir();
    writeFileSync(join(cwd, '.worklog'), 'not a directory', 'utf8');

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    await expect(
      deps.recordDispatch({
        itemId: 'WL-ABC',
        kind: 'plan',
        dispatchedAt: '2026-01-01T00:00:00.000Z',
        cwd,
      }),
    ).resolves.toBe(false);
  });

  it('skips the wl comment for scheduled-prompt dispatches (noItemComment, AC4)', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: '{}', stderr: '' });
    setExecFileAsync(mockExec as never);
    const cwd = makeTempDir();

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    await deps.recordDispatch({
      itemId: '/skill:refactor',
      kind: 'scheduled',
      dispatchedAt: '2026-01-01T00:00:00.000Z',
      cwd,
      noItemComment: true,
    });

    // There is no work item — no wl comment is attempted; the rolling-log
    // marker is the only trace.
    expect(mockExec).not.toHaveBeenCalled();
    const raw = readFileSync(join(cwd, '.worklog', DOWNTIME_LOG_FILE), 'utf8');
    const entry = JSON.parse(raw.split('\n').filter((l) => l.trim() !== '')[0]) as {
      kind?: string;
      itemId?: string;
    };
    expect(entry.kind).toBe('scheduled');
    expect(entry.itemId).toBe('/skill:refactor');
  });
});

describe('createDowntimeDeps recordError', () => {
  afterEach(() => {
    resetTempDirs();
  });

  it('writes a JSONL entry to the rolling downtime log under the cwd', async () => {
    const cwd = makeTempDir();

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    await deps.recordError({
      cwd,
      at: '2026-01-01T00:00:00.000Z',
      message: 'Downtime worker: 3 consecutive wl CLI errors',
    });

    const raw = readFileSync(join(cwd, '.worklog', DOWNTIME_LOG_FILE), 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.at).toBe('2026-01-01T00:00:00.000Z');
    expect(entry.message).toContain('3 consecutive');
  });

  it('is fail-closed when the log write fails (e.g. .worklog path is a file)', async () => {
    const cwd = makeTempDir();
    writeFileSync(join(cwd, '.worklog'), 'not a directory', 'utf8');

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    await expect(
      deps.recordError({ cwd, at: '2026-01-01T00:00:00.000Z', message: 'boom' }),
    ).resolves.toBeUndefined();
  });
});

describe('createDowntimeDeps recordDispatchFailure', () => {
  afterEach(() => {
    resetTempDirs();
  });

  it('writes an outcome:spawn-failed JSONL entry with the error trace under the cwd', async () => {
    const cwd = makeTempDir();

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    await deps.recordDispatchFailure({
      itemId: 'WL-ABC',
      kind: 'plan',
      dispatchedAt: '2026-01-01T00:00:00.000Z',
      cwd,
      stage: 'intake_complete',
      error: 'ENOENT: send-to-pi.sh',
    });

    const raw = readFileSync(join(cwd, '.worklog', DOWNTIME_LOG_FILE), 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    // The failure entry mirrors the marker fields (so the marker readers keep
    // excluding the item exactly as the standing marker does) and adds the
    // outcome + trace so the log distinguishes "attempted" from "opened"
    // (WL-0MSLWJ3I70031Z8U AC2).
    expect(entry).toEqual({
      itemId: 'WL-ABC',
      kind: 'plan',
      dispatchedAt: '2026-01-01T00:00:00.000Z',
      cwd,
      stage: 'intake_complete',
      error: 'ENOENT: send-to-pi.sh',
      outcome: 'spawn-failed',
    });
  });

  it('records the exit-code trace for a non-zero script exit', async () => {
    const cwd = makeTempDir();

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    await deps.recordDispatchFailure({
      itemId: 'WL-ABC',
      kind: 'implement',
      dispatchedAt: '2026-01-01T00:00:00.000Z',
      cwd,
      exitCode: 1,
    });

    const raw = readFileSync(join(cwd, '.worklog', DOWNTIME_LOG_FILE), 'utf8');
    const entry = JSON.parse(raw.split('\n').filter((l) => l.trim() !== '')[0]);
    expect(entry.outcome).toBe('spawn-failed');
    expect(entry.exitCode).toBe(1);
  });

  it('is fail-closed when the log write fails (never crashes the worker)', async () => {
    const cwd = makeTempDir();
    writeFileSync(join(cwd, '.worklog'), 'not a directory', 'utf8');

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    await expect(
      deps.recordDispatchFailure({
        itemId: 'WL-ABC',
        kind: 'plan',
        dispatchedAt: '2026-01-01T00:00:00.000Z',
        cwd,
      }),
    ).resolves.toBeUndefined();
  });
});
