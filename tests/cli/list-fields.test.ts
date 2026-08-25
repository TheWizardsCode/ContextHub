/**
 * Test: wl list --fields <comma-separated>
 *
 * The `--fields` option projects JSON output to only the requested fields
 * (id always included). Unknown field names are rejected with a clear error
 * listing the valid vocabulary. Without --fields the output is unchanged
 * (backward compatible).
 *
 * See WL-0MT5L55AQ002WTGQ.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execAsync, enterTempDir, leaveTempDir, writeConfig, writeInitSemaphore, seedWorkItems, cliPath } from './cli-helpers.js';

describe('wl list --fields', () => {
  let state: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    state = enterTempDir();
    writeConfig(state.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(state.tempDir);
  });

  afterEach(() => {
    leaveTempDir(state);
  });

  const FULL_ITEM = {
    id: 'TEST-1',
    title: 'Feature item',
    description: 'A long description that should be excluded',
    status: 'in-progress',
    priority: 'high',
    stage: 'in_review',
  };

  it('returns objects with only the requested fields', async () => {
    seedWorkItems(state.tempDir, [FULL_ITEM]);

    const { stdout } = await execAsync(`tsx ${cliPath} list --fields id,title --json`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.workItems).toHaveLength(1);
    const wi = result.workItems[0];
    expect(wi.id).toBe('TEST-1');
    expect(wi.title).toBe('Feature item');
    expect(Object.keys(wi)).toEqual(['id', 'title']);
    expect('description' in wi).toBe(false);
    expect('status' in wi).toBe(false);
    expect('priority' in wi).toBe(false);
  });

  it('always includes id even when not requested', async () => {
    seedWorkItems(state.tempDir, [FULL_ITEM]);

    const { stdout } = await execAsync(`tsx ${cliPath} list --fields title --json`);
    const result = JSON.parse(stdout);
    const wi = result.workItems[0];
    expect(wi.id).toBe('TEST-1');
    expect(wi.title).toBe('Feature item');
    expect(Object.keys(wi).sort()).toEqual(['id', 'title']);
  });

  it('works combined with --stage filter', async () => {
    seedWorkItems(state.tempDir, [
      { id: 'TEST-1', title: 'In review item', status: 'completed', stage: 'in_review' },
      { id: 'TEST-2', title: 'Open item', status: 'open', stage: 'idea' },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} list --stage in_review --fields id,title,status --json`);
    const result = JSON.parse(stdout);
    expect(result.workItems).toHaveLength(1);
    expect(result.workItems[0].id).toBe('TEST-1');
    expect(result.workItems[0].title).toBe('In review item');
    expect(result.workItems[0].status).toBe('completed');
    const keys = Object.keys(result.workItems[0]);
    expect(keys).toEqual(['id', 'title', 'status']);
  });

  it('rejects unknown field names with a clear error listing valid fields', async () => {
    seedWorkItems(state.tempDir, [FULL_ITEM]);

    const { stdout, stderr, code } = await execAsync(`tsx ${cliPath} list --fields id,invalid_field --json`)
      .then((r: any) => ({ stdout: r.stdout || '', stderr: '', code: 0 }))
      .catch((e: any) => ({ stdout: e.stdout || '', stderr: e.stderr || '', code: e.code ?? e.exitCode ?? 1 }));
    expect(code).not.toBe(0);
    const errOut = stderr || stdout;
    expect(errOut).toMatch(/Unknown fields: invalid_field/);
    expect(errOut).toMatch(/Valid fields: /);
    expect(errOut).toContain('id');
    expect(errOut).toContain('title');
    expect(errOut).toContain('status');
  });

  it('outputs full records without --fields (backward compatible)', async () => {
    seedWorkItems(state.tempDir, [FULL_ITEM]);

    const { stdout } = await execAsync(`tsx ${cliPath} list --json`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    const wi = result.workItems[0];
    expect(wi.id).toBe('TEST-1');
    expect(wi.description).toBe('A long description that should be excluded');
    expect(wi.status).toBe('in-progress');
    // Enrichment fields are present without --fields
    expect('auditResult' in wi).toBe(true);
    expect('childCount' in wi).toBe(true);
  });

  it('supports the -f shorthand', async () => {
    seedWorkItems(state.tempDir, [FULL_ITEM]);

    const { stdout } = await execAsync(`tsx ${cliPath} list -f id,title --json`);
    const result = JSON.parse(stdout);
    const wi = result.workItems[0];
    expect(Object.keys(wi)).toEqual(['id', 'title']);
  });

  it('produces smaller output than full records (projection reduces size)', async () => {
    const items = Array.from({ length: 50 }, (_, i) => ({
      id: `TEST-${i + 1}`,
      title: `Item ${i + 1}`,
      description: `A long description for item ${i + 1} ` + 'x'.repeat(200),
      status: 'completed',
      priority: 'medium',
      stage: 'in_review',
    }));
    seedWorkItems(state.tempDir, items);

    const { stdout: fullOut } = await execAsync(`tsx ${cliPath} list --stage in_review --json`);
    const { stdout: fieldOut } = await execAsync(`tsx ${cliPath} list --stage in_review --fields id,title --json`);
    expect(fieldOut.length).toBeLessThan(fullOut.length);
    // >=90% reduction: the field projection drops descriptions entirely
    expect(fieldOut.length).toBeLessThanOrEqual(fullOut.length * 0.1);
  });
});