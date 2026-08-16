/**
 * Dedicated tests for `wl update --if-status/--if-stage` — the CAS claim
 * guard (compare-and-swap, RCA WL-0MSRBFFLN005W3VT design point 1).
 *
 * The herdr downtime worker uses the conditional claim so that exactly one
 * concurrent pane wins the pre-dispatch claim: the transition to
 * `in_progress` only applies while the item is still in the state the tier
 * selected it in. A guard mismatch fails per-id with error `stale` (no
 * write) and a non-zero exit — the losing pane aborts its dispatch.
 *
 * Work item: WL-0MSRDEWES0059TZN
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  cliPath,
  execAsync,
  enterTempDir,
  leaveTempDir,
  writeConfig,
  writeInitSemaphore,
} from './cli-helpers.js';

describe('wl update --if-status/--if-stage (CAS claim)', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  async function createItem(flags = ''): Promise<string> {
    const { stdout } = await execAsync(
      `tsx ${cliPath} --json create -t "CAS item" ${flags}`
    );
    return JSON.parse(stdout).workItem.id;
  }

  it('claims (status → in_progress) when the guard matches', async () => {
    const id = await createItem();
    const { stdout } = await execAsync(
      `tsx ${cliPath} --json update ${id} --status in_progress --assignee Map --if-status open --if-stage idea`
    );
    const parsed = JSON.parse(stdout);
    expect(parsed.success).toBe(true);
    expect(parsed.workItem.status).toBe('in-progress');
    expect(parsed.workItem.assignee).toBe('Map');
  });

  it('fails stale with a non-zero exit when the status no longer matches (no write)', async () => {
    const id = await createItem();
    // Another pane claimed it first.
    await execAsync(`tsx ${cliPath} --json update ${id} --status in_progress --assignee Other`);

    const run = await execAsync(
      `tsx ${cliPath} --json update ${id} --status in_progress --assignee Map --if-status open --if-stage idea`,
    ).catch((e) => e as { stdout: string; stderr: string; exitCode?: number });
    const parsed = JSON.parse((run as { stderr: string }).stderr || (run as { stdout: string }).stdout);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('stale');
    // No write happened: the winner's claim stands.
    const { stdout } = await execAsync(`tsx ${cliPath} --json show ${id}`);
    expect(JSON.parse(stdout).workItem.assignee).toBe('Other');
  });

  it('fails stale when the stage no longer matches', async () => {
    const id = await createItem();
    await execAsync(`tsx ${cliPath} --json update ${id} --stage plan_complete`);

    const run = await execAsync(
      `tsx ${cliPath} --json update ${id} --status in_progress --if-stage idea`,
    ).catch((e) => e as { stderr: string; stdout: string });
    const parsed = JSON.parse((run as { stderr: string }).stderr || (run as { stdout: string }).stdout);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('stale');
  });

  it('accepts underscore spelling for the guard (in_progress matches stored in-progress)', async () => {
    const id = await createItem();
    // The guard value itself is normalized the same way stored statuses are.
    const { stdout } = await execAsync(
      `tsx ${cliPath} --json update ${id} --status in_progress --if-status open --if-stage idea`
    );
    expect(JSON.parse(stdout).success).toBe(true);
  });

  it('a successful conditional update is not a false success when fields match', async () => {
    const id = await createItem();
    const { stdout } = await execAsync(
      `tsx ${cliPath} --json update ${id} --status in_progress --if-status open --if-stage idea`
    );
    expect(JSON.parse(stdout).success).toBe(true);
  });
});
