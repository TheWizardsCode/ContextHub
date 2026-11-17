/**
 * Tests for the append-only dispatch-budget audit trail
 * (WL-0MWFJDGXQ001OXP8, parent WL-0MWFJD1RV008FCCR).
 *
 * The 2026-11-13 RCA could not establish which code path deleted six confirmed
 * ledger entries, because `dispatch-budget.json` keeps current state only. This
 * suite pins the trail that fixes that:
 *
 *  - one line per mutation, with the fields the RCA needs (`op`, `kind`,
 *    `itemId`, `paneId`, `instanceId`, `reason`, `actor`, `liveBefore`,
 *    `liveAfter`);
 *  - one line per REMOVED entry for `reap`/`sweep`, so a deletion is
 *    attributable;
 *  - the coordination-log retention policy bounds the file (per-file cap plus
 *    numbered siblings) and the entry that triggers a rotation is never lost;
 *  - a failing trail never changes a dispatch outcome (fail-open), and a
 *    malformed/locked trail never blocks one.
 *
 * Every test runs against the isolated machine coordination dir from
 * `host-dispatch-budget.fixtures.ts`, so nothing touches `~/.herdr/downtime`.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  DISPATCH_BUDGET_LOG_FILE,
  appendBudgetAuditLine,
  budgetAuditRotatedFiles,
  budgetAuditTrailPath,
  readBudgetAuditTrail,
  type BudgetAuditLine,
} from './host-dispatch-budget.audit.js';
import {
  HOST_BUDGET_STALE_WINDOW_MS,
  reap,
  release,
  replaceBudget,
  reserve,
  sweepClosedPanes,
} from './host-dispatch-budget.js';
import { confirmHostDispatch } from './host-dispatch-budget.admission.js';
import { resolveCoordinationLogPolicy } from './downtime-log-storage.js';
import {
  makeBudgetEntry,
  makeLivePaneList,
  seedBudgetLedger,
  withMachineDir,
  writeRawBudgetLedger,
} from './host-dispatch-budget.fixtures.js';

/** Read the trail lines for `dir`. */
function trail(dir: string): BudgetAuditLine[] {
  return readBudgetAuditTrail(dir);
}

/** The ops of the trail lines, in order. */
function ops(dir: string): string[] {
  return trail(dir).map((line) => line.op);
}

beforeAll(() => {
  // The trail shares the coordination-log policy; assert the documented
  // default once so a silent policy drift cannot weaken the bound tests below.
  expect(resolveCoordinationLogPolicy()).toEqual({ maxEntries: 500, maxRotatedFiles: 3 });
});

describe('audit trail path', () => {
  it('lives in the machine coordination dir as dispatch-budget.log', () => {
    expect(DISPATCH_BUDGET_LOG_FILE).toBe('dispatch-budget.log');
    expect(budgetAuditTrailPath('/machine/dir')).toBe('/machine/dir/dispatch-budget.log');
  });
});

describe('one line per mutation', () => {
  it('records a reserve with every required field', async () => {
    await withMachineDir((dir) => {
      const result = reserve(
        {
          kind: 'implement',
          itemId: 'WL-ITEM-1',
          instanceId: 'instance-a',
          root: '/repo/a',
        },
        { dir, actor: 'dispatcher:7', reason: 'unit-test' },
      );
      expect(result.ok).toBe(true);

      const lines = trail(dir);
      expect(lines).toHaveLength(1);
      const [line] = lines;
      expect(line.op).toBe('reserve');
      expect(line.kind).toBe('implement');
      expect(line.itemId).toBe('WL-ITEM-1');
      expect(line.instanceId).toBe('instance-a');
      expect(line.actor).toBe('dispatcher:7');
      expect(line.reason).toBe('unit-test');
      expect(line.liveBefore).toBe(0);
      expect(line.liveAfter).toBe(1);
      expect(Number.isNaN(Date.parse(line.at))).toBe(false);
    });
  });

  it('defaults actor and reason when the caller supplies neither', async () => {
    await withMachineDir((dir) => {
      reserve(
        { kind: 'implement', itemId: 'WL-ITEM-1', instanceId: 'i', root: '/r' },
        { dir },
      );
      const [line] = trail(dir);
      expect(line.actor).toBe(`herdr:${process.pid}`);
      expect(line.reason).toBe('dispatch-reserve');
    });
  });

  it('distinguishes a confirm from a first reservation', async () => {
    await withMachineDir((dir) => {
      reserve(
        { kind: 'implement', itemId: 'WL-ITEM-1', instanceId: 'i', root: '/r' },
        { dir },
      );
      const confirmed = confirmHostDispatch(
        { kind: 'implement', itemId: 'WL-ITEM-1', instanceId: 'i', root: '/r', paneId: 'w1:p2' },
        { dir },
      );
      expect(confirmed).toBe(true);

      expect(ops(dir)).toEqual(['reserve', 'confirm']);
      const [confirm] = trail(dir).slice(1);
      expect(confirm.paneId).toBe('w1:p2');
      expect(confirm.reason).toBe('dispatch-confirm');
      // The upsert preserves one entry, so the count stays at 1.
      expect(confirm.liveBefore).toBe(1);
      expect(confirm.liveAfter).toBe(1);
    });
  });

  it('records a release with the REMOVED entry identity and the caller reason', async () => {
    await withMachineDir((dir) => {
      seedBudgetLedger(dir, [
        makeBudgetEntry({ kind: 'implement', itemId: 'WL-ITEM-1', instanceId: 'owner-9', paneId: 'w9:p9' }),
      ]);
      const result = release(
        { itemId: 'WL-ITEM-1', kind: 'implement', paneId: 'w9:p9' },
        { dir, reason: 'anchor-unavailable', actor: 'herdr:42' },
      );
      expect(result).toMatchObject({ ok: true, removed: true });

      const lines = trail(dir);
      expect(lines).toHaveLength(1);
      const [line] = lines;
      expect(line.op).toBe('release');
      expect(line.kind).toBe('implement');
      expect(line.itemId).toBe('WL-ITEM-1');
      expect(line.paneId).toBe('w9:p9');
      // The OWNING instance, not the releasing one: a deletion is attributed to
      // the entry it destroyed.
      expect(line.instanceId).toBe('owner-9');
      expect(line.actor).toBe('herdr:42');
      expect(line.reason).toBe('anchor-unavailable');
      expect(line.liveBefore).toBe(1);
      expect(line.liveAfter).toBe(0);
    });
  });

  it('records nothing when a release removes nothing (idempotent no-op)', async () => {
    await withMachineDir((dir) => {
      const result = release({ itemId: 'WL-ABSENT', kind: 'implement', paneId: 'p:1' }, { dir });
      expect(result).toMatchObject({ ok: true, removed: false, refused: false });
      expect(trail(dir)).toHaveLength(0);
    });
  });

  it('records one line per reaped entry, naming the entry it removed', async () => {
    await withMachineDir((dir) => {
      const stale = new Date(Date.now() - HOST_BUDGET_STALE_WINDOW_MS - 60_000).toISOString();
      seedBudgetLedger(dir, [
        makeBudgetEntry({ kind: 'implement', itemId: 'WL-STALE-1', paneId: 'p:1', heartbeatAt: stale }),
        makeBudgetEntry({ kind: 'implement', itemId: 'WL-STALE-2', paneId: 'p:2', heartbeatAt: stale }),
        makeBudgetEntry({ kind: 'implement', itemId: 'WL-LIVE', paneId: 'p:3' }),
      ]);
      // A live list that omits both stale panes: they are reaped.
      const result = reap(makeLivePaneList(['WL-LIVE']), { dir, reason: 'sweep-stale' });
      expect(result.ok).toBe(true);

      const lines = trail(dir);
      expect(lines).toHaveLength(2);
      expect(lines.map((line) => line.op)).toEqual(['reap', 'reap']);
      expect(lines.map((line) => line.itemId).sort()).toEqual(['WL-STALE-1', 'WL-STALE-2']);
      for (const line of lines) {
        expect(line.kind).toBe('implement');
        expect(line.reason).toBe('sweep-stale');
        expect(line.liveBefore).toBe(3);
        expect(line.liveAfter).toBe(1);
        expect(line.paneId).toBeDefined();
      }
    });
  });

  it('records one line per swept confirmed entry', async () => {
    await withMachineDir((dir) => {
      seedBudgetLedger(dir, [
        makeBudgetEntry({ kind: 'implement', itemId: 'WL-CONFIRMED', paneId: 'p:dead' }),
        makeBudgetEntry({ kind: 'implement', itemId: 'WL-OTHER', paneId: 'p:alive' }),
      ]);
      const result = sweepClosedPanes(
        makeLivePaneList([{ paneId: 'p:alive', itemId: 'WL-OTHER' }]),
        { dir },
      );
      expect(result.ok).toBe(true);

      const lines = trail(dir);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        op: 'sweep',
        kind: 'implement',
        itemId: 'WL-CONFIRMED',
        paneId: 'p:dead',
        reason: 'sweep-closed-pane',
        liveBefore: 2,
        liveAfter: 1,
      });
    });
  });

  it('records a repair as one whole-document line with unknown before-count', async () => {
    await withMachineDir((dir) => {
      writeRawBudgetLedger(dir, 'not json at all');
      const result = replaceBudget([], { dir, reason: 'repair-from-live-panes' });
      expect(result.ok).toBe(true);

      const lines = trail(dir);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        op: 'repair',
        kind: 'all',
        itemId: '',
        reason: 'repair-from-live-panes',
        liveBefore: -1,
        liveAfter: 0,
      });
    });
  });

  it('records nothing for an idle reap (not a mutation)', async () => {
    await withMachineDir((dir) => {
      seedBudgetLedger(dir, [
        makeBudgetEntry({ kind: 'implement', itemId: 'WL-LIVE', paneId: 'p:alive' }),
      ]);
      reap(makeLivePaneList([{ paneId: 'p:alive', itemId: 'WL-LIVE' }]), { dir });
      expect(trail(dir)).toHaveLength(0);
    });
  });
});

describe('rotation and retention', () => {
  it('bounds the file at the per-file cap and keeps numbered siblings', async () => {
    await withMachineDir((dir) => {
      const policy = resolveCoordinationLogPolicy({ maxEntries: 10, maxRotatedFiles: 2 });
      expect(policy).toEqual({ maxEntries: 10, maxRotatedFiles: 2 });
      const base: BudgetAuditLine = {
        at: new Date(0).toISOString(),
        op: 'reserve',
        kind: 'implement',
        itemId: '',
        instanceId: 'i',
        reason: 'rotation-test',
        actor: 'a',
        liveBefore: 0,
        liveAfter: 1,
      };
      // 35 appends over a 10-line cap with 2 kept siblings: 25 rotations, so
      // exactly three files of evidence survive (indices 10..34) and the older
      // 10 lines are dropped — bounded disk.
      for (let i = 0; i < 35; i++) {
        const result = appendBudgetAuditLine(dir, { ...base, itemId: `WL-ROTATE-${i}` }, policy);
        expect(result.ok).toBe(true);
      }

      const current = readBudgetAuditTrail(dir).map((line) => line.itemId);
      expect(current).toEqual(['WL-ROTATE-30', 'WL-ROTATE-31', 'WL-ROTATE-32', 'WL-ROTATE-33', 'WL-ROTATE-34']);

      const rotated = budgetAuditRotatedFiles(dir);
      expect(rotated).toEqual([`${DISPATCH_BUDGET_LOG_FILE}.1`, `${DISPATCH_BUDGET_LOG_FILE}.2`]);

      const readSibling = (suffix: string): string[] =>
        readFileSync(join(dir, `${DISPATCH_BUDGET_LOG_FILE}${suffix}`), 'utf8')
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map((line) => (JSON.parse(line) as BudgetAuditLine).itemId);

      // `.1` is the NEWEST rotated file: indices 20..29. `.2` holds 10..19.
      expect(readSibling('.1')).toEqual(
        Array.from({ length: 10 }, (_, i) => `WL-ROTATE-${20 + i}`),
      );
      expect(readSibling('.2')).toEqual(
        Array.from({ length: 10 }, (_, i) => `WL-ROTATE-${10 + i}`),
      );

      // Bounded disk: at most (maxEntries x (1 + maxRotatedFiles)) lines, and
      // the entries older than the bound are gone.
      const total = current.length + 20;
      expect(total).toBeLessThanOrEqual(10 * (1 + 2));
      expect(total).toBe(25);
    });
  });

  it('never loses the entry that triggers a rotation', async () => {
    await withMachineDir((dir) => {
      // maxEntries is clamped to the coordination-log floor (10).
      const policy = resolveCoordinationLogPolicy({ maxEntries: 10, maxRotatedFiles: 1 });
      expect(policy).toEqual({ maxEntries: 10, maxRotatedFiles: 1 });
      const base: BudgetAuditLine = {
        at: new Date(0).toISOString(),
        op: 'release',
        kind: 'implement',
        itemId: '',
        instanceId: 'i',
        reason: 'rotation-test',
        actor: 'a',
        liveBefore: 1,
        liveAfter: 0,
      };
      for (let i = 0; i < 12; i++) {
        appendBudgetAuditLine(dir, { ...base, itemId: `WL-R-${i}` }, policy);
      }

      // The 11th append rotated the first 10 lines aside; the current file then
      // holds the two newest.
      expect(readBudgetAuditTrail(dir).map((line) => line.itemId)).toEqual([
        'WL-R-10',
        'WL-R-11',
      ]);
      const rotated = readFileSync(join(dir, `${DISPATCH_BUDGET_LOG_FILE}.1`), 'utf8');
      expect(rotated).toContain('WL-R-0');
      expect(rotated).toContain('WL-R-9');
    });
  });
});

describe('fail-open — a broken trail never changes a dispatch outcome', () => {
  it('reserve succeeds when the trail path is a directory (write fails)', async () => {
    await withMachineDir((dir) => {
      // A directory where the trail file should be: every write attempt fails.
      mkdirSync(join(dir, DISPATCH_BUDGET_LOG_FILE), { recursive: true });

      const result = reserve(
        { kind: 'implement', itemId: 'WL-ITEM-1', instanceId: 'i', root: '/r' },
        { dir },
      );
      expect(result.ok).toBe(true);
      // The ledger write still happened: the trail is not a gate.
      const ledger = readFileSync(join(dir, 'dispatch-budget.json'), 'utf8');
      expect(ledger).toContain('WL-ITEM-1');
    });
  });

  it('release succeeds when the trail path is a directory', async () => {
    await withMachineDir((dir) => {
      seedBudgetLedger(dir, [
        makeBudgetEntry({ itemId: 'WL-ITEM-1', paneId: 'w9:p9' }),
      ]);
      mkdirSync(join(dir, DISPATCH_BUDGET_LOG_FILE), { recursive: true });
      expect(
        release({ itemId: 'WL-ITEM-1', kind: 'implement', paneId: 'w9:p9' }, { dir }),
      ).toMatchObject({ ok: true, removed: true });
    });
  });

  it('tolerates a malformed existing trail line and appends after it', async () => {
    await withMachineDir((dir) => {
      writeFileSync(join(dir, DISPATCH_BUDGET_LOG_FILE), '{ this is not json }\n', 'utf8');
      const result = appendBudgetAuditLine(dir, {
        at: new Date().toISOString(),
        op: 'reserve',
        kind: 'implement',
        itemId: 'WL-AFTER-GARBAGE',
        instanceId: 'i',
        reason: 'malformed-tail',
        actor: 'a',
        liveBefore: 0,
        liveAfter: 1,
      });
      expect(result.ok).toBe(true);
      // The reader skips the malformed line and still sees the new one.
      expect(readBudgetAuditTrail(dir).map((line) => line.itemId)).toEqual([
        'WL-AFTER-GARBAGE',
      ]);
    });
  });

  it('reports an io-error instead of throwing when the dir is not writable', async () => {
    await withMachineDir((dir) => {
      // A path whose parent is a FILE cannot be created as a directory.
      const blockedParent = join(dir, 'blocked');
      writeFileSync(blockedParent, 'x', 'utf8');
      const result = appendBudgetAuditLine(join(blockedParent, 'nested'), {
        at: new Date().toISOString(),
        op: 'reserve',
        kind: 'implement',
        itemId: 'WL-X',
        instanceId: 'i',
        reason: 'io-error-test',
        actor: 'a',
        liveBefore: 0,
        liveAfter: 1,
      });
      expect(result).toEqual({ ok: false, reason: 'io-error' });
    });
  });
});
