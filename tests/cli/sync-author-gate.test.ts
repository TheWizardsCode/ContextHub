/**
 * CLI tests for the sync author-identity gate (WL-0MSOYWWS4009HTCB).
 *
 * Exercises the real `wl sync` command against a mock git ref
 * (tests/cli/mock-bin/git). The mock git is seeded via:
 *   - .git/worklog-log-commits  — `git log` store (lines "<hash> <email|-> <state>")
 *   - .git/user-email           — `git config user.email` get-form value
 *
 * TDD RED phase (C1): the gate is NOT wired into `wl sync` yet, so the
 * refusal tests FAIL today (sync succeeds and imports the remote items, and
 * `--allow-foreign-author` is an unknown option). This is the expected,
 * documented red state — the tests go green in C2/C3.
 *
 * Scenarios (parent AC6):
 *   (a) only own-author commits → sync succeeds, remote items imported
 *   (b) one empty-email commit → exit != 0, message names commit + remote ref,
 *       DB untouched (remote item NOT imported)
 *   (c) different-email commit → refused by default; succeeds with
 *       --allow-foreign-author
 *   (d) --dry-run reports the same refusal deterministically
 *   (Q3) --allow-foreign-author does NOT bypass the empty-email gate
 *   (AC1) last-synced-ref present → `--not <ref>` excludes already-synced commits
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execWithInput, writeConfig, writeInitSemaphore, cliPath } from './cli-helpers.js';
import { createTempDir, cleanupTempDir } from '../test-utils.js';

const REMOTE_REF = 'refs/worklog/remotes/origin/worklog/data';
const OWN_EMAIL = 'ross@example.com';
const REMOTE_ITEM_ID = 'GUA-100';

function makeItem(id: string, title: string): Record<string, unknown> {
  return {
    id,
    title,
    description: '',
    status: 'open',
    priority: 'medium',
    sortIndex: 0,
    parentId: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    tags: [],
    assignee: '',
    stage: '',
    issueType: '',
    createdBy: '',
    deletedBy: '',
    deleteReason: '',
    risk: '',
    effort: '',
  };
}

function jsonlLine(type: string, data: unknown): string {
  return JSON.stringify({ data, type });
}

/** Seed the mock `git log` commit store (lines "<hash> <email|-> <state>"). */
function writeLogCommits(repo: string, lines: Array<[hash: string, email: string, state: 'new' | 'synced']>): void {
  const content = lines
    .map(([hash, email, state]) => `${hash} ${email === '' ? '-' : email} ${state}`)
    .join('\n');
  fs.writeFileSync(path.join(repo, '.git', 'worklog-log-commits'), `${content}\n`, 'utf8');
}

/** Seed the mock `git config user.email` get-form value. */
function writeUserEmail(repo: string, email: string): void {
  fs.writeFileSync(path.join(repo, '.git', 'user-email'), `${email}\n`, 'utf8');
}

describe('sync author-identity gate — CLI (WL-0MSOYWWS4009HTCB)', () => {
  let repoA: string; // target project (prefix GUA)
  let repoB: string; // "remote" whose ref repoA syncs

  beforeEach(() => {
    repoA = createTempDir();
    repoB = createTempDir();
    for (const repo of [repoA, repoB]) {
      fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    }
    writeConfig(repoA, 'Identity Gate Test', 'GUA');
    writeInitSemaphore(repoA);
    // Point repoA's remote at repoB so the mock git fetch reads repoB's .worklog.
    fs.writeFileSync(path.join(repoA, '.git', 'remote_origin'), repoB, 'utf8');
    // Configured store identity (the gate reads this via `git config user.email`).
    writeUserEmail(repoA, OWN_EMAIL);

    // Seed the "remote" worklog ref with an own-prefix item (GUA-100) so a
    // successful sync observably imports something.
    fs.mkdirSync(path.join(repoB, '.worklog'), { recursive: true });
    fs.writeFileSync(
      path.join(repoB, '.worklog', 'worklog-data.jsonl'),
      `${jsonlLine('workitem', makeItem(REMOTE_ITEM_ID, 'Remote item'))}\n`,
      'utf8'
    );
  });

  afterEach(() => {
    cleanupTempDir(repoA);
    cleanupTempDir(repoB);
  });

  async function sync(args = ''): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    return execWithInput(
      `tsx ${cliPath} --worklog-dir ${repoA}/.worklog sync --no-push ${args}`,
      '',
      { cwd: repoA, timeout: 60000 }
    );
  }

  async function listIds(): Promise<string[]> {
    const list = await execWithInput(
      `tsx ${cliPath} --worklog-dir ${repoA}/.worklog list --json`,
      '',
      { cwd: repoA, timeout: 30000 }
    );
    expect(list.exitCode, `${list.stdout}\n${list.stderr}`).toBe(0);
    const payload = JSON.parse(list.stdout);
    const items: Array<{ id: string }> = payload.workItems ?? payload;
    return items.map(it => it.id);
  }

  it('(a) sync succeeds when all incoming commits are own-author (real CLI)', async () => {
    writeLogCommits(repoA, [['a1b2c3d', OWN_EMAIL, 'new']]);

    const { stdout, stderr, exitCode } = await sync();
    const output = `${stdout}\n${stderr}`;
    expect(exitCode, output).toBe(0);

    // Remote item was imported.
    expect(await listIds()).toContain(REMOTE_ITEM_ID);
  }, 90000);

  it('(b) refuses sync when an incoming commit has an empty author email; no DB mutation (real CLI)', async () => {
    // Seed the mock git log with the known polluted commit 5fc880a (empty email).
    writeLogCommits(repoA, [['5fc880a', '', 'new']]);

    const { stdout, stderr, exitCode } = await sync();
    const output = `${stdout}\n${stderr}`;
    expect(exitCode, output).not.toBe(0);

    // AC2: message names the offending commit AND the remote ref.
    expect(output).toContain('5fc880a');
    expect(output).toContain(REMOTE_REF);

    // AC6b: DB untouched — the remote item must NOT have been imported.
    expect(await listIds()).not.toContain(REMOTE_ITEM_ID);
  }, 90000);

  it('(c) refuses a different-email commit by default; succeeds with --allow-foreign-author (real CLI)', async () => {
    writeLogCommits(repoA, [['6b9e493', 'other@example.com', 'new']]);

    // Default: refused, message names the commit + remote ref.
    const refused = await sync();
    const refusedOutput = `${refused.stdout}\n${refused.stderr}`;
    expect(refused.exitCode, refusedOutput).not.toBe(0);
    expect(refusedOutput).toContain('6b9e493');
    expect(refusedOutput).toContain(REMOTE_REF);

    // Override: succeeds and imports the remote item.
    const allowed = await sync('--allow-foreign-author');
    const allowedOutput = `${allowed.stdout}\n${allowed.stderr}`;
    expect(allowed.exitCode, allowedOutput).toBe(0);
    expect(await listIds()).toContain(REMOTE_ITEM_ID);
  }, 120000);

  it('(d) --dry-run reports the same refusal deterministically (real CLI)', async () => {
    writeLogCommits(repoA, [['5fc880a', '', 'new']]);

    const { stdout, stderr, exitCode } = await sync('--dry-run');
    const output = `${stdout}\n${stderr}`;
    expect(exitCode, output).not.toBe(0);
    expect(output).toContain('5fc880a');
    expect(output).toContain(REMOTE_REF);
    expect(await listIds()).not.toContain(REMOTE_ITEM_ID);
  }, 90000);

  it('(Q3) --allow-foreign-author does NOT bypass the empty-email gate (real CLI)', async () => {
    writeLogCommits(repoA, [['5fc880a', '', 'new']]);

    const { stdout, stderr, exitCode } = await sync('--allow-foreign-author');
    const output = `${stdout}\n${stderr}`;
    expect(exitCode, output).not.toBe(0);
    expect(output).toContain('5fc880a');
    expect(await listIds()).not.toContain(REMOTE_ITEM_ID);
  }, 90000);

  it('(AC1) honors the last-synced-ref: `--not <ref>` excludes already-synced commits (real CLI)', async () => {
    // Record a last-known sync point; the empty-email commit is already merged
    // (state "synced"), so `git log <ref> --not <lastSyncedRef>` must exclude it.
    fs.writeFileSync(
      path.join(repoA, '.worklog', 'last-synced-ref'),
      'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391\n',
      'utf8'
    );
    writeLogCommits(repoA, [
      ['5fc880a', '', 'synced'],      // empty email, but already merged → excluded by --not
      ['a1b2c3d', OWN_EMAIL, 'new'],  // own new commit → inspected
    ]);

    const { stdout, stderr, exitCode } = await sync();
    const output = `${stdout}\n${stderr}`;
    expect(exitCode, output).toBe(0);
    expect(await listIds()).toContain(REMOTE_ITEM_ID);
  }, 90000);

  it('(AC3) syncAllowForeignAuthor config flag allows foreign commits; CLI flag wins over config (real CLI)', async () => {
    writeLogCommits(repoA, [['6b9e493', 'other@example.com', 'new']]);

    // config.yaml sets syncAllowForeignAuthor: true → foreign commit allowed.
    const configPath = path.join(repoA, '.worklog', 'config.yaml');
    const base = fs.readFileSync(configPath, 'utf8');
    fs.writeFileSync(configPath, `${base}\nsyncAllowForeignAuthor: true\n`, 'utf8');
    const viaConfig = await sync();
    expect(viaConfig.exitCode, `${viaConfig.stdout}\n${viaConfig.stderr}`).toBe(0);

    // CLI flag wins over config: with --allow-foreign-author the gate is
    // overridden even when config says refuse (default).
    writeLogCommits(repoA, [['6b9e493', 'other@example.com', 'new']]);
    fs.writeFileSync(configPath, base, 'utf8');
    const viaFlag = await sync('--allow-foreign-author');
    expect(viaFlag.exitCode, `${viaFlag.stdout}\n${viaFlag.stderr}`).toBe(0);
  }, 120000);

  it('(AC5) writes .worklog/last-synced-ref after a successful non-dry-run sync (real CLI)', async () => {
    writeLogCommits(repoA, [['a1b2c3d', OWN_EMAIL, 'new']]);

    const { stdout, stderr, exitCode } = await sync();
    const output = `${stdout}\n${stderr}`;
    expect(exitCode, output).toBe(0);

    // The tracking ref tip sha was persisted for the next gate scan.
    const lastSyncedRefPath = path.join(repoA, '.worklog', 'last-synced-ref');
    expect(fs.existsSync(lastSyncedRefPath)).toBe(true);
    const sha = fs.readFileSync(lastSyncedRefPath, 'utf8').trim();
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  }, 90000);
});
