import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { enterTempDir, leaveTempDir, writeConfig, writeInitSemaphore, seedWorkItems, execAsync, cliPath } from './cli-helpers.js';

const FAR_FUTURE_TIMESTAMP = '2999-01-01T00:00:00.000Z';

describe('github push timestamp uses push-start time (AC2)', () => {
  it('timestamp is captured before processing begins (push-start time <= post-push time)', async () => {
    const state = enterTempDir();
    try {
      writeConfig(state.tempDir);
      writeInitSemaphore(state.tempDir);
      seedWorkItems(state.tempDir, []);

      const timestampPath = path.join(state.tempDir, '.worklog', 'github-last-push');
      if (fs.existsSync(timestampPath)) fs.unlinkSync(timestampPath);

      const beforePush = new Date().toISOString();

      await execAsync(`tsx ${cliPath} github push --repo owner/name`, { cwd: state.tempDir });

      const afterPush = new Date().toISOString();

      expect(fs.existsSync(timestampPath)).toBe(true);
      const recorded = fs.readFileSync(timestampPath, 'utf-8').trim();
      const recordedDate = new Date(recorded);

      // The recorded timestamp must be a valid ISO date
      expect(isNaN(recordedDate.getTime())).toBe(false);

      // The recorded timestamp should be >= the time we captured before calling
      // push (it was set at push-start) and <= the time we captured after the
      // push completed. This proves it was captured *before* processing finished.
      expect(recordedDate.getTime()).toBeGreaterThanOrEqual(new Date(beforePush).getTime());
      expect(recordedDate.getTime()).toBeLessThanOrEqual(new Date(afterPush).getTime());
    } finally {
      leaveTempDir(state);
    }
  });

  it('timestamp is written even when zero items are processed (no-op push)', async () => {
    const state = enterTempDir();
    try {
      writeConfig(state.tempDir);
      writeInitSemaphore(state.tempDir);
      // Seed an empty list so there are zero items to push
      seedWorkItems(state.tempDir, []);

      const timestampPath = path.join(state.tempDir, '.worklog', 'github-last-push');
      if (fs.existsSync(timestampPath)) fs.unlinkSync(timestampPath);

      await execAsync(`tsx ${cliPath} github push --repo owner/name`, { cwd: state.tempDir });

      expect(fs.existsSync(timestampPath)).toBe(true);
      const content = fs.readFileSync(timestampPath, 'utf-8').trim();
      expect(isNaN(new Date(content).getTime())).toBe(false);
    } finally {
      leaveTempDir(state);
    }
  });

  it('subsequent push overwrites timestamp with a newer push-start time', async () => {
    const state = enterTempDir();
    try {
      writeConfig(state.tempDir);
      writeInitSemaphore(state.tempDir);
      seedWorkItems(state.tempDir, []);

      const timestampPath = path.join(state.tempDir, '.worklog', 'github-last-push');
      if (fs.existsSync(timestampPath)) fs.unlinkSync(timestampPath);

      // First push
      await execAsync(`tsx ${cliPath} github push --repo owner/name`, { cwd: state.tempDir });
      expect(fs.existsSync(timestampPath)).toBe(true);
      const firstTimestamp = fs.readFileSync(timestampPath, 'utf-8').trim();

      // Small delay to ensure time advances
      await new Promise((r) => setTimeout(r, 50));

      // Second push
      await execAsync(`tsx ${cliPath} github push --repo owner/name`, { cwd: state.tempDir });
      const secondTimestamp = fs.readFileSync(timestampPath, 'utf-8').trim();

      // The second timestamp should be strictly newer than the first
      expect(new Date(secondTimestamp).getTime()).toBeGreaterThan(new Date(firstTimestamp).getTime());
    } finally {
      leaveTempDir(state);
    }
  });

  it('timestamp is written even when items exist and are unchanged', async () => {
    const state = enterTempDir();
    try {
      writeConfig(state.tempDir);
      writeInitSemaphore(state.tempDir);
      // Seed one item that is already GitHub-synced and newer than local updates
      // so push can complete deterministically without external API calls.
      seedWorkItems(state.tempDir, [
        {
          id: 'WL-SYNCED-1',
          title: 'Previously synced item',
          status: 'open',
          priority: 'medium',
          githubIssueNumber: 4001,
          githubIssueId: 8001,
          githubIssueUpdatedAt: FAR_FUTURE_TIMESTAMP,
        },
      ]);

      const timestampPath = path.join(state.tempDir, '.worklog', 'github-last-push');
      if (fs.existsSync(timestampPath)) fs.unlinkSync(timestampPath);

      const beforePush = new Date().toISOString();

      await execAsync(`tsx ${cliPath} github push --repo owner/name`, { cwd: state.tempDir });

      const afterPush = new Date().toISOString();

      expect(fs.existsSync(timestampPath)).toBe(true);
      const recorded = fs.readFileSync(timestampPath, 'utf-8').trim();
      const recordedDate = new Date(recorded);

      expect(isNaN(recordedDate.getTime())).toBe(false);
      // Push-start timestamp should still be within the push window
      expect(recordedDate.getTime()).toBeGreaterThanOrEqual(new Date(beforePush).getTime());
      expect(recordedDate.getTime()).toBeLessThanOrEqual(new Date(afterPush).getTime());
    } finally {
      leaveTempDir(state);
    }
  });
});
