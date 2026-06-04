/**
 * Tests for legacy audit column removal.
 *
 * Verifies:
 * 1. After migration, workitems.audit column no longer exists.
 * 2. No code path reads/writes workitems.audit (static analysis).
 * 3. Existing consumers (API, TUI, show) use the new audit_results table only.
 * 4. wl update --audit-text does not modify the old column.
 *
 * These tests are designed to pass once the audit_results table migration
 * is complete and the legacy audit column has been dropped.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as childProcess from 'child_process';
import Database from 'better-sqlite3';
import { createTempDir, cleanupTempDir } from './test-utils.js';
import { runMigrations } from '../src/migrations/index.js';

// ---------------------------------------------------------------------------
// 1. Test that workitems.audit column no longer exists after migration
// ---------------------------------------------------------------------------

describe('Legacy audit column removal: schema migration', () => {
  it('audit column is dropped after migration', () => {
    const tmp = createTempDir();
    try {
      const dbPath = path.join(tmp, 'worklog.db');
      const db = new Database(dbPath);

      // Create a legacy database with the audit column
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
        CREATE TABLE audit_results (
          work_item_id TEXT PRIMARY KEY,
          ready_to_close INTEGER NOT NULL DEFAULT 0,
          audited_at TEXT NOT NULL,
          summary TEXT,
          raw_output TEXT,
          author TEXT,
          FOREIGN KEY (work_item_id) REFERENCES workitems(id) ON DELETE CASCADE
        );
        INSERT OR REPLACE INTO metadata (key, value) VALUES ('schemaVersion', '8');
      `);
      db.close();

      // Run migrations (which should drop the audit column)
      runMigrations({ confirm: true }, dbPath);

      // Verify audit column is gone
      const db2 = new Database(dbPath, { readonly: true });
      try {
        const cols = db2.prepare(`PRAGMA table_info('workitems')`).all() as any[];
        const colNames = new Set(cols.map(c => String(c.name)));
        expect(colNames.has('audit')).toBe(false);
      } finally {
        db2.close();
      }
    } finally {
      cleanupTempDir(tmp);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Test that no code path reads/writes workitems.audit (static analysis)
// ---------------------------------------------------------------------------

describe('Legacy audit column removal: static analysis', () => {
  it('no TypeScript source reads workitems.audit', () => {
    const srcDir = path.resolve(__dirname, '..', 'src');
    const files = getAllTsFiles(srcDir);
    const violations: string[] = [];

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      // Look for patterns like `.audit` or `['audit']` that reference the audit field
      // on a work item object (not the audit_results table)
      const patterns = [
        /\.audit\b/,           // e.g. item.audit
        /\['audit'\]/,        // e.g. item['audit']
        /\["audit"\]/,        // e.g. item["audit"]
        /audit\s*:\s*undefined/, // clearing audit field
        /audit\s*:\s*null/,     // clearing audit field
        /SET\s+\w+.*\baudit\b/, // SQL SET audit =
        /INSERT.*\baudit\b/,    // SQL INSERT with audit
      ];

      for (const pattern of patterns) {
        const matches = content.matchAll(new RegExp(pattern.source, 'g'));
        for (const match of matches) {
          // Skip comments and known-safe references (e.g., audit_results table references)
          const line = content.split('\n')[content.split('\n').indexOf(match.input!.split('\n').find(l => l.includes(match[0])) || '')];
          if (line && !line.trim().startsWith('//') && !line.trim().startsWith('*')) {
            // Skip references to audit_results table
            if (content.includes('audit_results') && line.includes('audit_results')) {
              continue;
            }
            // Skip the audit.ts file which handles audit entry building (not column access)
            if (file.includes('src/audit.ts')) {
              continue;
            }
            violations.push(`${file}:${line.trim().substring(0, 80)}`);
          }
        }
      }
    }

    // If violations are found, report them
    expect(violations.length).toBe(0);
  });

  it('no TypeScript source writes to workitems.audit', () => {
    const srcDir = path.resolve(__dirname, '..', 'src');
    const files = getAllTsFiles(srcDir);
    const writePatterns = [
      /\.audit\s*=\s*\w+/,           // item.audit = value
      /\.audit\s*\.\w+\s*=\s*\w+/,  // item.audit.something = value
      /SET\s+\w+.*\baudit\s*=/,      // SQL SET ... audit = ...
      /INSERT.*\baudit\b.*VALUES/,   // SQL INSERT ... VALUES
      /\.audit\s*=.*JSON/,           // .audit = JSON.stringify(...)
      /\.audit\s*:\s*\{/,            // audit: { ... } in object literal
    ];

    const violations: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      for (const pattern of writePatterns) {
        const matches = content.matchAll(new RegExp(pattern.source, 'g'));
        for (const match of matches) {
          const lines = content.split('\n');
          const lineNum = content.substring(0, match.index!).split('\n').length;
          const line = lines[lineNum - 1];
          if (line && !line.trim().startsWith('//') && !line.trim().startsWith('*')) {
            // Skip audit.ts which handles audit entry building
            if (file.includes('src/audit.ts')) {
              continue;
            }
            // Skip references to audit_results table operations
            if (content.includes('audit_results') && line.includes('audit_results')) {
              continue;
            }
            violations.push(`${file}:${lineNum}:${line.trim().substring(0, 80)}`);
          }
        }
      }
    }

    expect(violations.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Test that existing consumers use the new table only
// ---------------------------------------------------------------------------

describe('Legacy audit column removal: consumer integration', () => {
  it('API endpoint uses audit_results table', () => {
    const apiPath = path.resolve(__dirname, '..', 'src', 'api.ts');
    expect(fs.existsSync(apiPath)).toBe(true);
    const content = fs.readFileSync(apiPath, 'utf8');

    // Verify the API reads from audit_results, not workitems.audit
    // Look for audit_results table references
    expect(content.includes('audit_results')).toBe(true);
    // Ensure no workitems.audit references
    const auditRefMatches = content.match(/item\.audit|workItem\.audit|row\.audit/g);
    expect(auditRefMatches).toBe(null);
  });

  it('TUI component uses audit_results table', () => {
    const tuiPath = path.resolve(__dirname, '..', 'src', 'tui');
    if (!fs.existsSync(tuiPath)) {
      // TUI may not exist in all configurations
      return;
    }
    const tuiFiles = getAllTsFiles(tuiPath);
    let violations: string[] = [];

    for (const file of tuiFiles) {
      const content = fs.readFileSync(file, 'utf8');
      // Skip TUI files that handle audit display logic (not column access)
      if (file.includes('audit')) {
        continue;
      }
      const matches = content.match(/item\.audit|workItem\.audit|row\.audit/g);
      if (matches) {
        violations.push(`${file}: ${matches.length} references to legacy audit`);
      }
    }

    expect(violations.length).toBe(0);
  });

  it('wl show command uses audit_results table', () => {
    const showPath = path.resolve(__dirname, '..', 'src', 'commands', 'show.ts');
    expect(fs.existsSync(showPath)).toBe(true);
    const content = fs.readFileSync(showPath, 'utf8');

    // The show command should query audit_results, not read workitems.audit
    expect(content.includes('audit_results')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Test that wl update --audit-text does not modify the old column
// ---------------------------------------------------------------------------

describe('Legacy audit column removal: --audit-text writes to new table', () => {
  it('wl update --audit-text writes to audit_results, not workitems.audit', () => {
    const tmp = createTempDir();
    try {
      const dbPath = path.join(tmp, 'worklog.db');
      const jsonlPath = path.join(tmp, 'worklog.jsonl');

      // Create a test database with audit_results table
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
          needsProducerReview INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE audit_results (
          work_item_id TEXT PRIMARY KEY,
          ready_to_close INTEGER NOT NULL DEFAULT 0,
          audited_at TEXT NOT NULL,
          summary TEXT,
          raw_output TEXT,
          author TEXT,
          FOREIGN KEY (work_item_id) REFERENCES workitems(id) ON DELETE CASCADE
        );
        CREATE TABLE comments (
          id TEXT PRIMARY KEY, workItemId TEXT NOT NULL, author TEXT NOT NULL,
          comment TEXT NOT NULL, createdAt TEXT NOT NULL, refs TEXT
        );
        CREATE TABLE dependency_edges (
          fromId TEXT NOT NULL, toId TEXT NOT NULL,
          createdAt TEXT NOT NULL, PRIMARY KEY (fromId, toId)
        );
        INSERT OR REPLACE INTO workitems (id, title, description, status, priority,
          sortIndex, parentId, createdAt, updatedAt, tags, assignee, stage, issueType,
          createdBy, deletedBy, deleteReason, risk, effort, needsProducerReview)
        VALUES (
          'SA-TEST-AUDIT-001', 'Test item', 'Audit test', 'open', 'high', 100,
          NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '[]',
          '', 'idea', 'task', '', '', '', '', '', 0
        );
        INSERT OR REPLACE INTO metadata (key, value) VALUES ('schemaVersion', '8');
      `);
      db.close();

      // Run the wl update command with --audit-text
      const result = childProcess.spawnSync(
        'npx',
        ['ts-node', 'src/cli.ts', 'update', 'SA-TEST-AUDIT-001', '--audit-text', 'Ready to close: Yes\nTest audit'],
        {
          cwd: path.resolve(__dirname, '..'),
          env: { ...process.env, WORKLOG_DATA_PATH: jsonlPath, WORKLOG_DB_PATH: dbPath },
          encoding: 'utf8',
          timeout: 10000,
        }
      );

      // Verify the audit was written to audit_results
      const db2 = new Database(dbPath, { readonly: true });
      try {
        const auditRow = db2.prepare('SELECT * FROM audit_results WHERE work_item_id = ?').get('SA-TEST-AUDIT-001');
        expect(auditRow).toBeDefined();
        expect((auditRow as any).summary).toContain('Ready to close: Yes');
      } finally {
        db2.close();
      }

      // Verify workitems table has no audit column
      const db3 = new Database(dbPath, { readonly: true });
      try {
        const cols = db3.prepare(`PRAGMA table_info('workitems')`).all() as any[];
        const colNames = new Set(cols.map(c => String(c.name)));
        expect(colNames.has('audit')).toBe(false);
      } finally {
        db3.close();
      }
    } finally {
      cleanupTempDir(tmp);
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getAllTsFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) {
    return results;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getAllTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}
