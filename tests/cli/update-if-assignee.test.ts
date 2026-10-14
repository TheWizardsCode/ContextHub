/**
 * Contract tests for `wl update --if-assignee` — the atomic assignee CAS
 * guard (epic WL-0MV82CHGQ000HAZZ, test-first child WL-0MV85WARS000THEC;
 * implementation child WL-0MV85WBDB003J35W, "C2").
 *
 * These specs pin the TARGET CLI contract of the audit-tier status-neutral
 * claim (C4, WL-0MV85WCJJ0087VMP):
 *
 *   wl update <id> --assignee <agent> --if-status completed
 *                  --if-stage in_review --if-assignee ""
 *
 * The update applies ONLY while the item's stored assignee still matches
 * the guard; a mismatch is a stale/no-op result with NO write at all. The
 * empty string is a meaningful expected value (it matches an unassigned
 * item) and is distinguishable from the flag being omitted. Exactly one of
 * two concurrent `--if-assignee ""` claims wins (RCA WL-0MSRBFFLN005W3VT
 * RC-1 single-claim guarantee, preserved by the BEGIN IMMEDIATE CAS).
 *
 * Test-first discipline: before "C2" lands, `--if-assignee` is an UNKNOWN
 * option, so every spec below FAILS against current `dev` — that is the
 * red phase. They are committed under vitest's `it.fails(...)`
 * (expected-failure) so the project-configured suite stays green while the
 * red contract is pinned in the tree. C2 flips `it.fails(` → `it(` as it
 * implements the flag; the specs then go genuinely green and validate the
 * real semantics.
 *
 * Covers AC2 (unit semantics at the CLI), AC3 (atomicity) and AC4
 * (status-neutral claim never creates an in-progress/in_review hybrid) of
 * WL-0MV85WARS000THEC.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cliPath,
  execAsync,
  enterTempDir,
  leaveTempDir,
  writeConfig,
  writeInitSemaphore,
} from './cli-helpers.js';
import { resolveTsxBin } from '../test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');
const tsxBin = resolveTsxBin(__dirname);

/** Parse the JSON worklog output from a run (stdout for success, stderr for stale). */
function parseCliJson(run: { stdout: string; stderr: string }): any {
  const text = (run.stdout || run.stderr || '').trim();
  try {
    return JSON.parse(text);
  } catch {
    // A non-JSON line (e.g. commander "error: unknown option …") is what
    // current `dev` emits for --if-assignee — it must fail the spec.
    throw new SyntaxError(`No JSON payload in CLI output: ${text.slice(0, 300)}`);
  }
}

/** Run the real CLI in a subprocess (needed for the concurrency spec). */
function runCliSubprocess(
  cwd: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxBin, cliPath, ...args], {
      cwd,
      env: { ...(process.env as Record<string, string>) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('wl update --if-assignee (assignee CAS guard, WL-0MV85WARS000THEC)', () => {
  let state: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    state = enterTempDir();
    writeConfig(state.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(state.tempDir);
  });

  afterEach(() => {
    leaveTempDir(state);
  });

  /** Create a fresh item and return its id. */
  async function createItem(title = 'CAS assignee item'): Promise<string> {
    const { stdout } = await execAsync(
      `tsx ${cliPath} --json create -t "${title}"`,
    );
    return JSON.parse(stdout).workItem.id;
  }

  /** Move an item into the audit bucket (completed/in_review), assignee cleared. */
  async function seedCompletedInReview(id: string, assignee = ''): Promise<void> {
    await execAsync(
      `tsx ${cliPath} --json update ${id} --status completed --stage in_review --assignee "${assignee}"`,
    );
  }

  /** `wl show` read back as {status,stage,assignee,priority}. */
  async function readBack(id: string): Promise<{ status: string; stage: string; assignee: string; priority: string }> {
    const { stdout } = await execAsync(`tsx ${cliPath} --json show ${id}`);
    const w = JSON.parse(stdout).workItem;
    return { status: w.status, stage: w.stage, assignee: w.assignee ?? '', priority: w.priority ?? 'medium' };
  }

  // ── AC2: exact-match success ────────────────────────────────────────

  it.fails('applies the update when --if-assignee matches the current assignee', async () => {
    const id = await createItem(); // assignee '' by default
    const { stdout } = await execAsync(
      `tsx ${cliPath} --json update ${id} --assignee AgentA --if-assignee ""`,
    );
    const parsed = JSON.parse(stdout);
    expect(parsed.success).toBe(true);
    expect((await readBack(id)).assignee).toBe('AgentA');
  });

  it.fails('succeeds with a non-empty expected value on an exact match', async () => {
    const id = await createItem();
    await execAsync(`tsx ${cliPath} --json update ${id} --assignee Alice`);
    const { stdout } = await execAsync(
      `tsx ${cliPath} --json update ${id} --assignee AgentB --if-assignee Alice`,
    );
    expect(JSON.parse(stdout).success).toBe(true);
    expect((await readBack(id)).assignee).toBe('AgentB');
  });

  // ── AC2: mismatch is a stale no-op with NO partial write ────────────

  it.fails('fails stale with no write when the current assignee no longer matches', async () => {
    const id = await createItem();
    // Another pane won the claim first.
    await execAsync(`tsx ${cliPath} --json update ${id} --assignee Other`);

    const run = await execAsync(
      `tsx ${cliPath} --json update ${id} --assignee AgentA --priority high --if-assignee ""`,
    ).catch((e) => e as { stdout: string; stderr: string });
    const parsed = parseCliJson(run as { stdout: string; stderr: string });
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('stale');
    // No partial write: the winner's assignee AND an untouched field survive.
    const back = await readBack(id);
    expect(back.assignee).toBe('Other');
    expect(back.priority).toBe('medium');
  });

  // ── AC2: the empty-string guard ─────────────────────────────────────

  it.fails('--if-assignee "" succeeds when the current assignee is empty', async () => {
    const id = await createItem();
    const { stdout } = await execAsync(
      `tsx ${cliPath} --json update ${id} --assignee AgentA --if-assignee ""`,
    );
    expect(JSON.parse(stdout).success).toBe(true);
    expect((await readBack(id)).assignee).toBe('AgentA');
  });

  it.fails('--if-assignee "" fails stale when the assignee is non-empty', async () => {
    const id = await createItem();
    await execAsync(`tsx ${cliPath} --json update ${id} --assignee Map`);

    const run = await execAsync(
      `tsx ${cliPath} --json update ${id} --assignee AgentA --if-assignee ""`,
    ).catch((e) => e as { stdout: string; stderr: string });
    const parsed = parseCliJson(run as { stdout: string; stderr: string });
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('stale');
    expect((await readBack(id)).assignee).toBe('Map');
  });

  // ── AC4: status-neutral audit-tier claim ────────────────────────────
  // The item stays completed/in_review throughout — never a hybrid.

  it.fails('audit-tier claim keeps a completed/in_review item at completed/in_review', async () => {
    const id = await createItem('Audit me');
    await seedCompletedInReview(id);

    // This is exactly the claim command the status-neutral herdr audit
    // tier will run (C4): assignee CAS only — no --status, no --stage.
    const { stdout } = await execAsync(
      `tsx ${cliPath} --json update ${id} --assignee audit-tier --if-status completed --if-stage in_review --if-assignee ""`,
    );
    expect(JSON.parse(stdout).success).toBe(true);
    const back = await readBack(id);
    expect(back.status).toBe('completed');
    expect(back.stage).toBe('in_review');
    expect(back.assignee).toBe('audit-tier');
  });

  it.fails('a claimed-and-cleared item reads back completed/in_review with an empty assignee (no hybrid, no residue)', async () => {
    const id = await createItem('Audit me');
    await seedCompletedInReview(id);

    // Claim (status-neutral).
    await execAsync(
      `tsx ${cliPath} --json update ${id} --assignee audit-tier --if-status completed --if-stage in_review --if-assignee ""`,
    );
    // Simulated audit Phase-2 failure → guarded rollback clears the assignee
    // (--if-assignee <agent>), still without touching status/stage.
    const rollback = await execAsync(
      `tsx ${cliPath} --json update ${id} --assignee "" --if-assignee audit-tier`,
    ).catch((e) => e as { stdout: string; stderr: string });
    const parsed = parseCliJson(rollback as { stdout: string; stderr: string });
    expect(parsed.success).toBe(true);
    const back = await readBack(id);
    expect(back.status).toBe('completed');
    expect(back.stage).toBe('in_review');
    expect(back.assignee).toBe('');
  });

  // ── AC3: atomicity — two concurrent claims, exactly one winner ──────

  it.fails('two concurrent --if-assignee "" claims yield exactly one winner', async () => {
    const id = await createItem('Race me');
    await seedCompletedInReview(id);

    const claim = (agent: string) =>
      runCliSubprocess(state.tempDir, [
        '--json',
        'update',
        id,
        '--assignee',
        agent,
        '--if-status',
        'completed',
        '--if-stage',
        'in_review',
        '--if-assignee',
        '',
      ]);

    const [ra, rb] = await Promise.all([claim('AgentA'), claim('AgentB')]);
    const outcomes = [parseCliJson(ra), parseCliJson(rb)];
    const winners = outcomes.filter((o) => o.success === true);
    const losers = outcomes.filter((o) => o.success === false);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].error).toBe('stale');
    // The stored assignee is exactly the winner's agent.
    const back = await readBack(id);
    expect(['AgentA', 'AgentB']).toContain(back.assignee);
    // And the item never left the audit bucket.
    expect(back.status).toBe('completed');
    expect(back.stage).toBe('in_review');
  });
});
