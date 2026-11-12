/**
 * packages/herdr/src/host-dispatch-budget.interactive.test.ts — the USER-FIRED
 * dispatch gate for the host budget (WL-0MVXY0Z93002HKCZ F4, parent
 * WL-0MVXWQFGV000D2AB).
 *
 * F4's acceptance criteria, exercised against the F0 machine-budget fixture
 * (an isolated machine coordination dir, so no test ever touches
 * `~/.herdr/downtime`):
 *
 *  - AC2  at/over cap ⇒ prompt; below quota ⇒ no prompt, no extra keypress;
 *  - AC4  the prompt quotes live/max and the correct overshoot;
 *  - AC6  cancel ⇒ NO claim, NO pane spawn, NO ledger entry;
 *  - AC7  proceed ⇒ the claim/spawn proceeds and the ledger entry records
 *         `override: { by: 'user' }`;
 *  - AC8  an unreadable ledger fails OPEN with a visible notice and the
 *         dispatch still proceeds;
 *  - AC9  both agent branches (interactive pane and headless
 *         `open_pane: false`) — the gate runs once, before the branch, so
 *         cancel/proceed behave identically and neither can spawn on cancel.
 *
 * Run: npx vitest run packages/herdr/src/host-dispatch-budget.interactive.test.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  HOST_BUDGET_UNREADABLE_NOTICE,
  budgetKindForAgentCommand,
  prepareInteractiveAgentDispatch,
  type InteractiveAgentDispatchDeps,
} from './host-dispatch-budget.interactive.js';
import {
  HOST_BUDGET_STALE_WINDOW_MS,
  freshCount,
  type HostBudgetLivePanesResult,
} from './host-dispatch-budget.js';
import { readHostBudgetStatus } from './host-budget-status.js';
import {
  formatHostBudgetHeadline,
  type HostBudgetDialogChoice,
  type HostBudgetPromptRequest,
} from './host-budget-dialog.js';
import { HOST_BUDGET_CONFIG_FILE } from './host-dispatch-budget.js';
import {
  budgetLedgerPath,
  makeBudgetEntry,
  makeLivePaneList,
  readBudgetLedger,
  seedBudgetLedger,
  withMachineDir,
  writeBudgetLedger,
  writeRawBudgetLedger,
  type FakeBudgetEntry,
  type FakePaneSpec,
} from './host-dispatch-budget.fixtures.js';

const IMPLEMENT_CMD = '/skill:implement WL-0000000000000001';
const AUDIT_CMD = '/skill:audit WL-0000000000000001';

/**
 * Wrap a pane list as the tri-state `ok:true` read — the production shape of
 * a successful `hostBudgetLivePanes` (WL-0MW9VQX5T001GCUP). Pane specs are
 * passed through to {@link makeLivePaneList} directly.
 */
function okPanes(...specs: FakePaneSpec[]): HostBudgetLivePanesResult {
  return { ok: true, panes: makeLivePaneList(specs) };
}

/** A failed pane read: pane liveness is UNKNOWN, never "no panes". */
const unknownPanes: HostBudgetLivePanesResult = { ok: false };

/** Write `budget.json` into the isolated machine dir. */
function writeBudgetConfig(dir: string, config: { maxImplement?: number; maxAudit?: number }): void {
  writeFileSync(join(dir, HOST_BUDGET_CONFIG_FILE), JSON.stringify(config), 'utf8');
}

/** A fresh deps bundle; each seam is a spy so call counts are assertions. */
function makeDeps(
  dir: string,
  overrides: Partial<InteractiveAgentDispatchDeps> = {},
): {
  deps: InteractiveAgentDispatchDeps;
  confirm: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  claim: ReturnType<typeof vi.fn>;
} {
  const confirm = vi.fn<(request: HostBudgetPromptRequest) => Promise<HostBudgetDialogChoice>>(
    async () => 'cancel',
  );
  const notify = vi.fn();
  const claim = vi.fn(async () => {});
  const deps: InteractiveAgentDispatchDeps = {
    confirm,
    notify,
    claim,
    readLivePanes: async () => okPanes(),
    root: '/repo/test',
    instanceId: 'instance-1',
    budget: { dir },
    ...overrides,
  };
  return { deps, confirm, notify, claim };
}

// ── Command → tier mapping ────────────────────────────────────────────

describe('budgetKindForAgentCommand', () => {
  it('maps the implement family to the implement tier', () => {
    expect(budgetKindForAgentCommand('/skill:implement WL-1')).toBe('implement');
    expect(budgetKindForAgentCommand('/skill:implement-single WL-1')).toBe('implement');
    expect(budgetKindForAgentCommand('/skill:implementall WL-1')).toBe('implement');
  });

  it('maps /skill:audit to the audit tier', () => {
    expect(budgetKindForAgentCommand('/skill:audit WL-1')).toBe('audit');
  });

  it('returns undefined for commands outside the budget', () => {
    expect(budgetKindForAgentCommand('/skill:plan WL-1')).toBeUndefined();
    expect(budgetKindForAgentCommand('/intake WL-1')).toBeUndefined();
    expect(budgetKindForAgentCommand('!!wl update WL-1')).toBeUndefined();
    expect(budgetKindForAgentCommand('')).toBeUndefined();
  });
});

// ── Below quota: no prompt, no extra keypress (AC2) ────────────────────

describe('under quota (AC2)', () => {
  it('dispatches without a dialog and records the ledger entry', async () => {
    await withMachineDir(async (dir) => {
      writeBudgetConfig(dir, { maxImplement: 2 });
      const { deps, confirm, claim } = makeDeps(dir);

      const result = await prepareInteractiveAgentDispatch(IMPLEMENT_CMD, deps);

      expect(result.proceed).toBe(true);
      expect(result.override).toBeUndefined();
      expect(confirm).not.toHaveBeenCalled();
      expect(claim).toHaveBeenCalledTimes(1);
      expect(claim).toHaveBeenCalledWith(IMPLEMENT_CMD);

      const ledger = readBudgetLedger(dir);
      expect(ledger?.entries).toHaveLength(1);
      expect(ledger?.entries[0].kind).toBe('implement');
      expect(ledger?.entries[0].itemId).toBe('WL-0000000000000001');
      expect(ledger?.entries[0].override).toBeUndefined();
    });
  });

  it('counts live implement panes only (a pane-less entry does not reach the cap)', async () => {
    await withMachineDir(async (dir) => {
      writeBudgetConfig(dir, { maxImplement: 2 });
      // Two fresh entries, but only ONE has a pane in the live list.
      const entries: FakeBudgetEntry[] = [
        makeBudgetEntry({ itemId: 'WL-OTHER-1', paneId: 'pane-1' }),
        makeBudgetEntry({ itemId: 'WL-OTHER-2', paneId: 'pane-gone' }),
      ];
      writeBudgetLedger(dir, entries);
      const { deps, confirm } = makeDeps(dir, {
        readLivePanes: async () => okPanes('WL-OTHER-1'),
      });

      const result = await prepareInteractiveAgentDispatch(IMPLEMENT_CMD, deps);

      expect(result.proceed).toBe(true);
      expect(confirm).not.toHaveBeenCalled();
    });
  });

  it('does not prompt for a command outside the budget, and still claims', async () => {
    await withMachineDir(async (dir) => {
      writeBudgetConfig(dir, { maxImplement: 0 });
      const { deps, confirm, claim } = makeDeps(dir);

      const result = await prepareInteractiveAgentDispatch('/skill:plan WL-0000000000000001', deps);

      expect(result.proceed).toBe(true);
      expect(result.reserved).toBe(false);
      expect(confirm).not.toHaveBeenCalled();
      expect(claim).toHaveBeenCalledTimes(1);
      expect(readBudgetLedger(dir)).toBeNull();
    });
  });

  it('proceeds silently when the coordination dir is unresolvable (parent AC11)', async () => {
    const { deps, confirm, notify, claim } = makeDeps('/unused', { budget: { dir: null } });

    const result = await prepareInteractiveAgentDispatch(IMPLEMENT_CMD, deps);

    expect(result.proceed).toBe(true);
    expect(result.reserved).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(claim).toHaveBeenCalledTimes(1);
  });
});

// ── At/over cap: the dialog decides (AC4/AC6/AC7) ─────────────────────

describe('at cap (AC4/AC6/AC7)', () => {
  /** Seed the machine dir at the implement cap: 2 live panes, max 2. */
  function seedAtCap(dir: string): void {
    writeBudgetConfig(dir, { maxImplement: 2 });
    writeBudgetLedger(dir, [
      makeBudgetEntry({ itemId: 'WL-OTHER-1', paneId: 'pane-1' }),
      makeBudgetEntry({ itemId: 'WL-OTHER-2', paneId: 'pane-2' }),
    ]);
  }

  it('asks with the live count, the cap and the tier', async () => {
    await withMachineDir(async (dir) => {
      seedAtCap(dir);
      const { deps, confirm } = makeDeps(dir, {
        readLivePanes: async () => okPanes('WL-OTHER-1', 'WL-OTHER-2'),
      });
      confirm.mockResolvedValueOnce('cancel');

      await prepareInteractiveAgentDispatch(IMPLEMENT_CMD, deps);

      expect(confirm).toHaveBeenCalledTimes(1);
      const request = confirm.mock.calls[0][0];
      expect(request).toEqual({ kind: 'implement', live: 2, max: 2 });
      // The copy the dialog renders: at cap ⇒ over by 1.
      expect(formatHostBudgetHeadline(request)).toBe(
        'Implement dispatch would exceed the host quota (2 running, max 2) — over by 1.',
      );
    });
  });

  it('quotes n + 1 when the tier is already n over cap', async () => {
    await withMachineDir(async (dir) => {
      writeBudgetConfig(dir, { maxImplement: 2 });
      writeBudgetLedger(dir, [
        makeBudgetEntry({ itemId: 'WL-OTHER-1', paneId: 'pane-1' }),
        makeBudgetEntry({ itemId: 'WL-OTHER-2', paneId: 'pane-2' }),
        makeBudgetEntry({ itemId: 'WL-OTHER-3', paneId: 'pane-3' }),
      ]);
      const { deps, confirm } = makeDeps(dir, {
        readLivePanes: async () =>
          okPanes('WL-OTHER-1', 'WL-OTHER-2', 'WL-OTHER-3'),
      });

      await prepareInteractiveAgentDispatch(IMPLEMENT_CMD, deps);

      const request = confirm.mock.calls[0][0];
      expect(request).toEqual({ kind: 'implement', live: 3, max: 2 });
      expect(formatHostBudgetHeadline(request)).toContain('(3 running, max 2) — over by 2.');
    });
  });

  it('cancel ⇒ no claim and no ledger entry (AC6)', async () => {
    await withMachineDir(async (dir) => {
      seedAtCap(dir);
      const before = readBudgetLedger(dir);
      const { deps, confirm, claim } = makeDeps(dir, {
        readLivePanes: async () => okPanes('WL-OTHER-1', 'WL-OTHER-2'),
      });
      confirm.mockResolvedValueOnce('cancel');

      const result = await prepareInteractiveAgentDispatch(IMPLEMENT_CMD, deps);

      expect(result.proceed).toBe(false);
      expect(claim).not.toHaveBeenCalled();
      expect(readBudgetLedger(dir)).toEqual(before);
      expect(readBudgetLedger(dir)?.entries).toHaveLength(2);
    });
  });

  it('proceed ⇒ claims and records `override: { by: "user" }` (AC7)', async () => {
    await withMachineDir(async (dir) => {
      seedAtCap(dir);
      const { deps, confirm, claim } = makeDeps(dir, {
        readLivePanes: async () => okPanes('WL-OTHER-1', 'WL-OTHER-2'),
      });
      confirm.mockResolvedValueOnce('proceed');

      const result = await prepareInteractiveAgentDispatch(IMPLEMENT_CMD, deps);

      expect(result.proceed).toBe(true);
      expect(result.override).toEqual({ by: 'user' });
      expect(claim).toHaveBeenCalledTimes(1);

      const ledger = readBudgetLedger(dir);
      const entry = ledger?.entries.find((candidate) => candidate.itemId === 'WL-0000000000000001');
      expect(entry?.override).toEqual({ by: 'user' });
      expect(entry?.kind).toBe('implement');
      // The existing dispatcher entries survive the reservation.
      expect(ledger?.entries).toHaveLength(3);
    });
  });

  it('a disabled tier prompts with 0/0 evidence and can be overridden', async () => {
    await withMachineDir(async (dir) => {
      writeBudgetConfig(dir, { maxAudit: 0 });
      const { deps, confirm } = makeDeps(dir);
      confirm.mockResolvedValueOnce('cancel');

      await prepareInteractiveAgentDispatch(AUDIT_CMD, deps);

      expect(confirm.mock.calls[0][0]).toEqual({ kind: 'audit', live: 0, max: 0 });
      expect(formatHostBudgetHeadline(confirm.mock.calls[0][0])).toContain(
        'Audit dispatch would exceed the host quota (0 running, max 0) — over by 1.',
      );
    });
  });

  it('counts the audit tier without requiring a live pane (marker semantics)', async () => {
    await withMachineDir(async (dir) => {
      writeBudgetConfig(dir, { maxAudit: 1 });
      // A fresh audit entry with NO pane: the audit tier still counts it.
      seedBudgetLedger(dir, [makeBudgetEntry({ kind: 'audit', itemId: 'WL-OTHER-9' })]);
      const { deps, confirm } = makeDeps(dir);

      await prepareInteractiveAgentDispatch(AUDIT_CMD, deps);

      expect(confirm).toHaveBeenCalledTimes(1);
      expect(confirm.mock.calls[0][0]).toEqual({ kind: 'audit', live: 1, max: 1 });
    });
  });
});

// ── Fail-open on an unreadable ledger (AC8) ────────────────────────────

describe('unreadable ledger (AC8)', () => {
  it('fails open with a visible notice and still dispatches', async () => {
    await withMachineDir(async (dir) => {
      writeBudgetConfig(dir, { maxImplement: 2 });
      const corrupt = writeRawBudgetLedger(dir, '{ not json');
      const before = readBudgetLedger(dir);
      const { deps, confirm, notify, claim } = makeDeps(dir);

      const result = await prepareInteractiveAgentDispatch(IMPLEMENT_CMD, deps);

      expect(result.proceed).toBe(true);
      expect(result.notice).toBe(HOST_BUDGET_UNREADABLE_NOTICE);
      expect(confirm).not.toHaveBeenCalled();
      expect(claim).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(HOST_BUDGET_UNREADABLE_NOTICE);
      // The corrupt bytes are left untouched — this path never rewrites a
      // ledger it cannot trust (the dispatcher's repair path owns that).
      expect(readBudgetLedger(dir)).toEqual(before);
      expect(corrupt).toBe(budgetLedgerPath(dir));
    });
  });

  /**
   * AC8 ("missing/unreadable"): a MISSING ledger file is the documented
   * first-run state — `host-dispatch-budget.ts` reads it as an EMPTY ledger —
   * so nothing is blocked and no notice is needed; the dispatch records its
   * entry (creating the file). Only a ledger that EXISTS but cannot be trusted
   * produces the fail-open notice above.
   */
  it('a missing ledger file is an empty ledger: proceeds, records, no notice', async () => {
    await withMachineDir(async (dir) => {
      writeBudgetConfig(dir, { maxImplement: 2 });
      expect(readBudgetLedger(dir)).toBeNull();
      const { deps, confirm, notify, claim } = makeDeps(dir);

      const result = await prepareInteractiveAgentDispatch(IMPLEMENT_CMD, deps);

      expect(result.proceed).toBe(true);
      expect(result.reserved).toBe(true);
      expect(confirm).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
      expect(claim).toHaveBeenCalledTimes(1);
      expect(readBudgetLedger(dir)?.entries).toHaveLength(1);
    });
  });

  it('the notice names the ledger and the skipped check', () => {
    expect(HOST_BUDGET_UNREADABLE_NOTICE).toContain('unreadable');
    expect(HOST_BUDGET_UNREADABLE_NOTICE).toContain('quota check');
  });
});

// ── Audit tier dialog uses pane-aware display count (WL-0MW8IQNY7003JIOL) ──
//
// The interactive over-quota dialog for the audit tier must quote the same
// pane-aware display count the worklist header shows (`reduceAuditDisplayCounts`),
// not the admission-compatible count (`freshCount` / `reduceMarkerCounts`), so
// the two operator-facing surfaces never disagree.

describe('audit dialog pane-aware count (WL-0MW8IQNY7003JIOL)', () => {
  /** A stale heartbeat (older than the 2 h staleness window). */
  function staleHeartbeat(): string {
    return new Date(Date.now() - HOST_BUDGET_STALE_WINDOW_MS - 1000).toISOString();
  }

  it('does not prompt for a dead (confirmed, pane-gone) audit entry', async () => {
    await withMachineDir(async (dir) => {
      writeBudgetConfig(dir, { maxAudit: 1 });
      // One confirmed audit whose pane is NOT in the live pane list.
      seedBudgetLedger(dir, [
        makeBudgetEntry({ kind: 'audit', itemId: 'WL-DEAD-1', paneId: 'pane-gone' }),
      ]);
      const { deps, confirm } = makeDeps(dir, {
        readLivePanes: async () => okPanes(),
      });

      // Before the dispatch the dead entry is excluded from the display count.
      const header = readHostBudgetStatus({ dir, livePanes: [] });
      expect(header?.audit).toEqual({ live: 0, max: 1 });

      // Admission is untouched: `freshCount` (marker-compatible, fail-closed)
      // still counts the dead entry — the divergence is display-only.
      const admission = freshCount('audit', { dir });
      expect(admission.ok && admission.count).toBe(1);

      const result = await prepareInteractiveAgentDispatch(AUDIT_CMD, deps);

      // Display count is 0 (dead entry excluded) ⇒ below cap ⇒ no prompt.
      expect(result.proceed).toBe(true);
      expect(confirm).not.toHaveBeenCalled();
    });
  });

  it('prompts for a live audit entry (pane is in the live pane list)', async () => {
    await withMachineDir(async (dir) => {
      writeBudgetConfig(dir, { maxAudit: 1 });
      seedBudgetLedger(dir, [
        makeBudgetEntry({ kind: 'audit', itemId: 'WL-LIVE-1', paneId: 'pane-1' }),
      ]);
      const { deps, confirm } = makeDeps(dir, {
        readLivePanes: async () => okPanes('WL-LIVE-1'),
      });

      await prepareInteractiveAgentDispatch(AUDIT_CMD, deps);

      // At cap ⇒ it PROMPTS with the same count the header shows.
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(confirm.mock.calls[0][0]).toEqual({ kind: 'audit', live: 1, max: 1 });
      const header = readHostBudgetStatus({
        dir,
        livePanes: makeLivePaneList(['WL-LIVE-1']),
      });
      expect(header?.audit).toEqual({ live: 1, max: 1 });
    });
  });

  it('prompts for an unconfirmed audit entry (no paneId — reserve→spawn window)', async () => {
    await withMachineDir(async (dir) => {
      writeBudgetConfig(dir, { maxAudit: 1 });
      // No paneId yet: the display rule still counts a fresh unconfirmed entry.
      seedBudgetLedger(dir, [makeBudgetEntry({ kind: 'audit', itemId: 'WL-UNCONF-1' })]);
      const { deps, confirm } = makeDeps(dir, {
        readLivePanes: async () => okPanes(),
      });

      await prepareInteractiveAgentDispatch(AUDIT_CMD, deps);

      expect(confirm).toHaveBeenCalledTimes(1);
      expect(confirm.mock.calls[0][0]).toEqual({ kind: 'audit', live: 1, max: 1 });
    });
  });

  it('does not prompt for a stale audit entry', async () => {
    await withMachineDir(async (dir) => {
      writeBudgetConfig(dir, { maxAudit: 1 });
      seedBudgetLedger(dir, [
        makeBudgetEntry({
          kind: 'audit',
          itemId: 'WL-STALE-1',
          paneId: 'pane-1',
          heartbeatAt: staleHeartbeat(),
        }),
      ]);
      const { deps, confirm } = makeDeps(dir, {
        readLivePanes: async () => okPanes('WL-STALE-1'),
      });

      const result = await prepareInteractiveAgentDispatch(AUDIT_CMD, deps);

      expect(result.proceed).toBe(true);
      expect(confirm).not.toHaveBeenCalled();
      // The display read is read-only: the stale entry is excluded from the
      // count but NOT reaped/rewritten by the dialog path.
      const entries = readBudgetLedger(dir)?.entries ?? [];
      expect(entries.some((e) => e.itemId === 'WL-STALE-1')).toBe(true);
    });
  });

  it('the dialog live count equals the header audit count for mixed entries', async () => {
    await withMachineDir(async (dir) => {
      writeBudgetConfig(dir, { maxAudit: 2 });
      // Three entries: one live (counted), one dead (excluded), one unconfirmed
      // (counted) ⇒ display count 2, admission count 3.
      seedBudgetLedger(dir, [
        makeBudgetEntry({ kind: 'audit', itemId: 'WL-MIX-LIVE', paneId: 'pane-live' }),
        makeBudgetEntry({ kind: 'audit', itemId: 'WL-MIX-DEAD', paneId: 'pane-dead' }),
        makeBudgetEntry({ kind: 'audit', itemId: 'WL-MIX-UNCONF' }),
      ]);
      const livePanes = makeLivePaneList([
        { paneId: 'pane-live', itemId: 'WL-MIX-LIVE' },
      ]);
      const { deps, confirm } = makeDeps(dir, {
        readLivePanes: async () => ({ ok: true, panes: livePanes }),
      });

      await prepareInteractiveAgentDispatch(AUDIT_CMD, deps);

      const header = readHostBudgetStatus({ dir, livePanes });
      const dialogLive = confirm.mock.calls[0][0].live;
      // The two surfaces agree, and both exclude the dead entry.
      expect(dialogLive).toBe(header?.audit.live);
      expect(dialogLive).toBe(2);
    });
  });

  it('the implement-tier dialog counting is unchanged (liveCount)', async () => {
    await withMachineDir(async (dir) => {
      writeBudgetConfig(dir, { maxImplement: 1 });
      // One implement entry whose pane is NOT in the live pane list.
      seedBudgetLedger(dir, [
        makeBudgetEntry({ kind: 'implement', itemId: 'WL-IMP-GONE', paneId: 'pane-gone' }),
      ]);
      const { deps, confirm } = makeDeps(dir, {
        readLivePanes: async () => okPanes(),
      });

      const result = await prepareInteractiveAgentDispatch(IMPLEMENT_CMD, deps);

      // liveCount requires a live pane: count 0 ⇒ below cap ⇒ no prompt.
      expect(result.proceed).toBe(true);
      expect(confirm).not.toHaveBeenCalled();
    });
  });
});

// ── Both agent branches (AC9) ─────────────────────────────────────────
//
// index.ts runs this gate ONCE inside `route === 'agent'`, before the
// pane/headless split (and before the claim), so the two branches cannot
// diverge. These cases replicate that ordering: the gate decides, then the
// branch either spawns (a pane, or a headless `pi -p` background run) or —
// on cancel — nothing at all happens.

describe.each([
  { branch: 'interactive pane', openPane: true },
  { branch: 'headless (open_pane: false)', openPane: false },
])('$branch agent branch (AC9)', ({ openPane }) => {
  /** Replicates index.ts: gate → (proceed) claim+spawn, (cancel) return. */
  async function dispatch(
    deps: InteractiveAgentDispatchDeps,
    spawn: ReturnType<typeof vi.fn>,
  ): Promise<{ spawned: boolean; openPane: boolean }> {
    const preparation = await prepareInteractiveAgentDispatch(IMPLEMENT_CMD, deps);
    if (!preparation.proceed) return { spawned: false, openPane };
    spawn({ openPane, override: preparation.override });
    return { spawned: true, openPane };
  }

  it('at cap + cancel ⇒ no spawn, no claim, no ledger entry', async () => {
    await withMachineDir(async (dir) => {
      writeBudgetConfig(dir, { maxImplement: 1 });
      writeBudgetLedger(dir, [makeBudgetEntry({ itemId: 'WL-OTHER-1', paneId: 'pane-1' })]);
      const { deps, confirm, claim } = makeDeps(dir, {
        readLivePanes: async () => okPanes('WL-OTHER-1'),
      });
      confirm.mockResolvedValueOnce('cancel');
      const spawn = vi.fn();

      const outcome = await dispatch(deps, spawn);

      expect(outcome).toEqual({ spawned: false, openPane });
      expect(spawn).not.toHaveBeenCalled();
      expect(claim).not.toHaveBeenCalled();
      expect(readBudgetLedger(dir)?.entries).toHaveLength(1);
    });
  });

  it('at cap + proceed ⇒ spawns with the user override on the ledger entry', async () => {
    await withMachineDir(async (dir) => {
      writeBudgetConfig(dir, { maxImplement: 1 });
      writeBudgetLedger(dir, [makeBudgetEntry({ itemId: 'WL-OTHER-1', paneId: 'pane-1' })]);
      const { deps, confirm, claim } = makeDeps(dir, {
        readLivePanes: async () => okPanes('WL-OTHER-1'),
      });
      confirm.mockResolvedValueOnce('proceed');
      const spawn = vi.fn();

      const outcome = await dispatch(deps, spawn);

      expect(outcome).toEqual({ spawned: true, openPane });
      expect(claim).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledWith({ openPane, override: { by: 'user' } });
      const entry = readBudgetLedger(dir)?.entries.find(
        (candidate) => candidate.itemId === 'WL-0000000000000001',
      );
      expect(entry?.override).toEqual({ by: 'user' });
    });
  });

  it('below quota ⇒ spawns with no dialog (the common path is unchanged)', async () => {
    await withMachineDir(async (dir) => {
      writeBudgetConfig(dir, { maxImplement: 2 });
      const { deps, confirm } = makeDeps(dir);
      const spawn = vi.fn();

      const outcome = await dispatch(deps, spawn);

      expect(outcome).toEqual({ spawned: true, openPane });
      expect(confirm).not.toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledWith({ openPane, override: undefined });
    });
  });
});

// ── Unknown pane state (WL-0MW9VQX5T001GCUP) ──────────────────────────
//
// The interactive gate receives the tri-state pane read: `{ok:false}` means
// pane liveness is UNKNOWN — it must never be converted to an authoritative
// empty list, because the implement branch's `liveCount` would then reap a
// stale-but-live entry (AC1b) and the audit display count would invent a zero.

describe('unknown pane state in the interactive gate (WL-0MW9VQX5T001GCUP)', () => {
  it('AC1(b): a failed pane read never deletes — the implement gate counts by the freshness rule and never reaps', async () => {
    await withMachineDir(async (dir) => {
      writeBudgetConfig(dir, { maxImplement: 1 });
      seedBudgetLedger(dir, [
        // A live implement (fresh, has a pane): the freshness rule counts it.
        makeBudgetEntry({ kind: 'implement', itemId: 'WL-LIVE-IMP', paneId: 'pane-1' }),
        // A stale, pane-less implement entry that a trusted empty read would
        // reap — it must SURVIVE an unknown read.
        makeBudgetEntry({
          kind: 'implement',
          itemId: 'WL-STALE-IMP',
          paneId: 'pane-gone',
          heartbeatAt: new Date(Date.now() - HOST_BUDGET_STALE_WINDOW_MS - 1000).toISOString(),
        }),
      ]);
      const before = readFileSync(budgetLedgerPath(dir), 'utf8');
      const { deps, confirm } = makeDeps(dir, { readLivePanes: async () => unknownPanes });

      await prepareInteractiveAgentDispatch(IMPLEMENT_CMD, deps);

      // Unknown is NOT "no panes": the freshness rule counts the live entry,
      // so the gate is AT cap and PROMPTS instead of silently admitting with a
      // false zero.
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(confirm.mock.calls[0][0]).toEqual({ kind: 'implement', live: 1, max: 1 });
      // Neither the stale entry was reaped NOR a reservation written (the gate
      // prompts instead of reserving): the ledger is byte-identical.
      expect(readFileSync(budgetLedgerPath(dir), 'utf8')).toBe(before);
    });
  });

  it('AC4/AC3: the audit dialog counts by the freshness rule on unknown (never an invented zero)', async () => {
    await withMachineDir(async (dir) => {
      writeBudgetConfig(dir, { maxAudit: 1 });
      // One STARTED audit (fresh, no pane) and one stale audit: the freshness
      // fallback counts the fresh one, so the human is prompted rather than
      // being told the tier is free.
      seedBudgetLedger(dir, [
        makeBudgetEntry({ kind: 'audit', itemId: 'WL-AUD-LIVE' }),
        makeBudgetEntry({
          kind: 'audit',
          itemId: 'WL-AUD-STALE',
          paneId: 'pane-gone',
          heartbeatAt: new Date(Date.now() - HOST_BUDGET_STALE_WINDOW_MS - 1000).toISOString(),
        }),
      ]);
      const { deps, confirm } = makeDeps(dir, { readLivePanes: async () => unknownPanes });

      await prepareInteractiveAgentDispatch(AUDIT_CMD, deps);

      // livePanesTrusted derives from the tri-state: `{ok:false}` ⇒ unknown,
      // so the display count uses the marker-compatible freshness rule.
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(confirm.mock.calls[0][0]).toEqual({ kind: 'audit', live: 1, max: 1 });
    });
  });
});
