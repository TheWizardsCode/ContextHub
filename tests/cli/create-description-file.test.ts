import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execAsync, enterTempDir, leaveTempDir, writeConfig, writeInitSemaphore, cliPath } from './cli-helpers.js';
import * as fs from 'fs';

describe('create/update with --description-file', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  it('create should read description from file', async () => {
    const descPath = './desc.txt';
    fs.writeFileSync(descPath, 'File description', 'utf8');

    const { stdout } = await execAsync(`tsx ${cliPath} --json create -t "From file" --description-file ${descPath}`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.workItem.description).toBe('File description');
  });

  it('update should read description from file', async () => {
    const createOut = await execAsync(`tsx ${cliPath} --json create -t "To update"`);
    const created = JSON.parse(createOut.stdout);
    const id = created.workItem.id;

    const descPath = './update-desc.txt';
    fs.writeFileSync(descPath, 'Updated from file', 'utf8');

    const { stdout } = await execAsync(`tsx ${cliPath} --json update ${id} --description-file ${descPath}`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.workItem.description).toBe('Updated from file');
  });
});
