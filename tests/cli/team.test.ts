import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
import { cleanupTempDir, createTempDir } from '../test-utils.js';
import { getPackageVersion } from './cli-helpers.js';

describe('CLI Team Tests', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  describe('export and import commands', () => {
    beforeEach(() => {
      seedWorkItems(tempState.tempDir, [
        { title: 'Task 1' },
        { title: 'Task 2' },
      ]);
    });

    it('should export data to a file', async () => {
      const exportPath = path.join(tempState.tempDir, 'export-test.jsonl');
      const { stdout } = await execAsync(
        `tsx ${cliPath} --json export -f ${exportPath}`
      );

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.itemsCount).toBe(2);
      expect(fs.existsSync(exportPath)).toBe(true);
    });

    it('should import data from a file', async () => {
      const exportPath = path.join(tempState.tempDir, 'export-test.jsonl');

      await execAsync(`tsx ${cliPath} export -f ${exportPath}`);

      const importTempDir = createTempDir();
      const importOriginalCwd = process.cwd();
      process.chdir(importTempDir);

      try {
        fs.mkdirSync('.worklog', { recursive: true });
        fs.writeFileSync(
          '.worklog/config.yaml',
          [
            'projectName: Test',
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
        fs.writeFileSync(
          '.worklog/initialized',
          JSON.stringify({
            version: getPackageVersion(),
            initializedAt: '2024-01-23T12:00:00.000Z'
          }),
          'utf-8'
        );

        const { stdout } = await execAsync(
          `tsx ${cliPath} --json import -f ${exportPath}`
        );

        const result = JSON.parse(stdout);
        expect(result.success).toBe(true);
        expect(result.itemsCount).toBe(2);
      } finally {
        process.chdir(importOriginalCwd);
        cleanupTempDir(importTempDir);
      }
    });
  });

  describe('sync command', () => {
    it('should fail sync command when not initialized', async () => {
      fs.rmSync('.worklog', { recursive: true, force: true });

      try {
        await execAsync(`tsx ${cliPath} --json sync --dry-run`);
        throw new Error('Expected sync command to fail, but it succeeded');
      } catch (error: any) {
        const result = JSON.parse(error.stdout || '{}');
        expect(result.success).toBe(false);
        expect(result.initialized).toBe(false);
        expect(result.error).toContain('not initialized');
      }
    });

    it('should show sync diagnostics in JSON mode', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json sync debug`);

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.debug).toBeDefined();
      expect(result.debug.file).toBeDefined();
      expect(result.debug.git).toBeDefined();
      expect(result.debug.local).toBeDefined();
      expect(result.debug.remote).toBeDefined();
    });
  });
});
