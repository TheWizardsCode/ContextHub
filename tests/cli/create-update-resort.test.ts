import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  cliPath,
  execAsync,
  enterTempDir,
  leaveTempDir,
  writeConfig,
  writeInitSemaphore
} from './cli-helpers.js';

describe('Create/Update Auto Re-sort Behavior', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  it('create with --no-re-sort should suppress automatic re-sort', async () => {
    // Create a low-priority item first
    await execAsync(`tsx ${cliPath} --json create -t "Low first" -p low`);
    // Create a high-priority item but suppress automatic re-sort
    await execAsync(`tsx ${cliPath} --json create -t "High suppressed" -p high --no-re-sort`);

    // Request next without allowing next to run its own re-sort (preserve current sortIndex order)
    const { stdout } = await execAsync(`tsx ${cliPath} --json next --no-re-sort`);
    const result = JSON.parse(stdout);
    // Because the create suppressed re-sort, the original (low-priority) item
    // should still be first in the stale ordering when next does not re-sort.
    expect(result.success).toBe(true);
    expect(result.workItem.title).toBe('Low first');
  });

  it('update changing priority should trigger re-sort by default', async () => {
    // Create two items: low and medium
    // Create initial items but suppress automatic re-sort on create so the
    // created ordering (Low first, Medium second) is preserved in sortIndex.
    await execAsync(`tsx ${cliPath} --json create -t "Low item" -p low --no-re-sort`);
    const mediumOut = await execAsync(`tsx ${cliPath} --json create -t "Medium item" -p medium --no-re-sort`);
    const medium = JSON.parse(mediumOut.stdout).workItem;

    // Update the medium item to critical (no --no-re-sort)
    await execAsync(`tsx ${cliPath} --json update ${medium.id} -p critical`);

    // Ask for next but prevent next from doing its own re-sort so we can
    // validate that the update-triggered re-sort already reordered items.
    const { stdout } = await execAsync(`tsx ${cliPath} --json next --no-re-sort`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.workItem.title).toBe('Medium item');
  });

  it('update with --no-re-sort should suppress automatic re-sort', async () => {
    // Create two items: low and medium
    // Create initial items without triggering auto re-sort so sortIndex
    // ordering corresponds to creation order.
    await execAsync(`tsx ${cliPath} --json create -t "Low A" -p low --no-re-sort`);
    const mediumOut = await execAsync(`tsx ${cliPath} --json create -t "Medium B" -p medium --no-re-sort`);
    const medium = JSON.parse(mediumOut.stdout).workItem;

    // Update the medium item to critical but suppress re-sort
    await execAsync(`tsx ${cliPath} --json update ${medium.id} -p critical --no-re-sort`);

    // Ask for next with --no-re-sort to avoid next performing a fresh re-sort.
    const { stdout } = await execAsync(`tsx ${cliPath} --json next --no-re-sort`);
    const result = JSON.parse(stdout);
    // Because update suppressed re-sort, the sortIndex ordering should remain
    // as created (verify explicitly) even though selection favors critical
    // items. Verify sortIndex values were not modified and that `next` still
    // selects the critical item based on priority.
    expect(result.success).toBe(true);
    // Verify sortIndex ordering persisted (Low A created first -> sortIndex 100)
    const { stdout: postList } = await execAsync(`tsx ${cliPath} --json list`);
    const post = JSON.parse(postList);
    const low = post.workItems.find((w: any) => w.title === 'Low A');
    const med = post.workItems.find((w: any) => w.title === 'Medium B');
    expect(low.sortIndex).toBeLessThan(med.sortIndex);
    expect(result.workItem.title).toBe('Medium B');
  });
});
