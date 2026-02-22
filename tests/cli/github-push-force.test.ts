import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { enterTempDir, leaveTempDir, writeConfig, writeInitSemaphore, seedWorkItems, execAsync, cliPath } from './cli-helpers.js';

describe('github push --force timestamp behavior', () => {
  it('when --force is used timestamp file is still written by default', async () => {
    const state = enterTempDir();
    try {
      writeConfig(state.tempDir);
      writeInitSemaphore(state.tempDir);
      seedWorkItems(state.tempDir, []);

      const timestampPath = path.join(state.tempDir, '.worklog', 'github-last-push');
      if (fs.existsSync(timestampPath)) fs.unlinkSync(timestampPath);

      await execAsync(`tsx ${cliPath} github push --repo owner/name --force`, { cwd: state.tempDir });

      expect(fs.existsSync(timestampPath)).toBe(true);
      const content = fs.readFileSync(timestampPath, 'utf-8').trim();
      expect(() => new Date(content)).not.toThrow();
      expect(isNaN(new Date(content).getTime())).toBe(false);
    } finally {
      leaveTempDir(state);
    }
  });
});
