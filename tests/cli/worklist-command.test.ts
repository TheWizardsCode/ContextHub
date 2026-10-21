/**
 * Tests for the consolidated `wl worklist` read (WL-0MVI0HX58009JJRF, parent
 * WL-0MVGYLU0S004WZUS).
 *
 * The command replaces five per-refresh `wl` spawns (four mandatory `wl list`
 * subsets + the `wl next` browse feed) with one process, one DB open and one
 * payload. These tests pin the contract the Herdr fetcher relies on:
 *
 *   - payload shape: five always-present subsets + metadata;
 *   - filter parity: each list subset matches the equivalent `wl list` query;
 *   - browse parity: the `browse` subset is item-for-item identical to
 *     `wl next -n <count> --include-in-progress --include-blocked --no-re-sort`;
 *   - one DB open per invocation, with all four list queries on that handle;
 *   - pure read: never bumps the read-cache state counter;
 *   - bounded: the browse feed honours `-n`, the mandatory subsets do not.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { Command } from 'commander';
import {
  cliPath,
  execAsync,
  enterTempDir,
  leaveTempDir,
  seedWorklistFixture,
  writeConfig,
  writeInitSemaphore,
  type WorklistFixture,
} from './cli-helpers.js';
import { createTempDir, cleanupTempDir } from '../test-utils.js';
import { runCliProcess } from './cli-bundle.js';
import { createPluginContext } from '../../src/cli-utils.js';
import registerWorklist, {
  WORKLIST_DEFAULT_BROWSE_COUNT,
  WORKLIST_LIST_SUBSET_QUERIES,
} from '../../src/commands/worklist.js';
import { readStateCounter } from '../../src/read-cache.js';
import { setWorklogDirOverride } from '../../src/worklog-paths.js';
import { BUILT_IN_COMMAND_NAMES, COMMAND_LOADERS } from '../../src/command-registry.js';

interface WorklistSubsets {
  critical: Array<Record<string, any>>;
  reviewQueue: Array<Record<string, any>>;
  inProgressRoots: Array<Record<string, any>>;
  blockedRoots: Array<Record<string, any>>;
  browse: Array<Record<string, any>>;
}

interface WorklistPayload {
  success: boolean;
  worklogDir: string;
  requestedCount: number;
  subsets: WorklistSubsets;
}

/** Run `wl worklist --json` in-process (via the shared CLI harness). */
async function worklist(args: string = ''): Promise<WorklistPayload> {
  const { stdout } = await execAsync(`tsx ${cliPath} --json worklist ${args}`);
  return JSON.parse(stdout) as WorklistPayload;
}

/** Run `wl list --json <args>` in-process and return its items. */
async function listItems(args: string): Promise<Array<Record<string, any>>> {
  const { stdout } = await execAsync(`tsx ${cliPath} --json list ${args}`);
  return JSON.parse(stdout).workItems as Array<Record<string, any>>;
}

/** Stable ids of a subset, for order-sensitive comparisons. */
function ids(items: Array<Record<string, any>>): string[] {
  return items.map((item) => String(item.id));
}

const SUBSET_KEYS: ReadonlyArray<keyof WorklistSubsets> = [
  'critical',
  'reviewQueue',
  'inProgressRoots',
  'blockedRoots',
  'browse',
];

describe('wl worklist: registration', () => {
  it('is a built-in command with a lazy loader', () => {
    expect(BUILT_IN_COMMAND_NAMES).toContain('worklist');
    expect(typeof COMMAND_LOADERS.worklist).toBe('function');
  });

  it('documents its options on subcommand help', async () => {
    const { stdout } = await execAsync(`tsx ${cliPath} worklist --help`);
    expect(stdout).toContain('worklist');
    expect(stdout).toContain('-n, --number');
    expect(stdout).toContain('--prefix');
    // Grouped help placement is pinned by tests/cli/lazy-command-registry.test.ts.
  });
});

describe('wl worklist: payload contract', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  it('returns all five subset keys as empty arrays with metadata on an empty worklog', async () => {
    writeConfig(tempState.tempDir, 'Empty Worklog', 'EMP');
    writeInitSemaphore(tempState.tempDir);

    const payload = await worklist();

    expect(payload.success).toBe(true);
    expect(payload.requestedCount).toBe(WORKLIST_DEFAULT_BROWSE_COUNT);
    expect(payload.worklogDir).toBe(path.join(tempState.tempDir, '.worklog'));
    expect(Object.keys(payload.subsets).sort()).toEqual([...SUBSET_KEYS].sort());
    for (const key of SUBSET_KEYS) {
      expect(Array.isArray(payload.subsets[key])).toBe(true);
      expect(payload.subsets[key]).toHaveLength(0);
    }
  });

  it('honours -n for the requested browse count', async () => {
    writeConfig(tempState.tempDir, 'Empty Worklog', 'EMP');
    writeInitSemaphore(tempState.tempDir);

    const payload = await worklist('-n 7');
    expect(payload.requestedCount).toBe(7);
  });
});

describe('wl worklist: seeded worklog', () => {
  let tempState: { tempDir: string; originalCwd: string };
  let fixture: WorklistFixture;

  beforeEach(() => {
    tempState = enterTempDir();
    fixture = seedWorklistFixture(tempState.tempDir, { prefix: 'FIX', projectName: 'Worklist Command' });
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  it('returns every mandatory subset with the documented filters', async () => {
    const payload = await worklist();
    const { ids: expected } = fixture;

    expect(ids(payload.subsets.critical)).toEqual([expected.criticalRoot]);
    expect(payload.subsets.critical[0].priority).toBe('critical');

    // The review queue is root-only: the completed/in_review root is included,
    // the critical child (open) is not.
    expect(ids(payload.subsets.reviewQueue).sort()).toEqual(
      [expected.reviewCompleted, expected.reviewInProgress].sort(),
    );

    // The in-progress root re-worked in review is an in-progress root too.
    expect(ids(payload.subsets.inProgressRoots)).toEqual([expected.reviewInProgress]);

    expect(ids(payload.subsets.blockedRoots)).toEqual([expected.blockedRoot]);
  });

  it('matches the equivalent wl list filters item-for-item', async () => {
    const payload = await worklist();

    // Filters are exactly the documented ones — asserted against real
    // `wl list` invocations so a filter drift fails this test.
    const critical = await listItems('--priority critical --status open,in-progress,blocked,completed');
    expect(ids(payload.subsets.critical)).toEqual(ids(critical));

    const inProgressRoots = await listItems('--status in-progress --root-only');
    expect(ids(payload.subsets.inProgressRoots)).toEqual(ids(inProgressRoots));

    const blockedRoots = await listItems('--status blocked --root-only');
    expect(ids(payload.subsets.blockedRoots)).toEqual(ids(blockedRoots));

    // Membership parity for the review queue. Ordering intentionally differs
    // from `wl list --stage in_review`: the list command's 6-bucket sort needs
    // a per-item current content fingerprint (git calls), which a single
    // cacheable pure read must not pay, so the bundle uses the shared
    // hierarchy order for every list subset.
    const reviewQueue = await listItems('--status completed,in-progress --stage in_review --root-only');
    expect(ids(payload.subsets.reviewQueue).sort()).toEqual(ids(reviewQueue).sort());
  });

  it('mirrors every filter in the exported subset query definition', () => {
    // Guard against the queries drifting away from the documented filters.
    expect(WORKLIST_LIST_SUBSET_QUERIES.critical).toEqual({
      priority: 'critical',
      status: ['open', 'in-progress', 'blocked', 'completed'],
    });
    expect(WORKLIST_LIST_SUBSET_QUERIES.reviewQueue).toEqual({
      status: ['completed', 'in-progress'],
      stage: 'in_review',
      rootOnly: true,
    });
    expect(WORKLIST_LIST_SUBSET_QUERIES.inProgressRoots).toEqual({
      status: ['in-progress'],
      rootOnly: true,
    });
    expect(WORKLIST_LIST_SUBSET_QUERIES.blockedRoots).toEqual({
      status: ['blocked'],
      rootOnly: true,
    });
  });

  it('produces a browse feed identical to wl next --no-re-sort (item and order parity)', async () => {
    const payload = await worklist();

    const { stdout } = await execAsync(
      `tsx ${cliPath} --json next -n 20 --include-in-progress --include-blocked --no-re-sort`,
    );
    const nextPayload = JSON.parse(stdout);

    expect(payload.subsets.browse).toEqual(nextPayload.results);
    // Same items as `next`'s workItems alias, so consumers see one contract.
    expect(payload.subsets.browse).toEqual(nextPayload.workItems);
    // The audit enrichment `next` emits survives the bundle.
    const audited = payload.subsets.browse.find(
      (entry) => entry.workItem?.id === fixture.ids.audited,
    );
    expect(audited).toBeDefined();
    expect(audited?.workItem?.auditResult).toBe(true);
    expect(typeof audited?.workItem?.auditedAt).toBe('string');
    expect(audited?.workItem?.childCount).toBe(0);
  });

  it('bounds the browse feed by -n while the mandatory subsets stay complete', async () => {
    const full = await worklist();
    const bounded = await worklist('-n 2');

    expect(bounded.requestedCount).toBe(2);
    expect(bounded.subsets.browse.length).toBeLessThanOrEqual(2);
    expect(bounded.subsets.browse.length).toBeLessThan(full.subsets.browse.length);

    // Mandatory subsets are unbounded by the browse window.
    expect(ids(bounded.subsets.critical)).toEqual(ids(full.subsets.critical));
    expect(ids(bounded.subsets.reviewQueue)).toEqual(ids(full.subsets.reviewQueue));
    expect(ids(bounded.subsets.inProgressRoots)).toEqual(ids(full.subsets.inProgressRoots));
    expect(ids(bounded.subsets.blockedRoots)).toEqual(ids(full.subsets.blockedRoots));
  });

  it('resolves --worklog-dir like the other read commands', async () => {
    const worklogDir = path.join(tempState.tempDir, '.worklog');
    const { stdout } = await execAsync(
      `tsx ${cliPath} --json --worklog-dir ${worklogDir} worklist -n 3`,
    );
    const payload = JSON.parse(stdout) as WorklistPayload;

    expect(payload.worklogDir).toBe(worklogDir);
    expect(payload.requestedCount).toBe(3);
    expect(ids(payload.subsets.critical)).toEqual([fixture.ids.criticalRoot]);
  });
});

describe('wl worklist: one DB open per invocation', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    seedWorklistFixture(tempState.tempDir, { prefix: 'FIX', projectName: 'One Open' });
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  it('resolves the database once and issues all four list queries on that handle', async () => {
    const program = new Command();
    program.name('worklog').option('--json', 'Output JSON');
    const ctx = createPluginContext(program);

    let opens = 0;
    let listCalls = 0;
    const realGetDatabase = ctx.utils.getDatabase;
    ctx.utils.getDatabase = (prefix?: string) => {
      opens += 1;
      const db = realGetDatabase(prefix);
      const realList = db.list.bind(db);
      (db as any).list = (...args: any[]) => {
        listCalls += 1;
        return realList(...args);
      };
      return db;
    };
    registerWorklist(ctx);

    const logged: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: any[]) => {
      logged.push(args.map((a) => String(a)).join(' '));
    });
    // Pin the worklog dir explicitly: the in-process CLI harness can leave a
    // --worklog-dir override behind from an earlier test.
    setWorklogDirOverride(path.join(tempState.tempDir, '.worklog'));
    try {
      await program.parseAsync(['node', 'worklog', '--json', 'worklist'], { from: 'node' });
    } finally {
      logSpy.mockRestore();
      setWorklogDirOverride(undefined);
    }

    expect(opens).toBe(1);
    // Four list subsets — the browse feed goes through findNextWorkItems on the
    // same handle, never a second connection.
    expect(listCalls).toBe(4);

    const payload = JSON.parse(logged.join('\n')) as WorklistPayload;
    expect(Object.keys(payload.subsets).sort()).toEqual([...SUBSET_KEYS].sort());
  });
});

describe('wl worklist: pure read (read-cache state counter)', { timeout: 60_000 }, () => {
  let tempDir: string;
  let cacheDir: string;
  let worklogDir: string;
  let env: Record<string, string>;

  beforeEach(() => {
    tempDir = createTempDir();
    seedWorklistFixture(tempDir, { prefix: 'FIX', projectName: 'Pure Read' });
    cacheDir = path.join(tempDir, 'cache');
    worklogDir = path.join(tempDir, '.worklog');
    env = {
      ...process.env,
      WL_CACHE_DIR: cacheDir,
      WL_SPAWN_COUNT_FILE: path.join(tempDir, 'spawns.log'),
    } as Record<string, string>;
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('never bumps the state counter (and a write does, proving the guard is live)', () => {
    const run = (args: string[]) => runCliProcess(args, { cwd: tempDir, env });

    const before = readStateCounter(cacheDir, worklogDir);
    const res = run(['--json', 'worklist', '-n', '5']);
    expect(res.status).toBe(0);
    const afterRead = readStateCounter(cacheDir, worklogDir);
    expect(afterRead).toBe(before);

    // Control: a genuine write bumps the counter, so the assertion above is
    // not vacuous.
    const created = run(['--json', 'create', '-t', 'A written item']);
    expect(created.status).toBe(0);
    expect(readStateCounter(cacheDir, worklogDir)).toBeGreaterThan(afterRead);
  });

  it('emits identical JSON for identical DB state', () => {
    const run = (args: string[]) => runCliProcess(args, { cwd: tempDir, env });
    const first = run(['--json', 'worklist']);
    const second = run(['--json', 'worklist']);

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(second.stdout).toBe(first.stdout);
  });
});
