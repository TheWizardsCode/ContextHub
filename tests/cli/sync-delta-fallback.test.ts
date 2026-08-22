/**
 * E2E tests for the full-snapshot fallback on the PULL side
 * (WL-0MT2KZ5GJ000OJIP, parent WL-0MSAKUBKW006FN8Q §6.2).
 *
 * Uses REAL git + a real bare remote (mock-bin stripped from PATH) against
 * the compiled CLI (dist/cli.js), mirroring tests/cli/sync-delta-pull.test.ts.
 *
 * AC1 — a pull whose remote tip is a DELTA but whose local store has NO
 *       records (brand-new clone / store recovered from corruption) triggers
 *       the missing-base fallback instead of merging the partial delta.
 * AC2 — the fallback reconstructs the full chain from the remote ref HISTORY
 *       (newest full snapshot + every delta after it) and re-anchors the
 *       remote with a full snapshot push (§5.1 no baseline → full).
 * AC5 — no data loss: the reconstructed store contains the base records AND
 *       the delta changes; an unrepairable chain (no full anywhere in
 *       history) fails closed — nothing is merged, nothing is pushed, the
 *       local store and remote ref are both left untouched.
 * AC7 — covered by the end-to-end scenarios below plus the shared merge tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { writeConfig, writeInitSemaphore } from './cli-helpers.js';
import { exportToJsonl } from '../../src/jsonl.js';
import type { WorkItem } from '../../src/types.js';

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

function runCli(cwd: string, ...args: string[]): { stdout: string; stderr: string; status: number } {
  const res = spawnSync('node', [cliPath, ...args], { cwd, encoding: 'utf-8', env: realGitEnv() });
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status ?? -1 };
}

interface Setup {
  root: string;
  remote: string;
  local: string;
}

/** Full project setup: bare remote + initialized local repo (identity test@example.com). */
function setupProject(): Setup {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-delta-fallback-'));
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');
  git(root, 'init', '--bare', '-q', remote);
  git(root, 'init', '-q', local);
  git(local, 'config', 'user.email', 'test@example.com');
  git(local, 'config', 'user.name', 'Test User');
  git(local, 'remote', 'add', 'origin', remote);
  writeConfig(local, 'Delta Fallback Test', 'DFT');
  writeInitSemaphore(local);
  fs.writeFileSync(path.join(local, 'README.md'), '# delta fallback\n', 'utf8');
  git(local, 'add', '-A');
  git(local, 'commit', '-q', '-m', 'init');
  return { root, remote, local };
}

/** Fresh checkout of the same project with an EMPTY local worklog store. */
function makeFreshClone(s: Setup, name: string): string {
  const dir = path.join(s.root, name);
  git(s.root, 'clone', '-q', s.remote, dir);
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test User');
  writeConfig(dir, 'Delta Fallback Test', 'DFT');
  writeInitSemaphore(dir);
  return dir;
}

/** Create a work item via the CLI and return its id. */
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

/** Build a WorkItem record shaped like a JSONL `workitem` line data. */
function makeItemRecord(id: string, title: string, updatedAt: string): WorkItem {
  return {
    id,
    title,
    description: '',
    status: 'open',
    priority: 'medium',
    sortIndex: 0,
    parentId: null,
    createdAt: updatedAt,
    updatedAt,
    tags: [],
    assignee: '',
    stage: 'idea',
    issueType: '',
    createdBy: '',
    deletedBy: '',
    deleteReason: '',
    risk: '',
    effort: '',
  } as WorkItem;
}

/**
 * Replace the remote ref tip with an ORPHAN commit carrying ONLY a delta
 * JSONL (no full snapshot in history) — simulates an unrepairable chain.
 */
function publishOrphanDelta(s: Setup, items: WorkItem[]): void {
  const dataPath = path.join(s.local, '.worklog', 'worklog-data.jsonl');
  fs.mkdirSync(path.dirname(dataPath), { recursive: true });
  exportToJsonl(items, [], dataPath, [], [], 'delta');
  const originalBranch = git(s.local, 'rev-parse', '--abbrev-ref', 'HEAD');
  git(s.local, 'checkout', '-q', '--orphan', 'worklog-fallback-data');
  git(s.local, 'add', '-f', '.worklog/worklog-data.jsonl');
  git(s.local, 'commit', '-q', '-m', 'orphan delta');
  git(s.local, 'push', '-f', '-q', 'origin', 'HEAD:refs/worklog/data');
  git(s.local, 'checkout', '-q', originalBranch);
  git(s.local, 'branch', '-D', '-q', 'worklog-fallback-data');
}

/** Fetch the remote data ref and report kind + payload lines. */
function remoteTip(local: string): { kind: string | undefined; lines: string[] } {
  git(local, 'fetch', '-q', 'origin', '+refs/worklog/data:refs/worklog/remotes/origin/worklog/data');
  const content = git(local, 'show', 'refs/worklog/remotes/origin/worklog/data:.worklog/worklog-data.jsonl');
  const lines = content.trim().split('\n');
  let kind: string | undefined;
  let payload = lines;
  try {
    const first = JSON.parse(lines[0]);
    if (first && first.__worklog_sync__) {
      kind = first.__worklog_sync__.kind;
      payload = lines.slice(1);
    }
  } catch {
    /* headerless legacy file */
  }
  return { kind, lines: payload };
}

/** Local DB contents via `wl list --json`. */
function listItems(local: string): Array<{ id: string; title: string }> {
  const res = runCli(local, '--json', 'list', '--status', 'open');
  expect(res.status, res.stderr).toBe(0);
  const parsed = JSON.parse(res.stdout);
  return parsed.workItems ?? parsed;
}

describe('delta sync full-snapshot fallback (real git)', () => {
  let s: Setup;

  beforeEach(() => {
    s = setupProject();
  });

  afterEach(() => {
    fs.rmSync(s.root, { recursive: true, force: true });
  });

  it('AC1/AC2/AC5: a fresh clone with no local base replays full+delta history and re-anchors with a full push', async () => {
    // Client A builds a chain: full (3 items), then delta (1 new item).
    const alpha = createItem(s.local, 'Alpha');
    const beta = createItem(s.local, 'Beta');
    const gamma = createItem(s.local, 'Gamma');
    const firstSync = runCli(s.local, '--json', 'sync');
    expect(firstSync.status, firstSync.stderr).toBe(0);
    expect(remoteTip(s.local).kind).toBe('full');

    const fourth = createItem(s.local, 'Fourth');
    const secondSync = runCli(s.local, '--json', 'sync');
    expect(secondSync.status, secondSync.stderr).toBe(0);
    expect(remoteTip(s.local).kind).toBe('delta');

    // History now holds: full commit + delta commit.
    git(s.local, 'fetch', '-q', 'origin', '+refs/worklog/data:refs/worklog/remotes/origin/worklog/data');
    const historyCount = git(s.local, 'rev-list', '--count', 'refs/worklog/remotes/origin/worklog/data');
    expect(Number(historyCount)).toBeGreaterThanOrEqual(2);

    // Client B: a fresh clone with an EMPTY local store. Pulling the delta
    // tip alone would yield only 1 record; the fallback must replay history.
    const clone = makeFreshClone(s, 'clone-b');
    const thirdSync = runCli(clone, '--json', 'sync');
    expect(thirdSync.status, thirdSync.stderr).toBe(0);

    const items = listItems(clone);
    const ids = items.map(i => i.id);
    // AC5 — reconstructed store has the base records AND the delta change.
    expect(ids).toContain(alpha);
    expect(ids).toContain(beta);
    expect(ids).toContain(gamma);
    expect(ids).toContain(fourth);
    expect(new Set(ids).size).toBe(ids.length);
    // AC2 — no baseline → the clone's own push was a FULL snapshot,
    // re-anchoring the remote for future readers.
    expect(remoteTip(clone).kind).toBe('full');
  }, 120000);

  it('AC5: an unrepairable chain (delta-only history) fails closed — no merge, no push, no data loss', async () => {
    const ts = new Date(Date.now() + 10 * 1000).toISOString();
    publishOrphanDelta(s, [makeItemRecord('DFT-9000', 'Lone Delta', ts)]);
    expect(remoteTip(s.local).kind).toBe('delta');

    // Fresh clone with empty local store: replay finds no full snapshot →
    // must fail closed with an explicit error, leaving BOTH sides untouched.
    const clone = makeFreshClone(s, 'clone-broken');
    git(clone, 'fetch', '-q', 'origin', '+refs/worklog/data:refs/worklog/remotes/origin/worklog/data');
    const remoteBefore = git(clone, 'rev-parse', 'refs/worklog/remotes/origin/worklog/data');

    const res = runCli(clone, '--json', 'sync');
    expect(res.status, res.stdout).not.toBe(0);
    expect(res.stdout).toContain('Unrepairable remote delta chain');

    // AC5 — nothing merged, nothing pushed, local store stays empty.
    const items = listItems(clone);
    expect(items).toHaveLength(0);

    git(clone, 'fetch', '-q', 'origin', '+refs/worklog/data:refs/worklog/remotes/origin/worklog/data');
    const remoteAfter = git(clone, 'rev-parse', 'refs/worklog/remotes/origin/worklog/data');
    expect(remoteAfter).toBe(remoteBefore);
  }, 120000);

  it('AC1: a delta tip with an existing local base keeps the normal (child-5) delta pull — no fallback', async () => {
    // Client A: full then delta.
    const alpha = createItem(s.local, 'Alpha');
    const beta = createItem(s.local, 'Beta');
    expect(runCli(s.local, '--json', 'sync').status).toBe(0);
    const newId = createItem(s.local, 'Only Delta');
    expect(runCli(s.local, '--json', 'sync').status).toBe(0);
    expect(remoteTip(s.local).kind).toBe('delta');

    // SAME local store (has records) pulls the delta — must NOT trigger the
    // fallback; existing by-ID delta merge (child 5) applies.
    const pullSync = runCli(s.local, '--json', 'sync');
    expect(pullSync.status, pullSync.stderr).toBe(0);

    const ids = listItems(s.local).map(i => i.id);
    expect(ids).toContain(alpha);
    expect(ids).toContain(beta);
    expect(ids).toContain(newId);
    expect(new Set(ids).size).toBe(ids.length);
  }, 120000);
});