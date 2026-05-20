import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { enterTempDir, leaveTempDir, writeConfig, writeInitSemaphore, seedWorkItems, execAsync, cliPath } from './cli-helpers.js';

describe('github push synced items output', () => {
  it('does not print per-item synced list when not verbose', async () => {
    const state = enterTempDir();
    try {
      writeConfig(state.tempDir);
      writeInitSemaphore(state.tempDir);
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
        { cwd: state.tempDir }
      );

      expect(stdout).toContain('GitHub sync complete');
      expect(stdout).not.toContain('Synced items:');
    } finally {
      leaveTempDir(state);
    }
  });

  it('prints per-item synced list when --verbose is provided', async () => {
    const state = enterTempDir();
    try {
      writeConfig(state.tempDir);
      writeInitSemaphore(state.tempDir);
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

      const { stdout } = await execAsync(
        `tsx ${cliPath} --verbose github push --repo owner/name`,
        { cwd: state.tempDir }
      );

      expect(stdout).toContain('GitHub sync complete');
      expect(stdout).toContain('Synced items:');
    } finally {
      leaveTempDir(state);
    }
  });
});
