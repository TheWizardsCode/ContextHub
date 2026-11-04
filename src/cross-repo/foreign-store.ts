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
// The shared class, not the CLI wrapper: this module must stay importable from
// `src/database.ts` (which wires the resolver service) without a module cycle.
// A snapshot read needs no CLI services (JSONL, sync, file-lock, search).
import { WorklogDatabase } from '@worklog/shared';
import type { WorkItem } from '../types.js';
import { discoverProjects, type DiscoveryResult } from './project-registry.js';

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
  /**
   * `true` when a project owning the id's prefix was discovered — even when
   * its store could not be read or the prefix is ambiguous.
   *
   * This is the gating fail-safe discriminator (parent D3): an `unavailable`
   * target with a discovered project keeps the dependent blocked, while an
   * undiscoverable prefix stays a non-blocking coordination note.
   */
  discoveredProject: boolean;
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
 * Per-process memo of foreign resolutions, keyed by projects root + item id.
 *
 * The gating hot path (`wl next`, `hasActiveBlockers` during reconciliation)
 * asks the same question repeatedly and each uncached answer copies the
 * sibling's SQLite file into a temp directory. A CLI invocation is
 * short-lived, so a process-lifetime memo cannot serve a stale answer across
 * a sibling-store mutation that happened in another process. Call
 * {@link clearForeignResolutionCache} when a long-lived caller knows the
 * sibling layout or data changed in-process.
 */
const resolutionCache = new Map<string, ForeignItemResolution>();

/** Drop the per-process foreign resolution memo. */
export function clearForeignResolutionCache(): void {
  resolutionCache.clear();
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
  const discovery = discoverProjects({
    cwd: options.cwd,
    projectsRoot: options.projectsRoot,
  });

  const cacheKey = `${discovery.projectsRoot}\u0000${normalisedId}`;
  const cached = resolutionCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const resolution = resolveForeignItemFromDiscovery(id, normalisedId, discovery);
  resolutionCache.set(cacheKey, resolution);
  return resolution;
}

/** The uncached resolution body — see {@link resolveForeignItem}. */
function resolveForeignItemFromDiscovery(
  id: string,
  normalisedId: string,
  discovery: DiscoveryResult,
): ForeignItemResolution {
  const prefix = prefixOfWorkItemId(normalisedId);
  const base: ForeignItemResolution = {
    id: normalisedId,
    prefix,
    state: 'unavailable',
    discoveredProject: false,
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
      // A project owns the prefix, but more than one does: never guess an
      // owner. Gating treats this as a discovered, unreadable target.
      discoveredProject: true,
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
      discoveredProject: true,
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
      discoveredProject: true,
      projectPath,
      reason: `Work item ${normalisedId} was not found in the '${prefix}' store at ${projectPath}.`,
    };
  }

  return {
    ...base,
    state: 'resolved',
    discoveredProject: true,
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
