import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { enterTempDir, leaveTempDir, writeConfig, writeInitSemaphore, seedWorkItems, execAsync, cliPath } from './cli-helpers.js';

describe('github push --all flag', () => {
  it('--all processes all items and writes timestamp file', async () => {
    const state = enterTempDir();
    try {
      writeConfig(state.tempDir);
      writeInitSemaphore(state.tempDir);
      seedWorkItems(state.tempDir, []);

      const timestampPath = path.join(state.tempDir, '.worklog', 'github-last-push');
      if (fs.existsSync(timestampPath)) fs.unlinkSync(timestampPath);

      const { stdout } = await execAsync(`tsx ${cliPath} github push --repo owner/name --all`, { cwd: state.tempDir });

      // Timestamp file should still be written
      expect(fs.existsSync(timestampPath)).toBe(true);
      const content = fs.readFileSync(timestampPath, 'utf-8').trim();
      expect(() => new Date(content)).not.toThrow();
      expect(isNaN(new Date(content).getTime())).toBe(false);

      // Output should indicate full push mode
      expect(stdout).toContain('Full push (--all)');
    } finally {
      leaveTempDir(state);
    }
  });

  it('--all output indicates that pre-filter was bypassed', async () => {
    const state = enterTempDir();
    try {
      writeConfig(state.tempDir);
      writeInitSemaphore(state.tempDir);
      seedWorkItems(state.tempDir, []);

      const { stdout } = await execAsync(`tsx ${cliPath} github push --repo owner/name --all`, { cwd: state.tempDir });

      expect(stdout).toContain('--all was used; pre-filter was bypassed');
    } finally {
      leaveTempDir(state);
    }
  });

  it('--all with seeded items shows item count in output', async () => {
    const state = enterTempDir();
    try {
      writeConfig(state.tempDir);
      writeInitSemaphore(state.tempDir);
      seedWorkItems(state.tempDir, [
        { id: 'WL-TEST1', title: 'Item 1', status: 'open' as any, priority: 'medium' as any },
        { id: 'WL-TEST2', title: 'Item 2', status: 'open' as any, priority: 'medium' as any },
      ]);

      const { stdout } = await execAsync(`tsx ${cliPath} github push --repo owner/name --all`, { cwd: state.tempDir });

      // Should indicate "processing all N items"
      expect(stdout).toMatch(/Full push \(--all\): processing all \d+ items/);
    } finally {
      leaveTempDir(state);
    }
  });

  it('without --all, pre-filter is applied', async () => {
    const state = enterTempDir();
    try {
      writeConfig(state.tempDir);
      writeInitSemaphore(state.tempDir);
      seedWorkItems(state.tempDir, []);

      const { stdout } = await execAsync(`tsx ${cliPath} github push --repo owner/name`, { cwd: state.tempDir });

      // Should NOT contain the --all message
      expect(stdout).not.toContain('Full push (--all)');
      expect(stdout).not.toContain('--all was used');
    } finally {
      leaveTempDir(state);
    }
  });
});

describe('github push --force (deprecated alias)', () => {
  it('--force still works as backward-compatible alias for --all', async () => {
    const state = enterTempDir();
    try {
      writeConfig(state.tempDir);
      writeInitSemaphore(state.tempDir);
      seedWorkItems(state.tempDir, []);

      const timestampPath = path.join(state.tempDir, '.worklog', 'github-last-push');
      if (fs.existsSync(timestampPath)) fs.unlinkSync(timestampPath);

      const { stdout } = await execAsync(`tsx ${cliPath} github push --repo owner/name --force`, { cwd: state.tempDir });

      // Timestamp file should still be written
      expect(fs.existsSync(timestampPath)).toBe(true);
      const content = fs.readFileSync(timestampPath, 'utf-8').trim();
      expect(() => new Date(content)).not.toThrow();
      expect(isNaN(new Date(content).getTime())).toBe(false);

      // Output should indicate full push mode (same as --all)
      expect(stdout).toContain('Full push (--all)');
    } finally {
      leaveTempDir(state);
    }
  });
});
