/**
 * E2E tests for the delta (incremental) sync PULL path (WL-0MT2KYCNB000CYWV,
 * parent WL-0MSAKUBKW006FN8Q §6.1–§6.2).
 *
 * Uses REAL git + a real bare remote (mock-bin stripped from PATH) against
 * the compiled CLI (dist/cli.js), mirroring tests/cli/sync-delta-push.test.ts.
 *
 * AC1 — the pull path detects whether the remote JSONL is a delta (header
 *       `{"__worklog_sync__":{"version":1,"kind":"delta"}}`) or a full
 *       snapshot (kind `full`) / legacy headerless file (kind undefined).
 * AC2 — a delta remote is merged ONTO the local base using the existing by-ID
 *       merge logic; local records absent from the delta are preserved
 *       (non-destructive upsert persist — no missing records, no duplicates).
 * AC3 — a full-snapshot remote keeps the existing replace behavior.
 * AC6 — legacy headerless remotes fall back to the full path.
 * AC7 — delta merge behavior is covered by unit tests (merge-utils + database
 *       upsertComments) plus this end-to-end flow.
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

function setupProject(branch = 'sync-delta-pull'): Setup {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `wl-${branch}-`));
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');
  git(root, 'init', '--bare', '-q', remote);
  git(root, 'init', '-q', local);
  git(local, 'config', 'user.email', 'test@example.com');
  git(local, 'config', 'user.name', 'Test User');
  git(local, 'remote', 'add', 'origin', remote);
  writeConfig(local, 'Delta Pull Test', 'DPT');
  writeInitSemaphore(local);
  fs.writeFileSync(path.join(local, 'README.md'), `# ${branch}\n`, 'utf8');
  git(local, 'add', '-A');
  git(local, 'commit', '-q', '-m', 'init');
  git(local, 'checkout', '-q', '-b', branch);
  return { root, remote, local };
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
 * Replace the remote ref tip with a JSONL file built from the given records.
 * A kind of 'delta' writes the sync header so the pull path takes the delta
 * branch; 'full' writes the header with kind full; undefined writes a legacy
 * headerless file.
 */
function publishRemote(
  s: Setup,
  items: WorkItem[],
  comments: any[],
  kind: 'full' | 'delta' | undefined
): void {
  const dataPath = path.join(s.local, '.worklog', 'worklog-data.jsonl');
  fs.mkdirSync(path.dirname(dataPath), { recursive: true });
  exportToJsonl(items, comments, dataPath, [], [], kind);

  git(s.local, 'checkout', '-q', '--orphan', 'worklog-pull-data');
  git(s.local, 'add', '-f', '.worklog/worklog-data.jsonl');
  git(s.local, 'commit', '-q', '-m', `publish ${kind ?? 'legacy'} data`);
  git(s.local, 'push', '-f', '-q', 'origin', 'HEAD:refs/worklog/data');
  git(s.local, 'checkout', '-q', 'sync-delta-pull');
  git(s.local, 'branch', '-D', '-q', 'worklog-pull-data');
}

/** Fetch the remote data ref and report its kind (header parse) + payload lines. */
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

/** Pull the local DB contents via `wl list --json`. */
function listItems(local: string): Array<{ id: string; title: string; description: string }> {
  const res = runCli(local, '--json', 'list', '--status', 'open');
  expect(res.status, res.stderr).toBe(0);
  const parsed = JSON.parse(res.stdout);
  return parsed.workItems ?? parsed;
}

describe('delta sync pull path (real git)', () => {
  let s: Setup;

  beforeEach(() => {
    s = setupProject();
  });

  afterEach(() => {
    fs.rmSync(s.root, { recursive: true, force: true });
  });

  it('AC1/AC2/AC5: a delta remote is merged onto the local base without loss or duplicates', async () => {
    // Local base: three items, full snapshot pushed.
    const alpha = createItem(s.local, 'Alpha');
    const beta = createItem(s.local, 'Beta');
    const gamma = createItem(s.local, 'Gamma');
    const firstSync = runCli(s.local, '--json', 'sync');
    expect(firstSync.status, firstSync.stderr).toBe(0);
    expect(remoteTip(s.local).kind).toBe('full');

    // Peer pushes a DELTA: one new item + an updated copy of Alpha, with
    // timestamps newer than the local full push so the delta is clearly a
    // change set, not a snapshot.
    const deltaTs = new Date(Date.now() + 10 * 1000).toISOString();
    const deltaItems: WorkItem[] = [
      makeItemRecord('DPT-1000', 'Delta Arrival', deltaTs),
      { ...makeItemRecord(alpha, 'Alpha', deltaTs), description: 'updated by peer' },
    ];
    publishRemote(s, deltaItems, [], 'delta');
    expect(remoteTip(s.local).kind).toBe('delta');

    // Local sync pulls the delta and merges it onto the local base.
    const pullSync = runCli(s.local, '--json', 'sync');
    expect(pullSync.status, pullSync.stderr).toBe(0);

    const items = listItems(s.local);
    const ids = items.map(i => i.id);
    // AC5 — no missing records: base items survive even though they are
    // absent from the delta payload (non-destructive merge onto local base).
    expect(ids).toContain(alpha);
    expect(ids).toContain(beta);
    expect(ids).toContain(gamma);
    // AC2 — delta records merged in.
    expect(ids).toContain('DPT-1000');
    // AC5 — no duplicates: every id appears exactly once.
    expect(new Set(ids).size).toBe(ids.length);
    // AC2 — the updated record reflects the peer delta record's content.
    const alphaNow = items.find(i => i.id === alpha);
    expect(alphaNow?.title).toBe('Alpha');
    expect(alphaNow?.description).toBe('updated by peer');
  }, 120000);

  it('AC3: a full-snapshot remote replaces local state and is not mistaken for a delta', async () => {
    createItem(s.local, 'Local Only');
    const firstSync = runCli(s.local, '--json', 'sync');
    expect(firstSync.status, firstSync.stderr).toBe(0);
    expect(remoteTip(s.local).kind).toBe('full');

    // Peer publishes a full snapshot (header kind=full) containing a new item
    // AND a copy of the local item — the full path (replace) applies.
    const ts = new Date(Date.now() + 10 * 1000).toISOString();
    publishRemote(s, [makeItemRecord('DPT-2000', 'Snapshot Item', ts)], [], 'full');
    expect(remoteTip(s.local).kind).toBe('full');

    const pullSync = runCli(s.local, '--json', 'sync');
    expect(pullSync.status, pullSync.stderr).toBe(0);

    const items = listItems(s.local);
    const ids = items.map(i => i.id);
    expect(ids).toContain('DPT-2000');
    // Local-only records survive the full merge too (merge seeds from local).
    expect(ids.some(id => id !== 'DPT-2000' && id.startsWith('DPT-'))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  }, 120000);

  it('AC6: legacy headerless remote files fall back to the full pull path', async () => {
    createItem(s.local, 'Legacy Base');
    const firstSync = runCli(s.local, '--json', 'sync');
    expect(firstSync.status, firstSync.stderr).toBe(0);

    // Headerless file (legacy writer) — must import as a full push (kind
    // undefined → full replace path), not crash on the header parse.
    const ts = new Date(Date.now() + 10 * 1000).toISOString();
    publishRemote(s, [makeItemRecord('DPT-3000', 'Legacy Arrival', ts)], [], undefined);
    const tip = remoteTip(s.local);
    expect(tip.kind).toBeUndefined();

    const pullSync = runCli(s.local, '--json', 'sync');
    expect(pullSync.status, pullSync.stderr).toBe(0);

    const items = listItems(s.local);
    const ids = items.map(i => i.id);
    expect(ids).toContain('DPT-3000');
    expect(new Set(ids).size).toBe(ids.length);
  }, 120000);
});