/**
 * CLI tests for `wl update <id> --start-on` (WL-0MWMGEREG002L2YA, parent
 * WL-0MWM0FDZK007BAD0) — the authoring half of AC2.
 *
 * Covers: setting a scheduled instant, offset acceptance with UTC
 * normalisation, `--start-on ""` clearing back to the item's `createdAt`, the
 * bare-date rejection and the actionable invalid-value message (non-zero exit,
 * no write), and `wl show <id>` retrieving a future item by id.
 *
 * Every instant is derived from the shared frozen clock, so the assertions are
 * reproducible on any day.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cliPath, execAsync, enterTempDir, leaveTempDir, writeConfig, writeInitSemaphore } from './cli-helpers.js';
import { createFrozenClock } from '../helpers/frozen-clock.js';
import { START_ON_TIMEZONE_EXAMPLE, START_ON_UTC_EXAMPLE } from '../../src/validators/start-on.js';

/** Frozen "now" used to derive the instant expectations. */
const clock = createFrozenClock('2099-11-19T10:25:00.000Z');
/** The canonical (UTC `Z`) form the store must hold. */
const START_ON_UTC = clock.nowIso();
/** The same instant authored with a +01:00 offset. */
const START_ON_OFFSET = '2099-11-19T11:25:00+01:00';

describe('wl update --start-on', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  async function createItem(title = 'Plain item'): Promise<any> {
    const { stdout } = await execAsync(`tsx ${cliPath} --json create -t "${title}"`);
    return JSON.parse(stdout);
  }

  async function show(itemId: string): Promise<any> {
    const { stdout } = await execAsync(`tsx ${cliPath} --json show ${itemId}`);
    return JSON.parse(stdout).workItem;
  }

  it('sets a scheduled instant and shows it by id', async () => {
    const created = await createItem();
    expect(created.workItem.startOn).toBe(created.workItem.createdAt);

    const { stdout } = await execAsync(
      `tsx ${cliPath} --json update ${created.id} --start-on ${START_ON_UTC}`,
    );
    const updated = JSON.parse(stdout);
    expect(updated.success).toBe(true);
    expect(updated.workItem.startOn).toBe(START_ON_UTC);

    expect((await show(created.id)).startOn).toBe(START_ON_UTC);
    // Human output surfaces the scheduled instant.
    const human = await execAsync(`tsx ${cliPath} show ${created.id}`);
    expect(human.stdout).toContain(START_ON_UTC);
  });

  it('accepts a UTC offset and normalises it to UTC Z form', async () => {
    const created = await createItem();
    const { stdout } = await execAsync(
      `tsx ${cliPath} --json update ${created.id} --start-on ${START_ON_OFFSET}`,
    );
    const updated = JSON.parse(stdout).workItem;
    expect(updated.startOn).toBe(START_ON_UTC);
    expect(updated.startOn.endsWith('Z')).toBe(true);
    expect(updated.startOn).not.toContain('+');
  });

  it('clears back to createdAt with --start-on ""', async () => {
    const created = await createItem();
    const previousCreatedAt = created.workItem.createdAt;

    await execAsync(`tsx ${cliPath} --json update ${created.id} --start-on ${START_ON_UTC}`);
    expect((await show(created.id)).startOn).toBe(START_ON_UTC);

    const { stdout } = await execAsync(`tsx ${cliPath} --json update ${created.id} --start-on ""`);
    const cleared = JSON.parse(stdout).workItem;
    expect(cleared.startOn).toBe(previousCreatedAt);
    expect((await show(created.id)).startOn).toBe(previousCreatedAt);
  });

  it('rejects a bare date with an actionable message and leaves the value untouched', async () => {
    const created = await createItem();
    const before = await show(created.id);

    const failure = await execAsync(
      `tsx ${cliPath} --json update ${created.id} --start-on 2099-11-19`,
    ).then(
      () => null,
      (err: any) => err,
    );
    expect(failure, 'a bare date must exit non-zero').not.toBeNull();
    const text = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    expect(text).toContain('--start-on');
    expect(text).toContain('2099-11-19');
    expect(text).toContain(START_ON_UTC_EXAMPLE);
    expect(text).toContain(START_ON_TIMEZONE_EXAMPLE);

    const after = await show(created.id);
    expect(after.startOn).toBe(before.startOn);
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it('rejects an unparseable value and leaves the value untouched', async () => {
    const created = await createItem();
    const before = await show(created.id);

    const failure = await execAsync(
      `tsx ${cliPath} --json update ${created.id} --start-on not-an-instant`,
    ).then(
      () => null,
      (err: any) => err,
    );
    expect(failure).not.toBeNull();
    expect(`${failure.stdout ?? ''}${failure.stderr ?? ''}`).toContain('not-an-instant');

    expect((await show(created.id)).startOn).toBe(before.startOn);
  });

  it('rejects an invalid value in a batch update without writing any id', async () => {
    const first = await createItem('First item');
    const second = await createItem('Second item');
    const before = [await show(first.id), await show(second.id)];

    const failure = await execAsync(
      `tsx ${cliPath} --json update ${first.id} ${second.id} --start-on 2099-11-19`,
    ).then(
      () => null,
      (err: any) => err,
    );
    expect(failure).not.toBeNull();

    const after = [await show(first.id), await show(second.id)];
    expect(after.map((i) => i.startOn)).toEqual(before.map((i) => i.startOn));
  });

  it('documents the flag, its ISO-8601 offset and clear forms in --help', async () => {
    const { stdout } = await execAsync(`tsx ${cliPath} update --help`);
    expect(stdout).toContain('--start-on');
    expect(stdout.toLowerCase()).toContain('iso-8601');
    expect(stdout).toContain('+01:00');
    expect(stdout).toContain('createdAt');
    expect(stdout).toContain('""');
  });
});
