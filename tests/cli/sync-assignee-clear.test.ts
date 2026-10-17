/**
 * Cross-root sync test: assignee clear propagation (WL-0MV85WBZ2004VDUQ).
 *
 * Epic Q1 accepted answer (a): `assignee` is a scheduling hold, not a
 * protected data field, so it is NOT regression-guarded. A cleared assignee
 * (`''`) on a newer remote must propagate into a non-empty local assignee
 * WITHOUT `--accept-regressions` — otherwise a released scheduling hold is
 * refused as a regression and the stale claim is resurrected cross-root.
 *
 * These tests drive the REAL `wl sync` command against a mock git remote
 * (two worklog roots: repoA = local, repoB = remote) so the chosen rule is
 * exercised end-to-end. Other merge fields' regression protection
 * (status/stage/priority) is asserted unchanged.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execWithInput, writeConfig, writeInitSemaphore, cliPath } from './cli-helpers.js';
import { createTempDir, cleanupTempDir } from '../test-utils.js';

const OWN_EMAIL = 'ross@example.com';
const REMOTE_REF = 'refs/worklog/remotes/origin/worklog/data';

function jsonlLine(type: string, data: unknown): string {
  return JSON.stringify({ data, type });
}

/** Minimal remote workitem matching the export/import schema used by tests. */
function makeItem(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: 'Assignee clear item',
    description: '',
    status: 'open',
    priority: 'medium',
    sortIndex: 0,
    parentId: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    tags: [],
    assignee: '',
    stage: '',
    issueType: '',
    createdBy: '',
    deletedBy: '',
    deleteReason: '',
    risk: '',
    effort: '',
    ...overrides,
  };
}

describe('cross-root sync: assignee clear propagation (WL-0MV85WBZ2004VDUQ)', () => {
  let repoA: string; // local worklog root
  let repoB: string; // remote worklog root (repoA's origin)

  beforeEach(() => {
    repoA = createTempDir();
    repoB = createTempDir();
    for (const repo of [repoA, repoB]) {
      fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    }
    writeConfig(repoA, 'Assignee Clear Test', 'GUA');
    writeInitSemaphore(repoA);
    // repoA's remote points at repoB so `wl sync` reads repoB's data file.
    fs.writeFileSync(path.join(repoA, '.git', 'remote_origin'), repoB, 'utf8');
    fs.writeFileSync(path.join(repoA, '.git', 'user-email'), `${OWN_EMAIL}\n`, 'utf8');
    fs.mkdirSync(path.join(repoB, '.worklog'), { recursive: true });
  });

  afterEach(() => {
    cleanupTempDir(repoA);
    cleanupTempDir(repoB);
  });

  async function wl(args: string): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    return execWithInput(`tsx ${cliPath} --worklog-dir ${repoA}/.worklog ${args}`, '', {
      cwd: repoA,
      timeout: 60000,
    });
  }

  async function createLocalItem(assignee: string): Promise<{ id: string; updatedAt: string }> {
    const created = await wl(`create --json -t "Assignee clear item" --assignee "${assignee}"`);
    expect(created.exitCode, `${created.stdout}\n${created.stderr}`).toBe(0);
    const payload = JSON.parse(created.stdout);
    const id: string = payload.workItem?.id ?? payload.workItems?.[0].id ?? payload.id;
    expect(id).toBeTruthy();

    const shown = await wl(`show ${id} --json`);
    expect(shown.exitCode, `${shown.stdout}\n${shown.stderr}`).toBe(0);
    const item = JSON.parse(shown.stdout).workItem;
    return { id, updatedAt: item.updatedAt };
  }

  async function seedRemote(data: string): Promise<void> {
    fs.writeFileSync(path.join(repoB, '.worklog', 'worklog-data.jsonl'), data, 'utf8');
  }

  async function getItem(id: string): Promise<Record<string, unknown>> {
    const shown = await wl(`show ${id} --json`);
    expect(shown.exitCode, `${shown.stdout}\n${shown.stderr}`).toBe(0);
    return JSON.parse(shown.stdout).workItem;
  }

  it('propagates a newer remote empty assignee into a local non-empty assignee (no --accept-regressions)', async () => {
    // repoA holds the claim (assignee = Map).
    const local = await createLocalItem('Map');
    expect(local.updatedAt).toBeTruthy();
    expect((await getItem(local.id)).assignee).not.toBe('');

    // repoB cleared the claim at a NEWER timestamp.
    await seedRemote(
      `${jsonlLine('workitem', makeItem(local.id, {
        id: local.id,
        title: 'Assignee clear item',
        updatedAt: '2099-01-01T00:00:00.000Z', // definitely newer than the local DB write
        assignee: '',
      }))}\n`
    );

    const synced = await wl('sync --no-push');
    const output = `${synced.stdout}\n${synced.stderr}`;
    expect(synced.exitCode, output).toBe(0);

    // The clear propagated: local assignee is now empty.
    expect((await getItem(local.id)).assignee).toBe('');

    // And it was NOT reported as a refused regression.
    expect(output.toLowerCase()).not.toMatch(/regression/i);
  }, 90000);

  it('does NOT propagate a stale remote empty assignee over a newer local hold', async () => {
    // repoA holds the claim at a NEWER timestamp than repoB's stale empty copy.
    const local = await createLocalItem('Map');
    await seedRemote(
      `${jsonlLine('workitem', makeItem(local.id, {
        id: local.id,
        title: 'Assignee clear item',
        updatedAt: '2000-01-01T00:00:00.000Z', // older than the local claim
        assignee: '',
      }))}\n`
    );

    const synced = await wl('sync --no-push');
    const output = `${synced.stdout}\n${synced.stderr}`;
    expect(synced.exitCode, output).toBe(0);

    // Last-writer-wins keeps the newer local hold.
    expect((await getItem(local.id)).assignee).not.toBe('');
  }, 90000);

  it('still refuses a status regression cross-root (status/stage/priority protection unchanged)', async () => {
    // repoA item is in-progress; repoB has an OLDER-ish but newer-timestamped
    // 'open' copy — the regression guard must keep the local value.
    const local = await createLocalItem('');
    await wl(`update ${local.id} --status in-progress`);
    await seedRemote(
      `${jsonlLine('workitem', makeItem(local.id, {
        id: local.id,
        title: 'Assignee clear item',
        updatedAt: '2099-01-01T00:00:00.000Z',
        status: 'open',
        assignee: '',
      }))}\n`
    );

    const synced = await wl('sync --no-push');
    const output = `${synced.stdout}\n${synced.stderr}`;
    expect(synced.exitCode, output).toBe(0);

    // Local in-progress kept despite the newer remote 'open'.
    expect((await getItem(local.id)).status).toBe('in-progress');
  }, 90000);
});
