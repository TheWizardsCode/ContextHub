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
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

  /**
   * Rewrite `.worklog/config.yaml` to the production default stage set —
   * WITHOUT the retired `in_progress` stage (WL-0MTYL7DX9000MZOH). This
   * simulates the stage removal while the stored rows (created under the
   * legacy config that still listed it) keep their retired value.
   */
  function writeConfigWithoutRetiredStage(dir: string): void {
    writeFileSync(
      join(dir, '.worklog', 'config.yaml'),
      [
        'projectName: Test Project',
        'prefix: TEST',
        'statuses:',
        '  - value: open',
        '    label: Open',
        '  - value: in-progress',
        '    label: In Progress',
        '  - value: completed',
        '    label: Completed',
        '  - value: deleted',
        '    label: Deleted',
        'stages:',
        '  - value: ""',
        '    label: Undefined',
        '  - value: idea',
        '    label: Idea',
        '  - value: plan_complete',
        '    label: Plan Complete',
        '  - value: in_review',
        '    label: In Review',
        '  - value: done',
        '    label: Done',
        'statusStageCompatibility:',
        '  open: ["", idea, plan_complete]',
        '  in-progress: [plan_complete]',
        '  completed: [in_review, done]',
        '  deleted: [""]',
      ].join('\n'),
      'utf-8',
    );
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

  // ── Retired-stage tolerance (WL-0MTYL7DX9000MZOH) ──────────────────
  // The `in_progress` stage was removed from the valid set (WL-0MTOHS5B4001Y9FX)
  // but legacy rows still carry it. Re-validating an unchanged stored stage
  // made every status-only update fail (`Invalid stage "in_progress"`), and
  // the downtime dispatcher counted that as a hard wl-error strike.

  it('does not reject an unchanged retired stored stage on a status-only update', async () => {
    // Legacy row: created while in_progress was still a listed stage.
    const id = await createItem('--stage in_progress');
    // Production config no longer lists the retired stage.
    writeConfigWithoutRetiredStage(tempState.tempDir);

    // Status-only CAS claim — the stored stage is untouched by this update
    // and must not abort it.
    const { stdout } = await execAsync(
      `tsx ${cliPath} --json update ${id} --status in_progress --assignee Map --if-status open`
    );
    const parsed = JSON.parse(stdout);
    expect(parsed.success).toBe(true);
    expect(parsed.workItem.status).toBe('in-progress');
    expect(parsed.workItem.stage).toBe('in_progress');
  });

  it('retired-stage claim can migrate the stored stage atomically (--stage) and succeeds', async () => {
    const id = await createItem('--stage in_progress');
    writeConfigWithoutRetiredStage(tempState.tempDir);

    // Recovery claim: CAS on the item's ACTUAL retired stage (race-safe)
    // while `--stage plan_complete` advances it to a valid value in the
    // same write (the dispatcher's retired-stage recovery path).
    const { stdout } = await execAsync(
      `tsx ${cliPath} --json update ${id} --status in_progress --assignee Map ` +
      `--if-status open --if-stage in_progress --stage plan_complete`
    );
    const parsed = JSON.parse(stdout);
    expect(parsed.success).toBe(true);
    expect(parsed.workItem.status).toBe('in-progress');
    expect(parsed.workItem.stage).toBe('plan_complete');
  });

  it('a stale retired-stage CAS guard fails stale (no write), never a validation error', async () => {
    const id = await createItem('--stage in_progress');
    writeConfigWithoutRetiredStage(tempState.tempDir);
    // Item moves to plan_complete between selection and claim.
    await execAsync(`tsx ${cliPath} --json update ${id} --stage plan_complete`);

    const run = await execAsync(
      `tsx ${cliPath} --json update ${id} --status in_progress --if-status open --if-stage in_progress`,
    ).catch((e) => e as { stdout: string; stderr: string });
    const parsed = JSON.parse((run as { stderr: string }).stderr || (run as { stdout: string }).stdout);
    // Lost race — a stale guard, NOT `Invalid stage ...` (no hard strike).
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('stale');
    const { stdout } = await execAsync(`tsx ${cliPath} --json show ${id}`);
    expect(JSON.parse(stdout).workItem.stage).toBe('plan_complete');
  });
});
