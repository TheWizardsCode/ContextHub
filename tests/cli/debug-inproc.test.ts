import { it } from 'vitest';
import { createTempDir, cleanupTempDir } from '../test-utils.js';
import { execAsync, cliPath } from './cli-helpers.js';

it('debug in-process runner outputs', async () => {
  const tmp = createTempDir();
  try {
    // Initialize git repo quickly
    // Use execAsync to run init (this will invoke the CLI in-process)
    const initOut = await execAsync(`tsx ${cliPath} init --project-name "Dbg" --prefix DBG --auto-export yes --auto-sync no --workflow-inline no --agents-template skip --stats-plugin-overwrite no`, { cwd: tmp });
    void initOut;

    const createOut = await execAsync(`tsx ${cliPath} --json create --title "Dbg Item"`, { cwd: tmp });
    void createOut;
  } finally {
    cleanupTempDir(tmp);
  }
}, 45000);
