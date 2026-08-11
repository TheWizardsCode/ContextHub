/**
 * CLI output formatting with markdown rendering support.
 * Provides consistent formatting for CLI output using the existing
 * markdown renderer, with TTY awareness and safety for CI/TTY environments.
 */
import { type RendererOptions } from './markdown-renderer.js';
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
/**
 * Register a telemetry event listener.
 * @param listener - Called when a telemetry event is emitted
 * @returns A function to unregister the listener
 */
export declare function onCliRenderEvent(listener: (event: CliRenderTelemetryEvent) => void): () => void;
/**
 * Check if stdout is a TTY (interactive terminal)
 */
export declare function isTty(): boolean;
/**
 * Check if we should use formatted output.
 * Default is markdown in TTY, opt-out with --format text/plain.
 */
export declare function shouldUseFormattedOutput(enabledByFlag?: boolean): boolean;
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
export declare function resolveFormatToMarkdown(formatValue?: string): boolean | undefined;
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
export declare function renderCliMarkdown(input: string, opts?: CliOutputOptions): string;
/**
 * Strip ANSI escape codes from text for plain output (CI-safe).
 * Removes sequences like \u001b[31m used by chalk and other ANSI formatters.
 */
export declare function stripAnsi(input: string): string;
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
export declare function createCliOutput(opts?: CliOutputOptions): {
    /**
     * Render and print to stdout
     */
    print: (text: string) => void;
    /**
     * Render and print to stderr
     */
    printError: (text: string) => void;
    /**
     * Render text without printing
     */
    render: (text: string) => string;
    /**
     * Check if formatting is enabled
     */
    isFormatted: () => boolean;
};
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
export declare function resolveMarkdownEnabled(opts: {
    format?: string;
    formatAsMarkdown?: boolean;
    cliFormatMarkdown?: boolean;
}): boolean | undefined;
/**
 * Create CLI output from command options (program opts) and config.
 * Merges CLI flag with config setting using priority: CLI > config > auto-detect.
 *
 * @param programOpts - Parsed CLI options (e.g. program.opts())
 * @param configOpts - Config file options (e.g. cliFormatMarkdown setting)
 */
export declare function createCliOutputFromCommand(programOpts: {
    format?: string;
    formatAsMarkdown?: boolean;
}, configOpts?: {
    cliFormatMarkdown?: boolean;
}): ReturnType<typeof createCliOutput>;
export default createCliOutput;
//# sourceMappingURL=cli-output.d.ts.map