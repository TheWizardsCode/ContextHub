/**
 * Cross-root item-resolution tests for the downtime leader
 * (WL-0MTQ14W7L003II5A).
 *
 * The machine-wide coordination file holds ONE offer per herdr instance,
 * each naming a work item in THAT instance's own worklog root (AH- in
 * AI_Hell, CG- in Tableau-Card-Engine, WL- in ContextHub). When the elected
 * leader processes a FOREIGN offer it must resolve the item against the
 * offer's root — `wl show` / the audit-enrichment `wl list` / the CAS claim
 * `wl update` / the `wl comment add` trail must all carry
 * `--worklog-dir <root>/.worklog`. The pre-fix code resolved every lookup
 * against the leader's own module-level `_worklogDir`, so a foreign offer
 * produced "Work item not found" → 3 wl-error strikes → 60-minute dispatch
 * pause while the portal showed idle slots.
 *
 * These tests assert the observable CLI arg vectors produced through the
 * real `createDowntimeDeps` seam (exec mocked), plus the stateless
 * `buildWlArgsForRoot` helper that makes per-call root targeting possible
 * without the racy global `_worklogDir` swap.
 *
 * Run: npx vitest run packages/herdr/src/fetchAuditItemById.test.ts
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDowntimeDeps } from './index.js';
import {
  claimWorkItem,
  getWorklogDir,
  setWorklogDir,
  resetWorklogDir,
  setExecFileAsync,
  resetExecFileAsync,
  buildWlArgsForRoot,
} from './fetcher.js';

const tempDirs: string[] = [];

/** Create a temp directory (the dispatch event's cwd) for tests that write a marker. */
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wlroot-crossroot-'));
  tempDirs.push(dir);
  return dir;
}

/** A foreign worklog root whose items use a non-WL prefix. */
const FOREIGN_ROOT = '/home/user/projects/AI_Hell';

const openShowPayload = (id: string, stage = 'intake_complete'): string =>
  JSON.stringify({
    success: true,
    workItem: { id, title: 'Foreign item', status: 'open', stage },
  });

afterEach(() => {
  resetExecFileAsync();
  resetWorklogDir();
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true }); } catch { /* ignore */ }
  }
  tempDirs.length = 0;
});

describe('buildWlArgsForRoot (stateless per-call targeting)', () => {
  it('prepends --worklog-dir <root>/.worklog before the subcommand', () => {
    expect(buildWlArgsForRoot(FOREIGN_ROOT, ['show', 'AH-ABC', '--json'])).toEqual([
      '--worklog-dir',
      join(FOREIGN_ROOT, '.worklog'),
      'show',
      'AH-ABC',
      '--json',
    ]);
  });

  it('does not mutate the module-level override (no cross-root state leak)', () => {
    setWorklogDir('/home/user/projects/ContextHub/.worklog');
    buildWlArgsForRoot(FOREIGN_ROOT, ['show', 'AH-ABC', '--json']);
    expect(getWorklogDir()).toBe('/home/user/projects/ContextHub/.worklog');
  });
});

describe('fetchItem (leader per-entry lookup) cross-root resolution', () => {
  it('targets the passed worklog root for wl show (AC1)', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: openShowPayload('AH-ABC'),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    const result = await deps.fetchItem('AH-ABC', FOREIGN_ROOT);

    expect(result.ok).toBe(true);
    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      ['--worklog-dir', join(FOREIGN_ROOT, '.worklog'), 'show', 'AH-ABC', '--json'],
      expect.anything(),
    );
  });

  it('is unchanged when the item root matches the module override (AC2 no-regression)', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: openShowPayload('WL-X'),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);
    setWorklogDir('/repo/.worklog');

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    await deps.fetchItem('WL-X', '/repo');

    // Exactly the vector the pre-fix code produced via the module override —
    // no duplicated flag, no corrupted prefix.
    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      ['--worklog-dir', '/repo/.worklog', 'show', 'WL-X', '--json'],
      expect.anything(),
    );
  });

  it('applies --worklog-dir to the audit-enrichment list query too (completed/in_review)', async () => {
    const showPayload = JSON.stringify({
      success: true,
      workItem: {
        id: 'AH-AUD',
        title: 'Audit me',
        status: 'completed',
        stage: 'in_review',
        updatedAt: '2026-09-01T00:00:00.000Z',
      },
    });
    const listPayload = JSON.stringify({
      success: true,
      workItems: [{ id: 'AH-AUD', updatedAt: '2026-09-01T00:00:00.000Z', auditedAt: null }],
    });
    const mockExec = vi
      .fn()
      .mockImplementation((_bin: string, args: string[]) =>
        Promise.resolve({
          // Subcommand sits AFTER the --worklog-dir prefix (args[0..1]).
          stdout: args.includes('show') ? showPayload : listPayload,
          stderr: '',
        }),
      );
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    const result = await deps.fetchItem('AH-AUD', FOREIGN_ROOT);

    expect(result.ok).toBe(true);
    expect(result.info?.auditedAt).toBeNull();
    // Both lookups (show + the completed/in_review enrichment list) must
    // resolve against the SAME foreign root — a second wrong-root lookup
    // would strike just as hard as the first.
    expect(mockExec.mock.calls).toHaveLength(2);
    for (const [, args] of mockExec.mock.calls as [string, string[]][]) {
      expect(args[0]).toBe('--worklog-dir');
      expect(args[1]).toBe(join(FOREIGN_ROOT, '.worklog'));
    }
    expect((mockExec.mock.calls[1][1] as string[]).includes('list')).toBe(true);
  });

  it('hasFreshAudit routes the show lookup to the passed root', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: openShowPayload('AH-ABC'),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    const fresh = await deps.hasFreshAudit('AH-ABC', FOREIGN_ROOT);

    expect(fresh).toBe(false); // open item → no audit freshness
    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      ['--worklog-dir', join(FOREIGN_ROOT, '.worklog'), 'show', 'AH-ABC', '--json'],
      expect.anything(),
    );
  });
});

describe('claimItem cross-root resolution', () => {
  it('targets the passed root for the CAS claim (foreign dispatchable offer)', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: '{"success":true}', stderr: '' });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    const result = await deps.claimItem(
      'AH-ABC',
      { status: 'open', stage: 'intake_complete' },
      FOREIGN_ROOT,
    );

    expect(result).toEqual({ ok: true });
    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      [
        '--worklog-dir',
        join(FOREIGN_ROOT, '.worklog'),
        'update',
        'AH-ABC',
        '--status',
        'in_progress',
        '--assignee',
        'Map',
        '--if-status',
        'open',
        '--if-stage',
        'intake_complete',
        '--json',
      ],
      expect.anything(),
    );
  });

  it('without a cwd behaves as before (no --worklog-dir when unconfigured)', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: '{"success":true}', stderr: '' });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    const result = await deps.claimItem('WL-ABC', { status: 'open', stage: 'idea' });

    expect(result).toEqual({ ok: true });
    const args = mockExec.mock.calls[0][1] as string[];
    expect(args).not.toContain('--worklog-dir');
  });
});

describe('claimWorkItem (fetcher) cross-root', () => {
  it('prepends --worklog-dir <root>/.worklog when a worklogRoot is passed', async () => {
    const mockFn = vi.fn().mockResolvedValue({ stdout: '{"success":true}', stderr: '' });
    setExecFileAsync(mockFn as never);

    const result = await claimWorkItem('AH-ABC', 'Map', { status: 'open' }, FOREIGN_ROOT);

    expect(result.success).toBe(true);
    const callArgs = mockFn.mock.calls[0][1] as string[];
    expect(callArgs.slice(0, 3)).toEqual([
      '--worklog-dir',
      join(FOREIGN_ROOT, '.worklog'),
      'update',
    ]);
  });

  it('omits --worklog-dir when no root is passed and the module is unconfigured', async () => {
    const mockFn = vi.fn().mockResolvedValue({ stdout: '{"success":true}', stderr: '' });
    setExecFileAsync(mockFn as never);

    await claimWorkItem('WL-ABC', 'Map');

    const callArgs = mockFn.mock.calls[0][1] as string[];
    expect(callArgs).not.toContain('--worklog-dir');
  });
});

describe('recordDispatch cross-root comment trail', () => {
  it('comments the item in ITS OWN root DB even when the leader tab points elsewhere', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: '{}', stderr: '' });
    setExecFileAsync(mockExec as never);
    // The leader pane's resolved root (ContextHub) — different from the
    // dispatch root, the exact cross-root contamination scenario.
    setWorklogDir('/home/user/projects/ContextHub/.worklog');
    const cwd = makeTempDir(); // the foreign dispatch root (real dir for the marker)

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    const marked = await deps.recordDispatch({
      itemId: 'AH-ABC',
      kind: 'plan',
      dispatchedAt: '2026-01-01T00:00:00.000Z',
      cwd,
    });

    expect(marked).toBe(true); // marker written under the dispatch root
    const args = mockExec.mock.calls[0][1] as string[];
    expect(args.slice(0, 2)).toEqual(['--worklog-dir', join(cwd, '.worklog')]);
    expect(args).toContain('AH-ABC');
  });
});
