/**
 * packages/herdr/src/downtime-worker.route-outcome.test.ts — observed routing
 * outcome (WL-0MVWEZF4Z004UNYT AC10).
 *
 * Pins the AC10 contract: the dispatch record gains the OBSERVED local/remote
 * split of a dispatched session, sourced from the bounded route log (never
 * from the reservation ticket), and a 0 %-local run is recorded as
 * `localStarved: true` — with a dispatch that made no requests recorded as
 * `notObserved`, never as healthy.
 *
 * Test scenarios demanded by AC10: a stub route log producing 0 local /
 * 7 remote yields `localStarved: true` with the split recorded; a mixed 3/4
 * split yields `localStarved: false`; a dispatch with no requests at all is
 * recorded as `notObserved`.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { appendDowntimeLogEntry, readDowntimeLogEntries } from './downtime-log.js';
import {
  buildRouteOutcomeEntry,
  computeRouteSplit,
  observeDispatchedPaneOutcome,
  readLocalRouteLogEntries,
  sessionIdFromSessionPath,
  type RouteLogLine,
} from './downtime-worker.js';

/** A temp worklog root per test (cleanup-tracked). */
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'herdr-route-outcome-'));
  mkdirSync(join(root, '.worklog'), { recursive: true });
  return root;
}

function local(route: 'local' | 'remote:opencode-go', at: string): RouteLogLine {
  return { at, route };
}

describe('readLocalRouteLogEntries — fail-safe reader', () => {
  it('yields [] for a missing route log (normal first-run state)', async () => {
    const root = makeRoot();
    await expect(readLocalRouteLogEntries(root)).resolves.toEqual([]);
  });

  it('skips malformed JSONL lines without throwing', async () => {
    const root = makeRoot();
    writeFileSync(
      join(root, '.worklog', 'local-route.log'),
      '{ "route": "local" }\nnot json\n{ "route": "remote:opencode-go" }\n',
      'utf8',
    );
    const entries = await readLocalRouteLogEntries(root);
    expect(entries.map((e) => e.route)).toEqual(['local', 'remote:opencode-go']);
  });
});

describe('computeRouteSplit — AC10', () => {
  it('AC10: a 0 local / 7 remote route log yields observed 0/7 (localStarved decided at record build)', () => {
    const entries = Array.from({ length: 7 }, (_, i) => local('remote:opencode-go', `t${i}`));
    expect(computeRouteSplit(entries)).toEqual({
      observed: true,
      localStreams: 0,
      remoteStreams: 7,
    });
  });

  it('AC10: a mixed 3/4 split yields observed 3/4', () => {
    const entries = [
      local('local', 't1'),
      local('local', 't2'),
      local('local', 't3'),
      local('remote:opencode-go', 't4'),
      local('remote:opencode-go', 't5'),
      local('remote:opencode-go', 't6'),
      local('remote:opencode-go', 't7'),
    ];
    expect(computeRouteSplit(entries)).toEqual({
      observed: true,
      localStreams: 3,
      remoteStreams: 4,
    });
  });

  it('AC10: a dispatch with no requests at all is not observed (never healthy)', () => {
    expect(computeRouteSplit([])).toEqual({ observed: false });
  });

  it('AC10: entries with an unclassifiable route are ignored, and a log with only them is notObserved', () => {
    expect(computeRouteSplit([{ at: 't1', route: 'weird' }])).toEqual({ observed: false });
  });

  it('AC10: attribution by reservation ticket isolates ONE dispached session', () => {
    const own = Array.from({ length: 7 }, (_, i) => ({
      ...local('remote:opencode-go', `t${i}`),
      ticket: 'tkt-own',
      sessionId: 'herdr-1',
    }));
    const other = Array.from({ length: 2 }, (_, i) => ({
      ...local('local', `o${i}`),
      ticket: 'tkt-other',
      sessionId: 'herdr-2',
    }));
    expect(computeRouteSplit([...other, ...own], { ticket: 'tkt-own' })).toEqual({
      observed: true,
      localStreams: 0,
      remoteStreams: 7,
    });
  });

  it('AC10: attribution by pi sessionId isolates the pane session when no ticket exists', () => {
    const own = Array.from({ length: 2 }, (_, i) => ({
      ...local('local', `t${i}`),
      sessionId: 'herdr-1',
    }));
    const other = [{ ...local('remote:opencode-go', 'o1'), sessionId: 'herdr-2' }];
    expect(computeRouteSplit([...other, ...own], { sessionId: 'herdr-1' })).toEqual({
      observed: true,
      localStreams: 2,
      remoteStreams: 0,
    });
  });
});

describe('sessionIdFromSessionPath — AC10 attribution bridge', () => {
  it('derives the pi session id from a pi session-log path', () => {
    expect(
      sessionIdFromSessionPath(
        '/home/u/.pi/agent/sessions/--home-u-projects-app--/2026-10-29T00-44-13-965Z_herdr-1793234652-1770391-437.jsonl',
      ),
    ).toBe('herdr-1793234652-1770391-437');
  });

  it('returns undefined for paths without a timestamp_ prefix', () => {
    expect(sessionIdFromSessionPath('')).toBeUndefined();
    expect(sessionIdFromSessionPath('/some/plain.jsonl')).toBeUndefined();
    expect(sessionIdFromSessionPath('no-underscore')).toBeUndefined();
  });
});

describe('buildRouteOutcomeEntry — AC10 record shape', () => {
  it('a 0 local / 7 remote run records localStarved: true with the split', () => {
    const entry = buildRouteOutcomeEntry({
      itemId: 'WL-1',
      paneId: 'w1:p1',
      split: { observed: true, localStreams: 0, remoteStreams: 7 },
      preference: 'remote-ok',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    expect(entry).toMatchObject({
      entryType: 'route-outcome',
      itemId: 'WL-1',
      paneId: 'w1:p1',
      localStreams: 0,
      remoteStreams: 7,
      localStarved: true,
      preference: 'remote-ok',
    });
    expect(entry.notObserved).toBeUndefined();
  });

  it('a mixed 3/4 split records localStarved: false', () => {
    const entry = buildRouteOutcomeEntry({
      itemId: 'WL-1',
      paneId: 'w1:p1',
      split: { observed: true, localStreams: 3, remoteStreams: 4 },
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    expect(entry).toMatchObject({ localStreams: 3, remoteStreams: 4, localStarved: false });
  });

  it('a dispatch with no requests is recorded as notObserved — never as healthy', () => {
    const entry = buildRouteOutcomeEntry({
      itemId: 'WL-1',
      paneId: 'w1:p1',
      split: { observed: false },
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    expect(entry).toMatchObject({ entryType: 'route-outcome', notObserved: true });
    expect(entry.localStarved).toBeUndefined();
    expect(entry.localStreams).toBeUndefined();
  });

  it('carries the fallback reasons and ticket when provided', () => {
    const entry = buildRouteOutcomeEntry({
      itemId: 'WL-1',
      paneId: 'w1:p1',
      ticket: 'tkt-1',
      split: { observed: true, localStreams: 0, remoteStreams: 2 },
      fallbackReasons: ['queue-full', 'model-switch'],
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    expect(entry).toMatchObject({
      ticket: 'tkt-1',
      fallbackReasons: ['queue-full', 'model-switch'],
      localStarved: true,
    });
  });
});

describe('observeDispatchedPaneOutcome — window-close integration (AC10)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Seed a dispatch marker (with optional ticket/preference) + route log. */
  async function seed(
    root: string,
    opts: {
      itemId?: string;
      kind?: string;
      reservationTicketId?: string;
      localPreference?: string;
      routeEntries?: RouteLogLine[];
    } = {},
  ) {
    await appendDowntimeLogEntry(
      root,
      JSON.stringify({
        itemId: opts.itemId ?? 'WL-1',
        kind: opts.kind ?? 'plan',
        dispatchedAt: '2026-01-01T00:00:00.000Z',
        cwd: root,
        title: 'Route me',
        stage: 'intake_complete',
        ...(opts.reservationTicketId !== undefined ? { reservationTicketId: opts.reservationTicketId } : {}),
        ...(opts.localPreference !== undefined ? { localPreference: opts.localPreference } : {}),
      }),
    );
    if (opts.routeEntries !== undefined && opts.routeEntries.length > 0) {
      writeFileSync(
        join(root, '.worklog', 'local-route.log'),
        opts.routeEntries.map((e) => JSON.stringify(e)).join('\n') + '\n',
        'utf8',
      );
    }
  }

  function routeOutcomeEntries(root: string) {
    return readDowntimeLogEntries(root).then((entries) =>
      entries.filter((e) => e.entryType === 'route-outcome'),
    );
  }

  it('AC10: a 0 local / 7 remote session is recorded with localStarved: true and the split', async () => {
    const root = makeRoot();
    await seed(root, {
      reservationTicketId: 'tkt-own',
      routeEntries: Array.from({ length: 7 }, (_, i) => ({
        at: `2026-01-01T00:01:0${i}Z`,
        sessionId: 'herdr-1',
        ticket: 'tkt-own',
        route: 'remote:opencode-go',
        preference: 'local-preferred',
      })),
    });

    await observeDispatchedPaneOutcome(root, { itemId: 'WL-1', paneId: 'w1:p1' });

    const outcomes = await routeOutcomeEntries(root);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      entryType: 'route-outcome',
      itemId: 'WL-1',
      paneId: 'w1:p1',
      kind: 'plan',
      ticket: 'tkt-own',
      dispatchedAt: '2026-01-01T00:00:00.000Z',
      localStreams: 0,
      remoteStreams: 7,
      localStarved: true,
    });
  });

  it('AC10: a mixed 3/4 session is recorded with localStarved: false', async () => {
    const root = makeRoot();
    const entries: RouteLogLine[] = [
      ...Array.from({ length: 3 }, (_, i) => ({
        at: `t${i}`,
        sessionId: 'herdr-1',
        ticket: 'tkt-own',
        route: 'local' as const,
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        at: `r${i}`,
        sessionId: 'herdr-1',
        ticket: 'tkt-own',
        route: 'remote:opencode-go' as const,
      })),
    ];
    await seed(root, { reservationTicketId: 'tkt-own', routeEntries: entries });

    await observeDispatchedPaneOutcome(root, { itemId: 'WL-1', paneId: 'w1:p1' });

    const outcomes = await routeOutcomeEntries(root);
    expect(outcomes[0]).toMatchObject({ localStreams: 3, remoteStreams: 4, localStarved: false });
  });

  it('AC10: a dispatch with no requests at all is recorded as notObserved (never healthy)', async () => {
    const root = makeRoot();
    await seed(root, { localPreference: 'local-preferred' }); // no route log

    await observeDispatchedPaneOutcome(root, { itemId: 'WL-1', paneId: 'w1:p1' });

    const outcomes = await routeOutcomeEntries(root);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ entryType: 'route-outcome', notObserved: true });
  });

  it('AC10: a no-ticket session is attributed by pi sessionId, not by ticket', async () => {
    const root = makeRoot();
    await seed(root, {
      routeEntries: [
        { at: 't1', sessionId: 'herdr-1', route: 'local' },
        { at: 'o1', sessionId: 'herdr-2', route: 'remote:opencode-go' },
      ],
    });

    await observeDispatchedPaneOutcome(root, { itemId: 'WL-1', paneId: 'w1:p1', sessionId: 'herdr-1' });

    const outcomes = await routeOutcomeEntries(root);
    expect(outcomes[0]).toMatchObject({ sessionId: 'herdr-1', localStreams: 1, remoteStreams: 0, localStarved: false });
  });

  it('AC10: emits a WARNING naming dispatch/split/reason when prefer-local work starved', async () => {
    const root = makeRoot();
    await seed(root, {
      localPreference: 'local-preferred',
      routeEntries: [
        {
          at: 't1',
          sessionId: 'herdr-1',
          route: 'remote:opencode-go',
          fallbackReason: 'queue-full',
        },
      ],
    });
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await observeDispatchedPaneOutcome(root, { itemId: 'WL-1', paneId: 'w1:p1' });

    const entry = (await routeOutcomeEntries(root))[0];
    expect(entry).toMatchObject({ localStreams: 0, remoteStreams: 1, localStarved: true });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Downtime local-starved: dispatch WL-1 (pane w1:p1)'),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('0 local / 1 remote'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('queue-full'));
  });

  it('AC10: no WARNING for a remote-ok starved run (prefer-local is the warning scope)', async () => {
    const root = makeRoot();
    await seed(root, {
      localPreference: 'remote-ok',
      routeEntries: [{ at: 't1', sessionId: 'herdr-1', route: 'remote:opencode-go' }],
    });
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await observeDispatchedPaneOutcome(root, { itemId: 'WL-1', paneId: 'w1:p1' });

    expect((await routeOutcomeEntries(root))[0]).toMatchObject({ localStarved: true });
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('local-starved'));
  });

  it('AC10: with no dispatch marker nothing is written (nothing to observe)', async () => {
    const root = makeRoot();
    await observeDispatchedPaneOutcome(root, { itemId: 'WL-UNKNOWN', paneId: 'w1:p9' });
    expect(await routeOutcomeEntries(root)).toHaveLength(0);
  });
});
