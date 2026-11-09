/**
 * `wl list --stage in_review -F concise` respects the 6-bucket priority order
 * (WL-0MUWDW0N6003KF6G).
 *
 * The concise/tree renderer previously re-sorted its input by database
 * position (`sortIndex`), silently discarding the in_review bucket order that
 * `list.ts` had already computed. With items created medium→high→low the
 * position order put the medium first; the fix threads `preserveOrder` so the
 * renderer keeps the caller's order (high → medium → low within a bucket).
 *
 * End-to-end in-process CLI test against a temporary worklog.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { runInProcess } from './cli-inproc.js';
import { writeConfig, writeInitSemaphore, cliPath } from './cli-helpers.js';
import { createTempDir, cleanupTempDir } from '../test-utils.js';

describe('wl list --stage in_review -F concise ordering (WL-0MUWDW0N6003KF6G)', () => {
  let tempDir: string;
  let wlDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = createTempDir();
    writeConfig(tempDir, 'Concise Order Project', 'CO');
    writeInitSemaphore(tempDir);
    wlDir = path.join(tempDir, '.worklog');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    cleanupTempDir(tempDir);
  });

  async function createInReview(title: string, priority: string): Promise<string> {
    const createRes = await runInProcess(
      `tsx ${cliPath} --json --worklog-dir ${wlDir} create -t "${title}" --priority ${priority}`,
    );
    const created = JSON.parse(createRes.stdout);
    expect(created.success).toBe(true);
    const id = created.workItem.id as string;
    const updateRes = await runInProcess(
      `tsx ${cliPath} --json --worklog-dir ${wlDir} update ${id} --stage in_review --status completed`,
    );
    expect(JSON.parse(updateRes.stdout).success).toBe(true);
    return id;
  }

  it('renders high before medium before low, overriding the position re-sort', async () => {
    // Creation order (medium → high → low) deliberately disagrees with the
    // priority order so the position-based re-sort would show the medium first.
    const mediumId = await createInReview('Medium item', 'medium');
    const highId = await createInReview('High item', 'high');
    const lowId = await createInReview('Low item', 'low');

    const res = await runInProcess(
      `tsx ${cliPath} --worklog-dir ${wlDir} list --stage in_review -F concise --no-icons`,
    );

    const highPos = res.stdout.indexOf(highId);
    const mediumPos = res.stdout.indexOf(mediumId);
    const lowPos = res.stdout.indexOf(lowId);
    expect(highPos).toBeGreaterThanOrEqual(0);
    expect(mediumPos).toBeGreaterThanOrEqual(0);
    expect(lowPos).toBeGreaterThanOrEqual(0);
    expect(highPos).toBeLessThan(mediumPos);
    expect(mediumPos).toBeLessThan(lowPos);
  });

  it('ranks a high no-audit item before a medium item with a failed audit (WL-0MUWDW0N6003KF6G)', async () => {
    // Producer-reported symptom: the audit bucket was the primary sort key,
    // so a medium-priority item with a failed audit ranked ahead of a
    // high-priority item with no audit. Priority must dominate.
    const highId = await createInReview('High no audit', 'high');
    const mediumFailedId = await createInReview('Medium failed audit', 'medium');
    const mediumNoAuditId = await createInReview('Medium no audit', 'medium');

    const auditRes = await runInProcess(
      `tsx ${cliPath} --json --worklog-dir ${wlDir} audit-set ${mediumFailedId} --ready-to-close no --summary "Rejected by test"`,
    );
    expect(JSON.parse(auditRes.stdout).success).toBe(true);

    // `audit-set --ready-to-close no` reverts an in_review item to
    // open/plan_complete (WL-0MSKHYI5U0069FVV); real rejected items such as
    // WL-0MV1BWETT005GSUJ remain completed/in_review with a stored failed
    // audit. Re-advance it so the list sees the same state.
    const reAdvance = await runInProcess(
      `tsx ${cliPath} --json --worklog-dir ${wlDir} update ${mediumFailedId} --stage in_review --status completed`,
    );
    expect(JSON.parse(reAdvance.stdout).success).toBe(true);

    const res = await runInProcess(
      `tsx ${cliPath} --worklog-dir ${wlDir} list --stage in_review -F concise --no-icons`,
    );

    const highPos = res.stdout.indexOf(highId);
    const mediumFailedPos = res.stdout.indexOf(mediumFailedId);
    const mediumNoAuditPos = res.stdout.indexOf(mediumNoAuditId);
    expect(highPos).toBeGreaterThanOrEqual(0);
    expect(mediumFailedPos).toBeGreaterThanOrEqual(0);
    expect(mediumNoAuditPos).toBeGreaterThanOrEqual(0);
    expect(highPos).toBeLessThan(mediumFailedPos);
    expect(mediumFailedPos).toBeLessThan(mediumNoAuditPos);
  });

  // ── WL-0MW7S20IC001F3AP: soft-delete predicate consistency ───────────
  //
  // The bug: `wl list` excluded only `status === 'deleted'` while `wl update`
  // rejected any non-empty `deletedBy`. A repaired row (live status,
  // `deletedBy` retained) was therefore *visible but immutable* — the release
  // gate's `wl update --status in_progress` failed with `deleted-item` on a
  // row `wl list --stage in_review` returned.
  //
  // These assertions pin the FIXED behaviour. They are written test-first and
  // marked `it.fails` while the bug is live; the list read-path item
  // (WL-0MW8EU3IQ006XY1U) applies the shared predicate and flips them to `it`.
  describe('soft-deleted rows are excluded from --stage in_review (WL-0MW7S20IC001F3AP)', () => {
    /**
     * Seed the exact bug shape: a live (completed/in_review) row that retains a
     * non-empty `deletedBy`. This is producible through the CLI because the
     * soft-delete guard only blocks attribution changes on an *already*
     * soft-deleted row; attaching attribution to a still-live row is allowed.
     */
    async function createAttributedInReview(title: string): Promise<string> {
      const createRes = await runInProcess(
        `tsx ${cliPath} --json --worklog-dir ${wlDir} create -t "${title}"`,
      );
      const created = JSON.parse(createRes.stdout);
      expect(created.success).toBe(true);
      const id = created.workItem.id as string;
      const advance = await runInProcess(
        `tsx ${cliPath} --json --worklog-dir ${wlDir} update ${id} --stage in_review --status completed`,
      );
      expect(JSON.parse(advance.stdout).success).toBe(true);
      const attribute = await runInProcess(
        `tsx ${cliPath} --json --worklog-dir ${wlDir} update ${id} --deleted-by "repairer@example.com" --delete-reason "deletion intent retained"`,
      );
      expect(JSON.parse(attribute.stdout).success).toBe(true);
      return id;
    }

    async function listInReviewIds(): Promise<string[]> {
      const res = await runInProcess(
        `tsx ${cliPath} --json --worklog-dir ${wlDir} list --stage in_review`,
      );
      expect(res.exitCode).toBe(0);
      return JSON.parse(res.stdout).workItems.map((i: { id: string }) => i.id);
    }

    it(
      'does not return a completed/in_review row that retains a non-empty deletedBy (AC1)',
      async () => {
        const id = await createAttributedInReview('Attributed review row');
        expect(await listInReviewIds()).not.toContain(id);
      },
    );

    it(
      'never returns a row that wl update --status in_progress rejects as deleted-item (AC2)',
      async () => {
        const id = await createAttributedInReview('Attributed review row invariant');
        const listedIds = await listInReviewIds();

        const listed = listedIds.includes(id);
        let mutable = true;
        if (listed) {
          const upd = await runInProcess(
            `tsx ${cliPath} --json --worklog-dir ${wlDir} update ${id} --status in_progress`,
          );
          const parsed = JSON.parse(upd.stdout || upd.stderr);
          mutable = parsed.success === true && parsed.error !== 'deleted-item';
        }
        // A row must never be simultaneously visible and immutable.
        expect(listed && !mutable).toBe(false);
      },
    );

    it('still excludes status=deleted rows from --stage in_review (AC3, no regression)', async () => {
      const id = await createAttributedInReview('Row that will be hard-deleted');
      const del = await runInProcess(
        `tsx ${cliPath} --json --worklog-dir ${wlDir} delete ${id} --no-sync`,
      );
      // `wl delete` succeeded (or reported a non-fatal skip); status is now
      // 'deleted' and the row must stay out of the normal list.
      expect([0, null]).toContain(del.exitCode);
      expect(await listInReviewIds()).not.toContain(id);
    });

    it('--deleted still returns soft-deleted rows (status=deleted and live+deletedBy) (AC3)', async () => {
      // A live-but-attributed row (soft-deleted via deletedBy).
      const softDeletedId = await createAttributedInReview('Soft-deleted attributed row');
      // A hard-deleted row (status=deleted).
      const hardDeletedId = await createAttributedInReview('Hard-deleted row');
      const del = await runInProcess(
        `tsx ${cliPath} --json --worklog-dir ${wlDir} delete ${hardDeletedId} --no-sync`,
      );
      expect([0, null]).toContain(del.exitCode);

      const res = await runInProcess(
        `tsx ${cliPath} --json --worklog-dir ${wlDir} list --deleted`,
      );
      expect(res.exitCode).toBe(0);
      const ids = JSON.parse(res.stdout).workItems.map((i: { id: string }) => i.id);
      expect(ids).toContain(softDeletedId);
      expect(ids).toContain(hardDeletedId);
    });
  });
});
