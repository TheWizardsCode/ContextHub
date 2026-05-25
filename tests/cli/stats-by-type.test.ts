/**
 * Tests for the "By Type" breakdown in `wl stats`.
 *
 * These tests verify that:
 * - `wl stats --json` includes `stats.byType` with correct counts.
 * - Human-readable `wl stats` output contains a "By Type" section.
 * - Items with no type or an unexpected type are grouped under `unknown`.
 *
 * Related work item: Add by Type to wl stats (WL-0MP14Z8R1002WN2Z)
 */

import { describe, it, expect } from 'vitest';
import {
  cliPath,
  execAsync,
  execWithInput,
} from './cli-helpers.js';
import { createTempDir, cleanupTempDir } from '../test-utils.js';
import { initRepo } from './git-helpers.js';

/** Standard init flags that skip interactive prompts. */
const INIT_FLAGS = [
  '--project-name "StatsByTypeTest"',
  '--prefix STATS',
  '--auto-export yes',
  '--auto-sync no',
  '--workflow-inline no',
  '--agents-template skip',
  '--stats-plugin-overwrite no',
].join(' ');

/**
 * Helper: initialise a temp project, copy the stats plugin, and seed work
 * items via the CLI so that they have the correct `issueType` values.
 */
async function setupProjectWithItems(
  items: Array<{ title: string; issueType?: string }>
): Promise<{ tempDir: string }> {
  const tempDir = createTempDir();
  try {
    await initRepo(tempDir);

    await execAsync(
      `tsx ${cliPath} init ${INIT_FLAGS}`,
      { cwd: tempDir },
    );

    // Create items with specific issue types via the CLI
    for (const item of items) {
      const typeFlag = item.issueType
        ? `--issue-type "${item.issueType}"`
        : '';
      await execAsync(
        `tsx ${cliPath} create --json -t "${item.title}" ${typeFlag}`,
        { cwd: tempDir },
      );
    }
  } catch (e) {
    cleanupTempDir(tempDir);
    throw e;
  }
  return { tempDir };
}

/** Extract the first valid JSON object from mixed stdout. */
function extractJson(raw: string): any {
  const start = raw.indexOf('{');
  if (start < 0) throw new SyntaxError(`No JSON object found in output: ${raw.slice(0, 200)}`);
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === '{') depth++;
    else if (raw[i] === '}') depth--;
    if (depth === 0) {
      return JSON.parse(raw.slice(start, i + 1));
    }
  }
  throw new SyntaxError(`Unmatched braces in JSON output: ${raw.slice(0, 200)}`);
}

describe('wl stats — By Type breakdown', () => {
  /**
   * AC — `wl stats --json` must include `stats.byType` with correct counts
   * for known types.
   */
  it('wl stats --json includes byType with correct counts', async () => {
    const { tempDir } = await setupProjectWithItems([
      { title: 'Bug item 1', issueType: 'bug' },
      { title: 'Bug item 2', issueType: 'bug' },
      { title: 'Feature item', issueType: 'feature' },
      { title: 'Task item', issueType: 'task' },
      { title: 'Chore item', issueType: 'chore' },
    ]);
    try {
      const { stdout, stderr, exitCode } = await execWithInput(
        `tsx ${cliPath} --json stats`,
        '',
        { cwd: tempDir },
      );

      expect(exitCode).toBe(0);
      expect(stderr).not.toMatch(/Failed to load plugin/i);

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.stats).toHaveProperty('byType');
      expect(result.stats.byType.bug).toBe(2);
      expect(result.stats.byType.feature).toBe(1);
      expect(result.stats.byType.task).toBe(1);
      expect(result.stats.byType.chore).toBe(1);
    } finally {
      cleanupTempDir(tempDir);
    }
  }, 45000);

  /**
   * AC — Items with no type or an unexpected type must be grouped under
   * `unknown`.
   */
  it('groups items with no type or unexpected type under unknown', async () => {
    const { tempDir } = await setupProjectWithItems([
      { title: 'Known feature', issueType: 'feature' },
      { title: 'No type item' },  // empty issueType
      { title: 'Unknown type', issueType: 'review' },  // not a known type
    ]);
    try {
      const { stdout, exitCode } = await execWithInput(
        `tsx ${cliPath} --json stats`,
        '',
        { cwd: tempDir },
      );

      expect(exitCode).toBe(0);
      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.stats.byType.unknown).toBe(2);
      expect(result.stats.byType.feature).toBe(1);
    } finally {
      cleanupTempDir(tempDir);
    }
  }, 45000);

  /**
   * AC — Empty project (no items) still has `stats.byType` as an empty
   * object in JSON output.
   */
  it('wl stats --json on empty project has empty byType', async () => {
    const tempDir = createTempDir();
    try {
      await initRepo(tempDir);
      await execAsync(
        `tsx ${cliPath} init ${INIT_FLAGS}`,
        { cwd: tempDir },
      );

      const { stdout, exitCode } = await execWithInput(
        `tsx ${cliPath} --json stats`,
        '',
        { cwd: tempDir },
      );

      expect(exitCode).toBe(0);
      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.stats).toHaveProperty('byType');
      expect(Object.keys(result.stats.byType)).toEqual([]);
    } finally {
      cleanupTempDir(tempDir);
    }
  }, 45000);

  /**
   * AC — Human-readable output must include a "By Type" section header.
   */
  it('human-readable output includes By Type section', async () => {
    const { tempDir } = await setupProjectWithItems([
      { title: 'Bug item', issueType: 'bug' },
      { title: 'Feature item', issueType: 'feature' },
    ]);
    try {
      const { stdout, exitCode } = await execWithInput(
        `tsx ${cliPath} stats`,
        '',
        { cwd: tempDir },
      );

      expect(exitCode).toBe(0);
      // Strip ANSI colour codes before checking
      const plainText = stdout.replace(/\x1b\[[0-9;]*m/g, '');
      expect(plainText).toContain('By Type');
    } finally {
      cleanupTempDir(tempDir);
    }
  }, 45000);

  /**
   * AC — Existing `byStatus` and `byPriority` fields must still be present
   * and correct alongside the new `byType` field.
   */
  it('existing byStatus and byPriority fields remain intact', async () => {
    const { tempDir } = await setupProjectWithItems([
      { title: 'Bug item', issueType: 'bug' },
      { title: 'Feature item', issueType: 'feature' },
      { title: 'Task item', issueType: 'task' },
    ]);
    try {
      const { stdout, exitCode } = await execWithInput(
        `tsx ${cliPath} --json stats`,
        '',
        { cwd: tempDir },
      );

      expect(exitCode).toBe(0);
      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);

      // byStatus should be present (all items default to open)
      expect(result.stats).toHaveProperty('byStatus');
      expect(result.stats.byStatus['open']).toBe(3);

      // byPriority should still be present (all items default to medium)
      expect(result.stats).toHaveProperty('byPriority');
      expect(result.stats.byPriority['medium']).toBe(3);

      // byType should also be present
      expect(result.stats).toHaveProperty('byType');
      expect(result.stats.byType.bug).toBe(1);
      expect(result.stats.byType.feature).toBe(1);
      expect(result.stats.byType.task).toBe(1);
    } finally {
      cleanupTempDir(tempDir);
    }
  }, 45000);
});
