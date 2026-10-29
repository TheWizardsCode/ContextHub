/**
 * `audit-fingerprint.schema-skew` — a **warning-level** `wl doctor` check
 * reporting a mismatch between the installed audit skill's fingerprint schema
 * and this repository's expectation (WL-0MVS2RAR5007CBD5).
 *
 * Why a doctor warning: a schema-1 (or undeclared) installed
 * `_compute_content_fingerprint` produces digests that can never match this
 * repository's schema-2 fingerprints, so every locally-recomputed fingerprint
 * looks stale and the audit badge shows a false "stale" result
 * (LP-0MVKSXR4P001V0CM). The parity test fails the developer's suite; this
 * check surfaces the same skew to every `wl doctor` user, with remediation.
 *
 * **No probe logic here.** The Python import probe, the environment checks and
 * the fail-on-skew policy all live in the shared
 * `src/audit-fingerprint-installed.ts` (`ok` / `skip` / `fail` outcome). This
 * module only turns a `fail` outcome into a doctor finding, so `wl doctor` and
 * the parity test can never disagree about what "skewed" means.
 *
 * Read-only: no DB mutation, no worklog write, no cache.
 */

import {
  AUDIT_CONTENT_FINGERPRINT_SCHEMA,
  evaluateInstalledContract,
  findAuditScripts,
  probeInstalledContract,
  pythonAvailable,
  type InstalledContract,
  type InstalledContractOutcome,
} from '../audit-fingerprint-installed.js';

/** Stable identifier for the doctor finding. */
export const AUDIT_FINGERPRINT_SKEW_CHECK_ID = 'audit-fingerprint.schema-skew';

/** Finding `type` used for the human "manual fixes" grouping. */
export const AUDIT_FINGERPRINT_SKEW_TYPE = 'audit-fingerprint-schema-skew';

/**
 * Operator remediation, shared by the message and the finding context so the
 * two can never drift.
 */
export const FINGERPRINT_SKEW_REMEDIATION =
  'reinstall the framework so the audit skill matches (scripts/install_pi.sh), ' +
  'or point AUDIT_SKILL_SCRIPTS at a compatible install';

/** A doctor finding — mirrors the shape of the existing `findings` entries. */
export interface AuditFingerprintSkewFinding {
  checkId: string;
  type: string;
  severity: 'warning';
  /** Global finding: not attached to a work item. */
  itemId: null;
  message: string;
  /** Warning only: never auto-fixable. */
  proposedFix: null;
  safe: false;
  context: {
    installedSchema: number | null;
    expectedSchema: number;
    scriptsDir: string | null;
    remediation: string;
    reason: string;
  };
}

/** Inputs for the pure finding builder (the installed contract is injected). */
export interface AuditFingerprintSkewContext {
  /** Contract returned by the shared probe (`null` when the import failed). */
  contract: InstalledContract | null;
  /** Directory the contract was read from, or `null` when not found. */
  scriptsDir: string | null;
  /** Expected schema; defaults to this repository's constant. */
  expectedSchema?: number;
}

/** Human label for the installed schema, `<none>` when undeclared. */
export function describeInstalledSchema(installedSchema: number | null): string {
  return installedSchema === null
    ? 'no declared _AUDIT_CONTENT_FINGERPRINT_SCHEMA (pre-v2 install)'
    : `schema ${installedSchema}`;
}

/**
 * Build the warning finding from an installed-contract outcome.
 *
 * Returns `null` — i.e. no finding — for:
 * - `ok` (installed helper matches this repository's contract),
 * - `skip` (environment unavailability: no scripts dir, no python3, or an
 *   unimportable module — `wl doctor` must stay green on such hosts),
 * - a `fail` that is **not** a schema skew (signature-only mismatch): this
 *   check reports schema skew, and the parity test owns signature drift.
 */
export function buildAuditFingerprintSkewFinding(
  outcome: InstalledContractOutcome,
  ctx: AuditFingerprintSkewContext,
): AuditFingerprintSkewFinding | null {
  const expectedSchema = ctx.expectedSchema ?? AUDIT_CONTENT_FINGERPRINT_SCHEMA;
  if (outcome.kind !== 'fail') return null;

  // The outcome carries the verdict; the contract carries the installed
  // version. Without a contract there is nothing version-shaped to report.
  const installedSchema = ctx.contract ? ctx.contract.schema : null;
  if (!ctx.contract || installedSchema === expectedSchema) return null;

  return {
    checkId: AUDIT_FINGERPRINT_SKEW_CHECK_ID,
    type: AUDIT_FINGERPRINT_SKEW_TYPE,
    severity: 'warning',
    itemId: null,
    message:
      `Installed audit skill at ${ctx.scriptsDir ?? '<unknown>'} declares ` +
      `${describeInstalledSchema(installedSchema)} but this repository expects ` +
      `fingerprint schema ${expectedSchema}: stored audit fingerprints will never ` +
      `match and audits will appear stale. Remediation: ${FINGERPRINT_SKEW_REMEDIATION}.`,
    proposedFix: null,
    safe: false,
    context: {
      installedSchema,
      expectedSchema,
      scriptsDir: ctx.scriptsDir,
      remediation: FINGERPRINT_SKEW_REMEDIATION,
      reason: outcome.reason,
    },
  };
}

/**
 * Run the shared probe once and return the findings `wl doctor` should emit
 * (`null` when there is nothing to report).
 *
 * Best-effort by contract: any unexpected probe error degrades to "no finding"
 * so `wl doctor`'s exit status and output are never affected by this check.
 */
export function probeAuditFingerprintSkewFinding(): AuditFingerprintSkewFinding | null {
  try {
    const expectedSchema = AUDIT_CONTENT_FINGERPRINT_SCHEMA;
    const scriptsDir = findAuditScripts();
    if (!scriptsDir) {
      return buildAuditFingerprintSkewFinding(
        evaluateInstalledContract(null, null, expectedSchema),
        { contract: null, scriptsDir: null, expectedSchema },
      );
    }

    const contract = probeInstalledContract(scriptsDir);
    // A `null` contract means either python3 or the module is unavailable;
    // probe python3 only in that case to keep the happy path at one subprocess.
    const pythonOk = contract !== null || pythonAvailable();
    const outcome = evaluateInstalledContract(contract, scriptsDir, expectedSchema, pythonOk);
    return buildAuditFingerprintSkewFinding(outcome, { contract, scriptsDir, expectedSchema });
  } catch {
    return null;
  }
}
