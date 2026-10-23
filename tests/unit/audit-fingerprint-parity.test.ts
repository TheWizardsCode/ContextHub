/**
 * Byte-for-byte parity between the TypeScript canonical content fingerprint
 * and the audit skill's Python implementation
 * (`audit_runner._compute_content_fingerprint`) — WL-0MUN7QWFP0010EQC,
 * schema 2 in WL-0MVK5SWZE00254Y7.
 *
 * The TS port exists so `wl list` can emit `currentFingerprint` without a
 * runtime Python dependency; this test guards against drift by computing the
 * same fingerprint both ways for the same work item. Since schema 2 hashes
 * only the item's own title/description, no git repository is needed.
 *
 * The installed audit skill is a symlink into the agent framework
 * (`~/projects/SorraAgents/skill/audit`), so its contract can legitimately
 * move ahead of (or behind) this repository between installs. A *skew* — the
 * helper is missing, implements a different schema, or cannot accept the
 * documented call — is therefore reported as an explicit, actionable `skip`
 * naming the installed path/schema/signature instead of masquerading as a
 * code regression. At the SAME schema, any digest mismatch still fails.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AUDIT_CONTENT_FINGERPRINT_SCHEMA,
  computeContentFingerprint,
} from '../../src/audit-fingerprint.js';
import { createTempDir, cleanupTempDir } from '../test-utils.js';

/** Contract of the INSTALLED helper: schema constant and signature. */
export interface InstalledContract {
  schema: number | null;
  params: string[];
}

/** Locate the installed audit skill's scripts directory (or null). */
function findAuditScripts(): string | null {
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

function pythonAvailable(): boolean {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide whether the installed helper can be compared with this repository's
 * implementation.
 *
 * Returns `null` when it can, or an actionable skip reason naming what is
 * installed and how to remediate it. Kept pure so the skew policy itself is
 * unit-tested deterministically (a skew must skip, never fail).
 */
export function evaluateInstalledContract(
  contract: InstalledContract | null,
  scriptsDir: string | null,
  expectedSchema: number,
  pythonOk = true,
): string | null {
  if (!scriptsDir) {
    return 'installed audit skill not found (set AUDIT_SKILL_SCRIPTS to its scripts dir)';
  }
  if (!pythonOk) return 'python3 not available on PATH';
  if (!contract) {
    return `could not import _compute_content_fingerprint from ${scriptsDir}`;
  }
  if (!contract.params.includes('work_item')) {
    return (
      `installed audit skill signature (${contract.params.join(', ') || '<none>'}) ` +
      `cannot accept work_item= — update the framework install ` +
      `(scripts/install_pi.sh) or set AUDIT_SKILL_SCRIPTS`
    );
  }
  if (contract.schema !== expectedSchema) {
    return (
      `installed audit skill at ${scriptsDir} implements schema ` +
      `${contract.schema ?? '<none>'} but this repository expects schema ` +
      `${expectedSchema} — update the framework install (scripts/install_pi.sh)`
    );
  }
  return null;
}

function probeInstalledContract(scriptsDir: string): InstalledContract | null {
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

const AUDIT_SCRIPTS = findAuditScripts();
const PYTHON = pythonAvailable();
const CONTRACT = AUDIT_SCRIPTS && PYTHON ? probeInstalledContract(AUDIT_SCRIPTS) : null;
const SKEW = evaluateInstalledContract(
  CONTRACT,
  AUDIT_SCRIPTS,
  AUDIT_CONTENT_FINGERPRINT_SCHEMA,
  PYTHON,
);

describe('installed-audit-skill skew policy', () => {
  const expected = AUDIT_CONTENT_FINGERPRINT_SCHEMA;

  it('runs the parity check when the installed helper matches the contract', () => {
    expect(
      evaluateInstalledContract(
        { schema: expected, params: ['runner', 'issue_id', 'worklog_dir', 'work_item'] },
        '/tmp/audit/scripts',
        expected,
      ),
    ).toBeNull();
  });

  it('skips with the installed schema when the helper is ahead or behind', () => {
    const reason = evaluateInstalledContract(
      { schema: 1, params: ['runner', 'issue_id', 'worklog_dir', 'work_item'] },
      '/tmp/audit/scripts',
      expected,
    );
    expect(reason).toContain('schema 1');
    expect(reason).toContain(`schema ${expected}`);
    expect(reason).toContain('/tmp/audit/scripts');
    expect(reason).toContain('install_pi.sh');
  });

  it('skips with the installed signature when it cannot accept work_item=', () => {
    const reason = evaluateInstalledContract(
      { schema: expected, params: ['runner', 'issue_id'] },
      '/tmp/audit/scripts',
      expected,
    );
    expect(reason).toContain('cannot accept work_item=');
    expect(reason).toContain('runner, issue_id');
  });

  it('skips (never fails) when the skill or python is missing', () => {
    expect(evaluateInstalledContract(null, null, expected)).toContain('not found');
    expect(evaluateInstalledContract(null, '/tmp/audit/scripts', expected, false)).toContain(
      'python3',
    );
    expect(evaluateInstalledContract(null, '/tmp/audit/scripts', expected)).toContain(
      'could not import',
    );
  });
});

describe('canonical fingerprint parity (TS vs audit skill Python)', () => {
  it.skipIf(SKEW !== null)(
    'produces the same digest as audit_runner._compute_content_fingerprint',
    () => {
      const description = [
        '## Summary',
        'Parity fixture.',
        '## Key Files',
        '- `implementation.ts`',
      ].join('\n');
      const workItem = { id: 'CFP-PARITY001', title: 'Parity fixture title', description };

      const dir = createTempDir();
      try {
        const workItemFile = path.join(dir, 'work-item.json');
        fs.writeFileSync(workItemFile, JSON.stringify(workItem));

        const script = path.join(dir, 'parity.py');
        fs.writeFileSync(
          script,
          [
            'import json, sys',
            'sys.path.insert(0, sys.argv[2])',
            'import audit_runner as ar',
            'work_item = json.loads(open(sys.argv[1]).read())',
            'print(json.dumps({',
            '    "fingerprint": ar._compute_content_fingerprint(',
            '        None, work_item["id"], work_item=work_item),',
            '}))',
          ].join('\n'),
        );

        const pythonOut = JSON.parse(
          execFileSync('python3', [script, workItemFile, AUDIT_SCRIPTS as string], {
            encoding: 'utf8',
          }).trim(),
        ) as { fingerprint: string | null };

        const tsOut = computeContentFingerprint({
          title: workItem.title,
          description: workItem.description,
        });

        expect(pythonOut.fingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(tsOut).toBe(pythonOut.fingerprint);
      } finally {
        cleanupTempDir(dir);
      }
    },
  );
});
