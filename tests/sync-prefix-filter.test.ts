/**
 * Tests for the cross-project prefix merge filter (SA-0MSC0BM1V0032UYT).
 *
 * Defense-in-depth behind `assertDataFileInCwdRepo` (WL-0MSAH26DD001XXST):
 * even if a sync reaches the merge step with foreign data (e.g. a stale
 * long-running process that loaded pre-fix modules, or a repo-context check
 * bypass), work items whose ID prefix does not match the project prefix are
 * never imported — and their comments, dependency edges and audit results
 * are dropped with them.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { isOwnProjectItemId, filterRemoteDataByPrefix } from '../src/sync.js';
import type { WorkItem, Comment, DependencyEdge, AuditResult } from '../src/types.js';
import { execWithInput, writeConfig, writeInitSemaphore, cliPath } from './cli/cli-helpers.js';
import { createTempDir, cleanupTempDir } from './test-utils.js';

// ── Fixtures ──────────────────────────────────────────────────────────────

function makeItem(id: string, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    title: `Item ${id}`,
    description: '',
    status: 'open',
    priority: 'medium',
    sortIndex: 0,
    parentId: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    tags: [],
    assignee: '',
    stage: '',
    issueType: '',
    createdBy: '',
    deletedBy: '',
    deleteReason: '',
    risk: '' as const,
    effort: '' as const,
    ...overrides,
  };
}

function makeComment(id: string, workItemId: string, overrides: Partial<Comment> = {}): Comment {
  return {
    id,
    workItemId,
    author: 'tester',
    comment: `comment ${id}`,
    createdAt: '2024-01-01T00:00:00.000Z',
    references: [],
    ...overrides,
  };
}

function makeAudit(workItemId: string, overrides: Partial<AuditResult> = {}): AuditResult {
  return {
    workItemId,
    readyToClose: false,
    auditedAt: '2024-01-01T00:00:00.000Z',
    summary: null,
    rawOutput: null,
    author: null,
    ...overrides,
  };
}

// ── Unit tests: isOwnProjectItemId ────────────────────────────────────────

describe('isOwnProjectItemId (SA-0MSC0BM1V0032UYT)', () => {
  it('keeps items whose prefix matches the project prefix', () => {
    expect(isOwnProjectItemId('GUA-001', 'GUA')).toBe(true);
    expect(isOwnProjectItemId('GUA-abc', 'GUA')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(isOwnProjectItemId('gua-001', 'GUA')).toBe(true);
    expect(isOwnProjectItemId('GUA-001', 'gua')).toBe(true);
  });

  it('rejects items with a foreign prefix', () => {
    expect(isOwnProjectItemId('WL-001', 'GUA')).toBe(false);
    expect(isOwnProjectItemId('SA-001', 'GUA')).toBe(false);
    expect(isOwnProjectItemId('OB-0MN9CZ48N0053L9Q', 'GUA')).toBe(false);
  });

  it('keeps unclassifiable IDs (no dash, or leading dash) — consistent with wl doctor foreign-items', () => {
    expect(isOwnProjectItemId('12345', 'GUA')).toBe(true);
    expect(isOwnProjectItemId('-leading-dash', 'GUA')).toBe(true);
    expect(isOwnProjectItemId('', 'GUA')).toBe(true);
  });
});

// ── Unit tests: filterRemoteDataByPrefix ──────────────────────────────────

describe('filterRemoteDataByPrefix (SA-0MSC0BM1V0032UYT)', () => {
  it('drops foreign-prefix items and keeps own items', () => {
    const own = makeItem('GUA-001');
    const foreign = makeItem('WL-001');
    const result = filterRemoteDataByPrefix([own, foreign], [], [], [], 'GUA');

    expect(result.items.map(i => i.id)).toEqual(['GUA-001']);
    expect(result.droppedItems).toEqual(['WL-001']);
  });

  it('drops comments attached to dropped foreign items, keeps comments of own items', () => {
    const own = makeItem('GUA-001');
    const foreign = makeItem('WL-001');
    const comments = [
      makeComment('c1', 'GUA-001'),
      makeComment('c2', 'WL-001'),
    ];
    const result = filterRemoteDataByPrefix([own, foreign], comments, [], [], 'GUA');

    expect(result.comments.map(c => c.id)).toEqual(['c1']);
  });

  it('keeps edges whose either endpoint is a local item, drops only both-foreign edges', () => {
    const ownA = makeItem('GUA-001');
    const ownB = makeItem('GUA-002');
    const foreign = makeItem('WL-001');
    const edges: DependencyEdge[] = [
      { fromId: 'GUA-001', toId: 'GUA-002', createdAt: '2024-01-01T00:00:00.000Z' },
      { fromId: 'GUA-001', toId: 'WL-001', createdAt: '2024-01-01T00:00:00.000Z' },
      { fromId: 'WL-001', toId: 'GUA-002', createdAt: '2024-01-01T00:00:00.000Z' },
    ];
    const result = filterRemoteDataByPrefix([ownA, ownB, foreign], [], edges, [], 'GUA');

    // local→local kept, local→foreign kept, foreign→local kept
    expect(result.edges).toEqual([
      { fromId: 'GUA-001', toId: 'GUA-002', createdAt: '2024-01-01T00:00:00.000Z' },
      { fromId: 'GUA-001', toId: 'WL-001', createdAt: '2024-01-01T00:00:00.000Z' },
      { fromId: 'WL-001', toId: 'GUA-002', createdAt: '2024-01-01T00:00:00.000Z' },
    ]);
    expect(result.droppedEdges).toEqual([]);
  });

  it('drops only edges whose both endpoints are foreign', () => {
    const foreignA = makeItem('WL-001');
    const foreignB = makeItem('SA-002');
    const edges: DependencyEdge[] = [
      { fromId: 'WL-001', toId: 'SA-002', createdAt: '2024-01-01T00:00:00.000Z' },
    ];
    const result = filterRemoteDataByPrefix([foreignA, foreignB], [], edges, [], 'GUA');

    expect(result.edges).toEqual([]);
    expect(result.droppedEdges).toEqual(['WL-001->SA-002']);
  });

  it('keeps local→foreign cross-repo edges and reports dropped both-foreign edges', () => {
    // Regression case for WL-0MWXBHODR002ZLJG → SA-0MWFFD9N0050SP5
    const local = makeItem('WL-0MWXBHODR002ZLJG');
    const foreign = makeItem('SA-0MWFFD9N0050SP5');
    const edges: DependencyEdge[] = [
      { fromId: 'WL-0MWXBHODR002ZLJG', toId: 'SA-0MWFFD9N0050SP5', createdAt: '2024-01-01T00:00:00.000Z' },
    ];
    const result = filterRemoteDataByPrefix([local, foreign], [], edges, [], 'WL');

    expect(result.edges).toEqual([
      { fromId: 'WL-0MWXBHODR002ZLJG', toId: 'SA-0MWFFD9N0050SP5', createdAt: '2024-01-01T00:00:00.000Z' },
    ]);
    expect(result.droppedEdges).toEqual([]);
  });

  it('reports dropped both-foreign edge ids for observability', () => {
    const foreignA = makeItem('WL-001');
    const foreignB = makeItem('SA-002');
    const edges: DependencyEdge[] = [
      { fromId: 'WL-001', toId: 'SA-002', createdAt: '2024-01-01T00:00:00.000Z' },
      { fromId: 'WL-002', toId: 'SA-003', createdAt: '2024-01-01T00:00:00.000Z' },
    ];
    const result = filterRemoteDataByPrefix([foreignA, foreignB, makeItem('WL-002'), makeItem('SA-003')], [], edges, [], 'GUA');

    expect(result.droppedEdges.sort()).toEqual(['WL-001->SA-002', 'WL-002->SA-003']);
  });

  it('drops audit results of dropped foreign items, keeps audits of own items', () => {
    const own = makeItem('GUA-001');
    const foreign = makeItem('WL-001');
    const audits = [
      makeAudit('GUA-001', { readyToClose: true }),
      makeAudit('WL-001', { readyToClose: true }),
    ];
    const result = filterRemoteDataByPrefix([own, foreign], [], [], audits, 'GUA');

    expect(result.audits.map(a => a.workItemId)).toEqual(['GUA-001']);
  });

  it('reports the dropped foreign item ids for observability', () => {
    const result = filterRemoteDataByPrefix(
      [makeItem('GUA-001'), makeItem('WL-001'), makeItem('SA-002')],
      [],
      [],
      [],
      'GUA'
    );
    expect(result.droppedItems.sort()).toEqual(['SA-002', 'WL-001']);
  });
});

// ── CLI integration: sync must not import foreign items from a polluted ref ──

function jsonlLine(type: string, data: unknown): string {
  return JSON.stringify({ data, type });
}

describe('sync prefix filter — polluted remote ref (SA-0MSC0BM1V0032UYT)', () => {
  let repoA: string; // target project (prefix GUA)
  let repoB: string; // "remote" whose ref contains own + foreign items

  beforeEach(() => {
    repoA = createTempDir();
    repoB = createTempDir();
    for (const repo of [repoA, repoB]) {
      fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    }
    writeConfig(repoA, 'Prefix Filter Test', 'GUA');
    writeInitSemaphore(repoA);
    // Point repoA's remote at repoB so the mock git fetch reads repoB's .worklog.
    fs.writeFileSync(path.join(repoA, '.git', 'remote_origin'), repoB, 'utf8');

    // Seed the "remote" worklog ref with own + foreign items (and their
    // comments/edges) — simulating a polluted remote snapshot.
    const lines = [
      jsonlLine('workitem', {
        ...makeItem('GUA-100', { title: 'Own item' }),
        // Cross-repo blocker owned by the local item — must survive sync.
        dependencies: [{ from: 'GUA-100', to: 'SA-0MWFFD9N0050SP5' }],
      }),
      jsonlLine('workitem', {
        ...makeItem('WL-200', { title: 'Foreign item' }),
        // Fully-foreign edge — must be dropped and reported by the filter.
        // The foreign→local edge survives the filter (either endpoint rule)
        // but is unstorable at persist (`fromId` FK) — it must be reported
        // there, never dropped silently (WL-0MWXIT6H3006TY2I AC5).
        dependencies: [
          { from: 'WL-200', to: 'SA-300' },
          { from: 'WL-200', to: 'GUA-100' },
        ],
      }),
      jsonlLine('workitem', makeItem('SA-300', { title: 'Another foreign item' })),
      jsonlLine('workitem', makeItem('SA-0MWFFD9N0050SP5', { title: 'Sibling blocker' })),
      jsonlLine('comment', makeComment('cc1', 'GUA-100')),
      jsonlLine('comment', makeComment('cc2', 'WL-200')),
      jsonlLine('audit_result', makeAudit('GUA-100')),
      jsonlLine('audit_result', makeAudit('WL-200')),
    ];
    fs.mkdirSync(path.join(repoB, '.worklog'), { recursive: true });
    fs.writeFileSync(
      path.join(repoB, '.worklog', 'worklog-data.jsonl'),
      `${lines.join('\n')}\n`,
      'utf8'
    );
  });

  afterEach(() => {
    cleanupTempDir(repoA);
    cleanupTempDir(repoB);
  });

  it('syncs only own-prefix items and never imports foreign ones (real CLI)', async () => {
    const { stdout, stderr, exitCode } = await execWithInput(
      `tsx ${cliPath} --worklog-dir ${repoA}/.worklog sync --no-push`,
      '',
      { cwd: repoA, timeout: 60000 }
    );
    const output = `${stdout}\n${stderr}`;
    expect(exitCode, output).toBe(0);

    // The local database must contain ONLY own-prefix items.
    const list = await execWithInput(
      `tsx ${cliPath} --worklog-dir ${repoA}/.worklog list --json`,
      '',
      { cwd: repoA, timeout: 30000 }
    );
    expect(list.exitCode, `${list.stdout}\n${list.stderr}`).toBe(0);
    const payload = JSON.parse(list.stdout);
    const items: Array<{ id: string; title: string }> = payload.workItems ?? payload;
    expect(items.length).toBeGreaterThan(0);
    const ids = items.map(it => it.id);
    expect(ids).toContain('GUA-100');
    expect(ids).not.toContain('WL-200');
    expect(ids).not.toContain('SA-300');
    for (const it of items) {
      expect(it.id.startsWith('GUA-'), `foreign item imported: ${it.id}`).toBe(true);
    }
  }, 90000);

  it('keeps a local→foreign cross-repo edge through a full sync (WL-0MWXIT6H3006TY2I)', async () => {
    const sync = await execWithInput(
      `tsx ${cliPath} --worklog-dir ${repoA}/.worklog sync --no-push`,
      '',
      { cwd: repoA, timeout: 60000 }
    );
    expect(sync.exitCode, `${sync.stdout}\n${sync.stderr}`).toBe(0);

    // Keep foreign discovery fast and deterministic: point the projects root at
    // an empty directory so `dep list` never scans the shared temp parent.
    const emptyProjectsRoot = createTempDir();
    try {
      const configPath = path.join(repoA, '.worklog', 'config.yaml');
      fs.appendFileSync(configPath, `\nprojectsRoot: ${emptyProjectsRoot}\n`, 'utf8');

      // The owning item imported with its foreign blocker still attached.
      const depList = await execWithInput(
        `tsx ${cliPath} --worklog-dir ${repoA}/.worklog dep list GUA-100 --json`,
        '',
        { cwd: repoA, timeout: 30000 }
      );
      expect(depList.exitCode, `${depList.stdout}\n${depList.stderr}`).toBe(0);
      const payload = JSON.parse(depList.stdout);
      const outbound = (payload.outbound ?? []) as Array<{ id: string; foreign?: boolean }>;
      expect(outbound.map(e => e.id)).toContain('SA-0MWFFD9N0050SP5');
    } finally {
      cleanupTempDir(emptyProjectsRoot);
    }

    // And it is present in the dependency_edges table, not just the CLI view.
    const Database = (await import('better-sqlite3')).default;
    const raw = new Database(path.join(repoA, '.worklog', 'worklog.db'), { readonly: true });
    try {
      const rows = raw
        .prepare('SELECT fromId, toId FROM dependency_edges WHERE fromId = ?')
        .all('GUA-100') as Array<{ fromId: string; toId: string }>;
      expect(rows.map(r => r.toId)).toContain('SA-0MWFFD9N0050SP5');
    } finally {
      raw.close();
    }
  }, 120000);

  it('reports both-foreign edges the filter drops (never silent)', async () => {
    const sync = await execWithInput(
      `tsx ${cliPath} --worklog-dir ${repoA}/.worklog sync --no-push`,
      '',
      { cwd: repoA, timeout: 60000 }
    );
    expect(sync.exitCode, `${sync.stdout}\n${sync.stderr}`).toBe(0);
    const output = `${sync.stdout}\n${sync.stderr}`;
    expect(output).toMatch(/dropped \d+ edge\(s\)/i);
    expect(output).toContain('WL-200->SA-300');
  }, 90000);

  it('reports foreign→local edges the persist step cannot store (never silent)', async () => {
    // `WL-200 → GUA-100` survives the prefix filter (either endpoint is a
    // local item) but cannot be written: `dependency_edges` has a foreign key
    // on `fromId`, and WL-200 is not a local item. The persist diagnostics
    // must name it so the loss is not silent (WL-0MWXIT6H3006TY2I AC5).
    const sync = await execWithInput(
      `tsx ${cliPath} --worklog-dir ${repoA}/.worklog sync --no-push`,
      '',
      { cwd: repoA, timeout: 60000 }
    );
    expect(sync.exitCode, `${sync.stdout}\n${sync.stderr}`).toBe(0);
    const output = `${sync.stdout}\n${sync.stderr}`;
    expect(output).toMatch(/Foreign-edge persist: dropped 1 edge\(s\)/);
    expect(output).toContain('WL-200->GUA-100');
  }, 90000);

  it('carries persist-dropped edges in the --json sync summary (never silent)', async () => {
    const sync = await execWithInput(
      `tsx ${cliPath} --worklog-dir ${repoA}/.worklog sync --no-push --json`,
      '',
      { cwd: repoA, timeout: 60000 }
    );
    expect(sync.exitCode, `${sync.stdout}\n${sync.stderr}`).toBe(0);
    const payload = JSON.parse(sync.stdout);
    expect(payload.sync.summary.droppedEdges).toContain('WL-200->GUA-100');
  }, 90000);
});
