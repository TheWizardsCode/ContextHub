/**
 * E2E tests for deletion propagation through delta sync (WL-0MT2KZH0I005XUWE,
 * parent WL-0MSAKUBKW006FN8Q §4.3).
 *
 * Uses REAL git + a real bare remote (mock-bin stripped from PATH) against
 * the compiled CLI (dist/cli.js).
 *
 * AC1 — a soft-deleted record (status 'deleted', updatedAt = deletion time) is
 *       included in the delta export and pushed.
 * AC2 — the pull side merges the delta: the deleted record converges into the
 *       remote SQLite even when the local copy was completed/in_review
 *       (the close-preservation gap fixed in the status merge).
 * AC3 — after syncs, local and remote SQLite match for deleted items.
 * AC5 — no regression for full syncs: a full snapshot also carries deleted
 *       records and converges (legacy behavior preserved).
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-delta-delete-'));
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');
  git(root, 'init', '--bare', '-q', remote);
  git(root, 'init', '-q', local);
  git(local, 'config', 'user.email', 'test@example.com');
  git(local, 'config', 'user.name', 'Test User');
  git(local, 'remote', 'add', 'origin', remote);
  writeConfig(local, 'Delta Delete Test', 'DDT');
  writeInitSemaphore(local);
  fs.writeFileSync(path.join(local, 'README.md'), '# delta delete\n', 'utf8');
  git(local, 'add', '-A');
  git(local, 'commit', '-q', '-m', 'init');
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

/** Delete a work item via the CLI (auto-sync on) and return the raw JSON. */
function deleteItem(local: string, id: string) {
  const res = runCli(local, '--json', 'delete', id);
  if (res.status !== 0) {
    throw new Error(`wl delete failed: ${res.stderr}\n${res.stdout}`);
  }
  return JSON.parse(res.stdout);
}

/** Set an item to completed/in_review via the CLI so the close-preservation path is exercised. */
function completeItem(local: string, id: string) {
  const res = runCli(local, '--json', 'update', id, '-s', 'completed', '--stage', 'in_review');
  expect(res.status, res.stderr).toBe(0);
}

/** Fetch the remote data ref and report kind + payload. */
function remoteTip(local: string): { kind: string | undefined; payload: string } {
  git(local, 'fetch', '-q', 'origin', '+refs/worklog/data:refs/worklog/remotes/origin/worklog/data');
  const content = git(local, 'show', 'refs/worklog/remotes/origin/worklog/data:.worklog/worklog-data.jsonl');
  let kind: string | undefined;
  let payload = content;
  try {
    const first = JSON.parse(content.trim().split('\n')[0]);
    if (first && first.__worklog_sync__) {
      kind = first.__worklog_sync__.kind;
      payload = content.trim().split('\n').slice(1).join('\n');
    }
  } catch {
    /* headerless legacy */
  }
  return { kind, payload };
}

/** List items INCLUDING deleted ones via `wl list --deleted` JSON. */
function listAll(local: string): Array<{ id: string; title: string; status: string }> {
  const res = runCli(local, '--json', 'list', '--deleted');
  expect(res.status, res.stderr).toBe(0);
  const parsed = JSON.parse(res.stdout);
  return parsed.workItems ?? parsed;
}

describe('deletion propagation via delta sync (real git)', () => {
  let s: Setup;

  beforeEach(() => {
    s = setupProject();
  });

  afterEach(() => {
    fs.rmSync(s.root, { recursive: true, force: true });
  });

  it('AC1: deleting an item pushes a delta containing the deleted record', async () => {
    const a = createItem(s.local, 'Keep me');
    const victim = createItem(s.local, 'Delete me');
    expect(a).toBeTruthy();
    const sync1 = runCli(s.local, '--json', 'sync');
    expect(sync1.status, sync1.stderr).toBe(0);
    expect(remoteTip(s.local).kind).toBe('full');
    // Manually delete (auto-sync happens inside `wl delete`).
    const delRes = deleteItem(s.local, victim);
    expect(delRes.success).toBe(true);

    // Fetch the remote: the delete auto-synced and the tip must be a delta
    // carrying the deleted record.
    const tip = remoteTip(s.local);
    expect(tip.kind).toBe('delta');
    expect(tip.payload).toContain('"deleted"');
    expect(tip.payload).toContain(victim);
  }, 120000);

  it('AC2/AC3: a completed item deleted on one side converges to deleted on the pull side', async () => {
    // Client A: create, complete (close-preservation path), first full sync.
    const victim = createItem(s.local, 'Victim');
    createItem(s.local, 'Survivor');
    completeItem(s.local, victim);
    const sync1 = runCli(s.local, '--json', 'sync');
    expect(sync1.status, sync1.stderr).toBe(0);
    // Sanity: baseline remote is a full snapshot.
    expect(remoteTip(s.local).kind).toBe('full');

    // Client A deletes the completed victim (auto-sync → delta push).
    const delRes = deleteItem(s.local, victim);
    expect(delRes.success).toBe(true);
    expect(remoteTip(s.local).kind).toBe('delta');

    // Client B: second clone of the same project pulls the delta.
    const clone = path.join(s.root, 'clone-b');
    git(s.root, 'clone', '-q', s.remote, clone);
    git(clone, 'config', 'user.email', 'test@example.com');
    git(clone, 'config', 'user.name', 'Test User');
    writeConfig(clone, 'Delta Delete Test', 'DDT');
    writeInitSemaphore(clone);
    const syncB = runCli(clone, '--json', 'sync');
    expect(syncB.status, syncB.stderr).toBe(0);

    // AC2/AC3: B's local SQLite has the victim as deleted (converged), not
    // resurrected to completed by the close-preservation path.
    const items = listAll(clone);
    const victimB = items.find(i => i.id === victim);
    expect(victimB).toBeDefined();
    expect(victimB?.status).toBe('deleted');
    // Survivor untouched.
    expect(items.find(i => i.title === 'Survivor')?.status).toBe('open');
  }, 120000);

  it('AC5 (no regression): a full snapshot still carries and converges deleted records', async () => {
    const a = createItem(s.local, 'Keep full');
    const victim = createItem(s.local, 'Delete full');
    runCli(s.local, '--json', 'sync');
    deleteItem(s.local, victim);

    // Force a full snapshot: wipe delta metadata so the next push is full.
    // Simplest deterministic route: syncFullSnapshotEveryN: 1 → first delta
    // after the delete triggers a full on the NEXT sync (cadence). Instead,
    // we assert the full-snapshot path directly: run push with
    // WL_DELTA_EXPORT_DISABLED=1 → exportForSync falls back to full.
    const res = spawnSync('node', [cliPath, '--json', 'sync'], {
      cwd: s.local, encoding: 'utf-8',
      env: { ...realGitEnv(), WL_DELTA_EXPORT_DISABLED: '1' },
    });
    expect(res.status).toBe(0);

    const tip = remoteTip(s.local);
    expect(tip.kind).toBe('full');
    expect(tip.payload).toContain(victim);
    expect(tip.payload).toContain('"deleted"');
    expect(tip.payload).toContain(a);
  }, 120000);
});