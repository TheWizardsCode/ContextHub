/**
 * packages/herdr/src/index.stalled-work-wiring.test.ts — stalled-work
 * production wiring tests (WL-0MUYMBSA90092QV2; moved in WL-0MVOA238A0078J2H).
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createDowntimeDeps,
  defaultStalledPaneRootResolver,
  defaultStalledPanesLister,
  worklogRootFromPiSessionPath,
} from './index.js';
import { DISPATCHER_ASSIGNEE } from './index.claim.js';
import { resetExecFileAsync, setExecFileAsync } from './fetcher.js';
import type { HerdrPaneRecord } from './downtime-worker.js';
import { setupHostCpuPin } from './index.fixtures.js';

setupHostCpuPin();

// ---------------------------------------------------------------------------
// Stalled-work production wiring (WL-0MUYMBSA90092QV2)
// ---------------------------------------------------------------------------

describe('stalled-work production wiring (WL-0MUYMBSA90092QV2)', () => {
  let tempDirs: string[] = [];

  beforeEach(() => {
    tempDirs = [];
  });

  afterEach(() => {
    resetExecFileAsync();
    for (const dir of tempDirs.splice(0)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  // The pi session-path encoding replaces every `/` with `-`, so a decode
  // round-trip can only be asserted for a HYPHEN-FREE root. `tmpdir()` is not
  // guaranteed hyphen-free — the test skill's runner injects
  // `/var/tmp/pi-test-<uid>` (WL-0MW5C6XS00071DWN) — so the fixture re-creates
  // the randomly-suffixed directory at a hyphen-stripped path instead of
  // inheriting the ambient TMPDIR verbatim.
  function makeRoot(): string {
    const created = mkdtempSync(join(tmpdir(), 'stallroot'));
    const dir = created.replace(/-/g, '');
    if (dir !== created) {
      mkdirSync(dir, { recursive: true });
      rmSync(created, { recursive: true, force: true });
    }
    mkdirSync(join(dir, '.worklog'), { recursive: true });
    writeFileSync(join(dir, '.worklog', 'initialized'), '');
    tempDirs.push(dir);
    return dir;
  }

  it('createDowntimeDeps wires the scan and resume seams', () => {
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    expect(typeof deps.scanStalledPanes).toBe('function');
    expect(typeof deps.resumeStalledPane).toBe('function');
  });

  it('defaultStalledPaneRootResolver resolves the pane cwd root and fails closed otherwise', () => {
    const root = makeRoot();
    expect(defaultStalledPaneRootResolver({ paneId: 'p1', cwd: root }, '/fallback')).toBe(root);
    expect(defaultStalledPaneRootResolver({ paneId: 'p2' }, '/fallback')).toBeNull();
    expect(defaultStalledPaneRootResolver({ paneId: 'p3', cwd: '/definitely/not/a/repo' }, '/fallback')).toBeNull();
  });

  it('worklogRootFromPiSessionPath decodes a pi session dir back to the worklog root', () => {
    const root = makeRoot();
    const encoded = `${root.replace(/^\//, '').split('/').join('-')}`;
    const sessionPath = `/home/pi/.pi/agent/sessions/--${encoded}--/log.jsonl`;
    expect(worklogRootFromPiSessionPath(sessionPath)).toBe(root);
    expect(worklogRootFromPiSessionPath('not-a-session-path')).toBeUndefined();
    expect(worklogRootFromPiSessionPath('')).toBeUndefined();
  });

  it('scanStalledPanes reads the machine-wide pane list and fetches the item against its OWN root', async () => {
    const root = makeRoot();
    const panes = JSON.stringify({
      result: {
        panes: [
          {
            pane_id: 'w1:p1',
            label: 'Downtime triggered implement Some item - WL-STALLED',
            agent: 'pi',
            agent_status: 'idle',
            cwd: root,
          },
        ],
      },
    });
    const showJson = JSON.stringify({
      success: true,
      workItem: {
        id: 'WL-STALLED',
        title: 'Some item',
        status: 'open',
        stage: 'plan_complete',
        updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      },
    });
    const mockExec = vi.fn().mockImplementation((_bin: string, args: string[]) => {
      if (args.includes('pane') && args.includes('list')) {
        return Promise.resolve({ stdout: panes, stderr: '' });
      }
      if (args.includes('show')) {
        return Promise.resolve({ stdout: showJson, stderr: '' });
      }
      return Promise.resolve({ stdout: '{}', stderr: '' });
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const out = await deps.scanStalledPanes!(root, {
      enabled: true,
      frozen: false,
      thresholdMs: 5 * 60 * 1000,
      nonTerminalCooldownMs: 10 * 60 * 1000,
      maxAttempts: 3,
    });

    expect(out).toHaveLength(1);
    expect(out[0].cwd).toBe(root);
    expect(out[0].kind).toBe('implement');
    // The `wl show` lookup targeted the pane's OWN root, not the leader's root.
    const showCall = mockExec.mock.calls.find(([, a]) => (a as string[]).includes('show'));
    expect(showCall?.[1]).toEqual(expect.arrayContaining(['--worklog-dir', join(root, '.worklog')]));
  });

  it('resumeStalledPane prompts a live agent with the literal continue via herdr', async () => {
    const calls: Array<[string, string[]]> = [];
    const mockExec = vi.fn().mockImplementation((bin: string, args: string[]) => {
      calls.push([bin, args]);
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const out = await deps.resumeStalledPane!(
      {
        pane: {
          paneId: 'w1:p1',
          label: 'Downtime triggered implement Some item - WL-STALLED',
          agent: 'pi',
          agentStatus: 'idle',
        },
        item: {
          id: 'WL-STALLED',
          status: 'open',
          stage: 'plan_complete',
          title: 'Some item',
          updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        },
        cwd: makeRoot(),
        kind: 'implement',
      },
      {
        enabled: true,
        frozen: false,
        thresholdMs: 5 * 60 * 1000,
        nonTerminalCooldownMs: 10 * 60 * 1000,
        maxAttempts: 3,
      },
    );

    expect(out).toMatchObject({ resumed: true, via: 'prompt', paneId: 'w1:p1' });
    const promptCall = calls.find(([, args]) => args[0] === 'agent' && args[1] === 'prompt');
    expect(promptCall?.[1]).toEqual(['agent', 'prompt', 'w1:p1', 'continue']);
  });

  // ── Unparseable pane list / session-path fallback (WL-0MUYMBUAK007H10J) ──

  it('defaultStalledPanesLister returns null for an unparseable pane list (fail-safe)', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: 'not json at all', stderr: '' });
    setExecFileAsync(mockExec as never);
    expect(await defaultStalledPanesLister()).toBeNull();
  });

  it('production scan degrades to no candidates when the pane list is unparseable', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: '<unparseable>', stderr: '' });
    setExecFileAsync(mockExec as never);
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const out = await deps.scanStalledPanes!('/leader/root', {
      enabled: true,
      frozen: false,
      thresholdMs: 5 * 60 * 1000,
      nonTerminalCooldownMs: 10 * 60 * 1000,
      maxAttempts: 3,
    });
    expect(out).toEqual([]);
  });

  it('defaultStalledPaneRootResolver falls back to the pi session path when cwd is absent', () => {
    const root = makeRoot();
    const encoded = root.replace(/^\//, '').split('/').join('-');
    const sessionPath = `/home/pi/.pi/agent/sessions/--${encoded}--/log.jsonl`;
    const pane: HerdrPaneRecord = { paneId: 'p', agentSession: { value: sessionPath } as never };
    expect(defaultStalledPaneRootResolver(pane, '/fallback')).toBe(root);
  });

  // Regression (WL-0MW5C6XS00071DWN): the fixture used to inherit the ambient
  // `tmpdir()` verbatim, so a hyphenated TMPDIR (the test skill's runner
  // injects `/var/tmp/pi-test-<uid>`) broke the lossy pi session-path
  // encoding and turned BOTH round-trip assertions above red for an
  // environment-only reason. `makeRoot()` must deliver a hyphen-free root
  // whatever TMPDIR says.
  it('keeps the fixture root hyphen-free when TMPDIR itself contains a hyphen', () => {
    const savedTmpdir = process.env.TMPDIR;
    const hyphenatedTmpdir = mkdtempSync(join(tmpdir(), 'pi-test-'));
    const strippedTmpdir = hyphenatedTmpdir.replace(/-/g, '');
    process.env.TMPDIR = hyphenatedTmpdir;
    try {
      const root = makeRoot();
      expect(root).not.toContain('-');
      const encoded = root.replace(/^\//, '').split('/').join('-');
      const sessionPath = `/home/pi/.pi/agent/sessions/--${encoded}--/log.jsonl`;
      expect(worklogRootFromPiSessionPath(sessionPath)).toBe(root);
    } finally {
      if (savedTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = savedTmpdir;
      try { rmSync(hyphenatedTmpdir, { recursive: true, force: true }); } catch { /* ignore */ }
      try { rmSync(strippedTmpdir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
