/**
 * `startOn` in every CLI JSON surface (WL-0MWMGEPY2004EDZ8, parent
 * WL-0MWM0FDZK007BAD0, AC1).
 *
 * AC1 lists the surfaces a consumer can read an item from: `show`, `list`,
 * `search`, `next`, `recent`, `in_progress` and the dependency listings. Each
 * is asserted through the real CLI (`--json`) rather than through `db.getAll()`,
 * because the risk this test covers is a *projection* that drops the field —
 * `search` and `dep list` both emit a narrow hand-built payload, and a shared
 * store change would not touch them.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  cliPath,
  execAsync,
  enterTempDir,
  leaveTempDir,
  writeConfig,
  writeInitSemaphore,
  seedWorkItems,
} from './cli-helpers.js';

/** A scheduling instant far enough in the future to be unambiguous. */
const SCHEDULED = '2026-11-19T10:25:00.000Z';

describe('startOn JSON surfaces', () => {
  let state: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    state = enterTempDir();
    writeConfig(state.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(state.tempDir);
    seedWorkItems(state.tempDir, [
      {
        id: 'TEST-SCHEDULED',
        title: 'Scheduled refresh item',
        description: 'scheduling token refresh',
        status: 'open',
        startOn: SCHEDULED,
      },
      {
        id: 'TEST-DEFAULT',
        title: 'Unscheduled refresh item',
        description: 'scheduling token refresh',
        status: 'open',
      },
    ]);
  });

  afterEach(() => {
    leaveTempDir(state);
  });

  /** Run a CLI command and parse its JSON payload. */
  async function runJson(command: string): Promise<any> {
    const { stdout } = await execAsync(`tsx ${cliPath} --json ${command}`);
    return JSON.parse(stdout);
  }

  it('show returns startOn on the work item', async () => {
    const payload = await runJson('show TEST-SCHEDULED');

    expect(payload.success).toBe(true);
    expect(payload.workItem.startOn).toBe(SCHEDULED);
  });

  it('list returns startOn for every item, defaulting to createdAt', async () => {
    // `--include-not-started`: the scheduled fixture row is deliberately in the
    // future, which every search surface hides by default
    // (WL-0MWMGET8N009KG33). The projection contract is what this asserts.
    const payload = await runJson('list --include-not-started');

    const scheduled = payload.workItems.find((item: any) => item.id === 'TEST-SCHEDULED');
    const defaulted = payload.workItems.find((item: any) => item.id === 'TEST-DEFAULT');
    expect(scheduled.startOn).toBe(SCHEDULED);
    expect(defaulted.startOn).toBe(defaulted.createdAt);
  });

  it('search returns startOn in its default projection', async () => {
    // `--rebuild-index` guarantees the search actually matches the seeded rows
    // (the JSONL fixture import bypasses the FTS triggers). It emits its own
    // JSON payload, so the rebuild runs first and the search is then read.
    await execAsync(`tsx ${cliPath} --json search --rebuild-index`);
    // `--include-not-started`: the scheduled row is in the future and is hidden
    // by default (WL-0MWMGET8N009KG33); the projection is what this asserts.
    const payload = await runJson('search refresh --include-not-started');

    expect(payload.count).toBeGreaterThan(0);
    const scheduled = payload.workItems.find((item: any) => item.id === 'TEST-SCHEDULED');
    expect(scheduled.startOn).toBe(SCHEDULED);
  });

  it('next returns startOn on the selected item', async () => {
    const payload = await runJson('next');

    expect(payload.workItem).not.toBeNull();
    expect(payload.workItem.startOn).toBeDefined();
  });

  it('recent returns startOn for every item', async () => {
    const payload = await runJson('recent');

    expect(payload.workItems.length).toBeGreaterThan(0);
    for (const item of payload.workItems) {
      expect(item.startOn).toBeDefined();
    }
  });

  it('in_progress returns startOn for every item', async () => {
    // `in_progress` never hides a started item; the scheduling field must still
    // be visible on whatever it returns (possibly nothing), so assert on the
    // projection contract rather than on a non-empty set.
    const payload = await runJson('update TEST-DEFAULT --status in-progress');
    expect(payload.success).toBe(true);
    const inProgress = await runJson('in-progress');

    expect(inProgress.count).toBeGreaterThan(0);
    for (const item of inProgress.workItems) {
      expect(item.startOn).toBeDefined();
    }
  });

  it('dependency listings carry startOn on both edges', async () => {
    await runJson('dep add TEST-DEFAULT TEST-SCHEDULED');

    const outbound = await runJson('dep list TEST-DEFAULT');
    const inbound = await runJson('dep list TEST-SCHEDULED');

    expect(outbound.outbound).toContainEqual(
      expect.objectContaining({ id: 'TEST-SCHEDULED', startOn: SCHEDULED }),
    );
    expect(inbound.inbound).toContainEqual(
      expect.objectContaining({ id: 'TEST-DEFAULT', startOn: expect.any(String) }),
    );
  });
});
