/**
 * tests/cross-repo-gating.test.ts
 *
 * AC3 specification for **gating on foreign dependency blockers** — parent
 * WL-0MVWABT2Z001XMSD, child F5 (WL-0MVWEEP4U003FR91). F6
 * (WL-0MVWEEQ8K0013DOY) turns the RED pins below green.
 *
 * ## The contract this file pins
 *
 * An item whose **only active blocker is foreign** (an edge whose target lives
 * in a discovered sibling project's store) behaves exactly like a same-project
 * blocked item on the gating paths:
 *
 *   - excluded from `wl next` by default;
 *   - included with `wl next --include-blocked`;
 *   - selectable again once the foreign target is terminal (`in_review`,
 *     `done`, `completed` or `deleted`).
 *
 * A foreign blocker is **never surfaced as a `wl next` result**: it is not a
 * local work item, so blocker surfacing must not promote it. `--include-blocked`
 * returns the *dependent* itself.
 *
 * ## The fail-safe (D3) — the hazard this spec pins
 *
 * Today every gating path resolves a blocker from the **local** store only:
 * `isDependencyActive(null) === false`. A foreign edge's target is never local,
 * so the edge silently reads as *inactive* and the dependent is unblocked.
 * That is unsafe: a vanished sibling store must never unblock the dependent.
 *
 * Resolution is tri-state (`src/cross-repo/foreign-store.ts`, F4):
 * `resolved` | `unresolved` | `unavailable`. Gating must fail safe:
 *
 *   | resolution                                                  | blocks? | `unresolved` |
 *   |-------------------------------------------------------------|---------|--------------|
 *   | `resolved`, target still active                             | yes     | false        |
 *   | `resolved`, target terminal                                 | no      | false        |
 *   | `unresolved` (readable store, target item absent)           | yes     | true         |
 *   | `unavailable` **with a discovered project** (store removed / | yes     | true         |
 *   |   unreadable / ambiguous prefix)                            |         |              |
 *   | `unavailable` with **no** discovered project (undiscoverable | no      | false        |
 *   |   prefix: coordination note)                                |         |              |
 *
 * The distinction is deliberate (parent risk mitigation): fail safe only when
 * a **real foreign store was discovered**. An undiscoverable prefix stays a
 * non-blocking coordination note until `wl project add` records a mapping —
 * otherwise a previously-ignored cross-prefix edge would stall a consumer.
 *
 * ## The shared JSON view
 *
 * Every gating surface emits the same `ForeignDependencyView[]` so an operator
 * (and the framework) sees one shape for the resolution state:
 *
 * ```jsonc
 * {
 *   "id": "ALPHA-…",                 // foreign target id
 *   "foreign": true,
 *   "foreign_dependency": "resolved" | "unresolved" | "unavailable",
 *   "unresolved": true | false,      // true = could not resolve => fail-safe block
 *   "blocking": true | false,        // true = this edge currently blocks the dependent
 *   "reason": "…"                    // present when the target could not be resolved
 * }
 * ```
 *
 * Surfaces:
 *   - **`wl next --json`** — a single result carries `foreign_dependencies`
 *     beside `workItem`/`reason`; batch results (and `wl worklist`'s browse
 *     feed, which is the same selection) carry it on **each** result entry.
 *     The key is present only when the item has at least one foreign edge, so
 *     output for items without foreign edges is byte-identical to today.
 *   - **`wl worklist --json`** — the browse-feed entry for the item carries the
 *     same view (and `subsets.blockedRoots` still contains a blocked
 *     dependent).
 *   - **`wl doctor --json`** — an unresolved foreign edge is a
 *     `dependency.foreign-unresolved` / `unresolved-foreign-dependency` warning
 *     keyed to the **dependent** (`itemId`), with the same `context` fields
 *     (`blockerId`, `foreign`, `foreign_dependency`, `unresolved`, `reason`). A
 *     foreign target is no longer misreported as a local
 *     `dependency.missing-endpoint`.
 *
 * ## RED pinning
 *
 * The gating assertions are `it.fails(...)`: the behaviour does not exist until
 * F6, and vitest reports an expected failure as a pass so the suite stays
 * green between the spec and its implementation. The harness controls are plain
 * `it(...)` so a broken fixture cannot hide behind a RED pin — F6 flips
 * `it.fails(` → `it(` once the gating ships.
 */

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
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
import type { WorkItem } from '../packages/shared/src/types.js';

/** Prefix of the consumer checkout that records the edges. */
const CONSUMER_PREFIX = 'CONS';
/** Prefix of the discovered sibling store that owns the foreign items. */
const SIBLING_PREFIX = 'ALPHA';
/**
 * Prefix that no fixture project declares — the undiscoverable-prefix case
 * (no store and no `wl project add` mapping).
 */
const UNDISCOVERABLE_PREFIX = 'GHOST';

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

/** The shared foreign-dependency view emitted by every gating surface. */
interface ForeignDependencyView {
  id: string;
  foreign: true;
  foreign_dependency: 'resolved' | 'unresolved' | 'unavailable';
  unresolved: boolean;
  blocking: boolean;
  reason?: string;
}

/** A `wl next` result entry (single-item and batch shapes share the fields). */
interface NextResultEntry {
  workItem: (WorkItem & { id: string }) | null;
  reason?: string;
  foreign_dependencies?: ForeignDependencyView[];
}

/** A `wl doctor --json` finding (only the fields this spec asserts). */
interface DoctorFinding {
  checkId?: string;
  type?: string;
  severity?: string;
  itemId?: string | null;
  message?: string;
  context?: Record<string, unknown>;
}

/**
 * A fresh per-invocation cache directory.
 *
 * The read cache is keyed on the consumer's own DB state counter, which the
 * sibling-store mutations below deliberately do not touch. A shared cache dir
 * would therefore serve a stale `wl next` payload across a "before/after
 * terminal" pair and hide the real gating decision. Each invocation gets a
 * cold cache so the CLI always executes and the assertions observe the code
 * under test.
 */
let cacheSequence = 0;

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
 * Read a (sibling) store read-only, then remove the WAL sidecars the read-only
 * open leaves behind so the store directory stays deterministic.
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

/**
 * Mutate a sibling item's `status`/`stage` **directly in its own store**
 * (setup only, per the item's Minimal Implementation).
 *
 * The raw `UPDATE` avoids the local lifecycle reconciliation and any foreign
 * write path: this represents an upstream project advancing its own item, not
 * the consumer writing to a sibling store.
 */
function setSiblingItemState(
  sibling: StoreHandle,
  itemId: string,
  changes: { status?: string; stage?: string },
): void {
  const assignments: string[] = [];
  const values: unknown[] = [];
  if (changes.status !== undefined) {
    assignments.push('status = ?');
    values.push(changes.status);
  }
  if (changes.stage !== undefined) {
    assignments.push('stage = ?');
    values.push(changes.stage);
  }
  if (assignments.length === 0) {
    throw new Error('setSiblingItemState needs a status and/or stage change');
  }
  const db = new Database(sibling.dbPath);
  try {
    const info = db
      .prepare(`UPDATE workitems SET ${assignments.join(', ')} WHERE id = ?`)
      .run(...values, itemId);
    if (info.changes !== 1) {
      throw new Error(`no sibling work item ${itemId} was updated`);
    }
  } finally {
    db.close();
  }
}

/**
 * Record a foreign edge **directly in the local store** (setup only).
 *
 * `wl dep add` refuses an undiscoverable prefix (D4), so the
 * coordination-note scenario seeds its edge the way an import or a removed
 * sibling project would leave it behind. The dependent's status is left
 * untouched: the gating decision must follow the edge, not a stale status.
 */
function seedForeignEdge(consumer: Consumer, fromId: string, toId: string): void {
  const db = new WorklogDatabase(
    CONSUMER_PREFIX,
    consumer.dbPath,
    consumer.jsonlPath,
    true,
    false,
  );
  try {
    const edge = db.addDependencyEdge(fromId, toId, { allowForeignTarget: true });
    expect(edge).not.toBeNull();
  } finally {
    db.close();
  }
}

/** Run the real CLI in the consumer checkout with a cold read cache. */
function run(consumer: Consumer, args: string[]): CapturedRun {
  const result = runCliProcess(args, {
    cwd: consumer.dir,
    encoding: 'utf-8',
    env: {
      ...process.env,
      NO_COLOR: '1',
      WL_CACHE_DIR: path.join(consumer.dir, 'cache', String(cacheSequence++)),
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Parse a `--json` invocation's stdout. */
function parseJson<T = Record<string, unknown>>(captured: CapturedRun): T {
  return JSON.parse(captured.stdout) as T;
}

/** Run `wl next --json --no-re-sort` (single result) and parse it. */
function nextSingle(consumer: Consumer, extraArgs: string[] = []): NextResultEntry & {
  success: boolean;
} {
  const captured = run(consumer, ['--json', 'next', '--no-re-sort', ...extraArgs]);
  expect(captured.status, captured.stderr).toBe(0);
  return parseJson(captured);
}

/** Run `wl doctor --json` and return the findings array. */
function doctorFindings(consumer: Consumer): DoctorFinding[] {
  const captured = run(consumer, ['--json', 'doctor']);
  return parseJson<DoctorFinding[]>(captured);
}

// ── suite ────────────────────────────────────────────────────────────────

describe('cross-repo foreign blocker gating (AC3)', () => {
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
  function setup(): { consumer: Consumer; sibling: StoreHandle; foreignItem: WorkItem } {
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

  it.fails(
    'excludes an item whose only active blocker is foreign, and includes it with --include-blocked (F6)',
    () => {
      const { consumer, foreignItem } = setup();
      const [dependent] = seedLocalItems(consumer, [{ title: 'Local dependent' }]);

      // Record the cross-project edge through the real CLI (F4 already ships
      // this): the dependent becomes `blocked` while the target is active.
      const added = run(consumer, ['--json', 'dep', 'add', dependent.id, foreignItem.id]);
      expect(added.status, added.stderr).toBe(0);

      // Default `wl next` excludes the dependent — the foreign target is
      // active, so exactly as for a same-project edge it is not actionable.
      const excluded = nextSingle(consumer);
      expect(excluded.success).toBe(true);
      expect(excluded.workItem).toBeNull();

      // `--include-blocked` returns the dependent itself (never the foreign
      // target — it is not a local work item), carrying the resolution view.
      const included = nextSingle(consumer, ['--include-blocked']);
      expect(included.workItem?.id).toBe(dependent.id);
      expect(included.foreign_dependencies).toEqual([
        {
          id: foreignItem.id,
          foreign: true,
          foreign_dependency: 'resolved',
          unresolved: false,
          blocking: true,
        },
      ]);
    },
  );

  describe.each([
    { label: 'in_review stage', changes: { stage: 'in_review' } },
    { label: 'done stage', changes: { stage: 'done' } },
    { label: 'completed status', changes: { status: 'completed', stage: 'in_review' } },
    { label: 'deleted status', changes: { status: 'deleted' } },
  ])('foreign blocker reaches a terminal state — $label', ({ label, changes }) => {
    it.fails(
      `selects the dependent once the foreign target is ${label} (F6)`,
      () => {
        const { consumer, sibling, foreignItem } = setup();
        const [dependent] = seedLocalItems(consumer, [{ title: 'Local dependent' }]);

        expect(
          run(consumer, ['--json', 'dep', 'add', dependent.id, foreignItem.id]).status,
        ).toBe(0);

        // Control: while the target is active the dependent is excluded, so the
        // "selectable afterwards" assertion is non-vacuous.
        expect(nextSingle(consumer).workItem).toBeNull();

        // The upstream project advances its own item in its own store.
        setSiblingItemState(sibling, foreignItem.id, changes);

        // The dependent is selectable with no `--include-blocked` flag.
        const selected = nextSingle(consumer);
        expect(selected.workItem?.id).toBe(dependent.id);
        expect(selected.foreign_dependencies).toEqual([
          {
            id: foreignItem.id,
            foreign: true,
            foreign_dependency: 'resolved',
            unresolved: false,
            blocking: false,
          },
        ]);
      },
    );
  });

  it.fails(
    'keeps the dependent blocked with unresolved:true and a reason when the sibling store disappears (F6)',
    () => {
      const { consumer, sibling, foreignItem } = setup();
      const [dependent] = seedLocalItems(consumer, [{ title: 'Local dependent' }]);

      expect(
        run(consumer, ['--json', 'dep', 'add', dependent.id, foreignItem.id]).status,
      ).toBe(0);

      // The project is still discovered (its config + `initialized` marker
      // remain) but its database is gone: the store is unreadable. The edge
      // must stay blocking — `isDependencyActive(null) === false` must not
      // silently unblock the dependent.
      fs.rmSync(sibling.dbPath, { force: true });

      const excluded = nextSingle(consumer);
      expect(excluded.workItem).toBeNull();

      const included = nextSingle(consumer, ['--include-blocked']);
      expect(included.workItem?.id).toBe(dependent.id);

      const [view] = included.foreign_dependencies ?? [];
      expect(view).toMatchObject({
        id: foreignItem.id,
        foreign: true,
        foreign_dependency: 'unavailable',
        unresolved: true,
        blocking: true,
      });
      expect(typeof view?.reason).toBe('string');
      expect(view?.reason?.length ?? 0).toBeGreaterThan(0);
    },
  );

  it.fails(
    'does not block on an undiscoverable prefix but reports foreign_dependency "unavailable" (F6)',
    () => {
      fixture = makeProjectsRoot({ standard: false });
      const consumer = makeConsumer(fixture.root);
      disposables.push(() => cleanupTempDir(consumer.dir));
      const [dependent] = seedLocalItems(consumer, [{ title: 'Local dependent' }]);

      // No project declares GHOST and no `wl project add` mapping exists. The
      // edge can only exist because an import / a removed sibling left it.
      const undiscoverableId = `${UNDISCOVERABLE_PREFIX}-0000000000000000`;
      seedForeignEdge(consumer, dependent.id, undiscoverableId);

      // A coordination note never blocks: the dependent is selectable as-is.
      const selected = nextSingle(consumer);
      expect(selected.workItem?.id).toBe(dependent.id);

      const [view] = selected.foreign_dependencies ?? [];
      expect(view).toMatchObject({
        id: undiscoverableId,
        foreign: true,
        foreign_dependency: 'unavailable',
        unresolved: false,
        blocking: false,
      });
      expect(typeof view?.reason).toBe('string');
      expect(view?.reason?.length ?? 0).toBeGreaterThan(0);
    },
  );

  it.fails(
    'surfaces the same unresolved foreign state in wl worklist and wl doctor (F6)',
    () => {
      const { consumer, sibling, foreignItem } = setup();
      const [dependent] = seedLocalItems(consumer, [{ title: 'Local dependent' }]);

      expect(
        run(consumer, ['--json', 'dep', 'add', dependent.id, foreignItem.id]).status,
      ).toBe(0);
      fs.rmSync(sibling.dbPath, { force: true });

      // ── `wl worklist --json` ──
      const worklistRun = run(consumer, ['--json', 'worklist']);
      expect(worklistRun.status, worklistRun.stderr).toBe(0);
      const worklist = parseJson<{
        subsets: {
          blockedRoots: Array<{ id: string }>;
          browse: NextResultEntry[];
        };
      }>(worklistRun);

      expect(worklist.subsets.blockedRoots.map((item) => item.id)).toContain(
        dependent.id,
      );
      const browseEntry = worklist.subsets.browse.find(
        (entry) => entry.workItem?.id === dependent.id,
      );
      expect(browseEntry, 'dependent missing from the worklist browse feed').toBeDefined();
      expect(browseEntry?.foreign_dependencies?.[0]).toMatchObject({
        id: foreignItem.id,
        foreign: true,
        foreign_dependency: 'unavailable',
        unresolved: true,
        blocking: true,
      });

      // ── `wl doctor --json` ──
      const findings = doctorFindings(consumer);
      const unresolvedFinding = findings.find(
        (finding) => finding.itemId === dependent.id,
      );
      expect(unresolvedFinding, 'doctor did not surface the dependent').toBeDefined();
      expect(unresolvedFinding).toMatchObject({
        checkId: 'dependency.foreign-unresolved',
        type: 'unresolved-foreign-dependency',
        severity: 'warning',
        itemId: dependent.id,
      });
      expect(unresolvedFinding?.context).toMatchObject({
        blockerId: foreignItem.id,
        foreign: true,
        foreign_dependency: 'unavailable',
        unresolved: true,
      });
      expect(
        typeof unresolvedFinding?.context?.reason === 'string' &&
          (unresolvedFinding?.context?.reason as string).length > 0,
      ).toBe(true);

      // A foreign target is not a local missing endpoint: doctor must not
      // misreport the cross-project edge as `dependency.missing-endpoint`.
      const missingEndpoint = findings.find(
        (finding) =>
          finding.type === 'missing-dependency-endpoint' &&
          finding.context?.toId === foreignItem.id,
      );
      expect(missingEndpoint).toBeUndefined();
    },
  );
});

// ── always-green harness controls ─────────────────────────────────────────

describe('cross-repo gating spec harness controls', () => {
  const disposables: Array<() => void> = [];
  let fixture: ProjectsRootFixture | undefined;

  afterEach(() => {
    while (disposables.length > 0) {
      disposables.pop()!();
    }
    fixture?.cleanup();
    fixture = undefined;
  });

  function setup(): { consumer: Consumer; sibling: StoreHandle; foreignItem: WorkItem } {
    fixture = makeProjectsRoot({ standard: false });
    const sibling = fixture.addStore(SIBLING_PREFIX, {
      name: 'alpha-project',
      items: [{ title: 'Upstream blocker', status: 'open' }],
    });
    const consumer = makeConsumer(fixture.root);
    disposables.push(() => cleanupTempDir(consumer.dir));
    const [foreignItem] = readStoreItems(sibling);
    return { consumer, sibling, foreignItem };
  }

  it('mutates a sibling item status/stage directly in its own store', () => {
    const { sibling, foreignItem } = setup();

    setSiblingItemState(sibling, foreignItem.id, { status: 'completed', stage: 'in_review' });

    const [updated] = readStoreItems(sibling);
    expect(updated.id).toBe(foreignItem.id);
    expect(updated.status).toBe('completed');
    expect(updated.stage).toBe('in_review');
  });

  it('removes the sibling database so the store is genuinely unreadable', () => {
    const { sibling } = setup();
    expect(fs.existsSync(sibling.dbPath)).toBe(true);

    fs.rmSync(sibling.dbPath, { force: true });

    expect(fs.existsSync(sibling.dbPath)).toBe(false);
    // The project is still discoverable: the config and the `initialized`
    // marker survive a database removal (that is what makes the fail-safe
    // "discovered project, unreadable store" case distinct from an
    // undiscoverable prefix).
    expect(fs.existsSync(path.join(sibling.worklogDir, 'config.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(sibling.worklogDir, 'initialized'))).toBe(true);
  });

  it('records a foreign edge directly in the local store', () => {
    const { consumer, sibling, foreignItem } = setup();
    const [dependent] = seedLocalItems(consumer, [{ title: 'Local dependent' }]);
    const undiscoverableId = `${UNDISCOVERABLE_PREFIX}-0000000000000000`;

    seedForeignEdge(consumer, dependent.id, undiscoverableId);

    const db = new WorklogDatabase(
      CONSUMER_PREFIX,
      consumer.dbPath,
      consumer.jsonlPath,
      true,
      false,
      undefined,
      undefined,
      { readOnly: true },
    );
    try {
      expect(db.listDependencyEdgesFrom(dependent.id).map((edge) => edge.toId)).toEqual([
        undiscoverableId,
      ]);
    } finally {
      db.close();
    }

    // The sibling store is untouched by the direct seed (it is a local write).
    const [stillThere] = readStoreItems(sibling);
    expect(stillThere.id).toBe(foreignItem.id);
  });

  it('gating surfaces work for an item with no foreign edges (broken-CLI control)', () => {
    fixture = makeProjectsRoot({ standard: false });
    const consumer = makeConsumer(fixture.root);
    disposables.push(() => cleanupTempDir(consumer.dir));
    const [item] = seedLocalItems(consumer, [{ title: 'Plain local item' }]);

    // `wl next` selects a plain open item and never emits the foreign view.
    const next = nextSingle(consumer);
    expect(next.success).toBe(true);
    expect(next.workItem?.id).toBe(item.id);
    expect(next.foreign_dependencies).toBeUndefined();

    // `wl worklist` exposes the same item in its browse feed.
    const worklistRun = run(consumer, ['--json', 'worklist']);
    expect(worklistRun.status, worklistRun.stderr).toBe(0);
    const worklist = parseJson<{ subsets: { browse: NextResultEntry[] } }>(worklistRun);
    expect(worklist.subsets.browse.map((entry) => entry.workItem?.id)).toContain(item.id);
    expect(worklist.subsets.browse[0]?.foreign_dependencies).toBeUndefined();

    // `wl doctor --json` is a valid findings array with nothing dependency-related.
    const findings = doctorFindings(consumer);
    expect(Array.isArray(findings)).toBe(true);
    expect(
      findings.filter((finding) => finding.checkId?.startsWith('dependency.')),
    ).toEqual([]);
  });
});
