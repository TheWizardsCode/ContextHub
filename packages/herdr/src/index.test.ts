/**
 * Unit tests for command routing helpers in index.ts (the worklog-root
 * resolution tests live in packages/shared/src/worklog-paths.test.ts).
 *
 * Run: npx vitest run packages/herdr/src/index.test.ts
 */

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import {
  stripCommandPrefix,
  routeCommand,
  stripAgentPromptPrefix,
  buildSendToPiArgs,
  buildRunInPaneArgs,
  createDowntimeDeps,
  capturePaneIdFromFile,
  parsePaneIdFile,
  buildBackgroundLogPath,
  spawnBackgroundShell,
  spawnBackgroundPi,
  CAPTURE_TIMEOUT_MS,
} from './index.js';
import { appendDowntimeLogEntry, DOWNTIME_LOG_FILE, readDowntimeLogEntries } from './downtime-log.js';
import { DOWNTIME_WL_TIMEOUT_MS, dispatchDowntimeWork, type ScheduledPrompt } from './downtime-worker.js';
import { SCHEDULED_PROMPTS_FILE, scheduledPromptsPath } from './scheduled-prompts.js';
import {
  fetchItemsByStage,
  resetExecFileAsync,
  resetWorklogDir,
  setExecFileAsync,
  setWorklogDir,
} from './fetcher.js';

// ---------------------------------------------------------------------------
// buildSendToPiArgs tests (WL-0MSD48ZFC0043AO3)
// ---------------------------------------------------------------------------

describe('buildSendToPiArgs', () => {
  // Selection-list agent dispatch must NOT steal focus from the list
  // (WL-0MSHIA53D009DJOT): every agent-pane spawn passes --no-focus so
  // shared/send-to-pi.sh skips its final zoom. The flag is emitted before
  // --cwd, mirroring buildDowntimePaneArgs.
  it('includes --model <model> for agent commands with a model', () => {
    expect(buildSendToPiArgs('/skill:implement <id>', '/project', 'code')).toEqual([
      '--no-focus',
      '--cwd',
      '/project',
      '--model',
      'code',
      '/skill:implement <id>',
    ]);
  });

  it('omits --model when no model is provided (--no-focus retained)', () => {
    expect(buildSendToPiArgs('/skill:implement <id>', '/project')).toEqual([
      '--no-focus',
      '--cwd',
      '/project',
      '/skill:implement <id>',
    ]);
  });

  it('strips the /prompt: prefix and keeps the model', () => {
    expect(buildSendToPiArgs('/prompt:Review the item', '/project', 'author')).toEqual([
      '--no-focus',
      '--cwd',
      '/project',
      '--model',
      'author',
      'Review the item',
    ]);
  });

  it('passes an empty prompt arg for a bare /prompt: command (blank session)', () => {
    expect(buildSendToPiArgs('/prompt:', '/project', 'plan')).toEqual([
      '--no-focus',
      '--cwd',
      '/project',
      '--model',
      'plan',
      '',
    ]);
  });

  it('passes /plan with the plan model', () => {
    expect(buildSendToPiArgs('/plan <id>', '/project', 'plan')).toEqual([
      '--no-focus',
      '--cwd',
      '/project',
      '--model',
      'plan',
      '/plan <id>',
    ]);
  });

  it('forwards a descriptive pane name via --pane-name (WL-0MSJ4E8UA005KG9Y)', () => {
    expect(
      buildSendToPiArgs('/skill:implement WL-1', '/project', 'code', undefined, 'Manually triggered implement Fix the bug - WL-1'),
    ).toEqual([
      '--no-focus',
      '--cwd',
      '/project',
      '--pane-name',
      'Manually triggered implement Fix the bug - WL-1',
      '--model',
      'code',
      '/skill:implement WL-1',
    ]);
  });

  it('omits --pane-name when none is provided', () => {
    expect(buildSendToPiArgs('/skill:audit WL-2', '/project')).not.toContain('--pane-name');
  });
});

// ---------------------------------------------------------------------------
// buildRunInPaneArgs tests (WL-0MSHIA53D009DJOT) — the pane and stdout
// dispatch routes share this helper, so a single unit-test group covers both
// AC2 (!!/! prefixed) and AC3 (plain shell) no-focus behavior.
// ---------------------------------------------------------------------------

describe('buildRunInPaneArgs', () => {
  it('passes --no-focus + --cwd before a !!-prefixed command (pane route)', () => {
    expect(buildRunInPaneArgs('wl update <id> --priority high', '/project')).toEqual([
      '--no-focus',
      '--cwd',
      '/project',
      'wl update <id> --priority high',
    ]);
  });

  it('passes --no-focus + --cwd before a plain shell command (stdout route)', () => {
    expect(buildRunInPaneArgs('ls -la && pwd', '/project')).toEqual([
      '--no-focus',
      '--cwd',
      '/project',
      'ls -la && pwd',
    ]);
  });

  it('keeps the full command intact after the options', () => {
    const args = buildRunInPaneArgs("echo 'quoted arg' --flag", '/project');
    expect(args.slice(0, 3)).toEqual(['--no-focus', '--cwd', '/project']);
    expect(args[3]).toBe("echo 'quoted arg' --flag");
  });

  it('forwards --pane-name to replace the default "Command Output" (WL-0MSJ4E8UA005KG9Y)', () => {
    expect(buildRunInPaneArgs('wl update WL-1 --priority high', '/project', 'Shell: wl update WL-1 (Fix the bug) WL-1')).toEqual([
      '--no-focus',
      '--cwd',
      '/project',
      '--pane-name',
      'Shell: wl update WL-1 (Fix the bug) WL-1',
      'wl update WL-1 --priority high',
    ]);
  });

  it('omits --pane-name when none is provided', () => {
    expect(buildRunInPaneArgs('ls -la', '/project')).not.toContain('--pane-name');
  });
});

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
  model?: string;
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

  it('binds P-p to the free-form prompt, P-a to the audit-gaps prompt, and P-n to a blank session', () => {
    const freePrompt = entries.find((e) => e.chord.join(' ') === 'P p');
    expect(freePrompt).toBeDefined();
    expect(freePrompt!.command).toBe('/prompt:<prompt>');
    expect(freePrompt!.view).toBe('both');
    expect(freePrompt!.model).toBe('plan');
    expect(routeCommand(freePrompt!.command)).toBe('agent');

    const auditPrompt = entries.find((e) => e.chord.join(' ') === 'P a');
    expect(auditPrompt).toBeDefined();
    expect(auditPrompt!.command).toBe(
      '/prompt:What are the audit gaps reported in the most recent audit for <id>',
    );
    expect(auditPrompt!.view).toBe('both');
    expect(auditPrompt!.model).toBe('plan');
    expect(routeCommand(auditPrompt!.command)).toBe('agent');

    const blankSession = entries.find((e) => e.chord.join(' ') === 'P n');
    expect(blankSession).toBeDefined();
    expect(blankSession!.command).toBe('/prompt:');
    expect(blankSession!.view).toBe('both');
    expect(blankSession!.model).toBe('plan');
    // Empty /prompt: carries no placeholders: no command-input form, no
    // work-item claim (AC2/AC3), and it routes to the agent channel.
    expect(blankSession!.command).not.toContain('<id>');
    expect(blankSession!.command).not.toContain('<prompt>');
    expect(routeCommand(blankSession!.command)).toBe('agent');
  });

  it('keeps the single-key p chord bound to plan (P leader does not shadow it)', () => {
    const planEntry = entries.find((e) => e.chord.join(' ') === 'p');
    expect(planEntry).toBeDefined();
    expect(planEntry!.command).toBe('/plan <id>');
    // The uppercase P leader is distinct from the lowercase p plan chord.
    expect(entries.some((e) => e.chord.join(' ') === 'P')).toBe(false);
  });
});


describe('routeCommand', () => {
  describe('agent commands', () => {    it('routes /skill: commands to the agent pane', () => {
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
// Temp-dir helpers (shared by the configureWorklogTarget tests below)
// ---------------------------------------------------------------------------

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
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
    writeFileSync(join(root, '.worklog', 'config.yaml'), 'projectName: test\nprefix: TEST\n');
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
    writeFileSync(join(root, '.worklog', 'config.yaml'), 'projectName: test\nprefix: TEST\n');
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
    writeFileSync(join(root, '.worklog', 'config.yaml'), 'projectName: test\nprefix: TEST\n');
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

// ---------------------------------------------------------------------------
// createDowntimeDeps tests (WL-0MSF49FMW009M06K, F4 wiring)
// ---------------------------------------------------------------------------

describe('createDowntimeDeps', () => {
  afterEach(() => {
    resetExecFileAsync();
    resetWorklogDir();
  });

  // Route-aware wl mock for the critical-tier lookup (F3): `wl list`
  // returns the critical batch; `wl dep list` returns the outbound
  // depends-on edges for the queried item (its blockers); `wl show`
  // enriches a blocker with the full workItem fields. Unblocked items
  // (no outbound edges) resolve to themselves in the frontier walk, so
  // the F2 expectations carry over unchanged.
  const criticalWlMock = (
    workItems: unknown[],
    blockersByItem: Record<string, unknown[]> = {},
    showItems: Record<string, Record<string, unknown>> = {},
  ) =>
    vi.fn().mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === 'dep') {
        const itemId = args[2];
        return Promise.resolve({
          stdout: JSON.stringify({ success: true, item: itemId, inbound: [], outbound: blockersByItem[itemId] ?? [] }),
          stderr: '',
        });
      }
      if (args[0] === 'show') {
        const itemId = args[1];
        return Promise.resolve({
          stdout: JSON.stringify({ success: true, workItem: showItems[itemId] ?? { id: itemId, title: 'blocker', status: 'open', stage: 'intake_complete', risk: 'low', effort: 'small', sortIndex: 10 } }),
          stderr: '',
        });
      }
      return Promise.resolve({
        stdout: JSON.stringify({ success: true, count: workItems.length, workItems }),
        stderr: '',
      });
    });

  it('getNextItem runs wl next --stage -n 10 and parses the first workItem', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ success: true, workItem: { id: 'WL-ABC', title: 'Some task', status: 'open' } }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    const result = await deps.getNextItem('intake_complete', '/repo');

    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      ['next', '--stage', 'intake_complete', '-n', '10', '--json'],
      expect.anything(),
    );
    expect(result).toEqual({
      ok: true,
      candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete', status: 'open', sortIndex: undefined },
    });
  });

  it('getNextItem parses the batch shape (wl next -n N) and preserves priority order', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        workItems: [
          { workItem: { id: 'WL-1', title: 'Second', status: 'open', sortIndex: 20 } },
          { workItem: { id: 'WL-2', title: 'First', status: 'open', sortIndex: 10 } },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    const result = await deps.getNextItem('idea', '/repo');

    // selectNextCandidate: open-status guard + sortIndex ascending (wl next
    // priority order preserved).
    expect(result).toEqual({
      ok: true,
      candidate: { id: 'WL-2', title: 'First', stage: 'idea', status: 'open', sortIndex: 10 },
    });
  });

  it('getNextItem excludes a plan-dispatched candidate still at its dispatched stage (change-guard)', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        workItems: [
          { workItem: { id: 'WL-ONCE', title: 'Marked', status: 'open', sortIndex: 5 } },
          { workItem: { id: 'WL-NEXT', title: 'Next', status: 'open', sortIndex: 20 } },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);
    const cwd = makeTempDir();
    // Pre-write a plan marker for WL-ONCE at stage intake_complete (the same
    // stage the plan tier selects at).
    await appendDowntimeLogEntry(
      cwd,
      JSON.stringify({ itemId: 'WL-ONCE', kind: 'plan', stage: 'intake_complete', dispatchedAt: '2026-01-01T00:00:00.000Z' }),
    );

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    const result = await deps.getNextItem('intake_complete', cwd);

    // The marked candidate is excluded; the next one is selected.
    expect(result).toEqual({
      ok: true,
      candidate: { id: 'WL-NEXT', title: 'Next', stage: 'intake_complete', status: 'open', sortIndex: 20 },
    });
  });

  it('getNextItem passes --worklog-dir when the tab resolved a worklog root', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ success: true, workItem: { id: 'SA-ABC', title: 'Sorra task', status: 'open' } }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);
    setWorklogDir('/home/user/projects/SorraAgents/.worklog');

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    const result = await deps.getNextItem('intake_complete', '/repo');

    // The global option must appear BEFORE the subcommand, exactly as the
    // worklist's runWl() prepends it (WL-0MSI7DQL10016QYX).
    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      [
        '--worklog-dir',
        '/home/user/projects/SorraAgents/.worklog',
        'next',
        '--stage',
        'intake_complete',
        '-n',
        '10',
        '--json',
      ],
      expect.anything(),
    );
    expect(result).toEqual({ ok: true, candidate: { id: 'SA-ABC', title: 'Sorra task', stage: 'intake_complete', status: 'open', sortIndex: undefined } });
  });

  it('getNextItem reports ok:true with no candidate when wl reports no item', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ success: false, workItem: null, reason: 'none' }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    expect(await deps.getNextItem('idea', '/repo')).toEqual({ ok: true, candidate: null });
  });

  it('getNextItem fails closed ({ok:false}) when wl errors', async () => {
    setExecFileAsync(vi.fn().mockRejectedValue(new Error('wl boom')) as never);
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    expect(await deps.getNextItem('idea', '/repo')).toEqual({ ok: false, error: 'wl boom' });
  });

  it('getNextItem passes a bounded timeout so a hung wl fails closed', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ success: true, workItem: { id: 'WL-ABC', title: 'Some task', status: 'open' } }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    await deps.getNextItem('intake_complete', '/repo');

    // AC1: the invocation must carry the bounded timeout so a hung wl child
    // is killed by execFile instead of wedging the dispatch task.
    const [, , options] = mockExec.mock.calls[0];
    expect(options).toMatchObject({ timeout: DOWNTIME_WL_TIMEOUT_MS });
  });

  it('getNextItem fails closed within the timeout when wl hangs (AC4 hang path)', async () => {
    vi.useFakeTimers();
    try {
      // A hung wl child: the mock never resolves on its own — the bounded
      // timeout (enforced by execFile in production) rejects the invocation
      // after DOWNTIME_WL_TIMEOUT_MS, so the lookup fails closed to busy.
      const hungExec = vi.fn(
        (_bin: string, _args: string[], opts?: { timeout?: number }) =>
          new Promise((_resolve, reject) => {
            setTimeout(
              () => reject(Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' })),
              opts?.timeout ?? DOWNTIME_WL_TIMEOUT_MS,
            );
          }),
      );
      setExecFileAsync(hungExec as never);
      const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');

      const resultPromise = deps.getNextItem('idea', '/repo');
      await vi.advanceTimersByTimeAsync(DOWNTIME_WL_TIMEOUT_MS - 1);
      // Still pending just before the timeout — no premature resolution.
      await vi.advanceTimersByTimeAsync(1);
      await expect(resultPromise).resolves.toEqual({ ok: false, error: 'ETIMEDOUT' });

      // The hung invocation received the bounded timeout option.
      expect(hungExec.mock.calls[0][2]).toMatchObject({ timeout: DOWNTIME_WL_TIMEOUT_MS });
    } finally {
      vi.useRealTimers();
    }
  });

  it('getNextAuditCandidate runs wl list completed/in_review and selects the first stale-audit item', async () => {
    // Fixture times are relative to now so the 7-day recency filter passes
    // (selectAuditCandidate defaults to Date.now()).
    const now = Date.now();
    const HOUR_MS = 60 * 60 * 1000;
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        count: 2,
        workItems: [
          { id: 'WL-FRESH', title: 'Fresh audit', auditedAt: new Date(now - 30 * 60 * 1000).toISOString(), updatedAt: new Date(now - HOUR_MS).toISOString(), sortIndex: 100 },
          { id: 'WL-STALE', title: 'Stale audit', auditedAt: new Date(now - 2 * HOUR_MS).toISOString(), updatedAt: new Date(now - HOUR_MS).toISOString(), sortIndex: 200 },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    const result = await deps.getNextAuditCandidate('/repo');

    // AC1 (WL-0MSTLFW14000KPEC): the audit tier must request --root-only so
    // completed/in_review CHILDREN are excluded server-side and only parent
    // items are audit candidates.
    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      ['list', '--status', 'completed', '--stage', 'in_review', '--root-only', '--json'],
      expect.anything(),
    );
    expect(result).toEqual({ ok: true, candidate: { id: 'WL-STALE', title: 'Stale audit', stage: 'audit' } });
  });

  it('getNextAuditCandidate requests root-only items so child items never enter the audit tier (WL-0MSTLFW14000KPEC)', async () => {
    // AC3: child items in completed/in_review must never be dispatched as
    // audit candidates — only parent (root) items belong in the producer
    // review queue. The exclusion is delegated to the wl server filter
    // (`--root-only`, WL-0MS964SIA0057ABR), so the client contract is that
    // the `wl list` invocation carries --root-only; the mock output below
    // simulates what `wl list --root-only` returns (the child with a
    // parentId is filtered out server-side and never reaches selection).
    const now = Date.now();
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        count: 2,
        workItems: [
          { id: 'WL-PARENT', title: 'Parent epic', auditedAt: null, updatedAt: new Date(now - 60_000).toISOString(), sortIndex: 100 },
          { id: 'WL-ROOT', title: 'Standalone root', auditedAt: null, updatedAt: new Date(now - 60_000).toISOString(), sortIndex: 200 },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    const result = await deps.getNextAuditCandidate('/repo');

    // AC1/AC3: the invocation MUST carry --root-only — without it, a child
    // item sitting in completed/in_review would be returned by `wl list` and
    // dispatched independently, which is exactly the bug being fixed.
    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      ['list', '--status', 'completed', '--stage', 'in_review', '--root-only', '--json'],
      expect.anything(),
    );
    // Only root-level items (no parentId) can ever be candidates.
    expect(result).toEqual({ ok: true, candidate: { id: 'WL-PARENT', title: 'Parent epic', stage: 'audit' } });
  });

  it('getNextAuditCandidate returns ok:true with no candidate when no stale/missing-audit item exists', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        count: 1,
        workItems: [
          { id: 'WL-FRESH', title: 'Fresh audit', auditedAt: '2026-01-01T00:00:30.000Z', updatedAt: '2026-01-01T00:00:00.000Z', sortIndex: 100 },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    expect(await deps.getNextAuditCandidate('/repo')).toEqual({ ok: true, candidate: null });
  });

  it('getNextAuditCandidate resolves ok:false when wl errors (a strike, never a null empty tier)', async () => {
    setExecFileAsync(vi.fn().mockRejectedValue(new Error('wl boom')) as never);
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    expect(await deps.getNextAuditCandidate('/repo')).toEqual({ ok: false, error: 'wl boom' });
  });

  it('getNextAuditCandidate passes a bounded timeout so a hung wl fails closed', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ success: true, count: 0, workItems: [] }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    await deps.getNextAuditCandidate('/repo');

    // AC1: the audit-tier invocation must carry the bounded timeout too.
    const [, , options] = mockExec.mock.calls[0];
    expect(options).toMatchObject({ timeout: DOWNTIME_WL_TIMEOUT_MS });
  });

  it('getNextAuditCandidate resolves ok:false within the timeout when wl hangs', async () => {
    vi.useFakeTimers();
    try {
      const hungExec = vi.fn(
        (_bin: string, _args: string[], opts?: { timeout?: number }) =>
          new Promise((_resolve, reject) => {
            setTimeout(
              () => reject(Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' })),
              opts?.timeout ?? DOWNTIME_WL_TIMEOUT_MS,
            );
          }),
      );
      setExecFileAsync(hungExec as never);
      const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');

      const resultPromise = deps.getNextAuditCandidate('/repo');
      await vi.advanceTimersByTimeAsync(DOWNTIME_WL_TIMEOUT_MS);
      await expect(resultPromise).resolves.toEqual({ ok: false, error: 'ETIMEDOUT' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('getNextAuditCandidate resolves ok:false on malformed wl output', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: 'not json', stderr: '' });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    expect(await deps.getNextAuditCandidate('/repo')).toEqual({ ok: false, error: 'audit parse error' });
  });

  it('getNextAuditCandidate excludes an item already dispatched for audit (marker in the log, no fresh audit)', async () => {
    // Regression (WL-0MSGTLSUT002NF29): a completed/in_review item present in
    // the shared dispatch log with kind:audit and no fresh audit is excluded
    // from audit-tier selection even though it is otherwise selectable.
    const now = Date.now();
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        count: 2,
        workItems: [
          { id: 'WL-DUP', title: 'already dispatched', auditedAt: null, updatedAt: new Date(now - 60_000).toISOString(), sortIndex: 100 },
          { id: 'WL-OTHER', title: 'fresh slot', auditedAt: null, updatedAt: new Date(now - 60_000).toISOString(), sortIndex: 200 },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    // A real dispatch log under a temp worklog root with an audit marker.
    const cwd = makeTempDir();
    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    writeFileSync(
      join(cwd, '.worklog', DOWNTIME_LOG_FILE),
      JSON.stringify({ itemId: 'WL-DUP', kind: 'audit', dispatchedAt: new Date(now - 3_600_000).toISOString(), cwd }) + '\n',
      'utf8',
    );

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    const result = await deps.getNextAuditCandidate(cwd);
    expect(result).toEqual({ ok: true, candidate: { id: 'WL-OTHER', title: 'fresh slot', stage: 'audit' } });
  });

  it('getNextAuditCandidate does not exclude plan/intake markers (audit-tier-only scope guard)', async () => {
    const now = Date.now();
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        count: 1,
        workItems: [
          { id: 'WL-PLANNED', title: 'planned before', auditedAt: null, updatedAt: new Date(now - 60_000).toISOString(), sortIndex: 100 },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const cwd = makeTempDir();
    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    writeFileSync(
      join(cwd, '.worklog', DOWNTIME_LOG_FILE),
      JSON.stringify({ itemId: 'WL-PLANNED', kind: 'plan', dispatchedAt: new Date(now - 3_600_000).toISOString(), cwd }) + '\n',
      'utf8',
    );

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    const result = await deps.getNextAuditCandidate(cwd);
    expect(result).toEqual({ ok: true, candidate: { id: 'WL-PLANNED', title: 'planned before', stage: 'audit' } });
  });

  it('getNextAuditCandidate treats a missing dispatch log as empty (fail-safe, dispatch still works)', async () => {
    const now = Date.now();
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        count: 1,
        workItems: [
          { id: 'WL-FRESHWORKLOG', title: 'fresh worklog', auditedAt: null, updatedAt: new Date(now - 60_000).toISOString(), sortIndex: 100 },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    // cwd with no .worklog/downtime-dispatches.log at all.
    const cwd = makeTempDir();
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    const result = await deps.getNextAuditCandidate(cwd);
    expect(result).toEqual({ ok: true, candidate: { id: 'WL-FRESHWORKLOG', title: 'fresh worklog', stage: 'audit' } });
  });

  it('getNextAuditCandidate skips malformed log lines without failing the lookup', async () => {
    const now = Date.now();
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        count: 1,
        workItems: [
          { id: 'WL-OK', title: 'ok item', auditedAt: null, updatedAt: new Date(now - 60_000).toISOString(), sortIndex: 100 },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const cwd = makeTempDir();
    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    writeFileSync(
      join(cwd, '.worklog', DOWNTIME_LOG_FILE),
      'not-json\n{"broken":\n' + JSON.stringify({ itemId: 'WL-DUP', kind: 'audit', dispatchedAt: new Date(now - 3_600_000).toISOString(), cwd }) + '\n',
      'utf8',
    );

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    const result = await deps.getNextAuditCandidate(cwd);
    expect(result).toEqual({ ok: true, candidate: { id: 'WL-OK', title: 'ok item', stage: 'audit' } });
  });

  it('getNextImplementCandidate runs wl next plan_complete risk/effort batch and selects the first open item', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        count: 2,
        requested: 10,
        results: [
          { workItem: { id: 'WL-OPEN', title: 'Open low-risk', status: 'open', risk: 'low', effort: 'small' } },
          { workItem: { id: 'WL-DONE', title: 'Completed epic', status: 'completed', risk: 'low', effort: 'small' } },
        ],
        workItems: [
          { workItem: { id: 'WL-OPEN', title: 'Open low-risk', status: 'open', risk: 'low', effort: 'small' } },
          { workItem: { id: 'WL-DONE', title: 'Completed epic', status: 'completed', risk: 'low', effort: 'small' } },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    const result = await deps.getNextImplementCandidate('/repo');

    // The invocation must carry the risk/effort filters and a generous batch
    // count (-n) so completed items can be filtered out client-side without
    // starving selection (WL-0MSMAYIKX005LLO4 AC2/AC3).
    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      ['next', '--stage', 'plan_complete', '--risk', 'medium', '--effort', 'medium', '-n', expect.any(String), '--json'],
      expect.anything(),
    );
    // wl next keeps completed items with a stage filter; the client-side
    // status=open filter drops the completed epic and selects WL-OPEN.
    expect(result).toEqual({ id: 'WL-OPEN', title: 'Open low-risk', stage: 'implement' });
  });

  it('getNextImplementCandidate relies on wl next default dependency-blocked exclusion (no --include-blocked)', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        count: 1,
        workItems: [
          { workItem: { id: 'WL-OPEN', title: 'Open low-risk', status: 'open', risk: 'low', effort: 'small' } },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    await deps.getNextImplementCandidate('/repo');

    const [, args] = mockExec.mock.calls[0];
    // Dependency-blocked exclusion is wl next's default (includeBlocked=false).
    // The implement tier must never opt into --include-blocked, or blocked
    // candidates would reach the dispatch layer (WL-0MSMAYIKX005LLO4 AC3).
    expect(args).not.toContain('--include-blocked');
  });

  it('getNextImplementCandidate returns null when no open candidate exists (all completed)', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        count: 1,
        workItems: [
          { workItem: { id: 'WL-DONE', title: 'Completed epic', status: 'completed', risk: 'low', effort: 'small' } },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    expect(await deps.getNextImplementCandidate('/repo')).toBeNull();
  });

  it('getNextImplementCandidate fails closed (null) when wl errors', async () => {
    setExecFileAsync(vi.fn().mockRejectedValue(new Error('wl boom')) as never);
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    expect(await deps.getNextImplementCandidate('/repo')).toBeNull();
  });

  it('getNextImplementCandidate fails closed (null) on malformed wl output', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: 'not json', stderr: '' });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    expect(await deps.getNextImplementCandidate('/repo')).toBeNull();
  });

  it('getNextImplementCandidate passes a bounded timeout so a hung wl fails closed', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ success: true, count: 0, workItems: [] }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    await deps.getNextImplementCandidate('/repo');

    const [, , options] = mockExec.mock.calls[0];
    expect(options).toMatchObject({ timeout: DOWNTIME_WL_TIMEOUT_MS });
  });

  it('getNextImplementCandidate excludes an item already dispatched for implement (kind implement marker)', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        count: 2,
        workItems: [
          { workItem: { id: 'WL-DUP', title: 'already dispatched', status: 'open', risk: 'low', effort: 'small' } },
          { workItem: { id: 'WL-FRESH', title: 'fresh slot', status: 'open', risk: 'low', effort: 'small' } },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const cwd = makeTempDir();
    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    writeFileSync(
      join(cwd, '.worklog', DOWNTIME_LOG_FILE),
      JSON.stringify({ itemId: 'WL-DUP', kind: 'implement', dispatchedAt: new Date(Date.now() - 3_600_000).toISOString(), cwd }) + '\n',
      'utf8',
    );

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    const result = await deps.getNextImplementCandidate(cwd);
    expect(result).toEqual({ id: 'WL-FRESH', title: 'fresh slot', stage: 'implement' });
  });

  it('getNextImplementCandidate does not exclude audit/plan/intake markers (implement-tier-only scope guard)', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        count: 1,
        workItems: [
          { workItem: { id: 'WL-IMP', title: 'implementable', status: 'open', risk: 'low', effort: 'small' } },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const cwd = makeTempDir();
    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    writeFileSync(
      join(cwd, '.worklog', DOWNTIME_LOG_FILE),
      JSON.stringify({ itemId: 'WL-IMP', kind: 'audit', dispatchedAt: new Date(Date.now() - 3_600_000).toISOString(), cwd }) + '\n',
      'utf8',
    );

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    const result = await deps.getNextImplementCandidate(cwd);
    expect(result).toEqual({ id: 'WL-IMP', title: 'implementable', stage: 'implement' });
  });

  it('getNextImplementCandidate treats a missing dispatch log as empty (fail-safe, dispatch still works)', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        count: 1,
        workItems: [
          { workItem: { id: 'WL-FRESHWORKLOG', title: 'fresh worklog', status: 'open', risk: 'low', effort: 'small' } },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const cwd = makeTempDir(); // no .worklog/downtime-dispatches.log
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    const result = await deps.getNextImplementCandidate(cwd);
    expect(result).toEqual({ id: 'WL-FRESHWORKLOG', title: 'fresh worklog', stage: 'implement' });
  });

  it('getNextImplementCandidate applies --worklog-dir when the tab resolved a worklog root', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ success: true, count: 0, workItems: [] }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);
    setWorklogDir('/home/user/projects/SorraAgents/.worklog');

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    await deps.getNextImplementCandidate('/repo');

    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      [
        '--worklog-dir',
        '/home/user/projects/SorraAgents/.worklog',
        'next',
        '--stage',
        'plan_complete',
        '--risk',
        'medium',
        '--effort',
        'medium',
        '-n',
        expect.any(String),
        '--json',
      ],
      expect.anything(),
    );
  });

  it('getNextCriticalCandidate runs wl list --priority critical --status open across ALL stages', async () => {
    const mockExec = criticalWlMock([
      { id: 'WL-CRIT-IDEA', title: 'Critical idea', status: 'open', stage: 'idea', risk: 'low', effort: 'small', sortIndex: 100 },
      { id: 'WL-CRIT-READY', title: 'Critical ready', status: 'open', stage: 'intake_complete', risk: 'low', effort: 'small', sortIndex: 200 },
      { id: 'WL-CRIT-PLAN', title: 'Critical planned', status: 'open', stage: 'plan_complete', risk: 'medium', effort: 'medium', sortIndex: 300 },
    ]);
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    const result = await deps.getNextCriticalCandidate('/repo');

    // The critical lookup must NOT be stage-gated: every open critical
    // stage is enumerated, and the lowest sortIndex wins deterministically.
    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      ['list', '--priority', 'critical', '--status', 'open', '-n', expect.any(String), '--json'],
      expect.anything(),
    );
    expect(result).toEqual({
      ok: true,
      candidate: { id: 'WL-CRIT-IDEA', title: 'Critical idea', stage: 'idea' },
    });
  });

  it('getNextCriticalCandidate includes dependency-blocked items (no wl next exclusion)', async () => {
    const mockExec = criticalWlMock([
      { id: 'WL-CRIT-BLOCKED', title: 'Blocked critical', status: 'open', stage: 'plan_complete', risk: 'low', effort: 'small', sortIndex: 10 },
    ]);
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    await deps.getNextCriticalCandidate('/repo');

    const [, args] = mockExec.mock.calls[0];
    // wl list does not exclude dependency-blocked items — the critical
    // lookup must never opt into wl next's --include-blocked machinery or
    // add a stage filter, or blocked critical items would vanish from the
    // dispatch queue (Q3 needs them for frontier resolution).
    expect(args).not.toContain('--include-blocked');
    expect(args).not.toContain('--stage');
  });

  it('getNextCriticalCandidate honors the plan_complete implement caps (Q2: above caps not selected)', async () => {
    const mockExec = criticalWlMock([
      { id: 'WL-CRIT-HIRISK', title: 'High-risk critical', status: 'open', stage: 'plan_complete', risk: 'high', effort: 'small', sortIndex: 10 },
      { id: 'WL-CRIT-READY', title: 'Critical ready', status: 'open', stage: 'intake_complete', risk: 'low', effort: 'small', sortIndex: 900 },
    ]);
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    const result = await deps.getNextCriticalCandidate('/repo');

    // The plan_complete critical is above the risk cap → never
    // implement-dispatched; the intake_complete critical wins instead.
    expect(result).toEqual({
      ok: true,
      candidate: { id: 'WL-CRIT-READY', title: 'Critical ready', stage: 'intake_complete' },
    });
  });

  it('getNextCriticalCandidate excludes items still at their dispatched-at stage (change-guard)', async () => {
    const mockExec = criticalWlMock([
      { id: 'WL-CRIT-ONCE', title: 'already dispatched at idea', status: 'open', stage: 'idea', risk: 'low', effort: 'small', sortIndex: 5 },
      { id: 'WL-CRIT-NEXT', title: 'next critical', status: 'open', stage: 'intake_complete', risk: 'low', effort: 'small', sortIndex: 20 },
    ]);
    setExecFileAsync(mockExec as never);

    const cwd = makeTempDir();
    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    writeFileSync(
      join(cwd, '.worklog', DOWNTIME_LOG_FILE),
      JSON.stringify({ itemId: 'WL-CRIT-ONCE', kind: 'intake', stage: 'idea', dispatchedAt: new Date(Date.now() - 3_600_000).toISOString(), cwd }) + '\n',
      'utf8',
    );

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    const result = await deps.getNextCriticalCandidate(cwd);

    // WL-CRIT-ONCE was dispatched for /skill:intake at idea and is still at
    // idea → excluded by the change-guard; the next critical is selected.
    expect(result).toEqual({
      ok: true,
      candidate: { id: 'WL-CRIT-NEXT', title: 'next critical', stage: 'intake_complete' },
    });
  });

  it('getNextCriticalCandidate releases an item whose stage advanced past its dispatched-at stage', async () => {
    const mockExec = criticalWlMock([
      { id: 'WL-CRIT-ADV', title: 'advanced critical', status: 'open', stage: 'plan_complete', risk: 'low', effort: 'small', sortIndex: 5 },
    ]);
    setExecFileAsync(mockExec as never);

    const cwd = makeTempDir();
    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    writeFileSync(
      join(cwd, '.worklog', DOWNTIME_LOG_FILE),
      JSON.stringify({ itemId: 'WL-CRIT-ADV', kind: 'plan', stage: 'intake_complete', dispatchedAt: new Date(Date.now() - 3_600_000).toISOString(), cwd }) + '\n',
      'utf8',
    );

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    const result = await deps.getNextCriticalCandidate(cwd);

    // Marked at intake_complete, now at plan_complete → released.
    expect(result).toEqual({
      ok: true,
      candidate: { id: 'WL-CRIT-ADV', title: 'advanced critical', stage: 'plan_complete' },
    });
  });

  it('getNextCriticalCandidate treats a missing dispatch log as empty (fail-safe, dispatch still works)', async () => {
    const mockExec = criticalWlMock([
      { id: 'WL-CRIT-FRESH', title: 'fresh worklog critical', status: 'open', stage: 'idea', risk: 'low', effort: 'small', sortIndex: 5 },
    ]);
    setExecFileAsync(mockExec as never);

    const cwd = makeTempDir(); // no .worklog/downtime-dispatches.log
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    const result = await deps.getNextCriticalCandidate(cwd);
    expect(result).toEqual({
      ok: true,
      candidate: { id: 'WL-CRIT-FRESH', title: 'fresh worklog critical', stage: 'idea' },
    });
  });

  it('getNextCriticalCandidate reports ok:true with no candidate when the critical tier is empty', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ success: true, count: 0, workItems: [] }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    expect(await deps.getNextCriticalCandidate('/repo')).toEqual({ ok: true, candidate: null });
  });

  it('getNextCriticalCandidate fails closed ({ok:false}) on wl error (never a silent empty)', async () => {
    setExecFileAsync(vi.fn().mockRejectedValue(new Error('wl boom')) as never);
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    expect(await deps.getNextCriticalCandidate('/repo')).toEqual({ ok: false, error: 'wl boom' });
  });

  it('getNextCriticalCandidate fails closed ({ok:false}) on malformed wl output', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: 'not json', stderr: '' });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    expect(await deps.getNextCriticalCandidate('/repo')).toEqual({ ok: false, error: 'critical parse error' });
  });

  it('getNextCriticalCandidate passes a bounded timeout so a hung wl fails closed', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ success: true, count: 0, workItems: [] }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    await deps.getNextCriticalCandidate('/repo');

    const [, , options] = mockExec.mock.calls[0];
    expect(options).toMatchObject({ timeout: DOWNTIME_WL_TIMEOUT_MS });
  });

  it('getNextCriticalCandidate applies --worklog-dir when the tab resolved a worklog root', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ success: true, count: 0, workItems: [] }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);
    setWorklogDir('/home/user/projects/SorraAgents/.worklog');

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    await deps.getNextCriticalCandidate('/repo');

    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      [
        '--worklog-dir',
        '/home/user/projects/SorraAgents/.worklog',
        'list',
        '--priority',
        'critical',
        '--status',
        'open',
        '-n',
        expect.any(String),
        '--json',
      ],
      expect.anything(),
    );
  });

  it('getNextCriticalCandidate returns the frontier blocker when the selected critical is dependency-blocked (F3 Q3)', async () => {
    // The selected critical item depends on an OPEN blocker (outbound
    // depends-on edge). Per decision Q3 the dep follows the blocking
    // chain and returns the nearest open blocker with ITS stage — the
    // dispatch tier then runs the blocker's stage-appropriate skill.
    const mockExec = criticalWlMock(
      [
        { id: 'WL-CRIT-CHILD', title: 'Critical child', status: 'open', stage: 'idea', risk: 'low', effort: 'small', sortIndex: 5 },
      ],
      {
        'WL-CRIT-CHILD': [
          { id: 'WL-BLOCKER', title: 'Blocking critical', status: 'open', priority: 'critical', direction: 'depends-on' },
        ],
      },
    );
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    const result = await deps.getNextCriticalCandidate('/repo');

    // The dep queries the candidate's edges with `wl dep list`, then
    // enriches the blocker via `wl show` (dep edges lack stage/risk/
    // effort/sortIndex), and returns the frontier blocker — unblocked
    // BLOCKER resolves to itself, carrying its intake_complete stage.
    expect(result).toEqual({
      ok: true,
      candidate: { id: 'WL-BLOCKER', title: 'blocker', stage: 'intake_complete' },
    });
    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      ['dep', 'list', 'WL-CRIT-CHILD', '--json'],
      expect.anything(),
    );
    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      ['show', 'WL-BLOCKER', '--json'],
      expect.anything(),
    );
  });

  it('getNextCriticalCandidate returns null candidate when the blocking chain bottoms in a closed item (F3: fall through to tiers)', async () => {
    // The selected critical item's blocker is closed (completed) — the
    // frontier chain bottoms and the dep reports a null candidate so the
    // critical tier falls through to the normal tier order.
    const mockExec = criticalWlMock(
      [
        { id: 'WL-CRIT-CHILD', title: 'Critical child', status: 'open', stage: 'idea', risk: 'low', effort: 'small', sortIndex: 5 },
      ],
      {
        'WL-CRIT-CHILD': [
          { id: 'WL-CLOSED-BLOCKER', title: 'Closed blocker', status: 'completed', priority: 'critical', direction: 'depends-on' },
        ],
      },
      {
        'WL-CLOSED-BLOCKER': { id: 'WL-CLOSED-BLOCKER', title: 'Closed blocker', status: 'completed', stage: 'completed', risk: 'low', effort: 'small', sortIndex: 3 },
      },
    );
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    const result = await deps.getNextCriticalCandidate('/repo');

    expect(result).toEqual({ ok: true, candidate: null });
  });

  it('getNextCriticalCandidate fails closed to a strike when wl dep list errors (F3 AC5: no silent fall-through)', async () => {
    const mockExec = vi.fn().mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === 'dep') return Promise.reject(new Error('wl dep boom'));
      return Promise.resolve({
        stdout: JSON.stringify({
          success: true,
          count: 1,
          workItems: [
            { id: 'WL-CRIT-CHILD', title: 'Critical child', status: 'open', stage: 'idea', risk: 'low', effort: 'small', sortIndex: 5 },
          ],
        }),
        stderr: '',
      });
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    const result = await deps.getNextCriticalCandidate('/repo');

    // A dependency look-up failure must NOT look like an empty tier — it
    // is a wl-error strike.
    expect(result).toEqual({ ok: false, error: 'wl dep boom' });
  });

  it('end-to-end: two consecutive idle windows dispatch a single unaudited candidate exactly once', async () => {
    // AC5 (parent): with one unaudited completed/in_review candidate and two
    // consecutive idle windows (no audit recorded between), the worker
    // dispatches exactly once. The first dispatch writes the durable marker
    // (kind:audit) to the shared log. The second window's ACTIVE-AUDIT
    // single-flight check (WL-0MT3PHW4I002SNOV) then sees the non-stale
    // marker mapping to the still-in_progress item and skips the audit tier
    // outright — reporting reason 'audit-in-flight' (never 'no-candidate',
    // so the no-candidate cooldown is not entered while the audit runs) —
    // so no second dispatch.
    const now = Date.now();
    const candidate = {
      id: 'WL-ONCE',
      title: 'dispatch me once',
      status: 'completed',
      stage: 'in_review',
      auditedAt: null,
      updatedAt: new Date(now - 60_000).toISOString(),
      sortIndex: 100,
    };
    // wl list always returns the same single candidate (both for the
    // audit-candidate lookup and, as the still-in_progress item, for the
    // active-audit check); wl next returns no candidate so a second (wrong)
    // audit dispatch would be the only path.
    const mockExec = vi.fn((_bin: string, args: string[]) => {
      if (args.includes('--status') && args.includes('in_progress')) {
        // Active-audit check: the dispatched item is still in_progress.
        return Promise.resolve({
          stdout: JSON.stringify({ success: true, count: 1, workItems: [candidate] }),
          stderr: '',
        });
      }
      if (args[0] === 'list') {
        return Promise.resolve({
          stdout: JSON.stringify({ success: true, count: 1, workItems: [candidate] }),
          stderr: '',
        });
      }
      return Promise.resolve({ stdout: JSON.stringify({ success: true, workItem: null }), stderr: '' });
    });
    setExecFileAsync(mockExec as never);
    const spawnFn = vi.fn(() => ({ unref: vi.fn(), once: vi.fn() }));
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map', spawnFn);
    const cwd = makeTempDir();

    // Idle window 1: audit candidate selected and dispatched.
    const first = await dispatchDowntimeWork(deps, { model: 'plan', cwd });
    expect(first.dispatched).toBe(true);
    expect(first.kind).toBe('audit');
    expect(first.candidate?.id).toBe('WL-ONCE');

    // The durable marker landed in the shared log (kind:audit).
    const entries = await readDowntimeLogEntries(cwd);
    expect(entries.some((e) => e.itemId === 'WL-ONCE' && e.kind === 'audit')).toBe(true);

    // Idle window 2: the active-audit check skips the audit tier
    // (audit-in-flight); nothing else to dispatch.
    const second = await dispatchDowntimeWork(deps, { model: 'plan', cwd });
    expect(second.dispatched).toBe(false);
    expect(second.reason).toBe('audit-in-flight');
    expect(second.kind).toBeUndefined();
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it('claimItem runs wl update --status in_progress --assignee with CAS guards', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    const result = await deps.claimItem('WL-ABC', { status: 'open', stage: 'intake_complete' });

    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      [
        'update',
        'WL-ABC',
        '--status',
        'in_progress',
        '--assignee',
        'Map',
        '--if-status',
        'open',
        '--if-stage',
        'intake_complete',
        '--json',
      ],
      expect.anything(),
    );
    expect(result).toEqual({ ok: true });
  });

  it('claimItem resolves stale when the CAS guard fails (another pane won the race)', async () => {
    const mockExec = vi
      .fn()
      .mockRejectedValue(new Error('{"success":false,"error":"stale","message":"Conditional update skipped"}'));
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    const result = await deps.claimItem('WL-ABC', { status: 'open', stage: 'idea' });

    expect(result).toEqual({ ok: false, reason: 'stale', error: '{"success":false,"error":"stale","message":"Conditional update skipped"}' });
  });

  it('claimItem resolves error (a strike) when wl fails for any other reason', async () => {
    setExecFileAsync(vi.fn().mockRejectedValue(new Error('wl boom')) as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    const result = await deps.claimItem('WL-ABC', { status: 'open', stage: 'idea' });

    expect(result).toEqual({ ok: false, reason: 'error', error: 'wl boom' });
  });

  it('spawnAgentPane spawns send-to-pi.sh with the derived pane name and args', async () => {
    const spawnFn = vi.fn(() => ({ unref: vi.fn(), once: vi.fn() }));
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map', spawnFn);

    await deps.spawnAgentPane('Run /skill:plan WL-ABC — Some task.', {
      model: 'plan',
      cwd: '/repo',
    });

    expect(spawnFn).toHaveBeenCalledWith(
      '/path/to/send-to-pi.sh',
      [
        '--pane-name',
        'Downtime plan',
        '--no-focus',
        '--cwd',
        '/repo',
        '--model',
        'plan',
        'Run /skill:plan WL-ABC — Some task.',
      ],
      { cwd: '/repo' },
    );
    const handle = (spawnFn as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(handle.unref).toHaveBeenCalled();
  });

  it('spawnAgentPane derives the intake pane name from the prompt', async () => {
    const spawnFn = vi.fn(() => ({ unref: vi.fn(), once: vi.fn() }));
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map', spawnFn);

    await deps.spawnAgentPane('Run /skill:intake WL-DEF — An idea.', {
      model: 'plan',
      cwd: '/repo',
    });

    expect(spawnFn).toHaveBeenCalledWith(
      '/path/to/send-to-pi.sh',
      expect.arrayContaining(['--pane-name', 'Downtime intake']),
      expect.anything(),
    );
  });

  it('spawnAgentPane derives the audit pane name from the prompt', async () => {
    const spawnFn = vi.fn(() => ({ unref: vi.fn(), once: vi.fn() }));
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map', spawnFn);

    await deps.spawnAgentPane('Run /skill:audit WL-AUD — Audit me.', {
      model: 'plan',
      cwd: '/repo',
    });

    expect(spawnFn).toHaveBeenCalledWith(
      '/path/to/send-to-pi.sh',
      expect.arrayContaining(['--pane-name', 'Downtime audit']),
      expect.anything(),
    );
  });

  it('spawnAgentPane honours an explicit paneName (scheduled prompts run as Downtime <id>)', async () => {
    const spawnFn = vi.fn(() => ({ unref: vi.fn(), once: vi.fn() }));
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map', spawnFn);

    await deps.spawnAgentPane('/skill:refactor', {
      model: 'plan',
      cwd: '/repo',
      paneName: 'Downtime /skill:refactor',
    });

    expect(spawnFn).toHaveBeenCalledWith(
      '/path/to/send-to-pi.sh',
      [
        '--pane-name',
        'Downtime /skill:refactor',
        '--no-focus',
        '--cwd',
        '/repo',
        '--model',
        'plan',
        '/skill:refactor',
      ],
      { cwd: '/repo' },
    );
  });
});

describe('createDowntimeDeps recordDispatch', () => {
  afterEach(() => {
    resetExecFileAsync();
    resetWorklogDir();
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    }
    tempDirs.length = 0;
  });

  it('adds an audit comment via wl comment add with the herdr-downtime author', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: '{}', stderr: '' });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    await deps.recordDispatch({
      itemId: 'WL-ABC',
      kind: 'plan',
      dispatchedAt: '2026-01-01T00:00:00.000Z',
      cwd: '/repo',
    });

    // The comment is targeted at the dispatch root (event.cwd) via stateless
    // buildWlArgsForRoot — the item's own DB, never the ambient override.
    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      [
        '--worklog-dir',
        '/repo/.worklog',
        'comment',
        'add',
        'WL-ABC',
        '--comment',
        expect.stringContaining('/skill:plan WL-ABC'),
        '--author',
        'herdr-downtime',
        '--json',
      ],
      expect.anything(),
    );
  });

  it('targets the comment at event.cwd (the item root) even when the module override points elsewhere', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: '{}', stderr: '' });
    setExecFileAsync(mockExec as never);
    setWorklogDir('/home/user/projects/SorraAgents/.worklog');

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    await deps.recordDispatch({
      itemId: 'SA-ABC',
      kind: 'plan',
      dispatchedAt: '2026-01-01T00:00:00.000Z',
      cwd: '/home/user/projects/SorraAgents',
    });

    // The audit comment must land on the item in ITS project's DB — the
    // dispatch root event.cwd (WL-0MSI7DQL10016QYX semantics preserved;
    // cross-root leader dispatches target the offer's root, WL-0MTQ14W7L003II5A).
    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      [
        '--worklog-dir',
        '/home/user/projects/SorraAgents/.worklog',
        'comment',
        'add',
        'SA-ABC',
        '--comment',
        expect.stringContaining('/skill:plan SA-ABC'),
        '--author',
        'herdr-downtime',
        '--json',
      ],
      expect.anything(),
    );
  });

  it('writes a JSONL entry to .worklog/downtime-dispatches.log under the cwd', async () => {
    setExecFileAsync(vi.fn().mockResolvedValue({ stdout: '{}', stderr: '' }) as never);
    const cwd = makeTempDir();

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    await deps.recordDispatch({
      itemId: 'WL-ABC',
      kind: 'intake',
      dispatchedAt: '2026-01-01T00:00:00.000Z',
      cwd,
    });

    const raw = readFileSync(join(cwd, '.worklog', DOWNTIME_LOG_FILE), 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.itemId).toBe('WL-ABC');
    expect(entry.kind).toBe('intake');
    expect(entry.dispatchedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('resolves true even when wl comment add fails (comment is not the marker)', async () => {
    setExecFileAsync(vi.fn().mockRejectedValue(new Error('wl boom')) as never);
    const cwd = makeTempDir();
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');

    // The comment write failing must NOT abort the dispatch — the rolling-log
    // marker is the dispatch-suppression source. The log write succeeds, so
    // recordDispatch resolves true (no throw, dispatch proceeds).
    await expect(
      deps.recordDispatch({
        itemId: 'WL-ABC',
        kind: 'plan',
        dispatchedAt: '2026-01-01T00:00:00.000Z',
        cwd,
      }),
    ).resolves.toBe(true);
    // The marker still landed even though the comment failed.
    const raw = readFileSync(join(cwd, '.worklog', DOWNTIME_LOG_FILE), 'utf8');
    expect(raw).toContain('WL-ABC');
  });

  it('resolves false (marker write failed → dispatch aborts) when the log write fails', async () => {
    setExecFileAsync(vi.fn().mockResolvedValue({ stdout: '{}', stderr: '' }) as never);
    const cwd = makeTempDir();
    writeFileSync(join(cwd, '.worklog'), 'not a directory', 'utf8');

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    await expect(
      deps.recordDispatch({
        itemId: 'WL-ABC',
        kind: 'plan',
        dispatchedAt: '2026-01-01T00:00:00.000Z',
        cwd,
      }),
    ).resolves.toBe(false);
  });

  it('skips the wl comment for scheduled-prompt dispatches (noItemComment, AC4)', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: '{}', stderr: '' });
    setExecFileAsync(mockExec as never);
    const cwd = makeTempDir();

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    await deps.recordDispatch({
      itemId: '/skill:refactor',
      kind: 'scheduled',
      dispatchedAt: '2026-01-01T00:00:00.000Z',
      cwd,
      noItemComment: true,
    });

    // There is no work item — no wl comment is attempted; the rolling-log
    // marker is the only trace.
    expect(mockExec).not.toHaveBeenCalled();
    const raw = readFileSync(join(cwd, '.worklog', DOWNTIME_LOG_FILE), 'utf8');
    const entry = JSON.parse(raw.split('\n').filter((l) => l.trim() !== '')[0]) as {
      kind?: string;
      itemId?: string;
    };
    expect(entry.kind).toBe('scheduled');
    expect(entry.itemId).toBe('/skill:refactor');
  });
});

describe('createDowntimeDeps recordError', () => {
  afterEach(() => {
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    }
    tempDirs.length = 0;
  });

  it('writes a JSONL entry to the rolling downtime log under the cwd', async () => {
    const cwd = makeTempDir();

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    await deps.recordError({
      cwd,
      at: '2026-01-01T00:00:00.000Z',
      message: 'Downtime worker: 3 consecutive wl CLI errors',
    });

    const raw = readFileSync(join(cwd, '.worklog', DOWNTIME_LOG_FILE), 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.at).toBe('2026-01-01T00:00:00.000Z');
    expect(entry.message).toContain('3 consecutive');
  });

  it('is fail-closed when the log write fails (e.g. .worklog path is a file)', async () => {
    const cwd = makeTempDir();
    writeFileSync(join(cwd, '.worklog'), 'not a directory', 'utf8');

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    await expect(
      deps.recordError({ cwd, at: '2026-01-01T00:00:00.000Z', message: 'boom' }),
    ).resolves.toBeUndefined();
  });
});

describe('createDowntimeDeps recordDispatchFailure', () => {
  afterEach(() => {
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    }
    tempDirs.length = 0;
  });

  it('writes an outcome:spawn-failed JSONL entry with the error trace under the cwd', async () => {
    const cwd = makeTempDir();

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    await deps.recordDispatchFailure({
      itemId: 'WL-ABC',
      kind: 'plan',
      dispatchedAt: '2026-01-01T00:00:00.000Z',
      cwd,
      stage: 'intake_complete',
      error: 'ENOENT: send-to-pi.sh',
    });

    const raw = readFileSync(join(cwd, '.worklog', DOWNTIME_LOG_FILE), 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    // The failure entry mirrors the marker fields (so the marker readers keep
    // excluding the item exactly as the standing marker does) and adds the
    // outcome + trace so the log distinguishes "attempted" from "opened"
    // (WL-0MSLWJ3I70031Z8U AC2).
    expect(entry).toEqual({
      itemId: 'WL-ABC',
      kind: 'plan',
      dispatchedAt: '2026-01-01T00:00:00.000Z',
      cwd,
      stage: 'intake_complete',
      error: 'ENOENT: send-to-pi.sh',
      outcome: 'spawn-failed',
    });
  });

  it('records the exit-code trace for a non-zero script exit', async () => {
    const cwd = makeTempDir();

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    await deps.recordDispatchFailure({
      itemId: 'WL-ABC',
      kind: 'implement',
      dispatchedAt: '2026-01-01T00:00:00.000Z',
      cwd,
      exitCode: 1,
    });

    const raw = readFileSync(join(cwd, '.worklog', DOWNTIME_LOG_FILE), 'utf8');
    const entry = JSON.parse(raw.split('\n').filter((l) => l.trim() !== '')[0]);
    expect(entry.outcome).toBe('spawn-failed');
    expect(entry.exitCode).toBe(1);
  });

  it('is fail-closed when the log write fails (never crashes the worker)', async () => {
    const cwd = makeTempDir();
    writeFileSync(join(cwd, '.worklog'), 'not a directory', 'utf8');

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    await expect(
      deps.recordDispatchFailure({
        itemId: 'WL-ABC',
        kind: 'plan',
        dispatchedAt: '2026-01-01T00:00:00.000Z',
        cwd,
      }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createDowntimeDeps scheduled-prompts wiring (WL-0MSS1Q5ER007QDKX)
//
// The scheduled-prompts tier reads the project-local config at
// <cwd>/.worklog/scheduled-prompts.json through getDueScheduledPrompt and
// persists lastTriggeredAt through recordScheduledPromptTrigger (atomic
// tmp+rename). Both are fail-closed: absent/malformed config ⇒ no dispatch.
// ---------------------------------------------------------------------------

describe('createDowntimeDeps getDueScheduledPrompt', () => {
  afterEach(() => {
    resetExecFileAsync();
    resetWorklogDir();
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    }
    tempDirs.length = 0;
  });

  const refactor: ScheduledPrompt = {
    id: '/skill:refactor',
    prompt: '/skill:refactor',
    intervalDays: 3,
    lastTriggeredAt: null,
  };

  it('reads the config and returns the first due entry (null lastTriggeredAt = due)', async () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    writeFileSync(
      scheduledPromptsPath(cwd),
      JSON.stringify({ entries: [refactor] }),
      'utf8',
    );

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    const due = await deps.getDueScheduledPrompt(cwd);

    expect(due).toEqual(refactor);
  });

  it('returns null when the only entries are not yet due', async () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    writeFileSync(
      scheduledPromptsPath(cwd),
      JSON.stringify({
        entries: [
          {
            ...refactor,
            lastTriggeredAt: new Date(Date.now() - 86_400_000).toISOString(), // 1 day ago, due in 2
          },
        ],
      }),
      'utf8',
    );

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    expect(await deps.getDueScheduledPrompt(cwd)).toBeNull();
  });

  it('returns null for an absent config (fail-closed, logged)' , async () => {
    const cwd = makeTempDir();
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    expect(await deps.getDueScheduledPrompt(cwd)).toBeNull();
  });

  it('returns null for a malformed config (fail-closed, logged)', async () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    writeFileSync(scheduledPromptsPath(cwd), '{broken json', 'utf8');

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    expect(await deps.getDueScheduledPrompt(cwd)).toBeNull();
  });

  it('skips invalid entries (fail-closed) and still returns the first valid due one', async () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    writeFileSync(
      scheduledPromptsPath(cwd),
      JSON.stringify({
        entries: [
          { id: 'broken', prompt: '', intervalDays: 0, lastTriggeredAt: null },
          refactor,
        ],
      }),
      'utf8',
    );

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    expect(await deps.getDueScheduledPrompt(cwd)).toEqual(refactor);
  });
});

describe('createDowntimeDeps recordScheduledPromptTrigger', () => {
  afterEach(() => {
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    }
    tempDirs.length = 0;
  });

  const refactor: ScheduledPrompt = {
    id: '/skill:refactor',
    prompt: '/skill:refactor',
    intervalDays: 3,
    lastTriggeredAt: null,
  };
  const at = '2026-08-17T12:00:00.000Z';

  it('persists lastTriggeredAt atomically and preserves the other entries', async () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    writeFileSync(
      scheduledPromptsPath(cwd),
      JSON.stringify({ entries: [refactor, { ...refactor, id: 'weekly', intervalDays: 7 }] }),
      'utf8',
    );

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    await expect(deps.recordScheduledPromptTrigger(cwd, '/skill:refactor', at)).resolves.toBe(true);

    const parsed = JSON.parse(readFileSync(scheduledPromptsPath(cwd), 'utf8')) as {
      entries: ScheduledPrompt[];
    };
    expect(parsed.entries.find((e) => e.id === '/skill:refactor')?.lastTriggeredAt).toBe(at);
    expect(parsed.entries.find((e) => e.id === 'weekly')?.lastTriggeredAt).toBeNull();
    // No tmp file left behind (atomic tmp+rename).
    expect(readdirSync(join(cwd, '.worklog'))).toEqual([SCHEDULED_PROMPTS_FILE]);
  });

  it('resolves false when the config is absent or malformed (fail-closed, never throws)', async () => {
    const cwd = makeTempDir();
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    await expect(deps.recordScheduledPromptTrigger(cwd, '/skill:refactor', at)).resolves.toBe(false);

    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    writeFileSync(scheduledPromptsPath(cwd), '{broken', 'utf8');
    await expect(deps.recordScheduledPromptTrigger(cwd, '/skill:refactor', at)).resolves.toBe(false);
  });

  it('resolves false for an unknown entry id (fail-closed)', async () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    writeFileSync(scheduledPromptsPath(cwd), JSON.stringify({ entries: [refactor] }), 'utf8');

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    await expect(deps.recordScheduledPromptTrigger(cwd, 'nope', at)).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Agent-pane association capture (WL-0MSBQUJQX005RAT9)
//
// AC1: when an agent command carrying a work-item ID is dispatched, the
// plugin captures the new pane ID (via --pane-id-file) and records the
// work-item ↔ pane association. AC6: only worklist-spawned agent commands
// are tracked; commands without an ID are not.
// ---------------------------------------------------------------------------

describe('buildSendToPiArgs — pane-id capture flag', () => {
  it('forwards --pane-id-file when provided (with --no-focus)', () => {
    expect(
      buildSendToPiArgs('/skill:implement <id>', '/project', 'code', '/tmp/pane.json'),
    ).toEqual([
      '--no-focus',
      '--cwd',
      '/project',
      '--model',
      'code',
      '--pane-id-file',
      '/tmp/pane.json',
      '/skill:implement <id>',
    ]);
  });

  it('omits --pane-id-file when not provided (backward compatible, --no-focus retained)', () => {
    expect(buildSendToPiArgs('/skill:implement <id>', '/project')).toEqual([
      '--no-focus',
      '--cwd',
      '/project',
      '/skill:implement <id>',
    ]);
  });
});

describe('parsePaneIdFile', () => {
  it('parses the pane_id written by send-to-pi.sh', () => {
    expect(parsePaneIdFile('{"pane_id":"grid-pane-5"}')).toBe('grid-pane-5');
    expect(parsePaneIdFile('{"pane_id": "plain-pane-1"}')).toBe('plain-pane-1');
  });

  it('tolerates log lines prefixed before the JSON', () => {
    expect(parsePaneIdFile('some noise\n{"pane_id":"p1"}')).toBe('p1');
  });

  it('returns undefined for unparseable content', () => {
    expect(parsePaneIdFile('')).toBeUndefined();
    expect(parsePaneIdFile('not json')).toBeUndefined();
    expect(parsePaneIdFile('{"no_pane":1}')).toBeUndefined();
  });
});

describe('capturePaneIdFromFile — dispatch-time association capture', () => {
  it('polls for the pane-id file, records the association, and cleans up', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const unlink = vi.fn();
    let fileExists = false;
    let fileContent = '';

    const promise = capturePaneIdFromFile('WL-ABC', '/tmp/pane.json', record, {
      existsSync: () => fileExists,
      readFile: () => fileContent,
      unlink,
      sleep: async () => {
        // Simulate the pane-id file appearing after the first poll.
        fileExists = true;
        fileContent = '{"pane_id":"grid-pane-5"}';
      },
      now: () => 0,
    });

    const paneId = await promise;
    expect(paneId).toBe('grid-pane-5');
    expect(record).toHaveBeenCalledWith('WL-ABC', 'grid-pane-5');
    expect(unlink).toHaveBeenCalledWith('/tmp/pane.json');
  });

  it('records nothing when the file never appears (split failed)', async () => {
    const record = vi.fn();
    let t = 0;
    const paneId = await capturePaneIdFromFile('WL-ABC', '/tmp/pane.json', record, {
      existsSync: () => false,
      readFile: () => '',
      // Advance the clock past the deadline so the loop terminates (a
      // constant `now` would make the timeout unreachable and spin forever).
      sleep: async () => { t += CAPTURE_TIMEOUT_MS; },
      now: () => t,
    });
    expect(paneId).toBeUndefined();
    expect(record).not.toHaveBeenCalled();
  });

  it('is fail-open: a recording error never throws', async () => {
    const record = vi.fn().mockRejectedValue(new Error('tracker boom'));
    const unlink = vi.fn();
    const paneId = await capturePaneIdFromFile('WL-ABC', '/tmp/pane.json', record, {
      existsSync: () => true,
      readFile: () => '{"pane_id":"p1"}',
      unlink,
      sleep: async () => {},
      now: () => 0,
    });
    expect(paneId).toBe('p1');
    expect(record).toHaveBeenCalledWith('WL-ABC', 'p1');
    expect(unlink).toHaveBeenCalledWith('/tmp/pane.json');
  });

  it('keeps polling while the file is unreadable or mid-write', async () => {
    const record = vi.fn();
    let readable = false;
    const paneId = await capturePaneIdFromFile('WL-ABC', '/tmp/pane.json', record, {
      existsSync: () => true,
      readFile: () => {
        if (!readable) throw new Error('mid-write');
        return '{"pane_id":"p1"}';
      },
      sleep: async () => { readable = true; },
      now: () => 0,
    });
    expect(paneId).toBe('p1');
    expect(record).toHaveBeenCalledWith('WL-ABC', 'p1');
  });

  it('gives up once the timeout is reached', async () => {
    const record = vi.fn();
    let t = 0;
    const paneId = await capturePaneIdFromFile('WL-ABC', '/tmp/pane.json', record, {
      existsSync: () => true,
      readFile: () => 'not json',
      sleep: async () => { t += 200; },
      now: () => t,
    });
    expect(paneId).toBeUndefined();
    expect(record).not.toHaveBeenCalled();
  });
});

describe('createDowntimeDeps rotation wiring (WL-0MSSRED76008LGB6)', () => {
  afterEach(() => {
    resetExecFileAsync();
    resetWorklogDir();
  });

  it('getNextItem rotates within a tied-priority group via the shared cursor file', async () => {
    const cwd = makeTempDir();
    const worklogDir = join(cwd, '.worklog');
    mkdirSync(worklogDir, { recursive: true });
    // Two same-priority candidates; a pre-advanced cursor file selects the second first.
    writeFileSync(
      join(worklogDir, 'downtime-round-robin.json'),
      JSON.stringify({ high: { cursor: 1, version: 2 } }),
    );
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        workItems: [
          { workItem: { id: 'WL-A', title: 'A', status: 'open', priority: 'high', sortIndex: 10 } },
          { workItem: { id: 'WL-B', title: 'B', status: 'open', priority: 'high', sortIndex: 20 } },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    // Cursor 1 % 2 = 1 → selects WL-B first
    const result = await deps.getNextItem('intake_complete', cwd);
    expect(result).toEqual({
      ok: true,
      candidate: { id: 'WL-B', title: 'B', stage: 'intake_complete', status: 'open', sortIndex: 20, priority: 'high' },
    });
  });

  it('getNextItem persists the cursor advance so a second call rotates to the next tied item', async () => {
    const cwd = makeTempDir();
    const worklogDir = join(cwd, '.worklog');
    mkdirSync(worklogDir, { recursive: true });
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        workItems: [
          { workItem: { id: 'WL-A', title: 'A', status: 'open', priority: 'high', sortIndex: 10 } },
          { workItem: { id: 'WL-B', title: 'B', status: 'open', priority: 'high', sortIndex: 20 } },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    const first = await deps.getNextItem('intake_complete', cwd);
    expect(first.ok && first.candidate?.id).toBe('WL-A'); // cursor 0 % 2 = 0

    const second = await deps.getNextItem('intake_complete', cwd);
    expect(second.ok && second.candidate?.id).toBe('WL-B'); // cursor advanced → 1 % 2 = 1
  });
});

// ---------------------------------------------------------------------------
// Background (no-pane) dispatch helpers (WL-0MSJLD1I70045ZUL)
// ---------------------------------------------------------------------------

describe('buildBackgroundLogPath', () => {
  it('places logs under the tmpdir herdr-background-logs directory', () => {
    const path = buildBackgroundLogPath('wl update <id> --priority high');
    expect(path).toContain('herdr-background-logs');
    expect(path.endsWith('.log')).toBe(true);
  });

  it('produces distinct paths for different commands', () => {
    const a = buildBackgroundLogPath('wl update <id> --priority high');
    const b = buildBackgroundLogPath('wl update <id> --priority low');
    expect(a).not.toBe(b);
  });
});

describe('spawnBackgroundShell', () => {
  it('spawns bash -c detached with stdout/stderr redirected to the log file', () => {
    const spawnFn = vi.fn(() => ({ unref: vi.fn() }));
    const openSyncFn = vi.fn(() => 7);
    const child = spawnBackgroundShell(
      'wl reviewed WL-1 false',
      '/project',
      '/tmp/herdr-background-logs/x.log',
      { spawn: spawnFn as never, openSync: openSyncFn },
    );
    expect(spawnFn).toHaveBeenCalledWith(
      'bash',
      ['-c', 'wl reviewed WL-1 false'],
      expect.objectContaining({
        detached: true,
        stdio: ['ignore', 7, 7],
        cwd: '/project',
      }),
    );
    expect(openSyncFn).toHaveBeenCalledWith('/tmp/herdr-background-logs/x.log', 'a');
    expect(child.unref).toHaveBeenCalled();
  });

  it('fires onExit when the background child exits (completion → refresh)', () => {
    let exitHandler: ((code: number | null, signal: string | null) => void) | undefined;
    const child = {
      unref: vi.fn(),
      on: vi.fn((_event: string, cb: (code: number | null, signal: string | null) => void) => {
        exitHandler = cb;
        return child;
      }),
    } as never;
    const onExit = vi.fn();
    spawnBackgroundShell('wl reviewed WL-1 false', '/project', '/tmp/log', {
      spawn: vi.fn(() => child),
      openSync: () => 7,
      onExit,
    });
    expect(child.on).toHaveBeenCalledWith('exit', expect.any(Function));
    // Simulate the child exiting with code 0 — the refresh is triggered.
    exitHandler?.(0, null);
    expect(onExit).toHaveBeenCalledWith(0, null);
  });

  it('fires onExit for a non-zero exit (failure still refreshes)', () => {
    let exitHandler: ((code: number | null, signal: string | null) => void) | undefined;
    const child = {
      unref: vi.fn(),
      on: vi.fn((_event: string, cb: (code: number | null, signal: string | null) => void) => {
        exitHandler = cb;
        return child;
      }),
    } as never;
    const onExit = vi.fn();
    spawnBackgroundShell('false', '/project', '/tmp/log', {
      spawn: vi.fn(() => child),
      openSync: () => 7,
      onExit,
    });
    exitHandler?.(1, null);
    expect(onExit).toHaveBeenCalledWith(1, null);
  });
});

describe('spawnBackgroundPi', () => {
  it('spawns pi -p --mode json with the model and prompt, detached with log redirect', () => {
    const spawnFn = vi.fn(() => ({ unref: vi.fn() }));
    const openSyncFn = vi.fn(() => 9);
    const child = spawnBackgroundPi(
      '/skill:audit WL-1',
      '/project',
      'plan',
      '/tmp/herdr-background-logs/y.log',
      { spawn: spawnFn as never, openSync: openSyncFn },
    );
    expect(spawnFn).toHaveBeenCalledWith(
      'pi',
      ['-p', '--mode', 'json', '--model', 'plan', '/skill:audit WL-1'],
      expect.objectContaining({
        detached: true,
        stdio: ['ignore', 9, 9],
        cwd: '/project',
      }),
    );
    expect(child.unref).toHaveBeenCalled();
  });

  it('omits --model when no model is provided', () => {
    const spawnFn = vi.fn(() => ({ unref: vi.fn() }));
    const openSyncFn = vi.fn(() => 9);
    spawnBackgroundPi(
      '/intake My item',
      '/project',
      undefined,
      '/tmp/herdr-background-logs/z.log',
      { spawn: spawnFn as never, openSync: openSyncFn },
    );
    expect(spawnFn).toHaveBeenCalledWith(
      'pi',
      ['-p', '--mode', 'json', '/intake My item'],
      expect.any(Object),
    );
  });

  it('registers an exit handler when onExit is provided (completion → refresh)', () => {
    const on = vi.fn();
    const child = { on, unref: vi.fn() } as never;
    const onExit = vi.fn();
    spawnBackgroundPi('/skill:audit WL-1', '/project', undefined, '/tmp/log', {
      spawn: vi.fn(() => child),
      openSync: () => 9,
      onExit,
    });
    expect(on).toHaveBeenCalledWith('exit', expect.any(Function));
  });
});
