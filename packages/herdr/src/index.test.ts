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
  createDowntimeDeps,
  capturePaneIdFromFile,
  parsePaneIdFile,
  CAPTURE_TIMEOUT_MS,
} from './index.js';
import { DOWNTIME_LOG_FILE } from './downtime-log.js';
import { DOWNTIME_WL_TIMEOUT_MS } from './downtime-worker.js';
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
  it('includes --model <model> for agent commands with a model', () => {
    expect(buildSendToPiArgs('/skill:implement <id>', '/project', 'code')).toEqual([
      '--cwd',
      '/project',
      '--model',
      'code',
      '/skill:implement <id>',
    ]);
  });

  it('omits --model when no model is provided', () => {
    expect(buildSendToPiArgs('/skill:implement <id>', '/project')).toEqual([
      '--cwd',
      '/project',
      '/skill:implement <id>',
    ]);
  });

  it('strips the /prompt: prefix and keeps the model', () => {
    expect(buildSendToPiArgs('/prompt:Review the item', '/project', 'author')).toEqual([
      '--cwd',
      '/project',
      '--model',
      'author',
      'Review the item',
    ]);
  });

  it('passes /plan with the plan model', () => {
    expect(buildSendToPiArgs('/plan <id>', '/project', 'plan')).toEqual([
      '--cwd',
      '/project',
      '--model',
      'plan',
      '/plan <id>',
    ]);
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

  it('binds P-p to the free-form prompt and P-a to the audit-gaps prompt', () => {
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

  it('getNextItem runs wl next --stage and parses the first workItem', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ success: true, workItem: { id: 'WL-ABC', title: 'Some task' } }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    const result = await deps.getNextItem('intake_complete');

    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      ['next', '--stage', 'intake_complete', '--json'],
      expect.anything(),
    );
    expect(result).toEqual({
      ok: true,
      candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
    });
  });

  it('getNextItem passes --worklog-dir when the tab resolved a worklog root', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ success: true, workItem: { id: 'SA-ABC', title: 'Sorra task' } }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);
    setWorklogDir('/home/user/projects/SorraAgents/.worklog');

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    const result = await deps.getNextItem('intake_complete');

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
        '--json',
      ],
      expect.anything(),
    );
    expect(result).toEqual({ ok: true, candidate: { id: 'SA-ABC', title: 'Sorra task', stage: 'intake_complete' } });
  });

  it('getNextItem reports ok:true with no candidate when wl reports no item', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ success: false, workItem: null, reason: 'none' }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    expect(await deps.getNextItem('idea')).toEqual({ ok: true, candidate: null });
  });

  it('getNextItem fails closed ({ok:false}) when wl errors', async () => {
    setExecFileAsync(vi.fn().mockRejectedValue(new Error('wl boom')) as never);
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    expect(await deps.getNextItem('idea')).toEqual({ ok: false });
  });

  it('getNextItem passes a bounded timeout so a hung wl fails closed', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ success: true, workItem: { id: 'WL-ABC', title: 'Some task' } }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    await deps.getNextItem('intake_complete');

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

      const resultPromise = deps.getNextItem('idea');
      await vi.advanceTimersByTimeAsync(DOWNTIME_WL_TIMEOUT_MS - 1);
      // Still pending just before the timeout — no premature resolution.
      await vi.advanceTimersByTimeAsync(1);
      await expect(resultPromise).resolves.toEqual({ ok: false });

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
    const result = await deps.getNextAuditCandidate();

    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      ['list', '--status', 'completed', '--stage', 'in_review', '--json'],
      expect.anything(),
    );
    expect(result).toEqual({ id: 'WL-STALE', title: 'Stale audit', stage: 'audit' });
  });

  it('getNextAuditCandidate returns null when no stale/missing-audit item exists', async () => {
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
    expect(await deps.getNextAuditCandidate()).toBeNull();
  });

  it('getNextAuditCandidate fails closed (null) when wl errors', async () => {
    setExecFileAsync(vi.fn().mockRejectedValue(new Error('wl boom')) as never);
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    expect(await deps.getNextAuditCandidate()).toBeNull();
  });

  it('getNextAuditCandidate passes a bounded timeout so a hung wl fails closed', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ success: true, count: 0, workItems: [] }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    await deps.getNextAuditCandidate();

    // AC1: the audit-tier invocation must carry the bounded timeout too.
    const [, , options] = mockExec.mock.calls[0];
    expect(options).toMatchObject({ timeout: DOWNTIME_WL_TIMEOUT_MS });
  });

  it('getNextAuditCandidate fails closed (null) within the timeout when wl hangs', async () => {
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

      const resultPromise = deps.getNextAuditCandidate();
      await vi.advanceTimersByTimeAsync(DOWNTIME_WL_TIMEOUT_MS);
      await expect(resultPromise).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('getNextAuditCandidate fails closed (null) on malformed wl output', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: 'not json', stderr: '' });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    expect(await deps.getNextAuditCandidate()).toBeNull();
  });

  it('claimItem runs wl update --status in_progress --assignee', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    await deps.claimItem('WL-ABC');

    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      ['update', 'WL-ABC', '--status', 'in_progress', '--assignee', 'Map', '--json'],
      expect.anything(),
    );
  });

  it('spawnAgentPane spawns send-to-pi.sh with the derived pane name and args', async () => {
    const spawnFn = vi.fn(() => ({ unref: vi.fn() }));
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
    const spawnFn = vi.fn(() => ({ unref: vi.fn() }));
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
    const spawnFn = vi.fn(() => ({ unref: vi.fn() }));
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

    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      [
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

  it('passes --worklog-dir to wl comment add when the tab resolved a worklog root', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: '{}', stderr: '' });
    setExecFileAsync(mockExec as never);
    setWorklogDir('/home/user/projects/SorraAgents/.worklog');

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');
    await deps.recordDispatch({
      itemId: 'SA-ABC',
      kind: 'plan',
      dispatchedAt: '2026-01-01T00:00:00.000Z',
      cwd: '/repo',
    });

    // The audit comment must land on the item in ITS project's DB, not the
    // plugin process's cwd (WL-0MSI7DQL10016QYX).
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

  it('is fail-closed when wl comment add fails (no throw, dispatch unaffected)', async () => {
    setExecFileAsync(vi.fn().mockRejectedValue(new Error('wl boom')) as never);
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map');

    await expect(
      deps.recordDispatch({
        itemId: 'WL-ABC',
        kind: 'plan',
        dispatchedAt: '2026-01-01T00:00:00.000Z',
        cwd: '/repo',
      }),
    ).resolves.toBeUndefined();
  });

  it('is fail-closed when the log write fails (e.g. .worklog path is a file)', async () => {
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
    ).resolves.toBeUndefined();
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

// ---------------------------------------------------------------------------
// Agent-pane association capture (WL-0MSBQUJQX005RAT9)
//
// AC1: when an agent command carrying a work-item ID is dispatched, the
// plugin captures the new pane ID (via --pane-id-file) and records the
// work-item ↔ pane association. AC6: only worklist-spawned agent commands
// are tracked; commands without an ID are not.
// ---------------------------------------------------------------------------

describe('buildSendToPiArgs — pane-id capture flag', () => {
  it('forwards --pane-id-file when provided', () => {
    expect(
      buildSendToPiArgs('/skill:implement <id>', '/project', 'code', '/tmp/pane.json'),
    ).toEqual([
      '--cwd',
      '/project',
      '--model',
      'code',
      '--pane-id-file',
      '/tmp/pane.json',
      '/skill:implement <id>',
    ]);
  });

  it('omits --pane-id-file when not provided (backward compatible)', () => {
    expect(buildSendToPiArgs('/skill:implement <id>', '/project')).toEqual([
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
