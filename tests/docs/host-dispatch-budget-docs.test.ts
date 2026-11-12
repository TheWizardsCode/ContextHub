/**
 * Host-wide dispatch-budget documentation tests
 * (WL-0MVXY10QH0020V7S F6, parent WL-0MVXWQFGV000D2AB).
 *
 * This work item is documentation-only, so the documented contract IS the
 * behaviour under test. These assertions pin the facts an operator or future
 * maintainer must be able to find without re-deriving them from source:
 *
 *  - the gate table (both tiers plus the `host-budget-unknown` fail-closed row),
 *  - the machine-dir file-table entries and the module-table row,
 *  - the deliberate per-path fail directions,
 *  - the audit-cap unification (one release of read-compatibility, the
 *    mixed-version argument and the removal schedule),
 *  - the `maxImplement: 2` rationale and the WL-0MU2EP6JL006A1U3 boundary,
 *  - the README's machine-scoped statement and interactive-dialog behaviour,
 *  - CONFIG.md's env vars / file location / defaults / clamps / `0` semantics,
 *  - the rolling-window out-of-scope note and its additive `window` slot,
 *  - no stale claim that an audit cap of 1 is still hard-coded.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

const DISPATCHER_DOC = path.join(REPO_ROOT, 'docs', 'dev', 'downtime-dispatcher.md');
const HERDR_README = path.join(REPO_ROOT, 'packages', 'herdr', 'README.md');
const CONFIG_DOC = path.join(REPO_ROOT, 'CONFIG.md');
const MACHINE_COORDINATION_SRC = path.join(
  REPO_ROOT,
  'packages',
  'herdr',
  'src',
  'machine-coordination.ts',
);

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

/** A fenced-code-free view is not needed here: every assertion targets prose. */
const dispatcherDoc = read(DISPATCHER_DOC);
const readme = read(HERDR_README);
const configDoc = read(CONFIG_DOC);
const machineCoordination = read(MACHINE_COORDINATION_SRC);

describe('downtime-dispatcher deep-dive documents the host-wide budget', () => {
  it('has the module-table row for the ledger module', () => {
    expect(dispatcherDoc).toContain('| `host-dispatch-budget.ts` |');
    expect(dispatcherDoc).toContain('`readBudget`');
    expect(dispatcherDoc).toContain('`liveCount`');
  });

  it('has the machine-dir file-table entries for the ledger and its config', () => {
    expect(dispatcherDoc).toMatch(
      /\| `~\/\.herdr\/downtime\/dispatch-budget\.json` \|/,
    );
    expect(dispatcherDoc).toMatch(/\| `~\/\.herdr\/downtime\/budget\.json` \|/);
    // The retired marker is documented as read-only, not silently dropped.
    expect(dispatcherDoc).toMatch(/\| `~\/\.herdr\/downtime\/active-audit` \|/);
    expect(dispatcherDoc).toContain('Retired');
  });

  it('has a gate table covering both tiers with the budget reason tokens', () => {
    for (const token of [
      'host-budget-implement',
      'host-budget-audit',
      'host-budget-unknown',
      'audit-host-saturated',
    ]) {
      expect(dispatcherDoc).toContain(token);
    }
    // Both tier rows, and the unknown row that applies to either tier.
    expect(dispatcherDoc).toMatch(/\| implement \|/);
    expect(dispatcherDoc).toMatch(/\| audit \|/);
    expect(dispatcherDoc).toMatch(/\| either \|/);
    // The header tokens the herdr header shows for each refusal.
    expect(dispatcherDoc).toContain('`budget-implement`');
    expect(dispatcherDoc).toContain('`budget-audit`');
    expect(dispatcherDoc).toContain('`budget-unknown`');
  });

  it('records the deliberate per-path fail directions and the self-healing rewrite', () => {
    expect(dispatcherDoc).toContain('**fail closed**');
    expect(dispatcherDoc).toContain('**fail open with a visible notice**');
    expect(dispatcherDoc).toContain('self-healing rewrite from the live pane list');
    expect(dispatcherDoc).toContain(
      'Host dispatch budget ledger unreadable — proceeding without the quota check.',
    );
  });

  it('records the audit-cap unification, mixed-version safety and removal schedule', () => {
    expect(dispatcherDoc).toContain('retired in favour of the ledger');
    expect(dispatcherDoc).toContain('One release of read-compatibility');
    expect(dispatcherDoc).toContain('one synthetic audit entry');
    expect(dispatcherDoc).toContain('Mixed-version safety argument');
    expect(dispatcherDoc).toContain('Removal schedule');
    // The schedule must say WHEN the read goes away, not just that it will.
    expect(dispatcherDoc).toMatch(
      /release \*\*after\*\* the host-wide budget generalisation ships/,
    );
  });

  it('records the conservative maxImplement default and the WL-0MU2EP6JL006A1U3 boundary', () => {
    expect(dispatcherDoc).toContain('`maxImplement` defaults to 2');
    expect(dispatcherDoc).toContain('host work-in-flight');
    expect(dispatcherDoc).toContain('WL-0MU2EP6JL006A1U3');
    expect(dispatcherDoc).toContain('7 panes queued on 1 slot');
    expect(dispatcherDoc).toContain('inner limiter');
  });

  it('states that a rolling-window total cap is out of scope and where `window` slots in', () => {
    expect(dispatcherDoc).toMatch(/Out of scope for v1/);
    expect(dispatcherDoc).toContain('rolling window');
    expect(dispatcherDoc).toContain('`window` field');
    expect(dispatcherDoc).toMatch(/additive/i);
  });

  it('contains no stale claim that the audit cap of 1 is still hard-coded', () => {
    // Historical statements are allowed only when they name the retirement.
    expect(dispatcherDoc).not.toMatch(/audit cap of 1 is (?:still )?hard-?coded/i);
    expect(dispatcherDoc).not.toMatch(/hard-?coded[^.\n]*audit cap of 1(?!.*retired)/i);
    expect(dispatcherDoc).not.toMatch(/cap of 1 cannot be (?:configured|changed)/i);
    // The current contract is configurable.
    expect(dispatcherDoc).toContain('`maxAudit`');
  });
});

describe('herdr README downtime section is consistent with the budget', () => {
  it('documents the budget as machine-scoped and not a per-instance settings key', () => {
    expect(readme).toContain('Host-wide dispatch budget');
    expect(readme).toContain('machine-scoped ledger');
    expect(readme).toContain('not** a per-instance');
    expect(readme).toContain('drifts by');
  });

  it('documents the interactive dialog and the recorded override', () => {
    expect(readme).toContain('bottom-anchored dialog');
    expect(readme).toContain('cancel is the state on open');
    expect(readme).toContain('override: { by: "user" }');
    expect(readme).toContain('open_pane: false');
  });

  it('documents the env overrides in the configuration section', () => {
    expect(readme).toContain('HERDR_HOST_MAX_IMPLEMENT');
    expect(readme).toContain('HERDR_HOST_MAX_AUDIT');
  });

  it('does not present the audit single-flight as the only, hard-coded cap', () => {
    expect(readme).toContain('`maxAudit`');
    expect(readme).not.toMatch(/the audit cap is hard-?coded to 1/i);
  });
});

describe('CONFIG.md documents the host budget configuration', () => {
  it('documents the env vars, the budget.json file and its machine location', () => {
    expect(configDoc).toContain('HERDR_HOST_MAX_IMPLEMENT');
    expect(configDoc).toContain('HERDR_HOST_MAX_AUDIT');
    expect(configDoc).toContain('budget.json');
    expect(configDoc).toContain('~/.herdr/downtime');
  });

  it('documents defaults, clamps and the 0-per-tier kill switch', () => {
    expect(configDoc).toMatch(/`maxImplement`\s*\|\s*`2`/);
    expect(configDoc).toMatch(/`maxAudit`\s*\|\s*`1`/);
    expect(configDoc).toContain('0`–`32');
    expect(configDoc).toContain('kill switch');
  });
});

describe('proxy-derived audit admission is documented (WL-0MW95GBEG005ERHS)', () => {
  it('records the proxy-owned audit budget, the two reason tokens and the removal-side sibling item', () => {
    for (const token of [
      'audit-budget-saturated',
      'audit-budget-unknown',
      'audit-budget-divergence',
      'audit-budget-legacy',
      'LP-0MW95FYMH006XYNK',
    ]) {
      expect(dispatcherDoc).toContain(token);
    }
    expect(dispatcherDoc).toContain('HERDR_AUDIT_LOCAL_BUDGET');
    expect(dispatcherDoc).toContain('/llama/local/audit/status');
  });

  it('has a gate table with the proxy-derived audit rows and the one-release flag', () => {
    expect(dispatcherDoc).toMatch(/\| audit \| proxy availability read `available: true` \|/);
    expect(dispatcherDoc).toMatch(/\| audit \| proxy availability read `available: false` \|/);
    expect(dispatcherDoc).toMatch(
      /\| audit \| proxy read not `ok` — `endpoint-absent` \/ `unreachable` \/ `unparsable`/,
    );
    expect(dispatcherDoc).toContain(
      '| audit (one-release legacy path, `HERDR_AUDIT_LOCAL_BUDGET=1`)',
    );
    expect(dispatcherDoc).toContain('| audit (either path) |');
  });

  it('does not present budget.json maxAudit as the audit-admission authority', () => {
    // The machine-dir file table and the audit sections must say so explicitly.
    expect(dispatcherDoc).toContain('**not** the audit-admission authority');
    expect(dispatcherDoc).toContain('Audit entries are observability-only for admission');
    expect(configDoc).toContain('**not** the audit-admission authority');
    expect(configDoc).not.toMatch(/maxAudit`?\s*(?:is|as) the audit[- ]cap/i);
  });

  it('documents the machine-dir ledger audit entries as observability-only and the endpoint', () => {
    expect(dispatcherDoc).toMatch(
      /\| `~\/\.herdr\/downtime\/dispatch-budget\.json` \|.*observability-only for admission/,
    );
    expect(dispatcherDoc).toContain('GET {proxyUrl}/llama/local/audit/status');
    expect(dispatcherDoc).toContain('LP-0MW95FYMH006XYNK');
  });

  it('has an operator runbook for raising the audit cap and the one-release fallback', () => {
    expect(dispatcherDoc).toContain(
      "change the proxy's audit-budget configuration",
    );
    expect(dispatcherDoc).toContain('`HERDR_AUDIT_LOCAL_BUDGET=1` to restore');
    expect(dispatcherDoc).toContain('raising `budget.json` `maxAudit` has **no effect**');
  });

  it('records the removal release for the legacy flag', () => {
    expect(dispatcherDoc).toMatch(
      /removed in the release\s+> \*\*after\*\* the proxy side/s,
    );
  });

  it('supersedes the single-machine out-of-scope note in machine-coordination.ts', () => {
    expect(machineCoordination).not.toMatch(/multi-machine \(flock\/NFS\) is out of scope/i);
    expect(machineCoordination).toContain('cross-machine');
    expect(machineCoordination).toContain('proxy');
    expect(machineCoordination).toContain('Proxy-derived audit admission');
  });

  it('README documents the new flag and the proxy availability read', () => {
    expect(readme).toContain('HERDR_AUDIT_LOCAL_BUDGET');
    expect(readme).toContain('audit-budget-saturated');
    expect(readme).toContain('audit-budget-unknown');
    expect(readme).toContain('downtimeProxyUrl');
    expect(readme).toContain('proxy-derived');
    expect(readme).not.toMatch(/`maxAudit`, default `1`; see \*Host-wide dispatch budget\*/);
  });

  it('CONFIG.md documents the new flag, the proxy URL source and the non-authoritative cap', () => {
    expect(configDoc).toContain('HERDR_AUDIT_LOCAL_BUDGET');
    expect(configDoc).toContain('downtimeProxyUrl');
    expect(configDoc).toContain('audit-budget-saturated');
    expect(configDoc).toContain('audit-budget-unknown');
    expect(configDoc).toContain('proxy-owned budget');
  });
});
