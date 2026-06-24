import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { enterTempDir, leaveTempDir, writeConfig, writeInitSemaphore, seedWorkItems, execAsync, cliPath } from './cli-helpers.js';

describe('github push --no-update-timestamp', () => {
  it('does not write .worklog/github-last-push when --no-update-timestamp is used', async () => {
    const state = enterTempDir();
    try {
      writeConfig(state.tempDir);
      writeInitSemaphore(state.tempDir);
      // seed no work items so push does minimal work and avoids external GH calls
      seedWorkItems(state.tempDir, []);

      const timestampPath = path.join(state.tempDir, '.worklog', 'github-last-push');
      if (fs.existsSync(timestampPath)) fs.unlinkSync(timestampPath);

      // Run the CLI push with --no-update-timestamp
      await execAsync(`tsx ${cliPath} github push --repo owner/name --no-update-timestamp`, { cwd: state.tempDir });

      expect(fs.existsSync(timestampPath)).toBe(false);
    } finally {
      leaveTempDir(state);
    }
  });

  it('writes .worklog/github-last-push when flag not provided', async () => {
    const state = enterTempDir();
    try {
      writeConfig(state.tempDir);
      writeInitSemaphore(state.tempDir);
      seedWorkItems(state.tempDir, []);

      const timestampPath = path.join(state.tempDir, '.worklog', 'github-last-push');
      if (fs.existsSync(timestampPath)) fs.unlinkSync(timestampPath);

      await execAsync(`tsx ${cliPath} github push --repo owner/name`, { cwd: state.tempDir });

      expect(fs.existsSync(timestampPath)).toBe(true);
      const content = fs.readFileSync(timestampPath, 'utf-8').trim();
      // basic ISO timestamp validation
      expect(() => new Date(content)).not.toThrow();
      expect(isNaN(new Date(content).getTime())).toBe(false);
    } finally {
      leaveTempDir(state);
    }
  });
});
