/**
 * Tests for `.pi` folder discovery — resolvePiDir().
 *
 * `.pi` discovery walks up from the current directory to the git repo root,
 * preferring the nearest directory that owns a `.pi/settings.json` (a local
 * settings file in cwd or a closer ancestor overrides the repo root), and
 * falls back to the repo root when no settings file exists anywhere.
 *
 * These tests use real temp directories with `.git` markers; `git rev-parse
 * --show-toplevel` is served by the test-local mock git binary (see
 * tests/cli/mock-bin and tests/setup-tests.ts).
 *
 * Run: npx vitest run tests/unit/resolve-pi-dir.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Skip global (~/.pi/agent) settings: these tests exercise project-level
// `.pi/settings.json` resolution only.
vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => '',
}));

import { resolvePiDir } from '../../src/worklog-paths.js';

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
