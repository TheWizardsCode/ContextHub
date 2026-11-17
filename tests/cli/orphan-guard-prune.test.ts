/**
 * R1 — hard-delete admin paths must not orphan children silently.
 *
 * Serves WL-0MWGRJCXO006A9ZV (fixture slice of WL-0MWFMKWZA005ZT4T) and pins
 * the AC1 / R1 contract implemented by the sibling slice
 * WL-0MWGRK52Z0078SJJ. The specs below are **RED-pinned with
 * `it.fails(...)`** by this test-first child: their assertions fail on
 * current main (proved in the raw red run — `refusedIds`/`protectedIds`
 * undefined, `--cascade-children` rejected as unknown) while the suite stays
 * green for the finish and dev-push gates. WL-0MWGRK52Z0078SJJ must flip
 * `it.fails(` → `it(` on all four specs as the guard lands (repo convention,
 * cf. tests/cli/doctor-prefix.test.ts).
 *
 * ## Contract pinned here
 *
 * `wl doctor prune` (soft-deleted items older than `--days`):
 *   - Default: a candidate that still has **live children** is refused. It is
 *     reported in a new `refusedIds` array, is NOT in `prunedIds`, stays in
 *     the database, and its children keep a resolvable `parentId`.
 *   - `--cascade-children` (explicit opt-in): the candidate IS pruned and its
 *     descendants are hard-deleted with it — no live child is left pointing
 *     at a vanished parent.
 *
 * `wl doctor foreign-items --apply`:
 *   - Default: a foreign id that an **own-prefix child** references is
 *     protected. It is reported in a new `protectedIds` array, is NOT in
 *     `removedIds`, stays in the database, and the own child keeps a
 *     resolvable `parentId`.
 *   - `--cascade-children` (explicit opt-in): the foreign id IS removed and
 *     its own-prefix children are hard-deleted with it.
 *
 * On current main `refusedIds`/`protectedIds` do not exist and every
 * candidate is hard-deleted regardless of live children, so every assertion
 * below fails (or the `--cascade-children` flag is rejected as unknown).
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
import {
  seedPruneParentWithLiveChildren,
  seedForeignParentWithOwnChild,
  PRUNE_PARENT_WITH_CHILDREN,
  FOREIGN_PARENT_WITH_OWN_CHILD,
} from '../fixtures/orphan-guard.js';

describe('orphan-guard: hard-delete admin paths (R1)', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  async function allIds(extra = ''): Promise<string[]> {
    const { stdout } = await execAsync(`tsx ${cliPath} --json list ${extra}`);
    const parsed = JSON.parse(stdout);
    return (parsed.workItems ?? []).map((i: { id: string }) => i.id);
  }

  // ── wl doctor prune ─────────────────────────────────────────────────────

  it.fails('prune refuses to hard-delete a parent with live children (default)', async () => {
    const { parent, children } = PRUNE_PARENT_WITH_CHILDREN;
    seedPruneParentWithLiveChildren(tempState.tempDir);

    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor prune --days 30`);
    const result = JSON.parse(stdout);

    // The parent is refused, not pruned: it survives in the database.
    expect(result.refusedIds).toContain(parent);
    expect(result.prunedIds).not.toContain(parent);

    // The parent still resolves — its live children are not orphans.
    expect(await allIds('--deleted')).toContain(parent);
    const liveIds = await allIds();
    expect(liveIds).toEqual(expect.arrayContaining(children));
    for (const childId of children) {
      const { stdout: showOut } = await execAsync(`tsx ${cliPath} --json show ${childId}`);
      expect(JSON.parse(showOut).workItem.parentId).toBe(parent);
    }
  });

  it.fails('prune --cascade-children hard-deletes the parent AND its live children (explicit opt-in)', async () => {
    const { parent, children } = PRUNE_PARENT_WITH_CHILDREN;
    seedPruneParentWithLiveChildren(tempState.tempDir);

    const { stdout } = await execAsync(
      `tsx ${cliPath} --json doctor prune --days 30 --cascade-children`,
    );
    const result = JSON.parse(stdout);

    expect(result.prunedIds).toContain(parent);
    // Hard delete: neither the parent nor its children remain — not even
    // under `--deleted`, because the rows are physically removed.
    const remaining = await allIds('--deleted');
    expect(remaining).not.toContain(parent);
    for (const childId of children) {
      expect(remaining).not.toContain(childId);
    }
  });

  // ── wl doctor foreign-items --apply ────────────────────────────────────

  it.fails('foreign-items --apply protects a foreign parent referenced by an own child (default)', async () => {
    const { foreignParent, ownChild, plainForeign, plainOwn } = FOREIGN_PARENT_WITH_OWN_CHILD;
    seedForeignParentWithOwnChild(tempState.tempDir);

    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor foreign-items --apply`);
    const result = JSON.parse(stdout);

    // The foreign parent is protected (not removed); the un-referenced
    // foreign item is still cleaned up.
    expect(result.protectedIds).toContain(foreignParent);
    expect(result.removedIds).not.toContain(foreignParent);
    expect(result.removedIds).toContain(plainForeign);

    // The own child keeps a resolvable parent.
    const remaining = await allIds('--deleted');
    expect(remaining).toContain(foreignParent);
    expect(remaining).toContain(ownChild);
    expect(remaining).toContain(plainOwn);
    const { stdout: showOut } = await execAsync(`tsx ${cliPath} --json show ${ownChild}`);
    expect(JSON.parse(showOut).workItem.parentId).toBe(foreignParent);
  });

  it.fails('foreign-items --apply --cascade-children removes the foreign parent and its own child (explicit opt-in)', async () => {
    const { foreignParent, ownChild, plainForeign, plainOwn } = FOREIGN_PARENT_WITH_OWN_CHILD;
    seedForeignParentWithOwnChild(tempState.tempDir);

    const { stdout } = await execAsync(
      `tsx ${cliPath} --json doctor foreign-items --apply --cascade-children`,
    );
    const result = JSON.parse(stdout);

    expect(result.removedIds).toContain(foreignParent);
    expect(result.removedIds).toContain(plainForeign);

    // The cascaded own child is hard-deleted with its foreign parent; the
    // unrelated own item survives.
    const remaining = await allIds('--deleted');
    expect(remaining).not.toContain(foreignParent);
    expect(remaining).not.toContain(ownChild);
    expect(remaining).toContain(plainOwn);
  });
});
