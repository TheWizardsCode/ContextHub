import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  cliPath,
  execAsync,
  enterTempDir,
  leaveTempDir,
  seedWorkItems,
  writeConfig,
  writeInitSemaphore
} from './cli-helpers.js';
import { initRepo, initBareRepo } from './git-helpers.js';
import { cleanupTempDir, createTempDir } from '../test-utils.js';

describe('CLI Init Tests', () => {
  it('should insert the AGENTS.md pointer line when an existing file is present', async () => {
    const tempState = enterTempDir();
    try {
      const existing = '## Local Rules\n\n- Do the local thing\n';
      fs.writeFileSync('AGENTS.md', existing, 'utf-8');

      await execAsync(
        `tsx ${cliPath} init --project-name "Test Project" --prefix TEST --auto-export yes --auto-sync no --workflow-inline no --agents-template append --stats-plugin-overwrite no`
      );

      const updated = fs.readFileSync('AGENTS.md', 'utf-8');
      const pointer = 'Follow the global AGENTS.md in addition to the rules below. The local rules below take priority in the event of a conflict.';
      const lines = updated.split(/\r?\n/).filter(line => line.trim().length > 0);
      expect(lines[0]).toBe(pointer);
      expect(updated).toContain(existing.trim());
    } finally {
      leaveTempDir(tempState);
    }
  });

  it('should not duplicate the AGENTS.md pointer line on re-run', async () => {
    const tempState = enterTempDir();
    try {
      const pointer = 'Follow the global AGENTS.md in addition to the rules below. The local rules below take priority in the event of a conflict.';
      const existing = `${pointer}\n\n## Local Rules\n\n- Keep it\n`;
      fs.writeFileSync('AGENTS.md', existing, 'utf-8');

      await execAsync(
        `tsx ${cliPath} init --project-name "Test Project" --prefix TEST --auto-export yes --auto-sync no --workflow-inline no --agents-template append --stats-plugin-overwrite no`
      );

      const updated = fs.readFileSync('AGENTS.md', 'utf-8');
      const pointerMatches = updated.split(/\r?\n/).filter(line => line.trim() === pointer).length;
      expect(pointerMatches).toBe(1);
      expect(updated).toContain('## Local Rules');
    } finally {
      leaveTempDir(tempState);
    }
  });
  it('should create semaphore when config exists but semaphore does not', async () => {
    const tempState = enterTempDir();
    try {
      fs.mkdirSync('.worklog', { recursive: true });
      fs.writeFileSync(
        '.worklog/config.yaml',
        [
          'projectName: Test Project',
          'prefix: TEST',
          'statuses:',
          '  - value: open',
          '    label: Open',
          '  - value: in-progress',
          '    label: In Progress',
          '  - value: blocked',
          '    label: Blocked',
          '  - value: completed',
          '    label: Completed',
          '  - value: deleted',
          '    label: Deleted',
          'stages:',
          '  - value: ""',
          '    label: Undefined',
          '  - value: idea',
          '    label: Idea',
          '  - value: prd_complete',
          '    label: PRD Complete',
          '  - value: plan_complete',
          '    label: Plan Complete',
          '  - value: in_progress',
          '    label: In Progress',
          '  - value: in_review',
          '    label: In Review',
          '  - value: done',
          '    label: Done',
          'statusStageCompatibility:',
          '  open: ["", idea, prd_complete, plan_complete, in_progress]',
          '  in-progress: [in_progress]',
          '  blocked: ["", idea, prd_complete, plan_complete, in_progress]',
          '  completed: [in_review, done]',
          '  deleted: [""]'
        ].join('\n'),
        'utf-8'
      );

      const { stdout } = await execAsync(`tsx ${cliPath} --json init`);

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.message).toContain('already exists');
      expect(result.version).toBe('0.0.1');
      expect(result.initializedAt).toBeDefined();

      expect(fs.existsSync('.worklog/initialized')).toBe(true);
      const semaphore = JSON.parse(fs.readFileSync('.worklog/initialized', 'utf-8'));
      expect(semaphore.version).toBe('0.0.1');
      expect(semaphore.initializedAt).toBeDefined();
    } finally {
      leaveTempDir(tempState);
    }
  });

  it('should allow init command without initialization', async () => {
    const tempState = enterTempDir();
    try {
      fs.rmSync('.worklog', { recursive: true, force: true });
      try {
        await execAsync(`tsx ${cliPath} --json init`, { timeout: 1000 });
      } catch (error: any) {
        const errorOutput = error.stdout || error.stderr || '';
        expect(errorOutput).not.toContain('not initialized');
      }
    } finally {
      leaveTempDir(tempState);
    }
  });

  it('should sync remote work items on init in new checkout', async () => {
    const sourceRepo = createTempDir();
    const remoteRepo = createTempDir();
    const cloneRepo = createTempDir();

    try {
      await initRepo(sourceRepo);

      await initBareRepo(remoteRepo);
      await execAsync(`git remote add origin ${remoteRepo}`, { cwd: sourceRepo });
      await execAsync('git push -u origin HEAD', { cwd: sourceRepo });

      writeConfig(sourceRepo, 'Sync Test', 'SYNC');
      writeInitSemaphore(sourceRepo, '0.0.1');

      seedWorkItems(sourceRepo, [
        { title: 'Seed item' },
      ]);
      await execAsync(`tsx ${cliPath} sync`, { cwd: sourceRepo });

      await execAsync(`git clone ${remoteRepo} ${cloneRepo}`);
      await execAsync('git config user.email "test@example.com"', { cwd: cloneRepo });
      await execAsync('git config user.name "Test User"', { cwd: cloneRepo });

      writeConfig(cloneRepo, 'Sync Test', 'SYNC');

      await execAsync(
        `tsx ${cliPath} init --project-name "Sync Test" --prefix SYNC --auto-export yes --auto-sync no --workflow-inline no --agents-template skip --stats-plugin-overwrite no`,
        { cwd: cloneRepo }
      );

      const { stdout } = await execAsync(`tsx ${cliPath} --json list`, { cwd: cloneRepo });
      const listResult = JSON.parse(stdout);
      expect(listResult.success).toBe(true);
      expect(listResult.workItems).toHaveLength(1);
      expect(listResult.workItems[0].title).toBe('Seed item');
    } finally {
      cleanupTempDir(sourceRepo);
      cleanupTempDir(remoteRepo);
      cleanupTempDir(cloneRepo);
    }
  }, 60000);

  // Removed: outside-repo .worklog simulation (not part of the target scenario).

  it('should place .worklog in main repo when initializing', async () => {
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

  it('should find main repo .worklog when in subdirectory', async () => {
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
