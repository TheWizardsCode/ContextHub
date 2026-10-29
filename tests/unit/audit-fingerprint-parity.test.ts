/**
 * Byte-for-byte parity between the TypeScript canonical content fingerprint
 * and the audit skill's Python implementation
 * (`audit_runner._compute_content_fingerprint`) — WL-0MUN7QWFP0010EQC,
 * schema 2 in WL-0MVK5SWZE00254Y7.
 *
 * The TS port exists so `wl list` can emit `currentFingerprint` without a
 * runtime Python dependency; this test guards against drift by computing
 * the same fingerprint both ways for the same work item. Since schema 2 hashes
 * only the item's own title/description, no git repository is needed.
 *
 * **Fail-on-skew contract:** a schema version mismatch between the installed
 * audit skill and this repository is a **hard failure** (not a skip) because a
 * stale or ahead fingerprint algorithm cannot be trusted.  An undeclared
 * schema (pre-v2 install) is also a failure — the algorithm cannot be proven
 * compatible (fail-safe) — and a helper whose signature cannot accept
 * `work_item=` fails too.  Genuine environment unavailability (no scripts
 * dir, no python3, or unimportable module) remains a **skip** so CI images
 * stay green.  At the same schema, any digest mismatch still fails.
 *
 * The probe lives in `src/audit-fingerprint-installed.ts` and is shared with
 * `wl doctor`'s `audit-fingerprint.schema-skew` warning, so the two cannot
 * disagree about what "skewed" means; remediation is documented in
 * `docs/dev/audit-fingerprint.md` § "Parity check and host tooling skew".
 *
 * The policy is only *enforced* by the live-host gate below: probing the
 * installed helper and then quietly skipping the digest comparison is exactly
 * how a skewed install shipped green and produced the false-stale audit badge
 * (LP-0MVKSXR4P001V0CM). A `fail` outcome now turns this file red on the
 * machine running the suite (WL-0MVOE11V60050Q6Y AC1/AC2).
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  computeContentFingerprint,
  canonicalJson,
  sha256Hex,
} from '../../src/audit-fingerprint.js';
import {
  AUDIT_CONTENT_FINGERPRINT_SCHEMA,
  findAuditScripts,
  pythonAvailable,
  probeInstalledContract,
  evaluateInstalledContract,
  type InstalledContractOutcome,
} from '../../src/audit-fingerprint-installed.js';
import { isAuditFresh } from '@worklog/shared/icons';
import { createTempDir, cleanupTempDir } from '../test-utils.js';

const AUDIT_SCRIPTS = findAuditScripts();
const PYTHON = pythonAvailable();
const CONTRACT = AUDIT_SCRIPTS && PYTHON ? probeInstalledContract(AUDIT_SCRIPTS) : null;
const OUTCOME = evaluateInstalledContract(
  CONTRACT,
  AUDIT_SCRIPTS,
  AUDIT_CONTENT_FINGERPRINT_SCHEMA,
  PYTHON,
);

/**
 * Decision of the live-host gate: `null` means the suite may proceed, a string
 * is the loud, actionable failure the suite must report.
 *
 * Kept pure so the fail-on-skew contract is pinned deterministically — CI
 * cannot be handed a skewed host on demand — while the live test below applies
 * it to the machine actually running the suite.
 */
function liveHostSkewFailure(
  outcome: InstalledContractOutcome,
): string | null {
  return outcome.kind === 'fail' ? outcome.reason : null;
}

describe('installed-audit-skill skew policy', () => {
  const expected = AUDIT_CONTENT_FINGERPRINT_SCHEMA;

  it('returns ok when the installed helper matches the contract', () => {
    const result = evaluateInstalledContract(
      { schema: expected, params: ['runner', 'issue_id', 'worklog_dir', 'work_item'] },
      '/tmp/audit/scripts',
      expected,
    );
    expect(result.kind).toBe('ok');
  });

  it('fails when the helper is ahead of the expected schema', () => {
    const ahead = expected + 1;
    const outcome = evaluateInstalledContract(
      { schema: ahead, params: ['runner', 'issue_id', 'worklog_dir', 'work_item'] },
      '/tmp/audit/scripts',
      expected,
    );
    expect(outcome.kind).toBe('fail');
    expect((outcome as { kind: 'fail'; reason: string }).reason).toContain(
      `schema ${ahead}`,
    );
    expect((outcome as { kind: 'fail'; reason: string }).reason).toContain(
      `schema ${expected}`,
    );
    expect((outcome as { kind: 'fail'; reason: string }).reason).toContain(
      '/tmp/audit/scripts',
    );
    expect((outcome as { kind: 'fail'; reason: string }).reason).toContain(
      'install_pi.sh',
    );
  });

  it('fails when the helper is behind the expected schema', () => {
    const behind = expected - 1;
    const outcome = evaluateInstalledContract(
      { schema: behind, params: ['runner', 'issue_id', 'worklog_dir', 'work_item'] },
      '/tmp/audit/scripts',
      expected,
    );
    expect(outcome.kind).toBe('fail');
    expect((outcome as { kind: 'fail'; reason: string }).reason).toContain(
      `schema ${behind}`,
    );
    expect((outcome as { kind: 'fail'; reason: string }).reason).toContain(
      `schema ${expected}`,
    );
    expect((outcome as { kind: 'fail'; reason: string }).reason).toContain(
      '/tmp/audit/scripts',
    );
    expect((outcome as { kind: 'fail'; reason: string }).reason).toContain(
      'install_pi.sh',
    );
  });

  it('fails when the schema is undeclared (pre-v2 install)', () => {
    const outcome = evaluateInstalledContract(
      { schema: null, params: ['runner', 'issue_id', 'worklog_dir', 'work_item'] },
      '/tmp/audit/scripts',
      expected,
    );
    expect(outcome.kind).toBe('fail');
    expect((outcome as { kind: 'fail'; reason: string }).reason).toContain('<none>');
    expect((outcome as { kind: 'fail'; reason: string }).reason).toContain(
      `schema ${expected}`,
    );
  });

  it('fails with the installed signature when it cannot accept work_item=', () => {
    const outcome = evaluateInstalledContract(
      { schema: expected, params: ['runner', 'issue_id'] },
      '/tmp/audit/scripts',
      expected,
    );
    expect(outcome.kind).toBe('fail');
    expect((outcome as { kind: 'fail'; reason: string }).reason).toContain(
      'cannot accept work_item=',
    );
    expect((outcome as { kind: 'fail'; reason: string }).reason).toContain(
      'runner, issue_id',
    );
  });

  it('fails the live-host gate on every skew, and only on a skew', () => {
    const params = ['runner', 'issue_id', 'worklog_dir', 'work_item'];

    // Environment unavailability: unverifiable, so the gate stays quiet (CI
    // images without the agent framework keep passing).
    expect(
      liveHostSkewFailure(evaluateInstalledContract(null, null, expected)),
    ).toBeNull();
    expect(
      liveHostSkewFailure(
        evaluateInstalledContract(null, '/tmp/audit/scripts', expected, false),
      ),
    ).toBeNull();

    // A matching helper passes.
    expect(
      liveHostSkewFailure(
        evaluateInstalledContract(
          { schema: expected, params },
          '/tmp/audit/scripts',
          expected,
        ),
      ),
    ).toBeNull();

    // Ahead, behind and undeclared schemas all fail the gate with the
    // actionable probe message (installed schema, expected schema, scripts
    // dir, remediation) — never a silent skip.
    for (const schema of [expected + 1, expected - 1, null]) {
      const reason = liveHostSkewFailure(
        evaluateInstalledContract(
          { schema, params },
          '/tmp/audit/scripts',
          expected,
        ),
      );
      expect(reason, `schema ${String(schema)} must fail the gate`).toContain(
        '/tmp/audit/scripts',
      );
      expect(reason).toContain(`schema ${expected}`);
      expect(reason).toContain('install_pi.sh');
    }
  });

  it('skips (never fails) when the skill or python is missing', () => {
    const r1 = evaluateInstalledContract(null, null, expected);
    expect(r1.kind).toBe('skip');
    expect((r1 as { kind: 'skip'; reason: string }).reason).toContain('not found');

    const r2 = evaluateInstalledContract(null, '/tmp/audit/scripts', expected, false);
    expect(r2.kind).toBe('skip');
    expect((r2 as { kind: 'skip'; reason: string }).reason).toContain('python3');

    const r3 = evaluateInstalledContract(null, '/tmp/audit/scripts', expected);
    expect(r3.kind).toBe('skip');
    expect((r3 as { kind: 'skip'; reason: string }).reason).toContain('could not import');
  });
});

/**
 * Live-host enforcement of the fail-on-skew contract
 * (WL-0MVOE11V60050Q6Y AC1/AC2).
 *
 * The matrix above proves the *policy*; this block makes it bite on the host
 * running the suite. A skewed install must turn this file **red** with the
 * probe's actionable message instead of the digest comparison quietly
 * skipping — the exact silence that let a schema-1 host ship a false-stale
 * audit badge (LP-0MVKSXR4P001V0CM). Environment unavailability remains a
 * skip (AC3): CI images without the agent framework stay green.
 */
describe('live installed audit skill (fail-on-skew)', () => {
  it('passes only when the installed helper matches or is unverifiable', () => {
    // Failing here means this host's installed audit skill is skewed. The
    // remediation is in the message: reinstall the framework
    // (`cd ~/projects/SorraAgents && git pull && scripts/install_pi.sh`) or
    // point AUDIT_SKILL_SCRIPTS at a schema-2 install.
    expect(
      liveHostSkewFailure(OUTCOME),
      `installed audit skill at ${AUDIT_SCRIPTS ?? '<not found>'}`,
    ).toBeNull();
  });
});

describe('canonical fingerprint parity (TS vs audit skill Python)', () => {
  it('documents that a schema-1 report fingerprint can never match schema-2', () => {
    // A pre-v2 (schema 1) audit stored its digest under the OLD payload:
    //   sha256( json.dumps({
    //     "path_states":      { <touched path>: {"head","worktree"} },
    //     "description_hash": sha256(description),
    //     "key_files":        [ ...Key Files from the description... ],
    //   }, sort_keys=True) )
    // with raw `description` (no title, no schema version).  Schema 2 hashes
    // ONLY title_hash + description_hash under an explicit `"schema": 2`
    // key — a different arrangement for the same content — so a stored
    // schema-1 digest can never validate against the current
    // `computeContentFingerprint` (fail-safe degradation to the time gate
    // until the next audit).  This is the observed failure behind treating
    // an undeclared pre-v2 schema as a hard skew.
    const title = 'Parity fixture title';
    const description = [
      '## Summary',
      'Parity fixture.',
      '## Key Files',
      '- `implementation.ts`',
    ].join('\n');
    const keyFiles = ['implementation.ts'];
    const schema1Payload = canonicalJson({
      path_states: {
        'implementation.ts': { head: 'abc123', worktree: '' },
      },
      description_hash: sha256Hex(description),
      key_files: keyFiles,
    });
    const schema1Digest = sha256Hex(schema1Payload);

    const schema2Digest = computeContentFingerprint({ title, description });

    expect(schema2Digest).toMatch(/^[0-9a-f]{64}$/);
    // Same title/description, different schema: the stored digest NEVER
    // matches the current one — the incompatibility is structural, not a
    // content change.
    expect(schema1Digest).not.toBe(schema2Digest);
  });

  it.skipIf(OUTCOME.kind !== 'ok')(
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

/**
 * A fingerprint-schema skew must never read as fresh (WL-0MVS2PQ7C005IFA2).
 *
 * Before the schema-2 port (WL-0MVK5SWZE00254Y7) an audit stored its
 * fingerprint under the pre-v2 payload
 * `{path_states, description_hash, key_files}` (verified against
 * `git show 213a96b7^:src/audit-fingerprint.ts`). The current
 * `computeContentFingerprint` emits `{schema: 2, title_hash,
 * description_hash}` instead, so an audit persisted by the old algorithm can
 * never match the current digest for unchanged content — the false-stale
 * badge reported in LP-0MVKSXR4P001V0CM.
 *
 * The tests are self-contained: the item fixture and both digests are built
 * in-test with the canonical-JSON/SHA-256 utilities (no DB, no git, no
 * Python, no live worklog data), because this repository currently holds no
 * fingerprint-bearing audits from before the port.
 */
describe('fingerprint schema skew is never fresh (WL-0MVS2PQ7C005IFA2)', () => {
  const title = 'Freshness skew fixture title';
  const description = [
    '## Summary',
    'Freshness skew fixture.',
    '## Key Files',
    '- `src/fixture.ts`',
  ].join('\n');
  const keyFiles = ['src/fixture.ts'];

  // `auditedAt` is deliberately AFTER `updatedAt`: the legacy 60 s time gate
  // would call this audit fresh, so only the fingerprint comparison can make
  // the skew read as stale.
  const auditedAt = '2026-10-20T12:00:00.000Z';
  const updatedAt = '2026-10-20T11:00:00.000Z';

  /** The pre-v2 payload, reproduced because its emitter no longer exists. */
  function schema1Fingerprint(): string {
    return sha256Hex(
      canonicalJson({
        path_states: {
          'src/fixture.ts': { head: 'abc123', worktree: '' },
        },
        description_hash: sha256Hex(description),
        key_files: keyFiles,
      }),
    );
  }

  it('reads an identical schema-2 fingerprint as fresh', () => {
    const storedSchema2 = computeContentFingerprint({ title, description });
    const currentSchema2 = computeContentFingerprint({ title, description });

    expect(storedSchema2).toMatch(/^[0-9a-f]{64}$/);
    expect(isAuditFresh(auditedAt, updatedAt, storedSchema2, currentSchema2)).toBe(true);
  });

  it('reads a stored schema-1 fingerprint as stale, so a schema skew is never fresh', () => {
    const storedSchema1 = schema1Fingerprint();
    const currentSchema2 = computeContentFingerprint({ title, description });

    // Same content, different schema: the digests differ structurally, not
    // because anything about the item changed.
    expect(storedSchema1).toMatch(/^[0-9a-f]{64}$/);
    expect(storedSchema1).not.toBe(currentSchema2);
    expect(isAuditFresh(auditedAt, updatedAt, storedSchema1, currentSchema2)).toBe(false);
  });

  it('is a bare string compare, so the 60 s time gate cannot rescue a skew', () => {
    const storedSchema1 = schema1Fingerprint();
    const currentSchema2 = computeContentFingerprint({ title, description });

    // Without fingerprints the same timestamps read as fresh (time gate).
    expect(isAuditFresh(auditedAt, updatedAt)).toBe(true);
    // With both fingerprints present the string compare decides: no
    // tolerance and no time-gate fallback, so the skew stays stale.
    expect(isAuditFresh(auditedAt, updatedAt, storedSchema1, currentSchema2)).toBe(false);

    // A matching fingerprint is fresh even when `updatedAt` post-dates the
    // audit by far more than the tolerance, proving the comparison ignores
    // the clock rather than merely narrowing it.
    const muchLater = '2026-10-20T13:00:00.000Z';
    expect(isAuditFresh(auditedAt, muchLater)).toBe(false);
    expect(isAuditFresh(auditedAt, muchLater, currentSchema2, currentSchema2)).toBe(true);
  });
});
