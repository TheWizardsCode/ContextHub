/**
 * Regression tests: an explicit `wl update <id> --status <s>` write must win
 * over the derived (`blocked`/`open`) reconciliation.
 *
 * Parent: WL-0MVTUKSJZ003WK82 — `wl update --status blocked` silently reverts
 * to `open` and still reports success.
 *
 * ## The defect
 *
 * For an item with only an **inbound** dependency edge (other items depend on
 * it; it depends on nothing), `db.update` wrote the requested `blocked` status
 * and then called `hooks.reconcileDependentStatus(id)`
 * (`packages/shared/src/database/work-items.ts`). That reconciliation rewrites
 * `blocked` -> `open` whenever the item has no **active outbound blockers**
 * (`packages/shared/src/database/dependencies.ts`). The update returned the
 * **pre-reconcile** snapshot, so `wl update --json` reported
 * `workItem.status: "blocked"` while the store held `open` with a later
 * `updatedAt`.
 *
 * ## The fix (WL-0MVTVYXZD002NDMP)
 *
 * `db.update` / `db.updateIfMatches` accept an `UpdateOptions` with
 * `reconcileSelf`; `wl update` passes `reconcileSelf: false` when the caller
 * supplied an explicit `--status`/`--stage`, so the explicit write is never
 * self-reconciled. Reconciliation of **dependent** items is unchanged, as are
 * the `wl dep add` / `wl dep rm` paths. `db.update` now returns the
 * **persisted post-reconcile** record, so the CLI reports the stored value.
 *
 * The first test below was landed RED-pinned (`it.fails`) by the reproduction
 * task WL-0MVTVYNY4001EBRX; it is now plain `it(` — the RED->GREEN transition
 * is the evidence the reproduction tracked a real defect.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import {
  cliPath,
  execAsync,
  writeConfig,
  writeInitSemaphore,
} from './cli/cli-helpers.js';
import {
  createTempDir,
  cleanupTempDir,
  createTempDbPath,
  createTempJsonlPath,
} from './test-utils.js';
import { WorklogDatabase } from '../packages/shared/src/database.js';

describe('explicit --status writes win over derived reconcile (WL-0MVTVYXZD002NDMP)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    writeConfig(tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempDir);
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  /** Create an item via the real CLI and return its id. */
  async function createItem(title: string): Promise<string> {
    const { stdout } = await execAsync(
      `tsx ${cliPath} --json create -t "${title}"`,
      { cwd: tempDir },
    );
    return JSON.parse(stdout).workItem.id as string;
  }

  /** Read the persisted record through the store (not the update payload). */
  async function persistedStatus(id: string): Promise<string> {
    const { stdout } = await execAsync(
      `tsx ${cliPath} --json show ${id}`,
      { cwd: tempDir },
    );
    return JSON.parse(stdout).workItem.status as string;
  }

  it('persists an explicit --status blocked write on an item with only an inbound edge', async () => {
    // The affected item (open) and a second item that depends on it.
    // `dep add <itemId> <dependsOnId>` means "itemId depends on dependsOnId",
    // so `dep add other item` gives `item` an INBOUND edge only — the exact
    // condition that mis-fired the reconcile.
    const item = await createItem('Item to block');
    const other = await createItem('Dependent');

    await execAsync(
      `tsx ${cliPath} --json dep add ${other} ${item}`,
      { cwd: tempDir },
    );

    // The exact user-facing reproduction: an explicit status write.
    const { stdout: updateOut } = await execAsync(
      `tsx ${cliPath} --json update ${item} --status blocked`,
      { cwd: tempDir },
    );
    const updateJson = JSON.parse(updateOut);
    expect(updateJson.success).toBe(true);
    expect(updateJson.workItem.status).toBe('blocked');
    const reportedStatus: string = updateJson.workItem.status;

    // The explicit blocked write must persist — no post-write reconcile may
    // rewrite it to `open`.
    const storedStatus = await persistedStatus(item);
    expect(storedStatus).toBe('blocked');

    // The JSON payload must agree with the persisted record (AC4).
    expect(reportedStatus).toBe(storedStatus);
  });

  it('persists an explicit --status blocked write on an item with no dependency edges', async () => {
    const item = await createItem('Standalone item');

    const { stdout } = await execAsync(
      `tsx ${cliPath} --json update ${item} --status blocked`,
      { cwd: tempDir },
    );
    expect(JSON.parse(stdout).workItem.status).toBe('blocked');

    expect(await persistedStatus(item)).toBe('blocked');
  });

  it('persists an explicit --status blocked write on an item with an active outbound blocker', async () => {
    // Dependency-derived semantics are unchanged: `dep add` blocks the item
    // that depends on a non-terminal blocker.
    const blocker = await createItem('Active blocker');
    const item = await createItem('Blocked item');
    await execAsync(
      `tsx ${cliPath} --json dep add ${item} ${blocker}`,
      { cwd: tempDir },
    );
    expect(await persistedStatus(item)).toBe('blocked');

    // Re-asserting `blocked` explicitly must keep it blocked.
    const { stdout } = await execAsync(
      `tsx ${cliPath} --json update ${item} --status blocked`,
      { cwd: tempDir },
    );
    expect(JSON.parse(stdout).workItem.status).toBe('blocked');
    expect(await persistedStatus(item)).toBe('blocked');
  });

  it('does not let the self-reconcile overwrite an explicit --status open', async () => {
    // An explicit status write is authoritative even when the item still has
    // an active outbound blocker; only dependency-derived paths (`dep add`,
    // `dep rm`, blocker completion) derive `blocked`/`open`.
    const blocker = await createItem('Active blocker');
    const item = await createItem('Blocked item');
    await execAsync(
      `tsx ${cliPath} --json dep add ${item} ${blocker}`,
      { cwd: tempDir },
    );
    expect(await persistedStatus(item)).toBe('blocked');

    const { stdout } = await execAsync(
      `tsx ${cliPath} --json update ${item} --status open`,
      { cwd: tempDir },
    );
    expect(JSON.parse(stdout).workItem.status).toBe('open');
    expect(await persistedStatus(item)).toBe('open');
  });

  it('keeps dependency-derived reconciliation: dep rm unblocks when no active blockers remain', async () => {
    const blocker = await createItem('Blocker');
    const item = await createItem('Blocked item');
    await execAsync(
      `tsx ${cliPath} --json dep add ${item} ${blocker}`,
      { cwd: tempDir },
    );
    expect(await persistedStatus(item)).toBe('blocked');

    await execAsync(
      `tsx ${cliPath} --json dep rm ${item} ${blocker}`,
      { cwd: tempDir },
    );
    expect(await persistedStatus(item)).toBe('open');
  });
});

describe('db.update reports the persisted post-reconcile record (WL-0MVTVYXZD002NDMP)', () => {
  let tempDir: string;
  let dbPath: string;
  let jsonlPath: string;
  let db: WorklogDatabase;

  beforeEach(() => {
    tempDir = createTempDir();
    dbPath = createTempDbPath(tempDir);
    jsonlPath = createTempJsonlPath(tempDir);
    if (fs.existsSync(jsonlPath)) {
      fs.unlinkSync(jsonlPath);
    }
    db = new WorklogDatabase('TEST', dbPath, jsonlPath, true, true);
  });

  afterEach(() => {
    db.close();
    cleanupTempDir(tempDir);
  });

  it('returns the persisted status when derived reconciliation overrides the write', () => {
    const blocker = db.create({ title: 'Blocker', status: 'open' });
    const item = db.create({ title: 'Item', status: 'blocked' });
    db.addDependencyEdge(item.id, blocker.id);

    // Derived reconciliation re-blocks an item that still has an active
    // blocker — the return value must be that persisted record, not the
    // in-memory pre-reconcile snapshot (AC4).
    const updated = db.update(item.id, { status: 'in-progress' });
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('blocked');
    expect(updated!.status).toBe(db.get(item.id)!.status);
  });

  it('persists and returns an explicit status when reconcileSelf is false', () => {
    const blocker = db.create({ title: 'Blocker', status: 'open' });
    const item = db.create({ title: 'Item', status: 'blocked' });
    db.addDependencyEdge(item.id, blocker.id);

    const updated = db.update(item.id, { status: 'in-progress' }, { reconcileSelf: false });
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('in-progress');
    expect(db.get(item.id)!.status).toBe('in-progress');
  });

  it('keeps derived self-reconciliation as the default (no explicit-status signal)', () => {
    const blocker = db.create({ title: 'Blocker', status: 'open' });
    const item = db.create({ title: 'Item', status: 'blocked' });
    db.addDependencyEdge(item.id, blocker.id);

    db.reconcileDependentStatus(item.id);
    expect(db.get(item.id)!.status).toBe('blocked');

    // Without the reconcileSelf opt-out the item is re-derived from its
    // edges, so `dep add`/`dep rm` semantics (which rely on it) are intact.
    db.update(item.id, { status: 'open' });
    expect(db.get(item.id)!.status).toBe('blocked');
  });
});
