/**
 * CLI integration tests for ID-first `wl create` output (WL-0MSTNG2QF0049B97,
 * RCA fix #2 — feature WL-0MSU8E2YA0059GEA).
 *
 * The created ID must be robustly visible so output-trimming tools (tail,
 * E2BIG truncation) cannot hide it: human mode prints an `ID: <id>` line
 * first; `--json` output carries a top-level `id` field as the first key.
 * This reduces the retry frequency that triggers the dedup guard.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  cliPath,
  execAsync,
  enterTempDir,
  leaveTempDir,
  writeConfig,
  writeInitSemaphore,
} from './cli-helpers.js';

describe('wl create ID-first output', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  async function createJson(flags = ''): Promise<any> {
    const { stdout } = await execAsync(
      `tsx ${cliPath} --json create -t "Some Title" ${flags}`
    );
    return JSON.parse(stdout);
  }

  // AC1: Human mode — first line of output is `ID: <id>`
  it('AC1: prints an ID: <id> line as the first line in human mode', async () => {
    const { stdout } = await execAsync(`tsx ${cliPath} create -t "Some Title"`);
    const lines = stdout.split('\n');
    expect(lines[0]).toMatch(/^ID: TEST-[A-Z0-9]+$/);
  });

  // AC2: JSON mode — `id` is the first key of the output object and matches workItem.id
  it('AC2: top-level id is the first JSON key and matches workItem.id', async () => {
    const result = await createJson();
    expect(Object.keys(result)[0]).toBe('id');
    expect(result.id).toBe(result.workItem.id);
    expect(result.workItem.id).toMatch(/^TEST-/);
    // id also leads the workItem object itself
    expect(Object.keys(result.workItem)[0]).toBe('id');
  });

  // AC3a: Duplicate case (human) — `ID: <existing-id>` still appears as first line
  it('AC3: duplicate retry in human mode still leads with ID: <existing-id>', async () => {
    const first = await createJson();
    const { stdout } = await execAsync(`tsx ${cliPath} create -t "Some Title"`);
    const lines = stdout.split('\n');
    expect(lines[0]).toBe(`ID: ${first.workItem.id}`);
    // The duplicate marker follows the ID line.
    expect(lines.slice(1).join('\n')).toContain('Duplicate of');
  });

  // AC3b: Duplicate case (JSON) — top-level id still present and first
  it('AC3: duplicate retry in JSON mode carries a first-key id equal to duplicateOf', async () => {
    const first = await createJson();
    const retry = await createJson();
    expect(Object.keys(retry)[0]).toBe('id');
    expect(retry.id).toBe(first.workItem.id);
    expect(retry.duplicateOf).toBe(first.workItem.id);
    expect(retry.workItem.id).toBe(first.workItem.id);
  });
});
