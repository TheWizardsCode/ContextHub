/**
 * packages/herdr/src/host-dispatch-budget.identity.test.ts — release identity
 * (WL-0MWFJD5T4003OM91, parent WL-0MWFJD1RV008FCCR).
 *
 * `release(itemId)` was the only release primitive, keyed on the item id alone.
 * Any aborted dispatch attempt, any audit/implement collision and any sibling
 * pane close for the same item therefore deleted *any* entry for that item —
 * including a still-running dispatch's. On 2026-11-13 six confirmed, live
 * implement entries had vanished this way.
 *
 * This suite pins the replacement contract:
 *
 *  - the entry key is `(itemId, kind)`, so an implement and an audit dispatch of
 *    one item coexist and neither release/confirm touches the other;
 *  - a release must prove ownership with the attempt token `reserve` minted (or
 *    the confirmed pane id); a different attempt/kind/pane is REFUSED and the
 *    entry survives;
 *  - a release that proves nothing is refused (`incomplete-identity`);
 *  - a missing entry is still a successful no-op, and nothing throws.
 *
 * Pure-ledger tests live here; the four dispatch-pipeline abort paths get their
 * own survival tests in `downtime-worker.dispatch-budget-identity.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import {
  readBudget,
  release,
  reserve,
  type HostBudgetEntry,
} from './host-dispatch-budget.js';
import { confirmHostDispatch } from './host-dispatch-budget.admission.js';
import { withMachineDir } from './host-dispatch-budget.fixtures.js';

/** Reserve one entry and return it (failing the test when reservation fails). */
function reserveEntry(
  dir: string,
  input: { kind: 'implement' | 'audit'; itemId: string; paneId?: string },
): HostBudgetEntry {
  const result = reserve(
    {
      kind: input.kind,
      itemId: input.itemId,
      instanceId: `instance-${input.kind}`,
      root: '/repo/test',
      ...(input.paneId !== undefined ? { paneId: input.paneId } : {}),
    },
    { dir },
  );
  if (!result.ok) throw new Error(`reserve failed: ${result.reason}`);
  return result.entry;
}

/** The stored entries, for "what survived" assertions. */
function entries(dir: string): HostBudgetEntry[] {
  const read = readBudget({ dir });
  if (!read.ok) throw new Error(`ledger unreadable: ${read.reason}`);
  return read.ledger.entries;
}

describe('entry key is (itemId, kind)', () => {
  it('keeps an implement and an audit dispatch of the same item as two entries', async () => {
    await withMachineDir((dir) => {
      reserveEntry(dir, { kind: 'implement', itemId: 'WL-BOTH', paneId: 'p:impl' });
      reserveEntry(dir, { kind: 'audit', itemId: 'WL-BOTH', paneId: 'p:audit' });

      expect(entries(dir)).toHaveLength(2);
      expect(entries(dir).map((entry) => entry.kind).sort()).toEqual(['audit', 'implement']);
    });
  });

  it('a confirm on one kind never touches the other kind', async () => {
    await withMachineDir((dir) => {
      reserveEntry(dir, { kind: 'implement', itemId: 'WL-BOTH', paneId: 'p:impl' });
      reserveEntry(dir, { kind: 'audit', itemId: 'WL-BOTH' });

      expect(
        confirmHostDispatch(
          { kind: 'audit', itemId: 'WL-BOTH', instanceId: 'i', root: '/r', paneId: 'p:audit' },
          { dir },
        ),
      ).toBe(true);

      const byKind = Object.fromEntries(entries(dir).map((e) => [e.kind, e]));
      expect(byKind.implement?.paneId).toBe('p:impl');
      expect(byKind.audit?.paneId).toBe('p:audit');
    });
  });

  it('releasing one kind leaves the other kind intact', async () => {
    await withMachineDir((dir) => {
      const impl = reserveEntry(dir, { kind: 'implement', itemId: 'WL-BOTH', paneId: 'p:impl' });
      reserveEntry(dir, { kind: 'audit', itemId: 'WL-BOTH', paneId: 'p:audit' });

      const result = release(
        { itemId: 'WL-BOTH', kind: 'implement', attemptId: impl.attemptId },
        { dir },
      );
      expect(result).toMatchObject({ ok: true, removed: true, refused: false });

      expect(entries(dir).map((entry) => entry.kind)).toEqual(['audit']);
    });
  });
});

describe('release proves ownership', () => {
  it('removes the entry when the attempt token matches', async () => {
    await withMachineDir((dir) => {
      const entry = reserveEntry(dir, { kind: 'implement', itemId: 'WL-A' });
      const result = release({ itemId: 'WL-A', kind: 'implement', attemptId: entry.attemptId }, { dir });
      expect(result).toMatchObject({ ok: true, removed: true, refused: false });
      expect(entries(dir)).toEqual([]);
    });
  });

  it('REFUSES a release carrying a different attempt token and keeps the entry', async () => {
    await withMachineDir((dir) => {
      reserveEntry(dir, { kind: 'implement', itemId: 'WL-A', paneId: 'p:live' });

      const result = release(
        { itemId: 'WL-A', kind: 'implement', attemptId: 'att-someone-else' },
        { dir },
      );
      expect(result).toEqual({
        ok: true,
        removed: false,
        refused: true,
        reason: 'identity-mismatch',
      });
      // The still-running dispatch keeps its slot.
      expect(entries(dir)).toHaveLength(1);
      expect(entries(dir)[0].paneId).toBe('p:live');
    });
  });

  it('REFUSES a release carrying a different pane id and keeps the entry', async () => {
    await withMachineDir((dir) => {
      reserveEntry(dir, { kind: 'implement', itemId: 'WL-A', paneId: 'p:live' });
      const result = release(
        { itemId: 'WL-A', kind: 'implement', paneId: 'p:sibling' },
        { dir },
      );
      expect(result).toMatchObject({ refused: true, reason: 'identity-mismatch', removed: false });
      expect(entries(dir)).toHaveLength(1);
    });
  });

  it('removes the entry when the pane id matches (pane-close path)', async () => {
    await withMachineDir((dir) => {
      reserveEntry(dir, { kind: 'implement', itemId: 'WL-A', paneId: 'p:live' });
      // The pane-close path knows the pane but not the tier: kind omitted.
      const result = release({ itemId: 'WL-A', paneId: 'p:live' }, { dir });
      expect(result).toMatchObject({ ok: true, removed: true, refused: false });
      expect(entries(dir)).toEqual([]);
    });
  });

  it('REFUSES an identity-less release (the item-id-keyed primitive is gone)', async () => {
    await withMachineDir((dir) => {
      reserveEntry(dir, { kind: 'implement', itemId: 'WL-A', paneId: 'p:live' });
      const result = release({ itemId: 'WL-A', kind: 'implement' }, { dir });
      expect(result).toEqual({
        ok: true,
        removed: false,
        refused: true,
        reason: 'incomplete-identity',
      });
      expect(entries(dir)).toHaveLength(1);
    });
  });

  it('a missing entry is still an idempotent no-op (no refusal noise)', async () => {
    await withMachineDir((dir) => {
      const result = release({ itemId: 'WL-ABSENT', kind: 'implement', paneId: 'p:1' }, { dir });
      expect(result).toEqual({ ok: true, removed: false, refused: false });
    });
  });

  it('never throws, whatever the identity', async () => {
    await withMachineDir((dir) => {
      expect(() =>
        release({ itemId: '', kind: 'implement', paneId: 'p:1' }, { dir }),
      ).not.toThrow();
      expect(() =>
        release({ itemId: 'WL-A', kind: 'audit', attemptId: 'nope' }, { dir }),
      ).not.toThrow();
    });
  });
});

describe('attempt identity lifecycle', () => {
  it('mints a distinct token per reservation and preserves it across a confirm', async () => {
    await withMachineDir((dir) => {
      const first = reserveEntry(dir, { kind: 'implement', itemId: 'WL-A' });
      expect(typeof first.attemptId).toBe('string');

      confirmHostDispatch(
        { kind: 'implement', itemId: 'WL-A', instanceId: 'i', root: '/r', paneId: 'p:1' },
        { dir },
      );
      const afterConfirm = entries(dir)[0];
      // A confirm is the SAME attempt writing its pane back: the identity the
      // caller holds must still be valid afterwards.
      expect(afterConfirm.attemptId).toBe(first.attemptId);
      expect(afterConfirm.paneId).toBe('p:1');

      // A fresh reservation (a new attempt) mints a new token, so the previous
      // attempt's identity can no longer remove the entry.
      const second = reserveEntry(dir, { kind: 'implement', itemId: 'WL-B' });
      expect(second.attemptId).not.toBe(first.attemptId);
    });
  });

  it('refuses a reservation that presents a conflicting attempt token', async () => {
    await withMachineDir((dir) => {
      reserveEntry(dir, { kind: 'implement', itemId: 'WL-A' });
      const result = reserve(
        {
          kind: 'implement',
          itemId: 'WL-A',
          instanceId: 'i',
          root: '/r',
          attemptId: 'att-not-the-owner',
        },
        { dir },
      );
      expect(result).toEqual({ ok: false, unknown: false, reason: 'identity-mismatch' });
      expect(entries(dir)).toHaveLength(1);
    });
  });
});
