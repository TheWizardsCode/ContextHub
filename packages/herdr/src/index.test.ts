/**
 * Unit tests for stripCommandPrefix and findWorklogRoot in index.ts
 *
 * Run: npx vitest run packages/herdr/src/index.test.ts
 */

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { stripCommandPrefix, routeCommand, stripAgentPromptPrefix } from './index.js';
import {
  fetchItemsByStage,
  resetExecFileAsync,
  resetWorklogDir,
  setExecFileAsync,
} from './fetcher.js';

// ---------------------------------------------------------------------------
// stripCommandPrefix tests
// ---------------------------------------------------------------------------

describe('stripCommandPrefix', () => {
  describe('double-bang prefix (!!)', () => {
    it('strips !! from commands starting with !!', () => {
      expect(stripCommandPrefix('!!wl update <id> --priority high')).toBe(
        'wl update <id> --priority high',
      );
    });

    it('strips !! from multi-command sequences', () => {
      expect(
        stripCommandPrefix(
          '!!wl reviewed <id> false && wl audit-set <id> --ready-to-close yes',
        ),
      ).toBe(
        'wl reviewed <id> false && wl audit-set <id> --ready-to-close yes',
      );
    });

    it('strips !! from search command', () => {
      expect(stripCommandPrefix('!!wl search ')).toBe('wl search ');
    });
  });

  describe('single-bang prefix (!)', () => {
    it('strips ! from commands starting with single !', () => {
      expect(stripCommandPrefix('!some shell command')).toBe('some shell command');
    });

    it('leaves !! commands unaffected by the single-bang rule', () => {
      expect(stripCommandPrefix('!!double-bang')).toBe('double-bang');
    });
  });

  describe('no prefix', () => {
    it('leaves agent commands unchanged (/skill:*)', () => {
      expect(stripCommandPrefix('/skill:implement <id>')).toBe(
        '/skill:implement <id>',
      );
    });

    it('leaves agent commands unchanged (/intake)', () => {
      expect(stripCommandPrefix('/intake')).toBe('/intake');
    });

    it('leaves agent commands unchanged (/plan)', () => {
      expect(stripCommandPrefix('/plan <id>')).toBe('/plan <id>');
    });

    it('leaves /prompt: commands unchanged', () => {
      expect(stripCommandPrefix('/prompt:Review this code')).toBe(
        '/prompt:Review this code',
      );
    });

    it('leaves /wl filter commands unchanged', () => {
      expect(stripCommandPrefix('/wl idea')).toBe('/wl idea');
      expect(stripCommandPrefix('/wl review')).toBe('/wl review');
    });

    it('leaves plain commands without bang unchanged', () => {
      expect(stripCommandPrefix('echo hello')).toBe('echo hello');
    });

    it('leaves empty string unchanged', () => {
      expect(stripCommandPrefix('')).toBe('');
    });
  });

  describe('edge cases', () => {
    it('strips !! from !!wl close <id>', () => {
      expect(stripCommandPrefix('!!wl close <id>')).toBe('wl close <id>');
    });

    it('strips !! from !!wl delete <id>', () => {
      expect(stripCommandPrefix('!!wl delete <id>').trim()).toBe('wl delete <id>');
    });

    it('strips !! from !!wl update <id> --status <status> --stage <stage>', () => {
      expect(stripCommandPrefix('!!wl update <id> --status <status> --stage <stage> ')).toBe(
        'wl update <id> --status <status> --stage <stage> ',
      );
      expect(stripCommandPrefix('!!wl update <id> --status <status> --stage <stage>')).toBe(
        'wl update <id> --status <status> --stage <stage>',
      );
    });

    it('strips !! from !!wl update <id> --title ', () => {
      expect(stripCommandPrefix('!!wl update <id> --title ')).toBe(
        'wl update <id> --title ',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// shortcuts.json routing tests
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

interface ShortcutEntry {
  chord: string[];
  command: string;
  view: string;
  label?: string;
}

function loadShortcutsJson(): ShortcutEntry[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(join(here, 'shortcuts.json'), 'utf8');
  return JSON.parse(raw) as ShortcutEntry[];
}

describe('shortcuts.json command routing', () => {
  const entries = loadShortcutsJson();

  it('routes the a-y audit-approve command to the visible pane (bug fix)', () => {
    const entry = entries.find((e) => e.chord.join(',') === 'a,y');
    expect(entry).toBeDefined();
    expect(entry!.command.startsWith('!!')).toBe(true);
    expect(routeCommand(entry!.command)).toBe('pane');
  });

  it('routes all shell-executed wl commands (!! prefix) to the visible pane', () => {
    const shellEntries = entries.filter((e) => e.command.startsWith('!!'));
    expect(shellEntries.length).toBeGreaterThan(0);
    for (const e of shellEntries) {
      expect(routeCommand(e.command)).toBe('pane');
    }
  });

  it('routes agent commands (/skill:, /intake, /plan) to the agent pane', () => {
    const agentEntries = entries.filter((e) =>
      /^\/skill:|^\/intake|^\/plan/.test(e.command),
    );
    expect(agentEntries.length).toBeGreaterThan(0);
    for (const e of agentEntries) {
      expect(routeCommand(e.command)).toBe('agent');
    }
  });

  it('routes /prompt: entries to the agent pane', () => {
    const promptEntries = entries.filter((e) => e.command.startsWith('/prompt:'));
    expect(promptEntries.length).toBeGreaterThan(0);
    for (const e of promptEntries) {
      expect(routeCommand(e.command)).toBe('agent');
    }
  });

  it('uses a free chord for /prompt: entries (no collision with existing chords)', () => {
    const promptEntries = entries.filter((e) => e.command.startsWith('/prompt:'));
    expect(promptEntries.length).toBeGreaterThan(0);
    const usedChords = new Set(
      entries
        .filter((e) => !e.command.startsWith('/prompt:'))
        .map((e) => e.chord.join(' ')),
    );
    for (const e of promptEntries) {
      expect(usedChords.has(e.chord.join(' '))).toBe(false);
      expect(e.view).toBe('both');
      expect(e.label).toBeTruthy();
    }
  });

  it('keeps /wl stage-filter commands unprefixed', () => {
    const filterEntries = entries.filter((e) => e.command.startsWith('/wl '));
    expect(filterEntries.length).toBeGreaterThan(0);
    for (const e of filterEntries) {
      expect(e.command.startsWith('!!')).toBe(false);
    }
  });
});


describe('routeCommand', () => {
  describe('agent commands', () => {
    it('routes /skill: commands to the agent pane', () => {
      expect(routeCommand('/skill:implement <id>')).toBe('agent');
      expect(routeCommand('/skill:audit <id>')).toBe('agent');
    });

    it('routes /intake and /plan commands to the agent pane', () => {
      expect(routeCommand('/intake')).toBe('agent');
      expect(routeCommand('/intake <id>')).toBe('agent');
      expect(routeCommand('/plan <id>')).toBe('agent');
    });

    it('routes /prompt: commands to the agent pane', () => {
      expect(routeCommand('/prompt:Some prompt text')).toBe('agent');
      expect(routeCommand('/prompt:Review the current work item')).toBe('agent');
      expect(routeCommand('/prompt:')).toBe('agent');
    });
  });

  describe('!! / ! prefixed commands', () => {
    it('routes !!-prefixed wl commands to the visible pane', () => {
      expect(
        routeCommand(
          '!!wl reviewed <id> false && wl audit-set <id> --ready-to-close yes --summary \'Approved by manual review\'',
        ),
      ).toBe('pane');
    });

    it('routes !!-prefixed single commands to the visible pane', () => {
      expect(routeCommand('!!wl update <id> --priority high')).toBe('pane');
      expect(routeCommand('!!wl close <id>')).toBe('pane');
      expect(routeCommand('!!wl delete <id>')).toBe('pane');
    });

    it('routes single-! prefixed commands to the visible pane', () => {
      expect(routeCommand('!wl update <id> --title ')).toBe('pane');
    });
  });

  describe('unprefixed commands', () => {
    it('routes unprefixed commands to stdout (CMD:)', () => {
      expect(
        routeCommand(
          'wl reviewed <id> && wl comment add <id> --body \'<producer_comment>\'',
        ),
      ).toBe('stdout');
      expect(routeCommand('wl search ')).toBe('stdout');
      expect(routeCommand('/wl idea')).toBe('stdout');
    });
  });
});

// ---------------------------------------------------------------------------
// stripAgentPromptPrefix tests
// ---------------------------------------------------------------------------

describe('stripAgentPromptPrefix', () => {
  it('strips the /prompt: prefix, leaving the prompt text', () => {
    expect(stripAgentPromptPrefix('/prompt:Review the current work item')).toBe(
      'Review the current work item',
    );
  });

  it('strips /prompt: leaving an empty string when nothing follows', () => {
    expect(stripAgentPromptPrefix('/prompt:')).toBe('');
  });

  it('leaves non-/prompt: commands unchanged', () => {
    expect(stripAgentPromptPrefix('/skill:implement <id>')).toBe(
      '/skill:implement <id>',
    );
    expect(stripAgentPromptPrefix('/intake <id>')).toBe('/intake <id>');
    expect(stripAgentPromptPrefix('/plan <id>')).toBe('/plan <id>');
    expect(stripAgentPromptPrefix('!!wl close <id>')).toBe('!!wl close <id>');
  });
});

// ---------------------------------------------------------------------------
// findWorklogRoot integration tests
// Use real temp directories to avoid vi.mock hoisting issues with node:fs.
// Each test imports the module via dynamic import to get a fresh reference.
// ---------------------------------------------------------------------------

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const tempDirs: string[] = [];

/**
 * Create a temp directory for testing. Automatically cleaned up.
 */
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wlroot-test-'));
  tempDirs.push(dir);
  return dir;
}

describe('findWorklogRoot', () => {
  let originalCwd: () => string;

  beforeAll(() => {
    originalCwd = process.cwd;
  });

  afterEach(() => {
    process.cwd = originalCwd;
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    }
    tempDirs.length = 0;
  });

  describe('CWD has a valid .worklog/', () => {
    it('returns CWD when .worklog/ contains worklog.db', async () => {
      const { findWorklogRoot } = await import('./index.js');
      const root = makeTempDir();
      mkdirSync(join(root, '.worklog'));
      writeFileSync(join(root, '.worklog', 'worklog.db'), '');
      vi.spyOn(process, 'cwd').mockReturnValue(root);

      expect(findWorklogRoot()).toBe(root);
    });

    it('returns CWD when .worklog/ contains initialized marker', async () => {
      const { findWorklogRoot } = await import('./index.js');
      const root = makeTempDir();
      mkdirSync(join(root, '.worklog'));
      writeFileSync(join(root, '.worklog', 'initialized'), '');
      vi.spyOn(process, 'cwd').mockReturnValue(root);

      expect(findWorklogRoot()).toBe(root);
    });
  });

  describe('CWD has no valid .worklog/ and not in worktree', () => {
    it('returns undefined when CWD has no .worklog/ at all', async () => {
      const { findWorklogRoot } = await import('./index.js');
      const root = makeTempDir();
      vi.spyOn(process, 'cwd').mockReturnValue(root);

      expect(findWorklogRoot()).toBeUndefined();
    });

    it('returns undefined when .worklog/ exists but is invalid (no markers)', async () => {
      const { findWorklogRoot } = await import('./index.js');
      const root = makeTempDir();
      mkdirSync(join(root, '.worklog')); // Empty - no worklog.db or initialized
      vi.spyOn(process, 'cwd').mockReturnValue(root);

      expect(findWorklogRoot()).toBeUndefined();
    });

    it('does NOT walk up to parent directories when CWD has no .worklog/', async () => {
      const { findWorklogRoot } = await import('./index.js');
      const base = makeTempDir();
      // Create ContextHub-like .worklog/ at a parent level (sibling)
      const contextHubRoot = join(base, 'context-hub');
      mkdirSync(join(contextHubRoot, '.worklog'), { recursive: true });
      writeFileSync(join(contextHubRoot, '.worklog', 'worklog.db'), '');

      // CWD is a separate directory at the same level, no .worklog/
      const cwd = join(base, 'unrelated-dir');
      mkdirSync(cwd, { recursive: true });
      vi.spyOn(process, 'cwd').mockReturnValue(cwd);

      // Should NOT find ContextHub's .worklog/ by walking up
      expect(findWorklogRoot()).toBeUndefined();
    });

    it('walks up to parent when it has valid .worklog/', async () => {
      const { findWorklogRoot } = await import('./index.js');
      const base = makeTempDir();
      // Create a parent dir with valid .worklog/
      mkdirSync(join(base, '.worklog'), { recursive: true });
      writeFileSync(join(base, '.worklog', 'worklog.db'), '');

      // CWD is a subdirectory with no .worklog/
      const cwd = join(base, 'subdir');
      mkdirSync(cwd, { recursive: true });
      vi.spyOn(process, 'cwd').mockReturnValue(cwd);

      // Should find the parent's .worklog/ by walking up
      expect(findWorklogRoot()).toBe(base);
    });
  });

  describe('Inside a worktree (.worklog/worktrees/ in path)', () => {
    it('walks up from worktree directory to find project root .worklog/', async () => {
      const { findWorklogRoot } = await import('./index.js');
      const base = makeTempDir();
      const projectRoot = join(base, 'context-hub');

      // Create a valid .worklog/ at the project root
      mkdirSync(join(projectRoot, '.worklog'), { recursive: true });
      writeFileSync(join(projectRoot, '.worklog', 'worklog.db'), '');

      // Create a worktree deep inside the project
      const worktreeDir = join(projectRoot, '.worklog', 'worktrees', 'wl-XYZ-feature', 'src');
      mkdirSync(worktreeDir, { recursive: true });

      vi.spyOn(process, 'cwd').mockReturnValue(worktreeDir);

      expect(findWorklogRoot()).toBe(projectRoot);
    });

    it('skips past invalid .worklog/ inside worktree to find project root', async () => {
      const { findWorklogRoot } = await import('./index.js');
      const base = makeTempDir();
      const projectRoot = join(base, 'context-hub');

      // Create a valid .worklog/ at the project root
      mkdirSync(join(projectRoot, '.worklog'), { recursive: true });
      writeFileSync(join(projectRoot, '.worklog', 'worklog.db'), '');

      // Create a worktree with an invalid .worklog/ (empty dir)
      const worktreeDir = join(projectRoot, '.worklog', 'worktrees', 'wl-XYZ-feature');
      mkdirSync(worktreeDir, { recursive: true });
      mkdirSync(join(worktreeDir, '.worklog')); // No worklog.db, no initialized

      vi.spyOn(process, 'cwd').mockReturnValue(worktreeDir);

      expect(findWorklogRoot()).toBe(projectRoot);
    });

    it('returns undefined when no project root .worklog/ found above worktree', async () => {
      const { findWorklogRoot } = await import('./index.js');
      const base = makeTempDir();

      // Create a worktree but NO valid .worklog/ at the project root
      const worktreeDir = join(base, 'project', '.worklog', 'worktrees', 'wl-XYZ-feature');
      mkdirSync(worktreeDir, { recursive: true });

      vi.spyOn(process, 'cwd').mockReturnValue(worktreeDir);

      expect(findWorklogRoot()).toBeUndefined();
    });

    it('walks up from deeply nested worktree path', async () => {
      const { findWorklogRoot } = await import('./index.js');
      const base = makeTempDir();
      const projectRoot = join(base, 'context-hub');

      // Create a valid .worklog/ at the project root
      mkdirSync(join(projectRoot, '.worklog'), { recursive: true });
      writeFileSync(join(projectRoot, '.worklog', 'worklog.db'), '');

      // Deeply nested worktree path
      const worktreeDir = join(
        projectRoot, '.worklog', 'worktrees', 'wl-XYZ-feature',
        'packages', 'herdr', 'src',
      );
      mkdirSync(worktreeDir, { recursive: true });

      vi.spyOn(process, 'cwd').mockReturnValue(worktreeDir);

      expect(findWorklogRoot()).toBe(projectRoot);
    });
  });

  describe('Edge cases', () => {
    it('stops at filesystem root without infinite loop', async () => {
      const { findWorklogRoot } = await import('./index.js');
      vi.spyOn(process, 'cwd').mockReturnValue('/');
      expect(findWorklogRoot()).toBeUndefined();
    });

    it('prefers CWD .worklog/ over worktree walking', async () => {
      const { findWorklogRoot } = await import('./index.js');
      const base = makeTempDir();
      const projectRoot = join(base, 'context-hub');

      // Create valid .worklog/ at project root
      mkdirSync(join(projectRoot, '.worklog'), { recursive: true });
      writeFileSync(join(projectRoot, '.worklog', 'worklog.db'), '');

      // Create worktree with its OWN valid .worklog/
      const worktreeDir = join(projectRoot, '.worklog', 'worktrees', 'wl-XYZ-feature');
      mkdirSync(join(worktreeDir, '.worklog'), { recursive: true });
      writeFileSync(join(worktreeDir, '.worklog', 'worklog.db'), '');

      vi.spyOn(process, 'cwd').mockReturnValue(worktreeDir);

      expect(findWorklogRoot()).toBe(worktreeDir);
    });

    it('walks past a leftover .worklog/worktrees container stub to find the real project worklog', async () => {
      // Regression: a stray `.worklog/worktrees/` container (created by the
      // implement tool's worktree lifecycle, e.g. inside packages/herdr)
      // must not block upward resolution to the real project root.
      const { findWorklogRoot } = await import('./index.js');
      const base = makeTempDir();
      const projectRoot = join(base, 'context-hub');

      // Real, valid .worklog/ at the project root
      mkdirSync(join(projectRoot, '.worklog'), { recursive: true });
      writeFileSync(join(projectRoot, '.worklog', 'worklog.db'), '');

      // CWD is a plugin dir that contains a leftover worktree container
      // (empty .worklog/worktrees/, no config.yaml / initialized / worklog.db)
      const cwd = join(projectRoot, 'packages', 'herdr');
      mkdirSync(join(cwd, '.worklog', 'worktrees'), { recursive: true });

      vi.spyOn(process, 'cwd').mockReturnValue(cwd);

      expect(findWorklogRoot()).toBe(projectRoot);
    });
  });
});

// ---------------------------------------------------------------------------
// configureWorklogTarget tests
//
// AC4: the plugin must pass the resolved worklog root to child `wl` processes
// via --worklog-dir instead of process.chdir(). configureWorklogTarget() is
// the integration seam: it resolves the project root and configures the
// fetcher so every runWl() call prepends --worklog-dir <root>/.worklog.
// ---------------------------------------------------------------------------

describe('configureWorklogTarget', () => {
  let originalCwd: () => string;

  beforeAll(() => {
    originalCwd = process.cwd;
  });

  afterEach(() => {
    resetWorklogDir();
    resetExecFileAsync();
    process.env.HERDR_RESOLVED_CWD = '';
    process.cwd = originalCwd;
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    }
    tempDirs.length = 0;
  });

  it('resolves the root and configures the fetcher with <root>/.worklog', async () => {
    const { configureWorklogTarget } = await import('./index.js');
    const root = makeTempDir();
    mkdirSync(join(root, '.worklog'));
    writeFileSync(join(root, '.worklog', 'worklog.db'), '');
    resetWorklogDir();

    const resolved = configureWorklogTarget(root);
    expect(resolved).toBe(root);

    // The fetcher must now pass --worklog-dir <root>/.worklog to wl.
    const mockFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ results: [] }),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);
    await fetchItemsByStage('plan_complete');

    const callArgs = mockFn.mock.calls[0][1] as string[];
    expect(callArgs).toContain('--worklog-dir');
    expect(callArgs[callArgs.indexOf('--worklog-dir') + 1]).toBe(join(root, '.worklog'));
  });

  it('returns undefined and leaves the fetcher unconfigured when no valid .worklog exists', async () => {
    const { configureWorklogTarget } = await import('./index.js');
    const root = makeTempDir();
    resetWorklogDir();

    const resolved = configureWorklogTarget(root);
    expect(resolved).toBeUndefined();

    const mockFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ results: [] }),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);
    await fetchItemsByStage('plan_complete');

    const callArgs = mockFn.mock.calls[0][1] as string[];
    expect(callArgs).not.toContain('--worklog-dir');
  });

  it('resolves from the given start directory, not the process CWD', async () => {
    const { configureWorklogTarget } = await import('./index.js');
    const root = makeTempDir();
    mkdirSync(join(root, '.worklog'));
    writeFileSync(join(root, '.worklog', 'worklog.db'), '');
    const unrelated = makeTempDir();
    process.cwd = () => unrelated; // Simulate the plugin running from its own dir
    resetWorklogDir();

    const resolved = configureWorklogTarget(root);
    expect(resolved).toBe(root);

    const mockFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ results: [] }),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);
    await fetchItemsByStage('plan_complete');

    const callArgs = mockFn.mock.calls[0][1] as string[];
    expect(callArgs[callArgs.indexOf('--worklog-dir') + 1]).toBe(join(root, '.worklog'));
    process.cwd = originalCwd;
  });

  it('uses HERDR_RESOLVED_CWD as the start directory when set', async () => {
    const { configureWorklogTarget } = await import('./index.js');
    const root = makeTempDir();
    mkdirSync(join(root, '.worklog'));
    writeFileSync(join(root, '.worklog', 'worklog.db'), '');
    process.env.HERDR_RESOLVED_CWD = root;
    resetWorklogDir();

    const resolved = configureWorklogTarget(process.env.HERDR_RESOLVED_CWD);
    expect(resolved).toBe(root);
  });

  it('reports the uninitialized state with actionable stderr messages', async () => {
    const { uninitializedReport } = await import('./index.js');
    const report = uninitializedReport('/tmp/nonexistent-project');
    expect(report).toContain("No valid .worklog/ directory found in or above '/tmp/nonexistent-project'");
    expect(report).toContain('Showing empty worklist. Navigate to a project with \'worklog init\' to see items.');
  });
});
