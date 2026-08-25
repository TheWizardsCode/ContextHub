/**
 * Integration test: end-to-end --fields flag verification for wl list
 * and wl search (WL-0MT5L6TLQ004NDLK).
 *
 * Complements the per-command unit/integration suites (list-fields.test.ts,
 * search-fields.test.ts) and verifies cross-cutting concerns:
 *   - consistent field vocabulary across `wl list` and `wl search`
 *   - --fields combined with --semantic search keeps projection + search metadata
 *   - size reduction for a large in_review dataset (>=90%)
 *   - non-zero exit + clear error for invalid field names on both commands
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execAsync, enterTempDir, leaveTempDir, writeConfig, writeInitSemaphore, seedWorkItems, cliPath } from './cli-helpers.js';

describe('--fields end-to-end integration', () => {
  let state: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    state = enterTempDir();
    writeConfig(state.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(state.tempDir);
  });

  afterEach(() => {
    leaveTempDir(state);
  });

  it('list and search share the same field vocabulary', async () => {
    // Same invalid field name on both commands → identical error vocabulary.
    const run = (cmd: string) =>
      execAsync(cmd)
        .then((r: any) => ({ stdout: r.stdout || '', code: 0 }))
        .catch((e: any) => ({ stdout: e.stdout || '', stderr: e.stderr || '', code: e.code ?? e.exitCode ?? 1 }));

    seedWorkItems(state.tempDir, [{ id: 'TEST-1', title: 'Vocabulary item', description: 'token phrase', status: 'open' }]);
    const listRun = await run(`tsx ${cliPath} list --fields id,title,bogus --json`);
    const searchRun = await run(`tsx ${cliPath} search token --fields id,title,bogus --json`);

    expect(listRun.code).not.toBe(0);
    expect(searchRun.code).not.toBe(0);
    const listErr = (listRun.stderr || listRun.stdout || '').match(/Valid fields: (.+)/);
    const searchErr = (searchRun.stderr || searchRun.stdout || '').match(/Valid fields: (.+)/);
    expect(listErr).not.toBeNull();
    expect(searchErr).not.toBeNull();
    // Both commands report the same valid-field vocabulary.
    expect(listErr![1]).toBe(searchErr![1]);
    // The vocabulary contains the documented field set.
    for (const f of ['id', 'title', 'description', 'status', 'stage', 'priority', 'issueType', 'assignee', 'tags', 'createdAt', 'updatedAt', 'parentId', 'needsProducerReview', 'sortIndex']) {
      expect(listErr![1]).toContain(f);
    }
  });

  it('search --fields combined with --semantic keeps projection and search metadata', async () => {
    // --semantic falls back to lexical when no embedder is configured; the
    // test asserts the --fields projection still applies to the work-item
    // portion and search metadata stays intact.
    const { stdout: createOut } = await execAsync(
      `tsx ${cliPath} create -t "Semantic searchable item" -d "Unique phrase platypus occupies the lake" --json`
    );
    const created = JSON.parse(createOut);
    expect(created.workItem?.id || created.id).toBeDefined();

    const search = await execAsync(`tsx ${cliPath} search platypus --semantic --fields id,title,status --json`)
      .then((r: any) => ({ stdout: r.stdout || '', code: 0 }))
      .catch((e: any) => ({ stdout: e.stdout || '', stderr: e.stderr || '', code: e.code ?? e.exitCode ?? 1 }));
    expect(search.code).toBe(0);
    const result = JSON.parse(search.stdout);
    expect(result.workItems.length).toBeGreaterThan(0);
    const wi = result.workItems[0];
    expect(wi.id).toBeDefined();
    expect(wi.title).toBe('Semantic searchable item');
    // Projection applied to work-item portion
    expect('status' in wi).toBe(true);
    expect('priority' in wi).toBe(false);
    // Search metadata retained
    expect('score' in wi).toBe(true);
    expect('snippet' in wi).toBe(true);
  });

  it('large in_review dataset: --fields id,title output is >=90% smaller', async () => {
    const items = Array.from({ length: 200 }, (_, i) => ({
      id: `TEST-${i + 1}`,
      title: `Review item ${i + 1}`,
      description: 'x'.repeat(400),
      status: 'completed',
      priority: 'medium',
      stage: 'in_review',
      tags: ['fixture'],
      assignee: 'alice',
    }));
    seedWorkItems(state.tempDir, items);

    const { stdout: fullOut } = await execAsync(`tsx ${cliPath} list --stage in_review --json`);
    const { stdout: fieldOut } = await execAsync(`tsx ${cliPath} list --stage in_review --fields id,title --json`);
    expect(fieldOut.length).toBeLessThan(fullOut.length);
    expect(fieldOut.length).toBeLessThanOrEqual(fullOut.length * 0.1);
    // Projection still returns every matching item (count preserved)
    const full = JSON.parse(fullOut);
    const projected = JSON.parse(fieldOut);
    expect(projected.count).toBe(full.count);
    expect(projected.count).toBe(200);
    // Each projected object has exactly id + title
    for (const wi of projected.workItems) {
      expect(Object.keys(wi)).toEqual(['id', 'title']);
    }
  });
});