import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  cliPath,
  execAsync,
  enterTempDir,
  leaveTempDir,
  writeConfig,
  writeInitSemaphore,
  getPackageVersion
} from './cli-helpers.js';

describe('CLI Status Tests', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  it('should fail when system is not initialized', async () => {
    fs.rmSync('.worklog', { recursive: true, force: true });

    try {
      await execAsync(`tsx ${cliPath} --json status`);
      throw new Error('Expected status command to fail, but it succeeded');
    } catch (error: any) {
      const result = JSON.parse(error.stdout || '{}');
      expect(result.success).toBe(false);
      expect(result.initialized).toBe(false);
      expect(result.error).toContain('not initialized');
    }
  });

  it('should show status when initialized', async () => {
    fs.writeFileSync(
      '.worklog/initialized',
      JSON.stringify({
        version: getPackageVersion(),
        initializedAt: '2024-01-23T12:00:00.000Z'
      }),
      'utf-8'
    );

    const { stdout } = await execAsync(`tsx ${cliPath} --json status`);

    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.initialized).toBe(true);
    expect(result.version).toBe(getPackageVersion());
    expect(result.initializedAt).toBe('2024-01-23T12:00:00.000Z');
    expect(result.config).toBeDefined();
    expect(result.config.projectName).toBe('Test Project');
    expect(result.config.prefix).toBe('TEST');
    expect(result.config.autoSync).toBe(false);
    expect(result.config.githubRepo).toBeUndefined();
    expect(result.config.githubLabelPrefix).toBeUndefined();
    expect(result.config.githubImportCreateNew).toBe(true);
    expect(result.database).toBeDefined();
    expect(result.database.workItems).toBe(0);
    expect(result.database.comments).toBe(0);
  });

  it('should show correct counts in database summary', async () => {
    fs.writeFileSync(
      '.worklog/initialized',
      JSON.stringify({
        version: getPackageVersion(),
        initializedAt: '2024-01-23T12:00:00.000Z'
      }),
      'utf-8'
    );

    await execAsync(`tsx ${cliPath} create -t "Item 1"`);
    await execAsync(`tsx ${cliPath} create -t "Item 2"`);

    const { stdout: listOutput } = await execAsync(`tsx ${cliPath} --json list`);
    const listResult = JSON.parse(listOutput);
    const firstItemId = listResult.workItems[0].id;

    await execAsync(`tsx ${cliPath} comment create ${firstItemId} -a "Test Author" --body "Test comment"`);

    const { stdout } = await execAsync(`tsx ${cliPath} --json status`);

    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.database.workItems).toBe(2);
    expect(result.database.comments).toBe(1);
  }, 60000);

  it('should output human-readable format by default', async () => {
    fs.writeFileSync(
      '.worklog/initialized',
      JSON.stringify({
        version: getPackageVersion(),
        initializedAt: '2024-01-23T12:00:00.000Z'
      }),
      'utf-8'
    );

    const { stdout } = await execAsync(`tsx ${cliPath} status`);

    expect(stdout).toContain('Worklog System Status');
    expect(stdout).toContain('Initialized: Yes');
    expect(stdout).toContain(`Version: ${getPackageVersion()}`);
    expect(stdout).toContain('Configuration:');
    expect(stdout).toContain('Database Summary:');
    expect(stdout).toContain('Work Items:');
    expect(stdout).toContain('Comments:');
  });

  it('should suppress debug messages by default', async () => {
    const { stdout, stderr } = await execAsync(
      `tsx ${cliPath} --json create -t "Test task"`
    );

    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);

    const output = stdout + stderr;
    expect(output).not.toContain('Refreshing database from');
  });


});
