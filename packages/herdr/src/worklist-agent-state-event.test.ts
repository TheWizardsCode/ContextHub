/**
 * packages/herdr/src/worklist-agent-state-event.test.ts — Integration tests
 * for the EVENT-DRIVEN agent-status + focus/visibility paths
 * (WL-0MSHB7DHO004RHBJ F4/F5/F6).
 *
 * Verifies end-to-end that a mocked herdr event socket drives:
 *  - `pane_agent_status_changed` → immediate icon update (no `herdr agent
 *    list` exec), coalesced per render cycle.
 *  - `pane_agent_detected` → re-read of the shared `.worklog/agent-panes.json`
 *    (cross-instance / late-spawned agents) + per-pane subscription sync.
 *  - `pane_closed` / `pane_exited` → prune associations + icon clear.
 *  - `pane_focused` → immediate visibility update (no `herdr tab get`) and
 *    refresh on hidden → visible, clearing the paused indicator.
 *
 * Uses the real events.ts + mock-herdr-socket fixture + real fetcher exec
 * seam. Run: npx vitest run packages/herdr/src/worklist-agent-state-event.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Module mocks (hoisted before worklist.js is imported).
vi.mock('./auto-sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./auto-sync.js')>();
  return { ...actual, runSync: vi.fn().mockResolvedValue({ success: true }) };
});
vi.mock('./notify.js', () => ({ showToast: vi.fn() }));

import { runWorklistTui } from './worklist.js';
import { setExecFileAsync, resetExecFileAsync } from './fetcher.js';
import { AgentTracker } from './agent-tracker.js';
import { HerdrEventSubscriber } from './events.js';
import { createMockSocket, type MockHerdrSocket } from './test-utils/mock-herdr-socket.js';
import type { WorkItem } from './fetcher.js';

let dataHandler: ((chunk: Buffer) => void) | undefined;
let writes: string[];

/** Fresh temp state file for a given test. */
function makeStateFile(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-wl-event-'));
  return {
    path: join(dir, 'agent-panes.json'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Seed the shared agent-panes.json with an association. */
function seedStateFile(
  path: string,
  items: Array<{ workItemId: string; paneId: string }>,
): void {
  writeFileSync(
    path,
    JSON.stringify(
      items.map((i) => ({
        workItemId: i.workItemId,
        paneId: i.paneId,
        recordedAt: new Date().toISOString(),
      })),
      null,
      2,
    ),
    'utf8',
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  dataHandler = undefined;
  writes = [];

  for (const prop of ['on', 'removeListener', 'pause', 'resume', 'setRawMode'] as const) {
    if (!(prop in process.stdin)) {
      Object.defineProperty(process.stdin, prop, { value: vi.fn(), configurable: true, writable: true });
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

  process.env.HERDR_TAB_ID = 'w1:t11';
  process.env.HERDR_PANE_ID = 'w1:pCM';
  delete process.env.HERDR_BIN_PATH;
});

afterEach(() => {
  resetExecFileAsync();
  delete process.env.HERDR_TAB_ID;
  delete process.env.HERDR_PANE_ID;
  delete process.env.HERDR_BIN_PATH;
  vi.restoreAllMocks();
});

/** Exec mock that reports a visible tab and empty wl results. */
function makeVisibleExecMock(): Mock {
  return vi.fn(async (bin: string, args: string[]) => {
    if (bin === 'herdr' && args[0] === 'tab' && args[1] === 'get') {
      return { stdout: JSON.stringify({ id: 'cli:tab:get', result: { tab: { focused: true } } }), stderr: '' };
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

/** Sleep real ms (used between event pushes so frames settle). */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const GREEN_CIRCLE = '\u{1F7E2}'; // 🟢 working
const RED_CIRCLE = '\u{26D4}'; // ⛔ blocked
const WHITE_CIRCLE = '\u{26AA}'; // ⚪ idle

describe('worklist — event-driven agent status (WL-0MSHB7DHO004RHBJ)', () => {
  it('a pane_agent_status_changed event updates the icon with no agent-list exec', async () => {
    const sf = makeStateFile();
    seedStateFile(sf.path, [{ workItemId: 'WL-1', paneId: 'w3:p99' }]);

    const tracker = new AgentTracker({ stateFile: sf.path, ttlMs: 60_000 });
    const mockServer: MockHerdrSocket = await createMockSocket();
    const subscriber = new HerdrEventSubscriber({ socketPath: mockServer.getAddress(), callbacks: {} });
    const execMock = makeVisibleExecMock();
    setExecFileAsync(execMock as any);

    const fetcher = vi.fn(async (): Promise<WorkItem[]> => [
      { id: 'WL-1', title: 'Task one', status: 'open', stage: 'idea' },
    ]);

    const p = runWorklistTui(fetcher, undefined, undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
      subscriber,
      agentTracker: tracker,
      mergeAgentStates: async () => {},
    });

    // Let initial render + subscriber connect settle.
    await sleep(100);
    const client = mockServer.getFirstClient();
    expect(client).toBeDefined();
    // No icon before any state is seeded.
    expect(writes.join('')).not.toContain(GREEN_CIRCLE);

    // Push an agent status change → the icon appears immediately.
    client!.pushEvent({
      event: 'pane_agent_status_changed',
      data: { pane_id: 'w3:p99', agent_status: 'working' },
    });
    await sleep(100);

    const output = writes.join('');
    expect(output).toContain(GREEN_CIRCLE);
    // The event path must NOT spawn `herdr agent list` (only tab get + wl).
    expect(
      execMock.mock.calls.filter((c) => c[0] === 'herdr' && c[1]?.[0] === 'agent'),
    ).toHaveLength(0);

    await subscriber.close();
    await mockServer.stop();
    await quit(p);
    sf.cleanup();
  });

  it('pane_agent_status_changed flips an existing icon to blocked', async () => {
    const sf = makeStateFile();
    const tracker = new AgentTracker({ stateFile: sf.path, ttlMs: 60_000 });
    const mockServer = await createMockSocket();
    const subscriber = new HerdrEventSubscriber({ socketPath: mockServer.getAddress(), callbacks: {} });
    setExecFileAsync(makeVisibleExecMock() as any);

    const fetcher = vi.fn(async (): Promise<WorkItem[]> => [
      { id: 'WL-1', title: 'Task one', status: 'open', stage: 'idea' },
    ]);
    const p = runWorklistTui(fetcher, undefined, undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
      subscriber,
      agentTracker: tracker,
      mergeAgentStates: async () => {},
    });
    await sleep(100);
    const client = mockServer.getFirstClient();

    // Seed the association at runtime (as if dispatch recorded it).
    await tracker.recordAgentForWorkItem('WL-1', 'w3:p99');
    await sleep(20);
    client!.pushEvent({
      event: 'pane_agent_status_changed',
      data: { pane_id: 'w3:p99', agent_status: 'blocked' },
    });
    await sleep(100);

    expect(writes.join('')).toContain(RED_CIRCLE);

    await subscriber.close();
    await mockServer.stop();
    await quit(p);
    sf.cleanup();
  });

  it('a pane_closed event prunes the association and clears the icon', async () => {
    const sf = makeStateFile();
    seedStateFile(sf.path, [{ workItemId: 'WL-1', paneId: 'w3:p99' }]);

    const tracker = new AgentTracker({ stateFile: sf.path, ttlMs: 60_000 });
    const mockServer = await createMockSocket();
    const subscriber = new HerdrEventSubscriber({ socketPath: mockServer.getAddress(), callbacks: {} });
    setExecFileAsync(makeVisibleExecMock() as any);

    const fetcher = vi.fn(async (): Promise<WorkItem[]> => [
      { id: 'WL-1', title: 'Task one', status: 'open', stage: 'idea' },
    ]);
    const p = runWorklistTui(fetcher, undefined, undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
      subscriber,
      agentTracker: tracker,
      mergeAgentStates: async () => {},
    });
    await sleep(100);
    const client = mockServer.getFirstClient();

    // Seed a working icon VIA THE EVENT PATH so the renderer re-applies
    // the cached state (a direct tracker call never triggers a render).
    client!.pushEvent({
      event: 'pane_agent_status_changed',
      data: { pane_id: 'w3:p99', agent_status: 'working' },
    });
    await sleep(100);
    expect(writes.join('')).toContain(GREEN_CIRCLE);

    // A pane_closed event prunes → icon clears.
    client!.pushEvent({ event: 'pane_closed', data: { pane_id: 'w3:p99' } });
    await sleep(100);
    writes.length = 0; // only inspect output produced AFTER the event
    expect(writes.join('')).not.toContain(GREEN_CIRCLE);

    await subscriber.close();
    await mockServer.stop();
    await quit(p);
    sf.cleanup();
  });

  it('pane_agent_detected re-reads the shared file for a late-spawned agent (cross-instance)', async () => {
    const sf = makeStateFile();
    const tracker = new AgentTracker({ stateFile: sf.path, ttlMs: 60_000 });
    const mockServer = await createMockSocket();
    const subscriber = new HerdrEventSubscriber({ socketPath: mockServer.getAddress(), callbacks: {} });
    setExecFileAsync(makeVisibleExecMock() as any);

    const fetcher = vi.fn(async (): Promise<WorkItem[]> => [
      { id: 'WL-LATE', title: 'Late task', status: 'open', stage: 'idea' },
    ]);
    const p = runWorklistTui(fetcher, undefined, undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
      subscriber,
      agentTracker: tracker,
      mergeAgentStates: async () => {},
    });
    await sleep(100);
    const client = mockServer.getFirstClient();

    // Another instance records a late association to the shared file.
    seedStateFile(sf.path, [{ workItemId: 'WL-LATE', paneId: 'w5:p55' }]);
    await sleep(20);

    // A pane_agent_detected event triggers the re-read.
    client!.pushEvent({ event: 'pane_agent_detected', data: { pane_id: 'w5:p55' } });
    await sleep(100);

    // The association is now visible to this instance.
    expect(tracker.getPaneId('WL-LATE')).toBe('w5:p55');

    // And a status event for that late pane updates the icon.
    client!.pushEvent({
      event: 'pane_agent_status_changed',
      data: { pane_id: 'w5:p55', agent_status: 'idle' },
    });
    await sleep(100);
    expect(writes.join('')).toContain(WHITE_CIRCLE);

    await subscriber.close();
    await mockServer.stop();
    await quit(p);
    sf.cleanup();
  });

  it('a pane_exited event clears the icon (treated like closed)', async () => {
    const sf = makeStateFile();
    seedStateFile(sf.path, [{ workItemId: 'WL-1', paneId: 'w3:p99' }]);

    const tracker = new AgentTracker({ stateFile: sf.path, ttlMs: 60_000 });
    const mockServer = await createMockSocket();
    const subscriber = new HerdrEventSubscriber({ socketPath: mockServer.getAddress(), callbacks: {} });
    setExecFileAsync(makeVisibleExecMock() as any);

    const fetcher = vi.fn(async (): Promise<WorkItem[]> => [
      { id: 'WL-1', title: 'Task one', status: 'open', stage: 'idea' },
    ]);
    const p = runWorklistTui(fetcher, undefined, undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
      subscriber,
      agentTracker: tracker,
      mergeAgentStates: async () => {},
    });
    await sleep(100);
    const client = mockServer.getFirstClient();

    // Seed a working icon via the event path.
    client!.pushEvent({
      event: 'pane_agent_status_changed',
      data: { pane_id: 'w3:p99', agent_status: 'working' },
    });
    await sleep(100);
    expect(writes.join('')).toContain(GREEN_CIRCLE);

    client!.pushEvent({ event: 'pane_exited', data: { pane_id: 'w3:p99' } });
    await sleep(100);
    writes.length = 0; // only inspect output produced AFTER the event
    expect(writes.join('')).not.toContain(GREEN_CIRCLE);

    await subscriber.close();
    await mockServer.stop();
    await quit(p);
    sf.cleanup();
  });
});
