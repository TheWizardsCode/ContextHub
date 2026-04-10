import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import Database from 'better-sqlite3';
import {
  cliPath,
  execAsync,
  enterTempDir,
  leaveTempDir,
  writeConfig,
  writeInitSemaphore,
} from './cli-helpers.js';

function createLegacyDbWithoutAudit(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workitems (
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
      );
      INSERT OR REPLACE INTO metadata (key, value) VALUES ('schemaVersion', '6');
    `);
  } finally {
    db.close();
  }
}

describe('doctor upgrade command', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);

    const dbPath = path.join(tempState.tempDir, '.worklog', 'worklog.db');
    createLegacyDbWithoutAudit(dbPath);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  it('keeps --dry-run JSON as preview-only', async () => {
    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor upgrade --dry-run`);
    const result = JSON.parse(stdout);

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.pending.some((m: any) => m.id === '20260315-add-audit')).toBe(true);
  });

  it('applies migrations with --confirm --json and returns applied metadata', async () => {
    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor upgrade --confirm`);
    const result = JSON.parse(stdout);

    expect(result.success).toBe(true);
    expect(Array.isArray(result.applied)).toBe(true);
    expect(result.applied.some((m: any) => m.id === '20260315-add-audit')).toBe(true);
    expect(Array.isArray(result.backups)).toBe(true);
    expect(result.backups.length).toBeGreaterThan(0);

    const dbPath = path.join(tempState.tempDir, '.worklog', 'worklog.db');
    const db = new Database(dbPath, { readonly: true });
    try {
      const cols = db.prepare(`PRAGMA table_info('workitems')`).all() as Array<{ name: string }>;
      expect(cols.map(c => c.name)).toContain('audit');
    } finally {
      db.close();
    }
  });
});
