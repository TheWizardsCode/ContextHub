/**
 * packages/herdr/src/downtime-worker.prep-supply-source.test.ts — the ACQUISITION
 * half of the prep-supply report (WL-0MWTBJ7G1004Y29B, child 2 of
 * WL-0MWTAD1KM0081UUD).
 *
 * Pins the two reads the report is documented to use:
 *
 *  - `wl worklist --json` — the consolidated read the worklist/fetcher already
 *    issues (it has NO prep-stage subset, hence the gap);
 *  - the per-root fallback `wl list --json --stage idea|intake_complete
 *    --include-not-started` — the full prep read that closes the gap.
 *
 * Also pins the outbound-dependency enrichment (batched in-process read first,
 * `wl dep list <id> --json` fail-open fallback) and the fail-closed behaviour
 * on an unparseable payload. Every subprocess is a fake: no live worklog, no
 * `wl`, no sleeps.
 */

import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import {
  PREP_SUPPLY_FALLBACK_STATUSES,
  createPrepSupplyReportDeps,
  parseListItems,
  parseWorklistItems,
  toPrepSupplyItem,
} from './downtime-worker.prep-supply-source.js';
import { PREP_SUPPLY_STAGES } from './downtime-worker.prep-supply.js';
import type { DependencyTargetRef } from './fetcher.types.js';

const ROOT = '/home/x/projects/ContextHub';

interface CapturedCall {
  file: string;
  args: readonly string[];
}

/** A fake exec whose stdout is routed by the `wl` subcommand. */
function fakeExec(routes: Record<string, string | Error>): {
  exec: (file: string, args: readonly string[]) => Promise<unknown>;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  return {
    calls,
    exec: async (file, args) => {
      calls.push({ file, args: [...args] });
      const subcommand = args.find((arg) =>
        ['worklist', 'list', 'dep'].includes(arg),
      ) as string | undefined;
      const response = routes[subcommand ?? ''];
      if (response === undefined) throw new Error(`unexpected wl call: ${args.join(' ')}`);
      if (response instanceof Error) throw response;
      return { stdout: response };
    },
  };
}

const ITEM_JSON = {
  id: 'WL-1',
  title: 'An item',
  status: 'open',
  stage: 'idea',
  priority: 'medium',
  assignee: '',
  startOn: '2026-11-20T00:00:00.000Z',
  createdAt: '2026-11-20T00:00:00.000Z',
  needsProducerReview: false,
};

const WORKLIST_PAYLOAD = JSON.stringify({
  success: true,
  subsets: {
    critical: [ITEM_JSON],
    reviewQueue: [],
    inProgressRoots: [],
    blockedRoots: [],
    // The browse feed wraps each item in an envelope.
    browse: [{ workItem: ITEM_JSON, reason: 'browse' }],
  },
});

const LIST_PAYLOAD = JSON.stringify({ success: true, workItems: [ITEM_JSON] });

describe('prep-supply payload parsing', () => {
  it('reads every worklist subset and the browse envelope, deduped by id', () => {
    const items = parseWorklistItems(WORKLIST_PAYLOAD);
    expect(items).not.toBeNull();
    expect(items?.map((item) => item.id)).toEqual(['WL-1']);
    expect(items?.[0].stage).toBe('idea');
  });

  it('fails closed on malformed or shapeless worklist output', () => {
    expect(parseWorklistItems('not json')).toBeNull();
    expect(parseWorklistItems('{}')).toBeNull();
    expect(parseWorklistItems('{"subsets":{}}')).toEqual([]);
  });

  it('reads the list payload and skips non-object rows', () => {
    const payload = JSON.stringify({
      workItems: [ITEM_JSON, null, 'nope', { title: 'no id' }],
    });
    expect(parseListItems(payload)?.map((item) => item.id)).toEqual(['WL-1']);
    expect(parseListItems('{"success":true}')).toBeNull();
    expect(parseListItems('[]')).toBeNull();
  });

  it('maps only the documented item fields, keeping the flag and soft-delete', () => {
    const item = toPrepSupplyItem({
      ...ITEM_JSON,
      needsProducerReview: true,
      deletedBy: 'producer',
      unexpected: 'dropped',
    });
    expect(item).toMatchObject({
      id: 'WL-1',
      status: 'open',
      stage: 'idea',
      needsProducerReview: true,
      deletedBy: 'producer',
    });
    expect(item).not.toHaveProperty('unexpected');
    expect(toPrepSupplyItem(null)).toBeNull();
    expect(toPrepSupplyItem({ title: 'no id' })).toBeNull();
  });
});

describe('prep-supply report deps', () => {
  it('reads the consolidated worklist for a root through --worklog-dir', async () => {
    const { exec, calls } = fakeExec({ worklist: WORKLIST_PAYLOAD });
    const deps = createPrepSupplyReportDeps({
      exec,
      readLogEntries: async () => [],
      readDependencyTargets: async () => new Map(),
    });
    const read = await deps.readWorklist(ROOT);
    expect(read.items.map((item) => item.id)).toEqual(['WL-1']);
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('wl');
    expect(calls[0].args).toEqual([
      '--worklog-dir',
      join(ROOT, '.worklog'),
      'worklist',
      '--json',
    ]);
  });

  it('falls back to a per-stage full prep read with not-started items included', async () => {
    const { exec, calls } = fakeExec({ list: LIST_PAYLOAD });
    const deps = createPrepSupplyReportDeps({
      exec,
      readLogEntries: async () => [],
      readDependencyTargets: async () => new Map(),
    });
    const read = await deps.readFull(ROOT);
    expect(read.items.map((item) => item.id)).toEqual(['WL-1']);
    expect(calls).toHaveLength(PREP_SUPPLY_STAGES.length);
    for (const [index, stage] of PREP_SUPPLY_STAGES.entries()) {
      expect(calls[index].args).toEqual([
        '--worklog-dir',
        join(ROOT, '.worklog'),
        'list',
        '--json',
        '--status',
        PREP_SUPPLY_FALLBACK_STATUSES,
        '--stage',
        stage,
        '--include-not-started',
      ]);
    }
  });

  it('attaches the batched outbound dependency edges and blocker statuses', async () => {
    const { exec } = fakeExec({ list: LIST_PAYLOAD });
    const readDependencyTargets = vi.fn(
      async (_root: string, ids: readonly string[]): Promise<Map<string, DependencyTargetRef[]>> => {
        expect(ids).toContain('WL-1');
        return new Map([
          ['WL-1', [{ id: 'WL-BLOCKER', status: 'open', title: 'Blocker' }]],
        ]);
      },
    );
    const deps = createPrepSupplyReportDeps({
      exec,
      readLogEntries: async () => [],
      readDependencyTargets,
    });
    const read = await deps.readFull(ROOT);
    expect(read.items[0].dependencies).toEqual([{ from: 'WL-1', to: 'WL-BLOCKER' }]);
    expect(read.blockerStatusById).toEqual({ 'WL-BLOCKER': 'open' });
    expect(readDependencyTargets).toHaveBeenCalledTimes(1);
  });

  it('falls back to `wl dep list <id> --json` when the batched read is unavailable', async () => {
    const depPayload = JSON.stringify({
      success: true,
      outbound: [{ id: 'WL-BLOCKER', status: 'blocked', direction: 'depends-on' }],
      inbound: [],
    });
    const { exec, calls } = fakeExec({ list: LIST_PAYLOAD, dep: depPayload });
    const deps = createPrepSupplyReportDeps({
      exec,
      readLogEntries: async () => [],
      readDependencyTargets: async () => undefined,
    });
    const read = await deps.readFull(ROOT);
    expect(read.items[0].dependencies).toEqual([{ from: 'WL-1', to: 'WL-BLOCKER' }]);
    expect(read.blockerStatusById).toEqual({ 'WL-BLOCKER': 'blocked' });
    const depCall = calls.find((call) => call.args.includes('dep'));
    expect(depCall?.args).toEqual([
      '--worklog-dir',
      join(ROOT, '.worklog'),
      'dep',
      'list',
      'WL-1',
      '--json',
    ]);
  });

  it('fails closed on an unparseable per-root read instead of reporting empty supply', async () => {
    const { exec } = fakeExec({ list: 'not json' });
    const deps = createPrepSupplyReportDeps({
      exec,
      readLogEntries: async () => [],
      readDependencyTargets: async () => new Map(),
    });
    await expect(deps.readFull(ROOT)).rejects.toThrow(/unparseable/i);
  });

  it('reads the log through the injected seam', async () => {
    const { exec } = fakeExec({ worklist: WORKLIST_PAYLOAD });
    const readLogEntries = vi.fn(async () => []);
    const deps = createPrepSupplyReportDeps({
      exec,
      readLogEntries,
      readDependencyTargets: async () => new Map(),
    });
    await deps.readLogEntries(ROOT);
    expect(readLogEntries).toHaveBeenCalledWith(ROOT);
  });
});
