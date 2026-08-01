/**
 * Tests for `.pi` folder discovery — resolvePiDir() and the repo-root-aware
 * settings resolution used by loadSettings()/persistSettings().
 *
 * `.pi` discovery mirrors resolveWorklogDir(): it walks up from the current
 * directory to the git repo root, preferring the nearest directory that owns
 * a `.pi/settings.json` (a local settings file in cwd or a closer ancestor
 * overrides the repo root), and falls back to the repo root when no settings
 * file exists anywhere (so persistSettings() writes project-level config).
 *
 * These tests use real temp directories with `.git` markers; `git rev-parse
 * --show-toplevel` is served by the test-local mock git binary (see
 * tests/cli/mock-bin and tests/setup-tests.ts).
 *
 * Run: npx vitest run tests/unit/resolve-pi-dir.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Skip global (~/.pi/agent) settings: these tests exercise project-level
// `.pi/settings.json` resolution only.
vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => '',
}));

import { resolvePiDir } from '../../src/worklog-paths.js';
import {
  loadSettings,
  persistSettings,
  DEFAULT_SETTINGS,
} from '../../packages/tui/extensions/Worklog/settings-config.js';

/** Create a temp git repo (`.git` marker directory) and return its root. */
function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'wl-pi-dir-test-'));
  mkdirSync(join(root, '.git'), { recursive: true });
  return root;
}

/** Create `<dir>/.pi/settings.json` with a context-hub section. */
function makeSettingsFile(dir: string, overrides: Record<string, unknown> = {}): void {
  const piDir = join(dir, '.pi');
  mkdirSync(piDir, { recursive: true });
  writeFileSync(
    join(piDir, 'settings.json'),
    JSON.stringify({
      'context-hub': { browseItemCount: 9, showIcons: false, ...overrides },
    }),
  );
}

// ── resolvePiDir unit tests ───────────────────────────────────────────

describe('resolvePiDir', () => {
  let repoRoot: string;
  let subdir: string;

  beforeEach(() => {
    repoRoot = makeRepo();
    subdir = join(repoRoot, 'packages', 'herdr');
    mkdirSync(subdir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(repoRoot, { recursive: true }); } catch { /* ignore */ }
  });

  it('returns the repo root when it owns .pi/settings.json and no local settings exist', () => {
    makeSettingsFile(repoRoot);
    expect(resolvePiDir(subdir)).toBe(repoRoot);
  });

  it('prefers a local .pi/settings.json in the working directory over the repo root', () => {
    makeSettingsFile(repoRoot, { browseItemCount: 3 });
    makeSettingsFile(subdir, { browseItemCount: 7 });
    expect(resolvePiDir(subdir)).toBe(subdir);
  });

  it('returns the nearest ancestor that owns .pi/settings.json when walking up', () => {
    const nested = join(subdir, 'src', 'deep');
    mkdirSync(nested, { recursive: true });
    makeSettingsFile(repoRoot);
    makeSettingsFile(subdir, { browseItemCount: 12 });
    expect(resolvePiDir(nested)).toBe(subdir);
  });

  it('falls back to the repo root when no .pi/settings.json exists anywhere', () => {
    expect(resolvePiDir(subdir)).toBe(repoRoot);
  });

  it('skips an empty local .pi directory (no settings.json) and uses the repo root', () => {
    makeSettingsFile(repoRoot);
    mkdirSync(join(subdir, '.pi'), { recursive: true }); // empty .pi dir
    expect(resolvePiDir(subdir)).toBe(repoRoot);
  });

  it('returns the start directory unchanged when it owns .pi/settings.json', () => {
    makeSettingsFile(repoRoot);
    expect(resolvePiDir(repoRoot)).toBe(repoRoot);
  });

  it('returns the start directory when not inside a git repo', () => {
    const outside = mkdtempSync(join(tmpdir(), 'wl-pi-outside-'));
    try {
      expect(resolvePiDir(outside)).toBe(outside);
    } finally {
      rmSync(outside, { recursive: true });
    }
  });

  it('returns the start directory when the git repo root cannot be determined', () => {
    // Non-existent start directory: git invocation fails, getRepoRoot() → null.
    expect(resolvePiDir('/nonexistent/wl-pi-dir-fake')).toBe('/nonexistent/wl-pi-dir-fake');
  });
});

// ── loadSettings integration ──────────────────────────────────────────

describe('loadSettings with repo-root-aware .pi discovery', () => {
  let repoRoot: string;
  let subdir: string;

  beforeEach(() => {
    repoRoot = makeRepo();
    subdir = join(repoRoot, 'packages', 'herdr');
    mkdirSync(subdir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(repoRoot, { recursive: true }); } catch { /* ignore */ }
  });

  it('loads settings from the repo root .pi/settings.json when running from a subdirectory', () => {
    makeSettingsFile(repoRoot, { browseItemCount: 21 });
    const settings = loadSettings(subdir);
    expect(settings.browseItemCount).toBe(21);
    expect(settings.showIcons).toBe(false);
  });

  it('prefers local .pi/settings.json in the working directory over the repo root', () => {
    makeSettingsFile(repoRoot, { browseItemCount: 21 });
    makeSettingsFile(subdir, { browseItemCount: 33 });
    const settings = loadSettings(subdir);
    expect(settings.browseItemCount).toBe(33);
  });

  it('returns defaults when no settings file exists anywhere', () => {
    expect(loadSettings(subdir)).toEqual(DEFAULT_SETTINGS);
  });

  it('behaves unchanged when running from the repo root', () => {
    makeSettingsFile(repoRoot, { browseItemCount: 42 });
    const settings = loadSettings(repoRoot);
    expect(settings.browseItemCount).toBe(42);
  });

  it('still resolves when invoked without an explicit cwd (process.cwd())', () => {
    // When no cwd is passed, resolution starts at process.cwd(). In the test
    // environment process.cwd() is the repository checkout, which owns a
    // .pi/settings.json — the result must be a directory, not throw.
    const resolved = loadSettings();
    expect(resolved.browseItemCount).toBeGreaterThanOrEqual(1);
  });
});

// ── persistSettings integration ───────────────────────────────────────

describe('persistSettings with repo-root-aware .pi discovery', () => {
  let repoRoot: string;
  let subdir: string;

  beforeEach(() => {
    repoRoot = makeRepo();
    subdir = join(repoRoot, 'packages', 'herdr');
    mkdirSync(subdir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(repoRoot, { recursive: true }); } catch { /* ignore */ }
  });

  it('writes to the repo root .pi/settings.json when running from a subdirectory without local settings', () => {
    makeSettingsFile(repoRoot);
    persistSettings({ showHelpText: false }, subdir);

    const written = JSON.parse(readFileSync(join(repoRoot, '.pi', 'settings.json'), 'utf-8'));
    expect(written['context-hub'].showHelpText).toBe(false);
    // Existing values are preserved
    expect(written['context-hub'].browseItemCount).toBe(9);
    // Nothing is written to the local subdirectory
    expect(existsSync(join(subdir, '.pi', 'settings.json'))).toBe(false);
  });

  it('creates .pi/settings.json at the repo root when none exists anywhere', () => {
    persistSettings({ browseItemCount: 6 }, subdir);

    const written = JSON.parse(readFileSync(join(repoRoot, '.pi', 'settings.json'), 'utf-8'));
    expect(written['context-hub'].browseItemCount).toBe(6);
    expect(existsSync(join(subdir, '.pi', 'settings.json'))).toBe(false);
  });

  it('writes to the local .pi/settings.json when one exists in the working directory', () => {
    makeSettingsFile(repoRoot);
    makeSettingsFile(subdir);
    persistSettings({ browseItemCount: 50 }, subdir);

    const local = JSON.parse(readFileSync(join(subdir, '.pi', 'settings.json'), 'utf-8'));
    expect(local['context-hub'].browseItemCount).toBe(50);

    // The repo root settings file is untouched
    const root = JSON.parse(readFileSync(join(repoRoot, '.pi', 'settings.json'), 'utf-8'));
    expect(root['context-hub'].browseItemCount).toBe(9);
  });
});
