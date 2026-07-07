/**
 * Unit tests for the activity-indicator module.
 *
 * Verifies that:
 * - Built-in Pi commands are correctly identified and excluded
 * - Skill commands are properly extracted
 * - Input events correctly set/clear the indicator
 * - Session lifecycle events (startup, new, resume) handle the indicator correctly
 * - Terminal width truncation works
 * - Command extraction from input text works
 *
 * Run: npx vitest run packages/tui/tests/activity-indicator.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from '@earendil-works/pi-coding-agent';

// We import the module but mock the dependencies for unit testing
// Since activity-indicator.ts exports functions that operate on ctx.ui,
// we test the core logic by creating mock contexts and calling the exported functions.

// Mock the wl-integration module before importing the module under test
vi.mock('../extensions/wl-integration.js', () => ({
  runWl: vi.fn(),
  wlEvents: { on: vi.fn(), emit: vi.fn(), removeListener: vi.fn() },
}));

// Import the module under test
import {
  registerActivityIndicator,
  showActivity,
  clearActivity,
  detectWorkItemId,
  BUILTIN_COMMANDS,
  ACTIVITY_STATUS_KEY,
} from '../extensions/Worklog/activity-indicator.js';

// Import the mocked module for controlling test behavior
import { runWl } from '../extensions/wl-integration.js';
const mockRunWl = runWl as ReturnType<typeof vi.fn>;

// Re-import for type use
import type { InputEvent, SessionStartEvent } from '@earendil-works/pi-coding-agent';

describe('BUILTIN_COMMANDS', () => {
  it('contains all expected built-in Pi commands', () => {
    const expectedCommands = [
      '/login', '/logout', '/model', '/scoped-models', '/settings',
      '/resume', '/new', '/name', '/session', '/tree', '/trust',
      '/fork', '/clone', '/compact', '/copy', '/export', '/share',
      '/reload', '/hotkeys', '/changelog', '/quit',
    ];
    for (const cmd of expectedCommands) {
      expect(BUILTIN_COMMANDS.has(cmd)).toBe(true);
    }
  });

  it('does NOT contain extension commands', () => {
    expect(BUILTIN_COMMANDS.has('/wl')).toBe(false);
    expect(BUILTIN_COMMANDS.has('/skill:audit')).toBe(false);
    expect(BUILTIN_COMMANDS.has('/custom-cmd')).toBe(false);
  });

  it('does NOT contain skill commands', () => {
    expect(BUILTIN_COMMANDS.has('/skill:implement')).toBe(false);
    expect(BUILTIN_COMMANDS.has('/skill:audit')).toBe(false);
  });
});

describe('ACTIVITY_STATUS_KEY', () => {
  it('uses a descriptive key for the footer status', () => {
    expect(ACTIVITY_STATUS_KEY).toBe('worklog-activity');
  });
});

describe('showActivity', () => {
  it('sets the activity status with a prefix indicator', () => {
    const setStatus = vi.fn();
    const theme = { fg: vi.fn((_color: string, text: string) => text) };
    const ctx = { ui: { setStatus, theme } };

    showActivity(ctx as any, '/wl');

    expect(setStatus).toHaveBeenCalledWith(
      ACTIVITY_STATUS_KEY,
      expect.stringContaining('⏵')
    );
    expect(setStatus).toHaveBeenCalledWith(
      ACTIVITY_STATUS_KEY,
      expect.stringContaining('/wl')
    );
  });

  it('truncates long activity text to fit terminal width', () => {
    const setStatus = vi.fn();
    const theme = { fg: vi.fn((_color: string, text: string) => text) };
    const ctx = { ui: { setStatus, theme } };

    const longText = '/wl ' + 'a'.repeat(500);
    showActivity(ctx as any, longText);

    expect(setStatus).toHaveBeenCalledOnce();
    const calledWith = setStatus.mock.calls[0][1] as string;
    // Should not include the full 500 'a's
    expect(calledWith.length).toBeLessThan(500);
    // Should have the prefix
    expect(calledWith).toContain('⏵');
  });

  it('applies theme accent color to the activity text', () => {
    const setStatus = vi.fn();
    const theme = { fg: vi.fn((_color: string, text: string) => text) };
    const ctx = { ui: { setStatus, theme } };

    showActivity(ctx as any, '/wl list');

    expect(theme.fg).toHaveBeenCalledWith('accent', expect.any(String));
  });

  it('is a no-op when showIndicator is false', () => {
    const setStatus = vi.fn();
    const theme = { fg: vi.fn((_color: string, text: string) => text) };
    const ctx = { ui: { setStatus, theme } };

    showActivity(ctx as any, '/wl', false);

    expect(setStatus).not.toHaveBeenCalled();
    expect(theme.fg).not.toHaveBeenCalled();
  });

  it('sets the indicator when showIndicator is true (explicit)', () => {
    const setStatus = vi.fn();
    const theme = { fg: vi.fn((_color: string, text: string) => text) };
    const ctx = { ui: { setStatus, theme } };

    showActivity(ctx as any, '/wl', true);

    expect(setStatus).toHaveBeenCalledWith(
      ACTIVITY_STATUS_KEY,
      expect.stringContaining('/wl')
    );
  });

  it('defaults to enabled when showIndicator is not provided', () => {
    const setStatus = vi.fn();
    const theme = { fg: vi.fn((_color: string, text: string) => text) };
    const ctx = { ui: { setStatus, theme } };

    showActivity(ctx as any, '/wl');

    expect(setStatus).toHaveBeenCalledWith(
      ACTIVITY_STATUS_KEY,
      expect.stringContaining('/wl')
    );
  });
});

describe('clearActivity', () => {
  it('clears the activity status with undefined', () => {
    const setStatus = vi.fn();
    const ctx = { ui: { setStatus } };

    clearActivity(ctx as any);

    expect(setStatus).toHaveBeenCalledWith(ACTIVITY_STATUS_KEY, undefined);
  });
});

describe('detectWorkItemId', () => {
  it('detects a standard WL- prefixed work item ID', () => {
    const result = detectWorkItemId('/intake WL-0MQL0T5TR0060AEH');
    expect(result).toBe('WL-0MQL0T5TR0060AEH');
  });

  it('detects a SA- prefixed work item ID', () => {
    const result = detectWorkItemId('/implement SA-0MPYMFZXO0004ZU4');
    expect(result).toBe('SA-0MPYMFZXO0004ZU4');
  });

  it('returns null for text without a work item ID', () => {
    expect(detectWorkItemId('/wl list')).toBeNull();
    expect(detectWorkItemId('/model')).toBeNull();
    expect(detectWorkItemId('Hello world')).toBeNull();
    expect(detectWorkItemId('')).toBeNull();
  });

  it('returns null for short ID-like patterns (under 15 chars after dash)', () => {
    expect(detectWorkItemId('/intake WL-1234')).toBeNull();
    expect(detectWorkItemId('WL-abc')).toBeNull();
  });

  it('returns the first ID when multiple IDs are present', () => {
    const text = '/implement WL-0MQL0T5TR0060AEH and WL-0MQLG8PK80041FM3';
    const result = detectWorkItemId(text);
    expect(result).toBe('WL-0MQL0T5TR0060AEH');
  });

  it('detects an ID at the start of the text', () => {
    expect(detectWorkItemId('WL-0MQL0T5TR0060AEH is the ID')).toBe('WL-0MQL0T5TR0060AEH');
  });

  it('detects an ID at the end of the text', () => {
    expect(detectWorkItemId('Process item WL-0MQL0T5TR0060AEH')).toBe('WL-0MQL0T5TR0060AEH');
  });

  it('returns null for ID-like patterns that are part of longer words', () => {
    // The regex uses \b word boundary to ensure the prefix starts on a
    // word boundary, preventing false positives when text like
    // "PREFIXWL-..." is encountered
    expect(detectWorkItemId('PREFIXWL-0MQL0T5TR0060AEH')).toBeNull();
  });
});

describe('registerActivityIndicator - input events', () => {
  let pi: Partial<ExtensionAPI>;
  let inputHandlers: Array<(event: InputEvent, ctx: ExtensionContext) => Promise<any>>;
  let sessionStartHandlers: Array<(event: SessionStartEvent, ctx: ExtensionContext) => Promise<any>>;

  beforeEach(() => {
    inputHandlers = [];
    sessionStartHandlers = [];
    pi = {
      on: vi.fn((event: string, handler: any) => {
        if (event === 'input') {
          inputHandlers.push(handler);
        } else if (event === 'session_start') {
          sessionStartHandlers.push(handler);
        }
      }) as any,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createMockContext(): ExtensionContext {
    const setStatus = vi.fn();
    const theme = { fg: vi.fn((_color: string, text: string) => text) };
    return {
      ui: { setStatus, theme } as unknown as ExtensionUIContext,
      mode: 'tui',
      hasUI: true,
      cwd: '/test',
      sessionManager: {
        getBranch: vi.fn().mockReturnValue([]),
        getEntries: vi.fn().mockReturnValue([]),
      } as any,
      model: undefined,
      modelRegistry: {} as any,
      isIdle: vi.fn().mockReturnValue(true),
      isProjectTrusted: vi.fn().mockReturnValue(true),
      signal: undefined,
      abort: vi.fn(),
      hasPendingMessages: vi.fn().mockReturnValue(false),
      shutdown: vi.fn(),
      getContextUsage: vi.fn(),
      compact: vi.fn(),
      getSystemPrompt: vi.fn().mockReturnValue(''),
    };
  }

  function createMockContext(): ExtensionContext {
    const setStatus = vi.fn();
    const theme = { fg: vi.fn((_color: string, text: string) => text) };
    return {
      ui: { setStatus, theme } as unknown as ExtensionUIContext,
      mode: 'tui',
      hasUI: true,
      cwd: '/test',
      sessionManager: {
        getBranch: vi.fn().mockReturnValue([]),
        getEntries: vi.fn().mockReturnValue([]),
      } as any,
      model: undefined,
      modelRegistry: {} as any,
      isIdle: vi.fn().mockReturnValue(true),
      isProjectTrusted: vi.fn().mockReturnValue(true),
      signal: undefined,
      abort: vi.fn(),
      hasPendingMessages: vi.fn().mockReturnValue(false),
      shutdown: vi.fn(),
      getContextUsage: vi.fn(),
      compact: vi.fn(),
      getSystemPrompt: vi.fn().mockReturnValue(''),
    };
  }

  it('sets indicator for /skill:name commands', async () => {
    registerActivityIndicator(pi as ExtensionAPI);
    expect(inputHandlers.length).toBe(1);

    const ctx = createMockContext();
    const event: InputEvent = {
      type: 'input',
      text: '/skill:audit',
      source: 'interactive',
    };

    const result = await inputHandlers[0](event, ctx);

    expect(result).toEqual({ action: 'continue' });
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      ACTIVITY_STATUS_KEY,
      expect.stringContaining('skill:audit')
    );
  });

  it('sets indicator for /skill:name with arguments (includes the ID)', async () => {
    registerActivityIndicator(pi as ExtensionAPI);

    const ctx = createMockContext();
    const event: InputEvent = {
      type: 'input',
      text: '/skill:implement WL-123',
      source: 'interactive',
    };

    await inputHandlers[0](event, ctx);

    // Should include the full input after /skill: prefix (skill name + ID)
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      ACTIVITY_STATUS_KEY,
      expect.stringContaining('implement WL-123')
    );
  });

  it('leaves indicator unchanged for free-form text (no / prefix)', async () => {
    registerActivityIndicator(pi as ExtensionAPI);

    const ctx = createMockContext();
    const event: InputEvent = {
      type: 'input',
      text: 'Hello, how can I help?',
      source: 'interactive',
    };

    await inputHandlers[0](event, ctx);

    // Free-form text should NOT clear the indicator
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it('leaves indicator unchanged for built-in Pi commands', async () => {
    registerActivityIndicator(pi as ExtensionAPI);

    const ctx = createMockContext();
    const event: InputEvent = {
      type: 'input',
      text: '/model',
      source: 'interactive',
    };

    await inputHandlers[0](event, ctx);

    // Built-in commands should NOT clear the indicator
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it('leaves indicator unchanged for built-in Pi commands with arguments', async () => {
    registerActivityIndicator(pi as ExtensionAPI);

    const ctx = createMockContext();
    const event: InputEvent = {
      type: 'input',
      text: '/settings thinking high',
      source: 'interactive',
    };

    await inputHandlers[0](event, ctx);

    // Built-in commands with arguments should NOT clear the indicator
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it('leaves indicator unchanged for /new command (session_start handles clearing)', async () => {
    registerActivityIndicator(pi as ExtensionAPI);

    const ctx = createMockContext();
    const event: InputEvent = {
      type: 'input',
      text: '/new',
      source: 'interactive',
    };

    await inputHandlers[0](event, ctx);

    // /new is handled by session_start (reason: "new"), not the input handler
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it('sets indicator showing full input for unknown /-prefixed text', async () => {
    registerActivityIndicator(pi as ExtensionAPI);

    const ctx = createMockContext();
    const event: InputEvent = {
      type: 'input',
      text: '/intake WL-123',
      source: 'interactive',
    };

    await inputHandlers[0](event, ctx);

    // Should show the full input including the ID, not just the first word
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      ACTIVITY_STATUS_KEY,
      expect.stringContaining('/intake WL-123')
    );
  });

  it('sets indicator with full input for command with long arguments', async () => {
    registerActivityIndicator(pi as ExtensionAPI);

    const ctx = createMockContext();
    const event: InputEvent = {
      type: 'input',
      text: '/intake WL-0MQL0T5TR0060AEH',
      source: 'interactive',
    };

    await inputHandlers[0](event, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      ACTIVITY_STATUS_KEY,
      expect.stringContaining('/intake WL-0MQL0T5TR0060AEH')
    );
  });

  it('does not set indicator for /skill: command when isActivityEnabled returns false', async () => {
    registerActivityIndicator(pi as ExtensionAPI, () => false);
    expect(inputHandlers.length).toBe(1);

    const ctx = createMockContext();
    const event: InputEvent = {
      type: 'input',
      text: '/skill:audit',
      source: 'interactive',
    };

    await inputHandlers[0](event, ctx);

    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it('does not set indicator for unknown /-prefixed command when isActivityEnabled returns false', async () => {
    registerActivityIndicator(pi as ExtensionAPI, () => false);

    const ctx = createMockContext();
    const event: InputEvent = {
      type: 'input',
      text: '/intake WL-0MQL0T5TR0060AEH',
      source: 'interactive',
    };

    await inputHandlers[0](event, ctx);

    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it('handles empty text gracefully (leaves indicator unchanged)', async () => {
    registerActivityIndicator(pi as ExtensionAPI);

    const ctx = createMockContext();
    const event: InputEvent = {
      type: 'input',
      text: '',
      source: 'interactive',
    };

    await inputHandlers[0](event, ctx);

    // Empty/free-form text should not clear the indicator
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it('handles whitespace-only text as free-form (leaves indicator unchanged)', async () => {
    registerActivityIndicator(pi as ExtensionAPI);

    const ctx = createMockContext();
    const event: InputEvent = {
      type: 'input',
      text: '   ',
      source: 'interactive',
    };

    await inputHandlers[0](event, ctx);

    // Whitespace-only/free-form text should not clear the indicator
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  describe('work item ID resolution', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('shows raw text immediately, then resolves title for command with work item ID', async () => {
      // Mock runWl to return a successful title lookup
      mockRunWl.mockResolvedValueOnce({ title: 'Fix login bug that crashes on startup' });

      registerActivityIndicator(pi as ExtensionAPI);
      const ctx = createMockContext();
      const event: InputEvent = {
        type: 'input',
        text: '/intake WL-0MQL0T5TR0060AEH',
        source: 'interactive',
      };

      await inputHandlers[0](event, ctx);

      // Should have shown raw text first, then replaced with command + ID + title
      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        ACTIVITY_STATUS_KEY,
        expect.stringContaining('WL-0MQL0T5TR0060AEH')
      );
      // Final display should include the command context alongside ID + title
      const lastCallArg = (ctx.ui.setStatus as ReturnType<typeof vi.fn>).mock.calls.slice(-1)[0][1] as string;
      expect(lastCallArg).toContain('/intake');
      expect(lastCallArg).toContain('WL-0MQL0T5TR0060AEH');
      expect(lastCallArg).toContain('Fix login bug');

      // Verify runWl was called with the correct arguments
      expect(mockRunWl).toHaveBeenCalledWith('show', ['WL-0MQL0T5TR0060AEH'], { timeout: 2000 });
    });

    it('falls back to raw text on work item ID lookup failure', async () => {
      // Mock runWl to reject (lookup failure)
      mockRunWl.mockRejectedValueOnce(new Error('Work item not found'));

      registerActivityIndicator(pi as ExtensionAPI);
      const ctx = createMockContext();
      const event: InputEvent = {
        type: 'input',
        text: '/intake WL-0MQL0T5TR0060AEH',
        source: 'interactive',
      };

      await inputHandlers[0](event, ctx);

      // Should still show raw text (not cleared)
      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        ACTIVITY_STATUS_KEY,
        expect.stringContaining('/intake WL-0MQL0T5TR0060AEH')
      );
    });

    it('resolves title for /skill: command with work item ID', async () => {
      mockRunWl.mockResolvedValueOnce({ title: 'Add user authentication' });

      registerActivityIndicator(pi as ExtensionAPI);
      const ctx = createMockContext();
      const event: InputEvent = {
        type: 'input',
        text: '/skill:implement WL-0MP15TA8J009NZUU',
        source: 'interactive',
      };

      await inputHandlers[0](event, ctx);

      // Should show skill name (with /skill: prefix stripped) + ID + title
      const lastCallArg = (ctx.ui.setStatus as ReturnType<typeof vi.fn>).mock.calls.slice(-1)[0][1] as string;
      expect(lastCallArg).not.toContain('/skill:');
      expect(lastCallArg).toContain('implement');
      expect(lastCallArg).toContain('WL-0MP15TA8J009NZUU');
      expect(lastCallArg).toContain('Add user authentication');
      expect(mockRunWl).toHaveBeenCalledWith('show', ['WL-0MP15TA8J009NZUU'], { timeout: 2000 });
    });

    it('preserves existing behavior for command without work item ID', async () => {
      registerActivityIndicator(pi as ExtensionAPI);
      const ctx = createMockContext();
      const event: InputEvent = {
        type: 'input',
        text: '/intake some text without ID',
        source: 'interactive',
      };

      await inputHandlers[0](event, ctx);

      // Should show full raw text (existing behavior)
      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        ACTIVITY_STATUS_KEY,
        expect.stringContaining('/intake some text')
      );
      // No wl show call should have been made
      expect(mockRunWl).not.toHaveBeenCalled();
    });

    it('resolves title for unknown /-prefixed command with work item ID', async () => {
      mockRunWl.mockResolvedValueOnce({ title: 'Resolve work item IDs to titles' });

      registerActivityIndicator(pi as ExtensionAPI);
      const ctx = createMockContext();
      const event: InputEvent = {
        type: 'input',
        text: '/custom-command WL-0MQLG8PK80041FM3',
        source: 'interactive',
      };

      await inputHandlers[0](event, ctx);

      // Should show command + ID + title
      const lastCallArg = (ctx.ui.setStatus as ReturnType<typeof vi.fn>).mock.calls.slice(-1)[0][1] as string;
      expect(lastCallArg).toContain('/custom-command');
      expect(lastCallArg).toContain('WL-0MQLG8PK80041FM3');
      expect(lastCallArg).toContain('Resolve work item IDs to titles');
      expect(mockRunWl).toHaveBeenCalledWith('show', ['WL-0MQLG8PK80041FM3'], { timeout: 2000 });
    });

    it('uses the first work item ID when multiple IDs are present in input', async () => {
      mockRunWl.mockResolvedValueOnce({ title: 'First work item title' });

      registerActivityIndicator(pi as ExtensionAPI);
      const ctx = createMockContext();
      const event: InputEvent = {
        type: 'input',
        text: '/implement WL-0MQL0T5TR0060AEH and WL-0MQLG8PK80041FM3',
        source: 'interactive',
      };

      await inputHandlers[0](event, ctx);

      // Should look up only the first ID
      expect(mockRunWl).toHaveBeenCalledTimes(1);
      expect(mockRunWl).toHaveBeenCalledWith('show', ['WL-0MQL0T5TR0060AEH'], { timeout: 2000 });

      const lastCallArg = (ctx.ui.setStatus as ReturnType<typeof vi.fn>).mock.calls.slice(-1)[0][1] as string;
      expect(lastCallArg).toContain('/implement');
      expect(lastCallArg).toContain('WL-0MQL0T5TR0060AEH');
      expect(lastCallArg).toContain('First work item title');
    });
  });
});

describe('registerActivityIndicator - session_start events', () => {
  let pi: Partial<ExtensionAPI>;
  let sessionStartHandlers: Array<(event: SessionStartEvent, ctx: ExtensionContext) => Promise<any>>;

  beforeEach(() => {
    sessionStartHandlers = [];
    pi = {
      on: vi.fn((event: string, handler: any) => {
        if (event === 'session_start') {
          sessionStartHandlers.push(handler);
        }
      }) as any,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createMockContext(): ExtensionContext {
    const setStatus = vi.fn();
    const theme = { fg: vi.fn((_color: string, text: string) => text) };
    return {
      ui: { setStatus, theme } as unknown as ExtensionUIContext,
      mode: 'tui',
      hasUI: true,
      cwd: '/test',
      sessionManager: {
        getBranch: vi.fn().mockReturnValue([]),
      } as any,
      model: undefined,
      modelRegistry: {} as any,
      isIdle: vi.fn().mockReturnValue(true),
      isProjectTrusted: vi.fn().mockReturnValue(true),
      signal: undefined,
      abort: vi.fn(),
      hasPendingMessages: vi.fn().mockReturnValue(false),
      shutdown: vi.fn(),
      getContextUsage: vi.fn(),
      compact: vi.fn(),
      getSystemPrompt: vi.fn().mockReturnValue(''),
    };
  }

  it('clears indicator on new session (reason: "new")', async () => {
    registerActivityIndicator(pi as ExtensionAPI);
    expect(sessionStartHandlers.length).toBe(1);

    const ctx = createMockContext();
    const event: SessionStartEvent = {
      type: 'session_start',
      reason: 'new',
    };

    await sessionStartHandlers[0](event, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith(ACTIVITY_STATUS_KEY, undefined);
  });

  it('clears indicator on startup (reason: "startup")', async () => {
    registerActivityIndicator(pi as ExtensionAPI);

    const ctx = createMockContext();
    const event: SessionStartEvent = {
      type: 'session_start',
      reason: 'startup',
    };

    await sessionStartHandlers[0](event, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith(ACTIVITY_STATUS_KEY, undefined);
  });

  it('clears indicator on reload (reason: "reload")', async () => {
    registerActivityIndicator(pi as ExtensionAPI);

    const ctx = createMockContext();
    const event: SessionStartEvent = {
      type: 'session_start',
      reason: 'reload',
    };

    await sessionStartHandlers[0](event, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith(ACTIVITY_STATUS_KEY, undefined);
  });

  it('clears indicator on fork (reason: "fork")', async () => {
    registerActivityIndicator(pi as ExtensionAPI);

    const ctx = createMockContext();
    const event: SessionStartEvent = {
      type: 'session_start',
      reason: 'fork',
    };

    await sessionStartHandlers[0](event, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith(ACTIVITY_STATUS_KEY, undefined);
  });

  it('attempts to recover last command on resume (reason: "resume")', async () => {
    registerActivityIndicator(pi as ExtensionAPI);

    const setStatus = vi.fn();
    const theme = { fg: vi.fn((_color: string, text: string) => text) };
    const ctx = {
      ui: { setStatus, theme } as unknown as ExtensionUIContext,
      mode: 'tui',
      hasUI: true,
      cwd: '/test',
      sessionManager: {
        getBranch: vi.fn().mockReturnValue([
          {
            type: 'message',
            message: {
              role: 'user',
              content: [{ type: 'text', text: '/wl list' }],
            },
          },
        ]),
      } as any,
      model: undefined,
      modelRegistry: {} as any,
      isIdle: vi.fn().mockReturnValue(true),
      isProjectTrusted: vi.fn().mockReturnValue(true),
      signal: undefined,
      abort: vi.fn(),
      hasPendingMessages: vi.fn().mockReturnValue(false),
      shutdown: vi.fn(),
      getContextUsage: vi.fn(),
      compact: vi.fn(),
      getSystemPrompt: vi.fn().mockReturnValue(''),
    };

    const event: SessionStartEvent = {
      type: 'session_start',
      reason: 'resume',
      previousSessionFile: '/path/to/session.jsonl',
    };

    await sessionStartHandlers[0](event, ctx);

    // Should have recovered the /wl command
    expect(setStatus).toHaveBeenCalledWith(
      ACTIVITY_STATUS_KEY,
      expect.stringContaining('/wl')
    );
  });

  it('attempts to recover skill command on resume', async () => {
    registerActivityIndicator(pi as ExtensionAPI);

    const setStatus = vi.fn();
    const theme = { fg: vi.fn((_color: string, text: string) => text) };
    const ctx = {
      ui: { setStatus, theme } as unknown as ExtensionUIContext,
      mode: 'tui',
      hasUI: true,
      cwd: '/test',
      sessionManager: {
        getBranch: vi.fn().mockReturnValue([
          {
            type: 'message',
            message: {
              role: 'user',
              content: [{ type: 'text', text: '/skill:audit WL-123' }],
            },
          },
        ]),
      } as any,
      model: undefined,
      modelRegistry: {} as any,
      isIdle: vi.fn().mockReturnValue(true),
      isProjectTrusted: vi.fn().mockReturnValue(true),
      signal: undefined,
      abort: vi.fn(),
      hasPendingMessages: vi.fn().mockReturnValue(false),
      shutdown: vi.fn(),
      getContextUsage: vi.fn(),
      compact: vi.fn(),
      getSystemPrompt: vi.fn().mockReturnValue(''),
    };

    const event: SessionStartEvent = {
      type: 'session_start',
      reason: 'resume',
    };

    await sessionStartHandlers[0](event, ctx);

    // Should have recovered the skill command
    expect(setStatus).toHaveBeenCalledWith(
      ACTIVITY_STATUS_KEY,
      expect.stringContaining('skill:audit')
    );
  });

  it('clears indicator on resume if no recoverable command found', async () => {
    registerActivityIndicator(pi as ExtensionAPI);

    const ctx = createMockContext();
    const event: SessionStartEvent = {
      type: 'session_start',
      reason: 'resume',
    };

    await sessionStartHandlers[0](event, ctx);

    // No user commands in history — should clear
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(ACTIVITY_STATUS_KEY, undefined);
  });

  it('clears indicator on resume if last user entry is free-form text', async () => {
    registerActivityIndicator(pi as ExtensionAPI);

    const setStatus = vi.fn();
    const theme = { fg: vi.fn((_color: string, text: string) => text) };
    const ctx = {
      ui: { setStatus, theme } as unknown as ExtensionUIContext,
      mode: 'tui',
      hasUI: true,
      cwd: '/test',
      sessionManager: {
        getBranch: vi.fn().mockReturnValue([
          {
            type: 'message',
            message: {
              role: 'user',
              content: [{ type: 'text', text: 'Please fix the bug' }],
            },
          },
        ]),
      } as any,
      model: undefined,
      modelRegistry: {} as any,
      isIdle: vi.fn().mockReturnValue(true),
      isProjectTrusted: vi.fn().mockReturnValue(true),
      signal: undefined,
      abort: vi.fn(),
      hasPendingMessages: vi.fn().mockReturnValue(false),
      shutdown: vi.fn(),
      getContextUsage: vi.fn(),
      compact: vi.fn(),
      getSystemPrompt: vi.fn().mockReturnValue(''),
    };

    const event: SessionStartEvent = {
      type: 'session_start',
      reason: 'resume',
    };

    await sessionStartHandlers[0](event, ctx);

    // Free-form text should not be recovered
    expect(setStatus).toHaveBeenCalledWith(ACTIVITY_STATUS_KEY, undefined);
  });

  it('clears indicator on resume when isActivityEnabled returns false', async () => {
    registerActivityIndicator(pi as ExtensionAPI, () => false);
    expect(sessionStartHandlers.length).toBe(1);

    const ctx = createMockContext();
    const event: SessionStartEvent = {
      type: 'session_start',
      reason: 'resume',
      previousSessionFile: '/path/to/session.jsonl',
    };

    await sessionStartHandlers[0](event, ctx);

    // Should clear indicator instead of attempting recovery
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(ACTIVITY_STATUS_KEY, undefined);
  });
});

describe('registerActivityIndicator - wiring', () => {
  it('registers input and session_start event handlers', () => {
    const on = vi.fn();
    const pi = { on } as unknown as ExtensionAPI;

    registerActivityIndicator(pi);

    expect(on).toHaveBeenCalledWith('input', expect.any(Function));
    expect(on).toHaveBeenCalledWith('session_start', expect.any(Function));
  });

  it('handler registration order is preserved (input first, then session_start)', () => {
    const on = vi.fn();
    const pi = { on } as unknown as ExtensionAPI;

    registerActivityIndicator(pi);

    expect(on.mock.calls[0][0]).toBe('input');
    expect(on.mock.calls[1][0]).toBe('session_start');
  });
});
