/**
 * Tests for the audit_results table schema and migration.
 *
 * Verifies:
 * 1. audit_results table is created with correct columns (work_item_id TEXT PK,
 *    ready_to_close INTEGER, audited_at TEXT, summary TEXT, raw_output TEXT,
 *    author TEXT).
 * 2. Foreign key references workitems(id) with CASCADE DELETE.
 * 3. `wl doctor upgrade --dry-run` lists the new migration.
 * 4. `wl doctor upgrade --confirm` applies migration (backup + table created).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { createTempDir, cleanupTempDir } from './test-utils.js';
import { listPendingMigrations, runMigrations } from '../src/migrations/index.js';

function createLegacyDbWithoutAuditResults(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workitems (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
        status TEXT NOT NULL, priority TEXT NOT NULL, sortIndex INTEGER NOT NULL DEFAULT 0,
        parentId TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        tags TEXT NOT NULL, assignee TEXT NOT NULL, stage TEXT NOT NULL,
        issueType TEXT NOT NULL, createdBy TEXT NOT NULL, deletedBy TEXT NOT NULL,
        deleteReason TEXT NOT NULL, risk TEXT NOT NULL, effort TEXT NOT NULL,
        githubIssueNumber INTEGER, githubIssueId INTEGER, githubIssueUpdatedAt TEXT,
        needsProducerReview INTEGER NOT NULL DEFAULT 0, audit TEXT
      );
      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY, workItemId TEXT NOT NULL, author TEXT NOT NULL,
        comment TEXT NOT NULL, createdAt TEXT NOT NULL, refs TEXT
      );
      CREATE TABLE IF NOT EXISTS dependency_edges (
        fromId TEXT NOT NULL, toId TEXT NOT NULL,
        createdAt TEXT NOT NULL, PRIMARY KEY (fromId, toId)
      );
      INSERT OR REPLACE INTO workitems (id, title, description, status, priority,
        sortIndex, parentId, createdAt, updatedAt, tags, assignee, stage, issueType,
        createdBy, deletedBy, deleteReason, risk, effort, needsProducerReview)
      VALUES (
        'SA-TEST-001', 'Test item', 'A test work item', 'open', 'high', 100,
        NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '[]',
        '', 'idea', 'task', '', '', '', '', '', 0
      );
      INSERT OR REPLACE INTO metadata (key, value) VALUES ('schemaVersion', '7');
    `);
  } finally {
    db.close();
  }
}

function getCols(dbPath: string): Array<{ name: string; type: string; notnull: number; dflt_value: unknown; pk: number }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(`PRAGMA table_info('audit_results')`).all() as any[];
  } finally {
    db.close();
  }
}

function getFks(dbPath: string): Array<{ from: string; to: string; table: string; on_delete: string }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(`PRAGMA foreign_key_list('audit_results')`).all() as any[];
  } finally {
    db.close();
  }
}

describe('audit_results table: schema DDL', () => {
  it('creates all expected columns after migration', () => {
    const tmp = createTempDir();
    try {
      const dbPath = path.join(tmp, 'worklog.db');
      createLegacyDbWithoutAuditResults(dbPath);
      runMigrations({ confirm: true }, dbPath);
      const cols = getCols(dbPath).map(c => c.name);
      expect(cols).toContain('work_item_id');
      expect(cols).toContain('ready_to_close');
      expect(cols).toContain('audited_at');
      expect(cols).toContain('summary');
      expect(cols).toContain('raw_output');
      expect(cols).toContain('author');
    } finally {
      cleanupTempDir(tmp);
    }
  });

  it('work_item_id is TEXT PRIMARY KEY', () => {
    const tmp = createTempDir();
    try {
      const dbPath = path.join(tmp, 'worklog.db');
      createLegacyDbWithoutAuditResults(dbPath);
      runMigrations({ confirm: true }, dbPath);
      const cols = getCols(dbPath);
      const col = cols.find(c => c.name === 'work_item_id');
      expect(col).toBeDefined();
      expect(col!.pk).toBe(1);
      expect(col!.type.toUpperCase()).toBe('TEXT');
    } finally {
      cleanupTempDir(tmp);
    }
  });

  it('ready_to_close is INTEGER NOT NULL DEFAULT 0', () => {
    const tmp = createTempDir();
    try {
      const dbPath = path.join(tmp, 'worklog.db');
      createLegacyDbWithoutAuditResults(dbPath);
      runMigrations({ confirm: true }, dbPath);
      const cols = getCols(dbPath);
      const col = cols.find(c => c.name === 'ready_to_close');
      expect(col).toBeDefined();
      expect(col!.type.toUpperCase()).toBe('INTEGER');
      expect(col!.notnull).toBe(1);
      expect(col!.dflt_value).toBe(0);
    } finally {
      cleanupTempDir(tmp);
    }
  });

  it('audited_at is TEXT NOT NULL', () => {
    const tmp = createTempDir();
    try {
      const dbPath = path.join(tmp, 'worklog.db');
      createLegacyDbWithoutAuditResults(dbPath);
      runMigrations({ confirm: true }, dbPath);
      const cols = getCols(dbPath);
      const col = cols.find(c => c.name === 'audited_at');
      expect(col).toBeDefined();
      expect(col!.type.toUpperCase()).toBe('TEXT');
      expect(col!.notnull).toBe(1);
    } finally {
      cleanupTempDir(tmp);
    }
  });

  it('summary is TEXT nullable', () => {
    const tmp = createTempDir();
    try {
      const dbPath = path.join(tmp, 'worklog.db');
      createLegacyDbWithoutAuditResults(dbPath);
      runMigrations({ confirm: true }, dbPath);
      const cols = getCols(dbPath);
      const col = cols.find(c => c.name === 'summary');
      expect(col).toBeDefined();
      expect(col!.type.toUpperCase()).toBe('TEXT');
      expect(col!.notnull).toBe(0);
    } finally {
      cleanupTempDir(tmp);
    }
  });

  it('raw_output is TEXT nullable', () => {
    const tmp = createTempDir();
    try {
      const dbPath = path.join(tmp, 'worklog.db');
      createLegacyDbWithoutAuditResults(dbPath);
      runMigrations({ confirm: true }, dbPath);
      const cols = getCols(dbPath);
      const col = cols.find(c => c.name === 'raw_output');
      expect(col).toBeDefined();
      expect(col!.type.toUpperCase()).toBe('TEXT');
      expect(col!.notnull).toBe(0);
    } finally {
      cleanupTempDir(tmp);
    }
  });

  it('author is TEXT nullable', () => {
    const tmp = createTempDir();
    try {
      const dbPath = path.join(tmp, 'worklog.db');
      createLegacyDbWithoutAuditResults(dbPath);
      runMigrations({ confirm: true }, dbPath);
      const cols = getCols(dbPath);
      const col = cols.find(c => c.name === 'author');
      expect(col).toBeDefined();
      expect(col!.type.toUpperCase()).toBe('TEXT');
      expect(col!.notnull).toBe(0);
    } finally {
      cleanupTempDir(tmp);
    }
  });
});

describe('audit_results table: foreign key constraints', () => {
  it('references workitems(id) with CASCADE DELETE', () => {
    const tmp = createTempDir();
    try {
      const dbPath = path.join(tmp, 'worklog.db');
      createLegacyDbWithoutAuditResults(dbPath);
      runMigrations({ confirm: true }, dbPath);
      const fks = getFks(dbPath);
      expect(fks.length).toBeGreaterThan(0);
      const fk = fks.find(f => f.from === 'work_item_id');
      expect(fk).toBeDefined();
      expect(fk!.table).toBe('workitems');
      expect(fk!.to).toBe('id');
      expect(fk!.on_delete.toUpperCase()).toBe('CASCADE');
    } finally {
      cleanupTempDir(tmp);
    }
  });

  it('cascading delete on workitems removes audit_results rows', () => {
    const tmp = createTempDir();
    try {
      const dbPath = path.join(tmp, 'worklog.db');
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS workitems (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL, priority TEXT NOT NULL, sortIndex INTEGER NOT NULL DEFAULT 0, parentId TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, tags TEXT NOT NULL, assignee TEXT NOT NULL, stage TEXT NOT NULL, issueType TEXT NOT NULL, createdBy TEXT NOT NULL, deletedBy TEXT NOT NULL, deleteReason TEXT NOT NULL, risk TEXT NOT NULL, effort TEXT NOT NULL, githubIssueNumber INTEGER, githubIssueId INTEGER, githubIssueUpdatedAt TEXT, needsProducerReview INTEGER NOT NULL DEFAULT 0, audit TEXT);
        CREATE TABLE IF NOT EXISTS audit_results (work_item_id TEXT PRIMARY KEY, ready_to_close INTEGER NOT NULL DEFAULT 0, audited_at TEXT NOT NULL, summary TEXT, raw_output TEXT, author TEXT, FOREIGN KEY (work_item_id) REFERENCES workitems(id) ON DELETE CASCADE);
        INSERT OR REPLACE INTO workitems (id, title, description, status, priority, sortIndex, parentId, createdAt, updatedAt, tags, assignee, stage, issueType, createdBy, deletedBy, deleteReason, risk, effort, needsProducerReview) VALUES ('SA-CASC-001', 'Cascade', 'test', 'open', 'high', 100, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '[]', '', 'idea', 'task', '', '', '', '', '', 0);
        INSERT OR REPLACE INTO audit_results (work_item_id, ready_to_close, audited_at, summary, raw_output, author) VALUES ('SA-CASC-001', 1, '2026-05-01T00:00:00.000Z', 'ready', NULL, 'test');
      `);
      db.close();
      const db2 = new Database(dbPath, { readonly: false });
      db2.exec('PRAGMA foreign_keys = ON');
      db2.exec("DELETE FROM workitems WHERE id = 'SA-C
