import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import {
  cliPath,
  execAsync,
  enterTempDir,
  leaveTempDir,
  writeConfig,
  writeInitSemaphore,
  seedWorkItems,
} from './cli-helpers.js';

describe('doctor prune command', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir, '1.0.0');
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  it('dry-run lists prunable items and skips unsynced GitHub-linked items', async () => {
    const now = new Date();
    const old = new Date(now.getTime() - (40 * 24 * 60 * 60 * 1000)).toISOString(); // 40 days ago
    const recent = new Date(now.getTime() - (5 * 24 * 60 * 60 * 1000)).toISOString(); // 5 days ago
    const older = new Date(now.getTime() - (70 * 24 * 60 * 60 * 1000)).toISOString(); // 70 days ago

    // Seed items
    seedWorkItems(tempState.tempDir, [
      { id: 'TEST-PRUNE-1', title: 'old deleted no GH', status: 'deleted', },
      { id: 'TEST-PRUNE-2', title: 'old deleted synced GH', status: 'deleted', },
      { id: 'TEST-PRUNE-3', title: 'old deleted unsynced GH', status: 'deleted', },
      { id: 'TEST-PRUNE-4', title: 'recent deleted', status: 'deleted', },
    ]);

    // Manually patch JSONL to set timestamps and GH fields
    const f = path.join(tempState.tempDir, '.worklog', 'worklog-data.jsonl');
    const content = (await import('fs')).readFileSync(f, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    for (const rec of content) {
      if (rec.type !== 'workitem') continue;
      if (rec.data.id === 'TEST-PRUNE-1') {
        rec.data.updatedAt = old;
      }
      if (rec.data.id === 'TEST-PRUNE-2') {
        rec.data.updatedAt = old;
        rec.data.githubIssueNumber = 123;
        rec.data.githubIssueUpdatedAt = old; // synced
      }
      if (rec.data.id === 'TEST-PRUNE-3') {
        // Older than cutoff (candidate) but local updatedAt is newer than GitHub
        // (githubIssueUpdatedAt set to an even older timestamp) so it should be skipped
        rec.data.updatedAt = old;
        rec.data.githubIssueNumber = 124;
        rec.data.githubIssueUpdatedAt = older;
      }
      if (rec.data.id === 'TEST-PRUNE-4') {
        rec.data.updatedAt = new Date().toISOString();
      }
    }
    (await import('fs')).writeFileSync(f, content.map(c => JSON.stringify(c)).join('\n') + '\n', 'utf-8');

    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor prune --dry-run --days 30`);
    const result = JSON.parse(stdout);
    expect(result.dryRun).toBe(true);
    // Expect TEST-PRUNE-1 and TEST-PRUNE-2 to be candidates; TEST-PRUNE-3 skipped
    expect(result.candidates).toContain('TEST-PRUNE-1');
    expect(result.candidates).toContain('TEST-PRUNE-2');
    expect(result.candidates).not.toContain('TEST-PRUNE-3');
    expect(result.skippedIds).toContain('TEST-PRUNE-3');
  });

  it('actual prune deletes expected items and reports skippedIds', async () => {
    const now = new Date();
    const old = new Date(now.getTime() - (40 * 24 * 60 * 60 * 1000)).toISOString(); // 40 days ago
    const recent = new Date(now.getTime() - (5 * 24 * 60 * 60 * 1000)).toISOString(); // 5 days ago
    const older = new Date(now.getTime() - (70 * 24 * 60 * 60 * 1000)).toISOString(); // 70 days ago

    seedWorkItems(tempState.tempDir, [
      { id: 'TEST-PRUNE-A', title: 'old deleted no GH', status: 'deleted' },
      { id: 'TEST-PRUNE-B', title: 'old deleted unsynced GH', status: 'deleted' },
      { id: 'TEST-KEEP', title: 'open item', status: 'open' },
    ]);

    const f = path.join(tempState.tempDir, '.worklog', 'worklog-data.jsonl');
    const content = (await import('fs')).readFileSync(f, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    for (const rec of content) {
      if (rec.type !== 'workitem') continue;
      if (rec.data.id === 'TEST-PRUNE-A') rec.data.updatedAt = old;
      if (rec.data.id === 'TEST-PRUNE-B') {
        // candidate (old) but local updatedAt is newer than GitHub -> skip
        rec.data.updatedAt = old;
        rec.data.githubIssueNumber = 999;
        rec.data.githubIssueUpdatedAt = older; // GitHub older
      }
    }
    (await import('fs')).writeFileSync(f, content.map(c => JSON.stringify(c)).join('\n') + '\n', 'utf-8');

    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor prune --days 30`);
    const result = JSON.parse(stdout);
    expect(result.dryRun).toBe(false);
    expect(result.prunedIds).toContain('TEST-PRUNE-A');
    expect(result.skippedIds).toContain('TEST-PRUNE-B');

    // Re-run list to ensure item A is gone and TEST-KEEP remains
    const { stdout: lsOut } = await execAsync(`tsx ${cliPath} --json list`);
    const listResult = JSON.parse(lsOut);
    const ids = listResult.map((i: any) => i.id);
    expect(ids).not.toContain('TEST-PRUNE-A');
    expect(ids).toContain('TEST-KEEP');
  });
});
