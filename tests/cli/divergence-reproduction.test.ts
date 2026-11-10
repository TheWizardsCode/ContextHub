/**
 * Reproduction fixtures for the store divergence reported in
 * WL-0MW9YUYF3006H56I (child WL-0MWABDLX500929F1).
 *
 * The report: a work item visible through `wl list`, `wl search` and
 * `wl export` is not resolvable/mutable through `wl show`, `wl comment` or
 * `wl update`, which return `Work item not found` — permanently blocking the
 * item's parent epic while every read path that *does* see it insists it
 * exists.
 *
 * These tests build the corrupt store states directly (see
 * `divergence-fixtures.ts`) and pin the diverging behaviour. They are the
 * shared reproduction the `wl doctor` integrity check (child
 * WL-0MWABEV8100167Y5), the repair command (child WL-0MWABFI8Z004RFA0) and the
 * shared resolver (child WL-0MWABGAVN0082TLF) build on:
 *
 *  1. **Class 2** — the primary row exists but the exact-match `get(id)` path
 *     misses it, so `list`/`search`/`export` succeed while the strict lookup
 *     paths fail. This is the class that reproduces the *reported* symptom.
 *  2. **Class 1** — a derived path holds an item the primary table cannot
 *     serve: a phantom FTS entry, an FTS gap (search silently omits an item
 *     list returns), and a JSONL snapshot holding an item the primary store
 *     lacks.
 *
 * No live worklog, network or subprocess-heavy setup: a temp worklog, direct
 * SQLite fixture writes under the store mutation lock, and the CLI run
 * in-process / bundled.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import {
  cliPath,
  execAsync,
  enterTempDir,
  leaveTempDir,
  writeConfig,
  writeInitSemaphore,
} from './cli-helpers.js';
import { cliInvocation } from './cli-bundle.js';
import {
  demotePrimaryIdToNonCanonical,
  dropFtsEntry,
  makeDivergenceWorkItem,
  plantPhantomFtsEntry,
  readDivergenceJsonl,
  readFtsIds,
  readPrimaryIds,
  writeDivergenceJsonlSnapshot,
} from './divergence-fixtures.js';

describe('store divergence reproduction (WL-0MW9YUYF3006H56I)', () => {
  let state: { tempDir: string; originalCwd: string };
  let previousCacheDisabled: string | undefined;

  beforeEach(() => {
    state = enterTempDir();
    writeConfig(state.tempDir, 'Divergence Project', 'TEST');
    writeInitSemaphore(state.tempDir);
    // The in-process harness bypasses src/cli.ts's read-cache wiring, but set
    // the bypass explicitly so a subprocess path (the concurrency test) and any
    // future harness change cannot serve a stale read after a direct fixture
    // write bumped no state counter.
    previousCacheDisabled = process.env.WL_CACHE_DISABLED;
    process.env.WL_CACHE_DISABLED = '1';
  });

  afterEach(() => {
    if (previousCacheDisabled === undefined) delete process.env.WL_CACHE_DISABLED;
    else process.env.WL_CACHE_DISABLED = previousCacheDisabled;
    leaveTempDir(state);
  });

  async function runJson(args: string): Promise<any> {
    const { stdout } = await execAsync(`tsx ${cliPath} ${args}`);
    return JSON.parse(stdout);
  }

  async function runExpectFailure(
    args: string,
  ): Promise<{ stdout: string; stderr: string; failed: boolean }> {
    try {
      const res = await execAsync(`tsx ${cliPath} ${args}`);
      return { ...res, failed: false };
    } catch (e: any) {
      return { stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? ''), failed: true };
    }
  }

  /**
   * Assert a failed CLI call reported the item as not found.
   *
   * The mutating commands differ in where the structured failure lands in JSON
   * mode — `wl update` writes `{success:false,error}` to stdout, while
   * `wl show`/`wl comment add` write it to stderr — so the assertion covers
   * both streams.
   */
  function expectNotFoundException(res: { stderr: string; stdout: string; failed: boolean }): void {
    expect(res.failed).toBe(true);
    expect(`${res.stdout}\n${res.stderr}`).toContain('Work item not found');
  }

  async function createItem(title: string): Promise<string> {
    const res = await runJson(`--json create -t "${title}" --allow-duplicate`);
    expect(res.success).toBe(true);
    return res.workItem.id as string;
  }

  // ── Class 2 — primary row present, exact-match lookup misses it ──────────
  describe('class 2: non-canonical primary id (exact lookup diverges from scan)', () => {
    it('is visible through list/search/export but the exact-match lookup misses it', async () => {
      const canonicalId = await createItem('Divergent lookup item');
      const storedId = demotePrimaryIdToNonCanonical(state.tempDir, canonicalId);

      // The fixture really did create the divergence: the primary + FTS rows
      // now carry the non-canonical id, and the canonical id is gone.
      expect(storedId).toBe(canonicalId.toLowerCase());
      expect(readPrimaryIds(state.tempDir)).toContain(storedId);
      expect(readPrimaryIds(state.tempDir)).not.toContain(canonicalId);
      expect(readFtsIds(state.tempDir)).toContain(storedId);

      // Read paths that scan the primary table still see the item.
      const listed = await runJson(`--json list ${canonicalId}`);
      expect(listed.count).toBe(1);
      expect(listed.workItems[0].id).toBe(storedId);

      const searched = await runJson(`--json search ${canonicalId}`);
      expect(searched.count).toBe(1);
      expect(searched.workItems[0].id).toBe(storedId);

      const exportFile = path.join(state.tempDir, 'divergence-export.jsonl');
      const exported = await runJson(`--json export --file "${exportFile}"`);
      expect(exported.success).toBe(true);
      expect(fs.readFileSync(exportFile, 'utf-8')).toContain(storedId);

      // The strict exact-match path (`wl show --exact`) reproduces the
      // reported failure: "Work item not found" for an id `wl list` returns.
      const exact = await runExpectFailure(`--json show --exact ${canonicalId}`);
      expectNotFoundException(exact);

      // The tolerant `wl show` (WL-0MSOMI4GQ009WL8E) masks the divergence with
      // its unique-substring fallback; the item is still resolvable that way.
      const tolerant = await runJson(`--json show ${canonicalId}`);
      expect(tolerant.success).toBe(true);
      expect(tolerant.workItem.id).toBe(storedId);
    });

    it('reproduces the mutating-path failure: comment add / update cannot touch the visible item', async () => {
      const canonicalId = await createItem('Divergent mutating item');
      const storedId = demotePrimaryIdToNonCanonical(state.tempDir, canonicalId);

      // The item is still advertised by the read paths…
      expect((await runJson(`--json list ${canonicalId}`)).count).toBe(1);
      expect((await runJson(`--json search ${canonicalId}`)).count).toBe(1);

      // …but the mutating paths use the exact-match lookup and reject it.
      // NOTE (child WL-0MWABGAVN0082TLF): once the shared resolver lands, these
      // two assertions flip to "resolves (or surfaces an actionable divergence
      // error)". They are the reproduction witness for the reported deadlock.
      const comment = await runExpectFailure(
        `--json comment add ${canonicalId} --comment reproduction_comment --author tester`,
      );
      expectNotFoundException(comment);

      const update = await runExpectFailure(`--json update ${canonicalId} --status blocked`);
      expectNotFoundException(update);

      // The underlying root cause is the exact-match lookup, not the row's
      // presence: the stored (scan-visible) id still resolves via the read
      // paths above, and the primary row is intact.
      expect(readPrimaryIds(state.tempDir)).toContain(storedId);
    });
  });

  // ── Class 1 — a derived read path holds an item the primary cannot serve ─
  describe('class 1a: phantom FTS entry (FTS holds an id the primary dropped)', () => {
    it('records a divergence no user read path surfaces today, and rebuildFtsIndex clears it', async () => {
      // A primary store that already has a real item, so the empty-store
      // JSONL refresh never runs.
      await createItem('Primary anchor item');

      const phantomId = 'TEST-PHANTOMFTS0001';
      plantPhantomFtsEntry(state.tempDir, phantomId, { title: 'phantom searchable title' });

      // The derived path holds the id; the authoritative table does not.
      expect(readFtsIds(state.tempDir)).toContain(phantomId);
      expect(readPrimaryIds(state.tempDir)).not.toContain(phantomId);

      // Today the FTS query JOINs `workitems`, so the phantom is invisible to
      // `list`/`search`/`show`. That is precisely why an integrity check that
      // queries the FTS index directly is required (child WL-0MWABEV8100167Y5):
      expect((await runJson(`--json list ${phantomId}`)).count).toBe(0);
      expect((await runJson(`--json search ${phantomId}`)).count).toBe(0);
      expect((await runExpectFailure(`--json show ${phantomId}`)).failed).toBe(true);

      // The existing FTS rebuild (from the primary table) drops the phantom.
      // Rebuild with no query: with a query the command emits the rebuild JSON
      // and then the search JSON, which is not one parseable document.
      await runJson('--json search --rebuild-index');
      expect(readFtsIds(state.tempDir)).not.toContain(phantomId);

      // Idempotent: a second rebuild changes nothing.
      await runJson('--json search --rebuild-index');
      expect(readFtsIds(state.tempDir)).not.toContain(phantomId);
    });
  });

  describe('class 1b: FTS gap (primary holds an item the FTS index is missing)', () => {
    it('makes wl search silently omit an item wl list returns; rebuildFtsIndex restores agreement', async () => {
      const itemId = await createItem('QuokkaDivergence marker item');

      // Baseline: search and list agree.
      expect((await runJson('--json list QuokkaDivergence')).count).toBe(1);
      expect((await runJson('--json search QuokkaDivergence')).count).toBe(1);

      // Drop the FTS row only — the item stays in the primary table.
      dropFtsEntry(state.tempDir, itemId);
      expect(readPrimaryIds(state.tempDir)).toContain(itemId);
      expect(readFtsIds(state.tempDir)).not.toContain(itemId);

      // list (scan) finds it; search (FTS) silently returns nothing.
      expect((await runJson('--json list QuokkaDivergence')).count).toBe(1);
      const staleSearch = await runJson('--json search QuokkaDivergence');
      expect(staleSearch.count).toBe(0);
      // Never a silent "no results" masking an index defect is the repair
      // command's job (child WL-0MWABFI8Z004RFA0); the reproduction pins the
      // silent omission here.
      expect(staleSearch.workItems).toEqual([]);

      // The existing FTS rebuild re-indexes the item from the primary table.
      await runJson('--json search --rebuild-index');
      const repaired = await runJson('--json search QuokkaDivergence');
      expect(repaired.count).toBe(1);
      expect(repaired.workItems[0].id).toBe(itemId);
      expect(readFtsIds(state.tempDir)).toContain(itemId);

      // Idempotent: it stays repaired.
      await runJson('--json search --rebuild-index');
      expect((await runJson('--json search QuokkaDivergence')).count).toBe(1);
    });
  });

  describe('class 1c: authoritative JSONL snapshot holds an item the primary store lacks', () => {
    it('leaves the item absent from the store while the JSONL source still carries it', async () => {
      // Non-empty primary store: prevents the constructor's empty-store JSONL
      // refresh from importing the snapshot we are about to write.
      await createItem('Primary anchor for jsonl');

      const jsonlOnlyId = 'TEST-JSONLONLY0001';
      writeDivergenceJsonlSnapshot(state.tempDir, [
        makeDivergenceWorkItem({ id: jsonlOnlyId, title: 'jsonl-only recovery candidate' }),
      ]);

      // The authoritative source carries the item…
      expect(readDivergenceJsonl(state.tempDir)).toContain(jsonlOnlyId);
      // …the primary store does not, and the read paths miss it.
      expect(readPrimaryIds(state.tempDir)).not.toContain(jsonlOnlyId);
      expect((await runJson(`--json list ${jsonlOnlyId}`)).count).toBe(0);
      expect((await runExpectFailure(`--json show ${jsonlOnlyId}`)).failed).toBe(true);
    });
  });

  // ── Read-path agreement invariant (parent AC4 precursor) ─────────────────
  describe('read-path agreement invariant', () => {
    it('every id returned by wl list resolves through wl show', async () => {
      for (const title of ['Agreement alpha', 'Agreement beta', 'Agreement gamma']) {
        await createItem(title);
      }

      const listed = await runJson('--json list');
      expect(listed.count).toBeGreaterThanOrEqual(3);

      for (const item of listed.workItems as Array<{ id: string }>) {
        const shown = await runJson(`--json show ${item.id}`);
        expect(shown.success).toBe(true);
        expect(shown.workItem.id).toBe(item.id);
      }
    });
  });

  // ── Concurrency: fixtures + real multi-process writers ───────────────────
  describe('concurrent multi-process use', () => {
    it(
      'keeps a fixture-injected divergence and two concurrent real writers intact',
      async () => {
        const itemId = await createItem('Concurrent write target');

        // Inject the divergence under the store mutation lock (the same lock
        // `wl sync` / `wl update` / `wl comment add` hold).
        const phantomId = 'TEST-CONCURRENTPHANTOM01';
        plantPhantomFtsEntry(state.tempDir, phantomId, { title: 'concurrent phantom' });
        expect(readFtsIds(state.tempDir)).toContain(phantomId);

        // Two real CLI processes contend on the same per-store lock while the
        // divergent FTS row is present.
        const [update, comment] = await Promise.all([
          spawnCli(['--json', 'update', itemId, '--status', 'blocked'], state.tempDir),
          spawnCli(
            ['--json', 'comment', 'add', itemId, '--comment', 'concurrent write', '--author', 'tester'],
            state.tempDir,
          ),
        ]);
        expect(update.code).toBe(0);
        expect(comment.code).toBe(0);

        // Both writer effects landed…
        const shown = await runJson(`--json show ${itemId}`);
        expect(shown.workItem.status).toBe('blocked');
        expect(
          (shown.comments as Array<{ comment: string }>).some((c) => c.comment === 'concurrent write'),
        ).toBe(true);

        // …and the fixture-injected divergence was not clobbered by either
        // writer (no whole-store replace, no lost update).
        expect(readFtsIds(state.tempDir)).toContain(phantomId);
        expect(readPrimaryIds(state.tempDir)).toContain(itemId);
      },
      60_000,
    );
  });
});

/** Run the real CLI (pre-compiled bundle when available) as an async subprocess. */
function spawnCli(
  args: string[],
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const [executable, script] = cliInvocation();
  return new Promise((resolve) => {
    const child = spawn(executable, [script, ...args], {
      cwd,
      env: { ...process.env, WL_CACHE_DISABLED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf-8');
    child.stderr?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', () => resolve({ code: 1, stdout, stderr }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
