/**
 * E2E regression tests: `wl sync` must never downgrade a newer audit result
 * to an older one (SA-0MUJNFF3K009BF03).
 *
 * Incident: a background `wl sync` replaced a just-persisted audit with an
 * older copy of the same item's audit. The item's status/stage/comments were
 * preserved, leaving the lifecycle reflecting the new verdict while the stored
 * audit showed a stale one. Re-persisting did not help while syncs kept
 * running.
 *
 * The sync merge is therefore last-write-wins by `auditedAt` (newest audit
 * wins, local wins ties), and the bulk audit persist used by the sync import
 * paths is monotonic — it never overwrites a newer stored audit with an older
 * incoming one.
 *
 * These tests use REAL git + a real bare remote (mock-bin stripped from PATH)
 * against the CLI bundle, so the real export → push → pull → merge → persist
 * path is exercised (AC4). The behaviour is observed only through the public
 * CLI (`wl audit-show` / `wl sync`), never by re-implementing sync logic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { writeConfig, writeInitSemaphore } from './cli-helpers.js';
import { cliInvocation } from './cli-bundle.js';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const projectRoot = path.resolve(__dirname, '..', '..');
const mockBinDir = path.join(projectRoot, 'tests', 'cli', 'mock-bin');

function cliSpawn(
  args: string[],
  options: Parameters<typeof spawnSync>[2],
) {
  const [command, entry] = cliInvocation();
  return spawnSync(command, [entry, ...args], options);
}

/** PATH without the test mock-bin so subprocesses run the real git binary. */
function realGitEnv(extra: Record<string, string> = {}): Record<string, string> {
  const pathVal = (process.env.PATH || '')
    .split(path.delimiter)
    .filter(p => path.resolve(p) !== path.resolve(mockBinDir))
    .join(path.delimiter);
  return { ...(process.env as Record<string, string>), PATH: pathVal, ...extra };
}

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync('git', args, { cwd, encoding: 'utf-8', env: realGitEnv() });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
  }
  return res.stdout.trim();
}

function runCli(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): { stdout: string; stderr: string; status: number } {
  const res = cliSpawn(args, { cwd, encoding: 'utf-8', env: realGitEnv(extraEnv) });
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status ?? -1 };
}

interface Setup {
  root: string;
  remote: string;
  local: string;
}

function initProject(dir: string, origin?: string): void {
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test User');
  if (origin) git(dir, 'remote', 'add', 'origin', origin);
  writeConfig(dir, 'Audit Newest Wins', 'AUD');
  writeInitSemaphore(dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# audit newest wins\n', 'utf8');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
}

function setupProject(): Setup {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-audit-newest-'));
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');
  git(root, 'init', '--bare', '-q', remote);
  fs.mkdirSync(local, { recursive: true });
  initProject(local, remote);
  return { root, remote, local };
}

/** Clone the remote into a second client (same store config as the original). */
function cloneProject(s: Setup, name: string): string {
  const clone = path.join(s.root, name);
  git(s.root, 'clone', '-q', s.remote, clone);
  git(clone, 'config', 'user.email', 'test@example.com');
  git(clone, 'config', 'user.name', 'Test User');
  writeConfig(clone, 'Audit Newest Wins', 'AUD');
  writeInitSemaphore(clone);
  return clone;
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

interface AuditView {
  readyToClose: boolean;
  auditedAt: string;
  summary: string | null;
  author: string | null;
}

/** Persist an audit via the canonical CLI write path; returns the stored record. */
function auditSet(
  local: string,
  id: string,
  readyToClose: boolean,
  summary: string,
): AuditView {
  const res = runCli(local, [
    '--json', 'audit-set', id,
    '--ready-to-close', readyToClose ? 'yes' : 'no',
    '--summary', summary,
    '--raw-output', `raw output for ${summary}`,
    '--author', 'audit-runner',
  ]);
  expect(res.status, res.stderr).toBe(0);
  const parsed = JSON.parse(res.stdout);
  expect(parsed.success).toBe(true);
  return parsed.audit as AuditView;
}

/** Read the stored audit via the public read path. */
function auditShow(local: string, id: string): AuditView | null {
  const res = runCli(local, ['--json', 'audit-show', id]);
  expect(res.status, res.stderr).toBe(0);
  const parsed = JSON.parse(res.stdout);
  return (parsed.audit as AuditView | null) ?? null;
}

function sync(local: string, extraEnv: Record<string, string> = {}) {
  const res = runCli(local, ['--json', 'sync'], extraEnv);
  expect(res.status, res.stderr).toBe(0);
  return JSON.parse(res.stdout);
}

/** Fetch the remote data ref and report its sync kind + payload (header stripped). */
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

/** Wait until the wall clock has clearly advanced past `after` (ISO, ms precision). */
async function waitPast(after: string): Promise<void> {
  const target = Date.parse(after) + 25;
  while (Date.now() < target) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe('wl sync never downgrades a newer audit (real git)', () => {
  let s: Setup;

  beforeEach(() => {
    s = setupProject();
  });

  afterEach(() => {
    if (s?.root) fs.rmSync(s.root, { recursive: true, force: true });
  });

  it('AC1/AC4: a newer local audit survives a sync that pulls an older remote snapshot', async () => {
    const id = createItem(s.local, 'Audited item');

    const older = auditSet(s.local, id, true, 'OLDER audit — ready to close');
    // First sync publishes the older audit in a full snapshot.
    sync(s.local);
    expect(remoteTip(s.local).kind).toBe('full');
    expect(remoteTip(s.local).payload).toContain(older.auditedAt);

    // A newer audit lands after the remote snapshot was taken.
    await waitPast(older.auditedAt);
    const newer = auditSet(s.local, id, false, 'NEWER audit — not ready to close');
    expect(Date.parse(newer.auditedAt)).toBeGreaterThan(Date.parse(older.auditedAt));

    // Syncing pulls the older remote audit into the merge, then persists.
    sync(s.local);

    const shown = auditShow(s.local, id);
    expect(shown).not.toBeNull();
    expect(shown!.summary).toBe('NEWER audit — not ready to close');
    expect(shown!.auditedAt).toBe(newer.auditedAt);
    expect(shown!.readyToClose).toBe(false);

    // The pushed export carries the newer audit too (AC2), so readers converge.
    const tip = remoteTip(s.local);
    expect(tip.kind).toBe('delta');
    expect(tip.payload).toContain(newer.auditedAt);
    expect(tip.payload).not.toContain(older.auditedAt);
  }, 120000);

  it('AC2: the newest audit wins even when it exists only on the remote (stale local audit)', async () => {
    const id = createItem(s.local, 'Converging item');
    const older = auditSet(s.local, id, true, 'OLDER audit on both sides');
    sync(s.local);

    // A second client adopts the older audit.
    const clone = cloneProject(s, 'clone-b');
    sync(clone);
    expect(auditShow(clone, id)!.auditedAt).toBe(older.auditedAt);

    // The first client records a newer verdict and publishes it.
    await waitPast(older.auditedAt);
    const newer = auditSet(s.local, id, false, 'NEWER audit on the remote');
    sync(s.local);

    // The second client still holds the older audit locally; syncing must
    // adopt the newer remote audit rather than keeping its stale local copy.
    sync(clone);

    const shown = auditShow(clone, id);
    expect(shown).not.toBeNull();
    expect(shown!.summary).toBe('NEWER audit on the remote');
    expect(shown!.auditedAt).toBe(newer.auditedAt);
    expect(shown!.readyToClose).toBe(false);
  }, 120000);

  it('AC3: a remote snapshot that cannot represent audits leaves the newer local audit unchanged', async () => {
    const id = createItem(s.local, 'Local-only audit item');
    const newer = auditSet(s.local, id, false, 'NEWER local audit');
    sync(s.local);
    expect(remoteTip(s.local).payload).toContain(newer.auditedAt);

    // Simulate a legacy/older exporter that carries work items only — the
    // shape observed in the incident (no audit_result records in the export).
    const scratch = cloneProject(s, 'legacy-exporter');
    const tip = remoteTip(s.local);
    const header = JSON.stringify({ __worklog_sync__: { kind: 'full', version: 1 } });
    const withoutAudits = tip.payload
      .split('\n')
      .filter(line => line.trim() && !line.includes('"type":"audit_result"'))
      .join('\n');
    fs.writeFileSync(
      path.join(scratch, '.worklog', 'worklog-data.jsonl'),
      `${header}\n${withoutAudits}\n`,
      'utf8',
    );
    git(scratch, 'add', '.worklog/worklog-data.jsonl');
    git(scratch, 'commit', '-q', '-m', 'legacy exporter snapshot without audits');
    // Force: the legacy snapshot is built from the current tip content, but
    // its commit history is unrelated to the sync tool's orphan ref history.
    git(scratch, 'push', '-q', '-f', 'origin', 'HEAD:refs/worklog/data');

    // Pulling that snapshot must not clear or downgrade the local audit.
    sync(s.local);

    const shown = auditShow(s.local, id);
    expect(shown).not.toBeNull();
    expect(shown!.summary).toBe('NEWER local audit');
    expect(shown!.auditedAt).toBe(newer.auditedAt);
  }, 120000);
});
