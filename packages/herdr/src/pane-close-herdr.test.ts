/**
 * packages/herdr/src/pane-close-herdr.test.ts — Tests for the production
 * herdr/session reaper deps (WL-0MUJW9FFW009008M / WL-0MUJL1NAH0042GOS).
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseHerdrPaneCloseList,
  paneKindFromLabel,
  paneItemIdFromLabel,
  readFinalAssistantEntries,
  readSessionTailLines,
  createHerdrReaperDeps,
  parsePaneProcessInfo,
  countSpawnedChildProcesses,
  dirHasRecentModifications,
} from './pane-close-herdr';

describe('parseHerdrPaneCloseList', () => {
  it('parses the {result:{panes:[…]}} envelope with agent_session', () => {
    const raw = JSON.stringify({
      id: 'cli:pane:list',
      result: {
        panes: [
          {
            pane_id: 'w1:p1',
            label: 'Downtime triggered plan Foo - WL-0ABC123',
            agent: 'pi',
            agent_status: 'idle',
            agent_session: { kind: 'path', value: '/tmp/s.jsonl' },
          },
        ],
        type: 'pane_list',
      },
    });
    const panes = parseHerdrPaneCloseList(raw);
    expect(panes).toHaveLength(1);
    expect(panes![0]).toMatchObject({
      paneId: 'w1:p1',
      agent: 'pi',
      agentStatus: 'idle',
      sessionPath: '/tmp/s.jsonl',
    });
  });

  it('parses a bare pane array', () => {
    const raw = JSON.stringify([{ paneId: 'p1', label: 'x' }]);
    expect(parseHerdrPaneCloseList(raw)![0].paneId).toBe('p1');
  });

  it('parses workspace_id (WL-0MUJMXVPO0016DZM AC1)', () => {
    const raw = JSON.stringify({
      panes: [{ pane_id: 'w2V:p1', label: 'x', workspace_id: 'w2V' }],
    });
    expect(parseHerdrPaneCloseList(raw)![0].workspaceId).toBe('w2V');
  });

  it('parses tab_id (WL-0MUJMXVPO0016DZM AC3)', () => {
    const raw = JSON.stringify({
      panes: [{ pane_id: 'w2V:p1', label: 'x', tab_id: 'w2V:tT' }],
    });
    expect(parseHerdrPaneCloseList(raw)![0].tabId).toBe('w2V:tT');
  });

  it('parses cwd and the raw agent_session object (WL-0MUYMBMCG000Z4WP AC1)', () => {
    const raw = JSON.stringify({
      result: {
        panes: [
          {
            pane_id: 'w2Y:p87',
            label: 'Manually triggered intake',
            agent: 'pi',
            agent_status: 'working',
            cwd: '/home/u/projects/OtherRoot',
            agent_session: {
              agent: 'pi',
              kind: 'path',
              source: 'herdr:pi',
              value: '/tmp/s.jsonl',
            },
          },
        ],
      },
    });
    const panes = parseHerdrPaneCloseList(raw);
    expect(panes).toHaveLength(1);
    expect(panes![0].cwd).toBe('/home/u/projects/OtherRoot');
    expect(panes![0].agentSession).toEqual({
      agent: 'pi',
      kind: 'path',
      source: 'herdr:pi',
      value: '/tmp/s.jsonl',
    });
    // sessionPath stays derived from the same field (back-compat).
    expect(panes![0].sessionPath).toBe('/tmp/s.jsonl');
  });

  it('omits cwd / agent_session when absent or malformed, without throwing (WL-0MUYMBMCG000Z4WP AC3)', () => {
    const raw = JSON.stringify({
      panes: [
        { pane_id: 'p1', cwd: 42, agent_session: 'not-an-object' },
        { pane_id: 'p2' },
      ],
    });
    const panes = parseHerdrPaneCloseList(raw)!;
    expect(panes).toHaveLength(2);
    expect(panes[0].cwd).toBeUndefined();
    expect(panes[0].agentSession).toBeUndefined();
    expect(panes[1].cwd).toBeUndefined();
    expect(panes[1].agentSession).toBeUndefined();
  });

  it('tolerates a bracketed log prefix before the JSON envelope (WL-0MUYMBMCG000Z4WP AC3)', () => {
    const raw = '[herdr] starting\n' + JSON.stringify({ result: { panes: [{ pane_id: 'p1' }] } });
    expect(parseHerdrPaneCloseList(raw)![0].paneId).toBe('p1');
  });

  it('tolerates log lines before the JSON envelope', () => {
    const raw = 'some log line\n' + JSON.stringify({ panes: [{ pane_id: 'p1' }] });
    expect(parseHerdrPaneCloseList(raw)![0].paneId).toBe('p1');
  });

  it('returns null when no pane array exists', () => {
    expect(parseHerdrPaneCloseList('not json at all')).toBeNull();
    expect(parseHerdrPaneCloseList('{"result":{}}')).toBeNull();
  });
});

describe('paneKindFromLabel', () => {
  it('derives the kind from the launcher keyword', () => {
    expect(paneKindFromLabel('Downtime triggered implement Foo - WL-1')).toBe('implement');
    expect(paneKindFromLabel('🚫 Downtime triggered plan Foo - WL-1')).toBe('plan');
    expect(paneKindFromLabel('Downtime triggered intake Foo - WL-1')).toBe('intake');
    expect(paneKindFromLabel('Downtime triggered audit Foo - WL-1')).toBe('audit');
    expect(paneKindFromLabel('Downtime triggered risk-effort Foo - WL-1')).toBe('risk-effort');
  });

  it('returns unknown for unrelated labels', () => {
    expect(paneKindFromLabel('Work Items')).toBe('unknown');
    expect(paneKindFromLabel('')).toBe('unknown');
  });
});

describe('paneItemIdFromLabel', () => {
  it('extracts the trailing work-item id', () => {
    expect(paneItemIdFromLabel('Downtime triggered plan Foo - WL-0ABC123')).toBe('WL-0ABC123');
    expect(paneItemIdFromLabel('Manually triggered implement Bar - CG-0XYZ')).toBe('CG-0XYZ');
  });

  it('returns empty when there is no id suffix', () => {
    expect(paneItemIdFromLabel('Downtime plan')).toBe('');
    expect(paneItemIdFromLabel('foo - not an id')).toBe('');
    expect(paneItemIdFromLabel('')).toBe('');
  });
});

describe('readFinalAssistantEntries', () => {
  function withTempFile(contents: string, fn: (path: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'pane-close-herdr-'));
    const path = join(dir, 'session.jsonl');
    try {
      writeFileSync(path, contents, 'utf-8');
      fn(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('extracts assistant text from the pi session shape', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
      JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '...' },
            { type: 'text', text: 'All done.\n\n</end_session>' },
          ],
        },
      }),
    ];
    withTempFile(lines.join('\n') + '\n', (path) => {
      const entries = readFinalAssistantEntries(path);
      expect(entries).toEqual([{ type: 'assistant', text: 'All done.\n\n</end_session>' }]);
    });
  });

  it('supports the simplified {type,text} shape', () => {
    withTempFile('{"type":"assistant","text":"Done"}\n', (path) => {
      expect(readFinalAssistantEntries(path)).toEqual([{ type: 'assistant', text: 'Done' }]);
    });
  });

  it('returns [] for an unreadable file', () => {
    expect(readFinalAssistantEntries('/nonexistent/path/session.jsonl')).toEqual([]);
  });
});

describe('readSessionTailLines (WL-0MUJMXVPO0016DZM AC4)', () => {
  function withTempFile(contents: string, fn: (path: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'pane-tail-'));
    const path = join(dir, 'session.jsonl');
    try {
      writeFileSync(path, contents, 'utf-8');
      fn(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('returns the last N assistant lines', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) {
      lines.push(
        JSON.stringify({
          type: 'message',
          message: { role: 'assistant', content: [{ type: 'text', text: `line ${i}` }] },
        }),
      );
    }
    withTempFile(lines.join('\n') + '\n', (path) => {
      const tail = readSessionTailLines(path, 20);
      expect(tail).toHaveLength(20);
      expect(tail[0]).toBe('line 11');
      expect(tail[19]).toBe('line 30');
    });
  });

  it('returns [] for an unreadable file', () => {
    expect(readSessionTailLines('/nonexistent/session.jsonl')).toEqual([]);
  });
});

describe('createHerdrReaperDeps', () => {
  it('maps pi panes with sessions into PaneStatus and skips session-less panes', async () => {
    const raw = JSON.stringify({
      panes: [
        {
          pane_id: 'w1:p1',
          label: 'Downtime triggered plan Foo - WL-0ABC123',
          agent: 'pi',
          agent_status: 'idle',
          agent_session: { value: '/tmp/nonexistent-but-mapped.jsonl' },
        },
        {
          pane_id: 'w1:p2',
          label: 'Work Items',
          agent_status: 'unknown',
        },
      ],
    });
    const deps = createHerdrReaperDeps({
      listPanesRaw: vi.fn().mockResolvedValue(raw),
      closePane: vi.fn().mockResolvedValue(true),
      now: () => 1_000_000,
    });
    const panes = await deps.listPanes();
    expect(panes).toHaveLength(1);
    expect(panes[0]).toMatchObject({
      id: 'w1:p1',
      kind: 'plan',
      itemId: 'WL-0ABC123',
      agentProcessAlive: true,
    });
  });

  it('maps workspace_id into PaneStatus.workspaceId (WL-0MUJMXVPO0016DZM AC1)', async () => {
    const raw = JSON.stringify({
      panes: [
        {
          pane_id: 'w2V:p1',
          label: 'Downtime triggered plan Foo - WL-0ABC123',
          agent: 'pi',
          agent_status: 'idle',
          workspace_id: 'w2V',
          agent_session: { value: '/tmp/nonexistent-but-mapped.jsonl' },
        },
      ],
    });
    const deps = createHerdrReaperDeps({
      listPanesRaw: vi.fn().mockResolvedValue(raw),
      closePane: vi.fn().mockResolvedValue(true),
    });
    const panes = await deps.listPanes();
    expect(panes[0].workspaceId).toBe('w2V');
  });

  it('treats an unreadable producer-review lookup as review-blocked (fail-closed)', async () => {
    const raw = JSON.stringify({
      panes: [
        {
          pane_id: 'w1:p1',
          label: 'Downtime triggered plan Foo - WL-0ABC123',
          agent: 'pi',
          agent_status: 'work',
          agent_session: { value: '/tmp/x.jsonl' },
        },
      ],
    });
    const deps = createHerdrReaperDeps({
      listPanesRaw: vi.fn().mockResolvedValue(raw),
      closePane: vi.fn(),
      getNeedsProducerReview: vi.fn().mockRejectedValue(new Error('wl down')),
    });
    const panes = await deps.listPanes();
    expect(panes[0].needsProducerReview).toBe(true);
  });

  it('maps closePane failure to {success:false} instead of throwing', async () => {
    const deps = createHerdrReaperDeps({
      listPanesRaw: vi.fn(),
      closePane: vi.fn().mockRejectedValue(new Error('close broke')),
    });
    await expect(deps.closePane('p1')).resolves.toMatchObject({ success: false });
  });

  it('derives ageSinceDispatchMs from the session file creation time (parent AC5)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-reaper-age-'));
    const sessionPath = join(dir, 'session.jsonl');
    try {
      writeFileSync(sessionPath, '{}\n');
      const st = statSync(sessionPath);
      const bornMs = st.birthtimeMs > 0 ? st.birthtimeMs : st.ctimeMs;
      const raw = JSON.stringify({
        panes: [
          {
            pane_id: 'w1:p1',
            label: 'Downtime triggered plan Foo - WL-0ABC123',
            agent: 'pi',
            agent_status: 'idle',
            agent_session: { value: sessionPath },
          },
        ],
      });
      const deps = createHerdrReaperDeps({
        listPanesRaw: vi.fn().mockResolvedValue(raw),
        closePane: vi.fn().mockResolvedValue(true),
        now: () => bornMs + 60_000,
      });
      const panes = await deps.listPanes();
      expect(panes).toHaveLength(1);
      expect(panes[0].ageSinceDispatchMs).toBe(60_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes activity probes through to PaneStatus (parent AC3.3)', async () => {
    const raw = JSON.stringify({
      panes: [
        {
          pane_id: 'w1:p1',
          label: 'Downtime triggered plan Foo - WL-0ABC123',
          agent: 'pi',
          agent_status: 'idle',
          agent_session: { value: '/tmp/activity-probe.jsonl' },
        },
      ],
    });
    const recent = vi.fn().mockReturnValue(true);
    const network = vi.fn().mockReturnValue(true);
    const deps = createHerdrReaperDeps({
      listPanesRaw: vi.fn().mockResolvedValue(raw),
      closePane: vi.fn(),
      hasRecentFileModifications: recent,
      hasActiveNetworkConnections: network,
    });
    const panes = await deps.listPanes();
    expect(panes).toHaveLength(1);
    expect(panes[0].hasRecentFileModifications).toBe(true);
    expect(panes[0].hasActiveNetworkConnections).toBe(true);
    expect(recent).toHaveBeenCalledWith(expect.objectContaining({ paneId: 'w1:p1' }));
    expect(network).toHaveBeenCalledWith(expect.objectContaining({ paneId: 'w1:p1' }));
  });

  it('populates itemStage and producer-review from getItemInfo (parent AC6)', async () => {
    const raw = JSON.stringify({
      panes: [
        {
          pane_id: 'w1:p1',
          label: 'Downtime triggered plan Foo - WL-0ABC123',
          agent: 'pi',
          agent_status: 'idle',
          agent_session: { value: '/tmp/item-info.jsonl' },
        },
      ],
    });
    const getItemInfo = vi.fn().mockResolvedValue({ needsProducerReview: false, stage: 'plan_complete' });
    const deps = createHerdrReaperDeps({
      listPanesRaw: vi.fn().mockResolvedValue(raw),
      closePane: vi.fn(),
      getItemInfo,
    });
    const panes = await deps.listPanes();
    expect(getItemInfo).toHaveBeenCalledWith('WL-0ABC123');
    expect(panes[0].itemStage).toBe('plan_complete');
    expect(panes[0].needsProducerReview).toBe(false);
  });

  it('treats a failed getItemInfo lookup as review-blocked (fail-closed)', async () => {
    const raw = JSON.stringify({
      panes: [
        {
          pane_id: 'w1:p1',
          label: 'Downtime triggered plan Foo - WL-0ABC123',
          agent: 'pi',
          agent_status: 'idle',
          agent_session: { value: '/tmp/item-info-fail.jsonl' },
        },
      ],
    });
    const deps = createHerdrReaperDeps({
      listPanesRaw: vi.fn().mockResolvedValue(raw),
      closePane: vi.fn(),
      getItemInfo: vi.fn().mockRejectedValue(new Error('wl down')),
    });
    const panes = await deps.listPanes();
    expect(panes[0].needsProducerReview).toBe(true);
  });

  it('maps the raw herdr agent status into PaneStatus (parent AC3/AC6)', async () => {
    const raw = JSON.stringify({
      panes: [
        {
          pane_id: 'w1:p1',
          label: 'Downtime triggered plan Foo - WL-0ABC123',
          agent: 'pi',
          agent_status: 'work',
          agent_session: { value: '/tmp/agent-status.jsonl' },
        },
      ],
    });
    const deps = createHerdrReaperDeps({
      listPanesRaw: vi.fn().mockResolvedValue(raw),
      closePane: vi.fn(),
    });
    const panes = await deps.listPanes();
    expect(panes[0].agentStatus).toBe('work');
    expect(panes[0].agentProcessAlive).toBe(true);
  });

  it('awaits an async childProcessCount probe (parent AC1/AC3)', async () => {
    const raw = JSON.stringify({
      panes: [
        {
          pane_id: 'w1:p1',
          label: 'Downtime triggered plan Foo - WL-0ABC123',
          agent: 'pi',
          agent_status: 'idle',
          agent_session: { value: '/tmp/child-count.jsonl' },
        },
      ],
    });
    const deps = createHerdrReaperDeps({
      listPanesRaw: vi.fn().mockResolvedValue(raw),
      closePane: vi.fn(),
      childProcessCount: vi.fn().mockResolvedValue(2),
    });
    const panes = await deps.listPanes();
    expect(panes[0].childProcessCount).toBe(2);
  });

  it('defaults activity probes to false when absent (backwards compatible)', async () => {
    const raw = JSON.stringify({
      panes: [
        {
          pane_id: 'w1:p1',
          label: 'Downtime triggered plan Foo - WL-0ABC123',
          agent: 'pi',
          agent_status: 'idle',
          agent_session: { value: '/tmp/activity-probe.jsonl' },
        },
      ],
    });
    const deps = createHerdrReaperDeps({
      listPanesRaw: vi.fn().mockResolvedValue(raw),
      closePane: vi.fn(),
    });
    const panes = await deps.listPanes();
    expect(panes[0].hasRecentFileModifications).toBe(false);
    expect(panes[0].hasActiveNetworkConnections).toBe(false);
  });
});

describe('parsePaneProcessInfo', () => {
  it('parses the {result:{process_info:{…}}} envelope', () => {
    const raw = JSON.stringify({
      id: 'cli:pane:process_info',
      result: {
        process_info: {
          foreground_process_group_id: 2817319,
          foreground_processes: [
            { pid: 2817319, cmdline: 'npm run dev --host' },
            { pid: 2817357, cmdline: 'sh -c vite --host' },
            { pid: 2817359, cmdline: 'node vite --host' },
          ],
        },
        type: 'pane_process_info',
      },
    });
    const info = parsePaneProcessInfo(raw);
    expect(info).toEqual({
      foregroundProcessGroupId: 2817319,
      foregroundPids: [2817319, 2817357, 2817359],
    });
  });

  it('tolerates log lines before the JSON payload', () => {
    const raw = 'connecting...\n' + JSON.stringify({ result: { process_info: { foreground_processes: [{ pid: 7 }] } } });
    expect(parsePaneProcessInfo(raw)).toEqual({ foregroundProcessGroupId: undefined, foregroundPids: [7] });
  });

  it('returns null when no JSON envelope is present', () => {
    expect(parsePaneProcessInfo('no json here')).toBeNull();
    expect(parsePaneProcessInfo('{not valid json')).toBeNull();
  });
});

describe('countSpawnedChildProcesses', () => {
  it('excludes the foreground process-group leader (the agent itself)', () => {
    expect(
      countSpawnedChildProcesses({
        foregroundProcessGroupId: 100,
        foregroundPids: [100, 101, 102],
      }),
    ).toBe(2);
  });

  it('returns 0 for an idle pane whose only process is the agent', () => {
    expect(countSpawnedChildProcesses({ foregroundProcessGroupId: 5, foregroundPids: [5] })).toBe(0);
  });

  it('returns 0 for absent process-info (fail-closed)', () => {
    expect(countSpawnedChildProcesses(null)).toBe(0);
  });
});

describe('dirHasRecentModifications', () => {
  it('detects a recently modified file and ignores stale ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-recent-'));
    try {
      writeFileSync(join(dir, 'fresh.txt'), 'x');
      const now = Date.now();
      // Freshly written file is within the window.
      expect(dirHasRecentModifications(dir, { windowMs: 60_000, nowMs: now })).toBe(true);
      // A window in the past (now far in the future) sees it as stale.
      expect(
        dirHasRecentModifications(dir, { windowMs: 1_000, nowMs: now + 3_600_000 }),
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns false for an absent directory (fail-closed)', () => {
    expect(dirHasRecentModifications('/nonexistent/does/not/exist')).toBe(false);
    expect(dirHasRecentModifications(undefined)).toBe(false);
  });

  it('descends into subdirectories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-recent-sub-'));
    try {
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, 'src', 'nested.ts'), 'x');
      expect(dirHasRecentModifications(dir, { windowMs: 60_000 })).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
