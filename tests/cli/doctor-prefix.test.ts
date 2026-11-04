/**
 * Integration tests for `wl doctor prefix` (WL-0MVZ2U295000GJ8M, parent
 * WL-0MVM8V79C003XH2J).
 *
 * The `prefix` subcommand is added by the implementation child
 * (WL-0MVZ2U4E0003IVSZ). These specs were RED-pinned with `it.fails(...)` by
 * the test-first child (without the subcommand the CLI exits non-zero) and the
 * implementation child flipped `it.fails(` to `it(` as the command landed.
 *
 * Contract exercised (JSON mode):
 *
 *   wl --json doctor prefix --to <PREFIX>              → preview (default)
 *   wl --json doctor prefix --to <PREFIX> --apply      → request apply (prompts; non-TTY fails closed)
 *   wl --json doctor prefix --to <PREFIX> --confirm    → apply
 *
 * Both modes emit exactly one machine-readable report on stdout:
 *
 *   {
 *     success, dryRun, applied, fromPrefix, toPrefix,
 *     counts: { items, comments, dependencyEdges, auditRecords },
 *     samples: [{ from, to }], renamedCount, renameMapPath
 *   }
 *
 * where:
 *  - `dryRun` is true for the preview and false for an applied rename;
 *  - `applied` is true only when THIS run wrote to the store (a replay after a
 *    successful rename reports `applied: false`);
 *  - `fromPrefix` is the store's current prefix (so a replay reports CC);
 *  - `counts` counts the rows a rename touches — items whose ID changes,
 *    comments whose `workItemId` changes, dependency edges with a renamed
 *    endpoint, and audit results — and `renamedCount` the number of items
 *    whose ID changes;
 *  - `samples` lists up to 10 `{ from, to }` ID pairs;
 *  - `renameMapPath` is the rename-map file path after an applied rename and
 *    null otherwise. The file is JSON:
 *
 *      { fromPrefix, toPrefix, renamedAt, ids: { "<old>": "<new>", ... } }
 *
 * Confirmation gate: the preview is the default and never writes; a run that
 * *requests* the rename (`--apply`, or `--confirm` which both requests and
 * confirms it) is the write path. On that path, a non-TTY run without
 * `--confirm` aborts with a non-zero exit, zero writes, and a message naming
 * `--confirm`. (The original draft of this suite asserted the abort for a bare
 * `--to` run, which contradicts the preview-by-default contract asserted by
 * the first spec — a bare `--to` run must preview. The apply request that the
 * gate guards is therefore explicit: `--apply`. Amended by
 * WL-0MVZ2U4E0003IVSZ and documented in the work item.)
 * The interactive prompt's accept/decline rule lives in the pure helper
 * `decidePrefixConfirmation` and is covered by
 * `tests/unit/doctor-prefix-check.test.ts` — this suite cannot allocate a TTY,
 * so a piped-stdin run is deliberately treated as the non-interactive case.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  cliPath,
  execAsync,
  enterTempDir,
  leaveTempDir,
  writeConfig,
  writeInitSemaphore,
  seedWorkItems,
} from './cli-helpers.js';
import type { Comment } from '../../src/types.js';

const OLD_PREFIX = 'TEST';
const NEW_PREFIX = 'CC';

/** Seed items: a parent/child pair, an audited item and a plain item. */
const SEED_ITEMS = [
  { id: 'TEST-PARENT', title: 'Parent item' },
  { id: 'TEST-CHILD', title: 'Child item', parentId: 'TEST-PARENT' },
  { id: 'TEST-AUDITED', title: 'Audited item', status: 'completed' as const, stage: 'in_review' },
  { id: 'TEST-SAMPLE', title: 'Plain item' },
];

/** Two comments, one per parent/child, to prove `workItemId` is rewritten. */
const SEED_COMMENTS: Comment[] = [
  {
    id: 'TEST-CM1',
    workItemId: 'TEST-PARENT',
    author: 'pi',
    comment: 'parent note',
    createdAt: '2026-01-01T00:00:00.000Z',
    references: ['TEST-CHILD'],
  },
  {
    id: 'TEST-CM2',
    workItemId: 'TEST-CHILD',
    author: 'pi',
    comment: 'child note',
    createdAt: '2026-01-01T00:00:01.000Z',
    references: [],
  },
];

/** One audit result, to prove `audit_results.work_item_id` is rewritten. */
const SEED_AUDITS = [
  {
    workItemId: 'TEST-AUDITED',
    readyToClose: true,
    auditedAt: '2026-01-01T00:00:02.000Z',
    summary: 'ready to close',
    author: 'pi',
  },
];

describe('doctor prefix command', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', OLD_PREFIX);
    writeInitSemaphore(tempState.tempDir);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  /** Seed the work items, comments and audit results shared by the specs. */
  function seedFixture(): void {
    seedWorkItems(tempState.tempDir, SEED_ITEMS, SEED_COMMENTS, SEED_AUDITS);
  }

  /** Run a CLI command in JSON mode and parse its stdout. */
  async function runJson(command: string): Promise<any> {
    const { stdout } = await execAsync(`tsx ${cliPath} --json ${command}`);
    return JSON.parse(stdout);
  }

  /** Every work-item ID currently in the store (including deleted). */
  async function listIds(): Promise<string[]> {
    const result = await runJson('list --deleted');
    return (result.workItems as Array<{ id: string }>).map(item => item.id).sort();
  }

  /** The `prefix:` value of the temp store's config.yaml. */
  function configPrefix(): string {
    const raw = fs.readFileSync(path.join(tempState.tempDir, '.worklog', 'config.yaml'), 'utf-8');
    const match = raw.match(/^prefix:\s*(\S+)\s*$/m);
    return match ? match[1] : '';
  }

  /** Rename-map files written under `.worklog/`, newest name order. */
  function renameMapFiles(): string[] {
    return fs
      .readdirSync(path.join(tempState.tempDir, '.worklog'))
      .filter(name => /^prefix-rename-.*\.json$/.test(name))
      .sort();
  }

  /** Resolve a reported rename-map path (absolute or project-root relative). */
  function resolveRenameMapPath(reported: string): string {
    return path.isAbsolute(reported) ? reported : path.join(tempState.tempDir, reported);
  }

  it(
    'preview is the default and reports counts plus samples without writing',
    async () => {
      seedFixture();
      // Seed a dependency edge (TEST-CHILD depends on TEST-PARENT).
      await runJson('dep add TEST-CHILD TEST-PARENT');
      const idsBefore = await listIds();

      const report = await runJson('doctor prefix --to CC');

      expect(report.success).toBe(true);
      expect(report.dryRun).toBe(true);
      expect(report.applied).toBe(false);
      expect(report.fromPrefix).toBe(OLD_PREFIX);
      expect(report.toPrefix).toBe(NEW_PREFIX);
      expect(report.counts).toEqual({
        items: 4,
        comments: 2,
        dependencyEdges: 1,
        auditRecords: 1,
      });
      expect(report.renamedCount).toBe(4);
      expect(report.renameMapPath).toBeNull();
      expect(Array.isArray(report.samples)).toBe(true);
      expect(report.samples.length).toBeGreaterThan(0);
      expect(report.samples.length).toBeLessThanOrEqual(10);
      expect(report.samples).toContainEqual({ from: 'TEST-CHILD', to: 'CC-CHILD' });

      // The preview must change nothing at all.
      expect(await listIds()).toEqual(idsBefore);
      expect(configPrefix()).toBe(OLD_PREFIX);
      expect(renameMapFiles()).toEqual([]);
    },
    60000,
  );

  it(
    'non-interactive apply request without --confirm aborts with a non-zero exit and zero writes',
    async () => {
      seedFixture();
      const idsBefore = await listIds();

      let failure: any;
      try {
        // Piped stdin (no TTY) and no --confirm: the gate must fail closed.
        // `--apply` is the explicit *request* to rename; without it the run is
        // a read-only preview (covered by the first spec).
        await execAsync(`tsx ${cliPath} --json doctor prefix --to CC --apply`);
      } catch (err) {
        failure = err;
      }

      expect(failure).toBeTruthy();
      expect(failure.exitCode).not.toBe(0);
      const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
      expect(output).toContain('--confirm');

      expect(await listIds()).toEqual(idsBefore);
      expect(configPrefix()).toBe(OLD_PREFIX);
      expect(renameMapFiles()).toEqual([]);
    },
    60000,
  );

  it(
    'invalid --to values fail with a non-zero exit and zero writes',
    async () => {
      seedFixture();
      const idsBefore = await listIds();

      for (const bad of ['C-C', 'C_C']) {
        let failure: any;
        try {
          await execAsync(`tsx ${cliPath} --json doctor prefix --to ${bad} --confirm`);
        } catch (err) {
          failure = err;
        }

        expect(failure, `expected --to ${bad} to be rejected`).toBeTruthy();
        expect(failure.exitCode).not.toBe(0);
        const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.toLowerCase();
        expect(output).toMatch(/invalid|not valid/);
      }

      expect(await listIds()).toEqual(idsBefore);
      expect(configPrefix()).toBe(OLD_PREFIX);
      expect(renameMapFiles()).toEqual([]);
    },
    60000,
  );

  it(
    '--confirm rewrites every ID-bearing record and writes the rename map',
    async () => {
      seedFixture();
      // Seed a dependency edge (TEST-CHILD depends on TEST-PARENT).
      await runJson('dep add TEST-CHILD TEST-PARENT');

      const report = await runJson('doctor prefix --to CC --confirm');

      expect(report.success).toBe(true);
      expect(report.dryRun).toBe(false);
      expect(report.applied).toBe(true);
      expect(report.fromPrefix).toBe(OLD_PREFIX);
      expect(report.toPrefix).toBe(NEW_PREFIX);
      expect(report.counts).toEqual({
        items: 4,
        comments: 2,
        dependencyEdges: 1,
        auditRecords: 1,
      });
      expect(report.renamedCount).toBe(4);

      // The rename map is written under .worklog/prefix-rename-<timestamp>.json.
      expect(typeof report.renameMapPath).toBe('string');
      const mapPath = resolveRenameMapPath(report.renameMapPath);
      expect(fs.existsSync(mapPath)).toBe(true);
      expect(renameMapFiles().length).toBe(1);
      const renameMap = JSON.parse(fs.readFileSync(mapPath, 'utf-8'));
      expect(renameMap.fromPrefix).toBe(OLD_PREFIX);
      expect(renameMap.toPrefix).toBe(NEW_PREFIX);
      expect(renameMap.ids['TEST-PARENT']).toBe('CC-PARENT');
      expect(renameMap.ids['TEST-CHILD']).toBe('CC-CHILD');
      expect(renameMap.ids['TEST-AUDITED']).toBe('CC-AUDITED');

      // workitems.id
      expect(await listIds()).toEqual([
        'CC-AUDITED',
        'CC-CHILD',
        'CC-PARENT',
        'CC-SAMPLE',
      ]);

      // workitems.parentId
      const child = await runJson('show CC-CHILD');
      expect(child.success).toBe(true);
      expect(child.workItem.id).toBe('CC-CHILD');
      expect(child.workItem.parentId).toBe('CC-PARENT');

      // comments.workItemId
      const parent = await runJson('show CC-PARENT');
      expect(parent.comments.map((c: Comment) => c.workItemId)).toEqual(['CC-PARENT']);

      // dependency_edges.fromId / toId
      const deps = await runJson('dep list CC-CHILD');
      expect(deps.outbound.map((edge: { id: string }) => edge.id)).toEqual(['CC-PARENT']);

      // audit_results.work_item_id
      const audit = await runJson('audit-show CC-AUDITED');
      expect(audit.audit).toBeTruthy();
      expect(audit.audit.workItemId).toBe('CC-AUDITED');

      // config prefix
      expect(configPrefix()).toBe(NEW_PREFIX);
    },
    60000,
  );

  it(
    'reports zero foreign items and resolves the renumbered IDs after a confirmed rename',
    async () => {
      seedFixture();

      await runJson('doctor prefix --to CC --confirm');

      const foreign = await runJson('doctor foreign-items');
      expect(foreign.success).toBe(true);
      expect(foreign.prefix).toBe(NEW_PREFIX);
      expect(foreign.foreignCount).toBe(0);
      expect(foreign.foreignIds).toEqual([]);

      const shown = await runJson('show CC-SAMPLE');
      expect(shown.success).toBe(true);
      expect(shown.workItem.id).toBe('CC-SAMPLE');
    },
    60000,
  );

  it(
    're-running after a successful rename is an idempotent no-op',
    async () => {
      seedFixture();

      await runJson('doctor prefix --to CC --confirm');
      const idsAfterFirstRun = await listIds();
      const mapFilesAfterFirstRun = renameMapFiles();

      const replay = await runJson('doctor prefix --to CC --confirm');

      expect(replay.success).toBe(true);
      expect(replay.dryRun).toBe(false);
      expect(replay.applied).toBe(false);
      expect(replay.fromPrefix).toBe(NEW_PREFIX);
      expect(replay.toPrefix).toBe(NEW_PREFIX);
      expect(replay.renamedCount).toBe(0);
      expect(replay.renameMapPath ?? null).toBeNull();

      expect(await listIds()).toEqual(idsAfterFirstRun);
      expect(configPrefix()).toBe(NEW_PREFIX);
      expect(renameMapFiles()).toEqual(mapFilesAfterFirstRun);
    },
    60000,
  );
});
