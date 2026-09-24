/**
 * Tests for `wl doctor --fix` migrating rows stuck on the retired
 * `in_progress` stage (WL-0MTYL7DX9000MZOH AC5).
 *
 * The `in_progress` stage was removed from the valid stage set
 * (WL-0MTOHS5B4001Y9FX) but rows created before the removal still carry it.
 * Once the config no longer lists the stage, the checker reports those rows
 * as `invalid-stage` — this test proves `wl doctor --fix` migrates the
 * stored stage to `plan_complete` automatically instead of leaving the row
 * for manual review, and leaves a row whose status cannot admit
 * `plan_complete` (completed) untouched.
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
  seedWorkItems,
} from './cli/cli-helpers.js';

/**
 * Rewrite `.worklog/config.yaml` to the production default stage set —
 * WITHOUT the retired `in_progress` stage.
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

describe('wl doctor --fix retired in_progress stage', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  async function showItem(id: string): Promise<{ stage: string; status: string }> {
    const { stdout } = await execAsync(`tsx ${cliPath} --json show ${id}`);
    return JSON.parse(stdout).workItem;
  }

  it('migrates a retired-stage open item to plan_complete with --fix', async () => {
    // Seed legacy rows directly (bypasses the now-removed stage validation).
    seedWorkItems(tempState.tempDir, [
      { id: 'TEST-RETIRED-OPEN', title: 'open retired row', status: 'open', stage: 'in_progress' },
    ]);
    // Production config no longer lists the retired stage.
    writeConfigWithoutRetiredStage(tempState.tempDir);

    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor --fix`);
    // JSON output is the (possibly empty) list of REMAINING findings — a
    // safe migration leaves nothing behind for this row.
    expect(Array.isArray(JSON.parse(stdout))).toBe(true);

    const item = await showItem('TEST-RETIRED-OPEN');
    expect(item.stage).toBe('plan_complete');
    expect(item.status).toBe('open');
  });

  it('leaves a retired-stage row whose status cannot admit plan_complete for manual review', async () => {
    seedWorkItems(tempState.tempDir, [
      { id: 'TEST-RETIRED-DONE', title: 'completed retired row', status: 'completed', stage: 'in_progress' },
    ]);
    writeConfigWithoutRetiredStage(tempState.tempDir);

    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor --fix`);
    expect(Array.isArray(JSON.parse(stdout))).toBe(true);

    // plan_complete is not compatible with `completed`; the row is left for
    // manual review rather than being migrated into another invalid combo.
    const item = await showItem('TEST-RETIRED-DONE');
    expect(item.stage).toBe('in_progress');
    expect(item.status).toBe('completed');
  });
});