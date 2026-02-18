import { runInProcess } from './cli-inproc.js';
import { it, expect } from 'vitest';
import { createTempDir, cleanupTempDir } from '../test-utils.js';
import * as fs from 'fs';

it('in-process harness preserves options and description-file handling', async () => {
  const temp = createTempDir();
  try {
    process.chdir(temp);
    fs.mkdirSync('.worklog', { recursive: true });
    fs.writeFileSync('.worklog/config.yaml', 'projectName: HarnessTest\nprefix: HRT\nstatuses:\n  - value: open\n    label: Open\nstages:\n  - value: ""\n    label: Undefined\n', 'utf8');
    fs.writeFileSync('.worklog/initialized', JSON.stringify({ version: '1.0.0', initializedAt: new Date().toISOString() }), 'utf8');

    const createRes = await runInProcess(`node src/cli.ts --json create -t "To update"`, 5000);
    const created = JSON.parse(createRes.stdout);
    const id = created.workItem.id;

    const descPath = './harness-desc.txt';
    fs.writeFileSync(descPath, 'Harness desc', 'utf8');

    const updateRes = await runInProcess(`node src/cli.ts --json update ${id} --description-file ${descPath}`, 5000);
    const result = JSON.parse(updateRes.stdout);
    expect(result.success).toBe(true);
    expect(result.workItem.description).toBe('Harness desc');
  } finally {
    cleanupTempDir(temp);
  }
});
