/**
 * Tests for --worklog-dir override support in resolveWorklogDir()
 *
 * Run: npx vitest run tests/unit/worklog-dir-override.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// resolveWorklogDir with --worklog-dir override
// ---------------------------------------------------------------------------

describe('resolveWorklogDir with worklogDir override', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wl-override-test-'));
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true }); } catch { /* ignore */ }
  });

  it('returns the override path when provided', async () => {
    // Need a fresh import to pick up mocked process.cwd etc.
    const mod = await import('../../src/worklog-paths.js');

    const overrideDir = join(tempDir, 'my-custom', '.worklog');
    mkdirSync(overrideDir, { recursive: true });
    writeFileSync(join(overrideDir, 'config.yaml'), 'projectName: test\nprefix: TEST\n');

    // Set the override
    mod.setWorklogDirOverride(overrideDir);

    expect(mod.resolveWorklogDir()).toBe(overrideDir);
  });

  it('returns the override even when CWD has a different .worklog/', async () => {
    const mod = await import('../../src/worklog-paths.js');

    // Create a .worklog/ in CWD (simulating a different project)
    const cwdWorklog = join(tempDir, 'cwd-project', '.worklog');
    mkdirSync(cwdWorklog, { recursive: true });
    writeFileSync(join(cwdWorklog, 'config.yaml'), 'projectName: cwd-project\nprefix: CWD\n');

    // Override points to a different .worklog/
    const overrideDir = join(tempDir, 'other-project', '.worklog');
    mkdirSync(overrideDir, { recursive: true });
    writeFileSync(join(overrideDir, 'config.yaml'), 'projectName: other-project\nprefix: OTHER\n');

    // Change CWD to the cwd-project directory
    const origCwd = process.cwd;
    process.cwd = () => join(tempDir, 'cwd-project');

    try {
      mod.setWorklogDirOverride(overrideDir);
      expect(mod.resolveWorklogDir()).toBe(overrideDir);
    } finally {
      mod.setWorklogDirOverride(undefined);
      process.cwd = origCwd;
    }
  });

  it('returns the override even when git repo root has a different .worklog/', async () => {
    const mod = await import('../../src/worklog-paths.js');

    const overrideDir = join(tempDir, 'explicit', '.worklog');
    mkdirSync(overrideDir, { recursive: true });
    writeFileSync(join(overrideDir, 'config.yaml'), 'projectName: explicit\nprefix: EXP\n');

    mod.setWorklogDirOverride(overrideDir);
    expect(mod.resolveWorklogDir()).toBe(overrideDir);
  });

  it('resets to standard resolution when override is cleared', async () => {
    const mod = await import('../../src/worklog-paths.js');

    // Set override
    const overrideDir = join(tempDir, 'other', '.worklog');
    mkdirSync(overrideDir, { recursive: true });
    writeFileSync(join(overrideDir, 'config.yaml'), 'projectName: other\nprefix: OTH\n');

    mod.setWorklogDirOverride(overrideDir);
    expect(mod.resolveWorklogDir()).toBe(overrideDir);

    // Clear override
    mod.setWorklogDirOverride(undefined);

    // Now should fall back to normal resolution (CWD has no .worklog/)
    // We need to know what it would resolve to normally
    const resolved = mod.resolveWorklogDir();
    expect(resolved).not.toBe(overrideDir);
    // Should be something under the current working directory or git root
    expect(resolved).toContain('.worklog');
  });

  it('returns the override as-is even if the directory does not exist', async () => {
    const mod = await import('../../src/worklog-paths.js');

    const nonExistentPath = '/tmp/nonexistent-worklog-dir';
    mod.setWorklogDirOverride(nonExistentPath);

    // Should return the path as given, letting downstream callers handle
    // any filesystem errors
    expect(mod.resolveWorklogDir()).toBe(nonExistentPath);
  });
});

// ---------------------------------------------------------------------------
// applyWorklogDirOverrideFromArgv — early --worklog-dir application
// (WL-0MSAH26DD001XXST: the override must be applied before ctx.dataPath is
// computed, otherwise -f/--file defaults resolve from the cwd repo)
// ---------------------------------------------------------------------------

describe('applyWorklogDirOverrideFromArgv', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wl-argv-override-'));
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true }); } catch { /* ignore */ }
  });

  it('applies --worklog-dir <path> from argv', async () => {
    const mod = await import('../../src/worklog-paths.js');
    try {
      const overrideDir = join(tempDir, 'proj', '.worklog');
      mod.applyWorklogDirOverrideFromArgv(['--worklog-dir', overrideDir, 'sync']);
      expect(mod.getWorklogDirOverride()).toBe(overrideDir);
      expect(mod.resolveWorklogDir()).toBe(overrideDir);
    } finally {
      mod.setWorklogDirOverride(undefined);
    }
  });

  it('applies --worklog-dir=<path> (equals form) from argv', async () => {
    const mod = await import('../../src/worklog-paths.js');
    try {
      const overrideDir = join(tempDir, 'proj', '.worklog');
      mod.applyWorklogDirOverrideFromArgv(['sync', `--worklog-dir=${overrideDir}`]);
      expect(mod.getWorklogDirOverride()).toBe(overrideDir);
    } finally {
      mod.setWorklogDirOverride(undefined);
    }
  });

  it('does not override when --worklog-dir is absent (and clears stale overrides)', async () => {
    const mod = await import('../../src/worklog-paths.js');
    try {
      // Simulate a stale override from a previous invocation (e.g. another
      // in-process run): the absence of --worklog-dir must clear it.
      mod.setWorklogDirOverride(join(tempDir, 'stale', '.worklog'));
      mod.applyWorklogDirOverrideFromArgv(['sync', '--dry-run']);
      expect(mod.getWorklogDirOverride()).toBeUndefined();
    } finally {
      mod.setWorklogDirOverride(undefined);
    }
  });

  it('does not override for a trailing --worklog-dir with no value', async () => {
    const mod = await import('../../src/worklog-paths.js');
    try {
      mod.setWorklogDirOverride(undefined);
      mod.applyWorklogDirOverrideFromArgv(['sync', '--worklog-dir']);
      expect(mod.getWorklogDirOverride()).toBeUndefined();
    } finally {
      mod.setWorklogDirOverride(undefined);
    }
  });

  it('dataPath resolution order: getDefaultDataPath reflects the override', async () => {
    const mod = await import('../../src/worklog-paths.js');
    const jsonl = await import('../../src/jsonl.js');
    try {
      const overrideDir = join(tempDir, 'proj', '.worklog');
      // This mirrors src/cli.ts: apply the override BEFORE createPluginContext
      // computes ctx.dataPath via getDefaultDataPath().
      mod.applyWorklogDirOverrideFromArgv(['--worklog-dir', overrideDir, 'sync']);
      expect(jsonl.getDefaultDataPath()).toBe(join(overrideDir, 'worklog-data.jsonl'));
    } finally {
      mod.setWorklogDirOverride(undefined);
    }
  });
});
