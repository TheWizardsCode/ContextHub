vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => '/home/test-user/.pi/agent',
}));

/**

 * Unit and integration tests for runWl initialization error detection.

 *

 * These tests verify that:

 * 1. runWl detects the known "not initialized" pattern in CLI stderr and

 *    surfaces a friendly, actionable message

 * 2. Unrelated CLI errors pass through unchanged (no false positives)

 * 3. runBrowseFlow shows the friendly TUI notification when runWl encounters

 *    the initialization error

 *

 * 4. The detection also works when the init error arrives via stdout (JSON mode),

 *    not just stderr (non-JSON mode)

 * 5. The original error text is preserved for debugging (via Error.cause)

 *

 * Run: npx vitest run packages/tui/tests/runWl-init-detection.test.ts

 *

 * Run: npx vitest run packages/tui/tests/runWl-init-detection.test.ts

 */



import { vi, describe, it, expect, beforeEach, type Mock } from 'vitest';


// ── Module-level mocks ──────────────────────────────────────────────────
// Mock child_process.execFile so we can simulate CLI error output without
// requiring a real .worklog directory or installed worklog CLI.

const mockExecFile = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

// ── Imports (resolved after mock is installed) ──────────────────────────

import { createDefaultListWorkItems, createWorklogBrowseExtension } from '../extensions/index.js';

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Simulate a callback-based execFile failure.
 *
 * The real execFile(file, args, options, callback) invokes callback(err, result)
 * on completion. promisify(execFile) wraps this so calling execFileAsync() returns
 * a Promise that rejects when the callback is called with an error.
 */
function mockExecFailure(errorProps: Record<string, unknown>): void {
  mockExecFile.mockImplementationOnce(
    (_binary: string, _args: string[], _options: object, callback: (err: Error | null) => void) => {
      const err = Object.assign(new Error('Command failed'), errorProps);
      callback(err);
    },
  );
}

/**
 * Simulate a successful execFile call returning stdout.
 */
function mockExecSuccess(stdout: string): void {
  mockExecFile.mockImplementationOnce(
    (
      _binary: string,
      _args: string[],
      _options: object,
      callback: (err: Error | null, result: { stdout: string }) => void,
    ) => {
      callback(null, { stdout });
    },
  );
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('runWl initialization error detection (unit)', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  describe('detecting known not-initialized pattern', () => {
    it('transforms the known init-error stderr into a friendly message (wl not found, worklog fails)', async () => {
      // First binary (wl) fails with ENOENT — runWl continues to next binary
      mockExecFailure({ code: 'ENOENT' });
      // Second binary (worklog) fails with the known init pattern
      mockExecFailure({
        stderr:
          'worklog: not initialized in this checkout/worktree. Run "wl init" to set up this location.',
      });

      const listItems = createDefaultListWorkItems();
      await expect(listItems()).rejects.toThrow(
        'Worklog is not initialized in this checkout/worktree. Run "wl init" to set up this location.',
      );
    });

    it('transforms the known init-error stderr when only worklog binary is tried (wl skipped)', async () => {
      // Only one call — worklog binary fails with init error
      mockExecFailure({
        stderr:
          'worklog: not initialized in this checkout/worktree. Run "wl init" to set up this location.',
      });

      const listItems = createDefaultListWorkItems();
      await expect(listItems()).rejects.toThrow(
        'Worklog is not initialized in this checkout/worktree.',
      );
    });

    it('handles the error with different character casing (case-insensitive)', async () => {
      mockExecFailure({
        stderr:
          'Worklog: Not Initialized in this checkout/worktree. Run "wl init" to set up this location.',
      });

      const listItems = createDefaultListWorkItems();
      await expect(listItems()).rejects.toThrow(
        'Worklog is not initialized',
      );
    });
  });

  describe('pass-through for unrelated CLI errors', () => {
    it('passes through unrelated CLI errors unchanged', async () => {
      mockExecFailure({
        stderr: 'wl: unknown command. Use --help to see available commands.',
      });

      const listItems = createDefaultListWorkItems();
      await expect(listItems()).rejects.toThrow(
        'wl: unknown command. Use --help to see available commands.',
      );
    });

    it('passes through missing .worklog directory errors unchanged when pattern does not match', async () => {
      // A different error about .worklog that is NOT the known init pattern
      mockExecFailure({
        stderr: '.worklog not found in current directory tree.',
      });

      const listItems = createDefaultListWorkItems();
      await expect(listItems()).rejects.toThrow(
        '.worklog not found in current directory tree.',
      );
    });

    it('passes through JSON parsing errors unchanged', async () => {
      mockExecFailure({
        stderr: 'Error: Failed to parse JSON output',
      });

      const listItems = createDefaultListWorkItems();
      await expect(listItems()).rejects.toThrow(
        'Error: Failed to parse JSON output',
      );
    });

    it('passes through stderr with binary name mismatch errors unchanged', async () => {
      mockExecFailure({
        stderr: 'wl sync: cannot find remote branch',
      });

      const listItems = createDefaultListWorkItems();
      await expect(listItems()).rejects.toThrow(
        'wl sync: cannot find remote branch',
      );
    });

    it('passes through errors where stderr is absent and falls back to message', async () => {
      mockExecFailure({
        stderr: '',
        message: 'generic error without stderr',
      });

      const listItems = createDefaultListWorkItems();
      await expect(listItems()).rejects.toThrow(
        'generic error without stderr',
      );
    });

    it('passes through errors with only non-matching stderr content', async () => {
      mockExecFailure({
        stderr: 'TypeError: Cannot read properties of undefined',
      });

      const listItems = createDefaultListWorkItems();
      await expect(listItems()).rejects.toThrow(
        'TypeError: Cannot read properties of undefined',
      );
    });
  });

  describe('detection via stdout (JSON mode)', () => {
    it('detects the init error when it arrives via stdout (JSON mode, --json flag)', async () => {
      // Simulate error where stderr is empty and error is in stdout (JSON mode)
      mockExecFailure({
        stderr: '',
        stdout: JSON.stringify({
          success: false,
          initialized: false,
          error: 'Worklog system is not initialized. Run "worklog init" first.',
        }),
      });

      const listItems = createDefaultListWorkItems();
      await expect(listItems()).rejects.toThrow(
        'Worklog is not initialized in this checkout/worktree. Run "wl init" to set up this location.',
      );
    });

    it('preserves the original error text in Error.cause for debugging', async () => {
      const originalStdout = JSON.stringify({
        success: false,
        initialized: false,
        error: 'Worklog system is not initialized. Run "worklog init" first.',
      });

      mockExecFailure({
        stderr: '',
        stdout: originalStdout,
      });

      const listItems = createDefaultListWorkItems();
      try {
        await listItems();
        expect.unreachable('should have thrown');
      } catch (err: any) {
        expect(err.cause).toBeDefined();
        expect(err.cause.stdout).toBe(originalStdout);
      }
    });

    it('passes through unrelated JSON errors in stdout unchanged (no false positive)', async () => {
      mockExecFailure({
        stderr: '',
        stdout: JSON.stringify({
          success: false,
          error: 'Some unrelated JSON error',
        }),
      });

      const listItems = createDefaultListWorkItems();
      await expect(listItems()).rejects.toThrow(
        'Some unrelated JSON error',
      );
    });

    it('passes through stdout with only non-matching JSON error', async () => {
      mockExecFailure({
        stderr: '',
        stdout: JSON.stringify({ success: false, error: 'Unknown work item ID' }),
      });

      const listItems = createDefaultListWorkItems();
      await expect(listItems()).rejects.toThrow(
        'Unknown work item ID',
      );
    });

    it('detects the CLI non-JSON stderr format (Error: Worklog system is not initialized.)', async () => {
      mockExecFailure({
        stderr: 'Error: Worklog system is not initialized.\nRun "worklog init" to initialize the system.',
      });

      const listItems = createDefaultListWorkItems();
      await expect(listItems()).rejects.toThrow(
        'Worklog is not initialized in this checkout/worktree. Run "wl init" to set up this location.',
      );
    });
  });

  describe('edge cases', () => {
    it('passes through when both binaries are not found (ENOENT for both)', async () => {
      mockExecFailure({ code: 'ENOENT' });
      mockExecFailure({ code: 'ENOENT' });

      const listItems = createDefaultListWorkItems();
      await expect(listItems()).rejects.toThrow(
        /Unable to execute wl\/worklog CLI/,
      );
    });
  });
});

describe('stdout / JSON mode detection (stdout fallback)', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it('detects init error when it arrives via stdout (JSON mode)', async () => {
    // Simulate the CLI's JSON-mode output: error goes to stdout
    mockExecFailure({
      stdout: JSON.stringify({
        success: false,
        initialized: false,
        error: 'Worklog system is not initialized. Run "worklog init" first.',
      }, null, 2),
      stderr: '',
    });

    const listItems = createDefaultListWorkItems();
    await expect(listItems()).rejects.toThrow(
      'Worklog is not initialized in this checkout/worktree. Run "wl init" to set up this location.',
    );
  });

  it('passes through unrelated JSON errors when they arrive via stdout', async () => {
    mockExecFailure({
      stdout: JSON.stringify({
        success: false,
        error: 'Some other error message entirely.',
      }),
      stderr: '',
    });

    const listItems = createDefaultListWorkItems();
    await expect(listItems()).rejects.toThrow(
      'Some other error message entirely.',
    );
  });

  it('passes through unrelated stdout when first binary ENOENT, second returns empty JSON', async () => {
    mockExecFailure({ code: 'ENOENT' });
    mockExecFailure({
      stdout: '{}',
      stderr: '',
    });

    const listItems = createDefaultListWorkItems();
    // The worklog binary ran but returned `{}` — this is passed through as-is
    // since it doesn't contain the not-initialized pattern.
    await expect(listItems()).rejects.toThrow('{}');
  });

  it('handles stdout-only error with non-JSON known pattern (edge case)', async () => {
    // Simulate a scenario where the known init message somehow lands in stdout
    // without stdout being valid JSON (unlikely but should be handled)
    mockExecFailure({
      stdout: 'worklog: not initialized in this checkout/worktree. Run "wl init" to set up this location.',
      stderr: '',
    });

    const listItems = createDefaultListWorkItems();
    await expect(listItems()).rejects.toThrow(
      'Worklog is not initialized in this checkout/worktree. Run "wl init" to set up this location.',
    );
  });
});

describe('runBrowseFlow notification path (integration)', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it('shows the friendly notification when runWl encounters the initialization error', async () => {
    // Both binaries fail — wl with ENOENT, worklog with init error
    mockExecFailure({ code: 'ENOENT' });
    mockExecFailure({
      stderr:
        'worklog: not initialized in this checkout/worktree. Run "wl init" to set up this location.',
    });

    const notify = vi.fn();
    const registerCommand = vi.fn();
    const registerShortcut = vi.fn();
    const on = vi.fn();

    // Create extension instance and register with mock Pi API
    const ext = createWorklogBrowseExtension();
    ext({
      registerCommand,
      registerShortcut,
      on,
    } as any);

    // Find the registered /wl command handler
    const wlCommand = registerCommand.mock.calls.find(
      (call: [string]) => call[0] === 'wl',
    );
    expect(wlCommand).toBeDefined();
    const handler = wlCommand[1].handler;

    // Invoke the handler with a mock context
    await handler('', { ui: { notify } });

    // Should show the friendly notification
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('Worklog is not initialized'),
      'error',
    );
  });

  it('shows raw error text for unrelated CLI errors (no false positive)', async () => {
    mockExecFailure({
      stderr: 'wl: unknown command',
    });

    const notify = vi.fn();
    const registerCommand = vi.fn();
    const registerShortcut = vi.fn();
    const on = vi.fn();

    const ext = createWorklogBrowseExtension();
    ext({ registerCommand, registerShortcut, on } as any);

    const wlCommand = registerCommand.mock.calls.find(
      (call: [string]) => call[0] === 'wl',
    );
    const handler = wlCommand[1].handler;

    await handler('', { ui: { notify } });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('wl: unknown command'),
      'error',
    );
  });

  it('shows the friendly notification when init error arrives via stdout (JSON mode)', async () => {
    mockExecFailure({
      stderr: '',
      stdout: JSON.stringify({
        success: false,
        initialized: false,
        error: 'Worklog system is not initialized. Run "worklog init" first.',
      }),
    });

    const notify = vi.fn();
    const registerCommand = vi.fn();
    const registerShortcut = vi.fn();
    const on = vi.fn();

    const ext = createWorklogBrowseExtension();
    ext({ registerCommand, registerShortcut, on } as any);

    const wlCommand = registerCommand.mock.calls.find(
      (call: [string]) => call[0] === 'wl',
    );
    const handler = wlCommand[1].handler;

    await handler('', { ui: { notify } });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('Worklog is not initialized'),
      'error',
    );
  });

  it('shows raw error text for unrelated JSON errors in stdout (no false positive)', async () => {
    mockExecFailure({
      stderr: '',
      stdout: JSON.stringify({ success: false, error: 'Unknown work item ID' }),
    });

    const notify = vi.fn();
    const registerCommand = vi.fn();
    const registerShortcut = vi.fn();
    const on = vi.fn();

    const ext = createWorklogBrowseExtension();
    ext({ registerCommand, registerShortcut, on } as any);

    const wlCommand = registerCommand.mock.calls.find(
      (call: [string]) => call[0] === 'wl',
    );
    const handler = wlCommand[1].handler;

    await handler('', { ui: { notify } });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('Unknown work item ID'),
      'error',
    );
  });

  it('does not crash the TUI when the extension is run in an initialized checkout', async () => {
    // Simulate successful CLI output
    const validOutput = JSON.stringify({
      results: [{ workItem: { id: 'WL-001', title: 'Test', status: 'open' } }],
    });
    mockExecSuccess(validOutput);

    const notify = vi.fn();
    const registerCommand = vi.fn();
    const registerShortcut = vi.fn();
    const on = vi.fn();
    const setWidget = vi.fn();

    const ext = createWorklogBrowseExtension();
    ext({ registerCommand, registerShortcut, on } as any);

    const wlCommand = registerCommand.mock.calls.find(
      (call: [string]) => call[0] === 'wl',
    );
    const handler = wlCommand[1].handler;

    await handler('', { ui: { notify, setWidget, custom: vi.fn(), setEditorText: vi.fn() } });

    // Should NOT show any error notification
    const errorNotifications = notify.mock.calls.filter(
      (call: [string, string]) => call[1] === 'error',
    );
    expect(errorNotifications).toHaveLength(0);
  });
});
