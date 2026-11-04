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

function createGitRepo(dir: string): void {
  // Create a minimal git repo
  fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
  // Initialize git
  const { execSync } = require('child_process');
  try {
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
    // Create initial commit
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n', 'utf-8');
    execSync('git add .', { cwd: dir, stdio: 'pipe' });
    execSync('git commit -m "initial"', { cwd: dir, stdio: 'pipe' });
  } catch (_e) {
    // git may not be available in test environment; skip
  }
}

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

function createLegacyDbWithAuditText(dbPath: string, rows: Array<{ id: string; audit: string }>): void {
  fs.rmSync(dbPath, { force: true });
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
        needsProducerReview INTEGER NOT NULL DEFAULT 0,
        audit TEXT
      );
      INSERT OR REPLACE INTO metadata (key, value) VALUES ('schemaVersion', '6');
    `);
    const insert = db.prepare(
      `INSERT INTO workitems (id, title, description, status, priority, sortIndex, parentId,
         createdAt, updatedAt, tags, assignee, stage, issueType, createdBy, deletedBy,
         deleteReason, risk, effort, audit)
       VALUES (?, ?, 'd', 'open', 'high', 100, NULL, '2026-01-01T00:00:00.000Z',
         '2026-01-01T00:00:00.000Z', '[]', '', 'idea', 'task', '', '', '', '', '', ?)`,
    );
    for (const row of rows) insert.run(row.id, `Item ${row.id}`, row.audit);
  } finally {
    db.close();
  }
}

const LEGACY_MAPPED_AUDIT = JSON.stringify({
  time: '2026-05-01T10:00:00.000Z',
  author: 'alice',
  text: 'Ready to close: Yes',
  status: 'Complete',
});

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
      // After all migrations, audit column should be dropped in favor of audit_results table
      expect(cols.map(c => c.name)).not.toContain('audit');
      // needsProducerReview is RESTORED (WL-0MVAMS4RO000H3B0 F2): the wrongful
      // removal (WL-0MV85WFYU0071YQ9 / RCA WL-0MVAOYBZM0065AEN) was reverted;
      // the column must be present after migrating.
      expect(cols.map(c => c.name)).toContain('needsProducerReview');
      // audit_results table should exist
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_results'").all() as any[];
      expect(tables.length).toBe(1);
    } finally {
      db.close();
    }
  });

  describe('legacy audit text blast radius (WL-0MW1W61CG005K893)', () => {
    const dbPath = () => path.join(tempState.tempDir, '.worklog', 'worklog.db');

    beforeEach(() => {
      createLegacyDbWithAuditText(dbPath(), [
        { id: 'TEST-MAPPED', audit: LEGACY_MAPPED_AUDIT },
        { id: 'TEST-UNMAPPABLE', audit: 'legacy notes that are not JSON' },
      ]);
    });

    it('reports the preservation summary in --dry-run JSON', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json doctor upgrade --dry-run`);
      const result = JSON.parse(stdout);

      expect(result.success).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(result.preservation).toEqual({
        candidates: 2,
        mappedToAuditResult: 0,
        preserveOnly: 2,
        alreadyPreserved: 0,
        orphaned: 2,
      });

      // Preview only: nothing was applied and the column is still there.
      const db = new Database(dbPath(), { readonly: true });
      try {
        const cols = db.prepare(`PRAGMA table_info('workitems')`).all() as Array<{ name: string }>;
        expect(cols.map(c => c.name)).toContain('audit');
      } finally {
        db.close();
      }
    });

    it('reports the preservation summary in --confirm JSON and preserves every value', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json doctor upgrade --confirm`);
      const result = JSON.parse(stdout);

      expect(result.success).toBe(true);
      // The same blast radius the dry-run showed is reported by the applying run.
      expect(result.preservation).toEqual({
        candidates: 2,
        mappedToAuditResult: 0,
        preserveOnly: 2,
        alreadyPreserved: 0,
        orphaned: 2,
      });
      expect(result.applied.some((m: any) => m.id === '20260604-drop-audit-column')).toBe(true);

      const db = new Database(dbPath(), { readonly: true });
      try {
        // The unmappable text survives verbatim; the parseable one is mapped.
        const preserved = db
          .prepare('SELECT work_item_id, audit_text FROM legacy_audit_preserved')
          .all() as Array<{ work_item_id: string; audit_text: string }>;
        expect(preserved).toEqual([
          { work_item_id: 'TEST-UNMAPPABLE', audit_text: 'legacy notes that are not JSON' },
        ]);
        const mapped = db
          .prepare('SELECT raw_output FROM audit_results WHERE work_item_id = ?')
          .get('TEST-MAPPED') as any;
        expect(mapped.raw_output).toBe(LEGACY_MAPPED_AUDIT);
      } finally {
        db.close();
      }
    });

    it('emits the same summary in human output before applying', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} doctor upgrade --confirm`);

      expect(stdout).toContain('Legacy audit text (workitems.audit):');
      expect(stdout).toContain(' - items with legacy audit text: 2');
      expect(stdout).toContain(' - already mapped to audit_results: 0');
      expect(stdout).toContain(' - unmappable, preserved verbatim on apply: 2');
      expect(stdout).toContain(' - already preserved in legacy_audit_preserved: 0');
      expect(stdout).toContain(' - orphaned (no successor row yet; the drop preserves these first): 2');

      // ... and it is printed *before* the migrations are applied.
      expect(stdout.indexOf('Legacy audit text (workitems.audit):')).toBeLessThan(
        stdout.indexOf('Applied migrations:'),
      );
    });

    it('carries the preservation summary on the refusal path in JSON', async () => {
      // Fault injection: a preservation store that silently refuses writes, so
      // one legacy value stays orphaned and the drop gate must refuse. This is
      // the only way to reach the refusal through the real CLI — the lossless
      // sweep removes every natural orphan (WL-0MW2F2AC8002BBRV AC2).
      const db = new Database(dbPath());
      try {
        db.exec(`
          CREATE TABLE legacy_audit_preserved (
            work_item_id TEXT PRIMARY KEY,
            audit_text TEXT NOT NULL,
            preserved_at TEXT NOT NULL
          );
          CREATE TRIGGER refuse_preserve
            BEFORE INSERT ON legacy_audit_preserved
            BEGIN SELECT RAISE(IGNORE); END;
        `);
      } finally {
        db.close();
      }

      let failure: any;
      try {
        await execAsync(`tsx ${cliPath} --json doctor upgrade --confirm`);
      } catch (e) {
        failure = e;
      }

      expect(failure, 'the drop must be refused').toBeDefined();
      const result = JSON.parse(failure.stdout);
      expect(result.success).toBe(false);
      expect(result.migrationId).toBe('20260604-drop-audit-column');
      expect(result.offendingIds).toEqual(['TEST-UNMAPPABLE']);
      // The same four-count summary the success paths report.
      expect(result.preservation).toEqual({
        candidates: 2,
        mappedToAuditResult: 0,
        preserveOnly: 2,
        alreadyPreserved: 0,
        orphaned: 2,
      });

      // Nothing was destroyed: the column survives and no marker was written.
      const check = new Database(dbPath(), { readonly: true });
      try {
        const cols = check.prepare(`PRAGMA table_info('workitems')`).all() as Array<{ name: string }>;
        expect(cols.map(c => c.name)).toContain('audit');
        const dropped = check
          .prepare('SELECT value FROM metadata WHERE key = ?')
          .get('audit_column_dropped') as any;
        expect(dropped).toBeUndefined();
      } finally {
        check.close();
      }
    });
  });

  describe('hook upgrade via CLI', () => {
    it('includes hook info in dry-run JSON output', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json doctor upgrade --dry-run`);
      const result = JSON.parse(stdout);

      expect(result.success).toBe(true);
      expect(result.dryRun).toBe(true);
      // Hooks should be present in the output
      expect(result.hooks).toBeDefined();
      expect(result.hooks.outdatedCount).toBeGreaterThanOrEqual(0);
    });

    it('reports outdated hooks when they exist', async () => {
      // Create a git repo with a .githooks/ directory containing a hook
      // and a mismatched hook in .git/hooks/
      const dir = tempState.tempDir;
      const gitHooks = path.join(dir, '.git', 'hooks');
      const githooks = path.join(dir, '.githooks');

      try {
        // Ensure .git/hooks exists
        fs.mkdirSync(gitHooks, { recursive: true });

        // Create .githooks with a fixed pre-push hook
        fs.mkdirSync(githooks, { recursive: true });
        const fixedHook = `#!/bin/sh
# worklog:pre-push-hook:v1
# Force the data branch to refs/worklog/data.
set -e
if [ "$WORKLOG_SKIP_PRE_PUSH" = "1" ]; then
  exit 0
fi
skip=0
while read local_ref local_sha remote_ref remote_sha; do
  if [ "$remote_ref" = "refs/worklog/data" ]; then
    skip=1
  fi
done
if [ "$skip" = "1" ]; then
  exit 0
fi
if command -v wl >/dev/null 2>&1; then
  WL=wl
elif command -v worklog >/dev/null 2>&1; then
  WL=worklog
else
  echo "worklog: wl/worklog not found; skipping pre-push sync" >&2
  exit 0
fi
"$WL" sync --git-branch refs/worklog/data
exit 0
`;

        // Create an outdated pre-push hook in .git/hooks/
        const outdatedHook = `#!/bin/sh
# worklog:pre-push-hook:v1
# Auto-sync Worklog data before pushing.
set -e
if [ "$WORKLOG_SKIP_PRE_PUSH" = "1" ]; then
  exit 0
fi
skip=0
while read local_ref local_sha remote_ref remote_sha; do
  if [ "$remote_ref" = "refs/worklog/data" ]; then
    skip=1
  fi
done
if [ "$skip" = "1" ]; then
  exit 0
fi
if command -v wl >/dev/null 2>&1; then
  WL=wl
elif command -v worklog >/dev/null 2>&1; then
  WL=worklog
else
  echo "worklog: wl/worklog not found; skipping pre-push sync" >&2
  exit 0
fi
$WL sync --git-branch refs/worklog/data
exit 0
`;

        fs.writeFileSync(path.join(githooks, 'pre-push'), fixedHook, { mode: 0o755 });
        fs.writeFileSync(path.join(gitHooks, 'pre-push'), outdatedHook, { mode: 0o755 });

        const { stdout } = await execAsync(`tsx ${cliPath} --json doctor upgrade --dry-run`);
        const result = JSON.parse(stdout);

        expect(result.success).toBe(true);
        expect(result.hooks.outdatedCount).toBe(1);
        expect(result.hooks.upgraded).toContain('pre-push');
      } finally {
        // Clean up
        try { fs.rmSync(githooks, { recursive: true, force: true }); } catch {}
        try { fs.rmSync(path.join(gitHooks, 'pre-push'), { force: true }); } catch {}
      }
    });

    it('applies hook upgrades with --confirm and reports them', async () => {
      const dir = tempState.tempDir;
      const gitHooks = path.join(dir, '.git', 'hooks');
      const githooks = path.join(dir, '.githooks');

      try {
        fs.mkdirSync(gitHooks, { recursive: true });
        fs.mkdirSync(githooks, { recursive: true });

        const fixedHook = `#!/bin/sh
# worklog:pre-push-hook:v1
# Force the data branch to refs/worklog/data.
set -e
if [ "$WORKLOG_SKIP_PRE_PUSH" = "1" ]; then
  exit 0
fi
skip=0
while read local_ref local_sha remote_ref remote_sha; do
  if [ "$remote_ref" = "refs/worklog/data" ]; then
    skip=1
  fi
done
if [ "$skip" = "1" ]; then
  exit 0
fi
if command -v wl >/dev/null 2>&1; then
  WL=wl
elif command -v worklog >/dev/null 2>&1; then
  WL=worklog
else
  echo "worklog: wl/worklog not found; skipping pre-push sync" >&2
  exit 0
fi
"$WL" sync --git-branch refs/worklog/data
exit 0
`;

        const outdatedHook = `#!/bin/sh
# worklog:pre-push-hook:v1
# Auto-sync Worklog data before pushing.
set -e
if [ "$WORKLOG_SKIP_PRE_PUSH" = "1" ]; then
  exit 0
fi
skip=0
while read local_ref local_sha remote_ref remote_sha; do
  if [ "$remote_ref" = "refs/worklog/data" ]; then
    skip=1
  fi
done
if [ "$skip" = "1" ]; then
  exit 0
fi
if command -v wl >/dev/null 2>&1; then
  WL=wl
elif command -v worklog >/dev/null 2>&1; then
  WL=worklog
else
  echo "worklog: wl/worklog not found; skipping pre-push sync" >&2
  exit 0
fi
$WL sync --git-branch refs/worklog/data
exit 0
`;

        fs.writeFileSync(path.join(githooks, 'pre-push'), fixedHook, { mode: 0o755 });
        fs.writeFileSync(path.join(gitHooks, 'pre-push'), outdatedHook, { mode: 0o755 });

        // Read old hook content before upgrade
        const oldContent = fs.readFileSync(path.join(gitHooks, 'pre-push'), 'utf-8');

        const { stdout } = await execAsync(`tsx ${cliPath} --json doctor upgrade --confirm`);
        const result = JSON.parse(stdout);

        expect(result.success).toBe(true);
        // Hooks should be applied
        expect(result.hooksApplied).toBeDefined();
        expect(result.hooksApplied).toContain('pre-push');

        // Verify the hook was actually upgraded
        const newContent = fs.readFileSync(path.join(gitHooks, 'pre-push'), 'utf-8');
        expect(newContent).toBe(fixedHook);
        expect(newContent).not.toBe(oldContent);
      } finally {
        // Clean up
        try { fs.rmSync(githooks, { recursive: true, force: true }); } catch {}
        try { fs.rmSync(path.join(gitHooks, 'pre-push'), { force: true }); } catch {}
      }
    });

    it('skips up-to-date hooks without error', async () => {
      const dir = tempState.tempDir;
      const gitHooks = path.join(dir, '.git', 'hooks');
      const githooks = path.join(dir, '.githooks');

      try {
        fs.mkdirSync(gitHooks, { recursive: true });
        fs.mkdirSync(githooks, { recursive: true });

        const fixedHook = `#!/bin/sh
# worklog:pre-push-hook:v1
# Force the data branch to refs/worklog/data.
set -e
if [ "$WORKLOG_SKIP_PRE_PUSH" = "1" ]; then
  exit 0
fi
skip=0
while read local_ref local_sha remote_ref remote_sha; do
  if [ "$remote_ref" = "refs/worklog/data" ]; then
    skip=1
  fi
done
if [ "$skip" = "1" ]; then
  exit 0
fi
if command -v wl >/dev/null 2>&1; then
  WL=wl
elif command -v worklog >/dev/null 2>&1; then
  WL=worklog
else
  echo "worklog: wl/worklog not found; skipping pre-push sync" >&2
  exit 0
fi
"$WL" sync --git-branch refs/worklog/data
exit 0
`;

        // Write identical hooks
        fs.writeFileSync(path.join(githooks, 'pre-push'), fixedHook, { mode: 0o755 });
        fs.writeFileSync(path.join(gitHooks, 'pre-push'), fixedHook, { mode: 0o755 });

        const { stdout } = await execAsync(`tsx ${cliPath} --json doctor upgrade --dry-run`);
        const result = JSON.parse(stdout);

        expect(result.success).toBe(true);
        expect(result.hooks.outdatedCount).toBe(0);
      } finally {
        try { fs.rmSync(githooks, { recursive: true, force: true }); } catch {}
        try { fs.rmSync(path.join(gitHooks, 'pre-push'), { force: true }); } catch {}
      }
    });

    it('skips non-worklog hooks', async () => {
      const dir = tempState.tempDir;
      const gitHooks = path.join(dir, '.git', 'hooks');
      const githooks = path.join(dir, '.githooks');

      try {
        fs.mkdirSync(gitHooks, { recursive: true });
        fs.mkdirSync(githooks, { recursive: true });

        // .githooks has a worklog hook
        fs.writeFileSync(path.join(githooks, 'pre-push'), '#!/bin/sh\n# worklog:pre-push-hook:v1\necho hook\n', { mode: 0o755 });
        // .git/hooks has a non-worklog hook (different content, no marker)
        fs.writeFileSync(path.join(gitHooks, 'pre-push'), '#!/bin/sh\necho custom hook\n', { mode: 0o755 });

        const { stdout } = await execAsync(`tsx ${cliPath} --json doctor upgrade --dry-run`);
        const result = JSON.parse(stdout);

        expect(result.success).toBe(true);
        // Non-worklog hooks should not be reported
        const prePush = result.hooks.hooks.find((h: any) => h.name === 'pre-push');
        // Either not listed or marked as not-installed (since non-worklog is skipped)
        if (prePush) {
          expect(prePush.status).not.toBe('outdated');
        }
      } finally {
        try { fs.rmSync(githooks, { recursive: true, force: true }); } catch {}
        try { fs.rmSync(path.join(gitHooks, 'pre-push'), { force: true }); } catch {}
      }
    });
  });
});
