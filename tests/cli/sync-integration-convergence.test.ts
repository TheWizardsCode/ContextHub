/**
 * Integration tests for delta sync convergence (WL-0MT2KZVXX0025BFH, parent
 * WL-0MSAKUBKW006FN8Q §8 / AC3).
 *
 * Two clients (A, B) share one bare remote and interleave FULL and DELTA
 * pushes over multiple rounds — each client edits its own records, syncs,
 * pulls the other's increment, and eventually both local SQLite stores must
 * converge to identical state (design's "convergence (interleaved full+delta)"
 * test matrix, AC-parent correctness/convergence).
 *
 * AC7 — interleaved incremental and full syncs: local and remote converge.
 * AC8 — backward compatibility: a LEGACY headerless (old-format) remote ref
 *       is pulled and merged like a full snapshot by the current wl.
 * AC9 — exercised by the canonical suite run (tests/cli + tests/unit) via
 *       the test-skill runner.
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

function setupProject(): Setup {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-integration-'));
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');
  git(root, 'init', '--bare', '-q', remote);
  git(root, 'init', '-q', local);
  git(local, 'config', 'user.email', 'test@example.com');
  git(local, 'config', 'user.name', 'Test User');
  git(local, 'remote', 'add', 'origin', remote);
  writeConfig(local, 'Integration Test', 'INT');
  writeInitSemaphore(local);
  fs.writeFileSync(path.join(local, 'README.md'), '# integration\n', 'utf8');
  git(local, 'add', '-A');
  git(local, 'commit', '-q', '-m', 'init');
  return { root, remote, local };
}

/** Second client: a fresh clone of the same project, empty local store. */
function addClient(s: Setup, name: string, prefix: string): string {
  const dir = path.join(s.root, name);
  git(s.root, 'clone', '-q', s.remote, dir);
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test User');
  writeConfig(dir, 'Integration Test', prefix);
  writeInitSemaphore(dir);
  return dir;
}

function createItem(local: string, title: string): string {
  const res = runCli(local, '--json', 'create', '-t', title);
  if (res.status !== 0) throw new Error(`wl create failed: ${res.stderr}\n${res.stdout}`);
  const parsed = JSON.parse(res.stdout);
  const id: string = parsed.workItem?.id ?? parsed.id;
  expect(id).toBeTruthy();
  return id;
}

/** Update a work item's description via the CLI. */
function updateItem(local: string, id: string, description: string) {
  const res = runCli(local, '--json', 'update', id, '-d', description);
  expect(res.status, res.stderr).toBe(0);
}

function sync(local: string) {
  const res = runCli(local, '--json', 'sync');
  expect(res.status, res.stderr).toBe(0);
}

/** Remote tip kind with the sync header parsed. */
function remoteKind(local: string): string | undefined {
  git(local, 'fetch', '-q', 'origin', '+refs/worklog/data:refs/worklog/remotes/origin/worklog/data');
  const content = git(local, 'show', 'refs/worklog/remotes/origin/worklog/data:.worklog/worklog-data.jsonl');
  try {
    const first = JSON.parse(content.trim().split('\n')[0]);
    if (first && first.__worklog_sync__) return first.__worklog_sync__.kind;
  } catch {
    /* headerless */
  }
  return undefined;
}

/** All local records keyed by id (title + status + description). */
function localState(local: string): Map<string, { title: string; status: string; description: string }> {
  const res = runCli(local, '--json', 'list', '--deleted');
  expect(res.status, res.stderr).toBe(0);
  const parsed = JSON.parse(res.stdout);
  const items: Array<{ id: string; title: string; status: string; description: string }> =
    parsed.workItems ?? parsed;
  return new Map(items.map(i => [i.id, { title: i.title, status: i.status, description: i.description }]));
}

function makeItemRecord(id: string, title: string, updatedAt: string, description = ''): WorkItem {
  return {
    id, title, description, status: 'open', priority: 'medium', sortIndex: 0, parentId: null,
    createdAt: updatedAt, updatedAt, tags: [], assignee: '', stage: 'idea', issueType: '',
    createdBy: '', deletedBy: '', deleteReason: '', risk: '', effort: '',
  } as WorkItem;
}

/** Publish a legacy (headerless) full snapshot to the remote ref — old-format writer. */
function publishLegacyFull(s: Setup, items: WorkItem[]): void {
  const dataPath = path.join(s.local, '.worklog', 'worklog-data.jsonl');
  fs.mkdirSync(path.dirname(dataPath), { recursive: true });
  exportToJsonl(items, [], dataPath, [], [], undefined);
  const originalBranch = git(s.local, 'rev-parse', '--abbrev-ref', 'HEAD');
  git(s.local, 'checkout', '-q', '--orphan', 'worklog-legacy-data');
  git(s.local, 'add', '-f', '.worklog/worklog-data.jsonl');
  git(s.local, 'commit', '-q', '-m', 'legacy full');
  git(s.local, 'push', '-f', '-q', 'origin', 'HEAD:refs/worklog/data');
  git(s.local, 'checkout', '-q', originalBranch);
  git(s.local, 'branch', '-D', '-q', 'worklog-legacy-data');
}

describe('delta sync integration: interleaved convergence (real git)', () => {
  let s: Setup;

  beforeEach(() => {
    s = setupProject();
  });

  afterEach(() => {
    fs.rmSync(s.root, { recursive: true, force: true });
  });

  it('AC7: A and B interleave full+delta syncs over 4 rounds and converge', async () => {
    const b = addClient(s, 'client-b', 'INT');

    // Round 1: A seeds 3 items and pushes a FULL snapshot; B pulls it.
    const a1 = createItem(s.local, 'A one');
    const a2 = createItem(s.local, 'A two');
    const a3 = createItem(s.local, 'A three');
    sync(s.local);
    expect(remoteKind(s.local)).toBe('full');
    sync(b); // B pulls A's full

    // Round 2: B adds its own item (delta push), A pulls it.
    const b1 = createItem(b, 'B one');
    sync(b); // B: no baseline? B pulled A's full → watermarks? B never pushed…
    // B has not pushed yet in round 2 — its own push must be a full or delta
    // depending on baseline; either way remote must keep growing.
    const kindAfterB = remoteKind(b);
    expect(['full', 'delta']).toContain(kindAfterB);
    sync(s.local); // A pulls B's increment

    // Round 3: A edits A one (delta), B edits B one (delta), then both pull.
    updateItem(s.local, a1, 'A one edited');
    updateItem(b, b1, 'B one edited');
    sync(s.local);
    expect(remoteKind(s.local)).toBe('delta');
    sync(b); // B pulls A's delta
    // B pushes its own edit on top (could be full/delta — converged anyway).
    sync(b);
    sync(s.local); // A pulls B's delta

    // Round 4: A creates item 4 and B creates item 5; final converge pass.
    const a4 = createItem(s.local, 'A four');
    const b2 = createItem(b, 'B two');
    sync(s.local);
    expect(remoteKind(s.local)).toBe('delta');
    sync(b); // B pulls A's delta and has B's own dirty records → pushes
    sync(b);
    sync(s.local); // final pull

    // Both clients must see identical state for all shared records.
    const stateA = localState(s.local);
    const stateB = localState(b);
    expect(stateB.size).toBeGreaterThanOrEqual(5);
    for (const [id, recA] of stateA) {
      const recB = stateB.get(id);
      expect(recB, `record ${id} missing on B`).toBeDefined();
      expect(recB?.description, `description drift on ${id}`).toBe(recA.description);
      expect(recB?.status, `status drift on ${id}`).toBe(recA.status);
    }
    // Everything B knows that A knows too.
    for (const id of stateB.keys()) {
      expect(stateA.has(id), `record ${id} missing on A`).toBe(true);
    }
  }, 180000);

  it('AC8: a legacy headerless remote ref is pulled and merged like a full snapshot', async () => {
    const ts = new Date(Date.now() + 10 * 1000).toISOString();
    publishLegacyFull(s, [
      makeItemRecord('INT-8001', 'Legacy Alpha', ts),
      makeItemRecord('INT-8002', 'Legacy Beta', ts),
    ]);
    expect(remoteKind(s.local)).toBeUndefined(); // headerless → legacy full

    const fresh = addClient(s, 'legacy-reader', 'INT');
    sync(fresh);

    const items = localState(fresh);
    expect(items.get('INT-8001')?.title).toBe('Legacy Alpha');
    expect(items.get('INT-8002')?.title).toBe('Legacy Beta');
  }, 120000);
});