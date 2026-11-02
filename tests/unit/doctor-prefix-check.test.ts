/**
 * Unit tests for the `wl doctor prefix` pure helpers
 * (WL-0MVZ2U295000GJ8M, parent WL-0MVM8V79C003XH2J).
 *
 * Green today: `extractIdPrefix` is the shared ID-prefix helper the rename
 * reuses (`src/doctor/foreign-items-check.ts`), so those specs run against the
 * real implementation.
 *
 * The new helpers live in `src/doctor/prefix-check.ts`, added by the
 * implementation child (WL-0MVZ2U4E0003IVSZ). Every spec that needs them was
 * RED-pinned with `it.fails(...)` by the test-first child; the implementation
 * child then flipped `it.fails(` to `it(` as the module landed. The module is
 * imported dynamically so the file also loaded before it existed.
 *
 * Contract exercised here (mirrored by `tests/cli/doctor-prefix.test.ts`):
 *
 *  - `validateTargetPrefix(value)` → `{ valid: boolean, error?: string }`
 *    Valid: non-empty, ASCII alphanumeric only, no `-` (and no whitespace,
 *    punctuation or non-ASCII letters). Invalid values carry a non-empty
 *    `error` message naming the problem.
 *  - `renameId(id, fromPrefix, toPrefix)` → suffix-preserving renumbering.
 *    Only the substring before the FIRST `-` changes; `fromPrefix` is matched
 *    case-insensitively; IDs without a `-` and IDs with a different prefix are
 *    returned unchanged.
 *  - `decidePrefixConfirmation({ confirm, stdinIsTTY, answer })` →
 *    `{ proceed: boolean, prompt: boolean }`:
 *      · `confirm: true` → proceed, never prompt;
 *      · non-TTY without `confirm` → never prompt, never proceed (fail closed);
 *      · TTY without `confirm` → prompt; proceed only when the trimmed,
 *        lowercased answer is exactly `y` (`yes`, `n`, empty and anything else
 *        decline).
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractIdPrefix } from '../../src/doctor/foreign-items-check.js';
import type {
  ApplyPrefixRenameResult,
  PrefixRenamePreview,
} from '../../src/doctor/prefix-check.js';

interface PrefixCheckModule {
  validateTargetPrefix: (value: string) => { valid: boolean; error?: string };
  renameId: (id: string, fromPrefix: string, toPrefix: string) => string;
  decidePrefixConfirmation: (input: {
    confirm?: boolean;
    stdinIsTTY: boolean;
    answer?: string | null;
  }) => { proceed: boolean; prompt: boolean };
  rewriteConfigPrefix: (configPath: string, prefix: string) => void;
  buildPrefixRenamePreview: (input: {
    items: Array<{ id: string }>;
    comments: Array<{ id: string; workItemId: string; references: string[] }>;
    edges: Array<{ fromId: string; toId: string }>;
    audits: Array<{ workItemId: string }>;
    fromPrefix: string;
    toPrefix: string;
  }) => PrefixRenamePreview;
  applyPrefixRename: (opts: {
    dbPath: string;
    fromPrefix: string;
    toPrefix: string;
    beforeCommit?: () => void;
    onFailure?: () => void;
  }) => ApplyPrefixRenameResult;
  runPrefixRename: (deps: {
    opts: { to?: string; apply?: boolean; confirm?: boolean; prefix?: string };
    configPrefix: string | null;
    dataPath: string;
    configPath: string;
    isJsonMode: boolean;
    stdinIsTTY: boolean;
    db: {
      getAll: () => Array<{ id: string }>;
      getAllComments: () => Array<{ id: string; workItemId: string }>;
      getAllDependencyEdges: () => Array<{ fromId: string; toId: string }>;
      getAllAuditResults: () => Array<{ workItemId: string }>;
    };
    withMutationLock: <T>(fn: () => T) => T;
    prompt: (question: string) => Promise<string>;
    now?: Date;
  }) => Promise<{
    exitCode: number;
    json: Record<string, unknown>;
    lines: string[];
    error?: string;
  }>;
}

/** Resolve the prefix-check module once the implementation adds it (throws today). */
async function loadPrefixCheck(): Promise<PrefixCheckModule> {
  return (await import('../../src/doctor/prefix-check.js')) as PrefixCheckModule;
}

describe('extractIdPrefix (shared helper reused by the rename)', () => {
  it('returns the substring before the first dash', () => {
    expect(extractIdPrefix('WL-0MSAH2A71000MUA3')).toBe('WL');
    expect(extractIdPrefix('OSL-0MVK31VYQ007CN37')).toBe('OSL');
  });

  it('returns null when the ID has no dash separator', () => {
    expect(extractIdPrefix('NODASH123')).toBeNull();
  });

  it('returns null for an empty prefix', () => {
    expect(extractIdPrefix('-LEADINGDASH')).toBeNull();
  });

  it('splits only on the first dash', () => {
    expect(extractIdPrefix('OSL-ABC-DEF')).toBe('OSL');
  });
});

describe('validateTargetPrefix (--to validation)', () => {
  it('accepts non-empty ASCII alphanumeric prefixes', async () => {
    const { validateTargetPrefix } = await loadPrefixCheck();

    for (const value of ['CC', 'cc', 'C1', 'OSL', 'A']) {
      const result = validateTargetPrefix(value);
      expect(result.valid, `expected ${JSON.stringify(value)} to be valid`).toBe(true);
      expect(result.error ?? '').toBe('');
    }
  });

  it('rejects an empty or whitespace-only prefix', async () => {
    const { validateTargetPrefix } = await loadPrefixCheck();

    for (const value of ['', '   ', '\t']) {
      const result = validateTargetPrefix(value);
      expect(result.valid, `expected ${JSON.stringify(value)} to be invalid`).toBe(false);
      expect(result.error ?? '').not.toBe('');
    }
  });

  it('rejects a prefix containing a dash', async () => {
    const { validateTargetPrefix } = await loadPrefixCheck();

    for (const value of ['C-C', '-CC', 'CC-']) {
      const result = validateTargetPrefix(value);
      expect(result.valid, `expected ${JSON.stringify(value)} to be invalid`).toBe(false);
      expect(result.error ?? '').not.toBe('');
    }
  });

  it('rejects non-ASCII-alphanumeric characters', async () => {
    const { validateTargetPrefix } = await loadPrefixCheck();

    for (const value of ['C_C', 'CC 1', 'CC!', 'Café', ' WI']) {
      const result = validateTargetPrefix(value);
      expect(result.valid, `expected ${JSON.stringify(value)} to be invalid`).toBe(false);
      expect(result.error ?? '').not.toBe('');
    }
  });
});

describe('renameId (suffix-preserving rename mapping)', () => {
  it('renames only the prefix and preserves the suffix', async () => {
    const { renameId } = await loadPrefixCheck();

    expect(renameId('OSL-0MVK31VYQ007CN37', 'OSL', 'CC')).toBe('CC-0MVK31VYQ007CN37');
    expect(renameId('TEST-SAMPLE', 'TEST', 'CC')).toBe('CC-SAMPLE');
  });

  it('changes only the substring before the first dash', async () => {
    const { renameId } = await loadPrefixCheck();

    expect(renameId('TEST-A-B', 'TEST', 'CC')).toBe('CC-A-B');
  });

  it('leaves an ID without a dash unchanged', async () => {
    const { renameId } = await loadPrefixCheck();

    expect(renameId('NODASH123', 'TEST', 'CC')).toBe('NODASH123');
  });

  it('leaves an ID carrying a different prefix unchanged', async () => {
    const { renameId } = await loadPrefixCheck();

    expect(renameId('OTHER-1', 'TEST', 'CC')).toBe('OTHER-1');
  });

  it('matches the source prefix case-insensitively', async () => {
    const { renameId } = await loadPrefixCheck();

    expect(renameId('test-1', 'TEST', 'CC')).toBe('CC-1');
  });

  it('is a no-op when source and target prefixes are equal', async () => {
    const { renameId } = await loadPrefixCheck();

    expect(renameId('CC-1', 'CC', 'CC')).toBe('CC-1');
  });
});

describe('decidePrefixConfirmation (confirmation gate)', () => {
  it('proceeds without prompting when --confirm is given', async () => {
    const { decidePrefixConfirmation } = await loadPrefixCheck();

    expect(decidePrefixConfirmation({ confirm: true, stdinIsTTY: false })).toEqual({
      proceed: true,
      prompt: false,
    });
    expect(decidePrefixConfirmation({ confirm: true, stdinIsTTY: true })).toEqual({
      proceed: true,
      prompt: false,
    });
  });

  it('fails closed without prompting when stdin is not a TTY', async () => {
    const { decidePrefixConfirmation } = await loadPrefixCheck();

    for (const answer of [undefined, null, 'y', 'yes']) {
      expect(
        decidePrefixConfirmation({ confirm: false, stdinIsTTY: false, answer }),
      ).toEqual({ proceed: false, prompt: false });
    }
  });

  it('prompts on a TTY and proceeds only for an explicit y', async () => {
    const { decidePrefixConfirmation } = await loadPrefixCheck();

    expect(decidePrefixConfirmation({ confirm: false, stdinIsTTY: true })).toEqual({
      proceed: false,
      prompt: true,
    });
    expect(
      decidePrefixConfirmation({ confirm: false, stdinIsTTY: true, answer: 'y' }),
    ).toEqual({ proceed: true, prompt: true });
    expect(
      decidePrefixConfirmation({ confirm: false, stdinIsTTY: true, answer: ' Y ' }),
    ).toEqual({ proceed: true, prompt: true });
  });

  it('declines the prompt for anything other than y', async () => {
    const { decidePrefixConfirmation } = await loadPrefixCheck();

    for (const answer of ['yes', 'n', 'no', '', 'true']) {
      expect(
        decidePrefixConfirmation({ confirm: false, stdinIsTTY: true, answer }),
      ).toEqual({ proceed: false, prompt: true });
    }
  });
});

describe('rewriteConfigPrefix (config.yaml suffix-preserving rewrite)', () => {
  function tempConfig(contents: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-prefix-config-'));
    const file = path.join(dir, 'config.yaml');
    fs.writeFileSync(file, contents, 'utf-8');
    return file;
  }

  it('rewrites only the top-level prefix line and preserves everything else', async () => {
    const { rewriteConfigPrefix } = await loadPrefixCheck();
    const file = tempConfig(
      [
        'projectName: Demo',
        '# the project prefix',
        'prefix: OSL',
        'llm:',
        '  model: compact',
        '  apiKey: never-written-by-rename',
        'githubLabelPrefix: wl',
        '',
      ].join('\n'),
    );

    rewriteConfigPrefix(file, 'CC');

    const raw = fs.readFileSync(file, 'utf-8');
    expect(raw).toContain('prefix: CC');
    expect(raw).not.toContain('prefix: OSL');
    // Unrelated keys (including the nested llm section and a similarly-named
    // key) are untouched — the rewrite must never re-serialise the config.
    expect(raw).toContain('  apiKey: never-written-by-rename');
    expect(raw).toContain('  model: compact');
    expect(raw).toContain('githubLabelPrefix: wl');
    expect(raw).toContain('# the project prefix');
  });

  it('fails loudly when there is no top-level prefix line', async () => {
    const { rewriteConfigPrefix } = await loadPrefixCheck();
    const file = tempConfig('projectName: Demo\ngithubLabelPrefix: wl\n');

    expect(() => rewriteConfigPrefix(file, 'CC')).toThrow(/prefix/i);
    expect(fs.readFileSync(file, 'utf-8')).toBe('projectName: Demo\ngithubLabelPrefix: wl\n');
  });
});

describe('applyPrefixRename (transactional store rewrite)', () => {
  /** Minimal store schema mirroring the ID-bearing columns. */
  function createStore(): { dir: string; dbPath: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-prefix-store-'));
    const dbPath = path.join(dir, 'worklog.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE workitems (id TEXT PRIMARY KEY, parentId TEXT);
      CREATE TABLE comments (
        id TEXT PRIMARY KEY,
        workItemId TEXT NOT NULL,
        refs TEXT NOT NULL
      );
      CREATE TABLE dependency_edges (
        fromId TEXT NOT NULL,
        toId TEXT NOT NULL,
        PRIMARY KEY (fromId, toId)
      );
      CREATE TABLE audit_results (work_item_id TEXT PRIMARY KEY);
      CREATE VIRTUAL TABLE worklog_fts USING fts5(
        title,
        itemId UNINDEXED,
        parentId UNINDEXED
      );
    `);
    db.prepare('INSERT INTO workitems (id, parentId) VALUES (?, ?)').run('TEST-PARENT', null);
    db.prepare('INSERT INTO workitems (id, parentId) VALUES (?, ?)').run('TEST-CHILD', 'TEST-PARENT');
    db.prepare('INSERT INTO comments (id, workItemId, refs) VALUES (?, ?, ?)').run(
      'TEST-CM1',
      'TEST-PARENT',
      JSON.stringify(['TEST-CHILD']),
    );
    db.prepare('INSERT INTO dependency_edges (fromId, toId) VALUES (?, ?)').run('TEST-CHILD', 'TEST-PARENT');
    db.prepare('INSERT INTO audit_results (work_item_id) VALUES (?)').run('TEST-CHILD');
    db.prepare('INSERT INTO worklog_fts (title, itemId, parentId) VALUES (?, ?, ?)').run(
      'Child',
      'TEST-CHILD',
      'TEST-PARENT',
    );
    db.close();
    return { dir, dbPath };
  }

  function readStore(dbPath: string): {
    items: Array<{ id: string; parentId: string | null }>;
    comments: Array<{ id: string; workItemId: string; refs: string }>;
    edges: Array<{ fromId: string; toId: string }>;
    audits: string[];
    fts: Array<{ itemId: string; parentId: string }>;
  } {
    const db = new Database(dbPath, { readonly: true });
    try {
      return {
        items: db.prepare('SELECT id, parentId FROM workitems ORDER BY id').all() as any,
        comments: db.prepare('SELECT id, workItemId, refs FROM comments ORDER BY id').all() as any,
        edges: db.prepare('SELECT fromId, toId FROM dependency_edges').all() as any,
        audits: (db.prepare('SELECT work_item_id FROM audit_results').all() as any[]).map(
          (row) => row.work_item_id,
        ),
        fts: db.prepare('SELECT itemId, parentId FROM worklog_fts').all() as any,
      };
    } finally {
      db.close();
    }
  }

  it('rewrites every ID-bearing record and reports the touched counts', async () => {
    const { applyPrefixRename } = await loadPrefixCheck();
    const { dbPath } = createStore();

    const result = applyPrefixRename({ dbPath, fromPrefix: 'TEST', toPrefix: 'CC' });

    expect(result.counts).toEqual({
      items: 2,
      comments: 1,
      dependencyEdges: 1,
      auditRecords: 1,
    });
    expect(result.ids).toEqual({
      'TEST-PARENT': 'CC-PARENT',
      'TEST-CHILD': 'CC-CHILD',
    });

    const store = readStore(dbPath);
    expect(store.items).toEqual([
      { id: 'CC-CHILD', parentId: 'CC-PARENT' },
      { id: 'CC-PARENT', parentId: null },
    ]);
    expect(store.comments).toEqual([
      { id: 'CC-CM1', workItemId: 'CC-PARENT', refs: JSON.stringify(['CC-CHILD']) },
    ]);
    expect(store.edges).toEqual([{ fromId: 'CC-CHILD', toId: 'CC-PARENT' }]);
    expect(store.audits).toEqual(['CC-CHILD']);
    // The FTS ID columns follow the rename so `wl search` cannot return stale IDs.
    expect(store.fts).toEqual([{ itemId: 'CC-CHILD', parentId: 'CC-PARENT' }]);
  });

  it('rolls the whole rewrite back (and restores ancillary state) when a later step fails', async () => {
    const { applyPrefixRename } = await loadPrefixCheck();
    const { dbPath } = createStore();
    const before = readStore(dbPath);

    let restored = false;
    expect(() =>
      applyPrefixRename({
        dbPath,
        fromPrefix: 'TEST',
        toPrefix: 'CC',
        beforeCommit: () => {
          throw new Error('boom');
        },
        onFailure: () => {
          restored = true;
        },
      }),
    ).toThrow('boom');

    expect(restored).toBe(true);
    expect(readStore(dbPath)).toEqual(before);
  });

  it('is a no-op when the store already carries the target prefix', async () => {
    const { applyPrefixRename } = await loadPrefixCheck();
    const { dbPath } = createStore();

    const result = applyPrefixRename({ dbPath, fromPrefix: 'CC', toPrefix: 'CC' });

    expect(result.counts).toEqual({
      items: 0,
      comments: 0,
      dependencyEdges: 0,
      auditRecords: 0,
    });
    expect(readStore(dbPath).items.map((item) => item.id)).toEqual(['TEST-CHILD', 'TEST-PARENT']);
  });
});

describe('runPrefixRename (confirmation gate flow)', () => {
  const FIXED_NOW = new Date('2026-11-02T21:00:00.000Z');

  /** Minimal store + config fixture shared by the gate specs. */
  function setup(): {
    dir: string;
    dbPath: string;
    configPath: string;
    db: {
      getAll: () => Array<{ id: string }>;
      getAllComments: () => Array<{ id: string; workItemId: string }>;
      getAllDependencyEdges: () => Array<{ fromId: string; toId: string }>;
      getAllAuditResults: () => Array<{ workItemId: string }>;
    };
  } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-prefix-run-'));
    const dbPath = path.join(dir, 'worklog.db');
    const configPath = path.join(dir, 'config.yaml');
    fs.writeFileSync(configPath, 'projectName: Demo\nprefix: TEST\n', 'utf-8');

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE workitems (id TEXT PRIMARY KEY, parentId TEXT);
      CREATE TABLE comments (id TEXT PRIMARY KEY, workItemId TEXT NOT NULL, refs TEXT NOT NULL);
      CREATE TABLE dependency_edges (fromId TEXT NOT NULL, toId TEXT NOT NULL);
      CREATE TABLE audit_results (work_item_id TEXT PRIMARY KEY);
    `);
    db.prepare('INSERT INTO workitems (id, parentId) VALUES (?, ?)').run('TEST-ONE', null);
    db.close();

    const read = new Database(dbPath, { readonly: true });
    return {
      dir,
      dbPath,
      configPath,
      db: {
        getAll: () => read.prepare('SELECT id FROM workitems').all() as any,
        getAllComments: () => read.prepare('SELECT id, workItemId FROM comments').all() as any,
        getAllDependencyEdges: () => read.prepare('SELECT fromId, toId FROM dependency_edges').all() as any,
        getAllAuditResults: () =>
          read.prepare('SELECT work_item_id AS workItemId FROM audit_results').all() as any,
      },
    };
  }

  function deps(
    fixture: ReturnType<typeof setup>,
    overrides: Partial<Parameters<PrefixCheckModule['runPrefixRename']>[0]> = {},
  ): Parameters<PrefixCheckModule['runPrefixRename']>[0] {
    return {
      opts: { to: 'CC' },
      configPrefix: 'TEST',
      dataPath: path.join(fixture.dir, 'worklog-data.jsonl'),
      configPath: fixture.configPath,
      isJsonMode: true,
      stdinIsTTY: false,
      db: fixture.db,
      withMutationLock: (fn) => fn(),
      prompt: async () => '',
      now: FIXED_NOW,
      ...overrides,
    };
  }

  function currentId(dbPath: string): string {
    const db = new Database(dbPath, { readonly: true });
    try {
      return (db.prepare('SELECT id FROM workitems').get() as { id: string }).id;
    } finally {
      db.close();
    }
  }

  it('previews by default and never prompts or writes', async () => {
    const { runPrefixRename } = await loadPrefixCheck();
    const fixture = setup();
    let prompted = false;

    const result = await runPrefixRename(
      deps(fixture, {
        prompt: async () => {
          prompted = true;
          return 'y';
        },
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ dryRun: true, applied: false, renamedCount: 1 });
    expect(prompted).toBe(false);
    expect(currentId(fixture.dbPath)).toBe('TEST-ONE');
    expect(fs.readFileSync(fixture.configPath, 'utf-8')).toContain('prefix: TEST');
  });

  it('applies on an explicit y at the interactive prompt', async () => {
    const { runPrefixRename } = await loadPrefixCheck();
    const fixture = setup();
    const questions: string[] = [];

    const result = await runPrefixRename(
      deps(fixture, {
        opts: { to: 'CC', apply: true },
        stdinIsTTY: true,
        prompt: async (question) => {
          questions.push(question);
          return ' Y ';
        },
      }),
    );

    expect(questions).toHaveLength(1);
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ dryRun: false, applied: true, renamedCount: 1 });
    expect(currentId(fixture.dbPath)).toBe('CC-ONE');
    expect(fs.readFileSync(fixture.configPath, 'utf-8')).toContain('prefix: CC');
  });

  it('declines without writing when the interactive answer is not y', async () => {
    const { runPrefixRename } = await loadPrefixCheck();
    const fixture = setup();

    const result = await runPrefixRename(
      deps(fixture, {
        opts: { to: 'CC', apply: true },
        stdinIsTTY: true,
        prompt: async () => 'yes',
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ dryRun: true, applied: false });
    expect(currentId(fixture.dbPath)).toBe('TEST-ONE');
    expect(fs.readFileSync(fixture.configPath, 'utf-8')).toContain('prefix: TEST');
  });

  it('fails closed for a non-TTY apply request without --confirm', async () => {
    const { runPrefixRename } = await loadPrefixCheck();
    const fixture = setup();
    let prompted = false;

    const result = await runPrefixRename(
      deps(fixture, {
        opts: { to: 'CC', apply: true },
        stdinIsTTY: false,
        prompt: async () => {
          prompted = true;
          return 'y';
        },
      }),
    );

    expect(result.exitCode).not.toBe(0);
    expect(String(result.error)).toContain('--confirm');
    expect(prompted).toBe(false);
    expect(currentId(fixture.dbPath)).toBe('TEST-ONE');
    expect(fs.readFileSync(fixture.configPath, 'utf-8')).toContain('prefix: TEST');
  });

  it('applies without prompting when --confirm is given', async () => {
    const { runPrefixRename } = await loadPrefixCheck();
    const fixture = setup();
    let prompted = false;

    const result = await runPrefixRename(
      deps(fixture, {
        opts: { to: 'CC', confirm: true },
        stdinIsTTY: false,
        prompt: async () => {
          prompted = true;
          return 'n';
        },
      }),
    );

    expect(prompted).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ dryRun: false, applied: true, renamedCount: 1 });
    expect(typeof result.json.renameMapPath).toBe('string');
    expect(currentId(fixture.dbPath)).toBe('CC-ONE');
  });
});
