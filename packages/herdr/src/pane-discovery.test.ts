/**
 * packages/herdr/src/pane-discovery.test.ts — Shared dispatched-pane
 * discovery (WL-0MWHWH6XL0025YX2 AC1/AC3/AC4).
 *
 * Pins the canonical discovery module: the raw `herdr pane list` parse, the
 * shared live/working predicates (the ONE liveness vocabulary the in-flight
 * resolution, the reaper and the ship guard consume — AC3), the live-pane
 * count, the item-scoped in-flight set, the safe-close predicate and the
 * blocking-pane filter. The consumers' own suites (downtime-worker.pane,
 * pane-close-herdr, ship-guard, long-running-panes) exercise the delegation;
 * this file pins the shared helpers directly so a span of behaviour change
 * touches one module.
 */

import { describe, expect, it } from 'vitest';
import {
  countRunningDowntimePanes,
  findBlockingPanes,
  hasPaneAgent,
  isPaneAgentLive,
  isPaneWorking,
  isSafeDowntimePaneToClose,
  isTerminalAgentStatus,
  parseHerdrPaneCloseList,
  parseHerdrPaneListOutput,
  runningDowntimePaneItemIds,
  type HerdrPaneRecord,
  type ParsedHerdrPane,
} from './pane-discovery.js';

/** Build a discovery record with the settled label/id convention. */
function rec(overrides: Partial<HerdrPaneRecord> & { paneId: string }): HerdrPaneRecord {
  return {
    label: 'Downtime triggered implement Some item - WL-ABC',
    agent: 'pi',
    agentStatus: 'working',
    ...overrides,
  };
}

describe('parseHerdrPaneCloseList (shared parse contract)', () => {
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
    expect(panes![0]).toMatchObject<ParsedHerdrPane>({
      paneId: 'w1:p1',
      agent: 'pi',
      agentStatus: 'idle',
      sessionPath: '/tmp/s.jsonl',
      workspaceId: undefined,
    });
  });

  it('tolerates log-line prefixes, bare arrays and a top-level {panes} object', () => {
    const bare = JSON.stringify([{ paneId: 'p1', label: 'x' }]);
    expect(parseHerdrPaneCloseList(bare)![0].paneId).toBe('p1');
    const prefixed = '[herdr] starting\n' + JSON.stringify({ panes: [{ pane_id: 'p1' }] });
    expect(parseHerdrPaneCloseList(prefixed)![0].paneId).toBe('p1');
    expect(parseHerdrPaneCloseList('not json at all')).toBeNull();
  });

  it('skips records without a usable pane id', () => {
    const raw = JSON.stringify({ panes: [{ label: 'no id' }, { pane_id: '' }] });
    expect(parseHerdrPaneCloseList(raw)).toEqual([]);
  });
});

describe('parseHerdrPaneListOutput (discovery-facing record)', () => {
  it('maps the shared parse onto the discovery record incl. cwd and agent_session', () => {
    const raw = JSON.stringify({
      result: {
        panes: [
          {
            pane_id: 'w2Y:p87',
            label: 'Manually triggered intake - WL-ABC',
            agent: 'pi',
            agent_status: 'working',
            cwd: '/home/u/projects/OtherRoot',
            agent_session: { kind: 'path', value: '/tmp/s.jsonl' },
          },
        ],
      },
    });
    const panes = parseHerdrPaneListOutput(raw)!;
    expect(panes[0]).toEqual({
      paneId: 'w2Y:p87',
      label: 'Manually triggered intake - WL-ABC',
      agent: 'pi',
      agentStatus: 'working',
      cwd: '/home/u/projects/OtherRoot',
      agentSession: { kind: 'path', value: '/tmp/s.jsonl' },
    });
    expect(parseHerdrPaneListOutput('not json at all')).toBeNull();
  });

  it('maps the pane tab id when present (WL-0MW6FIZYI0003QEU)', () => {
    const raw = JSON.stringify({
      result: {
        panes: [
          { pane_id: 'w9:pShip', label: 'Ship', agent: 'pi', agent_status: 'working', tab_id: 'w9:tShip' },
        ],
      },
    });
    const panes = parseHerdrPaneListOutput(raw)!;
    expect(panes[0].tabId).toBe('w9:tShip');
  });

  it('omits the tab id key when herdr did not report one', () => {
    const raw = JSON.stringify({
      result: { panes: [{ pane_id: 'w9:p1', label: 'P', agent: 'pi', agent_status: 'working' }] },
    });
    const panes = parseHerdrPaneListOutput(raw)!;
    expect('tabId' in panes[0]).toBe(false);
  });
});

describe('shared live/working predicates (AC3 — one liveness vocabulary)', () => {
  it('hasPaneAgent: agent present and non-empty', () => {
    expect(hasPaneAgent({ agent: 'pi' })).toBe(true);
    expect(hasPaneAgent({ agent: '' })).toBe(false);
    expect(hasPaneAgent({})).toBe(false);
  });

  it('isTerminalAgentStatus: done/exited are terminal (case-insensitive); empty/unknown are not', () => {
    expect(isTerminalAgentStatus('done')).toBe(true);
    expect(isTerminalAgentStatus('exited')).toBe(true);
    expect(isTerminalAgentStatus('DONE')).toBe(true);
    expect(isTerminalAgentStatus('idle')).toBe(false);
    expect(isTerminalAgentStatus('working')).toBe(false);
    expect(isTerminalAgentStatus('unknown')).toBe(false);
    expect(isTerminalAgentStatus('')).toBe(false);
    expect(isTerminalAgentStatus(undefined)).toBe(false);
  });

  it('isPaneAgentLive: agent present + non-terminal status (empty status counts live — fail-open)', () => {
    expect(isPaneAgentLive(rec({ agentStatus: 'working' }))).toBe(true);
    expect(isPaneAgentLive(rec({ agentStatus: 'idle' }))).toBe(true);
    // Unknown/empty status is LIVE for the dispatch/ship consumers
    // (never over-dispatch on a duplicate, never enter ship mode against a
    // possibly-live pane).
    expect(isPaneAgentLive(rec({ agentStatus: '' }))).toBe(true);
    expect(isPaneAgentLive(rec({ agentStatus: undefined }))).toBe(true);
    // Terminal statuses and absent agents are NOT live.
    expect(isPaneAgentLive(rec({ agentStatus: 'done' }))).toBe(false);
    expect(isPaneAgentLive(rec({ agentStatus: 'exited' }))).toBe(false);
    expect(isPaneAgentLive(rec({ agent: undefined, agentStatus: 'working' }))).toBe(false);
    expect(isPaneAgentLive(rec({ agent: '', agentStatus: 'working' }))).toBe(false);
  });

  it('isPaneWorking: only a present agent actively working', () => {
    expect(isPaneWorking(rec({ agentStatus: 'working' }))).toBe(true);
    expect(isPaneWorking(rec({ agentStatus: 'WORKING' }))).toBe(true);
    expect(isPaneWorking(rec({ agentStatus: 'idle' }))).toBe(false);
    expect(isPaneWorking(rec({ agentStatus: '' }))).toBe(false);
    expect(isPaneWorking(rec({ agentStatus: 'done' }))).toBe(false);
    expect(isPaneWorking(rec({ agent: undefined, agentStatus: 'working' }))).toBe(false);
  });
});

describe('countRunningDowntimePanes / runningDowntimePaneItemIds / isSafeDowntimePaneToClose', () => {
  it('counts only live downtime panes (excludes manual panes, done agents, agent-less panes)', () => {
    const panes = [
      rec({ paneId: 'w1:p1', label: 'Downtime triggered implement A - WL-A', agentStatus: 'working' }),
      rec({ paneId: 'w1:p2', label: 'Downtime triggered audit B - WL-B', agentStatus: 'idle' }),
      rec({ paneId: 'w1:p3', label: 'Manually triggered implement C - WL-C', agentStatus: 'working' }),
      rec({ paneId: 'w1:p4', label: 'Downtime triggered plan D - WL-D', agentStatus: 'done' }),
      rec({ paneId: 'w1:p5', label: 'Downtime triggered plan E - WL-E', agent: undefined, agentStatus: 'working' }),
      rec({ paneId: 'w1:p6', label: 'Downtime triggered plan F - WL-F', agentStatus: 'exited' }),
    ];
    expect(countRunningDowntimePanes(panes)).toEqual(['w1:p1', 'w1:p2']);
  });

  it('item-scoped in-flight set: only WORKING downtime panes keyed by item id', () => {
    const ids = runningDowntimePaneItemIds([
      rec({ paneId: 'w1:p1', label: 'Downtime triggered implement A - WL-A', agentStatus: 'working' }),
      // terminal → excluded
      rec({ paneId: 'w1:p2', label: 'Downtime triggered implement B - WL-B', agentStatus: 'done' }),
      // idle/unknown → NOT working → excluded (no deadlock)
      rec({ paneId: 'w1:p4', label: 'Downtime triggered implement D - WL-D', agentStatus: 'idle' }),
      // manual pane → excluded
      rec({ paneId: 'w1:p5', label: 'Work Items', agentStatus: 'working' }),
      // no agent → excluded
      rec({ paneId: 'w1:p6', label: 'Downtime plan E - WL-E', agent: undefined, agentStatus: 'working' }),
    ]);
    expect([...ids]).toEqual(['WL-A']);
  });

  it('isSafeDowntimePaneToClose only accepts the downtime pane for the SAME item (AC7)', () => {
    const live = [
      rec({ paneId: 'w1:p1', label: 'Downtime triggered implement Some item - WL-ABC' }),
      rec({ paneId: 'w1:p2', label: 'pi - my operator session' }),
    ];
    expect(isSafeDowntimePaneToClose(live, 'w1:p1', 'WL-ABC')).toBe(true);
    // A different item's downtime pane (id collision) → NOT safe.
    expect(isSafeDowntimePaneToClose(live, 'w1:p1', 'WL-OTHER')).toBe(false);
    // A non-downtime (operator) pane → NOT safe.
    expect(isSafeDowntimePaneToClose(live, 'w1:p2', 'WL-ABC')).toBe(false);
    // The pane is already gone → NOT safe (nothing to close).
    expect(isSafeDowntimePaneToClose(live, 'w1:p9', 'WL-ABC')).toBe(false);
  });
});

describe('findBlockingPanes (ship-guard blocking filter)', () => {
  const projectIds = new Set(['WL-0MUDEGBGO00609RV', 'WL-0MUDEIYUB008FFC2']);

  it('blocks live agents with project IDs; skips manual/done/no-agent panes', () => {
    const panes: HerdrPaneRecord[] = [
      rec({ paneId: 'p1', label: 'Downtime implement WL-0MUDEGBGO00609RV', agentStatus: 'working' }),
      rec({ paneId: 'p2', label: 'Other pane', agentStatus: 'working' }),
      rec({ paneId: 'p3', label: 'Downtime audit WL-0MUDEIYUB008FFC2', agentStatus: 'idle' }),
      rec({ paneId: 'p4', label: 'Downtime implement WL-0MUDEGBGO00609RV', agentStatus: 'done' }),
      rec({ paneId: 'p5', label: 'Downtime implement WL-0MUDEGBGO00609RV', agent: undefined, agentStatus: 'done' }),
    ];
    const blocking = findBlockingPanes(panes, projectIds);
    expect(blocking.map((b) => b.paneId)).toEqual(['p1', 'p3']);
    expect(blocking[0].workItemId).toBe('WL-0MUDEGBGO00609RV');
    expect(blocking[1].workItemId).toBe('WL-0MUDEIYUB008FFC2');
  });

  it('handles panes with multiple work-item IDs in the label', () => {
    const panes: HerdrPaneRecord[] = [
      rec({ paneId: 'p1', label: 'WL-0MUDEGBGO00609RV on top of WL-0OTHERID0000001', agentStatus: 'working' }),
    ];
    const blocking = findBlockingPanes(panes, projectIds);
    expect(blocking).toHaveLength(1);
    expect(blocking[0].workItemId).toBe('WL-0MUDEGBGO00609RV');
  });

  it('returns empty for no matches or an empty pane set', () => {
    expect(findBlockingPanes([], projectIds)).toEqual([]);
    expect(
      findBlockingPanes(
        [rec({ paneId: 'p1', label: 'Downtime implement WL-0OTHERID0000001', agentStatus: 'working' })],
        projectIds,
      ),
    ).toEqual([]);
  });
});
