/**
 * packages/herdr/src/worklist-agent-state.test.ts — Integration tests for the
 * green-circle (agent slot) icon rendering in the selection list
 * (WL-0MSBQUJQX005RAT9 + WL-0MV1BWETT005GSUJ).
 *
 * The row's green-circle icon is authored from `item.agentState`: the
 * pane-existence marker (`markItemsActiveByPane` / `applyActivePaneMarkers`)
 * stamps `'working'` on an item when a pane in the current workspace carries
 * the item's ID in its title and clears it otherwise. These tests verify the
 * RENDERER contract directly: an item carrying `agentState='working'` renders
 * the green circle, an item without it renders none, and the fixed-width
 * agent slot keeps the item-ID column aligned across rows.
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
import { stringDisplayWidth } from '@worklog/shared/icons';
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

const GREEN_CIRCLE = '\u{1F7E2}'; // 🟢 — the green circle (work-item pane open)

describe('worklist — green-circle agent slot rendering', () => {
  it('renders the green circle when the item carries agentState (an open work-item pane)', async () => {
    vi.useFakeTimers();
    process.env.HERDR_PANE_ID = 'w1:pCM';
    setExecFileAsync(makeExecMock() as any);

    const items: WorkItem[] = [
      { id: 'WL-1', title: 'Task one', status: 'open', stage: 'idea', agentState: 'working' },
    ];
    const fetcher = vi.fn(async (): Promise<WorkItem[]> => items);

    const p = runWorklistTui(fetcher, items, undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
    });
    await vi.advanceTimersByTimeAsync(0);

    const output = writes.join('');
    expect(output).toContain(GREEN_CIRCLE);
    expect(output).toContain('WL-1');

    await quit(p);
  });

  it('renders no green circle when no agentState is present', async () => {
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

  it('keeps rows aligned: item IDs share a column with and without the green circle', async () => {
    vi.useFakeTimers();
    process.env.HERDR_PANE_ID = 'w1:pCM';
    setExecFileAsync(makeExecMock() as any);

    const items: WorkItem[] = [
      { id: 'WL-AGENT', title: 'Has pane', status: 'open', stage: 'idea', agentState: 'working' },
      { id: 'WL-PLAIN', title: 'No pane', status: 'open', stage: 'idea' },
    ];
    const fetcher = vi.fn(async (): Promise<WorkItem[]> => items);

    const p = runWorklistTui(fetcher, items, undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
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
