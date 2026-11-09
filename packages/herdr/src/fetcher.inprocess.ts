/**
 * packages/herdr/src/fetcher.inprocess.ts — in-process SQLite read path
 * (fail-open).
 *
 * Single responsibility: read the worklog store directly through the lazily
 * loaded `@worklog/shared` `WorklogDatabase` instead of spawning `wl` — the
 * per-call fast path ({@link withInProcessDb}), the refresh-scoped connection
 * ({@link createInProcessRefreshScope}), the open accounting
 * ({@link getInProcessOpenStats} / {@link resetInProcessOpenStats}) and the
 * audit enrichment of in-process items. It holds the only declaration of the
 * in-process open stats and the only `createInProcessRefreshScope`.
 *
 * Leaf module: it imports only concrete siblings (`./fetcher.args.js` for the
 * worklog dir, `./fetcher.json.js` for item normalisation and
 * `./fetcher.types.js` for the structural DB/refresh-scope types) and never
 * the `./fetcher.js` barrel (parent AC4 of WL-0MVGKH47T007GKN1).
 *
 * The path stays strictly fail-open: any failure to load or open the database
 * resolves `undefined` (or skips the read), so every caller falls back to its
 * `wl` spawn path — never throws (WL-0MV5CBQ6L005SPAG).
 *
 * Moved verbatim out of `fetcher.ts` (parent WL-0MVGKH47T007GKN1; extraction
 * WL-0MW08VVC0007L28M). No behaviour change: the DB-open counter still
 * increments on the same events.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getWorklogDir } from './fetcher.args.js';
import { normalizeItem } from './fetcher.json.js';
import type {
  InProcessDb,
  InProcessDbCtor,
  InProcessOpenStats,
  InProcessRefreshScope,
  WorkItem,
} from './fetcher.types.js';

// ── In-process SQLite reads (WL-0MV5CBQ6L005SPAG) ─────────────────────

let _inProcessOpens = 0;
let _inProcessOpenMs = 0;

/** Snapshot of the open accounting since the last reset. */
export function getInProcessOpenStats(): InProcessOpenStats {
  return { opens: _inProcessOpens, openMs: _inProcessOpenMs };
}

/** Reset the open accounting (tests / harness). */
export function resetInProcessOpenStats(): void {
  _inProcessOpens = 0;
  _inProcessOpenMs = 0;
}

/**
 * Open ONE refresh-scoped in-process connection, read-only, no DDL (F6).
 *
 * `readOnly` opens the store with SQLite's READONLY flag and skips all
 * schema/FTS DDL on an already-initialised store, so the per-refresh open is
 * pragmas-only cheap and a refresh helper can never mutate the store. The
 * open runs synchronously on the event loop within the refresh, so its cost
 * is accounted here. Any open failure throws and the caller fails open
 * (degrades to the `wl` spawn path).
 */
function openInProcessConnection(
  Ctor: InProcessDbCtor,
  dir: string,
  dbPath: string,
): InProcessDb {
  const startedAt = Date.now();
  const db = new Ctor(
    'WI',
    dbPath,
    join(dir, 'worklog-data.jsonl'),
    true,
    false,
    undefined,
    undefined,
    { readOnly: true },
  );
  _inProcessOpens += 1;
  _inProcessOpenMs += Math.max(0, Date.now() - startedAt);
  return db;
}

let _dbCtorPromise: Promise<InProcessDbCtor | null> | null = null;

/**
 * Lazily resolve the `@worklog/shared` WorklogDatabase constructor. The
 * dynamic import keeps the native `better-sqlite3` dependency out of the
 * plugin's import graph until a refresh actually reads in-process. Any load
 * failure (native module unavailable, incompatible runtime) resolves `null`
 * and the caller falls back to spawning `wl` (fail-open).
 */
function loadInProcessDbCtor(): Promise<InProcessDbCtor | null> {
  if (_dbCtorPromise === null) {
    _dbCtorPromise = import('@worklog/shared')
      .then((mod) => ((mod as { WorklogDatabase?: InProcessDbCtor }).WorklogDatabase) ?? null)
      .catch(() => null);
  }
  return _dbCtorPromise;
}

/**
 * Run `fn` against a FRESH in-process WorklogDatabase for the current worklog
 * dir, or resolve `undefined` when no in-process read is possible (no dir
 * resolved, no SQLite file on disk, `@worklog/shared` unavailable, or the
 * read throws).
 *
 * The handle is opened per call and closed in `finally`, so a read always
 * reflects the latest committed state: the store's in-memory query cache can
 * never serve data across a refresh boundary. This is the "no stale cache
 * served or left behind" invariant for the default-view fast path
 * (WL-0MV5CBQ6L005SPAG). Callers MUST fall back to the `wl` spawn path on
 * `undefined`.
 *
 * Module-private surface consumed by the barrel's reads (the barrel is the only
 * consumer-visible entry point), so it is exported from this leaf for sibling
 * import but never re-exported from `./fetcher.js`.
 */
export async function withInProcessDb<T>(fn: (db: InProcessDb) => T): Promise<T | undefined> {
  const dir = getWorklogDir();
  if (!dir) return undefined;
  const dbPath = join(dir, 'worklog.db');
  if (!existsSync(dbPath)) return undefined;

  const Ctor = await loadInProcessDbCtor();
  if (!Ctor) return undefined;

  let db: InProcessDb | null = null;
  try {
    db = openInProcessConnection(Ctor, dir, dbPath);
    return fn(db);
  } catch {
    // Fail-open: any open/read failure degrades to the wl spawn path.
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore: closing a broken handle must not mask the result.
    }
  }
}

/**
 * Create an {@link InProcessRefreshScope} (WL-0MV6C6SLB005HX7B). The
 * connection is opened lazily on the scope's first read and closed by
 * {@link InProcessRefreshScope.close}; the lazy `@worklog/shared` import is
 * the same module-level `loadInProcessDbCtor` the per-call fast path uses,
 * so no new dependency or import-time cost is introduced.
 */
export function createInProcessRefreshScope(): InProcessRefreshScope {
  let db: InProcessDb | null = null;
  let ctorPromise: Promise<InProcessDbCtor | null> | undefined;
  let pendingReads = 0;
  let closeRequested = false;

  const release = (): void => {
    const handle = db;
    db = null;
    ctorPromise = undefined;
    pendingReads = 0;
    try {
      handle?.close();
    } catch {
      // ignore: closing a broken handle must not mask a read result.
    }
  };

  return {
    async read<T>(fn: (db: InProcessDb) => T): Promise<T | undefined> {
      const dir = getWorklogDir();
      if (!dir) return undefined;
      const dbPath = join(dir, 'worklog.db');
      if (!existsSync(dbPath)) return undefined;
      if (ctorPromise === undefined) ctorPromise = loadInProcessDbCtor();

      // Hold a read slot BEFORE any await: a close() requested while this
      // read is pending defers the release until the read settles, so the
      // read always runs against an open handle (doRefresh's actionable-count
      // read is fire-and-forget and can outlive the synchronous close call).
      pendingReads += 1;
      try {
        const Ctor = await ctorPromise;
        if (!Ctor) return undefined;
        if (!db) {
          try {
            db = openInProcessConnection(Ctor, dir, dbPath);
          } catch {
            // Fail-open: an open failure degrades to the wl spawn path.
            return undefined;
          }
        }
        try {
          return fn(db);
        } catch {
          // Fail-open: any read failure degrades to the wl spawn path.
          return undefined;
        }
      } finally {
        pendingReads -= 1;
        if (closeRequested && pendingReads === 0) release();
      }
    },
    close(): void {
      closeRequested = true;
      if (pendingReads === 0) release();
    },
  };
}

/**
 * Apply the audit enrichment `wl list --json` adds (auditResult, auditedAt and
 * the stored fingerprint) to in-process items. `currentFingerprint` is
 * deliberately NOT set: deriving it requires the canonical git-based
 * fingerprint computation that only the `wl` CLI performs, and the shared
 * `isAuditFresh` predicate fails safe to the time gate when it is absent.
 * Callers therefore only use this enrichment for items WITHOUT a stored
 * fingerprint (an audited item falls back to spawning `wl` so its exact
 * fingerprint freshness is preserved).
 *
 * Module-private surface consumed by the barrel's reads, exported for sibling
 * import only — never re-exported from `./fetcher.js`.
 */
export function enrichInProcessItems(db: InProcessDb, items: any[]): WorkItem[] {
  const auditMap = new Map(db.getAllAuditResults().map((audit) => [audit.workItemId, audit]));
  return items.map((raw) => {
    const item = normalizeItem(raw);
    const audit = auditMap.get(item.id);
    if (!audit) return item;
    return {
      ...item,
      auditResult: audit.readyToClose,
      auditedAt: audit.auditedAt ?? null,
      fingerprint: audit.fingerprint ?? null,
    };
  });
}
