/**
 * Claim-revert reproduction suite (SA-0MVE34D9B005TUYJ → child
 * SA-0MVKWV26Y000G3B9).
 *
 * ## Symptom
 *
 * A background `wl sync --if-idle` reverted an *actively worked* item from
 * `status: in-progress` back to `status: open` (with the pre-claim
 * `stage: intake_complete`) four times in one implement run
 * (SA-0MVDQF3VW002PKCA, 2026-10-18), although the general lost-update race
 * between `wl sync` and the mutating commands was already fixed by
 * WL-0MUV2U9QF002S9J1 (commit `ed0acc60`) — which is what this file proves
 * is *not* the remaining mechanism.
 *
 * ## Root cause (two mechanisms, both proven below)
 *
 * **(a) Lost update with a fresh stamp — `import()` re-stamps the stale row.**
 * `performSync()` (`src/commands/sync.ts`) takes its local snapshot
 * (`db.getAll()`) *after* acquiring the lock, then parks on the network for
 * the fetch/merge. `withFileLock()` treats any lock older than `maxLockAge`
 * (5 min, `src/file-lock.ts` `DEFAULT_MAX_LOCK_AGE_MS`) as stale *even when
 * the holder is alive* and unlinks it, so a mutation that arrives during a
 * long sync acquires "the" lock, claims the item, and completes. The parked
 * sync then persists its pre-claim merged set. `WorklogDatabase.import()`
 * (`packages/shared/src/database.ts`) re-inserts that stale row and — because
 * its tracked fields differ from the row now in the database — stamps it
 * `updatedAt = new Date().toISOString()`. The claim is therefore lost *and*
 * the losing (stale) row becomes the newest row, so every later merge honours
 * it. `upsertItems()` (delta path) has the same re-stamp behaviour.
 *
 * **(b) Store-resolution divergence — a second store per repo.**
 * `.worklog/config.yaml` is tracked (`.gitignore` re-includes it), so every
 * implement/audit worktree materialises a `.worklog/` directory that holds
 * only tracked config and no store. `isValidWorklogDir()`
 * (`packages/shared/src/worklog-paths.ts`) accepts a directory with
 * `config.yaml` as a valid root, so `resolveWorklogRoot()` returns the
 * *worktree*, and a `wl` command run with cwd inside the worktree binds to a
 * second store: its own DB, its own `last-synced-ref` watermark and its own
 * mutation lock (both derived from the data path in `src/file-lock.ts`), so
 * the two roots never serialise against each other and both push to the same
 * worklog ref. The stale copy a second store holds can then be re-stamped and
 * pushed back into the main store (feeding mechanism (a)).
 *
 * ## What these tests pin
 *
 * 1. `(b)` A `wl` command run inside a managed worktree binds to the main
 *    checkout's store and never creates a second store.
 * 2. `(a)` A claim that lands while a sync is parked cannot be reverted — and
 *    the (stale) losing row is not re-stamped newer — even when the sync's
 *    lock has age-expired and the claim therefore acquired it.
 *
 * Both are deterministic: the fetch is parked by a `git` shim (the technique
 * from `sync-vs-mutation.test.ts`), and the "long sync" is simulated by
 * back-dating the lock file's `acquiredAt` — no sleep-based timing races.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { writeConfig, writeInitSemaphore } from './cli-helpers.js';
import { cliInvocation } from './cli-bundle.js';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const projectRoot = path.resolve(__dirname, '..', '..');
const mockBinDir = path.join(projectRoot, 'tests', 'cli', 'mock-bin');

function cliSpawn(args: string[], options: Parameters<typeof spawn>[2]) {
  const [command, entry] = cliInvocation();
  return spawn(command, [entry, ...args], options);
}

function cliSpawnSync(args: string[], options: Parameters<typeof spawnSync>[2]) {
  const [command, entry] = cliInvocation();
  return spawnSync(command, [entry, ...args], options);
}

/** PATH without the test mock-bin so subprocesses run the real git binary. */
function realGitEnv(): Record<string, string> {
  const pathVal = (process.env.PATH || '')
    .split(path.delimiter)
    .filter(p => path.resolve(p) !== path.resolve(mockBinDir))
    .join(path.delimiter);
  return { ...process.env as Record<string, string>, PATH: pathVal };
}

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync('git', args, { cwd, encoding: 'utf-8', env: realGitEnv() });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
  }
  return (res.stdout || '').trim();
}

function runCli(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): { stdout: string; stderr: string; status: number } {
  const res = cliSpawnSync(args, {
    cwd,
    encoding: 'utf-8',
    env: env ?? realGitEnv(),
    timeout: 60000,
  });
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status ?? -1 };
}

interface SpawnedCli {
  child: ChildProcess;
  done: Promise<{ stdout: string; stderr: string; status: number | null }>;
}

function spawnCli(cwd: string, args: string[], env: Record<string, string>): SpawnedCli {
  const child = cliSpawn(args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as ChildProcess;
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
  child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
  const done = new Promise<{ stdout: string; stderr: string; status: number | null }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', status => resolve({ stdout, stderr, status }));
  });
  return { child, done };
}

async function waitForFile(file: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for file: ${file}`);
}

interface ShowResult {
  workItem: { id: string; status: string; stage: string; assignee?: string; updatedAt?: string; activityAt?: string };
}

function showItem(cwd: string, id: string, env?: Record<string, string>): ShowResult {
  const res = runCli(cwd, ['--json', 'show', id], env);
  expect(res.status, res.stderr).toBe(0);
  return JSON.parse(res.stdout) as ShowResult;
}

interface Setup {
  root: string;
  remote: string;
  local: string;
  shimDir: string;
  marker: string;
  release: string;
  realGit: string;
}

/**
 * Build a project with a real bare remote, plus a `git` shim that parks every
 * `git fetch` until a release file appears (the deterministic window-widening
 * technique from `sync-vs-mutation.test.ts`).
 */
function setupProject(): Setup {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-claim-revert-'));
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');
  git(root, 'init', '--bare', '-q', remote);
  git(root, 'init', '-q', local);
  git(local, 'config', 'user.email', 'test@example.com');
  git(local, 'config', 'user.name', 'Test User');
  git(local, 'remote', 'add', 'origin', remote);
  writeConfig(local, 'Claim Revert Test', 'CRV');
  writeInitSemaphore(local);
  // Mirror a real project's .gitignore: `.worklog/` is ignored except the
  // tracked config, so a `git worktree add` materialises a `.worklog/`
  // directory holding configuration but NO store (no `initialized`, no
  // `worklog.db`). That is the precondition for mechanism (b).
  fs.writeFileSync(
    path.join(local, '.gitignore'),
    ['.worklog/*', '!.worklog/config.yaml', '!.worklog/config.defaults.yaml', ''].join('\n'),
    'utf8',
  );
  fs.writeFileSync(path.join(local, 'README.md'), '# claim revert\n', 'utf8');
  git(local, 'add', '-A');
  git(local, 'commit', '-q', '-m', 'init');

  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-claim-git-shim-'));
  const marker = path.join(shimDir, 'fetch-started');
  const release = path.join(shimDir, 'fetch-release');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf-8', env: realGitEnv() }).trim();
  const shim = [
    '#!/bin/sh',
    'if [ "$1" = "fetch" ]; then',
    '  : > "$GIT_SHIM_MARKER"',
    '  n=0',
    '  while [ ! -f "$GIT_SHIM_RELEASE" ] && [ "$n" -lt 600 ]; do',
    '    sleep 0.1',
    '    n=$((n + 1))',
    '  done',
    'fi',
    'exec "$GIT_SHIM_REAL" "$@"',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(shimDir, 'git'), shim, { mode: 0o755 });

  return { root, remote, local, shimDir, marker, release, realGit };
}

function shimEnv(s: Setup): Record<string, string> {
  return {
    ...realGitEnv(),
    PATH: `${s.shimDir}${path.delimiter}${realGitEnv().PATH}`,
    GIT_SHIM_MARKER: s.marker,
    GIT_SHIM_RELEASE: s.release,
    GIT_SHIM_REAL: s.realGit,
  };
}

function createItem(local: string, title: string): string {
  const res = runCli(local, ['--json', 'create', '-t', title]);
  if (res.status !== 0) {
    throw new Error(`wl create failed: ${res.stderr}\n${res.stdout}`);
  }
  const parsed = JSON.parse(res.stdout);
  const id: string = parsed.workItem?.id ?? parsed.id;
  expect(id).toBeTruthy();
  return id;
}

/** Path of the store's advisory lock file (see `getLockPathForJsonl`). */
function lockPath(local: string): string {
  return path.join(local, '.worklog', 'worklog-data.jsonl.lock');
}

/**
 * Back-date a held lock past `DEFAULT_MAX_LOCK_AGE_MS` (5 minutes) so the next
 * acquirer treats it as stale and steals it *while the holder is still
 * alive* — exactly what happens when a sync runs longer than the hard-coded
 * max lock age. Deterministic: no sleeping.
 */
function expireLock(local: string): void {
  const p = lockPath(local);
  const info = JSON.parse(fs.readFileSync(p, 'utf8'));
  info.acquiredAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  fs.writeFileSync(p, JSON.stringify(info));
}

describe('wl sync cannot revert a held claim', () => {
  let s: Setup;

  beforeEach(() => {
    s = setupProject();
  });

  afterEach(() => {
    fs.rmSync(s.root, { recursive: true, force: true });
    fs.rmSync(s.shimDir, { recursive: true, force: true });
  });

  it('mechanism (b): a wl command inside a managed worktree binds to the main store', () => {
    const id = createItem(s.local, 'Worktree store-binding target');

    // Materialise a managed worktree exactly as implement.py start does. The
    // worktree inherits the tracked .worklog/config.yaml but has no store.
    const worktree = path.join(s.local, '.worklog', 'worktrees', 'wl-CRV-1-claim');
    git(s.local, 'worktree', 'add', '--track', '-b', 'wl-CRV-1-claim', worktree, 'HEAD');

    expect(fs.existsSync(path.join(worktree, '.worklog', 'config.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(worktree, '.worklog', 'worklog.db'))).toBe(false);

    // A claim made from the main checkout...
    const claim = runCli(s.local, ['--json', 'update', id, '-s', 'in_progress', '--no-re-sort']);
    expect(claim.status, claim.stderr).toBe(0);

    // ...must be visible from inside the worktree: one store per repo.
    const fromWorktree = runCli(worktree, ['--json', 'show', id]);
    expect(fromWorktree.status, fromWorktree.stderr).toBe(0);
    const shown = JSON.parse(fromWorktree.stdout) as ShowResult;
    expect(shown.workItem.id).toBe(id);
    expect(shown.workItem.status).toBe('in-progress');

    // ...and no second store may be created for the same project prefix.
    expect(fs.existsSync(path.join(worktree, '.worklog', 'worklog.db'))).toBe(false);
  }, 60000);

  it('mechanism (a): a claim made during a sync is not reverted, nor re-stamped newer', async () => {
    const id = createItem(s.local, 'Claim under a parked sync');

    // Seed the remote (also establishes the export watermark baseline).
    const seed = runCli(s.local, ['--json', 'sync']);
    expect(seed.status, seed.stderr).toBe(0);

    // Park a sync inside `git fetch`: it has already taken its local snapshot
    // (pre-claim) and now waits on the network, holding the store lock.
    const sync = spawnCli(s.local, ['--json', 'sync', '--if-idle'], shimEnv(s));
    await waitForFile(s.marker, 20000);

    // A sync that runs longer than DEFAULT_MAX_LOCK_AGE_MS has its lock treated
    // as stale by the next acquirer. Back-date it to model that deterministically.
    expireLock(s.local);

    // Claim the item. Today this steals the "expired" lock, completes, and is
    // then overwritten by the parked sync's pre-claim snapshot.
    const claim = runCli(s.local, ['--json', 'update', id, '-s', 'in_progress', '--no-re-sort']);
    expect(claim.status, claim.stderr).toBe(0);
    const claimed = showItem(s.local, id);
    expect(claimed.workItem.status).toBe('in-progress');
    const claimedUpdatedAt = claimed.workItem.updatedAt;
    expect(claimedUpdatedAt).toBeTruthy();

    // Release the parked fetch and let the sync write its stale snapshot back.
    fs.writeFileSync(s.release, 'go');
    const syncRes = await sync.done;
    expect(syncRes.status, syncRes.stderr).toBe(0);

    const after = showItem(s.local, id);
    expect(after.workItem.status, 'claim must survive the sync').toBe('in-progress');
    expect(
      after.workItem.updatedAt,
      'the losing stale row must not be re-stamped newer than the claim',
    ).toBe(claimedUpdatedAt);
  }, 120000);
  it("refuses a stale second store's newer downgrade of a held claim (AC2)", () => {
    const title = 'Stale clone target';
    const id = createItem(s.local, title);

    // Put the item at prd_complete, then seed the remote with that
    // pre-claim state (open / prd_complete).
    expect(runCli(s.local, ['--json', 'update', id, '--stage', 'prd_complete', '--no-re-sort']).status).toBe(0);
    const seed = runCli(s.local, ['--json', 'sync']);
    expect(seed.status, seed.stderr).toBe(0);

    // A second checkout ("clone") of the same project: same worklog remote,
    // same project prefix — i.e. a second store. It pulls the pre-claim row.
    const other = path.join(s.root, 'other');
    git(s.root, 'init', '-q', other);
    git(other, 'config', 'user.email', 'test@example.com');
    git(other, 'config', 'user.name', 'Test User');
    git(other, 'remote', 'add', 'origin', s.remote);
    writeConfig(other, 'Claim Revert Test', 'CRV');
    writeInitSemaphore(other);
    fs.writeFileSync(path.join(other, 'README.md'), '# other\n', 'utf8');
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'init');
    expect(runCli(other, ['--json', 'sync']).status).toBe(0);

    // The agent claims the item and advances it in the main checkout.
    const claim = runCli(s.local, ['--json', 'update', id, '-s', 'in_progress', '--stage', 'plan_complete', '--no-re-sort']);
    expect(claim.status, claim.stderr).toBe(0);
    const claimed = showItem(s.local, id);
    expect(claimed.workItem.status).toBe('in-progress');
    expect(claimed.workItem.stage).toBe('plan_complete');

    // The stale store bumps the row (edit and revert: the *content* ends up
    // unchanged, so the eventual merge must not re-stamp the claim) and pushes
    // its stale status/stage pair with a newer updatedAt.
    expect(runCli(other, ['--json', 'update', id, '-t', 'temp title', '--no-re-sort']).status).toBe(0);
    expect(runCli(other, ['--json', 'update', id, '-t', title, '--no-re-sort']).status).toBe(0);
    const staleRow = showItem(other, id);
    expect(staleRow.workItem.status).toBe('open');
    expect(staleRow.workItem.stage).toBe('prd_complete');
    expect(new Date(staleRow.workItem.updatedAt!).getTime())
      .toBeGreaterThan(new Date(claimed.workItem.updatedAt!).getTime());
    expect(runCli(other, ['--json', 'sync']).status).toBe(0);

    // The main checkout syncs: the stale, newer row must not downgrade the
    // held claim, and the claim's timestamps must be preserved.
    const res = runCli(s.local, ['--json', 'sync']);
    expect(res.status, res.stderr).toBe(0);

    const after = showItem(s.local, id);
    expect(after.workItem.status, 'claim status must survive').toBe('in-progress');
    expect(after.workItem.stage, 'claim stage must survive').toBe('plan_complete');
    expect(after.workItem.updatedAt, 'claim must not be re-stamped').toBe(claimed.workItem.updatedAt);
    expect(after.workItem.title).toBe(title);

    // The refusal is diagnosable from the --json output (AC2).
    const parsed = JSON.parse(res.stdout) as { sync?: { claimHolds?: Array<{ workItemId: string; fields: string[] }> } };
    const holds = parsed.sync?.claimHolds ?? [];
    expect(holds.some(h => h.workItemId === id)).toBe(true);
  }, 180000);

  it('releases the claim once protection is disabled (TTL-bounded, AC3)', () => {
    const title = 'TTL-bounded claim target';
    const id = createItem(s.local, title);
    expect(runCli(s.local, ['--json', 'update', id, '--stage', 'prd_complete', '--no-re-sort']).status).toBe(0);
    expect(runCli(s.local, ['--json', 'sync']).status).toBe(0);

    const other = path.join(s.root, 'other');
    git(s.root, 'init', '-q', other);
    git(other, 'config', 'user.email', 'test@example.com');
    git(other, 'config', 'user.name', 'Test User');
    git(other, 'remote', 'add', 'origin', s.remote);
    writeConfig(other, 'Claim Revert Test', 'CRV');
    writeInitSemaphore(other);
    fs.writeFileSync(path.join(other, 'README.md'), '# other\n', 'utf8');
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'init');
    expect(runCli(other, ['--json', 'sync']).status).toBe(0);

    const claim = runCli(s.local, ['--json', 'update', id, '-s', 'in_progress', '--stage', 'plan_complete', '--no-re-sort']);
    expect(claim.status, claim.stderr).toBe(0);
    const claimed = showItem(s.local, id);
    expect(claimed.workItem.status).toBe('in-progress');
    expect(claimed.workItem.stage).toBe('plan_complete');

    expect(runCli(other, ['--json', 'update', id, '-t', 'temp title', '--no-re-sort']).status).toBe(0);
    expect(runCli(other, ['--json', 'update', id, '-t', title, '--no-re-sort']).status).toBe(0);
    expect(runCli(other, ['--json', 'sync']).status).toBe(0);

    // `syncClaimHoldTtlHours: 0` disables the claim-hold guard: the newer stale
    // row wins again, proving the protection is time-bounded rather than an
    // unconditional local precedence.
    const configPath = path.join(s.local, '.worklog', 'config.yaml');
    fs.appendFileSync(configPath, '\nsyncClaimHoldTtlHours: 0\n');

    const res = runCli(s.local, ['--json', 'sync']);
    expect(res.status, res.stderr).toBe(0);

    const after = showItem(s.local, id);
    // The stale stage now wins (non-default → non-default, resolved by
    // timestamp) and the row is re-stamped as the newest row.
    expect(after.workItem.stage).toBe('prd_complete');
    expect(new Date(after.workItem.updatedAt!).getTime())
      .toBeGreaterThan(new Date(claimed.workItem.updatedAt!).getTime());
    // The *status* still cannot regress: that is the pre-existing merge-layer
    // regression guard (`isRegressionDefault`), which is independent of the
    // claim-hold TTL.
    expect(after.workItem.status).toBe('in-progress');
    // No claim-hold refusal is reported when the guard is disabled.
    const parsed = JSON.parse(res.stdout) as { sync?: { claimHolds?: unknown[] } };
    expect(parsed.sync?.claimHolds ?? []).toEqual([]);
  }, 180000);
  it('mechanism (b): refuses to create a second store when no main store exists (actionable error)', () => {
    // A repository with a managed worktree path but no initialised store
    // anywhere: a command inside the worktree must fail loudly instead of
    // silently initialising a second store for the same prefix.
    const project = path.join(s.root, 'nostore');
    git(s.root, 'init', '-q', project);
    const worktree = path.join(project, '.worklog', 'worktrees', 'wl-CRV-2-nostore');
    fs.mkdirSync(path.join(worktree, '.worklog'), { recursive: true });
    fs.writeFileSync(
      path.join(worktree, '.worklog', 'config.yaml'),
      'projectName: No Store\nprefix: CRV\n',
      'utf8',
    );

    const res = runCli(worktree, ['--json', 'show', 'CRV-000000']);
    expect(res.status).not.toBe(0);
    const output = `${res.stdout}\n${res.stderr}`;
    expect(output).toContain('--worklog-dir');
    expect(output.toLowerCase()).toContain('second store');
    expect(fs.existsSync(path.join(worktree, '.worklog', 'worklog.db'))).toBe(false);
  }, 60000);

  it('mechanism (b): a deliberately initialised worktree store is still honoured', () => {
    const project = path.join(s.root, 'ownstore');
    git(s.root, 'init', '-q', project);
    const worktree = path.join(project, '.worklog', 'worktrees', 'wl-CRV-3-ownstore');
    fs.mkdirSync(path.join(worktree, '.worklog'), { recursive: true });
    fs.writeFileSync(
      path.join(worktree, '.worklog', 'config.yaml'),
      'projectName: Own Store\nprefix: CRV\n',
      'utf8',
    );
    // `wl init` marks a store as genuine (the `initialized` semaphore).
    fs.writeFileSync(path.join(worktree, '.worklog', 'initialized'), '{}', 'utf8');

    const res = runCli(worktree, ['--json', 'show', 'CRV-000000']);
    const output = `${res.stdout}\n${res.stderr}`;
    // No store-identity refusal: the command bound to the worktree's own store
    // and simply did not find the (non-existent) item there.
    expect(output.toLowerCase()).not.toContain('second store');
  }, 60000);
});
