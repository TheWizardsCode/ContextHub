/**
 * packages/herdr/src/ship-guard.test.ts — Unit tests for the Ship It guard
 * module (WL-0MUDEGBGO00609RV / WL-0MUD6DDZC007ZSIW).
 *
 * Covers the pure, injectable helpers:
 *   - parseWorklogWorkItemIds:  parses `wl list --json` → Set<string>
 *   - listBlockingPanes:        filters panes by project ID + live agent
 *   - formatBlockedNotice:      renders human-readable blocking notice
 *   - runShipGuard:             convenience wrapper
 *
 * Run: npx vitest run packages/herdr/src/ship-guard.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  parseWorklogWorkItemIds,
  listBlockingPanes,
  formatBlockedNotice,
  runShipGuard,
  type BlockingPane,
  type ShipGuardResult,
} from './ship-guard.js';

// ── Fixture: wl list --json output ────────────────────────────────────────

function wlListJson(ids: string[]): string {
  const items = ids.map((id) => ({ id, title: `Item ${id}`, status: 'open' }));
  return JSON.stringify({ workItems: items });
}

// ── Fixture: herdr pane list --json output ────────────────────────────────

function paneListJson(panes: { paneId: string; label?: string; agent?: string; agentStatus?: string }[]): string {
  return JSON.stringify({ result: { panes } });
}

// ── parseWorklogWorkItemIds ───────────────────────────────────────────────

describe('parseWorklogWorkItemIds', () => {
  it('extracts IDs from a standard workItems array', () => {
    const set = parseWorklogWorkItemIds(
      wlListJson(['WL-0MUDEGBGO00609RV', 'WL-0MUDEIYUB008FFC2', 'WL-0MUDEJU9Z004UO2W']),
    );
    expect(set).not.toBeNull();
    expect(set!.size).toBe(3);
    expect(set!.has('WL-0MUDEGBGO00609RV')).toBe(true);
    expect(set!.has('WL-0MUDEIYUB008FFC2')).toBe(true);
    expect(set!.has('WL-0MUDEJU9Z004UO2W')).toBe(true);
  });

  it('skips entries without an id', () => {
    const set = parseWorklogWorkItemIds(
      JSON.stringify({
        workItems: [
          { id: 'WL-0MUDEGBGO00609RV' },
          { title: 'no id field' },
          { id: '' },
          { id: null },
        ],
      }),
    );
    expect(set).not.toBeNull();
    expect(set!.size).toBe(1);
    expect(set!.has('WL-0MUDEGBGO00609RV')).toBe(true);
  });

  it('returns null for malformed JSON', () => {
    expect(parseWorklogWorkItemIds('not json')).toBeNull();
  });

  it('returns null when there is no workItems array', () => {
    expect(parseWorklogWorkItemIds(JSON.stringify({ items: [] }))).toBeNull();
  });

  it('returns an empty set when workItems is empty', () => {
    const set = parseWorklogWorkItemIds(JSON.stringify({ workItems: [] }));
    expect(set).not.toBeNull();
    expect(set!.size).toBe(0);
  });
});

// ── listBlockingPanes ─────────────────────────────────────────────────────

describe('listBlockingPanes', () => {
  const projectIds = new Set(['WL-0MUDEGBGO00609RV', 'WL-0MUDEIYUB008FFC2']);

  it('returns blocking panes for live agents with project IDs', () => {
    const output = paneListJson([
      { paneId: 'p1', label: 'Downtime implement WL-0MUDEGBGO00609RV', agent: 'agent-1', agentStatus: 'working' },
      { paneId: 'p2', label: 'Other pane', agent: 'agent-2', agentStatus: 'working' },
      { paneId: 'p3', label: 'Downtime audit WL-0MUDEIYUB008FFC2', agent: 'agent-3', agentStatus: 'idle' },
    ]);
    const blocking = listBlockingPanes(projectIds, output);
    expect(blocking.map((b) => b.paneId)).toEqual(['p1', 'p3']);
    expect(blocking[0].workItemId).toBe('WL-0MUDEGBGO00609RV');
    expect(blocking[1].workItemId).toBe('WL-0MUDEIYUB008FFC2');
  });

  it('does not block panes with terminal agent status (done / exited)', () => {
    const output = paneListJson([
      { paneId: 'p1', label: 'Downtime implement WL-0MUDEGBGO00609RV', agent: 'agent-1', agentStatus: 'done' },
      { paneId: 'p2', label: 'Downtime implement WL-0MUDEGBGO00609RV', agent: 'agent-2', agentStatus: 'exited' },
      { paneId: 'p3', label: 'Downtime implement WL-0MUDEGBGO00609RV', agent: undefined, agentStatus: 'done' },
    ]);
    const blocking = listBlockingPanes(projectIds, output);
    expect(blocking).toEqual([]);
  });

  it('does not block panes without a project ID in the label', () => {
    const output = paneListJson([
      { paneId: 'p1', label: 'Random pane', agent: 'agent-1', agentStatus: 'working' },
      { paneId: 'p2', label: 'Downtime implement WL-0OTHERID0000001', agent: 'agent-2', agentStatus: 'working' },
    ]);
    const blocking = listBlockingPanes(projectIds, output);
    expect(blocking).toEqual([]);
  });

  it('does not block panes with no agent', () => {
    const output = paneListJson([
      { paneId: 'p1', label: 'Downtime implement WL-0MUDEGBGO00609RV', agent: undefined, agentStatus: undefined },
    ]);
    const blocking = listBlockingPanes(projectIds, output);
    expect(blocking).toEqual([]);
  });

  it('handles panes with multiple work-item IDs in the label', () => {
    const output = paneListJson([
      { paneId: 'p1', label: 'WL-0MUDEGBGO00609RV on top of WL-0OTHERID0000001', agent: 'agent-1', agentStatus: 'working' },
    ]);
    const blocking = listBlockingPanes(projectIds, output);
    expect(blocking).toHaveLength(1);
    expect(blocking[0].workItemId).toBe('WL-0MUDEGBGO00609RV');
  });

  it('returns empty when the pane list is empty', () => {
    const output = paneListJson([]);
    const blocking = listBlockingPanes(projectIds, output);
    expect(blocking).toEqual([]);
  });

  it('returns empty for malformed pane list (parser returns null)', () => {
    const blocking = listBlockingPanes(projectIds, 'not json');
    expect(blocking).toEqual([]);
  });
});

// ── formatBlockedNotice ───────────────────────────────────────────────────

describe('formatBlockedNotice', () => {
  const blockingPanes: BlockingPane[] = [
    { paneId: 'p1', label: 'Downtime implement WL-0MUDEGBGO00609RV', workItemId: 'WL-0MUDEGBGO00609RV' },
    { paneId: 'p2', label: 'Downtime audit WL-0MUDEIYUB008FFC2', workItemId: 'WL-0MUDEIYUB008FFC2' },
  ];

  it('lists blocking panes with labels', () => {
    const notice = formatBlockedNotice(blockingPanes);
    expect(notice).toContain('Ship mode is blocked');
    expect(notice).toContain('WL-0MUDEGBGO00609RV');
    expect(notice).toContain('WL-0MUDEIYUB008FFC2');
    expect(notice).toContain('Downtime implement WL-0MUDEGBGO00609RV');
    expect(notice).toContain('Downtime audit WL-0MUDEIYUB008FFC2');
  });

  it('lists blocking panes without labels', () => {
    const barePanes: BlockingPane[] = [
      { paneId: 'p1', workItemId: 'WL-0MUDEGBGO00609RV' },
    ];
    const notice = formatBlockedNotice(barePanes);
    expect(notice).toContain('WL-0MUDEGBGO00609RV');
  });

  it('shows a query-failed message when queryFailed is true', () => {
    const notice = formatBlockedNotice([], true);
    expect(notice).toContain('Cannot verify pane state');
    expect(notice).toContain('herdr CLI or worklog');
  });
});

// ── runShipGuard ──────────────────────────────────────────────────────────

describe('runShipGuard', () => {
  const projectIds = new Set(['WL-0MUDEGBGO00609RV', 'WL-0MUDEIYUB008FFC2']);

  it('returns ok=true with no blocking panes when no project panes exist', () => {
    const wlOutput = wlListJson(['WL-0MUDEGBGO00609RV']);
    const paneOutput = paneListJson([
      { paneId: 'p1', label: 'Random pane', agent: 'agent-1', agentStatus: 'working' },
    ]);
    const result = runShipGuard(wlOutput, paneOutput);
    expect(result.ok).toBe(true);
    expect(result.blockingPanes).toEqual([]);
  });

  it('returns ok=true with blocking panes when live panes exist', () => {
    const wlOutput = wlListJson(['WL-0MUDEGBGO00609RV']);
    const paneOutput = paneListJson([
      { paneId: 'p1', label: 'Downtime implement WL-0MUDEGBGO00609RV', agent: 'agent-1', agentStatus: 'working' },
    ]);
    const result = runShipGuard(wlOutput, paneOutput);
    expect(result.ok).toBe(true);
    expect(result.blockingPanes).toHaveLength(1);
    expect(result.blockingPanes[0].workItemId).toBe('WL-0MUDEGBGO00609RV');
  });

  it('returns ok=false with reason when wl list is malformed', () => {
    const result = runShipGuard('not json', paneListJson([]));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('worklog list unavailable');
  });

  it('returns ok=false with reason when pane list is malformed', () => {
    const wlOutput = wlListJson(['WL-0MUDEGBGO00609RV']);
    const result = runShipGuard(wlOutput, 'not json');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('pane list unavailable');
  });

  it('returns ok=false when wl list has no workItems array', () => {
    const result = runShipGuard(JSON.stringify({ items: [] }), paneListJson([]));
    expect(result.ok).toBe(false);
  });
});

// ── AC: blocking check with done/exited agents does not block ─────────────

describe('AC2: live agent only — done/exited agents do not block', () => {
  const projectIds = new Set(['WL-0MUDEGBGO00609RV']);

  it('pane with done agent does not block', () => {
    const output = paneListJson([
      { paneId: 'p1', label: 'Downtime implement WL-0MUDEGBGO00609RV', agent: 'agent-1', agentStatus: 'done' },
    ]);
    const blocking = listBlockingPanes(projectIds, output);
    expect(blocking).toEqual([]);
  });

  it('pane with exited agent does not block', () => {
    const output = paneListJson([
      { paneId: 'p1', label: 'Downtime implement WL-0MUDEGBGO00609RV', agent: 'agent-1', agentStatus: 'exited' },
    ]);
    const blocking = listBlockingPanes(projectIds, output);
    expect(blocking).toEqual([]);
  });

  it('pane with no agent does not block', () => {
    const output = paneListJson([
      { paneId: 'p1', label: 'Downtime implement WL-0MUDEGBGO00609RV', agent: undefined, agentStatus: undefined },
    ]);
    const blocking = listBlockingPanes(projectIds, output);
    expect(blocking).toEqual([]);
  });

  it('mixed: live agent blocks, done agent does not', () => {
    const output = paneListJson([
      { paneId: 'p1', label: 'Downtime implement WL-0MUDEGBGO00609RV', agent: 'agent-1', agentStatus: 'working' },
      { paneId: 'p2', label: 'Downtime implement WL-0MUDEGBGO00609RV', agent: 'agent-2', agentStatus: 'done' },
    ]);
    const blocking = listBlockingPanes(projectIds, output);
    expect(blocking).toHaveLength(1);
    expect(blocking[0].paneId).toBe('p1');
  });
});

// ── AC: multiple blocking panes ───────────────────────────────────────────

describe('AC: multiple blocking panes', () => {
  const projectIds = new Set(['WL-0MUDEGBGO00609RV', 'WL-0MUDEIYUB008FFC2']);

  it('reports all blocking panes', () => {
    const output = paneListJson([
      { paneId: 'p1', label: 'WL-0MUDEGBGO00609RV', agent: 'a1', agentStatus: 'working' },
      { paneId: 'p2', label: 'WL-0MUDEIYUB008FFC2', agent: 'a2', agentStatus: 'working' },
      { paneId: 'p3', label: 'WL-0MUDEGBGO00609RV', agent: 'a3', agentStatus: 'idle' },
    ]);
    const blocking = listBlockingPanes(projectIds, output);
    expect(blocking).toHaveLength(3);
    const ids = blocking.map((b) => b.paneId);
    expect(ids).toContain('p1');
    expect(ids).toContain('p2');
    expect(ids).toContain('p3');
  });
});

// ── AC: different project ID does not block ───────────────────────────────

describe('AC: work-item IDs from a different project not blocking', () => {
  const projectIds = new Set(['WL-0MUDEGBGO00609RV']);

  it('does not block a pane carrying a different project ID', () => {
    const output = paneListJson([
      { paneId: 'p1', label: 'Downtime implement AH-0MTVYBL2L0085G6G', agent: 'agent-1', agentStatus: 'working' },
    ]);
    const blocking = listBlockingPanes(projectIds, output);
    expect(blocking).toEqual([]);
  });

  it('does not block a pane with a WL prefix from a different project', () => {
    const output = paneListJson([
      { paneId: 'p1', label: 'Downtime implement WL-0OTHERID0000001', agent: 'agent-1', agentStatus: 'working' },
    ]);
    const blocking = listBlockingPanes(projectIds, output);
    expect(blocking).toEqual([]);
  });
});

// ── AC: pure and injectable — no file I/O ─────────────────────────────────

describe('AC: pure and injectable helpers', () => {
  it('parseWorklogWorkItemIds is pure', () => {
    const input = wlListJson(['WL-0MUDEGBGO00609RV', 'WL-0MUDEIYUB008FFC2']);
    const result1 = parseWorklogWorkItemIds(input);
    const result2 = parseWorklogWorkItemIds(input);
    expect(result1).toEqual(result2);
    expect(result1).not.toBe(result2); // fresh set each time
  });

  it('listBlockingPanes is pure', () => {
    const projectIds = new Set(['WL-0MUDEGBGO00609RV']);
    const output = paneListJson([
      { paneId: 'p1', label: 'Downtime implement WL-0MUDEGBGO00609RV', agent: 'agent-1', agentStatus: 'working' },
    ]);
    const result1 = listBlockingPanes(projectIds, output);
    const result2 = listBlockingPanes(projectIds, output);
    expect(result1).toEqual(result2);
    expect(result1).not.toBe(result2); // fresh array each time
  });

  it('formatBlockedNotice is pure', () => {
    const panes: BlockingPane[] = [
      { paneId: 'p1', label: 'test', workItemId: 'WL-0MUDEGBGO00609RV' },
    ];
    const result1 = formatBlockedNotice(panes);
    const result2 = formatBlockedNotice(panes);
    expect(result1).toBe(result2);
  });
});

// ── AC: blocked-notice content ────────────────────────────────────────────

describe('AC: blocked notice content', () => {
  it('includes the instruction to close panes', () => {
    const panes: BlockingPane[] = [
      { paneId: 'p1', label: 'Downtime implement WL-0MUDEGBGO00609RV', workItemId: 'WL-0MUDEGBGO00609RV' },
    ];
    const notice = formatBlockedNotice(panes);
    expect(notice).toContain('Close the blocking panes');
    expect(notice).toContain('retry');
  });

  it('includes pane labels where available', () => {
    const panes: BlockingPane[] = [
      { paneId: 'p1', label: 'Downtime implement WL-0MUDEGBGO00609RV', workItemId: 'WL-0MUDEGBGO00609RV' },
    ];
    const notice = formatBlockedNotice(panes);
    expect(notice).toContain('Downtime implement WL-0MUDEGBGO00609RV');
  });
});
