import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { enterTempDir, leaveTempDir, writeConfig, writeInitSemaphore, seedWorkItems, execAsync, cliPath } from './cli-helpers.js';

/**
 * Create a seed file for the `gh` mock script so that simulated GitHub issues
 * exist before the push command is executed.  The mock reads this file on startup
 * and returns deterministic responses for known issue numbers.
 */
function writeGhSeedFile(issues: Array<{ number: number; id: string; title: string; body: string; state: string; labels: string[]; updatedAt: string }>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-seed-'));
  const filePath = path.join(dir, 'issues.jsonl');
  for (const issue of issues) {
    fs.appendFileSync(filePath, JSON.stringify(issue) + '\n');
  }
  return filePath;
}

describe('github push synced items output', () => {
  // These tests spawn the full CLI via tsx and may be slow under concurrent
  // load; give them the explicit 60s timeout recommended in vitest.config.ts.
  it('does not print per-item synced list when not verbose', async () => {
    const state = enterTempDir();
    try {
      writeConfig(state.tempDir);
      writeInitSemaphore(state.tempDir);
      // WL-ONE has no githubIssueNumber so the push would try to CREATE it.
      // The mock creates issues with auto-incremented numbers starting at 1,
      // so the synced item would be WL-ONE.  Verbose mode is off, so
      // "Synced items:" must NOT appear in the output.
      seedWorkItems(state.tempDir, [
        {
          id: 'WL-ONE',
          title: 'One item',
          status: 'open' as any,
          priority: 'medium' as any,
        },
      ]);

      const { stdout } = await execAsync(
        `tsx ${cliPath} github push --repo owner/name`,
        { cwd: state.tempDir, timeout: 55000 }
      );

      expect(stdout).toContain('GitHub sync complete');
      expect(stdout).not.toContain('Synced items:');
    } finally {
      leaveTempDir(state);
    }
  }, 60000);

  it('prints per-item synced list when --verbose is provided', async () => {
    const state = enterTempDir();
    try {
      writeConfig(state.tempDir);
      writeInitSemaphore(state.tempDir);
      // WL-TWO already has a GitHub issue number so the push updates it.
      // Seed the gh mock so the mock returns a valid issue record.
      const seedFilePath = writeGhSeedFile([
        {
          number: 1002,
          id: 'GHI_5002',
          title: 'Two item',
          body: '',
          state: 'open',
          labels: [],
          updatedAt: '2025-01-01T00:00:00.000Z',
        },
      ]);
      process.env.WORKLOG_SEED_GH_ISSUES = seedFilePath;

      // Seed the work item (WL-TWO) into the local worklog
      seedWorkItems(state.tempDir, [
        {
          id: 'WL-TWO',
          title: 'Two item',
          status: 'open' as any,
          priority: 'medium' as any,
          githubIssueNumber: 1002,
          githubIssueId: 5002,
          githubIssueUpdatedAt: '2025-01-01T00:00:00.000Z',
        },
      ]);

      try {
        const { stdout } = await execAsync(
          `tsx ${cliPath} --verbose github push --repo owner/name`,
          { cwd: state.tempDir, timeout: 170000 }
        );

        expect(stdout).toContain('GitHub sync complete');
        // Verbose mode prints a timing breakdown.
        expect(stdout).toContain('Timing breakdown:');
        // The synced-items section must be present with per-item details.
        expect(stdout).toContain('Synced items:');
        // Per-item line format: action  ID  title  URL
        expect(stdout).toContain('updated');
        expect(stdout).toContain('WL-TWO');
        expect(stdout).toContain('Two item');
        expect(stdout).toContain('https://github.com/owner/name/issues/1002');
      } finally {
        // Clean up seed file so it doesn't leak between tests.
        try {
          if (process.env.WORKLOG_SEED_GH_ISSUES) {
            fs.rmSync(path.dirname(process.env.WORKLOG_SEED_GH_ISSUES!), { recursive: true, force: true });
            delete process.env.WORKLOG_SEED_GH_ISSUES;
          }
        } catch (_) {}
      }
    } finally {
      leaveTempDir(state);
    }
  }, 180000); // Generous explicit timeout: the in-process CLI run can take >60s on
              // heavily loaded dev boxes (tsx + github push + mock gh spawns), which
              // exceeds the 30s global testTimeout. The non-verbose sibling test
              // above sets an explicit 60s timeout for the same reason.
});
