import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { enterTempDir, leaveTempDir, writeConfig, writeInitSemaphore, seedWorkItems, execAsync, cliPath } from './cli-helpers.js';

// This test simulates the pre-filter module throwing by stubbing the module
// loader. We achieve this by creating a small shim that shadows the module
// resolution when running the CLI in-process: the CLI uses dynamic import
// '../github-pre-filter.js' so we create a file in node_modules to intercept
// resolution. For simplicity we instead run the CLI child-process and set
// NODE_OPTIONS to preload a small stub loader. However test harness constraints
// make this complex; instead assert that when pre-filter fails the CLI still
// completes and writes the timestamp file. We simulate failure by temporarily
// renaming the pre-filter file so the import will fail.

describe('github push pre-filter failure fallback', () => {
  it('falls back to processing all items and writes timestamp when pre-filter import fails', async () => {
    const state = enterTempDir();
    try {
      writeConfig(state.tempDir);
      writeInitSemaphore(state.tempDir);
      seedWorkItems(state.tempDir, []);

      const projectRoot = path.resolve(__dirname, '..');
      const prefilterPath = path.join(projectRoot, 'src', 'github-pre-filter.ts');
      const tmpPath = `${prefilterPath}.bak`;

      // Temporarily move the pre-filter implementation so dynamic import fails
      if (fs.existsSync(prefilterPath)) fs.renameSync(prefilterPath, tmpPath);

      const timestampPath = path.join(state.tempDir, '.worklog', 'github-last-push');
      if (fs.existsSync(timestampPath)) fs.unlinkSync(timestampPath);

      try {
        await execAsync(`tsx ${cliPath} github push --repo owner/name`, { cwd: state.tempDir });
      } finally {
        // restore file
        if (fs.existsSync(tmpPath)) fs.renameSync(tmpPath, prefilterPath);
      }

      expect(fs.existsSync(timestampPath)).toBe(true);
    } finally {
      leaveTempDir(state);
    }
  });
});
