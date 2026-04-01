import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { enterTempDir, leaveTempDir, writeConfig, writeInitSemaphore, seedWorkItems, execAsync, cliPath } from './cli-helpers.js';

const FAR_FUTURE_TIMESTAMP = '2999-01-01T00:00:00.000Z';

describe('github push --id flag', () => {
  it('--id with a valid item pushes only that item (command completes without error)', async () => {
    const state = enterTempDir();
    try {
      writeConfig(state.tempDir);
      writeInitSemaphore(state.tempDir);
      seedWorkItems(state.tempDir, [
        {
          id: 'WL-ALPHA',
          title: 'Alpha item',
          status: 'open' as any,
          priority: 'medium' as any,
          githubIssueNumber: 1001,
          githubIssueId: 5001,
          githubIssueUpdatedAt: FAR_FUTURE_TIMESTAMP,
        },
        {
          id: 'WL-BETA',
          title: 'Beta item',
          status: 'open' as any,
          priority: 'medium' as any,
          githubIssueNumber: 1002,
          githubIssueId: 5002,
          githubIssueUpdatedAt: FAR_FUTURE_TIMESTAMP,
        },
      ]);

      const { stdout } = await execAsync(
        `tsx ${cliPath} github push --repo owner/name --id WL-ALPHA`,
        { cwd: state.tempDir }
      );

      expect(stdout).toContain('GitHub sync complete');
    } finally {
      leaveTempDir(state);
    }
  });

  it('--id with a non-existent item exits with an error', async () => {
    const state = enterTempDir();
    try {
      writeConfig(state.tempDir);
      writeInitSemaphore(state.tempDir);
      seedWorkItems(state.tempDir, []);

      let errorThrown = false;
      let errorOutput = '';
      try {
        await execAsync(
          `tsx ${cliPath} github push --repo owner/name --id WL-NONEXISTENT`,
          { cwd: state.tempDir }
        );
      } catch (err: any) {
        errorThrown = true;
        errorOutput = (err.stdout ?? '') + (err.stderr ?? '');
      }

      expect(errorThrown).toBe(true);
      expect(errorOutput).toContain('WL-NONEXISTENT');
    } finally {
      leaveTempDir(state);
    }
  });

  it('--id honours --no-update-timestamp', async () => {
    const state = enterTempDir();
    try {
      writeConfig(state.tempDir);
      writeInitSemaphore(state.tempDir);
      seedWorkItems(state.tempDir, [
        {
          id: 'WL-ALPHA',
          title: 'Alpha item',
          status: 'open' as any,
          priority: 'medium' as any,
          githubIssueNumber: 1001,
          githubIssueId: 5001,
          githubIssueUpdatedAt: FAR_FUTURE_TIMESTAMP,
        },
      ]);

      const timestampPath = path.join(state.tempDir, '.worklog', 'github-last-push');
      if (fs.existsSync(timestampPath)) fs.unlinkSync(timestampPath);

      await execAsync(
        `tsx ${cliPath} github push --repo owner/name --id WL-ALPHA --no-update-timestamp`,
        { cwd: state.tempDir }
      );

      expect(fs.existsSync(timestampPath)).toBe(false);
    } finally {
      leaveTempDir(state);
    }
  });

  it('--id writes timestamp when --no-update-timestamp is not set', async () => {
    const state = enterTempDir();
    try {
      writeConfig(state.tempDir);
      writeInitSemaphore(state.tempDir);
      seedWorkItems(state.tempDir, [
        {
          id: 'WL-ALPHA',
          title: 'Alpha item',
          status: 'open' as any,
          priority: 'medium' as any,
          githubIssueNumber: 1001,
          githubIssueId: 5001,
          githubIssueUpdatedAt: FAR_FUTURE_TIMESTAMP,
        },
      ]);

      const timestampPath = path.join(state.tempDir, '.worklog', 'github-last-push');
      if (fs.existsSync(timestampPath)) fs.unlinkSync(timestampPath);

      await execAsync(
        `tsx ${cliPath} github push --repo owner/name --id WL-ALPHA`,
        { cwd: state.tempDir }
      );

      expect(fs.existsSync(timestampPath)).toBe(true);
    } finally {
      leaveTempDir(state);
    }
  });
});

describe('github push batching', () => {
  it('push with many items completes and writes timestamp (batching path)', async () => {
    const state = enterTempDir();
    try {
      writeConfig(state.tempDir);
      writeInitSemaphore(state.tempDir);
      // Seed more than one batch worth of items (batch size is fixed at 10 in the
      // implementation) to exercise the multi-batch code path.
      const items = Array.from({ length: 15 }, (_, i) => ({
        id: `WL-BATCH${String(i + 1).padStart(2, '0')}`,
        title: `Batch item ${i + 1}`,
        status: 'open' as any,
        priority: 'medium' as any,
        githubIssueNumber: 2000 + i,
        githubIssueId: 6000 + i,
        githubIssueUpdatedAt: FAR_FUTURE_TIMESTAMP,
      }));
      seedWorkItems(state.tempDir, items);

      const timestampPath = path.join(state.tempDir, '.worklog', 'github-last-push');
      if (fs.existsSync(timestampPath)) fs.unlinkSync(timestampPath);

      const { stdout } = await execAsync(
        `tsx ${cliPath} github push --repo owner/name --all`,
        { cwd: state.tempDir }
      );

      // Timestamp file should be written after all batches
      expect(fs.existsSync(timestampPath)).toBe(true);
      // Summary should appear
      expect(stdout).toContain('GitHub sync complete');
    } finally {
      leaveTempDir(state);
    }
  });

  it('push with exactly BATCH_SIZE items completes successfully (single batch)', async () => {
    const state = enterTempDir();
    try {
      writeConfig(state.tempDir);
      writeInitSemaphore(state.tempDir);
      const items = Array.from({ length: 10 }, (_, i) => ({
        id: `WL-EXACT${String(i + 1).padStart(2, '0')}`,
        title: `Exact item ${i + 1}`,
        status: 'open' as any,
        priority: 'medium' as any,
        githubIssueNumber: 3000 + i,
        githubIssueId: 7000 + i,
        githubIssueUpdatedAt: FAR_FUTURE_TIMESTAMP,
      }));
      seedWorkItems(state.tempDir, items);

      const { stdout } = await execAsync(
        `tsx ${cliPath} github push --repo owner/name --all`,
        { cwd: state.tempDir }
      );

      expect(stdout).toContain('GitHub sync complete');
    } finally {
      leaveTempDir(state);
    }
  });

  it('push with zero items completes and shows zero counts', async () => {
    const state = enterTempDir();
    try {
      writeConfig(state.tempDir);
      writeInitSemaphore(state.tempDir);
      seedWorkItems(state.tempDir, []);

      const { stdout } = await execAsync(
        `tsx ${cliPath} github push --repo owner/name --all`,
        { cwd: state.tempDir }
      );

      expect(stdout).toContain('GitHub sync complete');
      expect(stdout).toContain('Created: 0');
      expect(stdout).toContain('Updated: 0');
    } finally {
      leaveTempDir(state);
    }
  });
});
