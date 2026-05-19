import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { enterTempDir, leaveTempDir, writeConfig, writeInitSemaphore, seedWorkItems, execAsync, cliPath } from './cli-helpers.js';

const FAR_FUTURE_TIMESTAMP = '2999-01-01T00:00:00.000Z';

describe('github push --id bypasses pre-filter', () => {
  it('--id pushes an item even when last-push timestamp would exclude it', async () => {
    const state = enterTempDir();
    try {
      writeConfig(state.tempDir);
      writeInitSemaphore(state.tempDir);
      // Seed a single item that would normally be skipped by pre-filter if
      // last-push is set to a far-future timestamp.
      seedWorkItems(state.tempDir, [
        {
          id: 'WL-ALPHA',
          title: 'Alpha item',
          status: 'open' as any,
          priority: 'medium' as any,
          githubIssueNumber: 1001,
          githubIssueId: 5001,
          // updatedAt in the past
          updatedAt: '2025-01-01T00:00:00.000Z',
          // avoid external GH calls in this test path
          githubIssueUpdatedAt: FAR_FUTURE_TIMESTAMP,
        },
      ]);

      // Write a last-push timestamp far in the future so pre-filter would
      // normally exclude any real items from processing.
      const timestampPath = path.join(state.tempDir, '.worklog', 'github-last-push');
      fs.writeFileSync(timestampPath, `${FAR_FUTURE_TIMESTAMP}\n`, 'utf8');

      // Single-item push should still succeed (bypass pre-filter)
      const { stdout } = await execAsync(
        `tsx ${cliPath} github push --repo owner/name --id WL-ALPHA`,
        { cwd: state.tempDir }
      );

      expect(stdout).toContain('GitHub sync complete');
    } finally {
      leaveTempDir(state);
    }
  });
});
