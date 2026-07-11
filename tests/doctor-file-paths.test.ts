/**
 * Tests for `wl doctor file-paths` subcommand and stage-transition advisory.
 *
 * Tests cover:
 * - doctor file-paths detection (items missing **Key Files:** section)
 * - doctor file-paths --fix feature
 * - Advisory warning on stage transition to intake stage
 *
 * Note: The project's test config uses `prd_complete` as the intake stage
 * name instead of `intake_complete`. The implementation handles both names.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import {
  cliPath,
  execAsync,
  enterTempDir,
  leaveTempDir,
  writeConfig,
  writeInitSemaphore,
  seedWorkItems,
} from './cli/cli-helpers.js';

/**
 * Intake stage name used by the test project config (prd_complete).
 * The convention uses `intake_complete` as the canonical name, but
 * this project configures `prd_complete` instead.
 */
const INTAKE_STAGE = 'prd_complete';

describe('doctor file-paths subcommand', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  it('reports no issues when all intake-stage items have valid **Key Files:** sections', async () => {
    seedWorkItems(tempState.tempDir, [
      {
        id: 'TEST-001',
        title: 'item with paths',
        status: 'open',
        stage: INTAKE_STAGE,
        description: 'Do something.\n\n**Key Files:**\n- `src/foo.ts`\n- `src/bar.ts`',
      },
      {
        id: 'TEST-002',
        title: 'another with paths',
        status: 'open',
        stage: INTAKE_STAGE,
        description: 'Do more.\n\n**Key Files:**\n- `src/baz.ts`',
      },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor file-paths`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.total).toBe(2);
    expect(result.missing).toHaveLength(0);
    expect(result.withIncorrect).toHaveLength(0);
  });

  it('reports intake-stage items missing **Key Files:** section', async () => {
    seedWorkItems(tempState.tempDir, [
      {
        id: 'TEST-001',
        title: 'has paths',
        status: 'open',
        stage: INTAKE_STAGE,
        description: 'Has paths.\n\n**Key Files:**\n- `src/foo.ts`',
      },
      {
        id: 'TEST-002',
        title: 'missing paths',
        status: 'open',
        stage: INTAKE_STAGE,
        description: 'No file paths listed here.',
      },
      {
        id: 'TEST-003',
        title: 'also missing paths',
        status: 'open',
        stage: INTAKE_STAGE,
        description: '',
      },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor file-paths`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.total).toBe(3);
    expect(result.missing).toHaveLength(2);
    const missingIds = result.missing.map((m: any) => m.itemId);
    expect(missingIds).toContain('TEST-002');
    expect(missingIds).toContain('TEST-003');
  });

  it('reports items with **Key Files:** section but no valid paths', async () => {
    seedWorkItems(tempState.tempDir, [
      {
        id: 'TEST-001',
        title: 'valid paths',
        status: 'open',
        stage: INTAKE_STAGE,
        description: 'Has paths.\n\n**Key Files:**\n- `src/foo.ts`',
      },
      {
        id: 'TEST-002',
        title: 'section but no valid paths',
        status: 'open',
        stage: INTAKE_STAGE,
        description: '**Key Files:**\n- https://example.com\n- some text',
      },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor file-paths`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.total).toBe(2);
    expect(result.withIncorrect).toHaveLength(1);
    expect(result.withIncorrect[0].itemId).toBe('TEST-002');
  });

  it('skips non-intake-stage items', async () => {
    seedWorkItems(tempState.tempDir, [
      {
        id: 'TEST-001',
        title: 'idea item missing paths',
        status: 'open',
        stage: 'idea',
        description: 'No paths here.',
      },
      {
        id: 'TEST-002',
        title: 'plan_complete item missing paths',
        status: 'open',
        stage: 'plan_complete',
        description: 'Also no paths.',
      },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor file-paths`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.total).toBe(0); // No intake-stage items to check
    expect(result.missing).toHaveLength(0);
  });

  it('reports empty result when no intake-stage items exist at all', async () => {
    seedWorkItems(tempState.tempDir, [
      {
        id: 'TEST-001',
        title: 'a completed item',
        status: 'completed',
        stage: 'done',
        description: 'Already done.',
      },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor file-paths`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.total).toBe(0);
    expect(result.missing).toHaveLength(0);
  });

  it('accepts --fix to add placeholder **Key Files:** section to missing items', async () => {
    seedWorkItems(tempState.tempDir, [
      {
        id: 'TEST-001',
        title: 'item without paths',
        status: 'open',
        stage: INTAKE_STAGE,
        description: 'This item has no file paths.',
      },
      {
        id: 'TEST-002',
        title: 'item with paths',
        status: 'open',
        stage: INTAKE_STAGE,
        description: 'Has paths.\n\n**Key Files:**\n- `src/bar.ts`',
      },
    ]);

    // Run with --add-placeholder
    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor file-paths --add-placeholder`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.fixed).toBe(1);
    expect(result.fixedItems).toContain('TEST-001');

    // Verify the description was updated
    const { stdout: showStdout } = await execAsync(`tsx ${cliPath} --json show TEST-001`);
    const showResult = JSON.parse(showStdout);
    expect(showResult.workItem.description).toContain('**Key Files:**');
    expect(showResult.workItem.description).toContain('- `TODO: add file paths`');
  });

  it('ignores --fix on items that already have valid key files', async () => {
    seedWorkItems(tempState.tempDir, [
      {
        id: 'TEST-001',
        title: 'item with paths',
        status: 'open',
        stage: INTAKE_STAGE,
        description: 'Has paths.\n\n**Key Files:**\n- `src/bar.ts`',
      },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor file-paths --add-placeholder`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.fixed).toBe(0);
    expect(result.fixedItems).toEqual([]);
  });

  it('produces human-readable output when --json is not used', async () => {
    seedWorkItems(tempState.tempDir, [
      {
        id: 'TEST-001',
        title: 'missing paths',
        status: 'open',
        stage: INTAKE_STAGE,
        description: 'No paths.',
      },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} doctor file-paths`);
    // Human output should mention the item and "Key Files"
    expect(stdout).toContain('TEST-001');
    expect(stdout).toContain('Key Files');
  });
});

// ── Stage-transition advisory ─────────────────────────────────────────

describe('stage-transition advisory warning', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  it('emits a warning when transitioning to intake stage without **Key Files:** section', async () => {
    seedWorkItems(tempState.tempDir, [
      {
        id: 'TEST-001',
        title: 'item without paths',
        status: 'open',
        stage: 'idea',
        description: 'This item has no file paths.',
      },
    ]);

    const { stdout, stderr } = await execAsync(
      `tsx ${cliPath} update TEST-001 --stage ${INTAKE_STAGE}`
    );
    // The warning should be in stderr
    expect(stderr).toContain('Key Files');
    expect(stderr).toContain(INTAKE_STAGE);
    // The transition should still succeed (advisory only, not blocking)
    expect(stdout).toContain('TEST-001');

    // Verify stage was actually updated
    const { stdout: showStdout } = await execAsync(`tsx ${cliPath} --json show TEST-001`);
    const showResult = JSON.parse(showStdout);
    expect(showResult.workItem.stage).toBe(INTAKE_STAGE);
  });

  it('does NOT emit a warning when transitioning to intake stage with **Key Files:** section', async () => {
    seedWorkItems(tempState.tempDir, [
      {
        id: 'TEST-001',
        title: 'item with paths',
        status: 'open',
        stage: 'idea',
        description: '**Key Files:**\n- `src/foo.ts`',
      },
    ]);

    const { stdout, stderr } = await execAsync(
      `tsx ${cliPath} update TEST-001 --stage ${INTAKE_STAGE}`
    );
    // No warning should be in stderr
    expect(stderr).not.toContain('Key Files');

    // Verify stage was updated
    const { stdout: showStdout } = await execAsync(`tsx ${cliPath} --json show TEST-001`);
    const showResult = JSON.parse(showStdout);
    expect(showResult.workItem.stage).toBe(INTAKE_STAGE);
  });

  it('does NOT emit a warning when transitioning to stages other than intake stage', async () => {
    seedWorkItems(tempState.tempDir, [
      {
        id: 'TEST-001',
        title: 'item without paths',
        status: 'open',
        stage: 'idea',
        description: 'No file paths here.',
      },
    ]);

    const { stdout, stderr } = await execAsync(
      `tsx ${cliPath} update TEST-001 --stage plan_complete`
    );
    // No warning about Key Files
    expect(stderr).not.toContain('Key Files');

    // Verify stage was updated
    const { stdout: showStdout } = await execAsync(`tsx ${cliPath} --json show TEST-001`);
    const showResult = JSON.parse(showStdout);
    expect(showResult.workItem.stage).toBe('plan_complete');
  });

  it('emits a warning when transitioning to intake stage with empty description', async () => {
    // Empty descriptions can't have file paths, but the warning should still be advisory
    seedWorkItems(tempState.tempDir, [
      {
        id: 'TEST-001',
        title: 'item with empty description',
        status: 'open',
        stage: 'idea',
        description: '',
      },
    ]);

    const { stdout, stderr } = await execAsync(
      `tsx ${cliPath} update TEST-001 --stage ${INTAKE_STAGE}`
    );
    // Should still warn (empty description means no Key Files section)
    expect(stderr).toContain('Key Files');
    expect(stderr).toContain(INTAKE_STAGE);

    // Verify stage was updated (not blocked)
    const { stdout: showStdout } = await execAsync(`tsx ${cliPath} --json show TEST-001`);
    const showResult = JSON.parse(showStdout);
    expect(showResult.workItem.stage).toBe(INTAKE_STAGE);
  });
});
