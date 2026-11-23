/**
 * packages/herdr/src/host-dispatch-budget.relief.test.ts — admission-level
 * budget relief and both-dispatcher-path parity (parent WL-0MWTAD9NV000IVK5,
 * child WL-0MWTASOSV0004O6J).
 *
 * These tests drive the PRODUCTION admission reader (`admitHostDispatch`) with
 * the same seams `index.ts` wires: one isolated machine dir, an injected
 * clock, the tri-state live-pane list and the active model-cooldown read. They
 * pin parent AC2 (effective cap arithmetic), AC3 (total-live cap), AC4 (relief
 * ends when the cooldown expires), AC5 (unreadable signal fails closed) and
 * AC7 (there is no admission path that bypasses the seam).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ModelCooldownEntry } from '@worklog/shared/model-cooldown';

import {
  admitHostDispatch,
  HOST_BUDGET_IMPLEMENT_REFUSAL,
  HOST_BUDGET_AUDIT_REFUSAL,
} from './host-dispatch-budget.admission.js';
import { HOST_BUDGET_CONFIG_FILE } from './host-dispatch-budget.js';
import type { HostBudgetLivePane } from './host-dispatch-budget.js';
import { prepareInteractiveAgentDispatch } from './host-dispatch-budget.interactive.js';
import type { HostBudgetPromptRequest } from './host-budget-dialog.js';
import {
  makeBudgetEntry,
  makeLivePaneList,
  withMachineDir,
  writeBudgetLedger,
} from './host-dispatch-budget.fixtures.js';
import { HOST_BUDGET_RELIEF_UNREADABLE_REASON } from './host-budget-relief.js';
import { dispatchDowntimeWork } from './downtime-worker.js';
import { dispatchFromCoordination } from './downtime-worker.coordination-leader.js';
import { writeCoordinationFile } from './coordination.js';
import { makeDeps } from './downtime-worker.fixtures.js';

const NOW = Date.parse('2026-11-23T13:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
/** Environment with no budget/audit relief overrides. */
const CLEAN_ENV = { HERDR_COORDINATION_DIR: '' } as const;

/** Write `<dir>/budget.json` with the given per-kind caps. */
function writeCaps(dir: string, caps: Record<string, number>): void {
  writeFileSync(join(dir, HOST_BUDGET_CONFIG_FILE), JSON.stringify(caps), 'utf8');
}

/** A live pane in the dispatcher's real title form. */
function livePane(paneId: string, itemId: string, kind: 'implement' | 'audit' = 'implement'): HostBudgetLivePane {
  return { paneId, title: `Downtime triggered ${kind} - ${itemId}` };
}

/** An active model-cooldown entry matching `paneId`. */
function cooldown(
  paneId: string,
  kind: ModelCooldownEntry['kind'] = 'implement',
  cooldownUntil = NOW + HOUR,
): ModelCooldownEntry {
  return {
    paneId,
    sessionId: null,
    itemId: 'WL-BLOCKED',
    kind,
    reason: 'provider exhaustion',
    createdAt: NOW - MINUTE,
    cooldownUntil,
  };
}

interface AdmitOverrides {
  livePanes?: readonly HostBudgetLivePane[];
  modelCooldowns?: readonly ModelCooldownEntry[] | null;
  now?: number;
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Call the production admission reader with the SAME seams `index.ts` uses.
 * The rest of this suite varies only the live panes, the cooldown read and the
 * clock — exactly the three inputs relief consumes.
 */
function admit(
  dir: string,
  kind: 'implement' | 'audit',
  itemId = 'WL-NEW',
  overrides: AdmitOverrides = {},
) {
  return admitHostDispatch(
    { kind, itemId, instanceId: 'instance-a', root: '/repo' },
    {
      dir,
      livePanes: overrides.livePanes ?? [],
      now: overrides.now ?? NOW,
      env: overrides.env ?? CLEAN_ENV,
      ...(overrides.modelCooldowns !== undefined
        ? { modelCooldowns: overrides.modelCooldowns }
        : {}),
    },
  );
}

describe('admitHostDispatch — effective cap (AC2/AC3)', () => {
  it('admits below the relieved cap and records the budgetRelief evidence', async () => {
    await withMachineDir(async (dir) => {
      writeCaps(dir, { implement: 2 });
      const panes = [
        livePane('w1:p1', 'WL-A'),
        livePane('w1:p2', 'WL-B'),
        livePane('w1:p3', 'WL-BLOCKED'),
      ];
      const verdict = admit(dir, 'implement', 'WL-NEW', {
        livePanes: panes,
        modelCooldowns: [cooldown('w1:p3')],
      });
      // 3 live < effective 4 → admitted, and the verdict quotes the effective cap.
      expect(verdict.admitted).toBe(true);
      expect(verdict.max).toBe(4);
      expect(verdict.budgetRelief).toMatchObject({
        kind: 'implement',
        baseCap: 2,
        effectiveCap: 4,
        blockedPaneIds: ['w1:p3'],
        reason: 'model-blocked',
      });
    });
  });

  it('refuses at the effective cap with the normal host-budget-implement token', async () => {
    await withMachineDir(async (dir) => {
      writeCaps(dir, { implement: 2 });
      // Base 2, effective 4; 4 live panes of which 1 is model-blocked. The
      // blocked pane is INCLUDED in the total live count.
      const panes = [
        livePane('w1:p1', 'WL-A'),
        livePane('w1:p2', 'WL-B'),
        livePane('w1:p3', 'WL-C'),
        livePane('w1:p4', 'WL-BLOCKED'),
      ];
      const verdict = admit(dir, 'implement', 'WL-NEW', {
        livePanes: panes,
        modelCooldowns: [cooldown('w1:p4')],
      });
      expect(verdict.admitted).toBe(false);
      expect(verdict.reason).toBe(HOST_BUDGET_IMPLEMENT_REFUSAL);
      expect(verdict.live).toBe(4);
      expect(verdict.max).toBe(4);
      expect(verdict.budgetRelief?.effectiveCap).toBe(4);
    });
  });

  it('refuses at the configured cap when no pane is model-blocked', async () => {
    await withMachineDir(async (dir) => {
      writeCaps(dir, { implement: 2 });
      const panes = [
        livePane('w1:p1', 'WL-A'),
        livePane('w1:p2', 'WL-B'),
      ];
      const verdict = admit(dir, 'implement', 'WL-NEW', {
        livePanes: panes,
        modelCooldowns: [],
      });
      expect(verdict.admitted).toBe(false);
      expect(verdict.reason).toBe(HOST_BUDGET_IMPLEMENT_REFUSAL);
      expect(verdict.max).toBe(2);
      expect(verdict.budgetRelief).toBeUndefined();
    });
  });
});

describe('admitHostDispatch — per-kind independence (AC2)', () => {
  it('a blocked implement does not raise the audit cap', async () => {
    await withMachineDir(async (dir) => {
      writeCaps(dir, { implement: 2, audit: 1 });
      // The legacy local-budget path is the only audit path relief touches; use
      // it so the assertion is about the cap, not the proxy seam. One fresh
      // audit entry fills the configured cap of 1.
      writeBudgetLedger(dir, [
        makeBudgetEntry({
          kind: 'audit',
          itemId: 'WL-AUD',
          paneId: 'w1:a1',
          root: '/repo',
          startedAt: new Date(NOW).toISOString(),
          heartbeatAt: new Date(NOW).toISOString(),
        }),
      ]);
      const panes = [livePane('w1:a1', 'WL-AUD', 'audit')];
      const verdict = admitHostDispatch(
        { kind: 'audit', itemId: 'WL-NEW-AUDIT', instanceId: 'instance-a', root: '/repo' },
        {
          dir,
          livePanes: panes,
          now: NOW,
          env: { HERDR_AUDIT_LOCAL_BUDGET: '1' },
          modelCooldowns: [cooldown('w1:p-implement', 'implement')],
        },
      );
      expect(verdict.admitted).toBe(false);
      expect(verdict.reason).toBe(HOST_BUDGET_AUDIT_REFUSAL);
      expect(verdict.max).toBe(1);
      expect(verdict.budgetRelief).toBeUndefined();
    });
  });

  it('a blocked audit does not raise the implement cap', async () => {
    await withMachineDir(async (dir) => {
      writeCaps(dir, { implement: 2, audit: 1 });
      const panes = [
        livePane('w1:p1', 'WL-A'),
        livePane('w1:p2', 'WL-B'),
      ];
      const verdict = admit(dir, 'implement', 'WL-NEW', {
        livePanes: panes,
        modelCooldowns: [cooldown('w1:a1', 'audit')],
      });
      expect(verdict.admitted).toBe(false);
      expect(verdict.reason).toBe(HOST_BUDGET_IMPLEMENT_REFUSAL);
      expect(verdict.max).toBe(2);
    });
  });

  it('leaves an uncapped kind uncapped', async () => {
    await withMachineDir(async (dir) => {
      writeCaps(dir, { implement: 2 });
      const verdict = admitHostDispatch(
        { kind: 'plan', itemId: 'WL-PLAN', instanceId: 'instance-a', root: '/repo' },
        { dir, livePanes: [], now: NOW, env: CLEAN_ENV, modelCooldowns: [cooldown('w1:p1')] },
      );
      expect(verdict.admitted).toBe(true);
      expect(verdict.capped).toBe(false);
    });
  });

  it('never revives a disabled tier (max = 0)', async () => {
    await withMachineDir(async (dir) => {
      writeCaps(dir, { implement: 0 });
      const panes = [livePane('w1:p1', 'WL-BLOCKED')];
      const verdict = admit(dir, 'implement', 'WL-NEW', {
        livePanes: panes,
        modelCooldowns: [cooldown('w1:p1')],
      });
      expect(verdict.admitted).toBe(false);
      expect(verdict.max).toBe(0);
      expect(verdict.budgetRelief).toBeUndefined();
    });
  });
});

describe('admitHostDispatch — clock advance (AC4)', () => {
  it('ends relief when cooldownUntil passes and reverts the cap with no restart', async () => {
    await withMachineDir(async (dir) => {
      writeCaps(dir, { implement: 2 });
      const panes = [
        livePane('w1:p1', 'WL-A'),
        livePane('w1:p2', 'WL-B'),
        livePane('w1:p3', 'WL-BLOCKED'),
      ];
      const cooldowns = [cooldown('w1:p3', 'implement', NOW + 5 * MINUTE)];
      const during = admit(dir, 'implement', 'WL-NEW', {
        livePanes: panes,
        modelCooldowns: cooldowns,
        now: NOW,
      });
      expect(during.admitted).toBe(true);
      expect(during.max).toBe(4);

      // Same in-memory state, advanced clock: the entry is expired, so the
      // NEXT admission read uses the configured cap again.
      const after = admit(dir, 'implement', 'WL-NEW-2', {
        livePanes: panes,
        modelCooldowns: cooldowns,
        now: NOW + 5 * MINUTE + 1,
      });
      expect(after.admitted).toBe(false);
      expect(after.reason).toBe(HOST_BUDGET_IMPLEMENT_REFUSAL);
      expect(after.max).toBe(2);
      expect(after.budgetRelief).toBeUndefined();
    });
  });
});

describe('admitHostDispatch — unreadable signal (AC5)', () => {
  it('uses the configured cap and names the unreadable signal in the evidence', async () => {
    await withMachineDir(async (dir) => {
      writeCaps(dir, { implement: 2 });
      const panes = [
        livePane('w1:p1', 'WL-A'),
        livePane('w1:p2', 'WL-B'),
      ];
      const verdict = admit(dir, 'implement', 'WL-NEW', {
        livePanes: panes,
        modelCooldowns: null,
      });
      expect(verdict.admitted).toBe(false);
      expect(verdict.reason).toBe(HOST_BUDGET_IMPLEMENT_REFUSAL);
      expect(verdict.max).toBe(2);
      expect(verdict.budgetRelief).toMatchObject({
        reason: HOST_BUDGET_RELIEF_UNREADABLE_REASON,
        effectiveCap: 2,
      });
    });
  });
});

describe('interactive/admission agreement (AC7)', () => {
  it('does not prompt below the effective cap, prompts at it', async () => {
    await withMachineDir(async (dir) => {
      writeCaps(dir, { implement: 2 });
      const panes = [
        livePane('w1:p1', 'WL-A'),
        livePane('w1:p2', 'WL-B'),
        livePane('w1:p3', 'WL-BLOCKED'),
      ];
      const cooldowns = [cooldown('w1:p3')];
      const confirm = vi.fn(async (_request: HostBudgetPromptRequest) => 'cancel' as const);
      const claim = vi.fn(async () => {});

      const below = await prepareInteractiveAgentDispatch('/skill:implement WL-0000000000000001', {
        confirm,
        notify: vi.fn(),
        readLivePanes: async () => ({ ok: true, panes }),
        claim,
        root: '/repo',
        instanceId: 'instance-1',
        budget: { dir, now: NOW, env: CLEAN_ENV },
        modelCooldowns: cooldowns,
      });
      // 2 live < effective 4 → no dialog, claim proceeds.
      expect(below.proceed).toBe(true);
      expect(confirm).not.toHaveBeenCalled();
      expect(claim).toHaveBeenCalledTimes(1);

      // 4 live >= effective 4 → the SAME threshold admission uses asks first.
      const atCapPanes = [...panes, livePane('w1:p4', 'WL-D')];
      const atCap = await prepareInteractiveAgentDispatch('/skill:implement WL-0000000000000002', {
        confirm,
        notify: vi.fn(),
        readLivePanes: async () => ({ ok: true, panes: atCapPanes }),
        claim,
        root: '/repo',
        instanceId: 'instance-1',
        budget: { dir, now: NOW, env: CLEAN_ENV },
        modelCooldowns: cooldowns,
      });
      expect(atCap.proceed).toBe(false);
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(confirm.mock.calls[0][0]).toMatchObject({ max: 4 });
    });
  });
});

describe('both dispatcher paths produce the same verdict (AC7)', () => {
  it('the direct path and the coordination-leader path call the same admission seam', async () => {
    const verdict = {
      admitted: true,
      live: 3,
      max: 4,
      budgetRelief: {
        kind: 'implement' as const,
        baseCap: 2,
        effectiveCap: 4,
        blockedPaneIds: ['w1:blocked'],
        reason: 'model-blocked',
        until: NOW + HOUR,
      },
    };
    const admit = vi.fn(async (_input: { itemId: string; kind: string; cwd: string }) => verdict);
    const item = {
      id: 'WL-IMP',
      title: 'Implement me',
      stage: 'plan_complete',
      status: 'open',
      risk: 'Low',
      effort: 'S',
    };

    // Direct path: the worker's own-backlog dispatch.
    const directDeps = makeDeps({
      getNextImplementCandidate: vi.fn().mockResolvedValue(item),
      admitHostDispatch: admit,
    });
    const direct = await dispatchDowntimeWork(directDeps, { model: 'plan', cwd: '/repo' });
    expect(direct.dispatched).toBe(true);

    // Coordination-leader path: an OFFER from another instance.
    const coordDir = mkdtempSync(join(tmpdir(), 'herdr-relief-coord-'));
    try {
      const entry = {
        instanceId: 'inst-1',
        workItemId: 'WL-IMP',
        directory: '/repo',
        worklogRoot: '/repo',
        assignedAt: new Date(NOW).toISOString(),
        lastUpdated: new Date(NOW).toISOString(),
      };
      writeCoordinationFile(coordDir, { version: 1, entries: [entry] });
      const coordDeps = makeDeps({
        fetchItem: vi.fn().mockResolvedValue({ ok: true, info: item }),
        admitHostDispatch: admit,
      });
      const coord = await dispatchFromCoordination(coordDeps, [entry], {
        model: 'plan',
        cwd: '/repo',
        coordinationDir: coordDir,
      });
      expect(coord.dispatched).toBe(true);

      // Same input to the ONE admission seam, same evidence on both outcomes.
      expect(admit).toHaveBeenCalledTimes(2);
      const [directCall, coordCall] = admit.mock.calls.map((call) => call[0]);
      expect(directCall).toEqual({ itemId: 'WL-IMP', kind: 'implement', cwd: '/repo' });
      expect(coordCall).toEqual({ itemId: 'WL-IMP', kind: 'implement', cwd: '/repo' });
      expect(direct.budgetRelief).toEqual(verdict.budgetRelief);
      expect(coord.budgetRelief).toEqual(verdict.budgetRelief);
    } finally {
      rmSync(coordDir, { recursive: true, force: true });
    }
  });
});

describe('admission choke point (AC7)', () => {
  it('pins that both dispatcher paths route through the deps.admitHostDispatch seam', () => {
    // Source-level pin in the established style: the ONE admission read lives
    // in the shared dispatch-claims helper, and both dispatcher paths reach it
    // (they do not touch the ledger or compute a cap themselves).
    const claimsSource = readFileSync(
      join(process.cwd(), 'packages/herdr/src/downtime-worker.dispatch-claims.ts'),
      'utf8',
    );
    expect(claimsSource).toContain('deps.admitHostDispatch');
    expect(claimsSource).not.toContain('readBudgetConfig(');

    for (const file of [
      'packages/herdr/src/downtime-worker.dispatch.ts',
      'packages/herdr/src/downtime-worker.coordination-leader.ts',
    ]) {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      // Both paths call the shared claim helper; neither reserves a capped
      // slot itself.
      expect(source).toContain('dispatchClaimedTier');
      expect(source).not.toContain('reserve(');
    }
  });
});

describe('fixture sanity', () => {
  it('makeLivePaneList uses the dispatcher title form', () => {
    expect(makeLivePaneList(['WL-X'])[0].title).toContain('WL-X');
  });
});
