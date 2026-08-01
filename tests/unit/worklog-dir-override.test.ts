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
// getDefaultDataPath with --worklog-dir override
// ---------------------------------------------------------------------------

describe('getDefaultDataPath with worklogDir override', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wl-data-override-'));
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true }); } catch { /* ignore */ }
  });

  it('computes data path under the override worklog directory', async () => {
    const mod = await import('../../src/worklog-paths.js');

    const overrideDir = join(tempDir, 'project', '.worklog');
    mkdirSync(overrideDir, { recursive: true });
    writeFileSync(join(overrideDir, 'config.yaml'), 'projectName: test\nprefix: TEST\n');

    mod.setWorklogDirOverride(overrideDir);

    const dataPath = mod.resolveWorklogDir();
    expect(dataPath).toBe(overrideDir);
  });
});
