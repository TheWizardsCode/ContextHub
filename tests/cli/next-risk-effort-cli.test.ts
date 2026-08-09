/**
 * CLI-level tests for `wl next --risk/--effort` at-most filters
 * (WL-0MSMAIP5F003WAGG). Verifies the exact invocation the herdr
 * downtime implement tier uses:
 *   `wl next --stage plan_complete --risk low --effort small -n N --json`
 * and the fail-closed behavior for invalid filter levels.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { writeConfig, writeInitSemaphore, execAsync } from './cli-helpers.js';
import { createTempDir, cleanupTempDir } from '../test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');
const cliPath = path.join(projectRoot, 'src', 'cli.ts');

describe('wl next --risk/--effort CLI (WL-0MSMAIP5F003WAGG)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    writeConfig(tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempDir);
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  async function createItem(args: string[]): Promise<void> {
    const { stderr } = await execAsync(`tsx ${cliPath} --json create ${args.join(' ')}`, { cwd: tempDir });
    if (stderr && stderr.includes('Error')) {
      throw new Error(`create failed: ${stderr}`);
    }
  }

  async function runNext(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    try {
      const res = await execAsync(`tsx ${cliPath} --json next ${args.join(' ')}`, { cwd: tempDir });
      return { stdout: res.stdout, stderr: res.stderr, code: 0 };
    } catch (e: any) {
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.exitCode ?? 1 };
    }
  }

  it('--risk low --effort small selects only matching plan_complete items', async () => {
    await createItem(['-t', '"Eligible"', '--stage', 'plan_complete', '--risk', 'Low', '--effort', 'Small', '--no-re-sort']);
    await createItem(['-t', '"MediumRisk"', '--stage', 'plan_complete', '--risk', 'Medium', '--effort', 'Small', '--no-re-sort']);
    await createItem(['-t', '"MediumEffort"', '--stage', 'plan_complete', '--risk', 'Low', '--effort', 'Medium', '--no-re-sort']);
    await createItem(['-t', '"WrongStage"', '--stage', 'idea', '--risk', 'Low', '--effort', 'Small', '--no-re-sort']);

    const { stdout } = await runNext(['--stage', 'plan_complete', '--risk', 'low', '--effort', 'small', '-n', '10']);
    const parsed = JSON.parse(stdout);
    const ids = parsed.workItems?.map((r: any) => r.workItem?.id) ?? [];
    expect(ids.length).toBe(1);
    const item = parsed.workItems[0].workItem;
    expect(item.title).toBe('Eligible');
    expect(item.risk).toBe('Low');
    expect(item.effort).toBe('Small');
  });

  it('accepts XS/extra-small effort spellings', async () => {
    await createItem(['-t', '"XS item"', '--stage', 'plan_complete', '--risk', 'Low', '--effort', 'XS', '--no-re-sort']);
    await createItem(['-t', '"S item"', '--stage', 'plan_complete', '--risk', 'Low', '--effort', 'S', '--no-re-sort']);

    const { stdout } = await runNext(['--stage', 'plan_complete', '--risk', 'low', '--effort', 'xs', '-n', '10']);
    const parsed = JSON.parse(stdout);
    const ids = parsed.workItems?.map((r: any) => r.workItem?.id) ?? [];
    expect(ids.length).toBe(1);
    expect(parsed.workItems[0].workItem.title).toBe('XS item');
  });

  it('invalid risk level fails closed with an error', async () => {
    const { stderr, code } = await runNext(['--risk', 'bogus']);
    expect(code).toBe(1);
    expect(stderr).toContain('Invalid risk');
  });

  it('invalid effort level fails closed with an error', async () => {
    const { stderr, code } = await runNext(['--effort', 'bogus']);
    expect(code).toBe(1);
    expect(stderr).toContain('Invalid effort');
  });

  it('no flags behavior is unchanged', async () => {
    await createItem(['-t', '"A"', '-p', 'high', '--no-re-sort']);
    await createItem(['-t', '"B"', '-p', 'medium', '--no-re-sort']);
    const { stdout } = await runNext([]);
    const parsed = JSON.parse(stdout);
    expect(parsed.workItem?.title).toBe('A');
  });
});
