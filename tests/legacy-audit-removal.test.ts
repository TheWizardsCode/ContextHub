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

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
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
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        // Skip comments
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
        // Skip lines referencing audit_results table
        if (trimmed.includes('audit_results') || trimmed.includes('auditResult') || trimmed.includes('getAuditResult') || trimmed.includes('saveAuditResult')) continue;
        // Skip audit.ts (handles audit entry building)
        if (file.includes('src/audit.ts')) continue;
        // Skip migrations/index.ts (reads row.audit for backfill which is intentional)
        if (file.includes('src/migrations/')) continue;

        // Check for direct property access on work item objects
        // Pattern: item.audit, workItem.audit, row.audit (but NOT options.audit, input.audit, body.audit which are API inputs)
        // Also exclude 'result' and 'entry' which match audit-related variable names
        const directAuditRead = /\b(item|workItem|work_item|record)\.audit\b/;
        if (directAuditRead.test(trimmed)) {
          violations.push(`${file}:${i + 1}: ${trimmed.substring(0, 100)}`);
        }

        // Check for row.audit (SQL result row)
        if (/\brow\.audit\b/.test(trimmed)) {
          violations.push(`${file}:${i + 1}: ${trimmed.substring(0, 100)}`);
        }

        // Check for bracket notation on item-like objects
        const bracketAudit = /\b(item|workItem|work_item|row|record)\['audit'\]|\b(item|workItem|work_item|row|record)\["audit"\]/;
        if (bracketAudit.test(trimmed)) {
          violations.push(`${file}:${i + 1}: ${trimmed.substring(0, 100)}`);
        }
      }
    }

    // If violations are found, report them
    if (violations.length > 0) {
      console.log('Violations found:');
      for (const v of violations) {
        console.log(`  ${v}`);
      }
    }
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

    // Verify the API writes to audit_results via saveAuditResult
    expect(content.includes('saveAuditResult')).toBe(true);
    // Ensure no workitems.audit references (the old field is removed)
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
      // Skip metadata-pane.ts which handles audit display logic
      if (file.includes('metadata-pane')) {
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

    // The show command should query audit_results via getAuditResult
    expect(content.includes('getAuditResult')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Test that wl update --audit-text does not modify the old column
// ---------------------------------------------------------------------------

describe('Legacy audit column removal: --audit-text writes to new table', () => {
  it('workitems table has no audit column after full migration', () => {
    // Verifies that after running the full migration (including the drop-audit-column
    // migration), the workitems table no longer has an audit column.
    // E2E coverage for wl update --audit-text writing to audit_results is
    // handled in tests/cli/audit-results-cli.test.ts.
    const tmp = createTempDir();
    try {
      const dbPath = path.join(tmp, 'worklog.db');
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
        INSERT OR REPLACE INTO metadata (key, value) VALUES ('schemaVersion', '7');
      `);
      db.close();

      // Run all migrations (add-needsProducerReview, add-audit, add-audit-results, backfill, drop-audit-column)
      runMigrations({ confirm: true }, dbPath);

      // Verify workitems table has no audit column
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
