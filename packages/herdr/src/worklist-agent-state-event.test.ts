/**
 * packages/herdr/src/worklist-agent-state-event.test.ts — Integration tests
 * for the EVENT-DRIVEN pane/agent paths (WL-0MSHB7DHO004RHBJ) under the
 * pane-existence green-circle semantics (WL-0MV1BWETT005GSUJ).
 *
 * The row's green-circle icon (agent slot) is **pane-title existence**: a
 * pane in the current workspace whose title carries the work-item ID means
 * the item is being worked → 🟢 green circle; otherwise no icon. The
 * event-driven agent-status tracker is no longer the icon source (a pane
 * absent from `herdr agent list` — freshly spawned/`unknown` — used to be
 * pruned and lose its icon permanently; an agent `done` state used to prune
 * the icon even with the pane still open). Pane/agent lifecycle events
 * merely TRIGGER a pane-marker refresh so the icon tracks open/closed panes
 * without waiting for the 30 s cadence.
 *
 * Verifies end-to-end that a mocked herdr event socket drives:
 *  - `pane_agent_status_changed` → pane-marker refresh: the green circle
 *    appears iff a pane title in this workspace carries the item ID, and
 *    NEVER from the agent status alone (no `herdr agent list` exec).
 *  - `pane_agent_detected` → re-read of the shared `.worklog/agent-panes.json`
 *    (cross-instance / late-spawned agents) + a pane-marker refresh.
 *  - `pane_closed` / `pane_exited` → pane-marker refresh clears the green
 *    circle when the pane leaves the pane list.
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
import {
  applyActivePaneMarkers as applyPaneMarkersToItems,
  type HydratorPane,
} from './hydrator.js';
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
  process.env.HERDR_WORKSPACE_ID = 'w1';
  delete process.env.HERDR_BIN_PATH;
});

afterEach(() => {
  resetExecFileAsync();
  delete process.env.HERDR_TAB_ID;
  delete process.env.HERDR_PANE_ID;
  delete process.env.HERDR_WORKSPACE_ID;
  delete process.env.HERDR_BIN_PATH;
  vi.restoreAllMocks();
});

/** Exec mock that reports a visible tab, empty wl results, and NOTHING else. */
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

/**
 * Wait for the mock socket to accept its first client, polling instead of
 * sleeping a fixed interval. The subscriber connects asynchronously; under
 * heavy concurrent load a fixed 100 ms sleep is flaky (WL-0MUK6DGM6000K5NV).
 */
async function waitForClient(
  server: MockHerdrSocket,
  timeoutMs = 5_000,
): Promise<NonNullable<ReturnType<MockHerdrSocket['getFirstClient']>>> {
  const deadline = Date.now() + timeoutMs;
  let client = server.getFirstClient();
  while (!client && Date.now() < deadline) {
    await sleep(10);
    client = server.getFirstClient();
  }
  if (!client) throw new Error('mock herdr socket never received a client');
  return client;
}

/**
 * Poll a predicate until it is true or the timeout elapses — never wait a
 * fixed interval for async work to land. The event → render round-trip is
 * microtask-scheduled after socket data arrives, so a fixed 100 ms sleep is
 * flaky under heavy concurrent load.
 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
  description = 'condition',
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}`);
    }
    await sleep(10);
  }
}

/**
 * Wait until the captured TUI output satisfies `predicate`, polling instead
 * of sleeping a fixed interval. Positive checks (`toContain`) must not race
 * the microtask-scheduled event render; negative checks must not pass
 * before the clearing render has landed.
 */
async function waitForWrites(
  predicate: (captured: string[]) => boolean,
  timeoutMs = 5_000,
  description = 'TUI output condition',
): Promise<void> {
  const start = Date.now();
  while (!predicate(writes)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${description}; last output: ` +
          JSON.stringify(writes.join('').slice(-200)),
      );
    }
    await sleep(10);
  }
}

const GREEN_CIRCLE = '\u{1F7E2}'; // 🟢 — green circle (work-item pane open)
const RED_CIRCLE = '\u{26D4}'; // ⛔ — must never appear from a blocked agent

/** A realistic dispatched pane title carrying the item ID as a suffix. */
const titleFor = (id: string): string => `Manually triggered implement Foo - ${id}`;

/**
 * Mutable holder for the workspace pane set, so tests can swap the pane list
 * and have the injected seam observe the NEW value (a plain `let` captured by
 * the closure would freeze the array at option-construction time).
 */
interface PaneSetHolder {
  panes: HydratorPane[];
}

function markerOptions(
  holder: PaneSetHolder,
  subscriber: HerdrEventSubscriber | null,
  tracker: AgentTracker | null,
): ConstructorParameters<typeof runWorklistTui>[3] {
  return {
    autoRefresh: true,
    refreshIntervalMs: 30_000,
    autoSync: false,
    showHelpText: false,
    subscriber,
    agentTracker: tracker,
    applyActivePaneMarkers: (items) => applyPaneMarkersToItems(items, async () => holder.panes, 'w1'),
  };
}

/**
 * Build a subscriber exactly like the production wiring (packages/herdr/src/
 * index.ts): the initial tracked pane set is seeded from the agent tracker's
 * shared state file BEFORE the first connect, so the initial events.subscribe
 * already covers the known panes (WL-0MVAS988R008PNH6 — one request per
 * connection: the pane set cannot be changed on a live socket, so anything
 * not in the initial subscribe triggers a fresh connection).
 */
function makeSubscriber(
  server: MockHerdrSocket,
  tracker: AgentTracker,
): HerdrEventSubscriber {
  return new HerdrEventSubscriber({
    socketPath: server.getAddress(),
    callbacks: {},
    trackedPaneIds: tracker.snapshot().map((e) => e.paneId),
  });
}

describe('worklist — event paths under pane-existence green circles (WL-0MV1BWETT005GSUJ)', () => {
  it('a pane_agent_status_changed event refreshes the pane list: green circle iff a matching pane title exists (no agent-list exec)', async () => {
    const sf = makeStateFile();
    seedStateFile(sf.path, [{ workItemId: 'WL-0MV1BWETT005GSUJ', paneId: 'w3:p99' }]);

    const tracker = new AgentTracker({ stateFile: sf.path, ttlMs: 60_000 });
    const mockServer: MockHerdrSocket = await createMockSocket();
    const subscriber = makeSubscriber(mockServer, tracker);
    const execMock = makeVisibleExecMock();
    setExecFileAsync(execMock as any);

    const fetcher = vi.fn(async (): Promise<WorkItem[]> => [
      { id: 'WL-0MV1BWETT005GSUJ', title: 'Task one', status: 'open', stage: 'idea' },
    ]);

    // The workspace pane set starts WITHOUT a matching pane: no green circle
    // even after a `working` status event (the icon is pane existence, not
    // agent status).
    const holder: PaneSetHolder = { panes: [] };
    const p = runWorklistTui(fetcher, undefined, undefined, markerOptions(holder, subscriber, tracker));
    const client = await waitForClient(mockServer);
    expect(writes.join('')).not.toContain(GREEN_CIRCLE);

    client!.pushEvent({
      event: 'pane_agent_status_changed',
      data: { pane_id: 'w3:p99', agent_status: 'working' },
    });
    await sleep(50);
    expect(writes.join('')).not.toContain(GREEN_CIRCLE);
    expect(writes.join('')).not.toContain(RED_CIRCLE);

    // A pane whose title carries the item ID appears → the next pane-marker
    // refresh (triggered by an event, no 30 s wait) shows the green circle.
    holder.panes = [{ pane_id: 'w3:p99', label: titleFor('WL-0MV1BWETT005GSUJ'), workspace_id: 'w1' }];
    client!.pushEvent({
      event: 'pane_agent_status_changed',
      data: { pane_id: 'w3:p99', agent_status: 'blocked' },
    });
    await waitForWrites((w) => w.join('').includes(GREEN_CIRCLE), 5_000, 'GREEN_CIRCLE after pane appears');
    expect(writes.join('')).not.toContain(RED_CIRCLE);

    // The icon path must NOT spawn `herdr agent list` (only tab get + pane
    // marker refreshes triggered by events).
    expect(
      execMock.mock.calls.filter((c) => c[0] === 'herdr' && c[1]?.[0] === 'agent'),
    ).toHaveLength(0);

    await subscriber.close();
    await mockServer.stop();
    await quit(p);
    sf.cleanup();
  });

  it('a status event alone — without a matching pane title — never shows the green circle', async () => {
    const sf = makeStateFile();
    seedStateFile(sf.path, [{ workItemId: 'WL-0MV1BWETT005GSUJ', paneId: 'w3:p99' }]);

    const tracker = new AgentTracker({ stateFile: sf.path, ttlMs: 60_000 });
    const mockServer = await createMockSocket();
    const subscriber = makeSubscriber(mockServer, tracker);
    setExecFileAsync(makeVisibleExecMock() as any);

    const fetcher = vi.fn(async (): Promise<WorkItem[]> => [
      { id: 'WL-0MV1BWETT005GSUJ', title: 'Task one', status: 'open', stage: 'idea' },
    ]);
    // The only pane in the workspace carries a DIFFERENT item's ID.
    const holder: PaneSetHolder = {
      panes: [{ pane_id: 'w3:p99', label: titleFor('WL-0MV24T2VJ007Q49J'), workspace_id: 'w1' }],
    };
    const p = runWorklistTui(fetcher, undefined, undefined, markerOptions(holder, subscriber, tracker));
    const client = await waitForClient(mockServer);
    client!.pushEvent({
      event: 'pane_agent_status_changed',
      data: { pane_id: 'w3:p99', agent_status: 'blocked' },
    });
    await sleep(50);
    expect(writes.join('')).not.toContain(GREEN_CIRCLE);
    expect(writes.join('')).not.toContain(RED_CIRCLE);

    await subscriber.close();
    await mockServer.stop();
    await quit(p);
    sf.cleanup();
  });

  it('a pane_closed event clears the green circle when the matching pane leaves the pane list', async () => {
    const sf = makeStateFile();
    seedStateFile(sf.path, [{ workItemId: 'WL-0MV1BWETT005GSUJ', paneId: 'w3:p99' }]);

    const tracker = new AgentTracker({ stateFile: sf.path, ttlMs: 60_000 });
    const mockServer = await createMockSocket();
    const subscriber = makeSubscriber(mockServer, tracker);
    setExecFileAsync(makeVisibleExecMock() as any);

    const fetcher = vi.fn(async (): Promise<WorkItem[]> => [
      { id: 'WL-0MV1BWETT005GSUJ', title: 'Task one', status: 'open', stage: 'idea' },
    ]);
    const holder: PaneSetHolder = {
      panes: [{ pane_id: 'w3:p99', label: titleFor('WL-0MV1BWETT005GSUJ'), workspace_id: 'w1' }],
    };
    const p = runWorklistTui(fetcher, undefined, undefined, markerOptions(holder, subscriber, tracker));
    const client = await waitForClient(mockServer);
    await waitForWrites((w) => w.join('').includes(GREEN_CIRCLE), 5_000, 'GREEN_CIRCLE initial');

    // The pane closes (leaves the pane list) → pane_closed triggers a marker
    // refresh and the green circle clears — even though the tracker still
    // holds the association until pruning.
    holder.panes = [];
    const paneClosedMark = writes.length;
    client!.pushEvent({ event: 'pane_closed', data: { pane_id: 'w3:p99' } });
    await waitForWrites(
      (w) => w.length > paneClosedMark && !w.slice(paneClosedMark).join('').includes(GREEN_CIRCLE),
      5_000,
      'GREEN_CIRCLE cleared after pane_closed',
    );
    expect(writes.slice(paneClosedMark).join('')).not.toContain(GREEN_CIRCLE);
    // The closing event still prunes the association bookkeeping.
    expect(tracker.getPaneId('WL-0MV1BWETT005GSUJ')).toBeUndefined();

    await subscriber.close();
    await mockServer.stop();
    await quit(p);
    sf.cleanup();
  });

  it('pane_agent_detected re-reads the shared file for a late-spawned agent (cross-instance)', async () => {
    const sf = makeStateFile();
    const tracker = new AgentTracker({ stateFile: sf.path, ttlMs: 60_000 });
    const mockServer = await createMockSocket();
    const subscriber = makeSubscriber(mockServer, tracker);
    setExecFileAsync(makeVisibleExecMock() as any);

    const fetcher = vi.fn(async (): Promise<WorkItem[]> => [
      { id: 'WL-0MV25EE4E0028KDI', title: 'Late task', status: 'open', stage: 'idea' },
    ]);
    const holder: PaneSetHolder = { panes: [] };
    const p = runWorklistTui(fetcher, undefined, undefined, markerOptions(holder, subscriber, tracker));
    const client = await waitForClient(mockServer);
    // Another instance records a late association to the shared file.
    seedStateFile(sf.path, [{ workItemId: 'WL-0MV25EE4E0028KDI', paneId: 'w5:p55' }]);
    await sleep(20);

    // A pane_agent_detected event triggers the re-read. Subscribing the
    // late pane re-establishes the subscription on a FRESH connection
    // (WL-0MVAS988R008PNH6: herdr accepts one events.subscribe per
    // connection), so the status event is pushed on the CURRENT client.
    client!.pushEvent({ event: 'pane_agent_detected', data: { pane_id: 'w5:p55' } });
    // Poll, never fixed-sleep: the re-read is async (event → tracker).
    await waitFor(() => tracker.getPaneId('WL-0MV25EE4E0028KDI') === 'w5:p55', 5_000, 'late association re-read');
    expect(tracker.getPaneId('WL-0MV25EE4E0028KDI')).toBe('w5:p55');

    // With the late pane now in the pane list, the green circle appears for
    // the item (regardless of the agent's status value).
    holder.panes = [{ pane_id: 'w5:p55', label: titleFor('WL-0MV25EE4E0028KDI'), workspace_id: 'w1' }];
    const liveClient = mockServer.getFirstClient();
    expect(liveClient).toBeDefined();
    liveClient!.pushEvent({
      event: 'pane_agent_status_changed',
      data: { pane_id: 'w5:p55', agent_status: 'done' },
    });
    await waitForWrites((w) => w.join('').includes(GREEN_CIRCLE), 5_000, 'GREEN_CIRCLE after late pane appears');

    await subscriber.close();
    await mockServer.stop();
    await quit(p);
    sf.cleanup();
  });

  it('a pane_exited event clears the green circle (treated like closed)', async () => {
    const sf = makeStateFile();
    seedStateFile(sf.path, [{ workItemId: 'WL-0MV1BWETT005GSUJ', paneId: 'w3:p99' }]);

    const tracker = new AgentTracker({ stateFile: sf.path, ttlMs: 60_000 });
    const mockServer = await createMockSocket();
    const subscriber = makeSubscriber(mockServer, tracker);
    setExecFileAsync(makeVisibleExecMock() as any);

    const fetcher = vi.fn(async (): Promise<WorkItem[]> => [
      { id: 'WL-0MV1BWETT005GSUJ', title: 'Task one', status: 'open', stage: 'idea' },
    ]);
    const holder: PaneSetHolder = {
      panes: [{ pane_id: 'w3:p99', label: titleFor('WL-0MV1BWETT005GSUJ'), workspace_id: 'w1' }],
    };
    const p = runWorklistTui(fetcher, undefined, undefined, markerOptions(holder, subscriber, tracker));
    const client = await waitForClient(mockServer);
    await waitForWrites((w) => w.join('').includes(GREEN_CIRCLE), 5_000, 'GREEN_CIRCLE initial');

    holder.panes = [];
    const paneExitedMark = writes.length;
    client!.pushEvent({ event: 'pane_exited', data: { pane_id: 'w3:p99' } });
    await waitForWrites(
      (w) => w.length > paneExitedMark && !w.slice(paneExitedMark).join('').includes(GREEN_CIRCLE),
      5_000,
      'GREEN_CIRCLE cleared after pane_exited',
    );
    expect(writes.slice(paneExitedMark).join('')).not.toContain(GREEN_CIRCLE);

    await subscriber.close();
    await mockServer.stop();
    await quit(p);
    sf.cleanup();
  });
});
