/**
 * packages/herdr/src/worklist-icons.test.ts — TUI-level integration tests
 * for the showIcons setting gating (WL-0MSBV4RYO008JL70).
 *
 * runWorklistTui accepts a `getShowIcons` getter (wired from the settings
 * file in index.ts) that is consulted on every render. When it returns
 * false the item lines render text fallbacks ([OPEN], [IDEA], ...) instead
 * of emoji icons; when true (the default) icons are rendered. Because the
 * getter is re-read per render, editing showIcons in the config applies on
 * the next render without a plugin restart.
 *
 * Run: npx vitest run packages/herdr/src/worklist-icons.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks (must be hoisted before worklist.js is imported)
// ---------------------------------------------------------------------------
// Keep the REAL fetcher + visibility modules (so the exec seam and PollGate
// run for real) but avoid real `wl`/`herdr` process spawns by injecting a
// mock execFileAsync via setExecFileAsync() in each test.

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
import type { WorkItem } from './fetcher.js';

// ---------------------------------------------------------------------------
// Fake stdin/stdout harness (same pattern as worklist-agent-state.test.ts)
// ---------------------------------------------------------------------------

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

const OPEN_ICON = '\u{1F513}'; // 🔓 — the open-status icon
const AUDIT_UNKNOWN_ICON = '\u{2753}'; // ❓ — audit-unknown icon (metadata panel)

describe('worklist — showIcons gating through runWorklistTui', () => {
  it('renders item icons by default (backwards compatible)', async () => {
    vi.useFakeTimers();
    process.env.HERDR_PANE_ID = 'w1:pCM';
    setExecFileAsync(makeExecMock() as any);

    const fetcher = vi.fn(async (): Promise<WorkItem[]> => [
      { id: 'WL-1', title: 'Task one', status: 'open', stage: 'idea' },
    ]);

    const p = runWorklistTui(fetcher, undefined, undefined, {
      autoRefresh: false,
      autoSync: false,
      showHelpText: false,
    });
    await vi.advanceTimersByTimeAsync(0);

    const output = writes.join('');
    expect(output).toContain(OPEN_ICON);
    expect(output).toContain('WL-1');
    expect(output).not.toContain('[OPEN]');
    expect(output).toContain(AUDIT_UNKNOWN_ICON); // metadata panel audit icon still shown

    await quit(p);
  });

  it('omits item icons when getShowIcons returns false', async () => {
    vi.useFakeTimers();
    process.env.HERDR_PANE_ID = 'w1:pCM';
    setExecFileAsync(makeExecMock() as any);

    const fetcher = vi.fn(async (): Promise<WorkItem[]> => [
      { id: 'WL-1', title: 'Task one', status: 'open', stage: 'idea', priority: 'high' },
    ]);

    const p = runWorklistTui(fetcher, undefined, undefined, {
      autoRefresh: false,
      autoSync: false,
      showHelpText: false,
      getShowIcons: () => false,
    });
    await vi.advanceTimersByTimeAsync(0);

    const output = writes.join('');
    expect(output).not.toContain(OPEN_ICON);
    expect(output).toContain('[OPEN]'); // status text fallback
    expect(output).toContain('WL-1');
    expect(output).not.toContain(AUDIT_UNKNOWN_ICON); // metadata panel audit icon
    expect(output).toContain('unknown'); // audit text label (metadata falls back to plain text, WL-0MSGIXHHI009KFW9)

    await quit(p);
  });

  it('applies a showIcons change on the next render (per-render re-read)', async () => {
    vi.useFakeTimers();
    process.env.HERDR_PANE_ID = 'w1:pCM';
    setExecFileAsync(makeExecMock() as any);

    // Mutable flag standing in for the settings file on disk: the getter
    // re-reads it on every render, so flipping it between renders applies
    // without a plugin restart (mirrors getShowHelpText behavior).
    let showIcons = true;
    const fetcher = vi.fn(async (): Promise<WorkItem[]> => [
      { id: 'WL-1', title: 'Task one', status: 'open', stage: 'idea' },
    ]);

    const p = runWorklistTui(fetcher, undefined, undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
      getShowIcons: () => showIcons,
    });
    await vi.advanceTimersByTimeAsync(0);
    fetcher.mockClear();

    // First render (initial load) — icons shown.
    expect(writes.join('')).toContain(OPEN_ICON);

    // User edits the config to disable icons, then the next refresh renders.
    showIcons = false;
    writes = []; // ignore the initial render — assert only the refresh render
    await vi.advanceTimersByTimeAsync(30_000);

    const output = writes.join('');
    expect(output).not.toContain(OPEN_ICON);
    expect(output).toContain('[OPEN]');
    expect(output).toContain('WL-1');

    await quit(p);
  });
});
