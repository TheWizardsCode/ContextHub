/**
 * Regression tests for the lost-update race between `wl sync` and the
 * single-command mutators (WL-0MUV2U9QF002S9J1, origin CG-0MUUFGXFX004O2X7).
 *
 * `wl sync` holds the per-store advisory file lock for its whole
 * fetch → merge → write → push operation, but `wl update`, `wl comment add`
 * and `wl audit-set` historically did not. A mutation that landed inside the
 * sync's read→write window was therefore overwritten by the sync's stale
 * snapshot: a terminal `completed`/`in_review` transition was reverted and a
 * concurrently-added comment was lost.
 *
 * These tests use REAL git + a real bare remote against the compiled CLI
 * (dist/cli.js), and a PATH git shim that parks the sync inside `git fetch`
 * until the test releases it. Parking the sync widens the read→write window
 * deterministically, so the overlap does not depend on timing races.
 *
 * AC1: the terminal state + concurrently-added comment survive the sync.
 * AC3: an intentional `wl audit-set --ready-to-close no` still reverts
 *      `completed`/`in_review` → `open`/`plan_complete` (the confounder is
 *      excluded, not the defect).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { writeConfig, writeInitSemaphore } from './cli-helpers.js';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const projectRoot = path.resolve(__dirname, '..', '..');
const cliPath = path.join(projectRoot, 'dist', 'cli.js');
const mockBinDir = path.join(projectRoot, 'tests', 'cli', 'mock-bin');

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
  const res = spawnSync('node', [cliPath, ...args], {
    cwd,
    encoding: 'utf-8',
    env: env ?? realGitEnv(),
    timeout: 60000,
  });
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status ?? -1 };
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

interface SpawnedCli {
  child: ChildProcess;
  done: Promise<SpawnResult>;
}

/** Spawn the compiled CLI without blocking the test process. */
function spawnCli(
  cwd: string,
  args: string[],
  env: Record<string, string>,
): SpawnedCli {
  const child = spawn('node', [cliPath, ...args], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
  child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
  const done = new Promise<SpawnResult>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', status => resolve({ stdout, stderr, status }));
  });
  return { child, done };
}

/** Wait until *file* exists (or throw after *timeoutMs*). */
async function waitForFile(file: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for file: ${file}`);
}

/** Shape of the subset of `wl show --json` this suite asserts on. */
interface ShowResult {
  workItem: { id: string; status: string; stage: string };
  comments: Array<{ author: string; comment: string }>;
}

function showItem(cwd: string, id: string): ShowResult {
  const res = runCli(cwd, ['--json', 'show', id]);
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
 * Build a git shim that parks every `git fetch` until a release file appears.
 * This widens `wl sync`'s read→write window deterministically.
 */
function setupProject(): Setup {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-sync-mutation-'));
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');
  git(root, 'init', '--bare', '-q', remote);
  git(root, 'init', '-q', local);
  git(local, 'config', 'user.email', 'test@example.com');
  git(local, 'config', 'user.name', 'Test User');
  git(local, 'remote', 'add', 'origin', remote);
  writeConfig(local, 'Sync Mutation Test', 'SMT');
  writeInitSemaphore(local);
  fs.writeFileSync(path.join(local, 'README.md'), '# sync mutation\n', 'utf8');
  git(local, 'add', '-A');
  git(local, 'commit', '-q', '-m', 'init');

  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-git-shim-'));
  const marker = path.join(shimDir, 'fetch-started');
  const release = path.join(shimDir, 'fetch-release');
  const realGit = execFileSync('which', ['git'], {
    encoding: 'utf-8',
    env: realGitEnv(),
  }).trim();
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
  const shimPath = path.join(shimDir, 'git');
  fs.writeFileSync(shimPath, shim, { mode: 0o755 });

  return { root, remote, local, shimDir, marker, release, realGit };
}

/** Environment for a spawned sync: the git shim is first on PATH. */
function shimEnv(s: Setup): Record<string, string> {
  return {
    ...realGitEnv(),
    PATH: `${s.shimDir}${path.delimiter}${realGitEnv().PATH}`,
    GIT_SHIM_MARKER: s.marker,
    GIT_SHIM_RELEASE: s.release,
    GIT_SHIM_REAL: s.realGit,
  };
}

/** Create a work item via the CLI and return its id. */
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

describe('wl sync vs concurrent mutation (lost-update race)', () => {
  let s: Setup;

  beforeEach(() => {
    s = setupProject();
  });

  afterEach(() => {
    fs.rmSync(s.root, { recursive: true, force: true });
    fs.rmSync(s.shimDir, { recursive: true, force: true });
  });

  it('AC1/AC2: a concurrent completed/in_review update and comment survive a sync', async () => {
    const id = createItem(s.local, 'Concurrent mutation target');

    // Seed the remote with a first full snapshot (also establishes the
    // watermark baseline so the second sync exercises the merge write-back).
    const seed = runCli(s.local, ['--json', 'sync']);
    expect(seed.status, seed.stderr).toBe(0);
    expect(seed.stdout).toContain('"success": true');

    // Park the sync inside `git fetch` (after it has taken its local
    // snapshot, before it writes the merged set back).
    const sync = spawnCli(s.local, ['--json', 'sync'], shimEnv(s));
    await waitForFile(s.marker, 20000);

    // Mutate the item to a terminal state and add a comment while the sync
    // is parked. On the fixed code both commands wait for the sync's lock;
    // on the buggy code they land inside the window and are clobbered.
    const mutation = (async () => {
      const upd = spawnCli(
        s.local,
        ['--json', 'update', id, '-s', 'completed', '--stage', 'in_review'],
        realGitEnv(),
      );
      const updRes = await upd.done;
      expect(updRes.status, updRes.stderr).toBe(0);
      const cmt = spawnCli(
        s.local,
        ['--json', 'comment', 'add', id, '-a', 'test', '-c', 'completed concurrently'],
        realGitEnv(),
      );
      const cmtRes = await cmt.done;
      expect(cmtRes.status, cmtRes.stderr).toBe(0);
    })();

    // Give the mutation a chance to complete before we release the sync. On
    // the buggy code it finishes here; on the fixed code it is still blocked
    // on the store lock and will finish after the sync releases it.
    await Promise.race([
      mutation,
      new Promise(r => setTimeout(r, 3000)),
    ]);

    // Release the parked fetch and let both processes finish.
    fs.writeFileSync(s.release, 'go');
    const syncRes = await sync.done;
    expect(syncRes.status, syncRes.stderr).toBe(0);
    await mutation;

    // The terminal state and the comment must both have survived the sync.
    const after = showItem(s.local, id);
    expect(after.workItem.status).toBe('completed');
    expect(after.workItem.stage).toBe('in_review');
    expect(
      after.comments.some(c => c.comment.includes('completed concurrently')),
    ).toBe(true);
  }, 90000);

  it('AC1: a concurrent wl close --force survives a sync (item stays completed/done, comment intact)', async () => {
    const id = createItem(s.local, 'Concurrent close target');

    // Seed the remote with a first full snapshot (also establishes the
    // watermark baseline so the second sync exercises the merge write-back).
    const seed = runCli(s.local, ['--json', 'sync']);
    expect(seed.status, seed.stderr).toBe(0);
    expect(seed.stdout).toContain('"success": true');

    // Park the sync inside `git fetch` (after it has taken its local
    // snapshot, before it writes the merged set back).
    const sync = spawnCli(s.local, ['--json', 'sync'], shimEnv(s));
    await waitForFile(s.marker, 20000);

    // Close the item while the sync is parked. On the fixed code the close
    // waits for the sync's lock; on the buggy code it lands inside the
    // window and is clobbered (item reverts to open, comment dropped).
    const mutation = (async () => {
      const close = spawnCli(
        s.local,
        ['--json', 'close', id, '--force', '--reason', 'closed concurrently'],
        realGitEnv(),
      );
      const closeRes = await close.done;
      expect(closeRes.status, closeRes.stderr).toBe(0);
    })();

    // Give the mutation a chance to complete before we release the sync. On
    // the buggy code it finishes here; on the fixed code it is still blocked
    // on the store lock and will finish after the sync releases it.
    await Promise.race([
      mutation,
      new Promise(r => setTimeout(r, 3000)),
    ]);

    // Release the parked fetch and let both processes finish.
    fs.writeFileSync(s.release, 'go');
    const syncRes = await sync.done;
    expect(syncRes.status, syncRes.stderr).toBe(0);
    await mutation;

    // The terminal state and the close comment must both have survived.
    const after = showItem(s.local, id);
    expect(after.workItem.status).toBe('completed');
    expect(after.workItem.stage).toBe('done');
    expect(
      after.comments.some(c => c.comment.includes('closed concurrently')),
    ).toBe(true);
  }, 90000);

  it('AC1/AC3: a concurrent wl delete --no-sync survives a sync (item stays deleted)', async () => {
    const id = createItem(s.local, 'Concurrent delete target');

    // Seed the remote with a first full snapshot (also establishes the
    // watermark baseline so the second sync exercises the merge write-back).
    const seed = runCli(s.local, ['--json', 'sync']);
    expect(seed.status, seed.stderr).toBe(0);
    expect(seed.stdout).toContain('"success": true');

    // Park the sync inside `git fetch` (after it has taken its local
    // snapshot, before it writes the merged set back).
    const sync = spawnCli(s.local, ['--json', 'sync'], shimEnv(s));
    await waitForFile(s.marker, 20000);

    // Soft-delete the item while the sync is parked. --no-sync keeps the
    // mutation local (and exercises the --no-sync path, AC3): on the fixed
    // code the delete waits for the sync's lock; on the buggy code it lands
    // inside the window and is clobbered (item reappears).
    const mutation = (async () => {
      const del = spawnCli(
        s.local,
        ['--json', 'delete', id, '--no-sync'],
        realGitEnv(),
      );
      const delRes = await del.done;
      expect(delRes.status, delRes.stderr).toBe(0);
    })();

    await Promise.race([
      mutation,
      new Promise(r => setTimeout(r, 3000)),
    ]);

    // Release the parked fetch and let both processes finish.
    fs.writeFileSync(s.release, 'go');
    const syncRes = await sync.done;
    expect(syncRes.status, syncRes.stderr).toBe(0);
    await mutation;

    // The deletion must have survived the sync.
    const after = showItem(s.local, id);
    expect(after.workItem.status).toBe('deleted');
  }, 90000);

  it('AC1: a concurrent wl dep add survives a sync (edge + blocked status intact)', async () => {
    const idA = createItem(s.local, 'Concurrent dep add target');
    const idB = createItem(s.local, 'Concurrent dep add depends-on');

    const seed = runCli(s.local, ['--json', 'sync']);
    expect(seed.status, seed.stderr).toBe(0);
    expect(seed.stdout).toContain('"success": true');

    const sync = spawnCli(s.local, ['--json', 'sync'], shimEnv(s));
    await waitForFile(s.marker, 20000);

    const mutation = (async () => {
      const dep = spawnCli(
        s.local,
        ['--json', 'dep', 'add', idA, idB],
        realGitEnv(),
      );
      const depRes = await dep.done;
      expect(depRes.status, depRes.stderr).toBe(0);
    })();

    await Promise.race([
      mutation,
      new Promise(r => setTimeout(r, 3000)),
    ]);

    fs.writeFileSync(s.release, 'go');
    const syncRes = await sync.done;
    expect(syncRes.status, syncRes.stderr).toBe(0);
    await mutation;

    // The dependency edge and the derived blocked status must both survive.
    const after = showItem(s.local, idA);
    expect(after.workItem.status).toBe('blocked');
    const depList = runCli(s.local, ['--json', 'dep', 'list', idA]);
    expect(depList.status, depList.stderr).toBe(0);
    const parsed = JSON.parse(depList.stdout) as { outbound: Array<{ id: string }> };
    expect(parsed.outbound.some(e => e.id === idB)).toBe(true);
  }, 90000);

  it('AC1: a concurrent wl dep rm survives a sync (edge stays removed)', async () => {
    const idA = createItem(s.local, 'Concurrent dep rm target');
    const idB = createItem(s.local, 'Concurrent dep rm depends-on');

    // Establish the edge before the parked sync takes its snapshot.
    const add = runCli(s.local, ['--json', 'dep', 'add', idA, idB]);
    expect(add.status, add.stderr).toBe(0);

    const seed = runCli(s.local, ['--json', 'sync']);
    expect(seed.status, seed.stderr).toBe(0);
    expect(seed.stdout).toContain('"success": true');

    const sync = spawnCli(s.local, ['--json', 'sync'], shimEnv(s));
    await waitForFile(s.marker, 20000);

    const mutation = (async () => {
      const dep = spawnCli(
        s.local,
        ['--json', 'dep', 'rm', idA, idB],
        realGitEnv(),
      );
      const depRes = await dep.done;
      expect(depRes.status, depRes.stderr).toBe(0);
    })();

    await Promise.race([
      mutation,
      new Promise(r => setTimeout(r, 3000)),
    ]);

    fs.writeFileSync(s.release, 'go');
    const syncRes = await sync.done;
    expect(syncRes.status, syncRes.stderr).toBe(0);
    await mutation;

    // The removal must survive the sync (edge not resurrected).
    const depList = runCli(s.local, ['--json', 'dep', 'list', idA]);
    expect(depList.status, depList.stderr).toBe(0);
    const parsed = JSON.parse(depList.stdout) as { outbound: Array<{ id: string }> };
    expect(parsed.outbound.some(e => e.id === idB)).toBe(false);
  }, 90000);

  it('AC3: an intentional "Ready to close: No" still reverts to open/plan_complete', () => {
    const id = createItem(s.local, 'Intentional revert target');

    const complete = runCli(
      s.local,
      ['--json', 'update', id, '-s', 'completed', '--stage', 'in_review'],
    );
    expect(complete.status, complete.stderr).toBe(0);
    expect(showItem(s.local, id).workItem.status).toBe('completed');

    // The documented auto-revert (WL-0MSKHYI5U0069FVV) is a legitimate
    // lifecycle transition and must remain intact.
    const audit = runCli(
      s.local,
      ['--json', 'audit-set', id, '--ready-to-close', 'no', '--summary', 'not ready'],
    );
    expect(audit.status, audit.stderr).toBe(0);

    const after = showItem(s.local, id);
    expect(after.workItem.status).toBe('open');
    expect(after.workItem.stage).toBe('plan_complete');
  }, 60000);
});
