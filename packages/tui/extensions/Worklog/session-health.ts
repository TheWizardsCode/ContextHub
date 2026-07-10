/**
 * Session health extension for the Worklog Pi extension.
 *
 * Displays real-time session health metrics in the footer:
 * - Status indicator (idle, streaming, tool execution)
 * - Elapsed time since last response (colour-coded)
 * - Token usage (input/output)
 * - Context window usage percentage
 * - Current model ID and turn count
 *
 * Uses `ctx.ui.setFooter()` to replace the default footer with a custom
 * health display. Gracefully degrades in non-TUI modes.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { truncateToTerminalWidth, visibleWidth } from './terminal-utils.js';

// ── Status constants ──────────────────────────────────────────────────────

/** Status key used for the session health footer. */
export const SESSION_HEALTH_STATUS_KEY = 'worklog-session-health';

/** Status indicator for idle state. */
export const STATUS_IDLE = '○';

/** Status indicator for streaming state. */
export const STATUS_STREAMING = '●';

/** Status indicator for tool execution state. */
export const STATUS_TOOL = '⚡';

/**
 * Session health state.
 *
 * - `status`: Current session status (idle, streaming, or tool execution)
 * - `toolName`: Name of the currently executing tool (when status === 'tool')
 * - `lastResponseTime`: Timestamp of the last model response
 * - `turnCount`: Number of turns in the current session
 * - `inputTokens`: Cumulative input tokens
 * - `outputTokens`: Cumulative output tokens
 * - `contextUsage`: Context usage info from ctx.getContextUsage()
 */
export interface SessionHealthState {
  status: 'idle' | 'streaming' | 'tool';
  toolName: string | null;
  lastResponseTime: number | null;
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  contextUsage: { tokens: number | null; contextWindow: number; percent: number | null };
}

/** Default initial state. */
const DEFAULT_STATE: SessionHealthState = {
  status: 'idle',
  toolName: null,
  lastResponseTime: null,
  turnCount: 0,
  inputTokens: 0,
  outputTokens: 0,
  contextUsage: { tokens: null, contextWindow: 128000, percent: null },
};

/** Ticker interval in milliseconds (1 second). */
const TICK_INTERVAL_MS = 1000;

/**
 * Get elapsed time since a timestamp.
 *
 * @param timestamp - Timestamp in milliseconds
 * @returns Elapsed time in seconds (0 if timestamp is null/old)
 */
export function getElapsedTime(timestamp: number | null): number {
  if (!timestamp) return Infinity;
  return Math.max(0, (Date.now() - timestamp) / 1000);
}

/**
 * Format elapsed time for display.
 *
 * @param seconds - Elapsed time in seconds
 * @returns Formatted string (e.g., "3s", "1m 30s", "2m")
 */
export function formatElapsedTime(seconds: number): string {
  if (seconds === Infinity || seconds < 0) return '—';
  if (seconds < 10) return `${Math.round(seconds)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

/**
 * Get color for elapsed time based on thresholds.
 *
 * - Green (<5s): good response time
 * - Yellow (5-15s): moderate delay
 * - Orange (15-30s): significant delay
 * - Red (>30s): potentially stuck
 *
 * @param seconds - Elapsed time in seconds
 * @returns Theme color name
 */
export function getTimeColor(seconds: number): string {
  if (seconds === Infinity || seconds < 0) return 'dim';
  if (seconds < 5) return 'success';
  if (seconds <= 30) return 'warning';
  return 'error';
}

/**
 * Format token count with k suffix for large numbers.
 *
 * @param tokens - Token count
 * @returns Formatted string (e.g., "1.2k", "42")
 */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${tokens}`;
}

/**
 * Format context usage as "X%/Yk" string.
 *
 * @param usage - Context usage info
 * @returns Formatted string (e.g., "76.8%/128k", "—/128k")
 */
export function formatContextUsage(usage: SessionHealthState['contextUsage']): string {
  if (usage.tokens === null || usage.percent === null) {
    return `—/${formatTokens(usage.contextWindow)}`;
  }
  const windowStr = formatTokens(usage.contextWindow);
  return `${usage.percent.toFixed(1)}%/${windowStr}`;
}

/**
 * Build the footer render string.
 *
 * Layout: [marker] [age] ↑input ↓output [context%/window] [model] #[turn]
 *
 * @param state - Session health state
 * @param ctx - Extension context with UI and model access
 * @param theme - Theme function for styling
 * @param width - Available terminal width
 * @returns Rendered footer string
 */
export function renderFooter(
  state: SessionHealthState,
  ctx: ExtensionContext,
  theme: { fg: (color: string, text: string) => string },
  width: number,
): string {
  // ── Build left section ──────────────────────────────────────────────
  // Status marker
  let marker = '';
  switch (state.status) {
    case 'idle':
      marker = STATUS_IDLE;
      break;
    case 'streaming':
      marker = STATUS_STREAMING;
      break;
    case 'tool':
      marker = STATUS_TOOL + (state.toolName ? ` ${state.toolName}` : '');
      break;
  }
  const markerStr = theme.fg('dim', marker);

  // Elapsed time
  const elapsed = getElapsedTime(state.lastResponseTime);
  const timeStr = formatElapsedTime(elapsed);
  const timeColor = getTimeColor(elapsed);
  const timeStrStyled = theme.fg(timeColor, timeStr);

  // Token counts
  const tokensStr = `↑${formatTokens(state.inputTokens)} ↓${formatTokens(state.outputTokens)}`;
  const tokensStrStyled = theme.fg('muted', tokensStr);

  // Left section
  const left = `${markerStr} ${timeStrStyled} ${tokensStrStyled}`;

  // ── Build right section ─────────────────────────────────────────────
  // Context usage
  const contextStr = formatContextUsage(state.contextUsage);
  const contextStrStyled = theme.fg('dim', contextStr);

  // Model ID
  const modelId = ctx.model?.id ?? '—';
  const modelStr = theme.fg('dim', modelId);

  // Turn count
  const turnStr = theme.fg('dim', `#${state.turnCount}`);

  let right = `${contextStrStyled} ${modelStr} ${turnStr}`;

  // ── Layout ──────────────────────────────────────────────────────────
  // Calculate visible widths and pad
  const leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);
  const totalContentWidth = leftWidth + rightWidth;

  if (totalContentWidth >= width) {
    // Not enough space: truncate right
    const maxRight = Math.max(0, width - leftWidth - 1);
    right = truncateToTerminalWidth(right, maxRight, { ellipsis: '…' });
  }

  const padding = ' '.repeat(Math.max(0, width - totalContentWidth));
  return truncateToTerminalWidth(left + padding + right, width);
}

/**
 * Extract token usage from session entries.
 *
 * Iterates through session entries to sum up input/output tokens
 * from assistant messages.
 *
 * @param entries - Session entries from ctx.sessionManager.getBranch()
 * @returns { inputTokens, outputTokens }
 */
export function extractTokenUsage(
  entries: Array<{ type: string; message?: any }>,
): { inputTokens: number; outputTokens: number } {
  let inputTokens = 0;
  let outputTokens = 0;

  for (const entry of entries) {
    if (entry.type === 'message' && entry.message?.role === 'assistant') {
      const usage = entry.message.usage;
      if (usage) {
        inputTokens += usage.input || 0;
        outputTokens += usage.output || 0;
      }
    }
  }

  return { inputTokens, outputTokens };
}

/**
 * Register session health event handlers with a Pi extension instance.
 *
 * Subscribes to lifecycle events to track:
 * - Session turns and status changes
 * - Model selection changes
 * - Tool execution lifecycle
 *
 * The footer renderer updates every second via setInterval and on state
 * changes via tui.requestRender().
 *
 * @param pi - The ExtensionAPI instance
 */
export function registerSessionHealth(pi: ExtensionAPI): void {
  // ── State ───────────────────────────────────────────────────────────
  let state: SessionHealthState = { ...DEFAULT_STATE };
  let tickerInterval: ReturnType<typeof setInterval> | null = null;
  let requestRender: (() => void) | null = null;

  /**
   * Update state and request a footer re-render.
   */
  function updateState(
    _event: any,
    updates: Partial<SessionHealthState>,
  ): void {
    state = { ...state, ...updates };
    if (requestRender) {
      requestRender();
    }
  }

  // ── Event handlers ──────────────────────────────────────────────────

  // Track turns
  pi.on('turn_start', (_event) => {
    state.turnCount += 1;
    state.status = 'streaming';
    state.lastResponseTime = Date.now();
    updateState(_event, {});
  });

  pi.on('message_end', (event) => {
    if (event.message?.role === 'assistant') {
      // Reset to idle after assistant message ends
      state.status = 'idle';
      state.lastResponseTime = Date.now();
      updateState(event, {});
    }
  });

  // Tool execution lifecycle
  pi.on('tool_execution_start', (event) => {
    state.status = 'tool';
    state.toolName = event.toolName ?? null;
    updateState(event, {});
  });

  pi.on('tool_execution_end', (event) => {
    // Only reset to idle if we're not currently streaming
    if (state.status === 'tool') {
      state.status = 'idle';
      state.toolName = null;
      updateState(event, {});
    }
  });

  // Model selection
  pi.on('model_select', (event) => {
    updateState(event, {});
  });

  // Session start — reset counters
  pi.on('session_start', (_event, ctx) => {
    state = { ...DEFAULT_STATE, contextUsage: state.contextUsage };
    updateState(_event, {});

    // Set the footer and start the ticker on first session start
    setFooter(ctx);
    startTicker(ctx);
  });

  // Session shutdown — clean up ticker
  pi.on('session_shutdown', () => {
    if (tickerInterval) {
      clearInterval(tickerInterval);
      tickerInterval = null;
    }
  });

  // ── Ticker ──────────────────────────────────────────────────────────
  function startTicker(ctx: ExtensionContext): void {
    if (tickerInterval) return; // Already running

    // Refresh state from session
    function refreshState(): void {
      try {
        const entries = ctx.sessionManager.getBranch();
        const tokens = extractTokenUsage(entries);
        state.inputTokens = tokens.inputTokens;
        state.outputTokens = tokens.outputTokens;
        state.contextUsage = ctx.getContextUsage() ?? {
          tokens: null,
          contextWindow: 128000,
          percent: null,
        };
      } catch {
        // Best-effort: if session manager unavailable, keep current state
      }
    }

    refreshState(); // Initial refresh
    tickerInterval = setInterval(refreshState, TICK_INTERVAL_MS);
  }

  // ── Set footer ──────────────────────────────────────────────────────
  function setFooter(ctx: ExtensionContext): void {
    // Gracefully degrade in non-TUI modes
    if (ctx.mode !== 'tui') return;
    if (typeof ctx.ui.setFooter !== 'function') return;

    const theme = ctx.ui.theme;
    if (!theme?.fg) return;

    ctx.ui.setFooter((tui, _theme, footerData) => {
      // Store requestRender for use in event handlers
      requestRender = () => tui.requestRender();

      const disposeBranchChange = footerData.onBranchChange(() => tui.requestRender());
      return {
        dispose() {
          if (tickerInterval) {
            clearInterval(tickerInterval);
            tickerInterval = null;
          }
          disposeBranchChange();
        },
        invalidate() {
          // Theme changed — nothing special to do
        },
        render(width: number): string[] {
          const line = renderFooter(state, ctx, theme, width);
          return [line];
        },
      };
    });
  }
}
