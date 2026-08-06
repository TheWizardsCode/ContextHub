/**
 * packages/herdr/src/worklist-agent-state.test.ts — Integration tests for
 * merging agent-status state into fetched work items (WL-0MSBQUJQX005RAT9).
 *
 * runWorklistTui accepts a `mergeAgentStates` callback that is applied to
 * freshly fetched items (top-level + expanded children) on every refresh
 * cycle. This verifies the plumbing: when the callback stamps an
 * `agentState` on an item, the row renders the agent-status icon; without
 * it, the row renders no agent icon.
 *
 * Run: npx vitest run packages/herdr/src/worklist-agent-state.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('./auto-sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./auto-sync.js')>();
  return {
    ...actual,
    runSync: vi.fn().mockResolvedValue({ success: true }),
  };
});

vi.mock('./notify.js', () => ({
  showToast: vi.fn(),
}));

import { runWorklistTui } from './worklist.js';
import { setExecFileAsync, resetExecFileAsync } from './fetcher.js';
import { stringDisplayWidth } from './icons.js';
import type { WorkItem } from './fetcher.js';

let dataHandler: ((chunk: Buffer) => void) | undefined;
let writes: string[];

beforeEach(() => {
  vi.clearAllMocks();
  dataHandler = undefined;
  writes = [];

  for (const prop of ['on', 'removeListener', 'pause', 'resume', 'setRawMode'] as const) {
    if (!(prop in process.stdin)) {
      Object.defineProperty(process.stdin, prop, {
        value: vi.fn(),
        configurable: true,
        writable: true,
      });
    }
  }
  (process.stdin as any).on = vi.fn((event: string, cb: (chunk: Buffer) => void) => {
    if (event === 'data') dataHandler = cb;
    return process.stdin;
  });
  (process.stdin as any).removeListener = vi.fn(() => process.stdin);
  (process.stdin as any).pause = vi.fn(() => process.stdin);
  (process.stdin as any).resume = vi.fn(() => process.stdin);
  (process.stdin as any).setRawMode = vi.fn(() => process.stdin);
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

  vi.spyOn(process.stdout, 'write').mockImplementation(((s: any) => {
    writes.push(String(s));
    return true;
  }) as any);
  vi.spyOn(process.stdout, 'on').mockImplementation((() => process.stdout as any) as any);
  vi.spyOn(process.stdout, 'removeListener').mockImplementation((() => process.stdout as any) as any);
});

afterEach(() => {
  resetExecFileAsync();
  delete process.env.HERDR_PANE_ID;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeExecMock(): Mock {
  return vi.fn(async (bin: string, args: string[]) => {
    if (bin === 'herdr' && args[0] === 'pane' && args[1] === 'get') {
      return {
        stdout: JSON.stringify({ id: 'cli:pane:get', result: { pane: { focused: true } } }),
        stderr: '',
      };
    }
    if (args.includes('list') && args.includes('--status')) {
      return { stdout: JSON.stringify({ count: 5 }), stderr: '' };
    }
    return { stdout: JSON.stringify({ workItems: [] }), stderr: '' };
  });
}

async function quit(p: Promise<unknown>): Promise<void> {
  dataHandler?.(Buffer.from('q'));
  await p;
}

const GREEN_CIRCLE = '\u{1F7E2}'; // 🟢 — the agent working icon

describe('worklist — agent-state merge into fetched items', () => {
  it('renders the agent-status icon when mergeAgentStates stamps an agentState', async () => {
    vi.useFakeTimers();
    process.env.HERDR_PANE_ID = 'w1:pCM';
    setExecFileAsync(makeExecMock() as any);

    const fetcher = vi.fn(async (): Promise<WorkItem[]> => [
      { id: 'WL-1', title: 'Task one', status: 'open', stage: 'idea' },
    ]);

    const p = runWorklistTui(fetcher, [], undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
      mergeAgentStates: async (items: WorkItem[]) => {
        for (const it of items) {
          if (it.id === 'WL-1') it.agentState = 'working';
        }
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    fetcher.mockClear();

    // Trigger the first auto-refresh cycle, which applies mergeAgentStates.
    await vi.advanceTimersByTimeAsync(30_000);

    const output = writes.join('');
    expect(output).toContain(GREEN_CIRCLE);
    expect(output).toContain('WL-1');

    await quit(p);
  });

  it('renders no agent icon when no agentState is stamped', async () => {
    vi.useFakeTimers();
    process.env.HERDR_PANE_ID = 'w1:pCM';
    setExecFileAsync(makeExecMock() as any);

    const fetcher = vi.fn(async (): Promise<WorkItem[]> => [
      { id: 'WL-1', title: 'Task one', status: 'open', stage: 'idea' },
    ]);

    const p = runWorklistTui(fetcher, [], undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    fetcher.mockClear();

    await vi.advanceTimersByTimeAsync(30_000);

    const output = writes.join('');
    expect(output).toContain('WL-1');
    expect(output).not.toContain(GREEN_CIRCLE);

    await quit(p);
  });

  it('keeps rows aligned: item IDs share a column with and without the agent icon', async () => {
    vi.useFakeTimers();
    process.env.HERDR_PANE_ID = 'w1:pCM';
    setExecFileAsync(makeExecMock() as any);

    const fetcher = vi.fn(async (): Promise<WorkItem[]> => [
      { id: 'WL-AGENT', title: 'Has agent', status: 'open', stage: 'idea' },
      { id: 'WL-PLAIN', title: 'No agent', status: 'open', stage: 'idea' },
    ]);

    const p = runWorklistTui(fetcher, [], undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
      mergeAgentStates: async (items: WorkItem[]) => {
        for (const it of items) {
          if (it.id === 'WL-AGENT') it.agentState = 'working';
        }
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    fetcher.mockClear();

    await vi.advanceTimersByTimeAsync(30_000);

    const output = writes.join('');
    const lines = output.split('\n');
    const findLine = (id: string): string => lines.find((l) => l.includes(id)) ?? '';
    const agentLine = findLine('WL-AGENT');
    const plainLine = findLine('WL-PLAIN');
    expect(agentLine).not.toBe('');
    expect(plainLine).not.toBe('');
    // Compare DISPLAY columns. Strip ANSI colour codes (the selected row
    // carries a reverse-video marker) and normalize the selection marker:
    // stringDisplayWidth models `▸` (U+25B8) as 2 cells, but terminals
    // render it as 1, so the selected row measures 1 cell wider than the
    // non-selected row even though real columns align. Ignoring surrogate-pair
    // code-unit indexes too (emoji), which differ though columns don't.
    const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');
    const norm = (s: string): string => stripAnsi(s).replace('▸', ' ');
    const idCol = (line: string, id: string): number => {
      const vis = norm(line);
      return stringDisplayWidth(vis.slice(0, vis.indexOf(id)));
    };
    expect(idCol(agentLine, 'WL-AGENT')).toBe(idCol(plainLine, 'WL-PLAIN'));

    await quit(p);
  });
});
