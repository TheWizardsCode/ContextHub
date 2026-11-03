/**
 * packages/herdr/src/host-budget-status.test.ts — the read-only host-budget
 * summary and refusal copy (WL-0MVXY0ZYW009NEJD F5, parent WL-0MVXWQFGV000D2AB).
 *
 * Covers:
 *  - AC1/AC2 vocabulary: the three reason tokens are the decision log's, and
 *    each maps to its own header token;
 *  - AC3 copy: the `Downtime … tier skipped: <reason>` line carries the live
 *    count and the cap (and is `null` for every other reason);
 *  - AC4 summary: `implement n/max · audit n/max`, `null` when the
 *    budget/ledger is unavailable, and the header renders nothing then;
 *  - AC5 rules: the summary counts through the ledger's own reductions
 *    (implement = fresh + live pane, audit = fresh, legacy marker included) and
 *    is strictly READ-ONLY — a display read never reaps or rewrites.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  HOST_BUDGET_CONFIG_FILE,
  HOST_BUDGET_STALE_WINDOW_MS,
  budgetConfigPath,
  budgetLedgerPath,
} from './host-dispatch-budget.js';
import {
  makeBudgetEntry,
  makeLivePaneList,
  withMachineDir,
  writeBudgetLedger,
  writeRawBudgetLedger,
} from './host-dispatch-budget.fixtures.js';
import {
  HOST_BUDGET_AUDIT_REASON,
  HOST_BUDGET_DECISION_REASONS,
  HOST_BUDGET_IMPLEMENT_REASON,
  HOST_BUDGET_UNKNOWN_REASON,
  isHostBudgetDecisionReason,
} from './downtime-log.js';
import { decisionHeaderToken } from './downtime-worker.constants.js';
import {
  hostBudgetSkipLine,
  hostBudgetStatusText,
  readHostBudgetStatus,
  summariseHostBudget,
} from './host-budget-status.js';

/** Deterministic clock: 2026-11-03T12:00:00.000Z. */
const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

const cleanEnv: Readonly<Record<string, string | undefined>> = {};

/** Write the machine `budget.json` caps. */
function writeCaps(dir: string, caps: Record<string, number>): void {
  writeFileSync(budgetConfigPath(dir), JSON.stringify(caps) + '\n', 'utf8');
}

// ── AC1/AC2: one vocabulary, one header token per reason ───────────────

describe('host-budget reason tokens and header mapping (AC1/AC2)', () => {
  it('accepts exactly the three budget tokens', () => {
    expect([...HOST_BUDGET_DECISION_REASONS]).toEqual([
      'host-budget-implement',
      'host-budget-audit',
      'host-budget-unknown',
    ]);
    for (const reason of HOST_BUDGET_DECISION_REASONS) {
      expect(isHostBudgetDecisionReason(reason)).toBe(true);
    }
    // Everything else — including the retired marker's own token — is not a
    // budget token, so no budget copy is emitted for it.
    for (const other of ['audit-host-saturated', 'no-candidate', '', null, undefined, 1]) {
      expect(isHostBudgetDecisionReason(other)).toBe(false);
    }
  });

  it('maps each token to its own header token, distinct from capacity tokens', () => {
    expect(decisionHeaderToken(HOST_BUDGET_IMPLEMENT_REASON)).toBe('budget-implement');
    expect(decisionHeaderToken(HOST_BUDGET_AUDIT_REASON)).toBe('budget-audit');
    expect(decisionHeaderToken(HOST_BUDGET_UNKNOWN_REASON)).toBe('budget-unknown');
    // AC2 consistency: the capacity-shaped stops keep their tokens, so an
    // operator-imposed budget stop is never read as a capacity stop.
    expect(decisionHeaderToken('proxy-contention')).toBe('contention');
    expect(decisionHeaderToken('slot-owned')).toBe('slot-owner');
    expect(decisionHeaderToken('capacity-saturated')).toBe('saturated');
  });
});

// ── AC3: the stderr skip line carries the live count and the cap ───────

describe('hostBudgetSkipLine (AC3)', () => {
  it('names the tier, the reason, the live count and the cap', () => {
    expect(hostBudgetSkipLine(HOST_BUDGET_IMPLEMENT_REASON, { live: 2, max: 2 })).toBe(
      '[worklog-plugin] Downtime implement tier skipped: host-budget-implement (live=2, max=2)',
    );
    expect(hostBudgetSkipLine(HOST_BUDGET_AUDIT_REASON, { live: 1, max: 1 })).toBe(
      '[worklog-plugin] Downtime audit tier skipped: host-budget-audit (live=1, max=1)',
    );
  });

  it('names the budget itself for the unknown ledger (tier cannot be inferred)', () => {
    expect(hostBudgetSkipLine(HOST_BUDGET_UNKNOWN_REASON, { live: 0, max: 0 })).toBe(
      '[worklog-plugin] Downtime budget tier skipped: host-budget-unknown (live=0, max=0)',
    );
  });

  it('is honest about missing evidence instead of inventing 0/0', () => {
    expect(hostBudgetSkipLine(HOST_BUDGET_IMPLEMENT_REASON)).toBe(
      '[worklog-plugin] Downtime implement tier skipped: host-budget-implement (live=unknown, max=unknown)',
    );
  });

  it('emits nothing for a non-budget reason (existing copy is unchanged)', () => {
    expect(hostBudgetSkipLine('audit-host-saturated', { live: 1, max: 1 })).toBeNull();
    expect(hostBudgetSkipLine('no-candidate')).toBeNull();
  });
});

// ── AC4: the pure summary and its header text ──────────────────────────

describe('summariseHostBudget / hostBudgetStatusText (AC4)', () => {
  it('pairs the observed counts with the resolved caps', () => {
    expect(summariseHostBudget({ implement: 1, audit: 0 }, { maxImplement: 2, maxAudit: 1 })).toEqual({
      implement: { live: 1, max: 2 },
      audit: { live: 0, max: 1 },
    });
  });

  it('is null when either half is unavailable (never a fabricated zero)', () => {
    expect(summariseHostBudget(null, { maxImplement: 2, maxAudit: 1 })).toBeNull();
    expect(summariseHostBudget({ implement: 0, audit: 0 }, null)).toBeNull();
    expect(summariseHostBudget(undefined, undefined)).toBeNull();
  });

  it('renders `implement n/max · audit n/max`, and nothing when unavailable', () => {
    expect(
      hostBudgetStatusText({
        implement: { live: 1, max: 2 },
        audit: { live: 0, max: 1 },
      }),
    ).toBe('[budget: implement 1/2 · audit 0/1]');
    expect(hostBudgetStatusText(null)).toBeNull();
    expect(hostBudgetStatusText(undefined)).toBeNull();
  });
});

// ── AC5: the read-only reader uses the ledger's own counting rules ─────

describe('readHostBudgetStatus — one read-only reader (AC5)', () => {
  it('renders nothing when the coordination dir is unresolvable', () => {
    expect(readHostBudgetStatus({ dir: null, now: NOW, env: cleanEnv })).toBeNull();
  });

  it('renders nothing when no ledger exists yet (the budget is not in use)', async () => {
    await withMachineDir((dir) => {
      // Caps may well be configured; with no ledger there is nothing in
      // flight to report and the header gains no chrome.
      writeCaps(dir, { maxImplement: 2, maxAudit: 1 });
      expect(readHostBudgetStatus({ dir, now: NOW, env: cleanEnv })).toBeNull();
    });
  });

  it('renders nothing for a corrupt ledger and never rewrites it', async () => {
    await withMachineDir((dir) => {
      writeRawBudgetLedger(dir, '{ not json');
      const before = readFileSync(budgetLedgerPath(dir), 'utf8');
      expect(readHostBudgetStatus({ dir, now: NOW, env: cleanEnv })).toBeNull();
      expect(readFileSync(budgetLedgerPath(dir), 'utf8')).toBe(before);
    });
  });

  it('counts the implement tier by its live-pane rule and the audit tier by freshness', async () => {
    await withMachineDir((dir) => {
      writeCaps(dir, { maxImplement: 2, maxAudit: 2 });
      writeBudgetLedger(dir, [
        makeBudgetEntry({
          kind: 'implement',
          itemId: 'WL-LIVE',
          paneId: 'pane-1',
          heartbeatAt: new Date(NOW - HOUR).toISOString(),
        }),
        // Fresh, but its pane is not in the live list: the implement tier does
        // not count it (the spawn/reconcile window of the ledger's own rule).
        makeBudgetEntry({
          kind: 'implement',
          itemId: 'WL-SPAWNING',
          paneId: 'pane-not-live',
          heartbeatAt: new Date(NOW).toISOString(),
        }),
        // Fresh audit with NO live pane: counted (marker-compatible rule).
        makeBudgetEntry({
          kind: 'audit',
          itemId: 'WL-AUDIT',
          heartbeatAt: new Date(NOW).toISOString(),
        }),
        // Stale and pane-less: not counted.
        makeBudgetEntry({
          kind: 'implement',
          itemId: 'WL-CRASHED',
          paneId: 'pane-gone',
          heartbeatAt: new Date(NOW - HOST_BUDGET_STALE_WINDOW_MS - 1).toISOString(),
        }),
      ]);

      const status = readHostBudgetStatus({
        dir,
        livePanes: makeLivePaneList([{ paneId: 'pane-1', itemId: 'WL-LIVE' }]),
        now: NOW,
        env: cleanEnv,
      });
      expect(status).toEqual({
        implement: { live: 1, max: 2 },
        audit: { live: 1, max: 2 },
      });
      expect(hostBudgetStatusText(status)).toBe('[budget: implement 1/2 · audit 1/2]');
    });
  });

  it('is strictly read-only: a display read never reaps the stale entry', async () => {
    await withMachineDir((dir) => {
      writeCaps(dir, { maxImplement: 2, maxAudit: 1 });
      writeBudgetLedger(dir, [
        makeBudgetEntry({
          kind: 'implement',
          itemId: 'WL-CRASHED',
          paneId: 'pane-gone',
          heartbeatAt: new Date(NOW - HOST_BUDGET_STALE_WINDOW_MS - 1).toISOString(),
        }),
      ]);
      const before = readFileSync(budgetLedgerPath(dir), 'utf8');
      expect(readHostBudgetStatus({ dir, livePanes: [], now: NOW, env: cleanEnv })).toEqual({
        implement: { live: 0, max: 2 },
        audit: { live: 0, max: 1 },
      });
      // Byte-identical: the display path did NOT reap, unlike the admission
      // read `liveCount` (which cleans up).
      expect(readFileSync(budgetLedgerPath(dir), 'utf8')).toBe(before);
    });
  });

  it('reports the configured caps, including a disabled tier', async () => {
    await withMachineDir((dir) => {
      writeCaps(dir, { maxImplement: 0, maxAudit: 3 });
      writeBudgetLedger(dir, [
        makeBudgetEntry({
          kind: 'audit',
          itemId: 'WL-AUDIT',
          heartbeatAt: new Date(NOW).toISOString(),
        }),
      ]);
      expect(readHostBudgetStatus({ dir, livePanes: [], now: NOW, env: cleanEnv })).toEqual({
        implement: { live: 0, max: 0 },
        audit: { live: 1, max: 3 },
      });
    });
  });

  it('resolves the machine coordination dir when no dir seam is supplied', async () => {
    await withMachineDir((dir) => {
      expect(readHostBudgetStatus({ now: NOW, env: cleanEnv })).toBeNull(); // no ledger yet
      writeBudgetLedger(dir, [
        makeBudgetEntry({
          kind: 'audit',
          itemId: 'WL-AUDIT',
          heartbeatAt: new Date(NOW).toISOString(),
        }),
      ]);
      // The fixture pins HERDR_COORDINATION_DIR, so the default resolution
      // reaches this isolated directory (never the real ~/.herdr/downtime).
      expect(readHostBudgetStatus({ now: NOW, env: cleanEnv })).toMatchObject({
        implement: { max: 2 },
        audit: { live: 1, max: 1 },
      });
    });
  });

  it('keeps the config file independent of the ledger (caps from budget.json)', async () => {
    await withMachineDir((dir) => {
      writeCaps(dir, { maxImplement: 5 });
      writeBudgetLedger(dir, []);
      const status = readHostBudgetStatus({ dir, livePanes: [], now: NOW, env: cleanEnv });
      expect(status).toMatchObject({ implement: { live: 0, max: 5 } });
      expect(budgetConfigPath(dir)).toContain(HOST_BUDGET_CONFIG_FILE);
    });
  });
});
