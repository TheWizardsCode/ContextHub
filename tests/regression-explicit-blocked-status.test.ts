/**
 * Regression test: an explicit `wl update <id> --status blocked` must persist
 * `blocked` (stored/reported agreement).
 *
 * Parent: WL-0MVTUKSJZ003WK82 — `wl update --status blocked` silently reverts
 * to `open` and still reports success. This file is the deterministic
 * reproduction (AC1) that lands **before** the fix task.
 *
 * ## What goes wrong today
 *
 * For an item with only an **inbound** dependency edge (other items depend on
 * it; it depends on nothing), `db.update` writes the requested `blocked`
 * status and then calls `hooks.reconcileDependentStatus(id)`
 * (`packages/shared/src/database/work-items.ts`). That reconciliation rewrites
 * `blocked` -> `open` whenever the item has no **active outbound blockers**
 * (`packages/shared/src/database/dependencies.ts`). The update returns the
 * **pre-reconcile** snapshot, so `wl update --json` reports
 * `workItem.status: "blocked"` while the store holds `open` with a later
 * `updatedAt`. The distinguishing feature of the affected item — an inbound
 * edge only, no outbound edges — is exactly the condition that triggers the
 * silent unblock.
 *
 * ## RED-pinned
 *
 * This spec asserts the FIXED behaviour (persisted status is `blocked` and the
 * JSON-reported status equals the persisted status), so its body fails against
 * the current tree. It is wrapped in `it.fails(...)` so the gated suite stays
 * green while the defect is open — the same RED-witness convention used by
 * `tests/cli/reviewed.test.ts` and the herdr RED witnesses. The fix task flips
 * `it.fails(` -> `it(` once the reconcile guard lands; the RED->GREEN
 * transition is the evidence the reproduction tracked a real defect.
 *
 * No production code is changed by this task (AC4).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  cliPath,
  execAsync,
  writeConfig,
  writeInitSemaphore,
} from './cli/cli-helpers.js';
import { createTempDir, cleanupTempDir } from './test-utils.js';

describe('explicit --status blocked persists (WL-0MVTVYNY4001EBRX)', () => {
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

  // RED-pinned with `it.fails(` — see the file header. The fix task flips it
  // to `it(`.
  it.fails(
    'RED: persists an explicit --status blocked write on an item with only an inbound edge',
    async () => {
      // The affected item (open, stage `idea`) and a second item that depends
      // on it. `dep add <itemId> <dependsOnId>` means "itemId depends on
      // dependsOnId", so `dep add other item` gives `item` an INBOUND edge
      // only — the exact condition that mis-fires the reconcile.
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

      // The command reports success and `blocked` today (the "still reports
      // success" half of the defect) — this documents that the report is
      // misleading rather than broken.
      expect(updateJson.workItem.status).toBe('blocked');
      const reportedStatus: string = updateJson.workItem.status;

      // Re-read the persisted record through the store.
      const { stdout: showOut } = await execAsync(
        `tsx ${cliPath} --json show ${item}`,
        { cwd: tempDir },
      );
      const persistedStatus: string = JSON.parse(showOut).workItem.status;

      // AC1: the explicit blocked write must persist. Fails today — the store
      // holds `open` after the post-write reconcile rewrote it.
      expect(persistedStatus).toBe('blocked');

      // AC2: the JSON-reported status must agree with the persisted status.
      // Fails today — reported `blocked` vs persisted `open`.
      expect(reportedStatus).toBe(persistedStatus);
    },
  );
});
