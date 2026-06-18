/**
 * CLI output formatting with markdown rendering support.
 * Provides consistent formatting for CLI output using the existing
 * markdown renderer, with TTY awareness and safety for CI/TTY environments.
 */

import { renderMarkdownToTags, type RendererOptions } from './markdown-renderer.js';

/**
 * Telemetry event types for CLI rendering.
 * These are lightweight events that can be collected by observability tools.
 */
export interface CliRenderTelemetryEvent {
  /** Event name */
  event: 'cli_render_used' | 'cli_render_fallback_size' | 'cli_render_error';
  /** The CLI command that triggered the event */
  command?: string;
  /** Size of the input in characters */
  inputSize?: number;
  /** Maximum allowed size (for fallback_size events) */
  maxAllowed?: number;
  /** Whether the output is TTY */
  isTty?: boolean;
  /** Type of error (for error events) */
  errorType?: string;
}

/** Global telemetry event listeners */
const telemetryListeners: Array<(event: CliRenderTelemetryEvent) => void> = [];

/**
 * Register a telemetry event listener.
 * @param listener - Called when a telemetry event is emitted
 * @returns A function to unregister the listener
 */
export function onCliRenderEvent(listener: (event: CliRenderTelemetryEvent) => void): () => void {
  telemetryListeners.push(listener);
  return () => {
    const idx = telemetryListeners.indexOf(listener);
    if (idx >= 0) telemetryListeners.splice(idx, 1);
  };
}

/**
 * Emit a telemetry event to all registered listeners.
 */
function emitTelemetryEvent(event: CliRenderTelemetryEvent): void {
  for (const listener of telemetryListeners) {
    try {
      listener(event);
    } catch (_) {
      // Telemetry errors should never affect rendering
    }
  }
}

/**
 * Debug logger for CLI rendering events.
 * Uses WL_VERBOSE env var to control verbosity; falls back to silent.
 */
function debugLog(message: string): void {
  if (process.env.WL_VERBOSE) {
    console.error(`[cli-render] ${message}`);
  }
}

/**
 * Check if stdout is a TTY (interactive terminal)
 */
export function isTty(): boolean {
  return process.stdout.isTTY === true;
}

/**
 * Check if we should use formatted output.
 * Default is markdown in TTY, opt-out with --format text/plain.
 */
export function shouldUseFormattedOutput(enabledByFlag?: boolean): boolean {
  // If explicitly disabled, don't use formatting
  if (enabledByFlag === false) return false;
  // Default: use markdown in TTY environments, or if explicitly enabled
  return enabledByFlag === true || isTty();
}

/**
 * CLI output options
 */
export interface CliOutputOptions extends RendererOptions {
  /** Explicitly enable/disable formatting (overrides auto-detection) */
  formatAsMarkdown?: boolean;
  /** Fallback string when rendering fails or is skipped */
  fallback?: string;
}

/**
 * Resolve --format value to a formatAsMarkdown boolean.
 * Supports: markdown -> true, plain/text -> false, auto -> TTY auto-detect (undefined).
 * Returns undefined for unrecognized values (let auto-detection decide).
 */
export function resolveFormatToMarkdown(formatValue?: string): boolean | undefined {
  if (!formatValue) return undefined;
  const normalized = formatValue.toLowerCase().trim();
  if (normalized === 'markdown') return true;
  if (normalized === 'plain' || normalized === 'text') return false;
  if (normalized === 'auto') return undefined; // let TTY auto-detect decide
  // For other format values (full, summary, concise, normal, raw),
  // don't change markdown rendering — let auto-detect decide
  return undefined;
}

/**
 * Render markdown for CLI output.
 * 
 * This function:
 * - Detects TTY environment and falls back to plain text in non-TTY
 * - Respects explicit formatAsMarkdown flag
 * - Has a size guard to avoid expensive rendering on large content
 * - Strips ANSI codes when falling back for CI safety
 * - Emits telemetry events for rendering, size fallback, and errors
 * - Returns safe output for CI logs (no control characters outside TTY)
 * 
 * @param input - The markdown text to render
 * @param opts - Rendering options
 * @returns Rendered output with ANSI if in TTY, plain text otherwise
 */
export function renderCliMarkdown(input: string, opts?: CliOutputOptions): string {
  if (!input) return opts?.fallback ?? '';

  const maxSize = opts?.maxSize ?? 100_000;
  const formatAsMarkdown = opts?.formatAsMarkdown;

  // Check if we should use formatted output
  if (!shouldUseFormattedOutput(formatAsMarkdown)) {
    // Strip ANSI codes for plain text output (CI-safe)
    return stripAnsi(input);
  }

  // Use the existing renderer with CLI options
  const rendererOpts: RendererOptions = {
    maxSize
  };

  // Check size guard before rendering — if input exceeds maxSize,
  // strip ANSI sequences to ensure no control characters remain in output.
  if (input.length > maxSize) {
    emitTelemetryEvent({
      event: 'cli_render_fallback_size',
      inputSize: input.length,
      maxAllowed: maxSize,
      isTty: isTty()
    });
    debugLog(`Size guard: input ${input.length} chars exceeds max ${maxSize}, falling back to plain text`);
    return stripAnsi(input);
  }

  try {
    const result = renderMarkdownToTags(input, rendererOpts);
    emitTelemetryEvent({
      event: 'cli_render_used',
      inputSize: input.length,
      isTty: isTty()
    });

    // The result is already ANSI/chalk output. Return as-is; the calling
    // print functions will output it directly (no conversion needed).
    return result;
  } catch (_error) {
    // On rendering failure, prefer explicit fallback, then strip ANSI sequences from plain input
    // to ensure no control characters remain
    emitTelemetryEvent({
      event: 'cli_render_error',
      errorType: _error instanceof Error ? _error.message : 'unknown',
      inputSize: input.length,
      isTty: isTty()
    });
    debugLog(`Rendering failed, falling back to plain text`);
    return opts?.fallback ?? stripAnsi(input);
  }
}

/**
 * Strip ANSI escape codes from text for plain output (CI-safe).
 * Removes sequences like \u001b[31m used by chalk and other ANSI formatters.
 */
export function stripAnsi(input: string): string {
  if (!input) return '';
  // eslint-disable-next-line no-control-regex
  return input.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}



/**
 * Output wrapper for commands that emit formatted text.
 * Use this to wrap command output for markdown rendering support.
 * 
 * @example
 * ```ts
 * import { createCliOutput } from './cli-output.js';
 * 
 * const out = createCliOutput({ formatAsMarkdown: true });
 * out.print('# Header\nSome `code`');
 * ```
 */
export function createCliOutput(opts?: CliOutputOptions) {
  return {
    /**
     * Render and print to stdout
     */
    print: (text: string): void => {
      const rendered = renderCliMarkdown(text, opts);
      if (isTty()) {
        console.log(rendered);
      } else {
        console.log(stripAnsi(rendered));
      }
    },

    /**
     * Render and print to stderr
     */
    printError: (text: string): void => {
      const rendered = renderCliMarkdown(text, opts);
      if (isTty()) {
        console.error(rendered);
      } else {
        console.error(stripAnsi(rendered));
      }
    },

    /**
     * Render text without printing
     */
    render: (text: string): string => {
      return renderCliMarkdown(text, opts);
    },

    /**
     * Check if formatting is enabled
     */
    isFormatted: (): boolean => {
      return shouldUseFormattedOutput(opts?.formatAsMarkdown);
    }
  };
}

/**
 * Resolve whether markdown formatting should be enabled based on CLI flags,
 * config settings, and TTY auto-detection.
 *
 * This is the single source of truth for the CLI > config > auto-detect
 * precedence chain. All code paths that need to decide whether to render
 * markdown should use this function to avoid duplicating precedence logic.
 *
 * Precedence:
 * 1. --format markdown/plain/text → explicit on/off
 * 2. --format auto               → TTY auto-detect (skip config)
 * 3. programmatic override        → explicit on/off
 * 4. cliFormatMarkdown config     → explicit on/off
 * 5. (default)                   → TTY auto-detect
 *
 * @param opts - CLI and config options
 * @returns boolean | undefined — true=enabled, false=disabled, undefined=auto-detect
 */
export function resolveMarkdownEnabled(opts: {
  format?: string;
  formatAsMarkdown?: boolean;
  cliFormatMarkdown?: boolean;
}): boolean | undefined {
  // Priority 1: explicit --format values (markdown/plain/text)
  const formatMarkdown = resolveFormatToMarkdown(opts.format);
  if (formatMarkdown !== undefined) {
    return formatMarkdown;
  }
  // Priority 2: --format auto is an explicit CLI choice for TTY auto-detect;
  // do NOT fall through to config.
  if (opts.format && opts.format.toLowerCase() === 'auto') {
    return isTty();
  }
  // Priority 3: programmatic override
  if (opts.formatAsMarkdown === true) return true;
  if (opts.formatAsMarkdown === false) return false;
  // Priority 4: config file setting
  if (opts.cliFormatMarkdown === true) return true;
  if (opts.cliFormatMarkdown === false) return false;
  // Priority 5: undefined — auto-detect from TTY
  return undefined;
}

/**
 * Create CLI output from command options (program opts) and config.
 * Merges CLI flag with config setting using priority: CLI > config > auto-detect.
 *
 * @param programOpts - Parsed CLI options (e.g. program.opts())
 * @param configOpts - Config file options (e.g. cliFormatMarkdown setting)
 */
export function createCliOutputFromCommand(
  programOpts: { format?: string; formatAsMarkdown?: boolean },
  configOpts?: { cliFormatMarkdown?: boolean }
): ReturnType<typeof createCliOutput> {
  const enabled = resolveMarkdownEnabled({
    format: programOpts.format,
    formatAsMarkdown: programOpts.formatAsMarkdown,
    cliFormatMarkdown: configOpts?.cliFormatMarkdown,
  });
  return createCliOutput({ formatAsMarkdown: enabled });
}

export default createCliOutput;