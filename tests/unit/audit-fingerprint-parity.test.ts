/**
 * Byte-for-byte parity between the TypeScript canonical content fingerprint
 * and the audit skill's Python implementation
 * (`audit_runner._compute_content_fingerprint`) — WL-0MUN7QWFP0010EQC.
 *
 * The TS port exists so `wl list` can emit `currentFingerprint` without a
 * runtime Python dependency; this test guards against drift by computing the
 * same fingerprint both ways over a real (temporary) git repository.
 *
 * The test is skipped when the audit skill's runner or a `python3` interpreter
 * is unavailable (e.g. CI without the SorraAgents skill installed), so it
 * never blocks the suite — it is an additional safety net, not the sole
 * correctness proof (the unit tests pin the algorithm independently).
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { computeContentFingerprint, createGitRunner } from '../../src/audit-fingerprint.js';
import { createTempDir, cleanupTempDir } from '../test-utils.js';

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

const AUDIT_SCRIPTS = findAuditScripts();
const PYTHON = pythonAvailable();

function haveGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const canRun = AUDIT_SCRIPTS !== null && PYTHON && haveGit();

describe.skipIf(!canRun)('canonical fingerprint parity (TS vs audit skill Python)', () => {
  it('produces the same digest as audit_runner._compute_content_fingerprint', () => {
    const repo = createTempDir();
    try {
      const filePath = path.join(repo, 'implementation.ts');
      fs.writeFileSync(filePath, 'export const value = 42;\n');

      const id = 'CFP-PARITY001';
      const description = [
        '## Summary',
        'Parity fixture.',
        '## Key Files',
        '- `implementation.ts`',
      ].join('\n');

      const env = {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      };
      const git = (args: string[]) =>
        execFileSync('git', args, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
      git(['init']);
      git(['add', 'implementation.ts']);
      git(['commit', '-m', `${id}: parity fixture`]);

      const workItem = { id, description };
      const workItemFile = path.join(repo, 'work-item.json');
      fs.writeFileSync(workItemFile, JSON.stringify(workItem));

      const script = path.join(repo, 'parity.py');
      fs.writeFileSync(
        script,
        [
          'import json, subprocess, sys',
          'sys.path.insert(0, sys.argv[3])',
          'import audit_runner as ar',
          'repo = sys.argv[1]',
          'work_item = json.loads(open(sys.argv[2]).read())',
          'def runner(cmd):',
          '    return subprocess.run(list(cmd), check=False, text=True,',
          '                          capture_output=True, cwd=repo)',
          'print(ar._compute_content_fingerprint(',
          '    runner, work_item["id"], work_item=work_item, comments=None))',
        ].join('\n'),
      );

      const pythonOut = execFileSync('python3', [script, repo, workItemFile, AUDIT_SCRIPTS], {
        encoding: 'utf8',
      }).trim();

      const tsOut = computeContentFingerprint({
        id,
        description,
        runGit: createGitRunner(repo),
      });

      expect(tsOut).toBe(pythonOut);
      expect(tsOut).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      cleanupTempDir(repo);
    }
  });
});
