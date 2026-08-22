/**
 * E2E tests for the delta (incremental) sync PUSH path (WL-0MT2KY0RQ008F50Q,
 * parent WL-0MSAKUBKW006FN8Q §5.1–§5.4).
 *
 * Uses REAL git + a real bare remote (mock-bin stripped from PATH) against
 * the compiled CLI (dist/cli.js), mirroring tests/cli/sync-concurrent.test.ts
 * and tests/cli/doctor-foreign-items-push.test.ts.
 *
 * AC1 — the first sync (no baseline) publishes a FULL snapshot; after a
 *       baseline exists, subsequent syncs publish DELTA increments.
 * AC2 — the delta JSONL written/pushed carries the sync header with
 *       `{"__worklog_sync__":{"version":1,"kind":"delta"}}`.
 * AC3 — the remote ref tip after a delta push contains ONLY the changed
 *       records (not the full store).
 * AC4 — push payload is proportional to the changed records (delta file is
 *       smaller than the full file when only one item changed).
 * AC5 — watermarks are advanced only after a successful push: a delta push
 *       makes the NEXT sync see zero dirty records and skip export+push
 *       (§5.4 zero-change fast path).
 * AC6/AC7 — full sync flow and concurrency protections are preserved (the
 *       first sync still pushes a full snapshot; --if-idle lock behavior is
 *       untouched — exercised implicitly via withFileLock at the caller).
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-delta-push-'));
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');
  git(root, 'init', '--bare', '-q', remote);
  git(root, 'init', '-q', local);
  git(local, 'config', 'user.email', 'test@example.com');
  git(local, 'config', 'user.name', 'Test User');
  git(local, 'remote', 'add', 'origin', remote);
  writeConfig(local, 'Delta Push Test', 'DPT');
  writeInitSemaphore(local);
  // Seed a commit so the local repo has a non-empty main branch (sync pushes
  // onto a dedicated refs/worklog/data branch, independent of main).
  fs.writeFileSync(path.join(local, 'README.md'), '# delta push\n', 'utf8');
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

/** Fetch the remote data ref and return `{ content, kind }` parsing the header. */
function remoteTip(local: string): { content: string; kind: string | undefined; lines: string[] } {
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
  return { content, kind, lines: payload };
}

describe('delta sync push path (real git)', () => {
  let s: Setup;

  beforeEach(() => {
    s = setupProject();
  });

  afterEach(() => {
    fs.rmSync(s.root, { recursive: true, force: true });
  });

  it('AC1/AC2/AC3/AC4: first sync is full; second sync is a delta containing only the new item', async () => {
    // Seed three items BEFORE the first sync so the full snapshot is clearly
    // larger than the subsequent single-item delta (AC4 payload proportionality).
    const a = createItem(s.local, 'Alpha');
    const b = createItem(s.local, 'Beta');
    const c = createItem(s.local, 'Gamma');

    // ── First sync: no baseline → FULL snapshot ──
    const firstSync = runCli(s.local, '--json', 'sync');
    expect(firstSync.status, firstSync.stderr).toBe(0);
    const firstOut = JSON.parse(firstSync.stdout);
    expect(firstOut.success).toBe(true);

    const firstRemote = remoteTip(s.local);
    expect(firstRemote.kind).toBe('full');
    const firstPayload = firstRemote.lines.join('\n');
    expect(firstPayload).toContain(a);
    expect(firstPayload).toContain(b);
    expect(firstPayload).toContain(c);

    // ── Second sync: baseline exists → DELTA ──
    const secondId = createItem(s.local, 'Delta Only');
    const secondSync = runCli(s.local, '--json', 'sync');
    expect(secondSync.status, secondSync.stderr).toBe(0);
    const secondOut = JSON.parse(secondSync.stdout);
    expect(secondOut.success).toBe(true);

    const secondRemote = remoteTip(s.local);
    // Delta header on the pushed file (AC2).
    expect(secondRemote.kind).toBe('delta');
    // Only the changed item is in the delta payload (AC3).
    const secondPayload = secondRemote.lines.join('\n');
    expect(secondPayload).toContain(secondId);
    expect(secondPayload).not.toContain(a);
    expect(secondPayload).not.toContain(b);
    expect(secondPayload).not.toContain(c);
    // Payload proportional to changes: 1-item delta < 3-item full (AC4).
    expect(secondRemote.lines.length).toBe(1);
    expect(secondRemote.content.length).toBeLessThan(firstRemote.content.length);
  }, 120000);

  it('AC5: after a delta push, a no-change sync skips export+push (zero-change fast path)', async () => {
    createItem(s.local, 'Only item');
    const firstSync = runCli(s.local, '--json', 'sync');
    expect(firstSync.status, firstSync.stderr).toBe(0);
    // Bring the local tracking ref up to date so rev-parse is meaningful.
    git(s.local, 'fetch', '-q', 'origin', '+refs/worklog/data:refs/worklog/remotes/origin/worklog/data');
    const remoteBefore = git(s.local, 'rev-parse', 'refs/worklog/remotes/origin/worklog/data');

    // No local changes → delta mode sees zero dirty records → skip export+push.
    const secondSync = runCli(s.local, '--json', 'sync');
    expect(secondSync.status, secondSync.stderr).toBe(0);
    const stdout = secondSync.stdout;
    expect(stdout).toContain('"success": true');

    // No push happened: remote tip ref unchanged AND no local JSONL file
    // (ephemeral pattern — file deleted after the first sync's push).
    const dataFile = path.join(s.local, '.worklog', 'worklog-data.jsonl');
    expect(fs.existsSync(dataFile)).toBe(false);
    git(s.local, 'fetch', '-q', 'origin', '+refs/worklog/data:refs/worklog/remotes/origin/worklog/data');
    const remoteAfter = git(s.local, 'rev-parse', 'refs/worklog/remotes/origin/worklog/data');
    expect(remoteAfter).toBe(remoteBefore);
  }, 120000);

  it('cadence forcing (§5.3): a delta-push counter reaching syncFullSnapshotEveryN forces a full snapshot', async () => {
    // Configure a strict cadence: 1 delta, then force full. (writeConfig
    // emits config.yaml without a trailing newline — prepend one so the key
    // lands on its own line and stays valid YAML.)
    const configPath = path.join(s.local, '.worklog', 'config.yaml');
    fs.writeFileSync(
      configPath,
      fs.readFileSync(configPath, 'utf-8') + '\nsyncFullSnapshotEveryN: 1\n',
      'utf-8'
    );

    createItem(s.local, 'One');
    const firstSync = runCli(s.local, '--json', 'sync');
    expect(firstSync.status, firstSync.stderr).toBe(0);
    expect(remoteTip(s.local).kind).toBe('full');

    // Delta push increments the counter to 1.
    createItem(s.local, 'Two');
    const secondSync = runCli(s.local, '--json', 'sync');
    expect(secondSync.status, secondSync.stderr).toBe(0);
    expect(remoteTip(s.local).kind).toBe('delta');

    // Counter (1) >= everyN (1) → next sync must be a FULL snapshot again.
    createItem(s.local, 'Three');
    const thirdSync = runCli(s.local, '--json', 'sync');
    expect(thirdSync.status, thirdSync.stderr).toBe(0);
    const thirdRemote = remoteTip(s.local);
    expect(thirdRemote.kind).toBe('full');
    // The full snapshot contains everything (all three items).
    expect(thirdRemote.lines.join('\n')).toContain('"One"');
    expect(thirdRemote.lines.join('\n')).toContain('"Three"');
  }, 120000);
});