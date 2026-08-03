/**
 * E2E tests for the cross-project sync guard (WL-0MSAH26DD001XXST).
 *
 * Scenario: `wl sync --worklog-dir <projB>/.worklog` run from inside a
 * DIFFERENT git repo (projA) used to fetch projA's remote worklog ref and
 * merge it into projB's database, then push the polluted union to projB's
 * remote. The fix (a) applies the --worklog-dir override before ctx.dataPath
 * is computed and (b) fails loudly when the data file belongs to a different
 * git repo than the process cwd.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execAsync, execWithInput, writeConfig, writeInitSemaphore, cliPath } from './cli-helpers.js';
import { createTempDir, cleanupTempDir } from '../test-utils.js';

describe('cross-project sync guard (WL-0MSAH26DD001XXST)', () => {
  let repoA: string; // the cwd repo (the "wrong" repo)
  let repoB: string; // the target project referenced via --worklog-dir

  beforeEach(() => {
    repoA = createTempDir();
    repoB = createTempDir();
    // Mock git (tests/cli/mock-bin) treats a .git dir as a repo root.
    for (const repo of [repoA, repoB]) {
      fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
      writeConfig(repo, 'Guard Test', 'GUA');
      writeInitSemaphore(repo);
    }
  });

  afterEach(() => {
    cleanupTempDir(repoA);
    cleanupTempDir(repoB);
  });

  it('sync with --worklog-dir at another repo fails loudly instead of merging (real CLI)', async () => {
    const { stdout, stderr, exitCode } = await execWithInput(
      `tsx ${cliPath} --worklog-dir ${repoB}/.worklog sync --dry-run --no-push`,
      '',
      { cwd: repoA, timeout: 60000 }
    );

    expect(exitCode).toBe(1);
    const output = `${stdout}\n${stderr}`;
    expect(output).toContain('Cross-project sync blocked');
    // The target project's database must NOT have been created/polluted.
    expect(fs.existsSync(path.join(repoB, '.worklog', 'worklog.db'))).toBe(false);
  }, 90000);

  it('sync debug resolves the data file from --worklog-dir (resolution-order fix)', async () => {
    const { stdout } = await execAsync(
      `tsx ${cliPath} --worklog-dir ${repoB}/.worklog sync debug`,
      { cwd: repoA, timeout: 30000 }
    );

    // ctx.dataPath (and the -f default) must reflect the override — NOT the
    // cwd repo's .worklog. This proves the override is applied before the
    // plugin context is created.
    expect(stdout).toContain(`Data file: ${repoB}/.worklog/worklog-data.jsonl`);
    expect(stdout).not.toContain(`Data file: ${repoA}/.worklog/worklog-data.jsonl`);
    // The remote fetch is also guarded: it must not read repoA's remote ref.
    expect(stdout).toContain('Cross-project sync blocked');
  }, 60000);
});
