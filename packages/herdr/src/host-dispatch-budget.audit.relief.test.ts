/**
 * packages/herdr/src/host-dispatch-budget.audit.relief.test.ts — audit-arm
 * lease authority under budget relief (parent WL-0MWTAD9NV000IVK5, child
 * WL-0MWTASQDU002HDYR, implemented by WL-0MWTAT3090003CA6).
 *
 * The proxy audit lease is the ONLY audit admission authority. Budget relief
 * therefore must never invent a second lease, never lift a proxy `cap: 1`
 * verdict, and is scoped to the one-release legacy local-budget path
 * (`HERDR_AUDIT_LOCAL_BUDGET=1`). These tests pin that choice from every side.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ModelCooldownEntry } from '@worklog/shared/model-cooldown';

import {
  admitHostDispatch,
  HOST_BUDGET_AUDIT_REFUSAL,
} from './host-dispatch-budget.admission.js';
import {
  AUDIT_BUDGET_SATURATED_REASON,
  AUDIT_BUDGET_UNKNOWN_REASON,
} from './downtime-worker.audit-availability.contract.js';
import type { AuditAvailabilityOutcome } from './downtime-worker.audit-availability.js';
import type { AuditLeaseAcquireOutcome } from './downtime-worker.audit-lease.js';
import { HOST_BUDGET_CONFIG_FILE, type HostBudgetLivePane } from './host-dispatch-budget.js';
import {
  makeBudgetEntry,
  withMachineDir,
  writeBudgetLedger,
} from './host-dispatch-budget.fixtures.js';

const NOW = Date.parse('2026-11-23T13:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const ISO_NOW = new Date(NOW).toISOString();
const LEGACY_ENV = { HERDR_AUDIT_LOCAL_BUDGET: '1' } as const;
const PROXY_ENV = {} as const;

function writeCaps(dir: string, caps: Record<string, number>): void {
  writeFileSync(join(dir, HOST_BUDGET_CONFIG_FILE), JSON.stringify(caps), 'utf8');
}

function livePane(
  paneId: string,
  itemId: string,
  kind: 'implement' | 'audit' = 'audit',
): HostBudgetLivePane {
  return { paneId, title: `Downtime triggered ${kind} - ${itemId}` };
}

function cooldown(paneId: string, kind: ModelCooldownEntry['kind'] = 'audit'): ModelCooldownEntry {
  return {
    paneId,
    sessionId: null,
    itemId: 'WL-BLOCKED',
    kind,
    reason: 'provider exhaustion',
    createdAt: NOW - HOUR,
    cooldownUntil: NOW + HOUR,
  };
}

/** One fresh audit ledger entry (the legacy path's in-flight count). */
function seedInFlightAudit(dir: string): void {
  writeBudgetLedger(dir, [
    makeBudgetEntry({
      kind: 'audit',
      itemId: 'WL-AUD-RUN',
      paneId: 'w1:a1',
      root: '/repo',
      startedAt: ISO_NOW,
      heartbeatAt: ISO_NOW,
    }),
  ]);
}

const LEASE_OK: AuditLeaseAcquireOutcome = {
  status: 'ok',
  lease: { sessionId: 'herdr-audit-WL-NEW' },
};

const AVAILABLE_ONE: AuditAvailabilityOutcome = {
  status: 'ok',
  availability: { cap: 1, live: 0, available: true },
};
const SATURATED_ONE: AuditAvailabilityOutcome = {
  status: 'ok',
  availability: { cap: 1, live: 1, available: false, reason: AUDIT_BUDGET_SATURATED_REASON },
};

describe('proxy-derived audit admission is unchanged by relief (AC6)', () => {
  it('still refuses audit-budget-saturated at proxy cap 1 while an audit is model-blocked', async () => {
    await withMachineDir(async (dir) => {
      writeCaps(dir, { audit: 9 }); // a local cap relief could otherwise double
      const verdict = admitHostDispatch(
        { kind: 'audit', itemId: 'WL-NEW', instanceId: 'instance-a', root: '/repo' },
        {
          dir,
          livePanes: [livePane('w1:a1', 'WL-BLOCKED')],
          now: NOW,
          env: PROXY_ENV,
          auditAvailability: SATURATED_ONE,
          modelCooldowns: [cooldown('w1:a1')],
          // A caller NEVER acquires on a refused pre-check; supplying one here
          // proves the availability refusal is not bypassed by a lease.
          auditLease: LEASE_OK,
        },
      );
      expect(verdict.admitted).toBe(false);
      expect(verdict.reason).toBe(AUDIT_BUDGET_SATURATED_REASON);
      expect(verdict.max).toBe(1);
      expect(verdict.budgetRelief).toBeUndefined();
    });
  });

  it('never raises the effective cap above the proxy-reported cap', async () => {
    await withMachineDir(async (dir) => {
      writeCaps(dir, { audit: 9 });
      const verdict = admitHostDispatch(
        { kind: 'audit', itemId: 'WL-NEW', instanceId: 'instance-a', root: '/repo' },
        {
          dir,
          livePanes: [livePane('w1:a1', 'WL-BLOCKED')],
          now: NOW,
          env: PROXY_ENV,
          auditAvailability: AVAILABLE_ONE,
          auditLease: LEASE_OK,
          modelCooldowns: [cooldown('w1:a1')],
        },
      );
      expect(verdict.admitted).toBe(true);
      // The proxy's cap is 1; relief must not turn it into 2.
      expect(verdict.max).toBe(1);
      expect(verdict.budgetRelief).toBeUndefined();
    });
  });

  it('fails closed with no relief when the proxy availability seam is absent', async () => {
    await withMachineDir(async (dir) => {
      writeCaps(dir, { audit: 9 });
      const verdict = admitHostDispatch(
        { kind: 'audit', itemId: 'WL-NEW', instanceId: 'instance-a', root: '/repo' },
        {
          dir,
          livePanes: [livePane('w1:a1', 'WL-BLOCKED')],
          now: NOW,
          env: PROXY_ENV,
          modelCooldowns: [cooldown('w1:a1')],
        },
      );
      expect(verdict.admitted).toBe(false);
      expect(verdict.reason).toBe(AUDIT_BUDGET_UNKNOWN_REASON);
      expect(verdict.budgetRelief).toBeUndefined();
    });
  });
});

describe('legacy local-budget audit relief (AC6, scoping option 2)', () => {
  it('doubles maxAudit while a model-blocked audit pane exists', async () => {
    await withMachineDir(async (dir) => {
      writeCaps(dir, { audit: 1 });
      seedInFlightAudit(dir);
      const verdict = admitHostDispatch(
        { kind: 'audit', itemId: 'WL-NEW', instanceId: 'instance-a', root: '/repo' },
        {
          dir,
          livePanes: [livePane('w1:a1', 'WL-AUD-RUN')],
          now: NOW,
          env: LEGACY_ENV,
          modelCooldowns: [cooldown('w1:a1')],
        },
      );
      expect(verdict.admitted).toBe(true);
      expect(verdict.max).toBe(2);
      expect(verdict.budgetRelief).toMatchObject({
        kind: 'audit',
        baseCap: 1,
        effectiveCap: 2,
        blockedPaneIds: ['w1:a1'],
        reason: 'model-blocked',
      });
    });
  });

  it('keeps the configured maxAudit when no audit pane is model-blocked', async () => {
    await withMachineDir(async (dir) => {
      writeCaps(dir, { audit: 1 });
      seedInFlightAudit(dir);
      const verdict = admitHostDispatch(
        { kind: 'audit', itemId: 'WL-NEW', instanceId: 'instance-a', root: '/repo' },
        {
          dir,
          livePanes: [livePane('w1:a1', 'WL-AUD-RUN')],
          now: NOW,
          env: LEGACY_ENV,
          modelCooldowns: [],
        },
      );
      expect(verdict.admitted).toBe(false);
      expect(verdict.reason).toBe(HOST_BUDGET_AUDIT_REFUSAL);
      expect(verdict.max).toBe(1);
      expect(verdict.budgetRelief).toBeUndefined();
    });
  });

  it('is unchanged when the legacy flag is absent', async () => {
    await withMachineDir(async (dir) => {
      writeCaps(dir, { audit: 1 });
      seedInFlightAudit(dir);
      const verdict = admitHostDispatch(
        { kind: 'audit', itemId: 'WL-NEW', instanceId: 'instance-a', root: '/repo' },
        {
          dir,
          livePanes: [livePane('w1:a1', 'WL-AUD-RUN')],
          now: NOW,
          env: PROXY_ENV,
          modelCooldowns: [cooldown('w1:a1')],
        },
      );
      // No proxy availability seam → fail closed, never a relieved local cap.
      expect(verdict.admitted).toBe(false);
      expect(verdict.reason).toBe(AUDIT_BUDGET_UNKNOWN_REASON);
      expect(verdict.budgetRelief).toBeUndefined();
    });
  });
});

describe('audit relief scoping is documented and pinned', () => {
  it('pins the code marker: the proxy branch does not read the relief resolver', () => {
    const source = readFileSync(
      join(process.cwd(), 'packages/herdr/src/host-dispatch-budget.admission.ts'),
      'utf8',
    );
    expect(source).toContain('AUDIT RELIEF SCOPING');

    const dispatchStart = source.indexOf('function admitAuditDispatch');
    const afterDispatch = source.indexOf('export function admitHostDispatch', dispatchStart);
    expect(dispatchStart).toBeGreaterThan(-1);
    expect(afterDispatch).toBeGreaterThan(dispatchStart);
    const proxyBranch = source.slice(dispatchStart, afterDispatch);
    // The proxy-derived branch must never compute a local relieved cap.
    expect(proxyBranch).not.toContain('resolveReliefForKind(');
    expect(proxyBranch).not.toContain('budgetRelief');

    const legacyStart = source.indexOf('function admitAuditLegacy');
    const legacyBranch = source.slice(legacyStart, dispatchStart);
    expect(legacyBranch).toContain('resolveReliefForKind');
  });

  it('pins the documented scoping in the dispatcher guide', () => {
    const docs = readFileSync(
      join(process.cwd(), 'docs/dev/downtime-dispatcher.md'),
      'utf8',
    );
    expect(docs).toContain('AUDIT RELIEF SCOPING');
    expect(docs).toContain('HERDR_AUDIT_LOCAL_BUDGET=1');
  });
});
