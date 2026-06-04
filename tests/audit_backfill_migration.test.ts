/**
 * Tests for the audit backfill migration.
 *
 * Verifies that the migration correctly parses existing workitems.audit JSON
 * objects and inserts rows into audit_results.
 *
 * Acceptance Criteria:
 * 1. Valid {time, author, text, status} JSON is parsed and inserted
 * 2. Null/missing/invalid entries are silently skipped
 * 3. Data integrity: all fields round-trip correctly
 * 4. Idempotency: re-running migration doesn't duplicate rows
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { createTempDir, cleanupTempDir } from './test-utils.js';

// ---------------------------------------------------------------------------
// Helper: Create a legacy database with audit data
// ---------------------------------------------------------------------------

function createLegacyDbWithAuditData(
  dbPath: string,
  auditEntries: Array<{ id: string; auditText: string | null; author?: string; time?: string }>
): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE workitems (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
        status TEXT NOT NULL, priority TEXT NOT NULL, sortIndex INTEGER NOT NULL DEFAULT 0,
        parentId TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        tags TEXT NOT NULL, assignee TEXT NOT NULL, stage TEXT NOT NULL,
        issueType TEXT NOT NULL, createdBy TEXT NOT NULL, deletedBy TEXT NOT NULL,
        deleteReason TEXT NOT NULL, risk TEXT NOT NULL, effort TEXT NOT NULL,
        githubIssueNumber INTEGER, githubIssueId INTEGER, githubIssueUpdatedAt TEXT,
        needsProducerReview INTEGER NOT NULL DEFAULT 0, audit TEXT
      );
      CREATE TABLE comments (
        id TEXT PRIMARY KEY, workItemId TEXT NOT NULL, author TEXT NOT NULL,
        comment TEXT NOT NULL, createdAt TEXT NOT NULL, refs TEXT
      );
      CREATE TABLE dependency_edges (
        fromId TEXT NOT NULL, toId TEXT NOT NULL,
        createdAt TEXT NOT NULL, PRIMARY KEY (fromId, toId)
      );
      INSERT OR REPLACE INTO metadata (key, value) VALUES ('schemaVersion', '7');
    `);

    for (const entry of auditEntries) {
      const auditValue = entry.auditText ? JSON.stringify({
        time: entry.time || '2026-01-01T00:00:00.000Z',
        author: entry.author || 'test-author',
        text: entry.auditText,
        status: entry.auditText?.startsWith('Ready to close: Yes') ? 'Complete' : 'Partial'
      }) : null;

      db.prepare(`
        INSERT OR REPLACE INTO workitems (
          id, title, description, status, priority, sortIndex, parentId,
          createdAt, updatedAt, tags, assignee, stage, issueType,
          createdBy, deletedBy, deleteReason, risk, effort,
          needsProducerReview, audit
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.id,
        `Work item ${entry.id}`,
        'Test description',
        'open',
        'high',
        100,
        null,
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
        '[]',
        '',
        'idea',
        'task',
        '',
        '',
        '',
        '',
        '',
        0,
        auditValue
      );
    }
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Test 1: Valid audit JSON is parsed and inserted
// ---------------------------------------------------------------------------

describe('Backfill migration: valid audit data', () => {
  it('parses and inserts valid {time, author, text, status} JSON', () => {
    const tmp = createTempDir();
    try {
      const dbPath = path.join(tmp, 'worklog.db');
      createLegacyDbWithAuditData(dbPath, [
        { id: 'SA-001', auditText: 'Ready to close: Yes\nReviewed', author: 'alice', time: '2026-05-01T10:00:00.000Z' }
      ]);

      // After implementing the backfill migration, this test should verify:
      // const { runBackfillMigration } = require('../src/migrations/index.js');
      // runBackfillMigration(dbPath);

      // For now, assert the expected behavior (will fail until implementation)
      expect(true).toBe(false); // Placeholder - implementation pending
    } finally {
      cleanupTempDir(tmp);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2: Null/missing/invalid entries are silently skipped
// ---------------------------------------------------------------------------

describe('Backfill migration: invalid entries', () => {
  it('skips null audit entries', () => {
    const tmp = createTempDir();
    try {
      const dbPath = path.join(tmp, 'worklog.db');
      createLegacyDbWithAuditData(dbPath, [
        { id: 'SA-002', auditText: null }
      ]);

      expect(true).toBe(false); // Placeholder - implementation pending
    } finally {
      cleanupTempDir(tmp);
    }
  });

  it('skips missing audit entries', () => {
    const tmp = createTempDir();
    try {
      const dbPath = path.join(tmp, 'worklog.db');
      createLegacyDbWithAuditData(dbPath, [
        { id: 'SA-003', auditText: undefined as any }
      ]);

      expect(true).toBe(false); // Placeholder - implementation pending
    } finally {
      cleanupTempDir(tmp);
    }
  });

  it('skips invalid JSON entries', () => {
    const tmp = createTempDir();
    try {
      const dbPath = path.join(tmp, 'worklog.db');

      // Create the base tables
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE workitems (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
          status TEXT NOT NULL, priority TEXT NOT NULL, sortIndex INTEGER NOT NULL DEFAULT 0,
          parentId TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
          tags TEXT NOT NULL, assignee TEXT NOT NULL, stage TEXT NOT NULL,
          issueType TEXT NOT NULL, createdBy TEXT NOT NULL, deletedBy TEXT NOT NULL,
          deleteReason TEXT NOT NULL, risk TEXT NOT NULL, effort TEXT NOT NULL,
          githubIssueNumber INTEGER, githubIssueId INTEGER, githubIssueUpdatedAt TEXT,
          needsProducerReview INTEGER NOT NULL DEFAULT 0, audit TEXT
        );
        INSERT OR REPLACE INTO metadata (key, value) VALUES ('schemaVersion', '7');
      `);

      // Insert workitem with invalid JSON in audit column
      db.prepare(`
        INSERT OR REPLACE INTO workitems (
          id, title, description, status, priority, sortIndex, parentId,
          createdAt, updatedAt, tags, assignee, stage, issueType,
          createdBy, deletedBy, deleteReason, risk, effort,
          needsProducerReview, audit
        ) VALUES (?, 'Invalid', 'test', 'open', 'high', 100, null,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '[]',
          '', 'idea', 'task', '', '', '', '', '', 0, ?)
      `).run('SA-004', 'not valid json {');
      db.close();

      expect(true).toBe(false); // Placeholder - implementation pending
    } finally {
      cleanupTempDir(tmp);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3: Data integrity - all fields round-trip correctly
// ---------------------------------------------------------------------------

describe('Backfill migration: data integrity', () => {
  it('round-trips all fields correctly', () => {
    const tmp = createTempDir();
    try {
      const dbPath = path.join(tmp, 'worklog.db');
      createLegacyDbWithAuditData(dbPath, [
        { id: 'SA-005', auditText: 'Ready to close: Yes\nFull review done', author: 'bob', time: '2026-05-15T14:30:00.000Z' }
      ]);

      expect(true).toBe(false); // Placeholder - implementation pending
    } finally {
      cleanupTempDir(tmp);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 4: Idempotency - re-running migration doesn't duplicate rows
// ---------------------------------------------------------------------------

describe('Backfill migration: idempotency', () => {
  it('re-running migration does not duplicate rows', () => {
    const tmp = createTempDir();
    try {
      const dbPath = path.join(tmp, 'worklog.db');
      createLegacyDbWithAuditData(dbPath, [
        { id: 'SA-006', auditText: 'Ready to close: No\nNeeds work', author: 'charlie', time: '2026-05-20T09:00:00.000Z' }
      ]);

      expect(true).toBe(false); // Placeholder - implementation pending
    } finally {
      cleanupTempDir(tmp);
    }
  });
});
