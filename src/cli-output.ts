/**
 * CLI output formatting with markdown rendering support.
 * Provides consistent formatting for CLI output using the existing
 * markdown renderer, with TTY awareness and safety for CI/TTY environments.
 */

import { renderMarkdownToTags, type RendererOptions } from './tui/markdown-renderer.js';

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
 * Render markdown for CLI output.
 * 
 * This function:
 * - Detects TTY environment and falls back to plain text in non-TTY
 * - Respects explicit formatAsMarkdown flag
 * - Has a size guard to avoid expensive rendering on large content
 * - Returns safe output for CI logs (no control characters outside TTY)
 * 
 * @param input - The markdown text to render
 * @param opts - Rendering options
 * @returns Rendered output with blessed tags if in TTY, plain text otherwise
 */
export function renderCliMarkdown(input: string, opts?: CliOutputOptions): string {
  if (!input) return opts?.fallback ?? '';

  const maxSize = opts?.maxSize ?? 100_000;
  const formatAsMarkdown = opts?.formatAsMarkdown;

  // Check if we should use formatted output
  if (!shouldUseFormattedOutput(formatAsMarkdown)) {
    // Strip any blessed tags for plain text output (CI-safe)
    return stripBlessedTags(input);
  }

  // Use the existing renderer with CLI options
  const rendererOpts: RendererOptions = {
    maxSize
  };

  try {
    return renderMarkdownToTags(input, rendererOpts);
  } catch (error) {
    // On rendering failure, return original input (safe fallback)
    console.error('Warning: markdown rendering failed, falling back to plain text');
    return input;
  }
}

/**
 * Strip blessed tags from text for plain output (CI-safe).
 * Removes {tag} patterns used by blessed.
 */
export function stripBlessedTags(input: string): string {
  if (!input) return '';
  return input.replace(/\{[^}]+\}/g, '');
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
      console.log(rendered);
    },

    /**
     * Render and print to stderr
     */
    printError: (text: string): void => {
      const rendered = renderCliMarkdown(text, opts);
      console.error(rendered);
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
 * Create CLI output from command options (program opts).
 * Merges CLI flag with config setting.
 */
export function createCliOutputFromCommand(
  programOpts: { format?: string; formatAsMarkdown?: boolean },
  configOpts?: { cliFormatMarkdown?: boolean }
): ReturnType<typeof createCliOutput> {
  let enabled: boolean | undefined = undefined;

  // Priority: CLI flag > config > auto-detect
  if (programOpts.format === 'markdown') {
    enabled = true;
  } else if (programOpts.formatAsMarkdown === true) {
    enabled = true;
  } else if (configOpts?.cliFormatMarkdown === true) {
    enabled = true;
  } else if (programOpts.format === 'plain' || configOpts?.cliFormatMarkdown === false) {
    enabled = false;
  }

  return createCliOutput({ formatAsMarkdown: enabled });
}

export default createCliOutput;