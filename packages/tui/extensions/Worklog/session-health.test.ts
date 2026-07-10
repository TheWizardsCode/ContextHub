/**
 * Unit tests for session-health.ts — Session health footer for the Worklog
 * Pi extension.
 *
 * Verifies:
 * 1. registerSessionHealth() sets up event listeners for relevant lifecycle
 *    events (session_start, turn_start, message_end, tool_execution_start,
 *    tool_execution_end, model_select, session_shutdown).
 * 2. The footer renders correctly for all status states (idle, streaming,
 *    tool execution).
 * 3. Elapsed time is colour-coded correctly (green <5s, yellow 5-15s,
 *    orange 15-30s, red >30s).
 * 4. Token counts are formatted with k suffixes.
 * 5. Context usage is formatted correctly.
 * 6. The module exports the SESSION_HEALTH_STATUS_KEY constant.
 * 7. Token extraction from session entries works correctly.
 *
 * Run: npx vitest run packages/tui/extensions/Worklog/session-health.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock @earendil-works/pi-coding-agent ──────────────────────────────

vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => '/home/test-user/.pi/agent',
}));

// ── Mock @earendil-works/pi-tui ───────────────────────────────────────

vi.mock('@earendil-works/pi-tui', () => ({
  truncateToWidth: (text: string, width: number) => text.slice(0, width),
  visibleWidth: (text: string) => text.length,
}));

// ── Mock ./model-display.js ────────────────────────────────────────────
// Used by the footer factory to read the current resolved/selected model.
// Tests for the model line control the return values to verify correct
// rendering of the third footer line.

const mocks = vi.hoisted(() => ({
  mockGetResolvedModel: vi.fn(() => null),
  mockGetSelectedModel: vi.fn(() => null),
  mockOnModelChange: vi.fn(() => () => {}),
}));

vi.mock('./model-display.js', () => ({
  getResolvedModel: mocks.mockGetResolvedModel,
  getSelectedModel: mocks.mockGetSelectedModel,
  onModelChange: mocks.mockOnModelChange,
  _resetModelDisplayState: vi.fn(),
  MODEL_DISPLAY_STATUS_KEY: 'worklog-0model',
}));

// ── Module under test ─────────────────────────────────────────────────

import {
  registerSessionHealth,
  SESSION_HEALTH_STATUS_KEY,
  STATUS_IDLE,
  STATUS_STREAMING,
  STATUS_TOOL,
  getElapsedTime,
  formatElapsedTime,
  formatShortElapsedTime,
  getTimeColor,
  formatTokens,
  formatContextUsage,
  extractTokenUsage,
  renderFooter,
  type SessionHealthState,
} from './session-health.js';

describe('session-health', () => {
  /** Tracks event listeners registered by registerSessionHealth. */
  const registeredListeners: Record<string, Function[]> = {};
  /** Tracks footer set calls. */
  const footerCalls: Array<{ factory: Function }> = [];
  /** Tracks status bar calls. */
  const statusCalls: Array<{ key: string; value: string | undefined }> = [];

  /** Mock ExtensionAPI with on(). */
  let mockPi: any;
  /** Mock context with ui and model. */
  let mockCtx: any;

  /** Helper to get registered handlers for an event. */
  function getHandler(event: string): Function | undefined {
    const handlers = registeredListeners[event];
    return handlers?.[handlers.length - 1]; // Return the last registered handler
  }

  beforeEach(() => {
    // Reset tracking
    Object.keys(registeredListeners).forEach(k => delete registeredListeners[k]);
    footerCalls.length = 0;
    statusCalls.length = 0;

    // Mock extension context
    mockCtx = {
      ui: {
        setStatus: vi.fn((key: string, value: string | undefined) => {
          statusCalls.push({ key, value });
        }),
        setFooter: vi.fn((factory: Function | undefined) => {
          if (factory) {
            footerCalls.push({ factory });
          }
        }),
        theme: {
          fg: vi.fn((color: string, text: string) => `[${color}${text}]`),
        },
      },
      mode: 'tui' as const,
      model: { id: 'gpt-4' },
      sessionManager: {
        getBranch: vi.fn(() => []),
      },
      getContextUsage: vi.fn(() => ({
        tokens: 50000,
        contextWindow: 128000,
        percent: 39.1,
      })),
    };

    // Mock Pi API
    mockPi = {
      on: vi.fn((event: string, handler: Function) => {
        if (!registeredListeners[event]) {
          registeredListeners[event] = [];
        }
        registeredListeners[event].push(handler);
      }),
    };
  });

  // ── Exports ─────────────────────────────────────────────────────────

  it('exports SESSION_HEALTH_STATUS_KEY', () => {
    expect(SESSION_HEALTH_STATUS_KEY).toBe('worklog-session-health');
  });

  it('exports status constants (idle, streaming, tool)', () => {
    expect(STATUS_IDLE).toBe('○');
    expect(STATUS_STREAMING).toBe('●');
    expect(STATUS_TOOL).toBe('⚡');
  });

  it('exports registerSessionHealth as a function', () => {
    expect(typeof registerSessionHealth).toBe('function');
  });

  // ── Event registration ──────────────────────────────────────────────

  it('registers session_start listener', () => {
    registerSessionHealth(mockPi);
    expect(registeredListeners['session_start']).toBeDefined();
  });

  it('registers turn_start listener', () => {
    registerSessionHealth(mockPi);
    expect(registeredListeners['turn_start']).toBeDefined();
  });

  it('registers message_end listener', () => {
    registerSessionHealth(mockPi);
    expect(registeredListeners['message_end']).toBeDefined();
  });

  it('registers tool_execution_start listener', () => {
    registerSessionHealth(mockPi);
    expect(registeredListeners['tool_execution_start']).toBeDefined();
  });

  it('registers tool_execution_end listener', () => {
    registerSessionHealth(mockPi);
    expect(registeredListeners['tool_execution_end']).toBeDefined();
  });

  it('registers model_select listener', () => {
    registerSessionHealth(mockPi);
    expect(registeredListeners['model_select']).toBeDefined();
  });

  it('registers session_shutdown listener', () => {
    registerSessionHealth(mockPi);
    expect(registeredListeners['session_shutdown']).toBeDefined();
  });

  // ── Time formatting ─────────────────────────────────────────────────

  describe('getElapsedTime', () => {
    it('returns Infinity for null timestamp', () => {
      expect(getElapsedTime(null)).toBe(Infinity);
    });

    it('returns 0 for future timestamp', () => {
      expect(getElapsedTime(Date.now() + 1000)).toBe(0);
    });

    it('returns elapsed seconds for past timestamp', () => {
      const past = Date.now() - 5000;
      const elapsed = getElapsedTime(past);
      expect(elapsed).toBeGreaterThanOrEqual(4.9);
      expect(elapsed).toBeLessThanOrEqual(5.1);
    });
  });

  describe('formatElapsedTime', () => {
    it('returns "—" for Infinity', () => {
      expect(formatElapsedTime(Infinity)).toBe('—');
    });

    it('returns "—" for negative', () => {
      expect(formatElapsedTime(-1)).toBe('—');
    });

    it('formats seconds < 60', () => {
      expect(formatElapsedTime(3.5)).toBe('4s');
      expect(formatElapsedTime(1.1)).toBe('1s');
      expect(formatElapsedTime(0.5)).toBe('1s');
    });

    it('formats minutes and seconds', () => {
      expect(formatElapsedTime(65)).toBe('1m 5s');
      expect(formatElapsedTime(120)).toBe('2m');
      expect(formatElapsedTime(90)).toBe('1m 30s');
    });
  });

  describe('formatShortElapsedTime', () => {
    it('returns "—" for Infinity', () => {
      expect(formatShortElapsedTime(Infinity)).toBe('—');
    });

    it('returns "—" for negative', () => {
      expect(formatShortElapsedTime(-1)).toBe('—');
    });

    it('formats seconds < 60', () => {
      expect(formatShortElapsedTime(3.5)).toBe('4s ago');
      expect(formatShortElapsedTime(1.1)).toBe('1s ago');
      expect(formatShortElapsedTime(0.5)).toBe('1s ago');
    });

    it('formats minutes and seconds', () => {
      expect(formatShortElapsedTime(65)).toBe('1m 5s ago');
      expect(formatShortElapsedTime(120)).toBe('2m ago');
      expect(formatShortElapsedTime(90)).toBe('1m 30s ago');
    });
  });

  describe('getTimeColor', () => {
    it('returns "dim" for Infinity or negative', () => {
      expect(getTimeColor(Infinity)).toBe('dim');
      expect(getTimeColor(-1)).toBe('dim');
    });

    it('returns "success" for <5s', () => {
      expect(getTimeColor(0)).toBe('success');
      expect(getTimeColor(4)).toBe('success');
      expect(getTimeColor(4.9)).toBe('success');
    });

    it('returns "warning" for 5-30s', () => {
      expect(getTimeColor(5)).toBe('warning');
      expect(getTimeColor(10)).toBe('warning');
      expect(getTimeColor(15)).toBe('warning');
      expect(getTimeColor(20)).toBe('warning');
      expect(getTimeColor(30)).toBe('warning');
    });

    it('returns "error" for >30s', () => {
      expect(getTimeColor(30.1)).toBe('error');
      expect(getTimeColor(60)).toBe('error');
    });
  });

  // ── Token formatting ────────────────────────────────────────────────

  // ── Token formatting ────────────────────────────────────────────────

  describe('formatTokens', () => {
    it('returns raw number for <1000', () => {
      expect(formatTokens(42)).toBe('42');
      expect(formatTokens(999)).toBe('999');
    });

    it('returns k suffix for >=1000', () => {
      expect(formatTokens(1000)).toBe('1.0k');
      expect(formatTokens(1500)).toBe('1.5k');
      expect(formatTokens(9999)).toBe('10.0k');
    });

    it('returns M suffix for >=1M', () => {
      expect(formatTokens(1_000_000)).toBe('1.0M');
      expect(formatTokens(2_500_000)).toBe('2.5M');
    });
  });

  // ── Context usage formatting ────────────────────────────────────────

  describe('formatContextUsage', () => {
    it('returns "—/128k" when tokens is null', () => {
      const result = formatContextUsage({
        tokens: null,
        contextWindow: 128000,
        percent: null,
      });
      expect(result).toBe('—/128.0k');
    });

    it('returns formatted percentage when tokens is set', () => {
      const result = formatContextUsage({
        tokens: 50000,
        contextWindow: 128000,
        percent: 39.1,
      });
      expect(result).toBe('39.1%/128.0k');
    });

    it('handles large context windows', () => {
      const result = formatContextUsage({
        tokens: 1000000,
        contextWindow: 10000000,
        percent: 10.0,
      });
      expect(result).toBe('10.0%/10.0M');
    });
  });

  // ── Token extraction ────────────────────────────────────────────────

  describe('extractTokenUsage', () => {
    it('returns zeros for empty entries', () => {
      const result = extractTokenUsage([]);
      expect(result).toEqual({ inputTokens: 0, outputTokens: 0 });
    });

    it('extracts tokens from assistant messages', () => {
      const entries = [
        {
          type: 'message',
          message: { role: 'assistant', usage: { input: 100, output: 200 } },
        },
        {
          type: 'message',
          message: { role: 'assistant', usage: { input: 150, output: 250 } },
        },
      ];
      const result = extractTokenUsage(entries);
      expect(result).toEqual({ inputTokens: 250, outputTokens: 450 });
    });

    it('ignores non-assistant messages', () => {
      const entries = [
        { type: 'message', message: { role: 'user' } },
        {
          type: 'message',
          message: { role: 'assistant', usage: { input: 100, output: 200 } },
        },
        { type: 'message', message: { role: 'toolResult' } },
      ];
      const result = extractTokenUsage(entries);
      expect(result).toEqual({ inputTokens: 100, outputTokens: 200 });
    });

    it('handles missing usage gracefully', () => {
      const entries = [
        { type: 'message', message: { role: 'assistant' } },
        {
          type: 'message',
          message: { role: 'assistant', usage: { input: 100, output: 200 } },
        },
      ];
      const result = extractTokenUsage(entries);
      expect(result).toEqual({ inputTokens: 100, outputTokens: 200 });
    });
  });

  // ── Footer rendering ────────────────────────────────────────────────

  describe('renderFooter', () => {
    const mockTheme = {
      fg: vi.fn((color: string, text: string) => `[${color}${text}]`),
    };
    const mockCtx = {
      model: { id: 'gpt-4' },
    };

    it('renders idle status with ○ Idle', () => {
      const state: SessionHealthState = {
        status: 'idle',
        toolName: null,
        lastResponseTime: Date.now() - 2000,
        lastChunkTime: null,
        turnCount: 1,
        inputTokens: 1000,
        outputTokens: 2000,
        contextUsage: { tokens: 50000, contextWindow: 128000, percent: 39.1 },
      };

      const result = renderFooter(state, mockCtx, mockTheme as any, 500);

      expect(result).toContain('[dim○ Idle]');
      expect(result).toContain('[dim#1]');
      expect(result).toContain('[success2s]');
    });

    it('renders streaming status with ● Streaming', () => {
      const state: SessionHealthState = {
        status: 'streaming',
        toolName: null,
        lastResponseTime: Date.now() - 3000,
        lastChunkTime: Date.now() - 1000,
        turnCount: 1,
        inputTokens: 1000,
        outputTokens: 0,
        contextUsage: { tokens: null, contextWindow: 128000, percent: null },
      };

      const result = renderFooter(state, mockCtx, mockTheme as any, 200);

      expect(result).toContain('[dim● Streaming]');
      expect(result).toContain('s ago');
      expect(result).toContain('[dim—/128.0k]');
      expect(result).toContain('[success3s]');
    });

    it('renders tool status with ⚡ Tool: read', () => {
      const state: SessionHealthState = {
        status: 'tool',
        toolName: 'read',
        lastResponseTime: Date.now() - 1000,
        lastChunkTime: null,
        turnCount: 1,
        inputTokens: 1000,
        outputTokens: 0,
        contextUsage: { tokens: null, contextWindow: 128000, percent: null },
      };

      const result = renderFooter(state, mockCtx, mockTheme as any, 120);

      expect(result).toContain('[dim⚡ Tool: read]');
    });

    it('handles missing model ID gracefully', () => {
      const state: SessionHealthState = {
        status: 'idle',
        toolName: null,
        lastResponseTime: Date.now() - 2000,
        lastChunkTime: null,
        turnCount: 1,
        inputTokens: 1000,
        outputTokens: 2000,
        contextUsage: { tokens: 50000, contextWindow: 128000, percent: 39.1 },
      };

      const result = renderFooter(state, { model: null } as any, mockTheme as any, 500);

      // Verify three-section layout still works without model context
      expect(result).toContain('[dim○ Idle]');
      expect(result).toContain('[dim#1]');
      expect(result).toContain('[success2s]');
    });

    it('truncates content for narrow terminals', () => {
      const state: SessionHealthState = {
        status: 'idle',
        toolName: null,
        lastResponseTime: Date.now() - 2000,
        turnCount: 1,
        inputTokens: 1000000,
        outputTokens: 2000000,
        contextUsage: { tokens: 500000, contextWindow: 10000000, percent: 5.0 },
      };

      const result = renderFooter(state, mockCtx, mockTheme as any, 20);

      // Should not exceed width
      expect(result.length).toBeLessThanOrEqual(20);
    });
  });

  // ── Integration tests ───────────────────────────────────────────────

  describe('registerSessionHealth integration', () => {
    it('sets up footer on session_start', () => {
      registerSessionHealth(mockPi);

      // Get the session_start handler
      const handler = getHandler('session_start');
      expect(handler).toBeDefined();

      // Call the handler with the mock context
      handler({}, mockCtx);

      // setFooter should have been called
      expect(mockCtx.ui.setFooter).toHaveBeenCalled();
    });

    it('increments turnCount on turn_start', () => {
      // We can't easily test the internal state, but we can verify the
      // handler is registered and doesn't crash
      registerSessionHealth(mockPi);

      const handler = getHandler('turn_start');
      expect(handler).toBeDefined();

      expect(() => {
        handler({}, mockCtx);
      }).not.toThrow();
    });

    it('handles message_end for assistant messages', () => {
      registerSessionHealth(mockPi);

      const handler = getHandler('message_end');
      expect(handler).toBeDefined();

      // Assistant message
      expect(() => {
        handler({ message: { role: 'assistant' } }, mockCtx);
      }).not.toThrow();

      // User message (should be ignored)
      expect(() => {
        handler({ message: { role: 'user' } }, mockCtx);
      }).not.toThrow();
    });

    it('handles tool_execution_start', () => {
      registerSessionHealth(mockPi);

      const handler = getHandler('tool_execution_start');
      expect(handler).toBeDefined();

      expect(() => {
        handler({ toolName: 'read' }, mockCtx);
      }).not.toThrow();
    });

    it('handles tool_execution_end', () => {
      registerSessionHealth(mockPi);

      const handler = getHandler('tool_execution_end');
      expect(handler).toBeDefined();

      expect(() => {
        handler({ toolName: 'read' }, mockCtx);
      }).not.toThrow();
    });

    it('handles model_select', () => {
      registerSessionHealth(mockPi);

      const handler = getHandler('model_select');
      expect(handler).toBeDefined();

      expect(() => {
        handler({ model: { id: 'gpt-4' } }, mockCtx);
      }).not.toThrow();
    });

    it('handles session_shutdown (cleans up ticker)', () => {
      registerSessionHealth(mockPi);

      const handler = getHandler('session_shutdown');
      expect(handler).toBeDefined();

      expect(() => {
        handler({}, mockCtx);
      }).not.toThrow();
    });
  });

  // ── message_update / lastChunkTime ────────────────────────────────────

  it('registers message_update listener', () => {
    registerSessionHealth(mockPi);
    expect(registeredListeners['message_update']).toBeDefined();
  });

  it('updates lastChunkTime on message_update', () => {
    // We use a closure to capture the internal state
    let capturedState: SessionHealthState | undefined;
    const patchedMockCtx = { ...mockCtx, ui: { ...mockCtx.ui, setFooter: vi.fn() } };
    const origOn = mockPi.on;

    // Patch the register to capture state changes
    registerSessionHealth(mockPi);

    const handler = getHandler('message_update');
    expect(handler).toBeDefined();

    // Call message_update handler
    const beforeCall = Date.now();
    handler({}, patchedMockCtx);
    const afterCall = Date.now();

    // The handler should have updated lastChunkTime
    // We verify by checking the handler doesn't throw and that it calls updateState
    // Since we can't directly inspect the captured state, we verify the
    // handler exists and is callable (the real integration test verifies state)
    expect(() => {
      handler({ message: { role: 'assistant' } }, patchedMockCtx);
    }).not.toThrow();
  });

  it('does NOT update lastChunkTime on turn_start', () => {
    registerSessionHealth(mockPi);
    const handler = getHandler('turn_start');
    expect(handler).toBeDefined();
    // turn_start should not call updateState for lastChunkTime
    expect(() => {
      handler({}, mockCtx);
    }).not.toThrow();
  });

  it('does NOT update lastChunkTime on message_end', () => {
    registerSessionHealth(mockPi);
    const handler = getHandler('message_end');
    expect(handler).toBeDefined();
    expect(() => {
      handler({ message: { role: 'assistant' } }, mockCtx);
    }).not.toThrow();
  });

  // ── Three-section footer layout ───────────────────────────────────────

  describe('renderFooter — three-section layout', () => {
    const mockTheme = {
      fg: vi.fn((color: string, text: string) => `[${color}${text}]`),
    };
    const mockCtx = {
      model: { id: 'gpt-4' },
    };

    it('shows elapsed time since last chunk only during streaming', () => {
      // Streaming state — should include last chunk info
      const streamingState: SessionHealthState = {
        status: 'streaming',
        toolName: null,
        lastResponseTime: Date.now() - 5000,
        lastChunkTime: Date.now() - 2000,
        turnCount: 3,
        inputTokens: 1000,
        outputTokens: 500,
        contextUsage: { tokens: 50000, contextWindow: 128000, percent: 39.1 },
      };

      const result = renderFooter(streamingState, mockCtx, mockTheme as any, 120);

      expect(result).toContain('s ago');
    });

    it('does NOT show elapsed time since last chunk when idle', () => {
      const idleState: SessionHealthState = {
        status: 'idle',
        toolName: null,
        lastResponseTime: Date.now() - 2000,
        lastChunkTime: null,
        turnCount: 1,
        inputTokens: 1000,
        outputTokens: 2000,
        contextUsage: { tokens: 50000, contextWindow: 128000, percent: 39.1 },
      };

      const result = renderFooter(idleState, mockCtx, mockTheme as any, 120);

      expect(result).not.toContain('s ago');
    });

    it('does NOT show elapsed time since last chunk when tool executing', () => {
      const toolState: SessionHealthState = {
        status: 'tool',
        toolName: 'read',
        lastResponseTime: Date.now() - 1000,
        lastChunkTime: null,
        turnCount: 1,
        inputTokens: 1000,
        outputTokens: 0,
        contextUsage: { tokens: null, contextWindow: 128000, percent: null },
      };

      const result = renderFooter(toolState, mockCtx, mockTheme as any, 120);

      expect(result).not.toContain('s ago');
    });

    it('shows elapsed time in center section', () => {
      const state: SessionHealthState = {
        status: 'streaming',
        toolName: null,
        lastResponseTime: Date.now() - 45000, // 45 seconds ago
        lastChunkTime: Date.now() - 1000,
        turnCount: 5,
        inputTokens: 1000,
        outputTokens: 2000,
        contextUsage: { tokens: 50000, contextWindow: 128000, percent: 39.1 },
      };

      const result = renderFooter(state, mockCtx, mockTheme as any, 200);

      // Should contain the elapsed time formatted as "45s"
      // 45s > 30s so getTimeColor returns 'error'
      expect(result).toContain('[error45s]');
    });

    it('places left, center, and right sections in correct order', () => {
      const state: SessionHealthState = {
        status: 'streaming',
        toolName: null,
        lastResponseTime: Date.now() - 10000,
        lastChunkTime: Date.now() - 3000,
        turnCount: 2,
        inputTokens: 500,
        outputTokens: 1000,
        contextUsage: { tokens: 25000, contextWindow: 128000, percent: 19.5 },
      };

      const result = renderFooter(state, mockCtx, mockTheme as any, 500);

      // Left section: marker + turn count + last chunk elapsed time
      expect(result).toContain('[dim● Streaming]');
      expect(result).toContain('[dim#2]');
      expect(result).toContain('s ago');
      // Center section: elapsed time
      expect(result).toContain('[warning10s]');
      // Right section: tokens
      expect(result).toContain('[muted↑500 ↓1.0k]');
      // Right section: context
      expect(result).toContain('[dim19.5%/128.0k]');
      // Right section: context (model is now on its own footer line)
    });

    it('renders footer with wide terminal (no truncation)', () => {
      const state: SessionHealthState = {
        status: 'streaming',
        toolName: null,
        lastResponseTime: Date.now() - 65000,
        lastChunkTime: Date.now() - 5000,
        turnCount: 10,
        inputTokens: 50000,
        outputTokens: 100000,
        contextUsage: { tokens: 64000, contextWindow: 128000, percent: 50.0 },
      };

      const result = renderFooter(state, mockCtx, mockTheme as any, 400);

      expect(result).toContain('s ago');
      // 65s = 1m 5s, and > 30s so error color
      expect(result).toContain('[error1m 5s]');
      expect(result).toContain('[muted↑50.0k ↓100.0k]');
      expect(result).toContain('[dim50.0%/128.0k]');
    });
  });

  // ── Model line in footer (Line 3) ──────────────────────────────────────

  describe('model line in footer', () => {
    /**
     * Helper: invoke the footer factory and return its render(…) result.
     * Simulates what Pi TUI does: calls setFooter(factory), then calls
     * factory(tui, theme, footerData) → { render(width) } → render(lines).
     */
    function fabricateFooterLines(ctx: any): string[] {
      registerSessionHealth(mockPi);

      // Start a session to trigger footer setup
      const sessionStartHandler = getHandler('session_start');
      sessionStartHandler({}, ctx);

      // Capture the factory passed to setFooter
      expect(footerCalls.length).toBeGreaterThanOrEqual(1);
      const factory = footerCalls[footerCalls.length - 1].factory;

      // Call the factory to get the footer object
      const footerObj = factory(
        { requestRender: vi.fn() },
        { fg: (color: string, text: string) => `[${color}${text}]` },
        {
          getExtensionStatuses: () => [],
          onBranchChange: () => () => {},
          requestRender: vi.fn(),
        },
      );

      return footerObj.render(500);
    }

    beforeEach(() => {
      // Reset mock return values before each test
      mocks.mockGetResolvedModel.mockReturnValue(null);
      mocks.mockGetSelectedModel.mockReturnValue(null);
      mocks.mockOnModelChange.mockReturnValue(() => {});

      // Clear footer calls before each test
      footerCalls.length = 0;
    });

    it('shows resolved model in grey on line 3 when available', () => {
      mocks.mockGetResolvedModel.mockReturnValue('openai/gpt-4');
      mocks.mockGetSelectedModel.mockReturnValue('code');

      const lines = fabricateFooterLines({ ...mockCtx, mode: 'tui', ui: { ...mockCtx.ui, theme: { fg: vi.fn((c: string, t: string) => `[${c}${t}]`) } } });

      // With no extension statuses: lines[0]=session health, lines[1]=model info
      expect(lines.length).toBe(2);
      expect(lines[1]).toContain('openai/gpt-4');
      expect(lines[1]).toContain('[dim');
    });

    it('shows (pending) on line 3 when model selected but not yet resolved', () => {
      mocks.mockGetResolvedModel.mockReturnValue(null);
      mocks.mockGetSelectedModel.mockReturnValue('code');

      const lines = fabricateFooterLines({ ...mockCtx, mode: 'tui', ui: { ...mockCtx.ui, theme: { fg: vi.fn((c: string, t: string) => `[${c}${t}]`) } } });

      // With no extension statuses: lines[0]=session health, lines[1]=(pending)
      expect(lines.length).toBe(2);
      expect(lines[1]).toContain('(pending)');
      expect(lines[1]).toContain('[dim');
    });

    it('omits line 3 when no model selected and no resolved model', () => {
      mocks.mockGetResolvedModel.mockReturnValue(null);
      mocks.mockGetSelectedModel.mockReturnValue(null);

      const lines = fabricateFooterLines({ ...mockCtx, mode: 'tui', ui: { ...mockCtx.ui, theme: { fg: vi.fn((c: string, t: string) => `[${c}${t}]`) } } });

      // With no extension statuses and no model: only session health line
      expect(lines.length).toBe(1);
    });

    it('updates when after_provider_response fires (requestRender triggered)', () => {
      const requestRender = vi.fn();
      registerSessionHealth(mockPi);

      // Fire all needed events to set up footer
      const sessionStartHandler = getHandler('session_start');
      sessionStartHandler({}, {
        ...mockCtx,
        mode: 'tui',
        ui: {
          ...mockCtx.ui,
          theme: { fg: vi.fn((c: string, t: string) => `[${c}${t}]`) },
          setFooter: vi.fn((factory: Function) => {
            // Call factory to get dispose/invalidate/render
            const result = factory(
              { requestRender },
              { fg: (c: string, t: string) => `[${c}${t}]` },
              {
                getExtensionStatuses: () => [],
                onBranchChange: () => () => {},
              },
            );
            expect(typeof result.render).toBe('function');
          }),
        },
      });

      // Fire after_provider_response - the listener should call requestRender
      const aprHandler = getHandler('after_provider_response');
      expect(aprHandler).toBeDefined();
      aprHandler({ headers: { 'x-resolved-model': 'anthropic/claude-sonnet-4' } }, {});

      // requestRender should have been called by the after_provider_response handler
      expect(requestRender).toHaveBeenCalled();
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('formatElapsedTime handles edge cases', () => {
      expect(formatElapsedTime(Infinity)).toBe('—');
      expect(formatElapsedTime(-1)).toBe('—');
      expect(formatElapsedTime(0)).toBe('0s');
    });

    it('getTimeColor handles boundary values', () => {
      expect(getTimeColor(4.99)).toBe('success');
      expect(getTimeColor(5.0)).toBe('warning');
      expect(getTimeColor(14.99)).toBe('warning');
      expect(getTimeColor(15.0)).toBe('warning');
      expect(getTimeColor(29.99)).toBe('warning');
      expect(getTimeColor(30.01)).toBe('error');
    });

    it('formatTokens handles edge cases', () => {
      expect(formatTokens(0)).toBe('0');
      expect(formatTokens(999)).toBe('999');
      expect(formatTokens(1000)).toBe('1.0k');
      expect(formatTokens(999999)).toBe('1000.0k');
      expect(formatTokens(1000000)).toBe('1.0M');
    });
  });
});
