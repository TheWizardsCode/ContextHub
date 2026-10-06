/**
 * Re-sort must not invalidate a fresh audit through `updatedAt` churn
 * (WL-0MTWU4XGP001GDEA, parent WL-0MU2O8AQ8000ASDO).
 *
 * The bulk re-sort path (`batchUpdateSortIndices`, used by `reSort` / `wl
 * re-sort`) was already fixed to leave `updatedAt` alone (WL-0MU2QKB98007BKYT).
 * The single-item path `assignSortIndexValues` (used by
 * `wl migrate sort-index`) still stamped `updatedAt` on every sortIndex-only
 * change, so running it rewrote the audit-relevant timestamp and made
 * previously-passing audits read as stale.
 *
 * These tests pin the observable behaviour: a sortIndex-only change preserves
 * `updatedAt` (and therefore audit freshness), while a genuine semantic edit
 * still bumps it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
// Import the shared source directly (not `../../src/database.js`): the CLI
// wrapper re-exports `@worklog/shared`, which resolves to the main checkout's
// prebuilt `dist/` and would not exercise the worktree's source change.
import { WorklogDatabase } from '../../packages/shared/src/database.js';
import { isAuditFresh } from '@worklog/shared/icons';
import {
  createTempDir,
  cleanupTempDir,
  createTempJsonlPath,
  createTempDbPath,
} from '../test-utils.js';

describe('assignSortIndexValues does not invalidate fresh audits (WL-0MTWU4XGP001GDEA)', () => {
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
    // autoSync disabled: the assertions are about persisted timestamps and a
    // background sync must not race them.
    db = new WorklogDatabase('RSRT', dbPath, jsonlPath, true, false);
  });

  afterEach(() => {
    db.close();
    cleanupTempDir(tempDir);
  });

  it('preserves updatedAt on a sortIndex-only change so a passing audit stays fresh', () => {
    // Deliberately stale sort ordering: the high-priority item sorts first but
    // carries the larger sortIndex, so assignSortIndexValues must move both.
    const low = db.create({ title: 'Low priority', priority: 'low', sortIndex: 1000 });
    const high = db.create({ title: 'High priority', priority: 'high', sortIndex: 1 });

    const auditedAt = '2026-08-02T10:00:00.000Z';
    db.saveAuditResult({
      workItemId: high.id,
      readyToClose: true,
      auditedAt,
      summary: 'Ready to close: Yes',
      rawOutput: null,
      author: 'tester',
      fingerprint: 'sha256-content-unchanged',
    });

    const updatedAtBefore = db.get(high.id)!.updatedAt;
    expect(updatedAtBefore).toBe(auditedAt);

    const result = db.assignSortIndexValues(100);
    expect(result.updated).toBeGreaterThan(0);

    // The reassignment really happened...
    expect(db.get(high.id)!.sortIndex).not.toBe(1);
    expect(db.get(low.id)!.sortIndex).not.toBe(1000);

    // ...but the audit-relevant timestamp did not move.
    expect(db.get(high.id)!.updatedAt).toBe(updatedAtBefore);
    expect(db.get(low.id)!.updatedAt).toBe(db.get(low.id)!.createdAt);

    const audit = db.getAuditResult(high.id)!;
    const after = db.get(high.id)!;
    // Fresh by the one-sided time gate AND by the fingerprint gate.
    expect(isAuditFresh(audit.auditedAt, after.updatedAt)).toBe(true);
    expect(
      isAuditFresh(audit.auditedAt, after.updatedAt, audit.fingerprint, 'sha256-content-unchanged'),
    ).toBe(true);
  });

  it('repeated assignSortIndexValues runs stay quiescent after the first pass', () => {
    const item = db.create({ title: 'Idempotent re-sort item', priority: 'medium', sortIndex: 7 });

    const first = db.assignSortIndexValues(100);
    expect(first.updated).toBe(1);
    const updatedAtAfterFirst = db.get(item.id)!.updatedAt;

    const second = db.assignSortIndexValues(100);
    expect(second.updated).toBe(0);
    expect(db.get(item.id)!.updatedAt).toBe(updatedAtAfterFirst);
  });

  it('a genuine semantic edit after audit still bumps updatedAt (invariant preserved)', () => {
    const item = db.create({ title: 'Semantic edit item', description: 'AC v1' });
    const auditedAt = '2026-08-02T10:00:00.000Z';
    db.saveAuditResult({
      workItemId: item.id,
      readyToClose: true,
      auditedAt,
      summary: null,
      rawOutput: null,
      author: 'tester',
      fingerprint: 'sha256-ac-v1',
    });

    db.update(item.id, { description: 'AC v2' });
    const after = db.get(item.id)!;
    expect(after.updatedAt).not.toBe(auditedAt);
    // The content fingerprint no longer matches what was audited → stale.
    const audit = db.getAuditResult(item.id)!;
    expect(isAuditFresh(audit.auditedAt, after.updatedAt, audit.fingerprint, 'sha256-ac-v2')).toBe(false);
  });
});
