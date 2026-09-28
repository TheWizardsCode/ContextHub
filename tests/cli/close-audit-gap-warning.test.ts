/**
 * Integration tests for the non-fatal audit-gap closure guard
 * (WL-0MUBVH9FV0027COG AC2/AC3).
 *
 * Covers: an unaudited root closed from in_review is flagged; a fresh audit,
 * an explicit waiver, and derived parent coverage all suppress the flag;
 * `--force` bypasses the flag and records a durable waiver.
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
import { runInProcess } from './cli-inproc.js';

async function runJson(args: string): Promise<any> {
  const { stdout } = await execAsync(`tsx ${cliPath} --json ${args}`);
  return JSON.parse(stdout);
}

async function runRaw(args: string): Promise<{ stdout: string; stderr: string }> {
  return await execAsync(`tsx ${cliPath} ${args}`);
}

/** Run JSON and parse even when the CLI exits non-zero. */
async function runJsonRaw(args: string): Promise<any> {
  const res = await runInProcess(`tsx ${cliPath} --json ${args}`, 30000);
  return JSON.parse(res.stdout ?? '');
}

describe('close audit-gap guard', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeInitSemaphore(tempState.tempDir);
    writeConfig(tempState.tempDir);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  async function createItem(title: string, inReview = true): Promise<string> {
    const created = await runJson(`create -t "${title}"`);
    const id = created.workItem.id;
    if (inReview) await runJson(`update ${id} --status completed --stage in_review`);
    return id;
  }

  async function setFreshAudit(id: string): Promise<void> {
    await runJson(`update ${id} --audit-text "Ready to close: Yes\nAll criteria met"`);
  }

  it('flags an unaudited root closed from in_review (non-fatal human warning + JSON field)', async () => {
    const id = await createItem('Unaudited root');

    const { stdout, stderr } = await runRaw(`close ${id} -r "done"`);
    expect(stdout).toContain(`Closed ${id}`);
    expect(stderr).toContain(`Warning: ${id} (root)`);
    expect(stderr).toContain('audit gate leak');

    // The close still succeeded (non-fatal).
    const shown = await runJson(`show ${id}`);
    expect(shown.workItem.status).toBe('completed');
  });

  it('exposes the warning in JSON mode (and keeps stderr clean)', async () => {
    const id = await createItem('Unaudited root JSON');
    const { stdout, stderr } = await execAsync(`tsx ${cliPath} --json close ${id} -r "done"`);
    const result = JSON.parse(stdout);

    expect(result.closed).toBe(1);
    expect(result.auditGapWarnings).toHaveLength(1);
    expect(result.auditGapWarnings[0]).toContain(id);
    expect(result.results[0].auditGapWarnings).toHaveLength(1);
    // Human warnings are suppressed from stderr in JSON mode.
    expect(stderr).not.toContain('audit gate leak');
  });

  it('does not flag a root with a fresh audit', async () => {
    const id = await createItem('Fresh-audited root');
    await setFreshAudit(id);

    const { stderr } = await runRaw(`close ${id} -r "done"`);
    expect(stderr).not.toContain('audit gate leak');
  });

  it('does not flag a root with an explicit waiver', async () => {
    const id = await createItem('Waived root');
    await runJson(`audit-waive ${id} --reason "legacy"`);

    const { stderr } = await runRaw(`close ${id} -r "done"`);
    expect(stderr).not.toContain('audit gate leak');
  });

  it('does not flag a child covered by a fresh-audited direct parent', async () => {
    const parent = await runJson(`create -t "Audited parent"`);
    const parentId = parent.workItem.id;
    const child = await runJson(`create -t "Covered child" --parent ${parentId}`);
    const childId = child.workItem.id;
    await runJson(`update ${parentId} --status completed --stage in_review`);
    await setFreshAudit(parentId);
    await runJson(`update ${childId} --status completed --stage in_review`);

    const { stderr } = await runRaw(`close ${childId} -r "done"`);
    expect(stderr).not.toContain('audit gate leak');
  });

  it('flags a child whose direct parent has no fresh audit', async () => {
    const parent = await runJson(`create -t "Unaudited parent"`);
    const parentId = parent.workItem.id;
    const child = await runJson(`create -t "Uncovered child" --parent ${parentId}`);
    const childId = child.workItem.id;
    await runJson(`update ${parentId} --status completed --stage in_review`);
    await runJson(`update ${childId} --status completed --stage in_review`);

    const { stderr } = await runRaw(`close ${childId} -r "done"`);
    expect(stderr).toContain(`Warning: ${childId} (child of ${parentId})`);
  });

  it('--force bypasses the warning and records a durable waiver on an uncovered root', async () => {
    const id = await createItem('Force-closed root');

    const result = await runJsonRaw(`close --force ${id} -r "shipping without audit"`);
    expect(result.closed).toBe(1);
    expect(result.auditGapWarnings ?? []).toHaveLength(0);

    const shown = await runJson(`show ${id}`);
    expect(shown.workItem.status).toBe('completed');
    expect(shown.workItem.auditWaiver).toMatchObject({ author: 'worklog' });
    expect(shown.workItem.auditWaiver.reason).toContain('wl close --force');
    expect(shown.workItem.auditWaiver.reason).toContain('shipping without audit');
  });

  it('does not flag a never-reviewed open item (not an audit-gap concern)', async () => {
    const id = await createItem('Open item', false);

    const { stderr } = await runRaw(`close ${id} -r "abandoned"`);
    expect(stderr).not.toContain('audit gate leak');
  });
});
