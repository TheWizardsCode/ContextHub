/**
 * packages/herdr/src/agent-tracker.test.ts — Unit tests for the
 * work-item ↔ agent-pane association tracker (WL-0MSBQUJQX005RAT9).
 *
 * Covers:
 *  - recordAgentForWorkItem / getPaneId (in-memory + persisted)
 *  - persistence: atomic state file round-trip across tracker instances
 *  - refreshStates: herdr agent list parsing, state mapping, pruning of
 *    gone/done panes, PollGate-style TTL memoization
 *  - fail-open: CLI errors / unparseable output keep entries and yield no
 *    icons
 *
 * Run: npx vitest run packages/herdr/src/agent-tracker.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentTracker,
  normalizeAgentState,
  parseAgentListOutput,
  mergeAgentStatesCached,
  type AgentState,
} from './agent-tracker.js';
import {
  setExecFileAsync,
  resetExecFileAsync,
} from './fetcher.js';

/**
 * Build a herdr-style `agent list` JSON envelope. The CLI may prefix the
 * envelope with log lines, so the parser must scan for the first `{`.
 */
function agentListEnvelope(agents: Array<Record<string, string>>, prefix = ''): string {
  return `${prefix}${JSON.stringify({
    id: 'cli:agent:list',
    result: { agents },
  })}`;
}

function makeStateFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-agent-tracker-'));
  return join(dir, 'agent-panes.json');
}

describe('AgentTracker — record & in-memory lookup', () => {
  it('records a workItemId → paneId association', async () => {
    const tracker = new AgentTracker({ stateFile: makeStateFile() });
    await tracker.recordAgentForWorkItem('WL-ABC', 'pane-1');
    expect(tracker.getPaneId('WL-ABC')).toBe('pane-1');
  });

  it('returns undefined for unknown work items', async () => {
    const tracker = new AgentTracker({ stateFile: makeStateFile() });
    expect(tracker.getPaneId('WL-NOPE')).toBeUndefined();
  });

  it('overwrites an existing association for the same work item', async () => {
    const tracker = new AgentTracker({ stateFile: makeStateFile() });
    await tracker.recordAgentForWorkItem('WL-ABC', 'pane-1');
    await tracker.recordAgentForWorkItem('WL-ABC', 'pane-2');
    expect(tracker.getPaneId('WL-ABC')).toBe('pane-2');
    expect(tracker.size).toBe(1);
  });
});

describe('AgentTracker — persistence', () => {
  it('persists the mapping to the state file (atomic write)', async () => {
    const stateFile = makeStateFile();
    const tracker = new AgentTracker({ stateFile });
    await tracker.recordAgentForWorkItem('WL-ABC', 'pane-1');
    await tracker.recordAgentForWorkItem('WL-DEF', 'pane-2');

    expect(existsSync(stateFile)).toBe(true);
    const raw = JSON.parse(readFileSync(stateFile, 'utf8'));
    expect(raw).toHaveLength(2);
    expect(raw[0]).toMatchObject({ workItemId: 'WL-ABC', paneId: 'pane-1' });
    expect(raw[1]).toMatchObject({ workItemId: 'WL-DEF', paneId: 'pane-2' });
  });

  it('restores the mapping across tracker instances (plugin restart)', async () => {
    const stateFile = makeStateFile();
    const first = new AgentTracker({ stateFile });
    await first.recordAgentForWorkItem('WL-ABC', 'pane-1');

    const second = new AgentTracker({ stateFile });
    expect(second.getPaneId('WL-ABC')).toBe('pane-1');
  });

  it('tolerates a missing or corrupt state file (fail-open)', async () => {
    const stateFile = makeStateFile();
    // Missing file — no entries, no throw.
    const empty = new AgentTracker({ stateFile: join(stateFile, 'nope.json') });
    expect(empty.size).toBe(0);

    // Corrupt file — no entries, no throw, and recording still works.
    writeFileSync(stateFile, '{not json', 'utf8');
    const corrupt = new AgentTracker({ stateFile });
    expect(corrupt.size).toBe(0);
    await corrupt.recordAgentForWorkItem('WL-ABC', 'pane-1');
    expect(corrupt.getPaneId('WL-ABC')).toBe('pane-1');
  });

  it('pruneEntry removes and persists the change', async () => {
    const stateFile = makeStateFile();
    const tracker = new AgentTracker({ stateFile });
    await tracker.recordAgentForWorkItem('WL-ABC', 'pane-1');
    await tracker.recordAgentForWorkItem('WL-DEF', 'pane-2');
    await tracker.pruneEntry('WL-ABC');

    expect(tracker.getPaneId('WL-ABC')).toBeUndefined();
    expect(tracker.size).toBe(1);
    const raw = JSON.parse(readFileSync(stateFile, 'utf8'));
    expect(raw).toHaveLength(1);
    expect(raw[0].workItemId).toBe('WL-DEF');
  });
});

describe('normalizeAgentState', () => {
  it('maps known statuses to canonical AgentState values', () => {
    expect(normalizeAgentState('idle')).toBe('idle');
    expect(normalizeAgentState('working')).toBe('working');
    expect(normalizeAgentState('blocked')).toBe('blocked');
    expect(normalizeAgentState('done')).toBe('done');
  });

  it('maps unknown/empty statuses to unknown', () => {
    expect(normalizeAgentState('weird')).toBe('unknown');
    expect(normalizeAgentState('')).toBe('unknown');
    expect(normalizeAgentState(undefined)).toBe('unknown');
    expect(normalizeAgentState('WORKING')).toBe('working'); // case-insensitive
  });
});

describe('parseAgentListOutput', () => {
  it('parses the result.agents array shape', () => {
    const records = parseAgentListOutput(
      agentListEnvelope([
        { pane_id: 'p1', agent_status: 'working' },
        { pane_id: 'p2', agent_status: 'blocked' },
      ]),
    );
    expect(records).toEqual([
      { paneId: 'p1', status: 'working' },
      { paneId: 'p2', status: 'blocked' },
    ]);
  });

  it('tolerates log lines prefixed before the JSON envelope', () => {
    const records = parseAgentListOutput(
      agentListEnvelope([{ pane_id: 'p1', agent_status: 'idle' }], 'some log line\n'),
    );
    expect(records).toEqual([{ paneId: 'p1', status: 'idle' }]);
  });

  it('reads camelCase aliases (paneId / agentStatus)', () => {
    const records = parseAgentListOutput(
      JSON.stringify({ result: { agents: [{ paneId: 'p1', agentStatus: 'working' }] } }),
    );
    expect(records).toEqual([{ paneId: 'p1', status: 'working' }]);
  });

  it('reads a bare status field when agent_status is absent', () => {
    const records = parseAgentListOutput(
      JSON.stringify({ result: { agents: [{ pane_id: 'p1', status: 'done' }] } }),
    );
    expect(records).toEqual([{ paneId: 'p1', status: 'done' }]);
  });

  it('returns null for unparseable output (fail-open trigger)', () => {
    expect(parseAgentListOutput('not json at all')).toBeNull();
    expect(parseAgentListOutput('')).toBeNull();
  });

  it('returns null when no agent array is present', () => {
    expect(parseAgentListOutput(JSON.stringify({ result: { ok: true } }))).toBeNull();
    expect(parseAgentListOutput(JSON.stringify({ result: { agents: 'nope' } }))).toBeNull();
  });
});

describe('AgentTracker — refreshStates', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetExecFileAsync();
    delete process.env.HERDR_BIN_PATH;
  });

  afterEach(() => {
    resetExecFileAsync();
    process.env.HERDR_BIN_PATH = originalEnv.HERDR_BIN_PATH;
  });

  it('maps live agent panes to states and prunes gone panes', async () => {
    const stateFile = makeStateFile();
    const tracker = new AgentTracker({ stateFile });
    await tracker.recordAgentForWorkItem('WL-ABC', 'p1');
    await tracker.recordAgentForWorkItem('WL-GONE', 'pX');

    const mockFn = vi.fn().mockResolvedValue({
      stdout: agentListEnvelope([{ pane_id: 'p1', agent_status: 'working' }]),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    const states = await tracker.refreshStates();
    expect(states.get('WL-ABC')).toBe('working');
    expect(states.has('WL-GONE')).toBe(false); // pane pX not an agent → pruned
    expect(tracker.getPaneId('WL-GONE')).toBeUndefined(); // pruned in memory
    // Pruning is persisted.
    const raw = JSON.parse(readFileSync(stateFile, 'utf8'));
    expect(raw).toHaveLength(1);
    expect(raw[0].workItemId).toBe('WL-ABC');
    // The CLI is invoked as `herdr agent list` (HERDR_BIN_PATH unset → herdr).
    expect(mockFn.mock.calls[0][1]).toEqual(['agent', 'list']);
  });

  it('maps idle/working/blocked and prunes done panes', async () => {
    const tracker = new AgentTracker({ stateFile: makeStateFile() });
    await tracker.recordAgentForWorkItem('WL-1', 'p1');
    await tracker.recordAgentForWorkItem('WL-2', 'p2');
    await tracker.recordAgentForWorkItem('WL-3', 'p3');
    await tracker.recordAgentForWorkItem('WL-DONE', 'p4');

    const mockFn = vi.fn().mockResolvedValue({
      stdout: agentListEnvelope([
        { pane_id: 'p1', agent_status: 'idle' },
        { pane_id: 'p2', agent_status: 'working' },
        { pane_id: 'p3', agent_status: 'blocked' },
        { pane_id: 'p4', agent_status: 'done' },
      ]),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    const states = await tracker.refreshStates();
    expect(states.get('WL-1')).toBe('idle');
    expect(states.get('WL-2')).toBe('working');
    expect(states.get('WL-3')).toBe('blocked');
    // done → no icon: pruned.
    expect(states.has('WL-DONE')).toBe(false);
    expect(tracker.getPaneId('WL-DONE')).toBeUndefined();
  });

  it('fails open when the herdr CLI errors: no icons, entries kept', async () => {
    const tracker = new AgentTracker({ stateFile: makeStateFile() });
    await tracker.recordAgentForWorkItem('WL-ABC', 'p1');

    const mockFn = vi.fn().mockRejectedValue({ code: 'ENOENT' });
    setExecFileAsync(mockFn as any);

    const states = await tracker.refreshStates();
    expect(states.size).toBe(0);
    // Entries survive the failed refresh so icons reappear when the CLI returns.
    expect(tracker.getPaneId('WL-ABC')).toBe('p1');
  });

  it('fails open on unparseable CLI output: no icons, entries kept', async () => {
    const tracker = new AgentTracker({ stateFile: makeStateFile() });
    await tracker.recordAgentForWorkItem('WL-ABC', 'p1');

    const mockFn = vi.fn().mockResolvedValue({ stdout: 'garbage', stderr: '' });
    setExecFileAsync(mockFn as any);

    const states = await tracker.refreshStates();
    expect(states.size).toBe(0);
    expect(tracker.getPaneId('WL-ABC')).toBe('p1');
  });

  it('memoizes the herdr query within the TTL (PollGate pattern)', async () => {
    const tracker = new AgentTracker({ stateFile: makeStateFile(), ttlMs: 60_000 });
    await tracker.recordAgentForWorkItem('WL-ABC', 'p1');

    const mockFn = vi.fn().mockResolvedValue({
      stdout: agentListEnvelope([{ pane_id: 'p1', agent_status: 'working' }]),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    const first = await tracker.refreshStates();
    const second = await tracker.refreshStates();
    expect(first.get('WL-ABC')).toBe('working');
    expect(second.get('WL-ABC')).toBe('working');
    expect(mockFn).toHaveBeenCalledTimes(1); // second call served from cache
  });

  it('uses HERDR_BIN_PATH when set', async () => {
    process.env.HERDR_BIN_PATH = '/custom/herdr';
    const tracker = new AgentTracker({ stateFile: makeStateFile(), ttlMs: 60_000 });
    await tracker.recordAgentForWorkItem('WL-ABC', 'p1');

    const mockFn = vi.fn().mockResolvedValue({
      stdout: agentListEnvelope([{ pane_id: 'p1', agent_status: 'idle' }]),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    await tracker.refreshStates();
    expect(mockFn.mock.calls[0][0]).toBe('/custom/herdr');
  });

  it('reloads the state file on refresh so other panes/tabs entries are shared', async () => {
    const stateFile = makeStateFile();
    const tabA = new AgentTracker({ stateFile });
    await tabA.recordAgentForWorkItem('WL-ABC', 'p1');

    // Tab B starts after A persisted, then A adds another entry while B runs.
    const tabB = new AgentTracker({ stateFile, ttlMs: 60_000 });
    await tabA.recordAgentForWorkItem('WL-DEF', 'p2');

    const mockFn = vi.fn().mockResolvedValue({
      stdout: agentListEnvelope([
        { pane_id: 'p1', agent_status: 'working' },
        { pane_id: 'p2', agent_status: 'blocked' },
      ]),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    const states = await tabB.refreshStates();
    expect(states.get('WL-ABC')).toBe('working');
    expect(states.get('WL-DEF')).toBe('blocked');
  });
});

describe('AgentTracker — event-applied path (WL-0MSHB7DHO004RHBJ F5)', () => {
  beforeEach(() => {
    resetExecFileAsync();
    delete process.env.HERDR_BIN_PATH;
  });

  afterEach(() => {
    resetExecFileAsync();
    delete process.env.HERDR_BIN_PATH;
  });

  it('applyAgentStatusChanged updates the cached state without any herdr exec', async () => {
    const stateFile = makeStateFile();
    const tracker = new AgentTracker({ stateFile, ttlMs: 60_000 });
    await tracker.recordAgentForWorkItem('WL-ABC', 'p1');
    await tracker.recordAgentForWorkItem('WL-DEF', 'p2');

    // Seed the cache via a normal refresh (one herdr exec).
    const mockFn = vi.fn().mockResolvedValue({
      stdout: agentListEnvelope([
        { pane_id: 'p1', agent_status: 'idle' },
        { pane_id: 'p2', agent_status: 'idle' },
      ]),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);
    const states = await tracker.refreshStates();
    expect(states.get('WL-ABC')).toBe('idle');
    expect(mockFn).toHaveBeenCalledTimes(1);

    // A pane_agent_status_changed event flips the state with NO exec.
    const affected = tracker.applyAgentStatusChanged('p1', 'working');
    expect(affected).toEqual(['WL-ABC']);
    expect(tracker.snapshotStates().get('WL-ABC')).toBe('working');
    expect(tracker.snapshotStates().get('WL-DEF')).toBe('idle');
    expect(mockFn).toHaveBeenCalledTimes(1);

    // The memo window was extended: refreshStates returns the event-applied
    // states without re-polling within the TTL.
    const refreshed = await tracker.refreshStates();
    expect(refreshed.get('WL-ABC')).toBe('working');
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('applyAgentStatusChanged with done prunes the entry (icon disappears)', async () => {
    const stateFile = makeStateFile();
    const tracker = new AgentTracker({ stateFile, ttlMs: 60_000 });
    await tracker.recordAgentForWorkItem('WL-ABC', 'p1');

    const affected = tracker.applyAgentStatusChanged('p1', 'done');
    expect(affected).toEqual(['WL-ABC']);
    expect(tracker.getPaneId('WL-ABC')).toBeUndefined();
    expect(tracker.snapshotStates().has('WL-ABC')).toBe(false);
  });

  it('applyAgentStatusChanged for an untracked pane is a no-op (empty affected)', () => {
    const tracker = new AgentTracker({ stateFile: makeStateFile() });
    expect(tracker.applyAgentStatusChanged('unknown-pane', 'working')).toEqual([]);
  });

  it('applyAgentDetected re-reads the shared file (cross-instance, late-spawned agents)', async () => {
    const stateFile = makeStateFile();
    const tracker = new AgentTracker({ stateFile, ttlMs: 60_000 });

    // Another plugin instance records an association after we started.
    const other = new AgentTracker({ stateFile });
    await other.recordAgentForWorkItem('WL-LATE', 'p9');

    // Our tracker has no in-memory knowledge of the new association.
    expect(tracker.getPaneId('WL-LATE')).toBeUndefined();

    // A pane_agent_detected event triggers a re-read → the late entry is
    // picked up and the pane set grew.
    const grew = tracker.applyAgentDetected();
    expect(grew).toBe(true);
    expect(tracker.getPaneId('WL-LATE')).toBe('p9');
  });

  it('applyPaneGone prunes associations for the closed pane and persists', async () => {
    const stateFile = makeStateFile();
    const tracker = new AgentTracker({ stateFile, ttlMs: 60_000 });
    await tracker.recordAgentForWorkItem('WL-ABC', 'p1');
    await tracker.recordAgentForWorkItem('WL-DEF', 'p2');

    const affected = tracker.applyPaneGone('p1');
    expect(affected).toEqual(['WL-ABC']);
    expect(tracker.getPaneId('WL-ABC')).toBeUndefined();
    expect(tracker.getPaneId('WL-DEF')).toBe('p2');

    // Persisted: a fresh tracker instance sees the prune.
    const reloaded = new AgentTracker({ stateFile });
    expect(reloaded.getPaneId('WL-ABC')).toBeUndefined();
    expect(reloaded.getPaneId('WL-DEF')).toBe('p2');
  });

  it('snapshotStates returns a copy (mutating it does not affect the tracker)', async () => {
    const tracker = new AgentTracker({ stateFile: makeStateFile() });
    await tracker.recordAgentForWorkItem('WL-ABC', 'p1');
    tracker.applyAgentStatusChanged('p1', 'blocked');

    const snap = tracker.snapshotStates();
    expect(snap.get('WL-ABC')).toBe('blocked');
    snap.delete('WL-ABC');
    expect(tracker.snapshotStates().get('WL-ABC')).toBe('blocked');
  });

  it('normalizes unknown statuses to unknown on the event path', async () => {
    const tracker = new AgentTracker({ stateFile: makeStateFile() });
    await tracker.recordAgentForWorkItem('WL-ABC', 'p1');
    tracker.applyAgentStatusChanged('p1', 'weird-status');
    expect(tracker.snapshotStates().get('WL-ABC')).toBe('unknown');
  });
});

describe('mergeAgentStatesCached (WL-0MSHB7DHO004RHBJ F5)', () => {
  beforeEach(() => resetExecFileAsync());
  afterEach(() => resetExecFileAsync());

  it('stamps icon-eligible states and clears no-longer-eligible ones without exec', async () => {
    const tracker = new AgentTracker({ stateFile: makeStateFile() });
    await tracker.recordAgentForWorkItem('WL-ABC', 'p1');
    await tracker.recordAgentForWorkItem('WL-DEF', 'p2');

    // First apply an event state, then merge into items.
    tracker.applyAgentStatusChanged('p1', 'working');
    tracker.applyAgentStatusChanged('p2', 'blocked');

    const items = [
      { id: 'WL-ABC', title: 'a', status: 'open' } as any,
      { id: 'WL-DEF', title: 'b', status: 'open' } as any,
      { id: 'WL-GHI', title: 'c', status: 'open' } as any,
    ];
    mergeAgentStatesCached(items, tracker);
    expect(items[0].agentState).toBe('working');
    expect(items[1].agentState).toBe('blocked');
    expect(items[2].agentState).toBeUndefined();
  });

  it('clears a previously stamped icon when the state becomes ineligible', async () => {
    const tracker = new AgentTracker({ stateFile: makeStateFile() });
    await tracker.recordAgentForWorkItem('WL-ABC', 'p1');
    tracker.applyAgentStatusChanged('p1', 'working');

    const items = [{ id: 'WL-ABC', title: 'a', status: 'open', agentState: 'working' } as any];
    mergeAgentStatesCached(items, tracker);
    expect(items[0].agentState).toBe('working');

    // Agent reports done → prune → icon must clear.
    tracker.applyAgentStatusChanged('p1', 'done');
    mergeAgentStatesCached(items, tracker);
    expect(items[0].agentState).toBeUndefined();
  });

  it('applies states recursively into children', async () => {
    const tracker = new AgentTracker({ stateFile: makeStateFile() });
    await tracker.recordAgentForWorkItem('WL-CHILD', 'p1');
    tracker.applyAgentStatusChanged('p1', 'blocked');

    const items = [
      {
        id: 'WL-PARENT',
        title: 'p',
        status: 'open',
        children: [{ id: 'WL-CHILD', title: 'c', status: 'open' }],
      },
    ] as any;
    mergeAgentStatesCached(items, tracker);
    expect(items[0].children[0].agentState).toBe('blocked');
  });

  it('never throws when the tracker has no states', async () => {
    const tracker = new AgentTracker({ stateFile: makeStateFile() });
    const items = [{ id: 'WL-X', title: 'x', status: 'open' } as any];
    expect(() => mergeAgentStatesCached(items, tracker)).not.toThrow();
    expect(items[0].agentState).toBeUndefined();
  });
});
