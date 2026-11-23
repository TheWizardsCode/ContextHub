/**
 * CLI tests for `wl create --start-on` (WL-0MWMGEREG002L2YA, parent
 * WL-0MWM0FDZK007BAD0) — the authoring half of AC2.
 *
 * Covers: setting a full ISO-8601 timestamp, accepting a UTC offset and
 * normalising it to UTC `Z` form before storage, defaulting to the item's
 * `createdAt` when the flag is omitted, the `""` clear form on create, the
 * bare-date rejection, the actionable invalid-value message (non-zero exit,
 * nothing written), and `wl show <id>` retrieving a future item by id.
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

describe('wl create --start-on', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  async function createJson(flags = ''): Promise<any> {
    const { stdout } = await execAsync(`tsx ${cliPath} --json create -t "Scheduled item" ${flags}`);
    return JSON.parse(stdout);
  }

  it('stores a UTC timestamp as authored', async () => {
    const created = await createJson(`--start-on ${START_ON_UTC}`);
    expect(created.success).toBe(true);
    expect(created.workItem.startOn).toBe(START_ON_UTC);
  });

  it('accepts a UTC offset and normalises it to UTC Z form', async () => {
    const created = await createJson(`--start-on ${START_ON_OFFSET}`);
    expect(created.workItem.startOn).toBe(START_ON_UTC);
    expect(created.workItem.startOn.endsWith('Z')).toBe(true);
    // The persisted value normalises identically on read-back.
    const { stdout } = await execAsync(`tsx ${cliPath} --json show ${created.id}`);
    expect(JSON.parse(stdout).workItem.startOn).toBe(START_ON_UTC);
  });

  it('defaults startOn to createdAt when the flag is omitted', async () => {
    const created = await createJson();
    expect(created.workItem.startOn).toBe(created.workItem.createdAt);
  });

  it('treats --start-on "" as the createdAt default on create', async () => {
    const created = await createJson('--start-on ""');
    expect(created.workItem.startOn).toBe(created.workItem.createdAt);
  });

  it('rejects a bare date with an actionable message and writes nothing', async () => {
    const failure = await execAsync(
      `tsx ${cliPath} --json create -t "Bare date item" --start-on 2099-11-19`,
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

    // Nothing was written: the store holds no items at all.
    const { stdout } = await execAsync(`tsx ${cliPath} --json list`);
    expect(JSON.parse(stdout).count).toBe(0);
  });

  it('rejects an unparseable value and writes nothing', async () => {
    const failure = await execAsync(
      `tsx ${cliPath} --json create -t "Bad instant item" --start-on not-an-instant`,
    ).then(
      () => null,
      (err: any) => err,
    );
    expect(failure).not.toBeNull();
    const text = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    expect(text).toContain('not-an-instant');

    const { stdout } = await execAsync(`tsx ${cliPath} --json list`);
    expect(JSON.parse(stdout).count).toBe(0);
  });

  it('shows a not-yet-started item by id, with startOn in the output', async () => {
    const created = await createJson(`--start-on ${START_ON_OFFSET}`);

    // JSON surface: retrievable by id and the field is present.
    const json = JSON.parse((await execAsync(`tsx ${cliPath} --json show ${created.id}`)).stdout);
    expect(json.success).toBe(true);
    expect(json.workItem.id).toBe(created.id);
    expect(json.workItem.startOn).toBe(START_ON_UTC);

    // Human surface: the scheduled instant is visible in the metadata.
    const human = await execAsync(`tsx ${cliPath} show ${created.id}`);
    expect(human.stdout).toContain(START_ON_UTC);
  });

  it('documents the flag, its ISO-8601 offset and clear forms in --help', async () => {
    const { stdout } = await execAsync(`tsx ${cliPath} create --help`);
    expect(stdout).toContain('--start-on');
    expect(stdout.toLowerCase()).toContain('iso-8601');
    expect(stdout).toContain('+01:00');
    expect(stdout).toContain('createdAt');
    // The clear form is described.
    expect(stdout).toContain('""');
  });
});
