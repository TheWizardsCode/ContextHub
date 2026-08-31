/**
 * Test: wl search --fields <comma-separated>
 *
 * The `--fields` option projects the work-item object portion of search
 * results (id always included). Search-specific fields (score, snippet,
 * matchedField) are always included, even when a projection is active.
 * Unknown field names are rejected with a clear error listing the valid
 * vocabulary. Without --fields the output is unchanged.
 *
 * See WL-0MT5L6G88006N4WD.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execAsync, enterTempDir, leaveTempDir, writeConfig, writeInitSemaphore, cliPath } from './cli-helpers.js';

describe('wl search --fields', () => {
  let state: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    state = enterTempDir();
    writeConfig(state.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(state.tempDir);
  });

  afterEach(() => {
    leaveTempDir(state);
  });

  async function createItem(title: string, description: string, extraArgs: string[] = []): Promise<string> {
    const { stdout } = await execAsync(
      `tsx ${cliPath} create -t "${title}" -d "${description}" ${extraArgs.join(' ')} --json`
    );
    const parsed = JSON.parse(stdout);
    return parsed.workItem?.id ?? parsed.id ?? '';
  }

  it('returns compact objects with only the requested fields plus search metadata', async () => {
    await createItem('Searchable feature item', 'Unique phrase zebra appears here', ['-p', 'high', '-s', 'in-progress', '--stage', 'in_progress']);

    const { stdout } = await execAsync(`tsx ${cliPath} search zebra --fields id,title,status --json`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.workItems).toBeDefined();
    expect(result.workItems.length).toBeGreaterThan(0);
    const wi = result.workItems[0];
    expect(wi.id).toBeDefined();
    expect(wi.title).toBe('Searchable feature item');
    expect(wi.status).toBe('in-progress');
    // Search-specific fields always present
    expect('score' in wi).toBe(true);
    expect('snippet' in wi).toBe(true);
    expect('matchedField' in wi).toBe(true);
    // Non-requested work-item fields omitted
    expect('priority' in wi).toBe(false);
    expect('description' in wi).toBe(false);
    // id is present in the projected object
    expect(Object.keys(wi)).toContain('id');
  });

  it('always includes id in the projected item', async () => {
    await createItem('Another searchable item', 'Unique phrase giraffe appears here');

    const { stdout } = await execAsync(`tsx ${cliPath} search giraffe --fields status --json`);
    const result = JSON.parse(stdout);
    expect(result.workItems.length).toBeGreaterThan(0);
    const wi = result.workItems[0];
    expect(wi.id).toBeDefined();
    expect(wi.status).toBe('open');
  });

  it('rejects unknown field names with a clear error listing valid fields', async () => {
    await createItem('Searchable item', 'Unique phrase lion appears here');

    const { stdout, stderr, code } = await execAsync(`tsx ${cliPath} search lion --fields id,invalid_field --json`)
      .then((r: any) => ({ stdout: r.stdout || '', stderr: '', code: 0 }))
      .catch((e: any) => ({ stdout: e.stdout || '', stderr: e.stderr || '', code: e.code ?? e.exitCode ?? 1 }));
    expect(code).not.toBe(0);
    const errOut = stderr || stdout;
    expect(errOut).toMatch(/Unknown fields: invalid_field/);
    expect(errOut).toMatch(/Valid fields: /);
    expect(errOut).toContain('title');
    expect(errOut).toContain('description');
  });

  it('output is unchanged without --fields (backward compatible)', async () => {
    await createItem('Plain searchable item', 'Unique phrase tiger appears here', ['-p', 'medium']);

    const { stdout } = await execAsync(`tsx ${cliPath} search tiger --json`);
    const result = JSON.parse(stdout);
    expect(result.workItems.length).toBeGreaterThan(0);
    const wi = result.workItems[0];
    expect(wi.id).toBeDefined();
    expect(wi.title).toBe('Plain searchable item');
    expect(wi.priority).toBe('medium');
    expect('snippet' in wi).toBe(true);
  });
});