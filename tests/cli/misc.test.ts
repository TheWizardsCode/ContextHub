import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  cliPath,
  execAsync,
  enterTempDir,
  leaveTempDir,
  writeConfig,
  writeInitSemaphore
} from './cli-helpers.js';

describe('CLI Misc Tests', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  describe('prefix override', () => {
    it('should use custom prefix when --prefix is specified', async () => {
      const { stdout } = await execAsync(
        `tsx ${cliPath} --json create -t "Custom prefix task" --prefix CUSTOM`
      );

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.workItem.id).toMatch(/^CUSTOM-/);
    });
  });
});
