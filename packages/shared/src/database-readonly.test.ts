/**
 * packages/shared/src/database-readonly.test.ts — read-only, no-DDL in-process
 * open for the Herdr refresh (F6 — WL-0MVJV2PX4005JH8D).
 *
 * A default-view refresh opens at most ONE in-process SQLite connection
 * (WL-0MV6C6SLB005HX7B) and the open cost is a budget risk: the old open path
 * ran `initializeSchema`'s ~7 `CREATE ... IF NOT EXISTS` execs, the additive
 * column repair (`PRAGMA table_info` × N) and the FTS5 probe (a virtual-table
 * create + drop) on the TUI event loop — measured at 46–70 ms cold
 * (F2, WL-0MVJV2NNG00771C6). This item makes the refresh-scoped open
 * READ-ONLY and skips ALL schema/FTS DDL when the store is already
 * initialised (schema/version present), so an already-initialised store is
 * opened with pragmas only.
 *
 * These tests assert the observable contract of the `readOnly` open mode:
 *
 *   1. a read-only open of an initialised store runs NO schema-changing DDL
 *      (asserted via SQLite's own `PRAGMA schema_version`, which any
 *      create/drop bumps — the old FTS probe bumped it on every writable
 *      open; a writable control open proves the assertion is non-vacuous);
 *   2. a read-only open still reads items, comments, audit results and
 *      dependency edges through the public API (the fetcher's read surface);
 *   3. a read-only handle cannot mutate the store (a write throws
 *      SQLITE_READONLY — refresh helpers can never persist);
 *   4. a read-only open of a MISSING database file fails instead of creating
 *      one (fail-open contract: the fetcher degrades to the `wl` spawn path);
 *   5. a read-only open of an uninitialised (empty) database file fails
 *      instead of silently creating a schema (same fail-open contract).
 *
 * Run: npx vitest run packages/shared/src/database-readonly.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { WorklogDatabase } from './database.js';

describe('WorklogDatabase read-only open mode (F6 — WL-0MVJV2PX4005JH8D)', () => {
  let tempDir: string;
  let dbPath: string;
  let jsonlPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wl-readonly-'));
    dbPath = join(tempDir, 'worklog.db');
    jsonlPath = join(tempDir, 'data.jsonl');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** SQLite's own schema-change counter (any DDL bumps it). */
  function schemaVersion(path: string): number {
    const raw = new Database(path, { readonly: true });
    try {
      return raw.pragma('schema_version', { simple: true }) as number;
    } finally {
      raw.close();
    }
  }

  /** Seed an initialised store with items, a comment, an audit and a dep edge. */
  function seedStore(): { fromId: string; toId: string } {
    const db = new WorklogDatabase('TEST', dbPath, jsonlPath, true, false);
    try {
      const from = db.create({ title: 'Blocked item', description: 'depends on the target', priority: 'high' });
      const to = db.create({ title: 'Blocker', description: 'still open', priority: 'critical' });
      db.createComment({ workItemId: from.id, author: 'tester', comment: 'a comment' });
      db.saveAuditResult({
        workItemId: from.id,
        readyToClose: false,
        auditedAt: '2026-01-01T00:00:00.000Z',
        summary: 'not ready',
        rawOutput: null,
        author: 'tester',
      });
      db.addDependencyEdge(from.id, to.id);
      return { fromId: from.id, toId: to.id };
    } finally {
      db.close();
    }
  }

  it('runs NO schema/FTS DDL when the store is already initialised (read-only)', () => {
    seedStore();
    const before = schemaVersion(dbPath);

    const ro = new WorklogDatabase('TEST', dbPath, jsonlPath, true, false, undefined, undefined, {
      readOnly: true,
    });
    try {
      // The read surface the fetcher's refresh scope consumes must be usable.
      expect(ro.list({}).length).toBeGreaterThanOrEqual(2);
    } finally {
      ro.close();
    }

    // A read-only open of an initialised store must not touch the schema:
    // the old path's FTS probe (virtual-table create + drop) bumped
    // schema_version on EVERY writable open.
    expect(schemaVersion(dbPath)).toBe(before);
  });

  it('the schema_version guard is non-vacuous: a writable open bumps it (FTS probe)', () => {
    seedStore();
    const before = schemaVersion(dbPath);

    // Writable open (the pre-F6 path): the FTS5 probe creates then drops a
    // virtual table, so the schema counter MUST move — proving the read-only
    // assertion above would catch a DDL regression.
    const writable = new WorklogDatabase('TEST', dbPath, jsonlPath, true, false);
    try {
      expect(writable.list({}).length).toBeGreaterThanOrEqual(2);
    } finally {
      writable.close();
    }
    expect(schemaVersion(dbPath)).toBeGreaterThan(before);
  });

  it('reads items, comments, audit results and dependency edges (the fetcher surface)', () => {
    const { fromId, toId } = seedStore();

    const ro = new WorklogDatabase('TEST', dbPath, jsonlPath, true, false, undefined, undefined, {
      readOnly: true,
    });
    try {
      expect(ro.list({}).length).toBe(2);
      expect(ro.get(fromId)?.title).toBe('Blocked item');
      expect(ro.get(toId)?.priority).toBe('critical');
      const audits = ro.getAllAuditResults();
      expect(audits.length).toBe(1);
      expect(audits[0].workItemId).toBe(fromId);
      expect(audits[0].readyToClose).toBe(false);
      const edges = ro.listDependencyEdgesFrom(fromId);
      expect(edges.length).toBe(1);
      expect(edges[0].toId).toBe(toId);
    } finally {
      ro.close();
    }
  });

  it('rejects writes on a read-only handle (refresh helpers can never persist)', () => {
    seedStore();
    const ro = new WorklogDatabase('TEST', dbPath, jsonlPath, true, false, undefined, undefined, {
      readOnly: true,
    });
    try {
      expect(() => ro.create({ title: 'must fail', description: 'x', priority: 'low' })).toThrow();
      expect(ro.list({}).length).toBe(2);
    } finally {
      ro.close();
    }
  });

  it('fails instead of creating a database when the file is missing (fail-open contract)', () => {
    // fileMustExist is part of the read-only open: the fetcher's fail-open
    // path needs the distinction between "no store, use the wl spawn path"
    // and a store that is merely empty.
    const absent = join(tempDir, 'does-not-exist', 'worklog.db');
    expect(() => {
      const ro = new WorklogDatabase('TEST', absent, jsonlPath, true, false, undefined, undefined, {
        readOnly: true,
      });
      ro.close();
    }).toThrow();
  });

  it('fails without creating a schema when the file exists but is uninitialised', () => {
    // A 0-byte database file: fileMustExist passes, but the store must NOT
    // silently initialise (writes) on a read-only open — the DDL path throws
    // and the constructor rejects, so the fetcher degrades to the spawn path.
    const raw = new Database(dbPath);
    raw.close();

    expect(() => {
      const ro = new WorklogDatabase('TEST', dbPath, jsonlPath, true, false, undefined, undefined, {
        readOnly: true,
      });
      ro.close();
    }).toThrow();
  });
});
