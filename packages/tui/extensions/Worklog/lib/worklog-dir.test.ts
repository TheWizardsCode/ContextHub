/**
 * Unit tests for lib/worklog-dir.ts — cross-project worklog-dir resolution
 * for the Worklog Pi extension (WL-0MVGB23MM004X501).
 *
 * The extension footer resolves work item titles via `wl show <id>`; when
 * the ID lives in a *sibling project's* worklog (its prefix is declared in
 * another project's `.worklog/config.yaml`), a plain cwd-based lookup fails
 * and the title silently disappears. `lib/worklog-dir.ts` mirrors the skills
 * layer's prefix-to-sibling scan (`skill/shared/status_lifecycle.py`
 * `_find_worklog_dir_by_prefix`) so the extension can pass `--worklog-dir`
 * explicitly.
 *
 * Covered:
 * - Prefix extraction (`<PREFIX>-<HASH>`).
 * - config.yaml `prefix:` parsing (bare / quoted / comment / missing).
 * - Sibling scan: hit, miss, missing scan root, uninitialized worklog
 *   filter, deterministic order, malformed/unreadable config skip.
 * - Memoisation of the prefix→dirs mapping for the process lifetime (AC6).
 * - `SIBLING_SCAN_ROOT` derivation and `WORKLOG_SIBLING_SCAN_ROOT` override.
 *
 * Run: npx vitest run packages/tui/extensions/Worklog/lib/worklog-dir.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  extractWorkItemPrefix,
  readConfigPrefix,
  findWorklogDirsByPrefix,
  getSiblingScanRoot,
  deriveSiblingScanRoot,
  resetWorklogDirCache,
} from './worklog-dir.js';

// ── Fixture helpers ────────────────────────────────────────────────────

let scanRoot: string;

/** Create a temp scan root with a `prefix:`-declaring sibling project. */
function makeScanRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wl-worklog-dir-test-'));
}

/**
 * Create `<scanRoot>/<name>/.worklog/config.yaml` (and a worklog.db marker
 * so the project counts as initialised). Returns the `.worklog` dir.
 */
function makeProject(
  root: string,
  name: string,
  prefixValue: string | null,
  opts: { initialized?: boolean } = {},
): string {
  const proj = path.join(root, name);
  const worklogDir = path.join(proj, '.worklog');
  fs.mkdirSync(worklogDir, { recursive: true });
  if (opts.initialized !== false) {
    fs.writeFileSync(path.join(worklogDir, 'worklog.db'), '');
  }
  if (prefixValue !== null) {
    fs.writeFileSync(
      path.join(worklogDir, 'config.yaml'),
      `# worklog config\nprefix: ${prefixValue}\n`,
    );
  }
  return worklogDir;
}

beforeEach(() => {
  scanRoot = makeScanRoot();
});

afterEach(() => {
  resetWorklogDirCache();
  fs.rmSync(scanRoot, { recursive: true, force: true });
  delete process.env.WORKLOG_SIBLING_SCAN_ROOT;
});

// ── extractWorkItemPrefix ──────────────────────────────────────────────

describe('extractWorkItemPrefix', () => {
  it('extracts a 2-5 letter uppercase prefix from a full ID', () => {
    expect(extractWorkItemPrefix('WL-0MQL0T5TR0060AEH')).toBe('WL');
    // 4-letter prefixes are real (RISE/GOLF/FEUD) — the original footer regex
    // only accepted 2-3 letters, which is why RISE items never resolved.
    expect(extractWorkItemPrefix('RISE-0MVCFSM9B0019M8L')).toBe('RISE');
    expect(extractWorkItemPrefix('GOLF-0MVCFSM9B0019M8L')).toBe('GOLF');
    expect(extractWorkItemPrefix('POD-0MVCFSM9B0019M8L')).toBe('POD');
  });

  it('returns null for text that is not a full work item ID', () => {
    expect(extractWorkItemPrefix('')).toBeNull();
    expect(extractWorkItemPrefix('WL-123')).toBeNull();      // too short hash
    expect(extractWorkItemPrefix('W-0MVCFSM9B0019M8L')).toBeNull();   // 1-letter prefix
    expect(extractWorkItemPrefix('WLDEXX-0MVCFSM9B0019M8L')).toBeNull(); // 6-letter prefix
    expect(extractWorkItemPrefix('wl-0MVCFSM9B0019M8L')).toBeNull();   // lowercase
    expect(extractWorkItemPrefix('prefix WL-0MVCFSM9B0019M8L suffix')).toBeNull();
  });
});

// ── readConfigPrefix ───────────────────────────────────────────────────

describe('readConfigPrefix', () => {
  it('parses a bare prefix value', () => {
    const cfg = path.join(scanRoot, 'config.yaml');
    fs.writeFileSync(cfg, '# comment\nprefix: RISE\nother: value\n');
    expect(readConfigPrefix(cfg)).toBe('RISE');
  });

  it('parses a quoted prefix value', () => {
    const cfg = path.join(scanRoot, 'config.yaml');
    fs.writeFileSync(cfg, 'prefix: "OSL"\n');
    expect(readConfigPrefix(cfg)).toBe('OSL');
  });

  it('returns null when no prefix key exists', () => {
    const cfg = path.join(scanRoot, 'config.yaml');
    fs.writeFileSync(cfg, 'other: value\n');
    expect(readConfigPrefix(cfg)).toBeNull();
  });

  it('returns null for an unreadable config', () => {
    expect(readConfigPrefix(path.join(scanRoot, 'missing', 'config.yaml'))).toBeNull();
  });
});

// ── findWorklogDirsByPrefix ────────────────────────────────────────────

describe('findWorklogDirsByPrefix', () => {
  it('returns the .worklog dir of the sibling declaring the prefix', () => {
    const wlDir = makeProject(scanRoot, 'tce-the-rising', 'RISE');
    makeProject(scanRoot, 'contexthub', 'WL');

    expect(findWorklogDirsByPrefix('RISE', scanRoot)).toEqual([wlDir]);
  });

  it('returns an empty list for an unknown prefix', () => {
    makeProject(scanRoot, 'contexthub', 'WL');
    expect(findWorklogDirsByPrefix('NOPE', scanRoot)).toEqual([]);
  });

  it('returns an empty list when the scan root does not exist', () => {
    expect(findWorklogDirsByPrefix('WL', path.join(scanRoot, 'no-such-root'))).toEqual([]);
  });

  it('returns an empty list when the scan root is not a directory', () => {
    const file = path.join(scanRoot, 'a-file');
    fs.writeFileSync(file, 'x');
    expect(findWorklogDirsByPrefix('WL', file)).toEqual([]);
  });

  it('filters out projects with an uninitialised worklog (no db / marker)', () => {
    makeProject(scanRoot, 'uninit', 'WL', { initialized: false });
    makeProject(scanRoot, 'init', 'WL');
    const dirs = findWorklogDirsByPrefix('WL', scanRoot);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toContain('init');
  });

  it('skips malformed configs without aborting the scan', () => {
    // A project whose config.yaml is unreadable (directory instead of file)
    // must be skipped, not thrown on.
    const proj = path.join(scanRoot, 'broken');
    fs.mkdirSync(path.join(proj, '.worklog', 'config.yaml'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.worklog', 'worklog.db'), '');
    makeProject(scanRoot, 'good', 'WL');

    expect(findWorklogDirsByPrefix('WL', scanRoot)).toHaveLength(1);
  });

  it('returns dirs in deterministic sorted order for an ambiguous prefix', () => {
    const a = makeProject(scanRoot, 'podcast-alpha', 'POD');
    const b = makeProject(scanRoot, 'podcast-beta', 'POD');
    const dirs = findWorklogDirsByPrefix('POD', scanRoot);
    expect(dirs).toEqual([a, b].sort((x, y) => x.localeCompare(y)));
    expect(dirs).toHaveLength(2);
  });

  it('memoises the prefix→dirs mapping for the process lifetime (AC6)', () => {
    const wlDir = makeProject(scanRoot, 'tce-the-rising', 'RISE');
    expect(findWorklogDirsByPrefix('RISE', scanRoot)).toEqual([wlDir]);

    // Delete the project on disk, add a new one with the same scan root:
    // the memoised result must be returned without re-scanning.
    fs.rmSync(path.dirname(wlDir), { recursive: true, force: true });
    expect(findWorklogDirsByPrefix('RISE', scanRoot)).toEqual([wlDir]);

    // After an explicit cache reset a re-scan reflects the filesystem.
    resetWorklogDirCache();
    expect(findWorklogDirsByPrefix('RISE', scanRoot)).toEqual([]);
  });
});

// ── SIBLING_SCAN_ROOT derivation ───────────────────────────────────────

describe('getSiblingScanRoot', () => {
  it('honours the WORKLOG_SIBLING_SCAN_ROOT override', () => {
    process.env.WORKLOG_SIBLING_SCAN_ROOT = scanRoot;
    expect(getSiblingScanRoot()).toBe(scanRoot);
    delete process.env.WORKLOG_SIBLING_SCAN_ROOT;
  });

  it('derives an absolute path from the extension install location', () => {
    const root = deriveSiblingScanRoot();
    expect(root).not.toBeNull();
    expect(path.isAbsolute(root as string)).toBe(true);
    expect(fs.existsSync(root as string)).toBe(true);
  });
});
