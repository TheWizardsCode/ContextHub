import { runInProcess } from '../cli/cli-inproc.js';
import { it, expect } from 'vitest';
import { createTempDir, cleanupTempDir } from '../test-utils.js';
import * as fs from 'fs';
import * as path from 'path';

it('debug update with description-file', async () => {
  const temp = createTempDir();
  try {
    process.chdir(temp);
    // write minimal config and initialized semaphore
    fs.mkdirSync('.worklog', { recursive: true });
    fs.writeFileSync('.worklog/config.yaml', 'projectName: Debug\nprefix: DBG\nstatuses:\n  - value: open\n    label: Open\nstages:\n  - value: ""\n    label: Undefined\n', 'utf8');
    fs.writeFileSync('.worklog/initialized', JSON.stringify({ version: '1.0.0', initializedAt: new Date().toISOString() }), 'utf8');

    // create an item
    const createRes = await runInProcess(`node src/cli.ts --json create -t "To update"`, 5000);
    console.log('CREATE STDOUT:\n', createRes.stdout);
    console.log('CREATE STDERR:\n', createRes.stderr);
    const created = JSON.parse(createRes.stdout);
    const id = created.workItem.id;

    // write description file
    const descPath = './debug-desc.txt';
    fs.writeFileSync(descPath, 'Debug desc', 'utf8');

    const updateRes = await runInProcess(`node src/cli.ts --json update ${id} --description-file ${descPath}`, 5000);
    console.log('UPDATE STDOUT:\n', updateRes.stdout);
    console.log('UPDATE STDERR:\n', updateRes.stderr);
    // fail if not successful
    const result = JSON.parse(updateRes.stdout);
    expect(result.success).toBe(true);
    expect(result.workItem.description).toBe('Debug desc');
  } finally {
    cleanupTempDir(temp);
  }
});
