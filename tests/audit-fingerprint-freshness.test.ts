/**
 * Content-fingerprint audit freshness (WL-0MUBVH5S0008NQ9K).
 *
 * The fingerprint gate makes audit freshness content-based rather than
 * write-time-based:
 *
 *   - A matching stored/current fingerprint keeps the audit fresh regardless
 *     of `updatedAt` churn (post-audit comment, sync-merge re-timestamp,
 *     sortIndex re-sort) — AC4.
 *   - A changed fingerprint (description/ACs, Key Files, HEAD, working tree)
 *     marks the audit stale — AC5.
 *   - A fingerprint-less legacy audit falls back to the 60 s time gate — AC6.
 *
 * The persistence tests exercise the real `WorklogDatabase` so the
 * `audit_results.fingerprint` column round-trips through save → get (AC2).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { WorklogDatabase } from '../src/database.js';
import { isAuditFresh } from '@worklog/shared/icons';
import { createTempDir, cleanupTempDir, createTempJsonlPath, createTempDbPath } from './test-utils.js';

describe('audit content-fingerprint freshness (WL-0MUBVH5S0008NQ9K)', () => {
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
    // autoSync disabled: these tests assert freshness persistence, and a
    // background sync must not race the assertions.
    db = new WorklogDatabase('FPT', dbPath, jsonlPath, true, false);
  });

  afterEach(() => {
    db.close();
    cleanupTempDir(tempDir);
  });

  describe('persistence (AC2)', () => {
    it('round-trips the fingerprint through saveAuditResult → getAuditResult', () => {
      const item = db.create({ title: 'Fingerprinted item', description: 'AC text' });
      const fingerprint = 'sha256-deadbeef';
      db.saveAuditResult({
        workItemId: item.id,
        readyToClose: true,
        auditedAt: new Date().toISOString(),
        summary: 'Ready to close: Yes',
        rawOutput: null,
        author: 'tester',
        fingerprint,
      });

      const audit = db.getAuditResult(item.id)!;
      expect(audit.fingerprint).toBe(fingerprint);
    });

    it('stores the fingerprint atomically with audited_at (updatedAt = auditedAt)', () => {
      const item = db.create({ title: 'Atomic fingerprint item' });
      const auditedAt = '2026-08-02T10:00:00.000Z';
      db.saveAuditResult({
        workItemId: item.id,
        readyToClose: true,
        auditedAt,
        summary: 'Ready to close: Yes',
        rawOutput: null,
        author: 'tester',
        fingerprint: 'sha256-atomic',
      });

      const audit = db.getAuditResult(item.id)!;
      const stored = db.get(item.id)!;
      expect(audit.fingerprint).toBe('sha256-atomic');
      expect(audit.auditedAt).toBe(auditedAt);
      expect(stored.updatedAt).toBe(auditedAt);
    });

    it('leaves fingerprint null when omitted (legacy write path)', () => {
      const item = db.create({ title: 'Legacy audit item' });
      db.saveAuditResult({
        workItemId: item.id,
        readyToClose: true,
        auditedAt: new Date().toISOString(),
        summary: 'Ready to close: Yes',
        rawOutput: null,
        author: 'tester',
      });
      expect(db.getAuditResult(item.id)!.fingerprint).toBeNull();
    });

    it('getAllAuditResults includes the fingerprint (JSONL export / sync)', () => {
      const item = db.create({ title: 'Export fingerprint item' });
      db.saveAuditResult({
        workItemId: item.id,
        readyToClose: true,
        auditedAt: new Date().toISOString(),
        summary: null,
        rawOutput: null,
        author: null,
        fingerprint: 'sha256-export',
      });
      const all = db.getAllAuditResults();
      const row = all.find(a => a.workItemId === item.id)!;
      expect(row.fingerprint).toBe('sha256-export');
    });
  });

  describe('updatedAt churn stays fresh with a matching fingerprint (AC4)', () => {
    it('a post-audit comment does NOT stale a fingerprinted audit', () => {
      const item = db.create({ title: 'Comment churn item', description: 'unchanged' });
      const fingerprint = 'sha256-content-unchanged';
      // Fixed past auditedAt so the comment's wall-clock bump is guaranteed to
      // be later (avoids same-millisecond flakiness under load).
      db.saveAuditResult({
        workItemId: item.id,
        readyToClose: true,
        auditedAt: '2026-08-02T10:00:00.000Z',
        summary: null,
        rawOutput: null,
        author: 'tester',
        fingerprint,
      });

      // A comment unconditionally touches updatedAt (metadata-only write).
      db.createComment({ workItemId: item.id, author: 'tester', comment: 'Follow-up' });

      const audit = db.getAuditResult(item.id)!;
      const afterComment = db.get(item.id)!;
      // updatedAt moved far past the 60 s window, but the content fingerprint
      // is unchanged → fresh (the time gate alone would call this stale).
      expect(new Date(afterComment.updatedAt).getTime()).toBeGreaterThan(
        new Date(audit.auditedAt).getTime() + 60_000,
      );
      expect(isAuditFresh(audit.auditedAt, afterComment.updatedAt, audit.fingerprint, fingerprint)).toBe(true);
    });

    it('a sync-merge re-timestamp does NOT stale a fingerprinted audit', () => {
      const item = db.create({ title: 'Sync churn item' });
      const fingerprint = 'sha256-before-sync';
      db.saveAuditResult({
        workItemId: item.id,
        readyToClose: true,
        auditedAt: '2026-08-02T10:00:00.000Z',
        summary: null,
        rawOutput: null,
        author: 'tester',
        fingerprint,
      });

      // Simulate a sync merge bumping updatedAt far past the 60 s window.
      db.update(item.id, { title: db.get(item.id)!.title });
      const merged = db.get(item.id)!;
      const audit = db.getAuditResult(item.id)!;

      // The current fingerprint still matches → fresh despite the write clock.
      expect(isAuditFresh(audit.auditedAt, merged.updatedAt, audit.fingerprint, fingerprint)).toBe(true);
    });

    it('a sortIndex re-sort does NOT stale a fingerprinted audit', () => {
      const item = db.create({ title: 'Re-sort item', description: 'unchanged' });
      const fingerprint = 'sha256-resort';
      db.saveAuditResult({
        workItemId: item.id,
        readyToClose: true,
        auditedAt: '2026-08-02T10:00:00.000Z',
        summary: null,
        rawOutput: null,
        author: 'tester',
        fingerprint,
      });

      db.reSort();
      const afterResort = db.get(item.id)!;
      const audit = db.getAuditResult(item.id)!;
      expect(isAuditFresh(audit.auditedAt, afterResort.updatedAt, audit.fingerprint, fingerprint)).toBe(true);
    });
  });

  describe('content change stales the audit with a mismatched fingerprint (AC5)', () => {
    it('a description/ACs edit changes the current fingerprint → stale', () => {
      const item = db.create({ title: 'Description change item', description: 'AC v1' });
      const storedFingerprint = 'sha256-ac-v1';
      db.saveAuditResult({
        workItemId: item.id,
        readyToClose: true,
        auditedAt: new Date().toISOString(),
        summary: null,
        rawOutput: null,
        author: 'tester',
        fingerprint: storedFingerprint,
      });

      // Content changes → the fingerprint recomputed at check time differs.
      db.update(item.id, { description: 'AC v2' });
      const currentFingerprint = 'sha256-ac-v2';
      const audit = db.getAuditResult(item.id)!;
      expect(isAuditFresh(audit.auditedAt, db.get(item.id)!.updatedAt, audit.fingerprint, currentFingerprint)).toBe(false);
    });

    it('a HEAD sha change stales the audit (fingerprint mismatch)', () => {
      const item = db.create({ title: 'HEAD change item' });
      db.saveAuditResult({
        workItemId: item.id,
        readyToClose: true,
        auditedAt: new Date().toISOString(),
        summary: null,
        rawOutput: null,
        author: 'tester',
        fingerprint: 'sha256-head-abc',
      });
      const audit = db.getAuditResult(item.id)!;
      // A new commit changes the current fingerprint (HEAD component).
      expect(isAuditFresh(audit.auditedAt, db.get(item.id)!.updatedAt, audit.fingerprint, 'sha256-head-def')).toBe(false);
    });

    it('a working-tree change stales the audit (fingerprint mismatch)', () => {
      const item = db.create({ title: 'Working-tree change item' });
      db.saveAuditResult({
        workItemId: item.id,
        readyToClose: true,
        auditedAt: new Date().toISOString(),
        summary: null,
        rawOutput: null,
        author: 'tester',
        fingerprint: 'sha256-tree-clean',
      });
      const audit = db.getAuditResult(item.id)!;
      expect(isAuditFresh(audit.auditedAt, db.get(item.id)!.updatedAt, audit.fingerprint, 'sha256-tree-dirty')).toBe(false);
    });
  });

  describe('legacy fallback to the time gate (AC6)', () => {
    it('fingerprint-less audit within 60 s is fresh', () => {
      const item = db.create({ title: 'Legacy fresh item' });
      const auditedAt = '2026-08-02T10:00:00.000Z';
      const updatedAt = '2026-08-02T10:00:30.000Z';
      expect(isAuditFresh(auditedAt, updatedAt, undefined, null)).toBe(true);
    });

    it('fingerprint-less audit beyond 60 s is stale', () => {
      expect(
        isAuditFresh('2026-08-02T10:00:00.000Z', '2026-08-02T10:05:00.000Z', null, null),
      ).toBe(false);
    });

    it('a legacy (null-fingerprint) DB row stays readable and uses the time gate', () => {
      const item = db.create({ title: 'Legacy row item' });
      const auditedAt = '2026-08-02T10:00:00.000Z';
      db.saveAuditResult({
        workItemId: item.id,
        readyToClose: true,
        auditedAt,
        summary: null,
        rawOutput: null,
        author: 'tester',
      });
      const audit = db.getAuditResult(item.id)!;
      expect(audit.fingerprint).toBeNull();
      // Same timestamp → within the time gate → fresh.
      expect(isAuditFresh(audit.auditedAt, auditedAt, audit.fingerprint, null)).toBe(true);
    });
  });
});
