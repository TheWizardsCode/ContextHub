/**
 * Tests for the audit field: type, persistence, migration, and status derivation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { WorklogDatabase } from '../../src/database.js';
import { buildAuditEntry, deriveAuditStatus, hasExplicitCriteria, getCurrentUser } from '../../src/audit.js';
import { listPendingMigrations, runMigrations } from '../../src/migrations/index.js';
import { createTempDir, cleanupTempDir, createTempJsonlPath, createTempDbPath } from '../test-utils.js';

// ---------------------------------------------------------------------------
// Audit utility unit tests
// ---------------------------------------------------------------------------

describe('audit utilities', () => {
  describe('hasExplicitCriteria', () => {
    it('returns false for empty description', () => {
      expect(hasExplicitCriteria('')).toBe(false);
    });

    it('returns false for description with no criteria markers', () => {
      expect(hasExplicitCriteria('This is a general description with no specific criteria.')).toBe(false);
    });

    it('detects "Success criteria" heading', () => {
      expect(hasExplicitCriteria('Success criteria\n- Item must do X')).toBe(true);
    });

    it('detects "Acceptance criteria" (case-insensitive)', () => {
      expect(hasExplicitCriteria('acceptance criteria:\n- must pass all tests')).toBe(true);
    });

    it('detects "AC 1" numbered criteria', () => {
      expect(hasExplicitCriteria('AC 1: The system must respond in < 1s')).toBe(true);
    });

    it('detects "done when" phrase', () => {
      expect(hasExplicitCriteria('This is done when the PR is merged.')).toBe(true);
    });

    it('detects checkbox list items', () => {
      expect(hasExplicitCriteria('- [ ] First criterion\n- [ ] Second criterion')).toBe(true);
    });
  });

  describe('deriveAuditStatus', () => {
    const descWithCriteria = 'Success criteria:\n- [ ] All tests pass\n- [ ] PR merged';
    const descWithoutCriteria = 'A simple description with no criteria.';

    it('returns Missing Criteria when description lacks success criteria', () => {
      expect(deriveAuditStatus('Work is complete', descWithoutCriteria)).toBe('Missing Criteria');
    });

    it('returns Complete for strong completion signal', () => {
      expect(deriveAuditStatus('All criteria met and verified', descWithCriteria)).toBe('Complete');
    });

    it('returns Complete for "fully complete" signal', () => {
      expect(deriveAuditStatus('Implementation is fully complete', descWithCriteria)).toBe('Complete');
    });

    it('returns Partial for partial-progress signal', () => {
      expect(deriveAuditStatus('Partially implemented; remaining tests needed', descWithCriteria)).toBe('Partial');
    });

    it('returns Partial for "work in progress"', () => {
      expect(deriveAuditStatus('Work in progress on the feature', descWithCriteria)).toBe('Partial');
    });

    it('returns Not Started for unrecognized audit text with criteria present', () => {
      expect(deriveAuditStatus('Applied migration on 2026-03-14', descWithCriteria)).toBe('Not Started');
    });

    it('is case-insensitive for Complete match', () => {
      expect(deriveAuditStatus('ALL CRITERIA MET', descWithCriteria)).toBe('Complete');
    });
  });

  describe('buildAuditEntry', () => {
    it('returns a complete AuditEntry shape', () => {
      const entry = buildAuditEntry('Migration applied', 'Success criteria:\n- [ ] DB updated');
      expect(entry).toMatchObject({
        author: expect.any(String),
        text: 'Migration applied',
        status: expect.stringMatching(/^(Complete|Partial|Not Started|Missing Criteria)$/),
      });
      expect(entry.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('sets author to a non-empty string', () => {
      const entry = buildAuditEntry('test', '');
      expect(typeof entry.author).toBe('string');
      expect(entry.author.length).toBeGreaterThan(0);
    });
  });

  describe('getCurrentUser', () => {
    it('returns a non-empty string', () => {
      const user = getCurrentUser();
      expect(typeof user).toBe('string');
      expect(user.length).toBeGreaterThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Persistence round-trip tests
// ---------------------------------------------------------------------------

describe('audit field persistence (fresh DB)', () => {
  let tempDir: string;
  let dbPath: string;
  let jsonlPath: string;
  let db: WorklogDatabase;

  beforeEach(() => {
    tempDir = createTempDir();
    dbPath = createTempDbPath(tempDir);
    jsonlPath = createTempJsonlPath(tempDir);
    db = new WorklogDatabase('TEST', dbPath, jsonlPath, true, true);
  });

  afterEach(() => {
    db.close();
    cleanupTempDir(tempDir);
  });

  it('stores and retrieves an audit entry on a work item', () => {
    const auditEntry = {
      time: new Date().toISOString(),
      author: 'testuser',
      text: 'Migration applied successfully',
      status: 'Not Started' as const,
    };

    const item = db.create({ title: 'Test item', description: 'no criteria' });
    const updated = db.update(item.id, { audit: auditEntry });

    expect(updated).not.toBeNull();
    expect(updated!.audit).toEqual(auditEntry);

    // Verify persistence by fetching from DB
    const fetched = db.get(item.id);
    expect(fetched!.audit).toEqual(auditEntry);
  });

  it('audit field is undefined when not set', () => {
    const item = db.create({ title: 'No audit item' });
    const fetched = db.get(item.id);
    expect(fetched!.audit).toBeUndefined();
  });

  it('creates a work item with audit entry via create()', () => {
    const auditEntry = {
      time: new Date().toISOString(),
      author: 'operator',
      text: 'Created with audit',
      status: 'Complete' as const,
    };

    const item = db.create({ title: 'With audit', audit: auditEntry });
    const fetched = db.get(item.id);
    expect(fetched!.audit).toEqual(auditEntry);
  });

  it('overwrites a previous audit entry on update', () => {
    const first = { time: new Date().toISOString(), author: 'a', text: 'first', status: 'Not Started' as const };
    const second = { time: new Date().toISOString(), author: 'b', text: 'second', status: 'Complete' as const };

    const item = db.create({ title: 'Replace audit', audit: first });
    db.update(item.id, { audit: second });

    const fetched = db.get(item.id);
    expect(fetched!.audit).toEqual(second);
  });

  it('can clear an audit entry by setting null (stores undefined)', () => {
    const auditEntry = { time: new Date().toISOString(), author: 'x', text: 'note', status: 'Partial' as const };
    const item = db.create({ title: 'Will clear audit', audit: auditEntry });
    // Update without audit field - should not clear existing
    db.update(item.id, { title: 'Updated title' });
    const fetched = db.get(item.id);
    // Audit should still be present since we didn't update it
    expect(fetched!.audit).toEqual(auditEntry);
  });
});

// ---------------------------------------------------------------------------
// Migration tests
// ---------------------------------------------------------------------------

describe('20260314-add-audit migration', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('reports no pending migrations for a fresh DB that already has the audit column', () => {
    const dbPath = path.join(tempDir, 'fresh.db');
    // Create DB via WorklogDatabase which creates schema with audit column
    const db = new WorklogDatabase('WL', dbPath, path.join(tempDir, 'data.jsonl'), false, true);
    db.close();

    const pending = listPendingMigrations(dbPath);
    const auditMig = pending.find(m => m.id === '20260314-add-audit');
    expect(auditMig).toBeUndefined();
  });

  it('reports audit migration as pending for a DB that lacks the audit column', () => {
    const dbPath = path.join(tempDir, 'old.db');
    // Simulate an old DB without the audit column
    const rawDb = new Database(dbPath);
    rawDb.exec(`CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    rawDb.exec(`INSERT INTO metadata (key, value) VALUES ('schemaVersion', '6')`);
    rawDb.exec(`
      CREATE TABLE workitems (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        sortIndex INTEGER NOT NULL DEFAULT 0,
        parentId TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        tags TEXT NOT NULL,
        assignee TEXT NOT NULL,
        stage TEXT NOT NULL,
        issueType TEXT NOT NULL,
        createdBy TEXT NOT NULL,
        deletedBy TEXT NOT NULL,
        deleteReason TEXT NOT NULL,
        risk TEXT NOT NULL,
        effort TEXT NOT NULL,
        githubIssueNumber INTEGER,
        githubIssueId INTEGER,
        githubIssueUpdatedAt TEXT,
        needsProducerReview INTEGER NOT NULL DEFAULT 0
      )
    `);
    rawDb.close();

    const pending = listPendingMigrations(dbPath);
    const auditMig = pending.find(m => m.id === '20260314-add-audit');
    expect(auditMig).toBeDefined();
    expect(auditMig!.safe).toBe(true);
  });

  it('applies the audit migration with --confirm and creates backup', () => {
    const dbPath = path.join(tempDir, 'migrate.db');
    // Simulate an old DB without audit column (has needsProducerReview already)
    const rawDb = new Database(dbPath);
    rawDb.exec(`CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    rawDb.exec(`INSERT INTO metadata (key, value) VALUES ('schemaVersion', '7')`);
    rawDb.exec(`
      CREATE TABLE workitems (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        sortIndex INTEGER NOT NULL DEFAULT 0,
        parentId TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        tags TEXT NOT NULL,
        assignee TEXT NOT NULL,
        stage TEXT NOT NULL,
        issueType TEXT NOT NULL,
        createdBy TEXT NOT NULL,
        deletedBy TEXT NOT NULL,
        deleteReason TEXT NOT NULL,
        risk TEXT NOT NULL,
        effort TEXT NOT NULL,
        githubIssueNumber INTEGER,
        githubIssueId INTEGER,
        githubIssueUpdatedAt TEXT,
        needsProducerReview INTEGER NOT NULL DEFAULT 0
      )
    `);
    rawDb.close();

    const result = runMigrations({ confirm: true }, dbPath);
    expect(result.applied.some(m => m.id === '20260314-add-audit')).toBe(true);
    expect(result.backups.length).toBe(1);

    // Verify the column was added
    const db2 = new Database(dbPath, { readonly: true });
    const cols = db2.prepare(`PRAGMA table_info('workitems')`).all() as any[];
    db2.close();
    const colNames = new Set(cols.map((c: any) => String(c.name)));
    expect(colNames.has('audit')).toBe(true);
  });

  it('dry-run returns pending migrations without applying them', () => {
    const dbPath = path.join(tempDir, 'dry.db');
    const rawDb = new Database(dbPath);
    rawDb.exec(`CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    rawDb.exec(`INSERT INTO metadata (key, value) VALUES ('schemaVersion', '6')`);
    rawDb.exec(`
      CREATE TABLE workitems (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
        status TEXT NOT NULL, priority TEXT NOT NULL, sortIndex INTEGER NOT NULL DEFAULT 0,
        parentId TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        tags TEXT NOT NULL, assignee TEXT NOT NULL, stage TEXT NOT NULL,
        issueType TEXT NOT NULL, createdBy TEXT NOT NULL, deletedBy TEXT NOT NULL,
        deleteReason TEXT NOT NULL, risk TEXT NOT NULL, effort TEXT NOT NULL,
        githubIssueNumber INTEGER, githubIssueId INTEGER, githubIssueUpdatedAt TEXT,
        needsProducerReview INTEGER NOT NULL DEFAULT 0
      )
    `);
    rawDb.close();

    const result = runMigrations({ dryRun: true }, dbPath);
    expect(result.applied.some(m => m.id === '20260314-add-audit')).toBe(true);
    expect(result.backups.length).toBe(0); // no backup in dry-run

    // Column must NOT have been added
    const db2 = new Database(dbPath, { readonly: true });
    const cols = db2.prepare(`PRAGMA table_info('workitems')`).all() as any[];
    db2.close();
    const colNames = new Set(cols.map((c: any) => String(c.name)));
    expect(colNames.has('audit')).toBe(false);
  });

  it('is idempotent: applying audit migration twice does not throw', () => {
    const dbPath = path.join(tempDir, 'idem.db');
    const rawDb = new Database(dbPath);
    rawDb.exec(`CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    rawDb.exec(`INSERT INTO metadata (key, value) VALUES ('schemaVersion', '6')`);
    rawDb.exec(`
      CREATE TABLE workitems (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
        status TEXT NOT NULL, priority TEXT NOT NULL, sortIndex INTEGER NOT NULL DEFAULT 0,
        parentId TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        tags TEXT NOT NULL, assignee TEXT NOT NULL, stage TEXT NOT NULL,
        issueType TEXT NOT NULL, createdBy TEXT NOT NULL, deletedBy TEXT NOT NULL,
        deleteReason TEXT NOT NULL, risk TEXT NOT NULL, effort TEXT NOT NULL,
        githubIssueNumber INTEGER, githubIssueId INTEGER, githubIssueUpdatedAt TEXT,
        needsProducerReview INTEGER NOT NULL DEFAULT 0
      )
    `);
    rawDb.close();

    runMigrations({ confirm: true }, dbPath);
    // Second run should be a no-op (column already present)
    const result2 = runMigrations({ confirm: true }, dbPath);
    // No new migrations applied
    expect(result2.applied.some(m => m.id === '20260314-add-audit')).toBe(false);
  });
});
