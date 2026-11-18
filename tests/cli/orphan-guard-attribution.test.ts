/**
 * R2 — attribution: every path that orphans or promotes a child must record a
 * comment naming the previous parent and the explicit decision/rationale.
 *
 * Serves WL-0MWGRJCXO006A9ZV (fixture slice of WL-0MWFMKWZA005ZT4T) and pins
 * the AC2 / AC4 / R2 contract implemented by the sibling slice
 * WL-0MWGRKYG0006N2A8. The specs below were **RED-pinned with `it.fails(...)`**
 * by this test-first child: their assertions failed on current main (proved in
 * the raw red run — no comment was written on any of the four paths) while the
 * suite stayed green for the finish and dev-push gates. WL-0MWGRKYG0006N2A8
 * flipped `it.fails(` → `it(` on all four specs as the attribution landed
 * (repo convention, cf. tests/cli/doctor-prefix.test.ts).
 *
 * ## Contract pinned here
 *
 * `wl delete <parent> --no-recursive` (explicit orphaning opt-in, AC2):
 *   - every remaining live child receives a comment naming the previous
 *     parent id and the explicit decision (text containing the parent id and
 *     an `orphan`/explicit token).
 *
 * Promotion (`parentId -> null`, AC4) — all three paths:
 *   - `wl update <child> --parent null`
 *   - `wl doctor dangling-parents --apply`
 *   - `wl doctor --fix`
 *   - each records a comment on the child naming the previous parent id and
 *     the rationale token from the retention rule (AC5):
 *     `promote-because-live` | `retire-because-stale`.
 *
 * The detach itself (`parentId: null`) already ships (WL-0MUJM2LV1000IHKR);
 * the comment is the missing piece. On current main no comment is written on
 * any of these paths, so every `comments.some(...)` assertion below fails.
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
  seedNoRecursiveOrphan,
  seedPromotion,
  seedDangling,
  NO_RECURSIVE_ORPHAN,
  PROMOTION,
  DANGLING,
} from '../fixtures/orphan-guard.js';

describe('orphan-guard: attribution comments (R2)', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  /** Fetch the child's comments via `wl show --json` (array, newest-last). */
  async function commentsOf(id: string): Promise<Array<{ comment: string }>> {
    const { stdout } = await execAsync(`tsx ${cliPath} --json show ${id}`);
    const parsed = JSON.parse(stdout);
    return (parsed.comments ?? []) as Array<{ comment: string }>;
  }

  /** Match the retention-rule rationale tokens (AC5). */
  const rationale = /promote-because-live|retire-because-stale/;

  // ── Explicit orphaning: wl delete --no-recursive (AC2) ─────────────────

  it('wl delete --no-recursive comments each orphaned child naming the previous parent', async () => {
    const { parent, children } = NO_RECURSIVE_ORPHAN;
    seedNoRecursiveOrphan(tempState.tempDir);

    const { stdout } = await execAsync(
      `tsx ${cliPath} --json delete ${parent} --no-recursive --reason "explicit orphaning" --no-sync`,
    );
    expect(JSON.parse(stdout).success).toBe(true);

    for (const childId of children) {
      const comments = await commentsOf(childId);
      expect(comments.some((c) => c.comment.includes(parent))).toBe(true);
      expect(comments.some((c) => /orphan|explicit/i.test(c.comment))).toBe(true);
    }
  });

  // ── Promotion paths (AC4) ──────────────────────────────────────────────

  it('wl update --parent null records a comment naming the previous parent and rationale', async () => {
    const { parent, child } = PROMOTION;
    seedPromotion(tempState.tempDir);

    const { stdout } = await execAsync(`tsx ${cliPath} --json update ${child} --parent null`);
    expect(JSON.parse(stdout).success).toBe(true);

    const { stdout: showOut } = await execAsync(`tsx ${cliPath} --json show ${child}`);
    const item = JSON.parse(showOut).workItem;
    expect(item.parentId).toBeNull();

    const comments = await commentsOf(child);
    expect(comments.some((c) => c.comment.includes(parent))).toBe(true);
    expect(comments.some((c) => rationale.test(c.comment))).toBe(true);
  });

  it('wl doctor dangling-parents --apply records a comment naming the previous parent and rationale', async () => {
    const { parentId, child } = DANGLING;
    seedDangling(tempState.tempDir);

    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor dangling-parents --apply`);
    expect(JSON.parse(stdout).success).toBe(true);

    const { stdout: showOut } = await execAsync(`tsx ${cliPath} --json show ${child}`);
    expect(JSON.parse(showOut).workItem.parentId).toBeNull();

    const comments = await commentsOf(child);
    expect(comments.some((c) => c.comment.includes(parentId))).toBe(true);
    expect(comments.some((c) => rationale.test(c.comment))).toBe(true);
  });

  it('wl doctor --fix records a comment naming the previous parent and rationale on detach', async () => {
    const { parentId, child } = DANGLING;
    seedDangling(tempState.tempDir);

    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor --fix`);
    expect(Array.isArray(JSON.parse(stdout))).toBe(true);

    const { stdout: showOut } = await execAsync(`tsx ${cliPath} --json show ${child}`);
    expect(JSON.parse(showOut).workItem.parentId).toBeNull();

    const comments = await commentsOf(child);
    expect(comments.some((c) => c.comment.includes(parentId))).toBe(true);
    expect(comments.some((c) => rationale.test(c.comment))).toBe(true);
  });
});
