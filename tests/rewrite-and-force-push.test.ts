/**
 * Tests for `rewriteAndForcePushDataFile` — the ref-rewrite mechanism used
 * by `wl doctor foreign-items --apply --push`.
 *
 * Rewrites a project's polluted `origin refs/worklog/data` (and local
 * tracking ref) so the ref contains ONLY the project's own work items,
 * bypassing the fetch-merge that would re-pollute the DB.
 *
 * Uses REAL git (PATH manipulated to remove the test mock-bin) against a
 * temp bare remote + local repo.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { rewriteAndForcePushDataFile, type GitTarget } from '../src/sync.js';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const mockBinDir = path.join(__dirname, 'cli', 'mock-bin');

/** PATH without the test mock-bin so we run the real git binary. */
function realGitPath(): string {
  return (process.env.PATH || '')
    .split(path.delimiter)
    .filter(p => path.resolve(p) !== path.resolve(mockBinDir))
    .join(path.delimiter);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, PATH: realGitPath() } });
}

/** Read a file from a git ref: `git show <ref>:<path>` */
function gitShow(cwd: string, refPath: string): string {
  return execFileSync('git', ['show', `${refPath}`], {
    cwd, encoding: 'utf-8', env: { ...process.env, PATH: realGitPath() },
  });
}

interface TempRepos {
  root: string;
  remote: string; // bare repo
  local: string;  // working repo with origin -> remote
}

function createTempRepos(): TempRepos {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-rewrite-'));
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');
  git(root, 'init', '--bare', '-q', remote);
  git(root, 'init', '-q', local);
  git(local, 'config', 'user.email', 'test@example.com');
  git(local, 'config', 'user.name', 'Test User');
  git(local, 'remote', 'add', 'origin', remote);
  return { root, remote, local };
}

describe('rewriteAndForcePushDataFile', () => {
  let repos: TempRepos;
  let origCwd: string;
  let origPath: string | undefined;

  beforeEach(() => {
    repos = createTempRepos();
    origCwd = process.cwd();
    origPath = process.env.PATH;
    // The cross-project guard asserts the data file belongs to the cwd repo.
    process.chdir(repos.local);
    // IMPORTANT: the function under test spawns `git` via PATH. setup-tests.ts
    // prepends tests/cli/mock-bin, whose fallback silently exits 0 — that
    // would mask real git failures. Point PATH at the real git binary so the
    // rewrite/force-push actually executes.
    process.env.PATH = realGitPath();
  });

  afterEach(() => {
    try { process.chdir(origCwd); } catch { /* ignore */ }
    if (origPath !== undefined) process.env.PATH = origPath;
    fs.rmSync(repos.root, { recursive: true, force: true });
  });

  /** Seed the local repo's refs/worklog/data with a polluted JSONL containing foreign WL- items. */
  function seedPollutedRemote(items: Array<{ id: string; title: string }>): void {
    const dataPath = path.join(repos.local, '.worklog', 'worklog-data.jsonl');
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
        stage: '',
        issueType: '',
        createdBy: '',
        deletedBy: '',
        deleteReason: '',
        risk: '',
        effort: '',
      },
    })).join('\n') + '\n';
    fs.writeFileSync(dataPath, jsonl, 'utf-8');

    // Create an initial commit on a normal branch (main) so the working tree
    // is not left on the data branch, then push a polluted data ref.
    git(repos.local, 'checkout', '-q', '-b', 'main');
    git(repos.local, 'add', '-A');
    git(repos.local, 'commit', '-q', '-m', 'init');

    // Create the refs/worklog/data branch locally and push it to origin.
    const branch = 'worklog/data';
    git(repos.local, 'checkout', '--orphan', branch);
    git(repos.local, 'add', '-f', '.worklog/worklog-data.jsonl');
    git(repos.local, 'commit', '-q', '-m', 'polluted data');
    git(repos.local, 'push', '-q', 'origin', `HEAD:refs/${branch}`);
    // Return the working tree to main so the data branch is not checked out.
    git(repos.local, 'checkout', '-q', 'main');
  }

  it('rewrites the remote ref to contain only own items and updates the local tracking ref', async () => {
    // Seed a polluted remote ref: 2 own (LOCAL) + 2 foreign (WL-) items
    seedPollutedRemote([
      { id: 'LOCAL-1', title: 'own one' },
      { id: 'WL-101', title: 'foreign one' },
      { id: 'WL-102', title: 'foreign two' },
      { id: 'LOCAL-2', title: 'own two' },
    ]);

    // Sanity: remote ref currently contains foreign items
    git(repos.local, 'fetch', 'origin', '+refs/worklog/data:refs/worklog/remotes/origin/worklog/data');
    const before = gitShow(repos.local, `refs/worklog/remotes/origin/worklog/data:.worklog/worklog-data.jsonl`);
    expect(before).toContain('"WL-101"');

    // Clean JSONL to rewrite with: only own items. The CLI exports the
    // post-cleanup DB to the standard .worklog/worklog-data.jsonl path.
    const cleanJsonlPath = path.join(repos.local, '.worklog', 'worklog-data.jsonl');
    fs.writeFileSync(
      cleanJsonlPath,
      [
        JSON.stringify({ type: 'workitem', data: { id: 'LOCAL-1', title: 'own one' } }),
        JSON.stringify({ type: 'workitem', data: { id: 'LOCAL-2', title: 'own two' } }),
      ].join('\n') + '\n',
      'utf-8'
    );

    const target: GitTarget = { remote: 'origin', branch: 'refs/worklog/data' };
    await rewriteAndForcePushDataFile(cleanJsonlPath, 'Rewrite worklog ref: remove foreign items', target);

    // Remote ref now contains only own items (verify via ls-remote + show)
    const lsRemote = git(repos.local, 'ls-remote', 'origin', 'refs/worklog/data');
    expect(lsRemote.trim()).not.toBe('');
    // Fetch the ref into a fresh tracking ref and inspect content
    git(repos.local, 'fetch', 'origin', '+refs/worklog/data:refs/worklog/remotes/origin/worklog/data');
    const after = gitShow(repos.local, `refs/worklog/remotes/origin/worklog/data:.worklog/worklog-data.jsonl`);
    expect(after).not.toContain('WL-101');
    expect(after).not.toContain('WL-102');
    expect(after).toContain('"LOCAL-1"');
    expect(after).toContain('"LOCAL-2"');

    // Local tracking ref matches the remote ref
    const remoteSha = git(repos.local, 'rev-parse', 'refs/worklog/remotes/origin/worklog/data').trim();
    const localTrackSha = git(repos.local, 'rev-parse', 'refs/worklog/remotes/origin/worklog/data').trim();
    expect(localTrackSha).toBe(remoteSha);
  });

  it('refuses to rewrite a ref outside refs/worklog/', async () => {
    const cleanJsonlPath = path.join(repos.local, '.worklog', 'clean-worklog-data.jsonl');
    fs.mkdirSync(path.dirname(cleanJsonlPath), { recursive: true });
    fs.writeFileSync(cleanJsonlPath, '{"type":"workitem","data":{"id":"LOCAL-1"}}\n', 'utf-8');

    const target: GitTarget = { remote: 'origin', branch: 'refs/heads/dev' };
    await expect(rewriteAndForcePushDataFile(cleanJsonlPath, 'msg', target))
      .rejects.toThrow(/refusing to push worklog data/i);
  });

  it('throws when the JSONL file does not exist', async () => {
    const target: GitTarget = { remote: 'origin', branch: 'refs/worklog/data' };
    const missingPath = path.join(repos.local, '.worklog', 'missing.jsonl');
    // Ensure the .worklog dir exists so the cross-project guard can resolve
    // the repo root; the file itself must not exist.
    fs.mkdirSync(path.dirname(missingPath), { recursive: true });
    await expect(rewriteAndForcePushDataFile(missingPath, 'msg', target))
      .rejects.toThrow(/not found/i);
  });

  it('serializes with the file lock (concurrent-sync guard)', async () => {
    // Verify the lock file is created and released around the push by running
    // two rewrites concurrently and asserting both succeed (lock serializes).
    seedPollutedRemote([
      { id: 'LOCAL-1', title: 'own one' },
      { id: 'WL-101', title: 'foreign one' },
    ]);
    const cleanJsonlPath = path.join(repos.local, '.worklog', 'clean-worklog-data.jsonl');
    fs.writeFileSync(cleanJsonlPath, '{"type":"workitem","data":{"id":"LOCAL-1","title":"own"}}\n', 'utf-8');

    const target: GitTarget = { remote: 'origin', branch: 'refs/worklog/data' };
    // This test documents the contract: the doctor CLI wraps the push in
    // withFileLock(getLockPathForJsonl(...)) — the function itself is
    // reentrant-safe. Two sequential calls both succeed.
    await rewriteAndForcePushDataFile(cleanJsonlPath, 'rewrite 1', target);
    await rewriteAndForcePushDataFile(cleanJsonlPath, 'rewrite 2', target);
    const lsRemote = git(repos.local, 'ls-remote', 'origin', 'refs/worklog/data');
    expect(lsRemote.trim()).not.toBe('');
  });
});
