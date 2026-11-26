/**
 * E2E: cross-repo dependency edges survive a real full and delta sync
 * (WL-0MWXIT6H3006TY2I).
 *
 * A dependency edge whose target is a **foreign** cross-project id must not be
 * silently dropped by the sync pipeline. Two drop points are exercised here
 * against the compiled CLI + a real bare remote:
 *
 *   1. the merge-time prefix filter (`filterRemoteDataByPrefix`), and
 *   2. the destructive import / non-destructive upsert endpoint guard.
 *
 * The edge is recorded directly on the local store (with
 * `allowForeignTarget`) so the test does not need a discovered sibling
 * project — the sync pipeline is what is under test, not foreign resolution.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { writeConfig, writeInitSemaphore } from './cli-helpers.js';
import { cliInvocation } from './cli-bundle.js';
import { fixtureGitEnv } from './git-helpers.js';
import { WorklogDatabase } from '../../packages/shared/src/database.js';

const FOREIGN_TARGET = 'SA-0MWFFD9N0050SP5';
const SECOND_FOREIGN_TARGET = 'SA-0MWFFD9N0050SP6';

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

function runCli(cwd: string, ...args: string[]): { stdout: string; stderr: string; status: number } {
  const res = cliSpawn(args, { cwd, encoding: 'utf-8', env: fixtureGitEnv() });
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status ?? -1 };
}

interface Setup {
  root: string;
  remote: string;
  local: string;
}

function setupProject(): Setup {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-cross-repo-edge-'));
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');
  git(root, 'init', '--bare', '-q', remote);
  git(root, 'init', '-q', local);
  git(local, 'config', 'user.email', 'test@example.com');
  git(local, 'config', 'user.name', 'Test User');
  git(local, 'remote', 'add', 'origin', remote);
  writeConfig(local, 'Cross-repo edge test', 'CRX');
  writeInitSemaphore(local);
  fs.writeFileSync(path.join(local, 'README.md'), '# cross-repo edge\n', 'utf8');
  git(local, 'add', '-A');
  git(local, 'commit', '-q', '-m', 'init');
  return { root, remote, local };
}

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

function updateTitle(local: string, id: string, title: string): void {
  const res = runCli(local, '--json', 'update', id, '-t', title);
  expect(res.status, res.stderr).toBe(0);
}

function sync(local: string): { stdout: string; stderr: string; status: number } {
  const res = runCli(local, 'sync');
  expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
  return res;
}

/** Open the local store directly (autoSync disabled) to record/read edges. */
function withStore<T>(local: string, fn: (db: WorklogDatabase) => T): T {
  const db = new WorklogDatabase(
    'CRX',
    path.join(local, '.worklog', 'worklog.db'),
    path.join(local, '.worklog', 'worklog-data.jsonl'),
    true,
    false,
  );
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function addForeignEdge(local: string, fromId: string, toId: string): void {
  withStore(local, (db) => {
    const edge = db.addDependencyEdge(fromId, toId, { allowForeignTarget: true });
    expect(edge, `could not record ${fromId} -> ${toId}`).not.toBeNull();
  });
}

function outboundTargets(local: string, fromId: string): string[] {
  return withStore(local, (db) => db.listDependencyEdgesFrom(fromId).map((e) => e.toId));
}

function cloneProject(s: Setup): string {
  const clone = path.join(s.root, 'clone');
  git(s.root, 'clone', '-q', s.remote, clone);
  git(clone, 'config', 'user.email', 'test@example.com');
  git(clone, 'config', 'user.name', 'Test User');
  writeConfig(clone, 'Cross-repo edge test', 'CRX');
  writeInitSemaphore(clone);
  return clone;
}

function remoteTipKind(local: string): string | undefined {
  git(local, 'fetch', '-q', 'origin', '+refs/worklog/data:refs/worklog/remotes/origin/worklog/data');
  const content = git(local, 'show', 'refs/worklog/remotes/origin/worklog/data:.worklog/worklog-data.jsonl');
  try {
    const first = JSON.parse(content.trim().split('\n')[0]);
    return first?.__worklog_sync__?.kind;
  } catch {
    return undefined;
  }
}

describe('cross-repo dependency edges survive sync (WL-0MWXIT6H3006TY2I)', () => {
  let s: Setup;

  beforeEach(() => {
    s = setupProject();
  });

  afterEach(() => {
    fs.rmSync(s.root, { recursive: true, force: true });
  });

  it('keeps a local→foreign edge through a full sync and a delta sync', () => {
    const owner = createItem(s.local, 'Blocked on sibling repo');
    addForeignEdge(s.local, owner, FOREIGN_TARGET);

    // ── Full sync: the edge is exported and survives the destructive import.
    sync(s.local);
    expect(remoteTipKind(s.local)).toBe('full');
    expect(outboundTargets(s.local, owner)).toContain(FOREIGN_TARGET);

    const clone = cloneProject(s);
    sync(clone);
    expect(outboundTargets(clone, owner)).toContain(FOREIGN_TARGET);

    // ── Delta sync: a second foreign edge recorded on the ahead store must
    // survive the delta merge on the behind store. Touching the owner's
    // title puts it in the delta item set so its `dependencies` array is
    // emitted with the new edge.
    addForeignEdge(s.local, owner, SECOND_FOREIGN_TARGET);
    updateTitle(s.local, owner, 'Blocked on two sibling repos');
    sync(s.local);
    expect(remoteTipKind(s.local)).toBe('delta');

    sync(clone);
    const targets = outboundTargets(clone, owner);
    expect(targets).toContain(FOREIGN_TARGET);
    expect(targets).toContain(SECOND_FOREIGN_TARGET);
  }, 180000);
});
