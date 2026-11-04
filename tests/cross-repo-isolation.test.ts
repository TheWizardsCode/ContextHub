/**
 * tests/cross-repo-isolation.test.ts
 *
 * AC5 isolation specification for cross-project dependency edges — child
 * WL-0MVWEEU5Z004E4K1 of parent WL-0MVWABT2Z001XMSD.
 *
 * ## The contract this file pins
 *
 * Recording and evaluating a **foreign** dependency edge must leave the
 * sibling store completely untouched. `tests/cross-repo-dep-edges.test.ts`
 * already proves the on-disk state (content hash, mtime, entry set, no
 * `-wal`/`-shm`) is unchanged by `wl dep add`/`dep list`. This module adds
 * the two isolation properties that proof cannot see from the filesystem
 * alone:
 *
 *   1. **No mutation lock on the foreign store.** Every write path runs
 *      inside `withStoreMutationLock` (`src/mutation-lock.ts`), which derives
 *      its lock path from the *local* store's JSONL file. The foreign read is
 *      a snapshot copy (`src/cross-repo/foreign-store.ts`) and must never
 *      engage that lock machinery for a sibling path. The test runs the real
 *      CLI with `WL_DEBUG=1`, collects every `[wl:lock] Lock acquired at …`
 *      line and asserts the local store's lock is acquired (non-vacuous —
 *      the instrumentation demonstrably works) while no lock path inside the
 *      sibling `.worklog/` is ever touched.
 *
 *   2. **No foreign item in the local edge cache.** `buildEdgeCache`
 *      (`packages/shared/src/database/context.ts`) indexes dependency edges
 *      and work items for the `wl next` pipeline. A foreign target has no
 *      local row, so it must never appear in `itemsById` — the gating path
 *      resolves it from its own store instead. The test records a foreign
 *      edge, builds the same cache the selector builds, and asserts:
 *        - the foreign id is absent from `itemsById` while the *local* edge
 *          target is present (the control that keeps the assertion honest),
 *        - `outbound`/`inbound` still carry the foreign edge, and
 *        - passing that exact cache to `hasActiveBlockers` /
 *          `getForeignDependencyViews` still gates on the foreign target,
 *          i.e. the resolver is consulted instead of the cache.
 *
 * ## Isolation target
 *
 * Everything is built under fresh `os.tmpdir()` directories; the real
 * checkout and any home-directory store are never opened.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runCliProcess } from './cli/cli-bundle.js';
import { writeInitSemaphore } from './cli/cli-helpers.js';
import { cleanupTempDir, createTempDir } from './test-utils.js';
import {
  makeProjectsRoot,
  writeProjectConfig,
  type ProjectsRootFixture,
  type SeedItem,
  type StoreHandle,
} from './helpers/cross-repo-fixture.js';
import { WorklogDatabase } from '../packages/shared/src/database.js';
import { buildEdgeCache } from '../packages/shared/src/database/context.js';
import type { WorklogDatabaseContext } from '../packages/shared/src/database/context.js';
import { resolveForeignItem } from '../src/cross-repo/foreign-store.js';
import { getLockPathForJsonl } from '../src/file-lock.js';
import type { WorkItem } from '../packages/shared/src/types.js';

/** Prefix of the consumer checkout that records the edges. */
const CONSUMER_PREFIX = 'CONS';
/** Prefix of the discovered sibling store that owns the foreign items. */
const SIBLING_PREFIX = 'ALPHA';

/** A consumer checkout (the local store) built for one test. */
interface Consumer {
  dir: string;
  worklogDir: string;
  dbPath: string;
  jsonlPath: string;
}

/** One captured CLI invocation. */
interface CapturedRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** The sibling store's observable on-disk state. */
interface StoreSnapshot {
  dbHash: string;
  dbMtimeMs: number;
  worklogDirMtimeMs: number;
  entries: string[];
}

/** SQLite sidecars that must never appear in the sibling. */
const FORBIDDEN_SIBLING_FILES = ['worklog.db-wal', 'worklog.db-shm'];

/** `[wl:lock] Lock acquired at <path> (PID …)` debug lines from `file-lock.ts`. */
const ACQUIRED_LOCK_LINE = /\[wl:lock\] Lock acquired at (.+?) \(PID/g;

// ── fixture / store helpers ──────────────────────────────────────────────

/** A consumer checkout whose config points discovery at `projectsRoot`. */
function makeConsumer(projectsRoot: string): Consumer {
  const dir = createTempDir();
  writeProjectConfig(dir, {
    prefix: CONSUMER_PREFIX,
    projectName: 'Consumer',
    projectsRoot,
  });
  writeInitSemaphore(dir);
  const worklogDir = path.join(dir, '.worklog');
  return {
    dir,
    worklogDir,
    dbPath: path.join(worklogDir, 'worklog.db'),
    jsonlPath: path.join(worklogDir, 'worklog-data.jsonl'),
  };
}

/** Seed local work items (setup only) and return the persisted records. */
function seedLocalItems(consumer: Consumer, items: SeedItem[]): WorkItem[] {
  const db = new WorklogDatabase(
    CONSUMER_PREFIX,
    consumer.dbPath,
    consumer.jsonlPath,
    true,
    false,
  );
  try {
    return items.map((item) =>
      db.create({ title: item.title, status: item.status, stage: item.stage }),
    );
  } finally {
    db.close();
  }
}

/**
 * Read the sibling store read-only so the test can learn the id the fixture
 * generated without altering the store it is about to snapshot.
 *
 * A read-only open of a WAL-mode store still leaves `-wal`/`-shm` sidecars in
 * the store directory, so they are removed afterwards; the snapshot below must
 * measure the CLI under test, not this helper.
 */
function readStoreItems(store: StoreHandle): WorkItem[] {
  const db = new WorklogDatabase(
    store.prefix,
    store.dbPath,
    path.join(store.worklogDir, 'data.jsonl'),
    true,
    false,
    undefined,
    undefined,
    { readOnly: true },
  );
  try {
    return db.getAll();
  } finally {
    db.close();
    for (const transient of ['worklog.db-wal', 'worklog.db-shm']) {
      fs.rmSync(path.join(store.worklogDir, transient), { force: true });
    }
  }
}

/** Run the real CLI in the consumer checkout. */
function run(
  consumer: Consumer,
  args: string[],
  extraEnv: Record<string, string> = {},
): CapturedRun {
  const result = runCliProcess(args, {
    cwd: consumer.dir,
    encoding: 'utf-8',
    env: {
      ...process.env,
      // Deterministic output: no TTY means chalk disables colour, and the
      // cache override keeps the suite out of the operator's home directory.
      NO_COLOR: '1',
      WL_CACHE_DIR: path.join(consumer.dir, 'cache'),
      ...extraEnv,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Parse a `--json` invocation's stdout, asserting it is valid JSON. */
function parseJson<T = Record<string, unknown>>(captured: CapturedRun): T {
  return JSON.parse(captured.stdout) as T;
}

/** Snapshot everything a write to the sibling store would change. */
function snapshotStore(worklogDir: string): StoreSnapshot {
  const dbPath = path.join(worklogDir, 'worklog.db');
  return {
    dbHash: createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex'),
    dbMtimeMs: fs.statSync(dbPath).mtimeMs,
    worklogDirMtimeMs: fs.statSync(worklogDir).mtimeMs,
    entries: fs.readdirSync(worklogDir).sort(),
  };
}

/**
 * Every lock path the CLI acquired in one invocation, from the `WL_DEBUG`
 * lines emitted by `src/file-lock.ts`.
 */
function acquiredLockPaths(captured: CapturedRun): string[] {
  const paths: string[] = [];
  for (const match of captured.stderr.matchAll(ACQUIRED_LOCK_LINE)) {
    paths.push(match[1].trim());
  }
  return paths;
}

/** True when `candidate` resolves inside `directory`. */
function isInside(candidate: string, directory: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// ── suite ────────────────────────────────────────────────────────────────

describe('cross-repo isolation (AC5)', () => {
  const disposables: Array<() => void> = [];
  let fixture: ProjectsRootFixture | undefined;

  afterEach(() => {
    while (disposables.length > 0) {
      disposables.pop()!();
    }
    fixture?.cleanup();
    fixture = undefined;
  });

  /** A projects root + consumer checkout + one discovered sibling store. */
  function setup(): {
    consumer: Consumer;
    sibling: StoreHandle;
    foreignItem: WorkItem;
    projectsRoot: string;
  } {
    fixture = makeProjectsRoot({ standard: false });
    const sibling = fixture.addStore(SIBLING_PREFIX, {
      name: 'alpha-project',
      items: [{ title: 'Upstream blocker', status: 'open' }],
    });
    const consumer = makeConsumer(fixture.root);
    disposables.push(() => cleanupTempDir(consumer.dir));

    const [foreignItem] = readStoreItems(sibling);
    expect(foreignItem).toBeDefined();
    return { consumer, sibling, foreignItem, projectsRoot: fixture.root };
  }

  it('records and evaluates a foreign edge without taking a mutation lock on the foreign store', () => {
    const { consumer, sibling, foreignItem } = setup();
    const [dependent] = seedLocalItems(consumer, [{ title: 'Local dependent' }]);
    const localLockPath = getLockPathForJsonl(consumer.jsonlPath);

    const before = snapshotStore(sibling.worklogDir);

    // Recording (`dep add` — the mutation-lock wrapped write path), listing and
    // gating evaluation (`next`) all run with lock instrumentation enabled.
    const added = run(
      consumer,
      ['--json', 'dep', 'add', dependent.id, foreignItem.id],
      { WL_DEBUG: '1' },
    );
    expect(added.status, added.stderr).toBe(0);

    const listed = run(
      consumer,
      ['--json', 'dep', 'list', dependent.id],
      { WL_DEBUG: '1' },
    );
    expect(listed.status, listed.stderr).toBe(0);

    // `--include-blocked` keeps the foreign-blocked dependent visible so the
    // gating path genuinely resolves (and reports) the foreign target.
    const next = run(
      consumer,
      ['--json', 'next', '--include-blocked', '--no-re-sort'],
      { WL_DEBUG: '1' },
    );
    expect(next.status, next.stderr).toBe(0);
    expect(parseJson<{ workItem: { id: string } }>(next).workItem.id).toBe(
      dependent.id,
    );
    expect(parseJson<{ foreign_dependencies?: Array<Record<string, unknown>> }>(next)
      .foreign_dependencies).toEqual([
      expect.objectContaining({
        id: foreignItem.id,
        foreign: true,
        foreign_dependency: 'resolved',
        blocking: true,
      }),
    ]);

    // The dependent really is gated by the foreign edge.
    const shown = run(consumer, ['--json', 'show', dependent.id]);
    expect(shown.status, shown.stderr).toBe(0);
    expect(parseJson<{ workItem: { status: string } }>(shown).workItem.status).toBe(
      'blocked',
    );

    // Non-vacuous instrumentation: the local store's mutation lock WAS
    // acquired, so a foreign lock would have been logged too.
    const lockPaths = [
      ...acquiredLockPaths(added),
      ...acquiredLockPaths(listed),
      ...acquiredLockPaths(next),
    ];
    expect(lockPaths).toContain(localLockPath);

    // ...and nothing under the sibling `.worklog/` was locked.
    const foreignLockPaths = lockPaths.filter((candidate) =>
      isInside(candidate, sibling.worklogDir),
    );
    expect(foreignLockPaths).toEqual([]);

    // No foreign lock file was created either (a lock is only visible in the
    // debug log while it is held; the file proves the absence independently).
    const siblingLockFiles = fs
      .readdirSync(sibling.worklogDir)
      .filter((entry) => /\.lock$/.test(entry));
    expect(siblingLockFiles).toEqual([]);

    // The sibling store is byte-identical: no write, no lock, no sidecar.
    const after = snapshotStore(sibling.worklogDir);
    expect(after.dbHash).toBe(before.dbHash);
    expect(after.dbMtimeMs).toBe(before.dbMtimeMs);
    expect(after.worklogDirMtimeMs).toBe(before.worklogDirMtimeMs);
    expect(after.entries).toEqual(before.entries);
    for (const forbidden of FORBIDDEN_SIBLING_FILES) {
      expect(fs.existsSync(path.join(sibling.worklogDir, forbidden))).toBe(false);
    }
  });

  it('keeps foreign targets out of the local edge cache while still gating on them', () => {
    const { consumer, sibling, foreignItem, projectsRoot } = setup();
    const [dependent, localBlocker] = seedLocalItems(consumer, [
      { title: 'Local dependent' },
      { title: 'Local blocker' },
    ]);

    // One foreign edge (target resolves from the sibling store) and one local
    // edge (target is a row in this store) — the local target is the control
    // that proves the cache does index edge targets it actually owns.
    expect(
      run(consumer, ['--json', 'dep', 'add', dependent.id, foreignItem.id]).status,
    ).toBe(0);
    expect(
      run(consumer, ['--json', 'dep', 'add', dependent.id, localBlocker.id]).status,
    ).toBe(0);

    // A fresh read-only connection to the local store: the cache is built from
    // persisted local rows only, exactly as `wl next` builds it.
    const db = new WorklogDatabase(
      CONSUMER_PREFIX,
      consumer.dbPath,
      consumer.jsonlPath,
      true,
      false,
      undefined,
      {
        foreign: {
          resolve: (id: string) =>
            resolveForeignItem(id, { projectsRoot }),
        },
      },
      { readOnly: true },
    );

    try {
      const edgeCache = buildEdgeCache({
        store: {
          getAllDependencyEdges: () => db.getAllDependencyEdges(),
          getAllWorkItems: () => db.getAll(),
        },
      } as unknown as WorklogDatabaseContext);

      // The foreign target has no local row, so it is not indexed...
      expect(edgeCache.itemsById.has(foreignItem.id)).toBe(false);
      // ...while the local edge target is (the control for the assertion).
      expect(edgeCache.itemsById.has(localBlocker.id)).toBe(true);
      expect(edgeCache.itemsById.has(dependent.id)).toBe(true);

      // The edges themselves are local data and are cached under their local
      // fromId / foreign toId keys — the cache indexes edges, not items.
      expect(
        edgeCache.outbound.get(dependent.id)?.map((edge) => edge.toId).sort(),
      ).toEqual([foreignItem.id, localBlocker.id].sort());
      expect(edgeCache.inbound.get(foreignItem.id)?.map((edge) => edge.fromId)).toEqual([
        dependent.id,
      ]);

      // Gating with that exact cache still resolves the foreign target from its
      // own store — it never falls back to an (absent) cached item.
      expect(db.hasActiveBlockers(dependent.id, edgeCache)).toBe(true);
      expect(db.getForeignDependencyViews(dependent.id, edgeCache)).toEqual([
        expect.objectContaining({
          id: foreignItem.id,
          foreign: true,
          foreign_dependency: 'resolved',
          blocking: true,
        }),
      ]);

      // Nothing foreign was written locally to make that work.
      expect(db.get(foreignItem.id)).toBeNull();
      expect(db.getAll().map((item) => item.id)).not.toContain(foreignItem.id);
    } finally {
      db.close();
    }

    // The sibling store still holds the item it always held — reading it never
    // moved a copy into the local store.
    expect(readStoreItems(sibling).map((item) => item.id)).toEqual([foreignItem.id]);
  });
});
