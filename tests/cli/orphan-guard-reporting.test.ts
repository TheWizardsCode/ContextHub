/**
 * R3 / R3b — orphan reporting must name the lost parent and group by it,
 * including children of soft-deleted parents.
 *
 * Serves WL-0MWGRJCXO006A9ZV (fixture slice of WL-0MWFMKWZA005ZT4T) and pins
 * the AC3 / R3 / R3b contract implemented by the sibling slice
 * WL-0MWGRKLLG0035PLG. The specs below were **RED-pinned with
 * `it.fails(...)`** by the test-first child (their assertions failed on
 * current main — no finding for a soft-deleted parent's child, `groups`
 * undefined) while the suite stayed green for the finish and dev-push gates.
 * WL-0MWGRKLLG0035PLG flipped `it.fails(` → `it(` on both specs as the
 * reporting landed (repo convention, cf. tests/cli/doctor-prefix.test.ts);
 * the shipped-shape pin below stayed plain `it` throughout.
 *
 * ## Contract pinned here
 *
 * Root `wl doctor` (validate):
 *   - Children of a **soft-deleted** parent produce a `missing-parent`
 *     finding (R3b). Today `validateParentReferences` resolves `parentId`
 *     against `db.getAll()` — which includes soft-deleted rows — so no
 *     finding is emitted.
 *   - The shipped per-child finding shape (`checkId: 'parent.missing-endpoint'`,
 *     `type: 'missing-parent'`, `itemId` = child, `context.parentId` = lost
 *     parent) is pinned for the hard-deleted-parent case so the reporting
 *     contract cannot regress while R3 lands.
 *
 * `wl doctor dangling-parents --dry-run`:
 *   - Adds a grouped summary `groups: Array<{ parentId, count, childIds }>`
 *     keyed by lost-parent id (R3), covering BOTH hard-missing and
 *     soft-deleted parents (R3b).
 *
 * On current main `groups` does not exist and soft-deleted parents are
 * treated as resolvable, so the assertions below fail.
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
  seedHardMissingParentWithLiveChildren,
  seedSoftDeletedParentWithLiveChildren,
  seedGroupedOrphanReportingScenarios,
  HARD_MISSING_PARENT,
  SOFT_DELETED_PARENT,
} from '../fixtures/orphan-guard.js';

describe('orphan-guard: grouped orphan reporting (R3/R3b)', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  // ── Root wl doctor (validate) ───────────────────────────────────────────

  it('wl doctor reports children of a soft-deleted parent (R3b)', async () => {
    const { parent, child } = SOFT_DELETED_PARENT;
    seedSoftDeletedParentWithLiveChildren(tempState.tempDir);

    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor`);
    const findings = JSON.parse(stdout);

    // One finding per child, naming both the child and the lost parent.
    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: 'parent.missing-endpoint',
        type: 'missing-parent',
        itemId: child,
        context: expect.objectContaining({ parentId: parent }),
      }),
    );
  });

  it('wl doctor still names the lost parent id and each child id for a hard-deleted parent (shipped shape pinned)', async () => {
    const { parentId, children } = HARD_MISSING_PARENT;
    seedHardMissingParentWithLiveChildren(tempState.tempDir);

    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor`);
    const findings = JSON.parse(stdout);

    for (const childId of children) {
      expect(findings).toContainEqual(
        expect.objectContaining({
          checkId: 'parent.missing-endpoint',
          type: 'missing-parent',
          itemId: childId,
          context: expect.objectContaining({ parentId }),
        }),
      );
    }
  });

  // ── wl doctor dangling-parents --dry-run ───────────────────────────────

  it('dangling-parents --dry-run groups children per lost parent, hard-missing and soft-deleted alike (R3/R3b)', async () => {
    const { parentId, children } = HARD_MISSING_PARENT;
    const softParent = SOFT_DELETED_PARENT;
    // One store holding both shapes so the grouping is exercised together.
    seedGroupedOrphanReportingScenarios(tempState.tempDir);

    const { stdout } = await execAsync(
      `tsx ${cliPath} --json doctor dangling-parents --dry-run`,
    );
    const result = JSON.parse(stdout);

    expect(result.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          parentId,
          count: children.length,
          childIds: expect.arrayContaining(children),
        }),
        expect.objectContaining({
          parentId: softParent.parent,
          count: 1,
          childIds: [softParent.child],
        }),
      ]),
    );
    // The soft-deleted-parent child is reported at all (R3b).
    expect(result.items.map((item: { id: string }) => item.id)).toContain(softParent.child);
  });
});
