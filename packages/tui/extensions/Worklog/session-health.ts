/**
 * Session health extension for the Worklog Pi extension.
 *
 * Displays real-time session health metrics in the footer:
 * - Status indicator (idle, streaming, tool execution)
 * - Elapsed time since last response (colour-coded)
 * - Token usage (input/output)
 * - Context window usage percentage
 * - Provider/model on a dedicated line
 * - Turn count
 *
 * Uses `ctx.ui.setFooter()` to replace the default footer with a custom
 * health display. Gracefully degrades in non-TUI modes.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { truncateToTerminalWidth, visibleWidth } from './terminal-utils.js';
import { getResolvedModel, getSelectedModel, onModelChange } from './model-display.js';

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
 * - `lastResponseTime`: Timestamp of the last model response (updated at
 *   `turn_start` and `message_end`; used for the center elapsed timer)
 * - `lastChunkTime`: Timestamp of the last `message_update` event (updated
 *   only during active streaming; used for the "last chunk" timer in the
 *   left section)
 * - `turnCount`: Number of turns in the current session
 * - `inputTokens`: Cumulative input tokens
 * - `outputTokens`: Cumulative output tokens
 * - `contextUsage`: Context usage info from ctx.getContextUsage()
 */
export interface SessionHealthState {
  status: 'idle' | 'streaming' | 'tool';
  toolName: string | null;
  lastResponseTime: number | null;
  lastChunkTime: number | null;
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  contextUsage: { tokens: number | null; contextWindow: number; percent: number | null };
  /** First few characters of the session's initial user message. */
  initialPrompt: string | null;
}

/** Default initial state. */
const DEFAULT_STATE: SessionHealthState = {
  status: 'idle',
  toolName: null,
  lastResponseTime: null,
  lastChunkTime: null,
  turnCount: 0,
  inputTokens: 0,
  outputTokens: 0,
  contextUsage: { tokens: null, contextWindow: 128000, percent: null },
  initialPrompt: null,
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
 * Format a short "Xs ago" string for the last-chunk indicator.
 *
 * Used only during active streaming to show how long it has been since the
 * last streaming chunk arrived.
 *
 * @param seconds - Elapsed time in seconds
 * @returns Formatted string (e.g., "2s ago", "1m 5s ago")
 */
export function formatShortElapsedTime(seconds: number): string {
  if (seconds === Infinity || seconds < 0) return '—';
  if (seconds < 10) return `${Math.round(seconds)}s ago`;
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return secs > 0 ? `${mins}m ${secs}s ago` : `${mins}m ago`;
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
 * Layout (three-section):
 *   Left:  [marker] [#turn] Xs ago
 *   Center: [elapsed since stage start]
 *   Right: ↑input ↓output [context%/window]
 *
 * The model/provider is displayed on a dedicated line below the session
 * health line (see the `render()` function in `registerSessionHealth`).
 * The elapsed time since last chunk (e.g. "4s ago") appears only when
 * `status === 'streaming'`.
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
  // ── Left section ────────────────────────────────────────────────────
  // Status marker with label
  let marker = '';
  switch (state.status) {
    case 'idle':
      marker = `${STATUS_IDLE} Idle`;
      break;
    case 'streaming':
      marker = `${STATUS_STREAMING} Streaming`;
      break;
    case 'tool':
      marker = `${STATUS_TOOL}${state.toolName ? ` Tool: ${state.toolName}` : ' Tool'}`;
      break;
  }
  const markerStr = theme.fg('dim', marker);

  // Turn count
  const turnStr = theme.fg('dim', `#${state.turnCount}`);

  // Last chunk indicator (streaming only)
  let lastChunkStr = '';
  if (state.status === 'streaming' && state.lastChunkTime !== null) {
    const chunkElapsed = getElapsedTime(state.lastChunkTime);
    const lastChunkElapsed = formatShortElapsedTime(chunkElapsed);
    lastChunkStr = theme.fg('dim', lastChunkElapsed);
  }

  const left = `${markerStr} ${turnStr} ${lastChunkStr}`;

  // ── Center section ──────────────────────────────────────────────────
  // Elapsed time since the stage started (lastResponseTime updated at
  // turn_start and message_end)
  const elapsed = getElapsedTime(state.lastResponseTime);
  const timeStr = formatElapsedTime(elapsed);
  const timeColor = getTimeColor(elapsed);
  const timeStrStyled = theme.fg(timeColor, timeStr);

  // ── Right section ───────────────────────────────────────────────────
  // Token counts
  const tokensStr = `↑${formatTokens(state.inputTokens)} ↓${formatTokens(state.outputTokens)}`;
  const tokensStrStyled = theme.fg('muted', tokensStr);

  // Context usage
  const contextStr = formatContextUsage(state.contextUsage);
  const contextStrStyled = theme.fg('dim', contextStr);

  // Model ID is now displayed on its own line below the session health line
  let right = `${tokensStrStyled} ${contextStrStyled}`;

  // ── Layout ──────────────────────────────────────────────────────────
  // Calculate visible widths and pad
  const leftWidth = visibleWidth(left);
  const centerWidth = visibleWidth(timeStrStyled);
  const rightWidth = visibleWidth(right);
  // Account for the space between center and right sections
  const hasSeparatorSpace = rightWidth > 0 ? 1 : 0;
  const totalContentWidth = leftWidth + centerWidth + rightWidth + hasSeparatorSpace;

  if (totalContentWidth >= width) {
    // Not enough space: truncate right
    const maxRight = Math.max(0, width - leftWidth - centerWidth - 1);
    right = truncateToTerminalWidth(right, maxRight, { ellipsis: '…' });
  }

  const padding = ' '.repeat(Math.max(0, width - totalContentWidth));
  return truncateToTerminalWidth(left + padding + timeStrStyled + ' ' + right, width);
}

/**
 * Extract the first user message content from session entries.
 * Returns the first line of the initial user message, or null if none found.
 *
 * Handles:
 * - String content (legacy format)
 * - Array content (Pi's default format: [{ type: "text", text: "..." }, ...])
 * - Skill expansion blocks (<skill name="...">...</skill>) — returns a compact
 *   representation like "[skill:audit] WL-123" instead of the raw XML first line
 *
 * Text extraction matches the approach used by Pi's own `extractTextContent`
 * in session-manager.js and `_getUserMessageText` in agent-session.js.
 *
 * @param entries - Session entries from ctx.sessionManager.getBranch()
 * @returns Initial user prompt text, or null
 */
export function extractInitialPrompt(
  entries: Array<{ type: string; message?: any }>,
): string | null {
  for (const entry of entries) {
    if (entry.type === 'message' && entry.message?.role === 'user') {
      const content = entry.message.content;
      const text = extractMessageText(content);
      if (!text) continue;

      // Check for skill expansion block: <skill name="...">...</skill>
      // Pi expands /skill:name into a wrapping XML block before storing
      const skillBlockMatch = text.match(/^<skill\s+name="([^"]*)"/);
      if (skillBlockMatch) {
        const skillName = skillBlockMatch[1];
        // Extract args after the closing </skill> tag
        const afterSkill = text.match(/<\/skill>\s*\n?\s*([\s\S]*)$/);
        const args = afterSkill ? afterSkill[1].trim() : '';
        return args ? `[skill:${skillName}] ${args}` : `[skill:${skillName}]`;
      }

      // Regular content: return first line
      return text.split('\n')[0].trim();
    }
  }
  return null;
}

/**
 * Extract text content from a message content field, which may be either
 * a string (legacy format) or an array of TextContent/ImageContent parts
 * (Pi's default format).
 *
 * Matches the approach used by Pi's own `extractTextContent` in
 * session-manager.js and `_getUserMessageText` in agent-session.js.
 *
 * @param content - The message.content field (string or content part array)
 * @returns The extracted text, or null if the content is empty or non-text
 */
function extractMessageText(content: any): string | null {
  if (typeof content === 'string') {
    return content.trim() || null;
  }
  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const part of content) {
      if (part.type === 'text' && typeof part.text === 'string') {
        textParts.push(part.text);
      }
    }
    const combined = textParts.join('\n').trim();
    return combined || null;
  }
  return null;
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

  // Track streaming chunks — updates lastChunkTime only on message_update
  pi.on('message_update', (_event) => {
    state.lastChunkTime = Date.now();
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

  // Listen for model/provider changes and trigger a footer re-render
  pi.on('after_provider_response', (_event) => {
    if (requestRender) requestRender();
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
        // Capture the initial prompt on first encounter (it may be set
        // on the very first tick after session_start)
        if (!state.initialPrompt) {
          state.initialPrompt = extractInitialPrompt(entries);
          requestRender?.();
        }
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
      // Subscribe to model state changes for reactive footer updates
      let disposeModelChange: (() => void) | null = null;
      return {
        dispose() {
          if (tickerInterval) {
            clearInterval(tickerInterval);
            tickerInterval = null;
          }
          if (disposeModelChange) {
            disposeModelChange();
            disposeModelChange = null;
          }
          disposeBranchChange();
        },
        invalidate() {
          // Theme changed — nothing special to do
        },
        render(width: number): string[] {
          const lines: string[] = [];

          // Subscribe to model changes on first render
          if (!disposeModelChange) {
            disposeModelChange = onModelChange(() => tui.requestRender());
          }

          // Line 1: Extension statuses (activity-indicator, etc.)
          // These are set via ctx.ui.setStatus() and would be hidden when a
          // custom footer is active. We include them here so that status
          // entries remain visible.
          // Note: The provider/model is no longer shown as a status entry;
          // it is displayed on Line 3 below.
          const statuses = footerData.getExtensionStatuses();
          if (statuses && statuses.length > 0) {
            const statusLine = statuses.join('  ');
            lines.push(truncateToTerminalWidth(theme.fg('muted', statusLine), width));
          }

          // Line 2: Session health
          lines.push(renderFooter(state, ctx, theme, width));

          // Line 3: Provider/model + initial prompt preview (grey/dim text)
          // Shows the Pi model alias (e.g. "code", "plan") and, when available,
          // the provider/model resolved by the router (e.g. "openai/gpt-4").
          // Also shows a preview of the first user message that started the
          // session when available. Always visible.
          const selectedModel = getSelectedModel();
          const resolvedModel = getResolvedModel();
          const initialPrompt = state.initialPrompt;

          // Build model portion
          let modelPart: string;
          if (selectedModel && resolvedModel) {
            modelPart = `${selectedModel} → ${resolvedModel}`;
          } else if (selectedModel) {
            modelPart = selectedModel;
          } else if (resolvedModel) {
            modelPart = resolvedModel;
          } else {
            modelPart = '—';
          }

          // Build initial prompt portion (quoted preview)
          let promptPart: string | null = null;
          if (initialPrompt) {
            // Limit to ~40 chars for a reasonable preview
            const preview =
              initialPrompt.length > 40 ? `${initialPrompt.slice(0, 37)}...` : initialPrompt;
            promptPart = `"${preview}"`;
          }

          const label = promptPart ? `${modelPart}  │  ${promptPart}` : modelPart;
          lines.push(truncateToTerminalWidth(theme.fg('dim', label), width));

          return lines;
        },
      };
    });
  }
}
