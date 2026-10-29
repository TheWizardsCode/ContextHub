/**
 * `wl doctor`'s `audit-fingerprint.schema-skew` warning
 * (WL-0MVS2RAR5007CBD5).
 *
 * Unit matrix: the finding builder is pure and takes the shared probe's
 * `ok`/`skip`/`fail` outcome plus the injected installed contract, so every
 * branch is exercised **without spawning Python**. The single CLI test pins the
 * end-to-end behaviour on this schema-2 host: no skew finding is emitted and
 * `wl doctor` succeeds in both human and `--json` mode.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  AUDIT_CONTENT_FINGERPRINT_SCHEMA,
  evaluateInstalledContract,
  type InstalledContract,
  type InstalledContractOutcome,
} from '../src/audit-fingerprint-installed.js';
import {
  AUDIT_FINGERPRINT_SKEW_CHECK_ID,
  AUDIT_FINGERPRINT_SKEW_TYPE,
  FINGERPRINT_SKEW_REMEDIATION,
  buildAuditFingerprintSkewFinding,
  describeInstalledSchema,
} from '../src/doctor/audit-fingerprint-skew-check.js';
import {
  cliPath,
  execAsync,
  enterTempDir,
  leaveTempDir,
  writeConfig,
  writeInitSemaphore,
  seedWorkItems,
} from './cli/cli-helpers.js';

const EXPECTED = AUDIT_CONTENT_FINGERPRINT_SCHEMA;
const SCRIPTS_DIR = '/tmp/audit-skill/scripts';

/** An installed contract whose signature satisfies the shared probe. */
const compatibleContract = (schema: number | null): InstalledContract => ({
  schema,
  params: ['runner', 'issue_id', 'worklog_dir', 'work_item'],
});

/** Outcome the shared probe produces for an installed contract. */
function outcomeFor(
  contract: InstalledContract | null,
  opts: { scriptsDir?: string | null; pythonOk?: boolean; expected?: number } = {},
): InstalledContractOutcome {
  return evaluateInstalledContract(
    contract,
    opts.scriptsDir === undefined ? SCRIPTS_DIR : opts.scriptsDir,
    opts.expected ?? EXPECTED,
    opts.pythonOk ?? true,
  );
}

describe('audit-fingerprint.schema-skew finding', () => {
  it('warns when the installed schema is behind the expected schema', () => {
    const behind = EXPECTED - 1;
    const contract = compatibleContract(behind);
    const finding = buildAuditFingerprintSkewFinding(outcomeFor(contract), {
      contract,
      scriptsDir: SCRIPTS_DIR,
    });

    expect(finding).not.toBeNull();
    expect(finding!.checkId).toBe(AUDIT_FINGERPRINT_SKEW_CHECK_ID);
    expect(finding!.checkId).toBe('audit-fingerprint.schema-skew');
    expect(finding!.type).toBe(AUDIT_FINGERPRINT_SKEW_TYPE);
    expect(finding!.severity).toBe('warning');
    // Global finding, never auto-fixable: `wl doctor --fix` must not touch it.
    expect(finding!.itemId).toBeNull();
    expect(finding!.proposedFix).toBeNull();
    expect(finding!.safe).toBe(false);

    // Message names the installed schema, the expected schema, and remediation.
    expect(finding!.message).toContain(`schema ${behind}`);
    expect(finding!.message).toContain(`schema ${EXPECTED}`);
    expect(finding!.message).toContain(SCRIPTS_DIR);
    expect(finding!.message).toContain(FINGERPRINT_SKEW_REMEDIATION);

    expect(finding!.context).toMatchObject({
      installedSchema: behind,
      expectedSchema: EXPECTED,
      scriptsDir: SCRIPTS_DIR,
      remediation: FINGERPRINT_SKEW_REMEDIATION,
    });
    expect(typeof finding!.context.reason).toBe('string');
  });

  it('warns when the installed schema is ahead of the expected schema', () => {
    const ahead = EXPECTED + 1;
    const contract = compatibleContract(ahead);
    const finding = buildAuditFingerprintSkewFinding(outcomeFor(contract), {
      contract,
      scriptsDir: SCRIPTS_DIR,
    });

    expect(finding).not.toBeNull();
    expect(finding!.context.installedSchema).toBe(ahead);
    expect(finding!.context.expectedSchema).toBe(EXPECTED);
    expect(finding!.message).toContain(`schema ${ahead}`);
  });

  it('warns when the installed skill declares no schema at all', () => {
    const contract = compatibleContract(null);
    const finding = buildAuditFingerprintSkewFinding(outcomeFor(contract), {
      contract,
      scriptsDir: SCRIPTS_DIR,
    });

    expect(finding).not.toBeNull();
    expect(finding!.context.installedSchema).toBeNull();
    expect(finding!.context.expectedSchema).toBe(EXPECTED);
    expect(finding!.message).toContain('no declared _AUDIT_CONTENT_FINGERPRINT_SCHEMA');
    expect(finding!.message).toContain(`schema ${EXPECTED}`);
    expect(finding!.message).toContain(FINGERPRINT_SKEW_REMEDIATION);
  });

  it('emits nothing when the installed schema matches', () => {
    const contract = compatibleContract(EXPECTED);
    expect(outcomeFor(contract).kind).toBe('ok');
    expect(
      buildAuditFingerprintSkewFinding(outcomeFor(contract), {
        contract,
        scriptsDir: SCRIPTS_DIR,
      }),
    ).toBeNull();
  });

  it('emits nothing when the environment is unavailable (skip)', () => {
    // No scripts dir.
    const noDir = outcomeFor(null, { scriptsDir: null });
    expect(noDir.kind).toBe('skip');
    expect(
      buildAuditFingerprintSkewFinding(noDir, { contract: null, scriptsDir: null }),
    ).toBeNull();

    // No python3 on PATH.
    const noPython = outcomeFor(null, { pythonOk: false });
    expect(noPython.kind).toBe('skip');
    expect(
      buildAuditFingerprintSkewFinding(noPython, { contract: null, scriptsDir: SCRIPTS_DIR }),
    ).toBeNull();

    // Scripts dir present but the module cannot be imported.
    const noImport = outcomeFor(null);
    expect(noImport.kind).toBe('skip');
    expect(
      buildAuditFingerprintSkewFinding(noImport, { contract: null, scriptsDir: SCRIPTS_DIR }),
    ).toBeNull();
  });

  it('emits nothing for a signature-only failure (not a schema skew)', () => {
    const contract: InstalledContract = { schema: EXPECTED, params: ['runner', 'issue_id'] };
    const outcome = outcomeFor(contract);
    expect(outcome.kind).toBe('fail');
    expect(
      buildAuditFingerprintSkewFinding(outcome, { contract, scriptsDir: SCRIPTS_DIR }),
    ).toBeNull();
  });

  it('compares against the injected expected schema', () => {
    // With an injected expectation of 7, a schema-7 install is clean...
    const matching = compatibleContract(7);
    expect(
      buildAuditFingerprintSkewFinding(
        outcomeFor(matching, { expected: 7 }),
        { contract: matching, scriptsDir: SCRIPTS_DIR, expectedSchema: 7 },
      ),
    ).toBeNull();

    // ...and a schema-EXPECTED install now skews, reporting the injected value.
    const current = compatibleContract(EXPECTED);
    const finding = buildAuditFingerprintSkewFinding(
      outcomeFor(current, { expected: 7 }),
      { contract: current, scriptsDir: SCRIPTS_DIR, expectedSchema: 7 },
    );
    expect(finding).not.toBeNull();
    expect(finding!.context.expectedSchema).toBe(7);
    expect(finding!.context.installedSchema).toBe(EXPECTED);
  });

  it('describes an undeclared schema explicitly', () => {
    expect(describeInstalledSchema(3)).toBe('schema 3');
    expect(describeInstalledSchema(null)).toContain('no declared');
  });
});

describe('wl doctor audit-fingerprint skew (CLI, schema-2 host)', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
    // A clean database: the only possible finding is the global skew warning,
    // so the absence assertions below are meaningful.
    seedWorkItems(tempState.tempDir, [
      { id: 'TEST-OK', title: 'Clean item', status: 'open', stage: 'idea' },
    ]);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  it('emits no skew finding in --json or human output', async () => {
    // AC3/AC4 on this host: the installed skill declares schema 2 (or is
    // unavailable, which is a skip) — either way `wl doctor` stays quiet.
    const json = await execAsync(`tsx ${cliPath} --json doctor`);
    const findings = JSON.parse(json.stdout) as Array<Record<string, unknown>>;
    expect(Array.isArray(findings)).toBe(true);
    expect(
      findings.filter(f => f.checkId === AUDIT_FINGERPRINT_SKEW_CHECK_ID),
    ).toEqual([]);

    // Human output: no global-heading skew entry, and the command succeeds.
    const human = await execAsync(`tsx ${cliPath} doctor`);
    expect(human.stdout).not.toContain(FINGERPRINT_SKEW_REMEDIATION);
    expect(human.stdout).not.toContain('(global)');
  });
});
