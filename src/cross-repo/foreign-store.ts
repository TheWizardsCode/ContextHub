/**
 * Read-only foreign store resolver (F4 — WL-0MVWEENZL008XGYC).
 *
 * Parent: WL-0MVWABT2Z001XMSD (cross-repo dependencies), design constraint D2.
 *
 * A dependency edge may point at an item that lives in **another project's**
 * store. Recording and displaying that edge must never touch the sibling
 * store beyond reading it: no schema write, no mutation lock, no sync, no
 * `-wal`/`-shm` sidecar (the AC5 isolation proof).
 *
 * This module is the single place that reads a sibling store. Discovery is
 * delegated to `./project-registry.ts` (F2) so the prefix → project scan
 * exists once.
 *
 * ## Why a snapshot copy instead of opening the sibling directly
 *
 * Every store this tool creates runs SQLite in **WAL** mode. Opening such a
 * database directly — even with `readonly: true` — makes SQLite create (or
 * touch) the `-wal` and `-shm` sidecars **inside the sibling's `.worklog/`**
 * directory, which is precisely what AC5 forbids (measured: a read-only open
 * of a freshly seeded, sidecar-free WAL database leaves `worklog.db-shm` and
 * `worklog.db-wal` behind). SQLite's `immutable=1` escape hatch is not
 * reachable through better-sqlite3 (it does not pass `SQLITE_OPEN_URI`), so
 * the resolver instead:
 *
 *   1. copies the sibling's `worklog.db` (plus `-wal` when present, so
 *      uncheckpointed committed pages are included) into a private temp
 *      directory — a byte read, never a SQLite open of the sibling;
 *   2. opens **the copy** with `readonly: true` + `fileMustExist: true`
 *      (the same read-only contract, applied where sidecars are harmless);
 *   3. removes the temp directory.
 *
 * The sibling therefore sees no lock, no sync, no schema write, no WAL write
 * and no sidecar — the strongest form of the AC5 isolation proof.
 *
 * ## Tri-state resolution
 *
 * The result is deliberately tri-state so a caller never has to guess why a
 * foreign target could not be read (parent D3's fail-safe contract):
 *
 *   - `resolved`    — the prefix maps to exactly one project and the item was
 *                     read from that project's store;
 *   - `unresolved`  — the project was found and its store opened, but it holds
 *                     no such item;
 *   - `unavailable` — no project owns the prefix, the prefix is ambiguous, or
 *                     the store could not be opened/read. `reason` says which.
 *
 * Nothing here writes, locks or syncs. A failure is reported, never thrown.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorklogDatabase } from '../database.js';
import type { WorkItem } from '../types.js';
import { discoverProjects } from './project-registry.js';

/** Resolution state of a foreign dependency target. */
export type ForeignDependencyState = 'resolved' | 'unresolved' | 'unavailable';

/** Options accepted by {@link resolveForeignItem}. */
export interface ResolveForeignItemOptions {
  /** Checkout directory used for projects-root resolution (default: cwd). */
  cwd?: string;
  /** Explicit projects root; wins over the config value and the default. */
  projectsRoot?: string;
}

/** Result of resolving one foreign id against the discovered projects. */
export interface ForeignItemResolution {
  /** The normalised (upper-cased) id that was resolved. */
  id: string;
  /** Prefix segment of {@link id} (the part before the first `-`). */
  prefix: string;
  /** Tri-state resolution result. */
  state: ForeignDependencyState;
  /** The foreign item — present only when {@link state} is `resolved`. */
  item?: WorkItem;
  /** Project root of the owning store, when one was identified. */
  projectPath?: string;
  /** The projects root that was scanned. */
  projectsRoot?: string;
  /** `true` when several projects declare {@link prefix}. */
  ambiguous?: boolean;
  /** Every project declaring {@link prefix}, sorted; present when ambiguous. */
  candidates?: string[];
  /** Human-readable explanation for a non-`resolved` state. */
  reason?: string;
}

/**
 * The prefix segment of a work-item id (`ALPHA-…` → `ALPHA`). Returns an empty
 * string when the id carries no prefix separator.
 */
export function prefixOfWorkItemId(id: string): string {
  const separator = id.indexOf('-');
  return separator < 0 ? '' : id.slice(0, separator).toUpperCase();
}

/**
 * Resolve `id` against the discovered sibling projects, opening the owning
 * store **read-only**.
 *
 * Never throws: every filesystem/database problem becomes an `unavailable`
 * result carrying a `reason`, so a caller can degrade gracefully instead of
 * failing the whole command.
 */
export function resolveForeignItem(
  id: string,
  options: ResolveForeignItemOptions = {},
): ForeignItemResolution {
  const normalisedId = id.trim().toUpperCase();
  const prefix = prefixOfWorkItemId(normalisedId);

  const discovery = discoverProjects({
    cwd: options.cwd,
    projectsRoot: options.projectsRoot,
  });
  const base: ForeignItemResolution = {
    id: normalisedId,
    prefix,
    state: 'unavailable',
    projectsRoot: discovery.projectsRoot,
  };

  if (prefix === '') {
    return {
      ...base,
      reason: `'${id}' has no project prefix (expected '<PREFIX>-<id>').`,
    };
  }

  const project = discovery.projects.find((entry) => entry.prefix === prefix);
  if (project === undefined) {
    return {
      ...base,
      reason: `No project with prefix '${prefix}' was discovered under ${discovery.projectsRoot}.`,
    };
  }

  if (project.ambiguous || project.path === null) {
    const candidates = project.candidates ?? [];
    return {
      ...base,
      ambiguous: true,
      candidates,
      reason:
        `Prefix '${prefix}' is declared by ${candidates.length} projects ` +
        `(${candidates.join(', ')}) — refusing to guess an owner.`,
    };
  }

  const projectPath = project.path;
  const worklogDir = path.join(projectPath, '.worklog');
  const dbPath = path.join(worklogDir, 'worklog.db');

  let item: WorkItem | null;
  try {
    item = readItemFromSnapshot(prefix, dbPath, normalisedId);
  } catch (error) {
    return {
      ...base,
      projectPath,
      reason:
        `Could not read the '${prefix}' store at ${dbPath} ` +
        `(${error instanceof Error ? error.message : String(error)}) — ` +
        'treating the foreign dependency as unavailable.',
    };
  }

  if (!item) {
    return {
      ...base,
      state: 'unresolved',
      projectPath,
      reason: `Work item ${normalisedId} was not found in the '${prefix}' store at ${projectPath}.`,
    };
  }

  return {
    ...base,
    state: 'resolved',
    projectPath,
    item,
  };
}

/**
 * Read one item from a **snapshot copy** of a sibling store.
 *
 * The sibling's `worklog.db` (plus its `-wal` when present) is copied into a
 * private temp directory; only the copy is opened, with `readonly: true` and
 * `fileMustExist: true`. The temp directory is always removed, so the sibling
 * `.worklog/` gains no lock, no sidecar and no write (AC5).
 *
 * Throws when the store cannot be copied/opened — the caller degrades that to
 * `unavailable` rather than propagating it.
 */
function readItemFromSnapshot(
  prefix: string,
  dbPath: string,
  itemId: string,
): WorkItem | null {
  const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-foreign-'));
  try {
    const snapshotDb = path.join(snapshotDir, 'worklog.db');
    fs.copyFileSync(dbPath, snapshotDb);
    // Include uncheckpointed committed pages when a live writer left a WAL
    // behind. The `-shm` is connection state and is deliberately not copied.
    const sourceWal = `${dbPath}-wal`;
    if (fs.existsSync(sourceWal)) {
      fs.copyFileSync(sourceWal, `${snapshotDb}-wal`);
    }

    const db = new WorklogDatabase(
      prefix,
      snapshotDb,
      path.join(snapshotDir, 'worklog-data.jsonl'),
      true,
      false,
      undefined,
      { readOnly: true },
    );
    try {
      return db.get(itemId);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(snapshotDir, { recursive: true, force: true });
  }
}
