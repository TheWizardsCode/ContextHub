import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  cliPath,
  execAsync,
} from './cli-helpers.js';
import { initRepo } from './git-helpers.js';
import { cleanupTempDir, createTempDir } from '../test-utils.js';

describe('Git Worktree Support', () => {
  it('should place .worklog in main repo when initializing main repository', async () => {
    const tempDir = createTempDir();
    try {
      // Initialize a git repo
      // Initialize repo with a fast empty commit
      await initRepo(tempDir);

      // Initialize worklog in the main repo
      await execAsync(
        `tsx ${cliPath} init --project-name "Main Repo" --prefix MAIN --auto-export yes --auto-sync no --workflow-inline no --agents-template skip --stats-plugin-overwrite no`,
        { cwd: tempDir }
      );

      // Check that .worklog was created in the main repo
      expect(fs.existsSync(path.join(tempDir, '.worklog'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, '.worklog', 'config.yaml'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, '.worklog', 'initialized'))).toBe(true);
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it('should find main repo .worklog when in subdirectory of main repo (not worktree)', async () => {
    const tempDir = createTempDir();
    try {
      // Initialize a git repo
      await initRepo(tempDir);

      // Initialize worklog in the main repo
      await execAsync(
        `tsx ${cliPath} init --project-name "Main Repo" --prefix MAIN --auto-export yes --auto-sync no --workflow-inline no --agents-template skip --stats-plugin-overwrite no`,
        { cwd: tempDir }
      );

      // Create a subdirectory in the repo
      const subDir = path.join(tempDir, 'src', 'components');
      fs.mkdirSync(subDir, { recursive: true });

      // Create a work item from the subdirectory - should use main repo's .worklog
      const createResult = await execAsync(
        `tsx ${cliPath} --json create --title "Item from subdirectory"`,
        { cwd: subDir }
      );
      const createData = JSON.parse(createResult.stdout);
      expect(createData.success).toBe(true);

      // List items from the subdirectory - should find the item created via subdirectory
      const listResult = await execAsync(
        `tsx ${cliPath} --json list`,
        { cwd: subDir }
      );
      const listData = JSON.parse(listResult.stdout);
      expect(listData.workItems).toHaveLength(1);
      expect(listData.workItems[0].title).toBe('Item from subdirectory');

      // Also verify from main repo
      const mainListResult = await execAsync(
        `tsx ${cliPath} --json list`,
        { cwd: tempDir }
      );
      const mainListData = JSON.parse(mainListResult.stdout);
      expect(mainListData.workItems).toHaveLength(1);
      expect(mainListData.workItems[0].title).toBe('Item from subdirectory');
    } finally {
      cleanupTempDir(tempDir);
    }
  });
});
