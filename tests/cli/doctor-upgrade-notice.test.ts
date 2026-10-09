/**
 * Tests for the top-level `wl doctor` pending-upgrade notice
 * (WL-0MUTVB271007YKJZ).
 *
 * Verifies that `wl doctor` surfaces pending `wl doctor upgrade` work
 * (schema migrations and outdated git hooks) in both human and JSON modes,
 * while remaining read-only and preserving the existing exit-code and
 * JSON-purity contracts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import Database from 'better-sqlite3';
import {
  cliPath,
  execAsync,
  execWithInput,
  enterTempDir,
  leaveTempDir,
  writeConfig,
  writeInitSemaphore,
} from './cli-helpers.js';

/**
 * Create a legacy database missing the columns/sentinels that current
 * migrations expect, so `listPendingMigrations()` reports pending work while
 * the status/stage validation of an empty database stays clean.
 */
function createLegacyDb(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
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

const OUTDATED_PRE_PUSH = `#!/bin/sh
# worklog:pre-push-hook:v1
# Auto-sync Worklog data before pushing (outdated copy).
set -e
if [ "$WORKLOG_SKIP_PRE_PUSH" = "1" ]; then
  exit 0
fi
$WL sync --git-branch refs/worklog/data
exit 0
`;

const CURRENT_PRE_PUSH = `#!/bin/sh
# worklog:pre-push-hook:v2
# Auto-sync Worklog data before pushing (current copy).
set -e
if [ "$WORKLOG_SKIP_PRE_PUSH" = "1" ]; then
  exit 0
fi
if [ "$(git rev-parse --git-dir 2>/dev/null)" != "$(git rev-parse --git-common-dir 2>/dev/null)" ]; then
  exit 0
fi
"$WL" sync --git-branch refs/worklog/data
exit 0
`;

/** Install an outdated worklog pre-push hook plus its committed counterpart. */
function createOutdatedHook(dir: string): void {
  const gitHooks = path.join(dir, '.git', 'hooks');
  const githooks = path.join(dir, '.githooks');
  fs.mkdirSync(gitHooks, { recursive: true });
  fs.mkdirSync(githooks, { recursive: true });
  fs.writeFileSync(path.join(githooks, 'pre-push'), CURRENT_PRE_PUSH, { mode: 0o755 });
  fs.writeFileSync(path.join(gitHooks, 'pre-push'), OUTDATED_PRE_PUSH, { mode: 0o755 });
}

function removeHooks(dir: string): void {
  try { fs.rmSync(path.join(dir, '.githooks'), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join(dir, '.git', 'hooks', 'pre-push'), { force: true }); } catch {}
}

describe('wl doctor pending-upgrade notice', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
    createLegacyDb(path.join(tempState.tempDir, '.worklog', 'worklog.db'));
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  it('reports pending migrations and instructs `wl doctor upgrade`', async () => {
    const { stdout } = await execAsync(`tsx ${cliPath} doctor`);

    expect(stdout).toContain('Doctor: pending upgrades detected.');
    expect(stdout).toContain('Pending migrations');
    expect(stdout).toContain('20260315-add-audit');
    expect(stdout).toContain('wl doctor upgrade');
    // Must not present a misleading all-clear as the only output (AC2).
    expect(stdout).not.toContain('Doctor: no issues found.');
  });

  it('reports outdated git hooks and instructs `wl doctor upgrade`', async () => {
    createOutdatedHook(tempState.tempDir);
    try {
      const { stdout } = await execAsync(`tsx ${cliPath} doctor`);

      expect(stdout).toContain('Doctor: pending upgrades detected.');
      expect(stdout).toContain('Outdated hooks');
      expect(stdout).toContain('pre-push');
      expect(stdout).toContain('wl doctor upgrade');
    } finally {
      removeHooks(tempState.tempDir);
    }
  });

  it('reports nothing extra when fully up to date', async () => {
    // Apply pending migrations so the database (and hooks) are up to date.
    await execAsync(`tsx ${cliPath} doctor upgrade --confirm`);

    const { stdout } = await execAsync(`tsx ${cliPath} doctor`);

    expect(stdout).toContain('Doctor: no issues found.');
    expect(stdout).not.toContain('pending upgrades detected');
    expect(stdout).not.toContain('Pending migrations');
  });

  it('emits valid single-document JSON carrying pending-upgrade data', async () => {
    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor`);
    const trimmed = stdout.trim();

    // JSON purity: no preamble or trailing text.
    expect(trimmed[0]).toBe('[');
    expect(trimmed[trimmed.length - 1]).toBe(']');

    const findings = JSON.parse(trimmed);
    expect(Array.isArray(findings)).toBe(true);

    const pending = findings.find((f: any) => f.checkId === 'upgrade.pending');
    expect(pending).toBeDefined();
    expect(pending.type).toBe('pending-upgrade');
    expect(pending.itemId).toBeNull();
    expect(pending.message).toContain('wl doctor upgrade');
    expect(pending.context.pendingMigrationCount).toBeGreaterThan(0);
    expect(
      pending.context.pendingMigrations.some((m: any) => m.id === '20260315-add-audit'),
    ).toBe(true);
    expect(pending.context.outdatedHookCount).toBe(0);
    expect(Array.isArray(pending.context.outdatedHooks)).toBe(true);
  });

  it('exits 0 when only pending upgrades are found', async () => {
    const { stdout, exitCode } = await execWithInput(`tsx ${cliPath} doctor`, '');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Doctor: pending upgrades detected.');
  });

  it('carries outdated hook details in JSON', async () => {
    createOutdatedHook(tempState.tempDir);
    try {
      const { stdout } = await execAsync(`tsx ${cliPath} --json doctor`);
      const findings = JSON.parse(stdout.trim());
      const pending = findings.find((f: any) => f.checkId === 'upgrade.pending');

      expect(pending).toBeDefined();
      expect(pending.context.outdatedHookCount).toBe(1);
      expect(pending.context.outdatedHooks).toContain('pre-push');
    } finally {
      removeHooks(tempState.tempDir);
    }
  });
});
