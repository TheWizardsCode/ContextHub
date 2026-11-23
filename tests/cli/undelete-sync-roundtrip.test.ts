/**
 * Two-store sync round-trip for `wl undelete` (WL-0MWMS4GUJ00576TB, parent
 * WL-0MWMRNL2W003W5R3).
 *
 * The merge unit tests (`tests/sync/undelete-merge.test.ts`) prove the rule in
 * isolation; this suite proves it end-to-end through the real CLI against a
 * real bare remote, because the failure mode that matters is a *peer* holding
 * the tombstone:
 *
 *   1. A creates an item, both stores sync — the item is live in both.
 *   2. A deletes it; B syncs and sees the tombstone.
 *   3. A restores it with `wl undelete` (auto-sync); B syncs — the item must be
 *      live again in B, **not** re-tombstoned by the copy B already holds.
 *   4. B syncs a second time — the restore must not flap back to deleted.
 *   5. B then deletes it again; A syncs — a later attributed delete still wins,
 *      so a restore never makes an item undeletable.
 *
 * Two clients sharing one bare remote is the harness from
 * `tests/cli/sync-integration-convergence.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { writeConfig, writeInitSemaphore } from './cli-helpers.js';
import { cliInvocation } from './cli-bundle.js';
import { fixtureGitEnv } from './git-helpers.js';

function cliSpawn(args: string[], options: Parameters<typeof spawnSync>[2]) {
  const [command, entry] = cliInvocation();
  return spawnSync(command, [entry, ...args], options);
}

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync('git', args, { cwd, encoding: 'utf-8', env: fixtureGitEnv() });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
  }
  return res.stdout.trim();
}

function runCli(
  cwd: string,
  ...args: string[]
): { stdout: string; stderr: string; status: number } {
  const res = cliSpawn(args, { cwd, encoding: 'utf-8', env: fixtureGitEnv() });
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status ?? -1 };
}

/** Client A: a project with a bare remote and its own store. */
function setupProject(): { root: string; remote: string; local: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-undelete-rt-'));
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');
  git(root, 'init', '--bare', '-q', remote);
  git(root, 'init', '-q', local);
  // Both stores must share one git identity: the synced worklog commits carry
  // the author, and `wl sync` refuses to merge commits from a foreign author.
  git(local, 'config', 'user.email', 'test@example.com');
  git(local, 'config', 'user.name', 'Test User');
  git(local, 'remote', 'add', 'origin', remote);
  writeConfig(local, 'Undelete Roundtrip', 'UND');
  writeInitSemaphore(local);
  fs.writeFileSync(path.join(local, 'README.md'), '# undelete roundtrip\n', 'utf8');
  git(local, 'add', '-A');
  git(local, 'commit', '-q', '-m', 'init');
  return { root, remote, local };
}

/** Client B: a fresh clone of the same project with its own (empty) store. */
function addClient(
  s: { root: string; remote: string },
  name: string
): string {
  const dir = path.join(s.root, name);
  git(s.root, 'clone', '-q', s.remote, dir);
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test User');
  writeConfig(dir, 'Undelete Roundtrip', 'UND');
  writeInitSemaphore(dir);
  return dir;
}

function createItem(cwd: string, title: string): string {
  const res = runCli(cwd, '--json', 'create', '-t', title);
  expect(res.status, res.stderr).toBe(0);
  const parsed = JSON.parse(res.stdout);
  const id: string = parsed.workItem?.id ?? parsed.id;
  expect(id).toBeTruthy();
  return id;
}

function sync(cwd: string): void {
  const res = runCli(cwd, '--json', 'sync');
  expect(res.status, res.stderr).toBe(0);
}

/** Read one item as the store at `cwd` sees it (deleted items included). */
function showItem(cwd: string, id: string): any {
  const res = runCli(cwd, '--json', 'show', id);
  expect(res.status, res.stderr).toBe(0);
  return JSON.parse(res.stdout).workItem;
}

describe('undelete ↔ peer sync round-trip (real git remote)', () => {
  let s: { root: string; remote: string; local: string };
  let peer: string;

  beforeEach(() => {
    s = setupProject();
    peer = addClient(s, 'peer');
  });

  afterEach(() => {
    fs.rmSync(s.root, { recursive: true, force: true });
  });

  it('a restore reaches a peer that still holds the tombstone and does not flap', () => {
    const id = createItem(s.local, 'Round-trip item');
    sync(s.local);
    sync(peer);
    expect(showItem(peer, id).status).toBe('open');

    // 1. The delete propagates to the peer.
    const del = runCli(s.local, '--json', 'delete', id, '--deleted-by', 'restorer@example.com');
    expect(del.status, del.stderr).toBe(0);
    sync(s.local);
    sync(peer);
    const peerDeleted = showItem(peer, id);
    expect(peerDeleted.status).toBe('deleted');
    expect(peerDeleted.deletedBy).toBe('restorer@example.com');

    // 2. The restore on A must beat the tombstone the peer already holds.
    const restored = runCli(s.local, '--json', 'undelete', id);
    expect(restored.status, restored.stderr).toBe(0);
    expect(JSON.parse(restored.stdout).success).toBe(true);
    sync(s.local);
    sync(peer);

    const peerRestored = showItem(peer, id);
    expect(peerRestored.status).toBe('open');
    expect(peerRestored.deletedBy ?? '').toBe('');
    expect(peerRestored.deleteReason ?? '').toBe('');

    // 3. A repeated sync must not re-apply the peer's stale tombstone.
    sync(peer);
    sync(s.local);
    expect(showItem(peer, id).status).toBe('open');
    expect(showItem(s.local, id).status).toBe('open');

    // 4. A delete *after* a restore still wins: a restore is not a lock.
    const reDeleted = runCli(peer, '--json', 'delete', id, '--deleted-by', 'peer@example.com');
    expect(reDeleted.status, reDeleted.stderr).toBe(0);
    sync(peer);
    sync(s.local);

    const finallyDeleted = showItem(s.local, id);
    expect(finallyDeleted.status).toBe('deleted');
    expect(finallyDeleted.deletedBy).toBe('peer@example.com');
  }, 120000);
});
