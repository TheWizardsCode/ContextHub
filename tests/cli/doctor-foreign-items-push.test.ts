/**
 * Integration tests for `wl doctor foreign-items --apply --push`.
 *
 * Verifies the full remote-ref cleanup flow end-to-end with REAL git:
 *  - `--apply` removes foreign items from the DB
 *  - `--push` exports a clean JSONL and rewrites `origin refs/worklog/data`
 *    so it contains only own items, bypassing the polluted remote history
 *  - local tracking ref matches the new remote ref
 *  - a subsequent `wl sync` does not re-import foreign items
 *
 * These tests spawn the built CLI (dist/cli.js) as a subprocess with a PATH
 * that excludes the test mock-bin so the real git binary is used.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
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
  return res.stdout.trim();
}

function runCli(cwd: string, ...args: string[]): { stdout: string; status: number } {
  const res = spawnSync('node', [cliPath, ...args], { cwd, encoding: 'utf-8', env: realGitEnv() });
  return { stdout: res.stdout || '', status: res.status ?? -1 };
}

interface Setup {
  root: string;
  remote: string;
  local: string;
}

function setupProject(): Setup {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-push-cli-'));
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');
  git(root, 'init', '--bare', '-q', remote);
  git(root, 'init', '-q', local);
  git(local, 'config', 'user.email', 'test@example.com');
  git(local, 'config', 'user.name', 'Test User');
  git(local, 'remote', 'add', 'origin', remote);
  writeConfig(local, 'Push Test', 'TEST');
  writeInitSemaphore(local);
  return { root, remote, local };
}

/** Seed a polluted remote ref with both own and foreign items. */
function seedPollutedRemote(local: string, items: Array<{ id: string; title: string }>): void {
  const dataPath = path.join(local, '.worklog', 'worklog-data.jsonl');
  fs.mkdirSync(path.dirname(dataPath), { recursive: true });
  const now = new Date().toISOString();
  const jsonl = items.map(i => JSON.stringify({
    type: 'workitem',
    data: {
      id: i.id,
      title: i.title,
      description: '',
      status: 'open',
      priority: 'medium',
      sortIndex: 0,
      parentId: null,
      createdAt: now,
      updatedAt: now,
      tags: [],
      assignee: '',
      stage: 'idea',
      issueType: '',
      createdBy: '',
      deletedBy: '',
      deleteReason: '',
      risk: '',
      effort: '',
    },
  })).join('\n') + '\n';
  fs.writeFileSync(dataPath, jsonl, 'utf-8');

  git(local, 'checkout', '-q', '-b', 'main');
  git(local, 'add', '-A');
  git(local, 'commit', '-q', '-m', 'init');

  git(local, 'checkout', '--orphan', 'worklog/data');
  git(local, 'add', '-f', '.worklog/worklog-data.jsonl');
  git(local, 'commit', '-q', '-m', 'polluted data');
  git(local, 'push', '-q', 'origin', 'HEAD:refs/worklog/data');
  git(local, 'checkout', '-q', 'main');
}

describe('wl doctor foreign-items --apply --push (real git)', () => {
  let s: Setup;

  beforeEach(() => {
    s = setupProject();
  });

  afterEach(() => {
    fs.rmSync(s.root, { recursive: true, force: true });
  });

  it('applies cleanup and rewrites the remote ref to contain only own items', async () => {
    // Seed the DB with items (own + foreign) via the CLI so worklog.db exists
    // locally, then publish a polluted ref.
    seedPollutedRemote(s.local, [
      { id: 'TEST-1', title: 'own one' },
      { id: 'TEST-2', title: 'own two' },
      { id: 'WL-101', title: 'foreign one' },
      { id: 'WL-102', title: 'foreign two' },
    ]);

    // Import the seeded JSONL into the local SQLite DB and confirm foreign
    // items are present.
    const importRes = runCli(s.local, '--json', 'doctor', 'foreign-items', '--dry-run');
    const before = JSON.parse(importRes.stdout);
    expect(before.success).toBe(true);
    expect(before.foreignCount).toBe(2);

    // Apply + push: remove foreign items and rewrite the remote ref.
    const applyPush = runCli(s.local, '--json', 'doctor', 'foreign-items', '--apply', '--push');
    expect(applyPush.status).toBe(0);
    const applied = JSON.parse(applyPush.stdout);
    expect(applied.success).toBe(true);
    expect(applied.apply).toBe(true);
    expect(applied.removedCount).toBe(2);

    // After apply: dry-run reports zero foreign items.
    const afterDry = runCli(s.local, '--json', 'doctor', 'foreign-items', '--dry-run');
    const after = JSON.parse(afterDry.stdout);
    expect(after.foreignCount).toBe(0);
    expect(after.totalItems).toBe(2);

    // Remote ref now contains only own items.
    git(s.local, 'fetch', 'origin', '+refs/worklog/data:refs/worklog/remotes/origin/worklog/data');
    const remoteContent = git(s.local, 'show', 'refs/worklog/remotes/origin/worklog/data:.worklog/worklog-data.jsonl');
    expect(remoteContent).toContain('"TEST-1"');
    expect(remoteContent).toContain('"TEST-2"');
    expect(remoteContent).not.toContain('WL-101');
    expect(remoteContent).not.toContain('WL-102');

    // Local tracking ref matches the remote ref.
    const remoteSha = git(s.local, 'rev-parse', 'refs/worklog/remotes/origin/worklog/data');
    const localSha = git(s.local, 'rev-parse', 'refs/worklog/remotes/origin/worklog/data');
    expect(localSha).toBe(remoteSha);
  }, 120000);

  it('a subsequent sync does not re-import foreign items', async () => {
    seedPollutedRemote(s.local, [
      { id: 'TEST-1', title: 'own one' },
      { id: 'WL-101', title: 'foreign one' },
    ]);

    // Apply + push
    const applyPush = runCli(s.local, '--json', 'doctor', 'foreign-items', '--apply', '--push');
    expect(applyPush.status).toBe(0);

    // Now sync: should pull the CLEAN remote ref and not re-import WL- items.
    const syncRes = runCli(s.local, '--json', 'sync');
    expect(syncRes.status).toBe(0);
    const syncOut = JSON.parse(syncRes.stdout);
    // Total items should be only own items (no WL-).
    const list = runCli(s.local, '--json', 'list', '--deleted');
    const listOut = JSON.parse(list.stdout);
    const ids = listOut.workItems.map((i: { id: string }) => i.id);
    expect(ids).toContain('TEST-1');
    expect(ids.some((id: string) => id.startsWith('WL-'))).toBe(false);
  }, 120000);

  it('--push without --apply is refused (safety)', async () => {
    seedPollutedRemote(s.local, [
      { id: 'TEST-1', title: 'own' },
      { id: 'WL-101', title: 'foreign' },
    ]);

    const res = runCli(s.local, '--json', 'doctor', 'foreign-items', '--push');
    const out = JSON.parse(res.stdout);
    // Without --apply, --push must be refused: rewriting the remote ref
    // without cleaning the DB would push foreign items.
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/requires --apply/i);
    // Remote ref untouched (still contains foreign items)
    git(s.local, 'fetch', 'origin', '+refs/worklog/data:refs/worklog/remotes/origin/worklog/data');
    const remoteContent = git(s.local, 'show', 'refs/worklog/remotes/origin/worklog/data:.worklog/worklog-data.jsonl');
    expect(remoteContent).toContain('WL-101');
  }, 60000);
});
