/**
 * packages/herdr/src/pane-close-herdr.test.ts — Tests for the production
 * herdr/session reaper deps (WL-0MUJW9FFW009008M / WL-0MUJL1NAH0042GOS).
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseHerdrPaneCloseList,
  paneKindFromLabel,
  paneItemIdFromLabel,
  readFinalAssistantEntries,
  createHerdrReaperDeps,
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
});
