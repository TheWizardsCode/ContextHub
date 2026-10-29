/**
 * Probe for the installed audit skill's fingerprint implementation and
 * evaluate whether it is compatible with this repository's expectations.
 *
 * Contract: the installed skill's `_compute_content_fingerprint` must
 * implement the same schema version (`_AUDIT_CONTENT_FINGERPRINT_SCHEMA`)
 * and accept the documented `work_item` parameter.  A **schema skew** —
 * declared schema different from the expected one — is a **hard failure**
 * because a stale or ahead fingerprint algorithm cannot be trusted to
 * produce comparable digests.  An **undeclared schema** (pre-v2 install)
 * is also a hard failure: without a version number the installed algorithm
 * cannot be proven compatible (fail-safe).
 *
 * Genuine **environment unavailability** (no scripts dir, no python3, or
 * unimportable module) remains a **skip** so CI images stay green.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** The fingerprint schema version this repository implements. */
export { AUDIT_CONTENT_FINGERPRINT_SCHEMA } from './audit-fingerprint.js';

/* ------------------------------------------------------------------ */
/*  Public contract & outcome model                                   */
/* ------------------------------------------------------------------ */

/** Contract of the INSTALLED helper: schema constant and signature. */
export interface InstalledContract {
  schema: number | null;
  params: string[];
}

/** Discriminated outcome of the installed-skill probe. */
export type InstalledContractOutcome =
  | { kind: 'ok'; contract: InstalledContract }
  | { kind: 'skip'; reason: string }
  | { kind: 'fail'; reason: string };

/* ------------------------------------------------------------------ */
/*  Helpers — environment probes                                      */
/* ------------------------------------------------------------------ */

/** Locate the installed audit skill's scripts directory (or null). */
export function findAuditScripts(): string | null {
  const candidates = [
    process.env.AUDIT_SKILL_SCRIPTS,
    path.join(os.homedir(), '.pi', 'agent', 'skills', 'audit', 'scripts'),
    path.join(process.cwd(), '..', 'SorraAgents', 'skill', 'audit', 'scripts'),
  ].filter((p): p is string => Boolean(p));
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'audit_runner.py'))) return dir;
  }
  return null;
}

export function pythonAvailable(): boolean {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe the installed audit skill for its schema version and function
 * signature via a tiny inline Python script.
 *
 * Returns `null` when the module cannot be imported or the function is
 * absent — this is an *environment* issue, not a schema mismatch.
 */
export function probeInstalledContract(
  scriptsDir: string,
): InstalledContract | null {
  const probe = [
    'import inspect, json, sys',
    'sys.path.insert(0, sys.argv[1])',
    'import audit_runner as ar',
    'fn = getattr(ar, "_compute_content_fingerprint", None)',
    'print(json.dumps({',
    '    "schema": getattr(ar, "_AUDIT_CONTENT_FINGERPRINT_SCHEMA", None),',
    '    "params": list(inspect.signature(fn).parameters) if fn else [],',
    '    "available": fn is not None,',
    '}))',
  ].join('\n');
  try {
    const out = execFileSync('python3', ['-c', probe, scriptsDir], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const parsed = JSON.parse(out) as InstalledContract & { available?: boolean };
    if (parsed.available === false) return null;
    return { schema: parsed.schema ?? null, params: parsed.params ?? [] };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Public evaluation — fail-on-skew policy                           */
/* ------------------------------------------------------------------ */

/**
 * Decide whether the installed helper can be compared with this
 * repository's implementation.
 *
 * **Fail-on-skew:** any declared schema different from the expected one
 * is a hard **failure** (not a skip).  An undeclared schema (null) is
 * also a failure because the algorithm cannot be proven compatible.
 *
 * Genuine **environment unavailability** — no scripts dir, no python3,
 * or unimportable module — returns a **skip** with a descriptive reason.
 *
 * Returns `null` only when the helper matches the contract exactly.
 */
export function evaluateInstalledContract(
  contract: InstalledContract | null,
  scriptsDir: string | null,
  expectedSchema: number,
  pythonOk = true,
): InstalledContractOutcome {
  // --- environment: skip ---
  if (!scriptsDir) {
    return {
      kind: 'skip',
      reason:
        'installed audit skill not found (set AUDIT_SKILL_SCRIPTS to its scripts dir)',
    };
  }
  if (!pythonOk) {
    return { kind: 'skip', reason: 'python3 not available on PATH' };
  }
  if (!contract) {
    return {
      kind: 'skip',
      reason: `could not import _compute_content_fingerprint from ${scriptsDir}`,
    };
  }

  // --- signature check: fail ---
  if (!contract.params.includes('work_item')) {
    return {
      kind: 'fail',
      reason:
        `installed audit skill signature (${contract.params.join(', ') || '<none>'}) ` +
        `cannot accept work_item= — update the framework install ` +
        `(scripts/install_pi.sh) or set AUDIT_SKILL_SCRIPTS`,
    };
  }

  // --- schema check: fail-on-skew ---
  if (contract.schema !== expectedSchema) {
    // `contract.schema` comes from the installed skill's
    // `_AUDIT_CONTENT_FINGERPRINT_SCHEMA` constant — null means the lookup
    // found no declared schema (pre-v2 install), which cannot be proven
    // compatible (fail-safe: never claim parity on unprovable data).
    const installed =
      contract.schema === null
        ? `no declared _AUDIT_CONTENT_FINGERPRINT_SCHEMA (lookup returned <none>)`
        : `schema ${contract.schema}`;
    return {
      kind: 'fail',
      reason:
        `installed audit skill at ${scriptsDir} implements ${installed} ` +
        `but this repository expects schema ` +
        `${expectedSchema} — reinstall via scripts/install_pi.sh or set AUDIT_SKILL_SCRIPTS`,
    };
  }

  // --- all clear ---
  return { kind: 'ok', contract };
}
