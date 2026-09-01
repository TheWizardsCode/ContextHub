/**
 * Tests for sync divergence detection (WL-0MTGGGP2000642JS).
 *
 * When the local store holds more records than the remote tip (e.g. after a
 * foreign-author full snapshot replaced the remote with fewer records), sync
 * must NOT report success with "No changes to sync". Instead it must detect
 * the divergence and force a full snapshot so the remote converges.
 *
 * AC1 — Divergence detection: sync fails (or warns) when local > remote
 * AC2 — Self-healing export: sync exports missing records so remote converges
 * AC3 — No false success: exit code/message reflect actual convergence
 * AC4 — Regression test: reproduces the watermark-blindness scenario
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
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

function setWatermark(dbPath: string, timestamp: string): void {
  const db = new Database(dbPath);
  // Per-type watermarks live in last_export_timestamps (one row per type).
  const upsert = db.prepare(
    `INSERT OR REPLACE INTO last_export_timestamps (record_type, exported_at) VALUES (?, ?)`
  );
  for (const recordType of ['workitems', 'comments', 'edges', 'audit_results']) {
    upsert.run(recordType, timestamp);
  }
  // Delta cadence metadata uses special record types in the same table.
  upsert.run('__delta_count__', '5');
  upsert.run('__delta_bytes__', '1000');
  db.close();
}

/**
 * Create a minimal JSONL content string with the given number of work items.
 * Each item gets a unique ID (project prefix TEST) and a timestamp.
 */
function buildRemoteJsonl(itemCount: number, timestamp: string): string {
  const lines: string[] = [];
  for (let i = 0; i < itemCount; i++) {
    const id = `TEST-REC-${String(i).padStart(4, '0')}`;
    lines.push(JSON.stringify({
      kind: 'delta',
      id,
      title: `Remote record ${i}`,
      description: '',
      status: 'open',
      priority: 'medium',
      sortIndex: i,
      parentId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      tags: [],
      assignee: '',
      stage: '',
      issueType: '',
      createdBy: '',
      deletedBy: '',
      deleteReason: '',
    }));
  }
  return lines.join('\n') + '\n';
}

describe('Sync divergence detection (WL-0MTGGGP2000642JS)', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  it('should detect divergence when local has more items than remote and force a full export', async () => {
    // Set up git repo
    await execAsync(`git -C ${tempState.tempDir} init -b dev`);
    await execAsync(`git -C ${tempState.tempDir} config user.name "Test User"`);
    await execAsync(`git -C ${tempState.tempDir} config user.email "test@example.com"`);

    // Create 10 local work items, capturing their IDs for later verification
    const createdIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const title = `Local item ${i}`;
      const { stdout } = await execAsync(
        `tsx ${cliPath} create --title "${title}" --json`
      );
      const parsed = JSON.parse(stdout);
      expect(parsed.success).toBe(true);
      createdIds.push(parsed.workItem.id as string);
    }

    // Create a fake remote with only 3 items (older than local records)
    const dataFilePath = '.worklog/worklog-data.jsonl';
    const oldTimestamp = '2024-01-01T00:00:00.000Z';

    // Create an initial commit with 3-item JSONL on the data ref
    await execAsync(`git -C ${tempState.tempDir} add -A`);
    await execAsync(`git -C ${tempState.tempDir} commit -m "chore: initial"`);

    // Create orphan branch for data ref and push 3-item JSONL
    await execAsync(`git -C ${tempState.tempDir} checkout --orphan refs/worklog/data 2>/dev/null || true`);
    await execAsync(`git -C ${tempState.tempDir} rm -rf . 2>/dev/null || true`);
    const remoteContent = buildRemoteJsonl(3, oldTimestamp);
    fs.writeFileSync(path.join(tempState.tempDir, dataFilePath), remoteContent, 'utf-8');
    await execAsync(`git -C ${tempState.tempDir} add -f ${dataFilePath}`);
    await execAsync(`git -C ${tempState.tempDir} commit -m "Sync: remote baseline"`);

    // Set up origin and push the data ref
    await execAsync(`git -C ${tempState.tempDir} checkout dev 2>/dev/null || git -C ${tempState.tempDir} checkout -b dev`);
    await execAsync(`git -C ${tempState.tempDir} remote add origin http://example.com/repo 2>/dev/null || true`);
    await execAsync(`git -C ${tempState.tempDir} push origin refs/worklog/data:refs/worklog/data 2>/dev/null || true`);

    // Simulate watermark being advanced past local timestamps
    // by writing last-export-timestamps to a future time
    const dbPath = path.join(tempState.tempDir, '.worklog', 'worklog.db');
    const wmFuture = '2026-12-31T23:59:59.999Z';
    setWatermark(dbPath, wmFuture);

    // Run sync --no-push and verify it detects divergence
    // The key assertion: output must NOT say "No changes to sync"
    const { stdout, stderr } = await execAsync(
      `tsx ${cliPath} sync --no-push 2>&1`
    );
    
    // Critical assertion: must NOT skip with "No changes to sync" (AC3)
    expect(stdout).not.toContain('No changes to sync');
    expect(stdout).not.toContain('skipping export');
    
    // Should report that it's syncing/pushing data
    expect(stdout).toContain('Starting sync');

    // AC1: the operator must be warned about the divergence (console.warn
    // goes to stderr which execAsync returns separately).
    expect(stderr).toContain('Sync divergence detected');

    // Self-healing export (AC2): the full snapshot JSONL must have been
    // produced and retained (--no-push keeps it for the next push), and it
    // must contain ALL 10 local records (remote convergence).
    const exportedPath = path.join(tempState.tempDir, '.worklog', 'worklog-data.jsonl');
    expect(fs.existsSync(exportedPath)).toBe(true);
    const exportedContent = fs.readFileSync(exportedPath, 'utf-8');
    // The export header must declare a FULL snapshot (not a delta).
    expect(exportedContent).toContain('"kind":"full"');
    // Every locally created item must appear in the exported snapshot.
    for (const id of createdIds) {
      expect(exportedContent).toContain(id);
    }
    // And the remote-only records are merged in too (full convergence).
    expect(exportedContent).toContain('TEST-REC-0000');
  });

  it('should keep the zero-change fast path when local and remote counts match', async () => {
    // Normal case: no divergence (equal counts), no dirty records → the
    // §5.4 fast path must still work and report "No changes to sync" — this
    // is the CORRECT behaviour when local and remote are provably identical.
    await execAsync(`git -C ${tempState.tempDir} init -b dev`);
    await execAsync(`git -C ${tempState.tempDir} config user.name "Test User"`);
    await execAsync(`git -C ${tempState.tempDir} config user.email "test@example.com"`);
    await execAsync(`git -C ${tempState.tempDir} add -A`);
    await execAsync(`git -C ${tempState.tempDir} commit -m "chore: initial"`);

    await execAsync(`git -C ${tempState.tempDir} remote add origin http://example.com/repo 2>/dev/null || true`);

    // Create orphan branch with empty JSONL (0 records — matches local 0)
    await execAsync(`git -C ${tempState.tempDir} checkout --orphan refs/worklog/data 2>/dev/null || true`);
    await execAsync(`git -C ${tempState.tempDir} rm -rf . 2>/dev/null || true`);
    fs.writeFileSync(
      path.join(tempState.tempDir, '.worklog/worklog-data.jsonl'),
      '',
      'utf-8'
    );
    await execAsync(`git -C ${tempState.tempDir} add -f .worklog/worklog-data.jsonl`);
    await execAsync(`git -C ${tempState.tempDir} commit -m "Sync: empty baseline"`);
    await execAsync(`git -C ${tempState.tempDir} checkout dev 2>/dev/null || git -C ${tempState.tempDir} checkout -b dev`);
    await execAsync(`git -C ${tempState.tempDir} push origin refs/worklog/data:refs/worklog/data 2>/dev/null || true`);

    // Run sync --dry-run (no changes, so should report success)
    const { stdout } = await execAsync(
      `tsx ${cliPath} sync --dry-run --json 2>&1`
    );
    
    const parsed = JSON.parse(stdout);
    expect(parsed.success).toBe(true);
    // With no items locally and no items remotely, sync is a no-op.
    expect(parsed.sync.summary.itemsUnchanged).toBe(0);
    // No divergence false-positive: the fast path is still used.
    expect(parsed.sync.summary.itemsAdded).toBe(0);
  });
});
