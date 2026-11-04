/**
 * tests/cross-repo-dep-edges.test.ts
 *
 * AC2 and AC5 specification for foreign dependency edges — parent
 * WL-0MVWABT2Z001XMSD, child F3 (WL-0MVWEEMP2002N37W).
 *
 * ## The contract this file pins
 *
 * `wl dep` accepts an id whose prefix belongs to a **discovered sibling
 * project** (see `src/cross-repo/project-registry.ts`, F2) and records the
 * edge in the **local** store while resolving the foreign endpoint strictly
 * read-only (parent design constraints D2 and D5):
 *
 *   wl dep add <local-id> <foreign-id>
 *     - exits 0 and emits `{ success: true, edge: { fromId, toId, createdAt } }`
 *       in `--json` mode; the edge is persisted in the local store with the
 *       foreign id as `toId`;
 *     - the local dependent becomes `blocked` while the foreign target is
 *       active (`isDependencyActive` semantics: not completed/deleted and not
 *       in `in_review`/`done`), exactly as a same-project edge does today;
 *     - an ambiguous prefix (two discovered projects declaring it) is refused
 *       non-zero with both candidate paths in the error — never guessed.
 *
 *   wl dep list <local-id> [--json]
 *     - outbound foreign entries carry `id`, `title`, `status`, `stage`,
 *       `priority`, `direction`, `foreign: true` and
 *       `foreign_dependency: "resolved"` (F4 contract; `unresolved` and
 *       `unavailable` are pinned by the F5 gating spec);
 *     - the human form shows the foreign title and status.
 *
 *   wl dep rm <local-id> <foreign-id>
 *     - exits 0, removes the edge from the local store and reconciles the
 *       dependent back to `open` once no active blocker remains.
 *
 * ## Read-only proof (AC5)
 *
 * Recording, listing and evaluating a foreign edge must never write to, lock
 * or sync the sibling store. The sibling's `worklog.db` content hash, file
 * mtime, `.worklog/` directory mtime and entry set are captured before and
 * after the CLI operations and must be byte-identical; no `-wal`, `-shm` or
 * lock file may appear in the sibling `.worklog/` directory.
 *
 * ## RED pinning
 *
 * F4 (WL-0MVWEENZL008XGYC) implemented the foreign branch in
 * `src/commands/dep.ts` and flipped the foreign blocks from `it.fails(` to
 * `it(`. The same-project baseline, the snapshot control and the normaliser
 * were plain `it(...)` from the start so a broken harness could not hide
 * behind a RED pin.
 *
 * ## Same-project regression baseline
 *
 * `tests/fixtures/cross-repo/same-project-dep-baseline.json` records the
 * normalised (volatile ids/timestamps collapsed) human and `--json` output of
 * `dep add` / `dep list` / `dep rm` for a purely local edge. F4 must not change
 * a single byte of it. Refresh deliberately with
 * `UPDATE_DEP_BASELINE=1` only when the same-project contract intentionally
 * changes, and say why in the work item.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
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

/** One captured CLI invocation, after volatile values are normalised. */
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

/** The same-project baseline file (one captured record per scenario). */
const BASELINE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'cross-repo',
  'same-project-dep-baseline.json',
);

/** ISO timestamps emitted inside JSON payloads (createdAt/updatedAt). */
const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
/** Any residual generated work-item id (`PREFIX-` + 16 base36 chars). */
const GENERATED_ID = /\b[A-Z][A-Z0-9]*-[0-9A-Z]{16}\b/g;

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
 * Read a (sibling) store read-only — no schema write, no mutation lock — so
 * the test can learn the ids the fixture generated without altering the store
 * it is about to snapshot.
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
    // A read-only open of a WAL-mode store still leaves `-wal`/`-shm` sidecars
    // in the store directory (SQLite creates them even for a reader). Restore
    // the fixture's clean state so the AC5 snapshot below measures the CLI
    // under test rather than this helper.
    for (const transient of ['worklog.db-wal', 'worklog.db-shm']) {
      fs.rmSync(path.join(store.worklogDir, transient), { force: true });
    }
  }
}

/** Read the local store read-only (a genuine re-read of the persisted edges). */
function readLocalStore(consumer: Consumer): WorklogDatabase {
  return new WorklogDatabase(
    CONSUMER_PREFIX,
    consumer.dbPath,
    consumer.jsonlPath,
    true,
    false,
    undefined,
    undefined,
    { readOnly: true },
  );
}

/** Run the real CLI in the consumer checkout. */
function run(consumer: Consumer, args: string[]): CapturedRun {
  const result = runCliProcess(args, {
    cwd: consumer.dir,
    encoding: 'utf-8',
    env: {
      ...process.env,
      // Deterministic output: no TTY means chalk disables colour, and the
      // cache override keeps the suite out of the operator's home directory.
      NO_COLOR: '1',
      WL_CACHE_DIR: path.join(consumer.dir, 'cache'),
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

/** SQLite sidecars and lock files that must never appear in the sibling. */
const FORBIDDEN_SIBLING_FILES = ['worklog.db-wal', 'worklog.db-shm', '.lock'];

// ── same-project baseline helpers ────────────────────────────────────────

/**
 * Collapse volatile values (generated ids and ISO timestamps) so two runs of
 * the same scenario produce byte-identical text.
 */
function normaliseOutput(text: string, ids: Record<string, string> = {}): string {
  let normalised = text;
  for (const [placeholder, id] of Object.entries(ids)) {
    normalised = normalised.split(id).join(`<${placeholder}>`);
  }
  return normalised
    .replace(ISO_TIMESTAMP, '<TIMESTAMP>')
    .replace(GENERATED_ID, '<ID>');
}

/** Normalise one captured CLI invocation for baseline comparison. */
function normaliseRun(captured: CapturedRun, ids: Record<string, string> = {}): CapturedRun {
  return {
    status: captured.status,
    stdout: normaliseOutput(captured.stdout, ids),
    stderr: normaliseOutput(captured.stderr, ids),
  };
}

/**
 * Capture the same-project scenarios (human and `--json`, add/list/rm).
 *
 * Two independent edges are used because `dep add` refuses a duplicate edge,
 * so one edge supplies the `--json` sequence and the other the human sequence.
 */
function captureSameProjectScenarios(
  consumer: Consumer,
  ids: { dependentJson: string; blockerJson: string; dependentHuman: string; blockerHuman: string },
): Record<string, CapturedRun> {
  const placeholders: Record<string, string> = {
    LOCAL_DEPENDENT_JSON: ids.dependentJson,
    LOCAL_BLOCKER_JSON: ids.blockerJson,
    LOCAL_DEPENDENT_HUMAN: ids.dependentHuman,
    LOCAL_BLOCKER_HUMAN: ids.blockerHuman,
  };

  const scenarios: Record<string, string[]> = {
    'dep-add-json': ['--json', 'dep', 'add', ids.dependentJson, ids.blockerJson],
    'dep-list-json': ['--json', 'dep', 'list', ids.dependentJson],
    'dep-list-human': ['dep', 'list', ids.dependentJson],
    'dep-rm-json': ['--json', 'dep', 'rm', ids.dependentJson, ids.blockerJson],
    'dep-add-human': ['dep', 'add', ids.dependentHuman, ids.blockerHuman],
    'dep-list-human-second': ['dep', 'list', ids.dependentHuman],
    'dep-list-json-second': ['--json', 'dep', 'list', ids.dependentHuman],
    'dep-rm-human': ['dep', 'rm', ids.dependentHuman, ids.blockerHuman],
  };

  const captures: Record<string, CapturedRun> = {};
  for (const [name, args] of Object.entries(scenarios)) {
    captures[name] = normaliseRun(run(consumer, args), placeholders);
  }
  return captures;
}

// ── suite ────────────────────────────────────────────────────────────────

describe('cross-repo foreign dependency edges (AC2/AC5)', () => {
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
    return { consumer, sibling, foreignItem };
  }

  it('records a foreign edge, lists its title/status and blocks the dependent (F4)', () => {
    const { consumer, foreignItem } = setup();
    const [dependent] = seedLocalItems(consumer, [{ title: 'Local dependent' }]);

    const added = run(consumer, [
      '--json',
      'dep',
      'add',
      dependent.id,
      foreignItem.id,
    ]);
    expect(added.status, added.stderr).toBe(0);
    const addPayload = parseJson<{ success: boolean; edge: { fromId: string; toId: string } }>(
      added,
    );
    expect(addPayload.success).toBe(true);
    expect(addPayload.edge.fromId).toBe(dependent.id);
    expect(addPayload.edge.toId).toBe(foreignItem.id);

    // The foreign endpoint's own read-only metadata is surfaced by dep list.
    const listed = run(consumer, ['--json', 'dep', 'list', dependent.id]);
    expect(listed.status, listed.stderr).toBe(0);
    const listPayload = parseJson<{
      success: boolean;
      outbound: Array<Record<string, unknown>>;
    }>(listed);

    const foreignEntry = listPayload.outbound.find(
      (entry) => entry.id === foreignItem.id,
    );
    expect(foreignEntry).toBeDefined();
    expect(foreignEntry).toMatchObject({
      id: foreignItem.id,
      title: 'Upstream blocker',
      status: 'open',
      stage: '',
      direction: 'depends-on',
      foreign: true,
      foreign_dependency: 'resolved',
    });

    // The human form shows the foreign title and status.
    const human = run(consumer, ['dep', 'list', dependent.id]);
    expect(human.status, human.stderr).toBe(0);
    expect(human.stdout).toContain('Upstream blocker');
    expect(human.stdout).toContain(`(${foreignItem.id})`);
    expect(human.stdout).toContain('Status: open');

    // The local dependent is blocked while the foreign target is active.
    const shown = run(consumer, ['--json', 'show', dependent.id]);
    expect(shown.status, shown.stderr).toBe(0);
    expect(parseJson<{ workItem: { status: string } }>(shown).workItem.status).toBe(
      'blocked',
    );
  });

  it('persists the foreign edge across a re-read of the local store (F4)', () => {
    const { consumer, foreignItem } = setup();
    const [dependent] = seedLocalItems(consumer, [{ title: 'Local dependent' }]);

    const added = run(consumer, ['--json', 'dep', 'add', dependent.id, foreignItem.id]);
    expect(added.status, added.stderr).toBe(0);

    // A brand-new connection to the local store must still see the edge with
    // the foreign id as its target (nothing is held in memory only).
    const db = readLocalStore(consumer);
    try {
      const edges = db.listDependencyEdgesFrom(dependent.id);
      expect(edges.map((edge) => edge.toId)).toEqual([foreignItem.id]);
      expect(db.get(dependent.id)?.status).toBe('blocked');
    } finally {
      db.close();
    }

    // A second independent CLI process re-reads the same edge.
    const relisted = run(consumer, ['--json', 'dep', 'list', dependent.id]);
    expect(relisted.status, relisted.stderr).toBe(0);
    expect(
      parseJson<{ outbound: Array<{ id: string }> }>(relisted).outbound.map(
        (entry) => entry.id,
      ),
    ).toEqual([foreignItem.id]);
  });

  it('removes the foreign edge and reconciles the dependent back to open (F4)', () => {
    const { consumer, foreignItem } = setup();
    const [dependent] = seedLocalItems(consumer, [{ title: 'Local dependent' }]);

    expect(
      run(consumer, ['--json', 'dep', 'add', dependent.id, foreignItem.id]).status,
    ).toBe(0);

    const removed = run(consumer, ['--json', 'dep', 'rm', dependent.id, foreignItem.id]);
    expect(removed.status, removed.stderr).toBe(0);
    expect(parseJson<{ success: boolean; removed: boolean }>(removed)).toMatchObject({
      success: true,
      removed: true,
    });

    const db = readLocalStore(consumer);
    try {
      expect(db.listDependencyEdgesFrom(dependent.id)).toEqual([]);
      expect(db.get(dependent.id)?.status).toBe('open');
    } finally {
      db.close();
    }

    const shown = run(consumer, ['--json', 'show', dependent.id]);
    expect(shown.status, shown.stderr).toBe(0);
    expect(parseJson<{ workItem: { status: string } }>(shown).workItem.status).toBe(
      'open',
    );
  });

  it('records and evaluates a foreign edge without writing, locking or syncing the sibling store (AC5)', () => {
    const { consumer, sibling, foreignItem } = setup();
    const [dependent] = seedLocalItems(consumer, [{ title: 'Local dependent' }]);

    const before = snapshotStore(sibling.worklogDir);

    expect(
      run(consumer, ['--json', 'dep', 'add', dependent.id, foreignItem.id]).status,
    ).toBe(0);
    expect(run(consumer, ['--json', 'dep', 'list', dependent.id]).status).toBe(0);
    expect(run(consumer, ['dep', 'list', dependent.id]).status).toBe(0);

    const after = snapshotStore(sibling.worklogDir);

    // Content hash, file mtime, directory mtime and entry set are unchanged:
    // the store was opened read-only, with no mutation lock and no sync.
    expect(after.dbHash).toBe(before.dbHash);
    expect(after.dbMtimeMs).toBe(before.dbMtimeMs);
    expect(after.worklogDirMtimeMs).toBe(before.worklogDirMtimeMs);
    expect(after.entries).toEqual(before.entries);

    for (const forbidden of FORBIDDEN_SIBLING_FILES) {
      expect(fs.existsSync(path.join(sibling.worklogDir, forbidden))).toBe(false);
    }
  });

  it('refuses an ambiguous foreign prefix instead of guessing an owner (F4)', () => {
    fixture = makeProjectsRoot({ standard: false });
    const [first, second] = fixture.addDuplicatePrefix(SIBLING_PREFIX);
    const consumer = makeConsumer(fixture.root);
    disposables.push(() => cleanupTempDir(consumer.dir));
    const [dependent] = seedLocalItems(consumer, [{ title: 'Local dependent' }]);

    // Any syntactically valid id with the ambiguous prefix is enough: the
    // prefix cannot be resolved to one store, so existence is never reached.
    const ambiguousId = `${SIBLING_PREFIX}-0000000000000000`;

    const captured = run(consumer, ['--json', 'dep', 'add', dependent.id, ambiguousId]);
    expect(captured.status).not.toBe(0);
    const payload = parseJson<{ success: boolean; error?: string; errors?: string[] }>(
      captured,
    );
    expect(payload.success).toBe(false);

    // Both candidate projects are named so the producer can disambiguate.
    const message = [payload.error, ...(payload.errors ?? []), captured.stderr]
      .filter(Boolean)
      .join('\n');
    expect(message).toContain(first.dir);
    expect(message).toContain(second.dir);

    // Nothing is recorded locally.
    const db = readLocalStore(consumer);
    try {
      expect(db.listDependencyEdgesFrom(dependent.id)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('degrades an unreadable sibling store to foreign_dependency "unavailable" without throwing', () => {
    const { consumer, sibling, foreignItem } = setup();
    const [dependent] = seedLocalItems(consumer, [{ title: 'Local dependent' }]);

    expect(
      run(consumer, ['--json', 'dep', 'add', dependent.id, foreignItem.id]).status,
    ).toBe(0);

    // The sibling project is still discovered (config + initialized marker),
    // but its database is gone — the resolver must report `unavailable`
    // instead of throwing (parent D3 fail-safe).
    fs.rmSync(sibling.dbPath, { force: true });

    const listed = run(consumer, ['--json', 'dep', 'list', dependent.id]);
    expect(listed.status, listed.stderr).toBe(0);
    const payload = parseJson<{ outbound: Array<Record<string, unknown>> }>(listed);
    expect(payload.outbound).toHaveLength(1);
    expect(payload.outbound[0]).toMatchObject({
      id: foreignItem.id,
      foreign: true,
      foreign_dependency: 'unavailable',
      title: '(missing)',
      status: 'deleted',
    });

    // The edge itself is untouched local data.
    const db = readLocalStore(consumer);
    try {
      expect(db.listDependencyEdgesFrom(dependent.id).map((edge) => edge.toId)).toEqual([
        foreignItem.id,
      ]);
    } finally {
      db.close();
    }
  });

  it('reports a missing foreign item as foreign_dependency "unresolved"', () => {
    const { consumer, sibling, foreignItem } = setup();
    const [dependent] = seedLocalItems(consumer, [{ title: 'Local dependent' }]);

    expect(
      run(consumer, ['--json', 'dep', 'add', dependent.id, foreignItem.id]).status,
    ).toBe(0);

    // Remove the target from the (readable) sibling store: the store resolves,
    // the item does not. `WorklogDatabase.delete()` is a soft delete (the row
    // survives with status `deleted`), so the row is removed directly.
    const siblingDb = new Database(sibling.dbPath);
    try {
      siblingDb.prepare('DELETE FROM workitems WHERE id = ?').run(foreignItem.id);
    } finally {
      siblingDb.close();
    }

    const listed = run(consumer, ['--json', 'dep', 'list', dependent.id]);
    expect(listed.status, listed.stderr).toBe(0);
    const payload = parseJson<{ outbound: Array<Record<string, unknown>> }>(listed);
    expect(payload.outbound[0]).toMatchObject({
      id: foreignItem.id,
      foreign: true,
      foreign_dependency: 'unresolved',
      title: '(missing)',
      status: 'deleted',
    });
  });
});

// ── always-green harness controls and same-project regression baseline ────

describe('cross-repo dep-edge harness controls', () => {
  const disposables: Array<() => void> = [];
  let fixture: ProjectsRootFixture | undefined;

  afterEach(() => {
    while (disposables.length > 0) {
      disposables.pop()!();
    }
    fixture?.cleanup();
    fixture = undefined;
  });

  it('collapses volatile generated ids and timestamps for the baseline', () => {
    const first = normaliseOutput(
      '{"fromId":"CONS-AAAAAAAAAAAAAAAA","toId":"CONS-BBBBBBBBBBBBBBBB",' +
        '"createdAt":"2026-11-02T19:57:56.517Z"}',
    );
    const second = normaliseOutput(
      '{"fromId":"CONS-CCCCCCCCCCCCCCCC","toId":"CONS-DDDDDDDDDDDDDDDD",' +
        '"createdAt":"2027-01-09T01:02:03.004Z"}',
    );

    expect(first).toBe(second);
    expect(first).toContain('<ID>');
    expect(first).toContain('<TIMESTAMP>');
    // Explicit placeholders win over the generic collapse.
    expect(
      normaliseOutput('CONS-AAAAAAAAAAAAAAAA', { LOCAL: 'CONS-AAAAAAAAAAAAAAAA' }),
    ).toBe('<LOCAL>');
  });

  it('detects a sibling-store write (the isolation snapshot is non-vacuous)', () => {
    fixture = makeProjectsRoot({ standard: false });
    const sibling = fixture.addStore(SIBLING_PREFIX, {
      name: 'alpha-project',
      items: [{ title: 'Upstream blocker', status: 'open' }],
    });

    const before = snapshotStore(sibling.worklogDir);
    const sidecar = path.join(sibling.worklogDir, 'worklog.db-wal');
    fs.writeFileSync(sidecar, 'uncheckpointed pages');
    try {
      const during = snapshotStore(sibling.worklogDir);
      expect(during.entries).not.toEqual(before.entries);
      expect(during.worklogDirMtimeMs).not.toBe(before.worklogDirMtimeMs);
    } finally {
      fs.rmSync(sidecar, { force: true });
    }

    const restored = snapshotStore(sibling.worklogDir);
    expect(restored.dbHash).toBe(before.dbHash);
    expect(restored.entries).toEqual(before.entries);
  });

  it('keeps same-project dep add/list/rm output byte-identical to the recorded baseline', () => {
    fixture = makeProjectsRoot({ standard: false });
    const consumer = makeConsumer(fixture.root);
    disposables.push(() => cleanupTempDir(consumer.dir));

    const [dependentJson, blockerJson, dependentHuman, blockerHuman] = seedLocalItems(
      consumer,
      [
        { title: 'Local dependent one' },
        { title: 'Local blocker one' },
        { title: 'Local dependent two' },
        { title: 'Local blocker two' },
      ],
    );

    const actual = captureSameProjectScenarios(consumer, {
      dependentJson: dependentJson.id,
      blockerJson: blockerJson.id,
      dependentHuman: dependentHuman.id,
      blockerHuman: blockerHuman.id,
    });

    if (process.env.UPDATE_DEP_BASELINE === '1') {
      fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
      fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(actual, null, 2)}\n`, 'utf-8');
    }

    expect(fs.existsSync(BASELINE_PATH), `missing baseline: ${BASELINE_PATH}`).toBe(
      true,
    );
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8')) as Record<
      string,
      CapturedRun
    >;
    expect(actual).toEqual(baseline);
  });
});
