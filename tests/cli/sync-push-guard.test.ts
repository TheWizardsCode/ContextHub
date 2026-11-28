/**
 * CLI-level tests for the push-side identity guard (WL-0MWGO58KL00187CO,
 * child WL-0MWGO5J8B001ES29).
 *
 * Exercises the real `wl sync` command against REAL git + a bare remote (the
 * test mock-bin is stripped from PATH through `fixtureGitEnv`), mirroring
 * tests/cli/sync-delta-push.test.ts and
 * tests/cli/doctor-foreign-items-push.test.ts. No network, no new deps.
 *
 * Scenarios (child AC1–AC6):
 *   1. sentinel `user.email` + push → refuse BEFORE pushing, naming the
 *      identity + the `git config user.email …` remedy; remote ref untouched.
 *   2. empty `user.email` → refuse with the remedy; `--allow-sentinel-author`
 *      does NOT bypass the empty-email refusal.
 *   3. `--no-push` under a sentinel identity → the guard does NOT fire.
 *   4. zero-change fast path under a sentinel identity → no guard (push skipped).
 *   5. `--allow-sentinel-author` → push proceeds and the bypass is audit-logged.
 *   6. doctor force-rewrite (`foreign-items --apply --push`) under a sentinel
 *      identity → refused (guard also covers `rewriteAndForcePushDataFile`).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { writeConfig, writeInitSemaphore } from './cli-helpers.js';
import { cliInvocation } from './cli-bundle.js';
import { fixtureGitEnv } from './git-helpers.js';

const __dirname = path.dirname(new URL(import.meta.url).pathname);

const SENTINEL = 't@t.com';
const VALID = 'dev@example.com';

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync('git', args, { cwd, encoding: 'utf-8', env: fixtureGitEnv() });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${res.stderr || res.stdout}`);
  }
  return res.stdout.trim();
}

function runCli(cwd: string, ...args: string[]): { stdout: string; stderr: string; status: number } {
  const [command, entry] = cliInvocation();
  const res = spawnSync(command, [entry, ...args], { cwd, encoding: 'utf-8', env: fixtureGitEnv() });
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status ?? -1 };
}

interface Setup {
  root: string;
  remote: string;
  local: string;
}

function setupProject(): Setup {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-pushguard-'));
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');
  git(root, 'init', '--bare', '-q', remote);
  git(root, 'init', '-q', local);
  git(local, 'config', 'user.email', VALID);
  git(local, 'config', 'user.name', 'Test User');
  git(local, 'remote', 'add', 'origin', remote);
  writeConfig(local, 'Push Guard Test', 'PGT');
  writeInitSemaphore(local);
  fs.writeFileSync(path.join(local, 'README.md'), '# push guard\n', 'utf8');
  git(local, 'add', '-A');
  git(local, 'commit', '-q', '-m', 'init');
  return { root, remote, local };
}

/** Create a local work item so a sync has something to push. */
function createItem(local: string, title: string): string {
  const res = runCli(local, '--json', 'create', '-t', title);
  if (res.status !== 0) {
    throw new Error(`wl create failed: ${res.stderr}\n${res.stdout}`);
  }
  const parsed = JSON.parse(res.stdout);
  const id: string = parsed.workItem?.id ?? parsed.id;
  expect(id).toBeTruthy();
  return id;
}

/** True when the bare remote already carries a `refs/worklog/data` ref. */
function remoteHasWorklogRef(remote: string): boolean {
  const res = spawnSync('git', ['--git-dir', remote, 'rev-parse', '--verify', 'refs/worklog/data'], {
    encoding: 'utf-8',
    env: fixtureGitEnv(),
  });
  return res.status === 0;
}

/** Seed a polluted remote ref (own + foreign items) for the doctor rewrite test. */
function seedPollutedRemote(local: string, prefix: string): void {
  const dataPath = path.join(local, '.worklog', 'worklog-data.jsonl');
  fs.mkdirSync(path.dirname(dataPath), { recursive: true });
  const now = new Date().toISOString();
  const mk = (id: string, title: string) => JSON.stringify({
    type: 'workitem',
    data: {
      id, title, description: '', status: 'open', priority: 'medium', sortIndex: 0,
      parentId: null, createdAt: now, updatedAt: now, tags: [], assignee: '',
      stage: 'idea', issueType: '', createdBy: '', deletedBy: '', deleteReason: '',
      risk: '', effort: '',
    },
  });
  fs.writeFileSync(dataPath, `${mk(`${prefix}-1`, 'own one')}\n${mk('WL-101', 'foreign one')}\n`, 'utf-8');
  // Branch-agnostic: `git init` already lands on `main` when the developer's
  // `init.defaultBranch` says so, and `-b` would then fail with
  // "a branch named 'main' already exists" (WL-0MWWSCXEC001BQ3I). `-B` resets
  // the branch to HEAD when it exists and creates it otherwise.
  git(local, 'checkout', '-q', '-B', 'main');
  git(local, 'add', '-A');
  git(local, 'commit', '-q', '-m', 'init');
  git(local, 'checkout', '--orphan', 'worklog/data');
  git(local, 'add', '-f', '.worklog/worklog-data.jsonl');
  git(local, 'commit', '-q', '-m', 'polluted data');
  git(local, 'push', '-q', 'origin', 'HEAD:refs/worklog/data');
  git(local, 'checkout', '-q', 'main');
}

describe('wl sync push-side identity guard — CLI (real git)', () => {
  let s: Setup;

  beforeEach(() => {
    s = setupProject();
  });

  afterEach(() => {
    fs.rmSync(s.root, { recursive: true, force: true });
  });

  it('AC1: refuses to push under an exact sentinel identity, naming it + the remedy; remote untouched', () => {
    createItem(s.local, 'Sentinel item');
    git(s.local, 'config', 'user.email', SENTINEL);

    const res = runCli(s.local, 'sync');
    const out = `${res.stdout}\n${res.stderr}`;

    expect(res.status, out).not.toBe(0);
    expect(out).toContain(SENTINEL);
    expect(out).toContain('git config user.email');
    expect(out).toContain('--allow-sentinel-author');
    // Refusal happened BEFORE any push: the remote ref was never created.
    expect(remoteHasWorklogRef(s.remote)).toBe(false);
  }, 120000);

  it('AC2: refuses an empty user.email; --allow-sentinel-author does NOT bypass it', () => {
    createItem(s.local, 'Empty identity item');
    // Set an EMPTY local user.email (rather than unsetting it, which would
    // fall back to the host's global identity under the fixture environment).
    git(s.local, 'config', 'user.email', '');

    const refused = runCli(s.local, 'sync');
    const refusedOut = `${refused.stdout}\n${refused.stderr}`;
    expect(refused.status, refusedOut).not.toBe(0);
    expect(refusedOut).toContain('git config user.email');
    expect(remoteHasWorklogRef(s.remote)).toBe(false);

    // The escape hatch never bypasses the empty-email refusal.
    const withFlag = runCli(s.local, 'sync', '--allow-sentinel-author');
    const withFlagOut = `${withFlag.stdout}\n${withFlag.stderr}`;
    expect(withFlag.status, withFlagOut).not.toBe(0);
    expect(withFlagOut).toContain('git config user.email');
    expect(remoteHasWorklogRef(s.remote)).toBe(false);
  }, 120000);

  it('AC3a: --no-push under a sentinel identity does NOT trip the guard', () => {
    createItem(s.local, 'No push item');
    git(s.local, 'config', 'user.email', SENTINEL);

    const res = runCli(s.local, 'sync', '--no-push');
    const out = `${res.stdout}\n${res.stderr}`;

    expect(res.status, out).toBe(0);
    expect(out).not.toContain('Refusing to push worklog data');
  }, 120000);

  it('AC3b: the zero-change fast path does not trip the guard', () => {
    createItem(s.local, 'Steady item');
    // First sync under a valid identity creates the baseline + pushes the ref.
    const first = runCli(s.local, 'sync', '--json');
    expect(first.status, first.stderr).toBe(0);
    expect(remoteHasWorklogRef(s.remote)).toBe(true);

    // Pin the last-synced-ref to the pushed tip so the PULL-side gate scans
    // nothing on the next sync — this isolates the push guard from the pull
    // gate (the pushed commit is authored by the valid identity, not the
    // sentinel we switch to below).
    git(s.local, 'fetch', '-q', 'origin', '+refs/worklog/data:refs/worklog/remotes/origin/worklog/data');
    const tipSha = git(s.local, 'rev-parse', 'refs/worklog/remotes/origin/worklog/data');
    fs.writeFileSync(path.join(s.local, '.worklog', 'last-synced-ref'), `${tipSha}\n`, 'utf8');

    // Switch to a sentinel identity; nothing is dirty, so the sync takes the
    // zero-change fast path (no export, no push) and the guard never runs.
    git(s.local, 'config', 'user.email', SENTINEL);
    const second = runCli(s.local, 'sync');
    const out = `${second.stdout}\n${second.stderr}`;

    expect(second.status, out).toBe(0);
    expect(out).not.toContain('Refusing to push worklog data');
    expect(out).toMatch(/No changes to sync/i);
  }, 120000);

  it('AC4: --allow-sentinel-author permits the push and the bypass is audit-logged', () => {
    createItem(s.local, 'Override item');
    git(s.local, 'config', 'user.email', SENTINEL);

    const res = runCli(s.local, 'sync', '--allow-sentinel-author');
    const out = `${res.stdout}\n${res.stderr}`;

    expect(res.status, out).toBe(0);
    // Audit trail in the sync output names the bypass + the identity.
    expect(out).toMatch(/BYPASSED via --allow-sentinel-author/);
    expect(out).toContain(SENTINEL);
    // The push actually happened.
    expect(remoteHasWorklogRef(s.remote)).toBe(true);

    // Audit trail also recorded in the sync log.
    const logPath = path.join(s.local, '.worklog', 'logs', 'sync.log');
    expect(fs.existsSync(logPath)).toBe(true);
    expect(fs.readFileSync(logPath, 'utf8')).toMatch(/BYPASSED via --allow-sentinel-author/);
  }, 120000);

  it('AC5: doctor force-rewrite (--apply --push) refuses under a sentinel identity', () => {
    seedPollutedRemote(s.local, 'PGT');
    // Populate the local DB from the seeded JSONL (first DB open imports it),
    // so the doctor run has state to operate on — mirrors the existing
    // doctor-foreign-items-push suite.
    runCli(s.local, '--json', 'doctor', 'foreign-items', '--dry-run');
    git(s.local, 'config', 'user.email', SENTINEL);

    const res = runCli(s.local, 'doctor', 'foreign-items', '--apply', '--push');
    const out = `${res.stdout}\n${res.stderr}`;

    expect(res.status, out).not.toBe(0);
    expect(out).toContain(SENTINEL);
    expect(out).toContain('git config user.email');

    // The polluted remote ref was NOT rewritten — the foreign commit is still
    // present because the guard fired before the force-push.
    git(s.local, 'fetch', '-q', 'origin', '+refs/worklog/data:refs/worklog/remotes/origin/worklog/data');
    const remoteContent = git(s.local, 'show', 'refs/worklog/remotes/origin/worklog/data:.worklog/worklog-data.jsonl');
    expect(remoteContent).toContain('WL-101');
  }, 120000);
});
