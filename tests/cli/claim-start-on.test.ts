/**
 * CLI integration tests for the `startOn` claim guard and its audited override
 * (WL-0MWMGEUT10056MUI, parent WL-0MWM0FDZK007BAD0; parent AC5, AC7).
 *
 * The CLI is the common claim path: the workflow's `StatusLifecycle` helper and
 * the Herdr claim both shell into `wl update`, so a refusal here covers them
 * all. Instants are absolute (year 2000 = started, year 2099 = scheduled) so
 * the assertions do not depend on the day the suite runs; the frozen-clock
 * half of the contract lives in `tests/unit/claim-start-on.test.ts`.
 *
 * What is pinned here:
 * - a claim of a future item is refused with the machine-readable
 *   `start_on_not_reached` reason in JSON and a non-zero exit;
 * - the message names the effective `startOn` and how long until it is reached;
 * - a status-neutral assignee-only claim (the Herdr audit-tier shape) is refused
 *   too;
 * - `--force-start-on "<reason>"` proceeds and writes an audited comment naming
 *   the actor, the reason and the overridden `startOn`;
 * - that comment survives export/import;
 * - `createdAt`-defaulted items and already-started items are never refused;
 * - a non-claim update on a future item is never refused.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import {
  cliPath,
  execAsync,
  enterTempDir,
  leaveTempDir,
  writeConfig,
  writeInitSemaphore,
} from './cli-helpers.js';

/** A scheduled instant far enough ahead to stay in the future. */
const FUTURE_ON = '2099-11-19T10:25:00Z';
/** A started instant far enough behind to stay in the past. */
const STARTED_ON = '2000-01-01T00:00:00Z';

describe('startOn claim guard (wl update)', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  async function createItem(title = 'Scheduled item', flags = ''): Promise<any> {
    const { stdout } = await execAsync(`tsx ${cliPath} --json create -t "${title}" ${flags}`);
    return JSON.parse(stdout).workItem;
  }

  async function showItem(id: string): Promise<any> {
    const { stdout } = await execAsync(`tsx ${cliPath} --json show ${id}`);
    return JSON.parse(stdout);
  }

  /** Run an update expected to fail; returns the parsed JSON refusal. */
  async function refusedUpdate(args: string): Promise<{ exitCode: number; payload: any }> {
    const failure = await execAsync(args).then(
      () => null,
      (err: any) => err,
    );
    expect(failure, 'the claim must exit non-zero').not.toBeNull();
    const text = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    // The CLI may interleave log lines around the single-line refusal JSON, so
    // extract every brace-bounded chunk and take the last one that parses to an
    // object carrying an `error` field.
    const chunks = text.match(/\{[^{}]*\}/g) ?? [];
    let payload: any = null;
    for (const chunk of chunks.reverse()) {
      try {
        const parsed = JSON.parse(chunk);
        if (parsed && typeof parsed === 'object' && parsed.error !== undefined) {
          payload = parsed;
          break;
        }
      } catch {
        // Not the refusal payload — keep looking.
      }
    }
    expect(payload, `no JSON refusal found in output: ${text}`).not.toBeNull();
    return { exitCode: failure.code ?? failure.exitCode ?? 1, payload };
  }

  it('refuses an in-progress claim on a future item with a machine-readable reason', async () => {
    const item = await createItem('Future task', `--start-on ${FUTURE_ON}`);

    const { exitCode, payload } = await refusedUpdate(
      `tsx ${cliPath} --json update ${item.id} --status in_progress --assignee implement`,
    );

    expect(exitCode).not.toBe(0);
    expect(payload.success).toBe(false);
    expect(payload.error).toBe('start_on_not_reached');
    expect(payload.reason).toBe('start_on_not_reached');
    expect(payload.startOn).toBe('2099-11-19T10:25:00.000Z');
    // The message names the effective startOn and how long until it is reached.
    expect(payload.message).toContain('2099-11-19T10:25:00.000Z');
    expect(payload.message).toMatch(/(second|minute|hour|day)/);
    expect(payload.message).toContain('--force-start-on');

    // The refusal leaves the item untouched.
    const after = await showItem(item.id);
    expect(after.workItem.status).toBe('open');
    expect(after.workItem.assignee).toBe('');
  });

  it('refuses a status-neutral assignee-only claim (Herdr audit-tier shape)', async () => {
    const item = await createItem('Future task', `--start-on ${FUTURE_ON}`);

    const { payload } = await refusedUpdate(
      `tsx ${cliPath} --json update ${item.id} --assignee audit-tier --if-assignee ""`,
    );

    expect(payload.success).toBe(false);
    expect(payload.error).toBe('start_on_not_reached');
    const after = await showItem(item.id);
    expect(after.workItem.assignee).toBe('');
  });

  it('proceeds with an audited override and records actor, reason and startOn', async () => {
    const item = await createItem('Future task', `--start-on ${FUTURE_ON}`);
    const reason = 'measurement window must not slip';

    const { stdout } = await execAsync(
      `tsx ${cliPath} --json update ${item.id} --status in_progress --assignee implement ` +
        `--force-start-on "${reason}"`,
    );
    const updated = JSON.parse(stdout);
    expect(updated.success).toBe(true);
    expect(updated.workItem.status).toBe('in-progress');
    expect(updated.workItem.assignee).toBe('implement');

    const shown = await showItem(item.id);
    const override = shown.comments.find((c: any) =>
      String(c.comment).includes('startOn override'),
    );
    expect(override, 'an audited override comment must be recorded').toBeTruthy();
    expect(override.author).toBe('implement');
    expect(override.comment).toContain(reason);
    expect(override.comment).toContain('2099-11-19T10:25:00.000Z');
  });

  it('survives export/import with the override comment intact', async () => {
    const item = await createItem('Future task', `--start-on ${FUTURE_ON}`);
    await execAsync(
      `tsx ${cliPath} --json update ${item.id} --status in_progress --assignee implement ` +
        `--force-start-on "early start because the window is closing"`,
    );

    const exportPath = path.join(tempState.tempDir, 'override-export.jsonl');
    await execAsync(`tsx ${cliPath} --json export --file "${exportPath}"`);
    await execAsync(`tsx ${cliPath} --json import --file "${exportPath}"`);

    const shown = await showItem(item.id);
    const override = shown.comments.find((c: any) =>
      String(c.comment).includes('startOn override'),
    );
    expect(override).toBeTruthy();
    expect(override.comment).toContain('early start because the window is closing');
    expect(override.comment).toContain('2099-11-19T10:25:00.000Z');
  });

  it('never refuses a createdAt-defaulted item', async () => {
    // No --start-on: the item's startOn defaults to its (past) createdAt.
    const item = await createItem('Defaulted task');
    const { stdout } = await execAsync(
      `tsx ${cliPath} --json update ${item.id} --status in_progress --assignee implement`,
    );
    const updated = JSON.parse(stdout);
    expect(updated.success).toBe(true);
    expect(updated.workItem.status).toBe('in-progress');
  });

  it('allows a claim once the item has started', async () => {
    const item = await createItem('Started task', `--start-on ${STARTED_ON}`);
    const { stdout } = await execAsync(
      `tsx ${cliPath} --json update ${item.id} --status in_progress --assignee implement`,
    );
    expect(JSON.parse(stdout).success).toBe(true);
  });

  it('never refuses a non-claim update on a future item', async () => {
    const item = await createItem('Future task', `--start-on ${FUTURE_ON}`);
    const { stdout } = await execAsync(
      `tsx ${cliPath} --json update ${item.id} --priority high`,
    );
    const updated = JSON.parse(stdout);
    expect(updated.success).toBe(true);
    expect(updated.workItem.priority).toBe('high');
  });

  it('writes no override comment when the flag is passed on an already-started item', async () => {
    const item = await createItem('Started task', `--start-on ${STARTED_ON}`);
    await execAsync(
      `tsx ${cliPath} --json update ${item.id} --status in_progress --assignee implement ` +
        `--force-start-on "not actually needed"`,
    );
    const shown = await showItem(item.id);
    const override = shown.comments.find((c: any) =>
      String(c.comment).includes('startOn override'),
    );
    expect(override).toBeUndefined();
  });

  it('documents the guard and the override flag in update --help', async () => {
    const { stdout } = await execAsync(`tsx ${cliPath} update --help`);
    expect(stdout).toContain('--force-start-on');
    expect(stdout.toLowerCase()).toContain('starton');
    // Parent AC8: `wl update --help` describes the field *and its default*.
    expect(stdout).toContain('--start-on');
    expect(stdout).toContain('createdAt');
    expect(stdout).toContain('""');
  });
});
