/**
 * CLI e2e tests for FTS index freshness + query-error surfacing
 * (WL-0MSLW8UCP001771K).
 *
 *   - `wl search` finds freshly imported / created items without a manual
 *     `--rebuild-index` (upstream: import()/upsertItems() now upsert FTS rows).
 *   - Punctuated unquoted queries (e.g. `v0.1.11`) are auto-quoted as a
 *     phrase and surface a visible warning in both human and JSON output
 *     (never a silent empty result list).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { writeConfig, writeInitSemaphore } from './cli-helpers.js';
import { createTempDir, cleanupTempDir, resolveTsxBin } from '../test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');
const cliPath = path.join(projectRoot, 'src', 'cli.ts');
const tsxBin = resolveTsxBin(__dirname);

function runCli(
  args: string[],
  cwd: string,
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [tsxBin, cliPath, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 60000,
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

function setup(): string {
  const tempDir = createTempDir();
  writeConfig(tempDir, 'Search FTS Freshness', 'SFF');
  writeInitSemaphore(tempDir);
  return tempDir;
}

describe('wl search — FTS freshness & query-error surfacing', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = setup();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('finds a freshly created punctate item without rebuilding the index', () => {
    // Create an item whose title contains a version string
    const create = runCli(['create', '-t', 'Release v0.1.11'], tempDir);
    expect(create.status).toBe(0);

    // Searching the unquoted punctuated term must NOT be a silent no-match:
    // the item is found (fresh FTS index) and a warning is issued.
    const search = runCli(['search', 'v0.1.11'], tempDir);
    expect(search.status).toBe(0);
    expect(search.stdout).toContain('Release v0.1.11');
    expect(search.stdout.toLowerCase()).toContain('auto-quoted');
  });

  it('surfaces the auto-quote warning in JSON output', () => {
    const create = runCli(['create', '-t', 'Release v0.1.11'], tempDir);
    expect(create.status).toBe(0);

    const search = runCli(['search', 'v0.1.11', '--json'], tempDir);
    expect(search.status).toBe(0);
    const parsed = JSON.parse(search.stdout);
    expect(parsed.success).toBe(true);
    expect(parsed.count).toBeGreaterThanOrEqual(1);
    expect(parsed.warning).toBeDefined();
    expect(String(parsed.warning).toLowerCase()).toContain('auto-quoted');
  });

  it('does not warn for valid quoted-phrase searches', () => {
    const create = runCli(['create', '-t', 'Release v0.1.11'], tempDir);
    expect(create.status).toBe(0);

    const search = runCli(['search', '"v0.1.11"', '--json'], tempDir);
    expect(search.status).toBe(0);
    const parsed = JSON.parse(search.stdout);
    expect(parsed.count).toBeGreaterThanOrEqual(1);
    expect(parsed.warning).toBeUndefined();
  });

  it('returns genuine empty results without a warning', () => {
    const create = runCli(['create', '-t', 'Some work item'], tempDir);
    expect(create.status).toBe(0);

    const search = runCli(['search', 'zzzznonexistentkeyword', '--json'], tempDir);
    expect(search.status).toBe(0);
    const parsed = JSON.parse(search.stdout);
    expect(parsed.count).toBe(0);
    expect(parsed.warning).toBeUndefined();
  });

  it('finds items imported via JSONL without a manual index rebuild', () => {
    // Build a minimal JSONL file and `wl sync-import`/import it.
    const itemId = 'SFF-0000000000000001';
    const item = {
      id: itemId,
      title: 'Imported fresh item',
      description: 'brought in via import',
      status: 'open',
      priority: 'medium',
      sortIndex: 1,
      tags: ['fresh'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const jsonl = tempDir + '/import.jsonl';
    fs.writeFileSync(jsonl, JSON.stringify(item) + '\n');

    const imp = runCli(['import', '--file', jsonl], tempDir);
    expect(imp.status).toBe(0);

    const search = runCli(['search', 'imported fresh', '--json'], tempDir);
    expect(search.status).toBe(0);
    const parsed = JSON.parse(search.stdout);
    expect(parsed.count).toBeGreaterThanOrEqual(1);
    const ids = parsed.workItems.map((r: { id: string }) => r.id);
    expect(ids).toContain(itemId);
  });
});