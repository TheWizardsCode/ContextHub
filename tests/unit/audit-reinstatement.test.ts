/**
 * Smart audit re-instatement (WL-0MU1EWMHN000YUCG).
 *
 * When the timestamp gate flags a stored audit as stale, the system decides
 * between re-instating the existing audit (non-semantic change — the audited
 * content is unchanged) and flagging the item for re-audit (semantic change).
 * The decision is the pure `assessAuditInvalidate` helper; the automatic
 * re-instatement (resetting `updatedAt = auditedAt`, the `saveAuditResult`
 * pattern) is performed by the persistent store via
 * `WorklogDatabase.reconcileAuditInvalidation`.
 *
 * The pure tests pin the verdict truth table; the persistence tests exercise
 * the real `WorklogDatabase` so the timestamp reset round-trips through
 * save → reconcile → get.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { WorklogDatabase } from '../../src/database.js';
import { assessAuditInvalidate } from '@worklog/shared/icons';
import { createTempDir, cleanupTempDir, createTempJsonlPath, createTempDbPath } from '../test-utils.js';

describe('assessAuditInvalidate — decision truth table (WL-0MU1EWMHN000YUCG)', () => {
  it('returns re-audit when there is no prior audit', () => {
    expect(assessAuditInvalidate({ auditedAt: null, updatedAt: '2026-08-02T10:05:00.000Z' })).toBe('re-audit');
    expect(assessAuditInvalidate({ updatedAt: '2026-08-02T10:05:00.000Z' })).toBe('re-audit');
  });

  it('returns fresh when the timestamp gate is satisfied (no action)', () => {
    expect(
      assessAuditInvalidate({
        auditedAt: '2026-08-02T10:00:00.000Z',
        updatedAt: '2026-08-02T10:00:00.000Z',
      }),
    ).toBe('fresh');
    // Within the 60 s at-or-near tolerance → still fresh.
    expect(
      assessAuditInvalidate({
        auditedAt: '2026-08-02T10:00:00.000Z',
        updatedAt: '2026-08-02T10:00:45.000Z',
      }),
    ).toBe('fresh');
  });

  it('re-instates a timestamp-stale audit whose content fingerprint is unchanged', () => {
    expect(
      assessAuditInvalidate({
        auditedAt: '2026-08-02T10:00:00.000Z',
        updatedAt: '2026-08-02T11:00:00.000Z',
        fingerprint: 'sha256-content',
        currentFingerprint: 'sha256-content',
      }),
    ).toBe('reinstate');
  });

  it('flags for re-audit when the content fingerprint changed (semantic change)', () => {
    expect(
      assessAuditInvalidate({
        auditedAt: '2026-08-02T10:00:00.000Z',
        updatedAt: '2026-08-02T11:00:00.000Z',
        fingerprint: 'sha256-ac-v1',
        currentFingerprint: 'sha256-ac-v2',
      }),
    ).toBe('re-audit');
  });

  it('fails safe to re-audit when fingerprints are missing or incomplete', () => {
    const base = {
      auditedAt: '2026-08-02T10:00:00.000Z',
      updatedAt: '2026-08-02T11:00:00.000Z',
    };
    // No fingerprints at all (legacy audit) → cannot prove unchanged.
    expect(assessAuditInvalidate(base)).toBe('re-audit');
    // Only one side present → not proof of equality.
    expect(assessAuditInvalidate({ ...base, fingerprint: 'sha256-content' })).toBe('re-audit');
    expect(assessAuditInvalidate({ ...base, currentFingerprint: 'sha256-content' })).toBe('re-audit');
  });
});

describe('reconcileAuditInvalidation — automatic re-instatement (WL-0MU1EWMHN000YUCG)', () => {
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
    // autoSync disabled: these tests assert timestamp persistence, and a
    // background sync must not race the assertions.
    db = new WorklogDatabase('ARI', dbPath, jsonlPath, true, false);
  });

  afterEach(() => {
    db.close();
    cleanupTempDir(tempDir);
  });

  it('re-instates updatedAt = auditedAt for non-semantic churn (unchanged fingerprint)', () => {
    const item = db.create({ title: 'Non-semantic churn item', description: 'unchanged content' });
    const fingerprint = 'sha256-content-unchanged';
    db.saveAuditResult({
      workItemId: item.id,
      readyToClose: true,
      auditedAt: '2026-08-02T10:00:00.000Z',
      summary: 'Ready to close: Yes',
      rawOutput: null,
      author: 'tester',
      fingerprint,
    });

    // Status/stage are not part of the content fingerprint, but the transition
    // bumps updatedAt past the 60 s tolerance — a non-semantic change.
    db.update(item.id, { status: 'completed', stage: 'in_review' });
    expect(db.get(item.id)!.updatedAt).not.toBe('2026-08-02T10:00:00.000Z');

    const verdict = db.reconcileAuditInvalidation(item.id, fingerprint);
    expect(verdict).toBe('reinstate');
    // The audit is re-instated: the timestamp gate now agrees with the
    // fingerprint gate for consumers that cannot compute the fingerprint.
    expect(db.get(item.id)!.updatedAt).toBe('2026-08-02T10:00:00.000Z');
  });

  it('is idempotent — a second reconcile is a no-op "fresh"', () => {
    const item = db.create({ title: 'Idempotent re-instatement item' });
    const fingerprint = 'sha256-stable';
    db.saveAuditResult({
      workItemId: item.id,
      readyToClose: true,
      auditedAt: '2026-08-02T10:00:00.000Z',
      summary: null,
      rawOutput: null,
      author: 'tester',
      fingerprint,
    });
    db.update(item.id, { status: 'completed' });

    expect(db.reconcileAuditInvalidation(item.id, fingerprint)).toBe('reinstate');
    const reInstated = db.get(item.id)!.updatedAt;
    expect(db.reconcileAuditInvalidation(item.id, fingerprint)).toBe('fresh');
    expect(db.get(item.id)!.updatedAt).toBe(reInstated);
  });

  it('flags a semantic change for re-audit and leaves the timestamp untouched', () => {
    const item = db.create({ title: 'Semantic change item', description: 'AC v1' });
    db.saveAuditResult({
      workItemId: item.id,
      readyToClose: true,
      auditedAt: '2026-08-02T10:00:00.000Z',
      summary: null,
      rawOutput: null,
      author: 'tester',
      fingerprint: 'sha256-ac-v1',
    });

    // A description/ACs edit changes the audited content.
    db.update(item.id, { description: 'AC v2' });
    const churned = db.get(item.id)!.updatedAt;

    const verdict = db.reconcileAuditInvalidation(item.id, 'sha256-ac-v2');
    expect(verdict).toBe('re-audit');
    expect(db.get(item.id)!.updatedAt).toBe(churned);
  });

  it('preserves the no-audit behaviour (re-audit, no timestamp rewrite)', () => {
    const item = db.create({ title: 'Never audited item' });
    const before = db.get(item.id)!.updatedAt;
    expect(db.reconcileAuditInvalidation(item.id, 'sha256-anything')).toBe('re-audit');
    expect(db.get(item.id)!.updatedAt).toBe(before);
  });

  it('does not lower activityAt when re-instating', () => {
    const item = db.create({ title: 'Activity preserved item' });
    db.saveAuditResult({
      workItemId: item.id,
      readyToClose: true,
      auditedAt: '2026-08-02T10:00:00.000Z',
      summary: null,
      rawOutput: null,
      author: 'tester',
      fingerprint: 'sha256-activity',
    });
    // A comment moves activityAt (not updatedAt) to a later time.
    db.createComment({ workItemId: item.id, author: 'tester', comment: 'follow-up' });
    const activityBefore = db.get(item.id)!.activityAt!;
    db.update(item.id, { assignee: 'someone' });

    expect(db.reconcileAuditInvalidation(item.id, 'sha256-activity')).toBe('reinstate');
    const after = db.get(item.id)!;
    expect(after.updatedAt).toBe('2026-08-02T10:00:00.000Z');
    // activityAt is the later of its prior value and the audit stamp.
    expect(after.activityAt! >= activityBefore).toBe(true);
  });
});
