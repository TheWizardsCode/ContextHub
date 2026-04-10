import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execAsync, enterTempDir, leaveTempDir, writeConfig, writeInitSemaphore, seedWorkItems, cliPath } from './cli-helpers.js';

describe('Human snapshots: show and list outputs with audit', () => {
  let state: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    state = enterTempDir();
    writeConfig(state.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(state.tempDir);
  });

  afterEach(() => {
    leaveTempDir(state);
  });

  it('renders concise/list and single-item human outputs with and without audit (snapshots)', async () => {
    // Seed two work items: one with audit and one without
    seedWorkItems(state.tempDir, [
      {
        id: 'TEST-1',
        title: 'Audited task',
        audit: { time: '2026-01-01T00:00:00Z', author: 'alice', text: 'Ready to close: Yes\nExtra details' }
      },
      {
        id: 'TEST-2',
        title: 'No audit'
      }
    ]);

    // List (human) - compact output used by default
    const { stdout: listOut } = await execAsync(`tsx ${cliPath} list`);
    expect(listOut).toMatchSnapshot('human-list-with-audit');

    // Single-item show (human)
    const { stdout: showOut } = await execAsync(`tsx ${cliPath} show TEST-1`);
    expect(showOut).toMatchSnapshot('human-show-with-audit');

    // Single-item show for item without audit should not include an Audit block/placeholder
    const { stdout: showOut2 } = await execAsync(`tsx ${cliPath} show TEST-2`);
    expect(showOut2).toMatchSnapshot('human-show-without-audit');
  });
});
