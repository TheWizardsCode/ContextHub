/**
 * `wl list --stage in_review -F concise` respects the 6-bucket priority order
 * (WL-0MUWDW0N6003KF6G).
 *
 * The concise/tree renderer previously re-sorted its input by database
 * position (`sortIndex`), silently discarding the in_review bucket order that
 * `list.ts` had already computed. With items created medium→high→low the
 * position order put the medium first; the fix threads `preserveOrder` so the
 * renderer keeps the caller's order (high → medium → low within a bucket).
 *
 * End-to-end in-process CLI test against a temporary worklog.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { runInProcess } from './cli-inproc.js';
import { writeConfig, writeInitSemaphore, cliPath } from './cli-helpers.js';
import { createTempDir, cleanupTempDir } from '../test-utils.js';

describe('wl list --stage in_review -F concise ordering (WL-0MUWDW0N6003KF6G)', () => {
  let tempDir: string;
  let wlDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = createTempDir();
    writeConfig(tempDir, 'Concise Order Project', 'CO');
    writeInitSemaphore(tempDir);
    wlDir = path.join(tempDir, '.worklog');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    cleanupTempDir(tempDir);
  });

  async function createInReview(title: string, priority: string): Promise<string> {
    const createRes = await runInProcess(
      `tsx ${cliPath} --json --worklog-dir ${wlDir} create -t "${title}" --priority ${priority}`,
    );
    const created = JSON.parse(createRes.stdout);
    expect(created.success).toBe(true);
    const id = created.workItem.id as string;
    const updateRes = await runInProcess(
      `tsx ${cliPath} --json --worklog-dir ${wlDir} update ${id} --stage in_review --status completed`,
    );
    expect(JSON.parse(updateRes.stdout).success).toBe(true);
    return id;
  }

  it('renders high before medium before low, overriding the position re-sort', async () => {
    // Creation order (medium → high → low) deliberately disagrees with the
    // priority order so the position-based re-sort would show the medium first.
    const mediumId = await createInReview('Medium item', 'medium');
    const highId = await createInReview('High item', 'high');
    const lowId = await createInReview('Low item', 'low');

    const res = await runInProcess(
      `tsx ${cliPath} --worklog-dir ${wlDir} list --stage in_review -F concise --no-icons`,
    );

    const highPos = res.stdout.indexOf(highId);
    const mediumPos = res.stdout.indexOf(mediumId);
    const lowPos = res.stdout.indexOf(lowId);
    expect(highPos).toBeGreaterThanOrEqual(0);
    expect(mediumPos).toBeGreaterThanOrEqual(0);
    expect(lowPos).toBeGreaterThanOrEqual(0);
    expect(highPos).toBeLessThan(mediumPos);
    expect(mediumPos).toBeLessThan(lowPos);
  });
});
