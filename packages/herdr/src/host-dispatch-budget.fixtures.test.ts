/**
 * Self-test for the machine-budget test harness
 * (WL-0MVXY0VGR00840ZS, parent WL-0MVXWQFGV000D2AB).
 *
 * The harness is what every host-dispatch-budget test will import, so its
 * own guarantees are pinned here: the machine dir is isolated to a temp dir
 * and never the real `~/.herdr/downtime`, two fake instances sharing one dir
 * observe each other's raw writes, a second call gets a distinct dir, and
 * cleanup (including on a thrown body) leaves no residue and restores the
 * environment.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { getMachineCoordinationDir } from './machine-coordination.js';
import {
  DISPATCH_BUDGET_FILE,
  MACHINE_DIR_TEMP_PREFIX,
  budgetLedgerPath,
  makeBudgetEntry,
  makeInstance,
  makeLivePaneList,
  readBudgetLedger,
  seedBudgetLedger,
  withMachineDir,
  writeBudgetLedger,
  writeRawBudgetLedger,
} from './host-dispatch-budget.fixtures.js';

describe('withMachineDir isolation', () => {
  it('pins the machine dir to a temp dir and never touches the real machine dir', async () => {
    const realLedger = join(homedir(), '.herdr', 'downtime', DISPATCH_BUDGET_FILE);
    const realBefore = existsSync(realLedger) ? readFileSync(realLedger, 'utf8') : null;

    await withMachineDir((dir) => {
      expect(dir.startsWith(tmpdir())).toBe(true);
      expect(basename(dir).startsWith(MACHINE_DIR_TEMP_PREFIX)).toBe(true);
      expect(dir).not.toBe(join(homedir(), '.herdr', 'downtime'));
      // The resolver — the single source of truth every production reader
      // uses — must agree with the pin, not with the real machine dir.
      expect(getMachineCoordinationDir()).toBe(dir);

      writeBudgetLedger(dir, [makeBudgetEntry()]);
      expect(budgetLedgerPath(dir)).toBe(join(dir, DISPATCH_BUDGET_FILE));
      expect(readBudgetLedger(dir)?.entries).toHaveLength(1);
    });

    const realAfter = existsSync(realLedger) ? readFileSync(realLedger, 'utf8') : null;
    expect(realAfter).toBe(realBefore);
  });

  it('gives each call a distinct dir and removes both from the temp root', async () => {
    let first = '';
    let second = '';
    await withMachineDir((dir) => {
      first = dir;
      writeBudgetLedger(dir, [makeBudgetEntry()]);
    });
    await withMachineDir((dir) => {
      second = dir;
    });

    expect(first).not.toBe(second);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
    const tempEntries = readdirSync(tmpdir());
    expect(tempEntries).not.toContain(basename(first));
    expect(tempEntries).not.toContain(basename(second));
  });

  it('cleans up and restores the env when the body throws', async () => {
    const previous = process.env.HERDR_COORDINATION_DIR;
    try {
      process.env.HERDR_COORDINATION_DIR = '/tmp/pre-existing-coordination-dir';
      let seen = '';
      await expect(
        withMachineDir((dir) => {
          seen = dir;
          expect(process.env.HERDR_COORDINATION_DIR).toBe(dir);
          writeBudgetLedger(dir, [makeBudgetEntry()]);
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(existsSync(seen)).toBe(false);
      expect(process.env.HERDR_COORDINATION_DIR).toBe('/tmp/pre-existing-coordination-dir');

      // An unset previous value is restored as unset, not as an empty string.
      delete process.env.HERDR_COORDINATION_DIR;
      await withMachineDir(() => undefined);
      expect(process.env.HERDR_COORDINATION_DIR).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.HERDR_COORDINATION_DIR;
      else process.env.HERDR_COORDINATION_DIR = previous;
    }
  });
});

describe('two fake instances over one machine dir', () => {
  it('observe each other\'s raw ledger writes', async () => {
    await withMachineDir((dir) => {
      const a = makeInstance('instance-a', { workItemId: 'WL-AAA' });
      const b = makeInstance('instance-b', { workItemId: 'WL-BBB' });
      const panes = makeLivePaneList([a.workItemId, { paneId: 'pane-b', itemId: b.workItemId }]);
      expect(panes.map((pane) => pane.paneId)).toEqual(['pane-1', 'pane-b']);

      // Instance A seeds a live implement dispatch.
      seedBudgetLedger(dir, [
        makeBudgetEntry({
          itemId: a.workItemId,
          instanceId: a.instanceId,
          root: a.worklogRoot,
          paneId: panes[0].paneId,
        }),
      ]);
      const seenByB = readBudgetLedger(dir);
      expect(seenByB?.entries.map((entry) => entry.instanceId)).toEqual([a.instanceId]);

      // Instance B seeds its own audit dispatch and sees A's entry too: one
      // shared file, machine-scoped state, no per-instance copy.
      seedBudgetLedger(dir, [
        makeBudgetEntry({
          kind: 'audit',
          itemId: b.workItemId,
          instanceId: b.instanceId,
          root: b.worklogRoot,
          paneId: panes[1].paneId,
        }),
      ]);
      const seenByA = readBudgetLedger(dir);
      expect(seenByA?.entries.map((entry) => [entry.instanceId, entry.kind])).toEqual([
        [a.instanceId, 'implement'],
        [b.instanceId, 'audit'],
      ]);
      expect(seenByA?.entries.map((entry) => entry.paneId)).toEqual(['pane-1', 'pane-b']);
    });
  });
});

describe('raw ledger writer / seeder', () => {
  it('replaces on write, appends on seed, and reads raw bytes verbatim', async () => {
    await withMachineDir((dir) => {
      expect(readBudgetLedger(dir)).toBeNull();

      const seeded = makeBudgetEntry({ itemId: 'WL-1' });
      writeBudgetLedger(dir, [seeded], { version: 7 });
      expect(readBudgetLedger(dir)).toEqual({ version: 7, entries: [seeded] });

      // A plain write is a replace, never an append.
      writeBudgetLedger(dir, [makeBudgetEntry({ itemId: 'WL-2' })]);
      expect(readBudgetLedger(dir)?.entries.map((entry) => entry.itemId)).toEqual(['WL-2']);

      seedBudgetLedger(dir, [makeBudgetEntry({ itemId: 'WL-3' })]);
      expect(readBudgetLedger(dir)?.entries.map((entry) => entry.itemId)).toEqual([
        'WL-2',
        'WL-3',
      ]);
      // Seeding preserves the document version it found.
      expect(readBudgetLedger(dir)?.version).toBe(1);
    });
  });

  it('surfaces a missing, empty or corrupt ledger as null (fail-safe view)', async () => {
    await withMachineDir((dir) => {
      expect(readBudgetLedger(dir)).toBeNull();
      writeRawBudgetLedger(dir, '');
      expect(readBudgetLedger(dir)).toBeNull();
      writeRawBudgetLedger(dir, '{ not json');
      expect(readBudgetLedger(dir)).toBeNull();
      writeRawBudgetLedger(dir, '{"version":1}');
      expect(readBudgetLedger(dir)).toBeNull();
      writeRawBudgetLedger(dir, '[]');
      expect(readBudgetLedger(dir)).toBeNull();
    });
  });
});

describe('fake records', () => {
  it('makeInstance derives a coordination-entry-compatible record', () => {
    const a = makeInstance('instance-a');
    expect(a.instanceId).toBe('instance-a');
    expect(a.workItemId).toBe('');
    expect(a.worklogRoot).toBe('/repo/instance-a');
    expect(a.directory).toBe(a.worklogRoot);
    expect(Number.isNaN(Date.parse(a.assignedAt))).toBe(false);
    expect(Number.isNaN(Date.parse(a.lastUpdated))).toBe(false);

    const b = makeInstance('instance-b', {
      workItemId: 'WL-B',
      worklogRoot: '/repo/b',
      lastUpdated: '2026-01-01T00:00:00.000Z',
    });
    expect(b.directory).toBe('/repo/b');
    expect(b.lastUpdated).toBe('2026-01-01T00:00:00.000Z');
  });

  it('makeBudgetEntry defaults every on-disk field and only adds override when asked', () => {
    const entry = makeBudgetEntry();
    expect(entry.kind).toBe('implement');
    expect(entry.itemId).toBe('WL-TEST');
    expect(entry.instanceId).toBe('instance-1');
    expect(entry.root).toBe('/repo/test');
    expect(entry.paneId).toBeUndefined();
    expect(entry.override).toBeUndefined();
    expect(Number.isNaN(Date.parse(entry.startedAt))).toBe(false);
    expect(Number.isNaN(Date.parse(entry.heartbeatAt))).toBe(false);

    const overridden = makeBudgetEntry({
      kind: 'audit',
      itemId: 'WL-O',
      instanceId: 'instance-2',
      paneId: 'pane-9',
      override: { by: 'user' },
    });
    expect(overridden.override).toEqual({ by: 'user' });
    expect(overridden.paneId).toBe('pane-9');
  });

  it('makeLivePaneList follows the fake-pane-list contract', () => {
    expect(makeLivePaneList()).toEqual([]);
    expect(
      makeLivePaneList([
        'WL-A',
        { paneId: 'p-2', itemId: 'WL-B' },
        { paneId: 'p-3', title: 'unrelated title' },
        { title: 'no work item' },
      ]),
    ).toEqual([
      { paneId: 'pane-1', title: 'Downtime triggered - WL-A' },
      { paneId: 'p-2', title: 'Downtime triggered - WL-B' },
      { paneId: 'p-3', title: 'unrelated title' },
      { paneId: 'pane-4', title: 'no work item' },
    ]);
  });
});
