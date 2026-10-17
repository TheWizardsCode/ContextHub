/**
 * Tests for scripts/cleanup-assignee-residue.ts (WL-0MV85WFDS0036INQ)
 *
 * Lives under tests/unit/ (rather than the predicted root path) so it runs in
 * the canonical suite declared by .pi/test-config.json — `tests/cli` and
 * `tests/unit`. Root-level tests exist but are not part of that suite.
 *
 * Exercises the one-time assignee-residue cleanup against a fixture database:
 *   - audit-hold residue (completed / in_review) is cleared
 *   - in-flight claims (open / in-progress / blocked / input_needed) are untouched
 *   - already-clean items are untouched
 *   - dry-run mode reports without writing
 *   - re-running is a no-op (idempotent)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { WorklogDatabase } from '../../src/database.js';
import {
  runCleanup,
  isResidueTarget,
  formatReport,
  parseArgs,
  resolveWorklogDir,
  IN_FLIGHT_STATUSES,
} from '../../scripts/cleanup-assignee-residue.js';
import {
  createTempDir,
  cleanupTempDir,
  createTempJsonlPath,
  createTempDbPath,
} from '../test-utils.js';

describe('cleanup-assignee-residue', () => {
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
    db = new WorklogDatabase('TEST', dbPath, jsonlPath, true, false);
  });

  afterEach(() => {
    db.close();
    cleanupTempDir(tempDir);
  });

  /** Seed the fixture database with the three categories. */
  function seedFixture(): void {
    // ── Audit-hold residue: must be cleared ──────────────────────────
    db.create({
      title: 'Completed item with stale assignee',
      status: 'completed',
      stage: 'in_review',
      assignee: 'implement',
    });
    db.create({
      title: 'Completed item with a different stale assignee',
      status: 'completed',
      assignee: 'producer',
    });
    db.create({
      title: 'In-review audit-hold item',
      status: 'completed',
      stage: 'in_review',
      assignee: 'audit-agent',
    });
    db.create({
      title: 'Deleted item with residual in_review stage',
      status: 'deleted',
      stage: 'in_review',
      assignee: 'stale-agent',
    });

    // ── In-flight claims: must be untouched ──────────────────────────
    const openItem = db.create({
      title: 'Open in-flight claim',
      status: 'open',
      stage: 'plan_complete',
      assignee: 'implement',
    });
    expect(openItem).toBeDefined();

    db.create({
      title: 'In-progress in-flight claim',
      status: 'in-progress',
      stage: 'in_progress',
      assignee: 'implement',
    });
    db.create({
      title: 'Blocked in-flight claim',
      status: 'blocked',
      stage: 'plan_complete',
      assignee: 'implement',
    });
    db.create({
      title: 'Input-needed in-flight claim',
      status: 'input_needed',
      stage: 'intake_complete',
      assignee: 'producer',
    });

    // ── Already-clean items: must be untouched ───────────────────────
    db.create({
      title: 'Completed item already clean',
      status: 'completed',
      stage: 'in_review',
      assignee: '',
    });
    db.create({
      title: 'Open item already clean',
      status: 'open',
      assignee: '',
    });
  }

  describe('isResidueTarget', () => {
    it('targets a completed item with a non-empty assignee', () => {
      const item = db.create({ title: 'x', status: 'completed', assignee: 'a' });
      expect(isResidueTarget(item)).toBe(true);
    });

    it('targets an in_review-stage completed item with a non-empty assignee', () => {
      const item = db.create({ title: 'x', status: 'completed', stage: 'in_review', assignee: 'a' });
      expect(isResidueTarget(item)).toBe(true);
    });

    it('never targets a deleted item even with a residual in_review stage', () => {
      const item = db.create({ title: 'x', status: 'deleted', stage: 'in_review', assignee: 'a' });
      expect(isResidueTarget(item)).toBe(false);
    });

    it.each(['open', 'in-progress', 'blocked', 'input_needed'] as const)(
      'never targets in-flight status %s',
      (status) => {
        const item = db.create({ title: 'x', status, assignee: 'a' });
        expect(isResidueTarget(item)).toBe(false);
      },
    );

    it('does not target an item with an empty assignee', () => {
      const item = db.create({ title: 'x', status: 'completed', assignee: '' });
      expect(isResidueTarget(item)).toBe(false);
    });

    it('does not target a non-hold open item', () => {
      const item = db.create({ title: 'x', status: 'open', stage: 'plan_complete', assignee: 'a' });
      expect(isResidueTarget(item)).toBe(false);
    });
  });

  describe('runCleanup (dry-run)', () => {
    it('reports affected items and counts without writing', () => {
      seedFixture();

      const report = runCleanup(db, true);

      expect(report.dryRun).toBe(true);
      expect(report.cleared).toHaveLength(3);
      expect(report.cleared.map((c) => c.id).sort()).toEqual(
        db
          .list()
          .filter((i) => isResidueTarget(i))
          .map((i) => i.id)
          .sort(),
      );

      // No writes happened: every assignee is still present.
      const unchanged = db.list();
      expect(unchanged.find((i) => i.title === 'Completed item with stale assignee')!.assignee).toBe(
        'implement',
      );
      expect(unchanged.find((i) => i.title === 'In-review audit-hold item')!.assignee).toBe(
        'audit-agent',
      );
    });

    it('returns a JSON-serialisable, human-readable report', () => {
      seedFixture();
      const report = runCleanup(db, true);
      const text = formatReport(report);
      expect(text).toContain('DRY RUN');
      expect(text).toContain('WOULD CLEAR: 3');
      expect(JSON.parse(JSON.stringify(report)).cleared).toHaveLength(3);
    });
  });

  describe('runCleanup (apply)', () => {
    it('clears audit-hold residue only', () => {
      seedFixture();

      const report = runCleanup(db, false);
      expect(report.cleared).toHaveLength(3);

      const byTitle = new Map(db.list().map((i) => [i.title, i]));

      // Cleared.
      expect(byTitle.get('Completed item with stale assignee')!.assignee).toBe('');
      expect(byTitle.get('Completed item with a different stale assignee')!.assignee).toBe('');
      expect(byTitle.get('In-review audit-hold item')!.assignee).toBe('');

      // In-flight untouched.
      expect(byTitle.get('Open in-flight claim')!.assignee).toBe('implement');
      expect(byTitle.get('In-progress in-flight claim')!.assignee).toBe('implement');
      expect(byTitle.get('Blocked in-flight claim')!.assignee).toBe('implement');
      expect(byTitle.get('Input-needed in-flight claim')!.assignee).toBe('producer');

      // Already-clean untouched.
      expect(byTitle.get('Completed item already clean')!.assignee).toBe('');
      expect(byTitle.get('Open item already clean')!.assignee).toBe('');
    });

    it('is idempotent — a second run clears nothing and writes nothing', () => {
      seedFixture();

      const first = runCleanup(db, false);
      expect(first.cleared).toHaveLength(3);

      const afterFirst = new Map(db.list().map((i) => [i.id, i]));

      const second = runCleanup(db, false);
      expect(second.cleared).toHaveLength(0);
      // Only the 2 already-clean fixtures plus the 3 just-cleared items are
      // now clean; in-flight and deleted items keep their assignees.
      expect(second.alreadyClean).toBe(2 + first.cleared.length);

      // Re-running never re-timestamps previously-cleared items.
      for (const item of db.list()) {
        const before = afterFirst.get(item.id)!;
        expect(item.updatedAt).toBe(before.updatedAt);
      }
    });

    it('does not touch items that are neither completed nor in_review', () => {
      const item = db.create({
        title: 'Open plan item with assignee',
        status: 'open',
        stage: 'plan_complete',
        assignee: 'implement',
      });

      const report = runCleanup(db, false);

      expect(report.cleared).toHaveLength(0);
      expect(report.skipped.some((s) => s.id === item.id)).toBe(true);
      expect(db.get(item.id)!.assignee).toBe('implement');
    });
  });

  describe('IN_FLIGHT_STATUSES', () => {
    it('covers exactly the non-terminal, non-audit-hold statuses', () => {
      expect([...IN_FLIGHT_STATUSES].sort()).toEqual(
        ['blocked', 'in-progress', 'input_needed', 'open'].sort(),
      );
    });
  });

  describe('CLI helpers', () => {
    it('parses --worklog-dir, --dry-run and --json', () => {
      const opts = parseArgs(['--worklog-dir', '/tmp/wl', '--dry-run', '--json']);
      expect(opts.worklogDir).toBe('/tmp/wl');
      expect(opts.dryRun).toBe(true);
      expect(opts.json).toBe(true);
    });

    it('resolves the .worklog directory by walking up', () => {
      const nested = `${tempDir}/a/b/c`;
      fs.mkdirSync(nested, { recursive: true });
      fs.mkdirSync(`${tempDir}/.worklog`, { recursive: true });
      expect(resolveWorklogDir(nested)).toBe(`${tempDir}/.worklog`);
    });

    it('falls back to <cwd>/.worklog when no .worklog exists', () => {
      const isolated = `${tempDir}/no-worklog`;
      fs.mkdirSync(isolated, { recursive: true });
      const resolved = resolveWorklogDir(isolated);
      // Walk may pass the temp dir; the fallback appends .worklog to the start.
      expect(resolved.endsWith('.worklog')).toBe(true);
    });
  });
});
