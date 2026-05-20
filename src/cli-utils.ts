/**
 * Shared CLI utilities and context factory
 */

import type { Command } from 'commander';
import { WorklogDatabase } from './database.js';
import { loadConfig, loadConfigRelaxed, isInitialized, getDefaultPrefix } from './config.js';
import { getDefaultDataPath } from './jsonl.js';
import type { PluginContext } from './plugin-types.js';
import { renderCliMarkdown, shouldUseFormattedOutput, type CliOutputOptions } from './cli-output.js';

import { WORKLOG_VERSION } from './version.js';

/**
 * Output formatting helpers
 */
export function createOutputHelpers(program: Command) {
  return {
    json: (data: any) => {
      console.log(JSON.stringify(data, null, 2));
    },
    
    success: (message: string, jsonData?: any) => {
      const isJsonMode = program.opts().json;
      if (isJsonMode) {
        console.log(JSON.stringify(jsonData || { success: true, message }, null, 2));
      } else {
        console.log(message);
      }
    },
    
    error: (message: string, jsonData?: any) => {
      const isJsonMode = program.opts().json;
      if (isJsonMode) {
        console.error(JSON.stringify(jsonData || { success: false, error: message }, null, 2));
      } else {
        console.error(message);
      }
    }
  };
}

/**
 * Create markdown-formatted output helpers for the CLI.
 * Uses the CLI format option to determine whether to render markdown.
 * In JSON mode, output is unchanged (JSON consumers handle their own formatting).
 * 
 * @param program - The commander program instance
 * @param opts - Optional CLI output options for markdown rendering
 * @returns Output helpers with markdown rendering support
 */
export function createMarkdownOutputHelpers(program: Command, opts?: CliOutputOptions) {
  const base = createOutputHelpers(program);
  const programOpts = program.opts();
  
  // Read config for cliFormatMarkdown setting
  const config = loadConfig();
  const configCliFormatMarkdown = config?.cliFormatMarkdown;
  
  // Determine if markdown formatting should be used:
  // - Never use in JSON mode (machine-readable takes precedence)
  // - Default: markdown in TTY (auto-detect), opt-out with --format text/plain
  // - Explicit --format markdown: enable
  // - Precedence: CLI > config > auto-detect
  // Determine if markdown formatting should be used:
  // - Never use in JSON mode (machine-readable takes precedence)
  // - Precedence: CLI flag > config > auto-detect (TTY)
  // - --format auto is an explicit CLI choice: use TTY detection, skip config
  let useMarkdown: boolean | undefined = undefined;
  if (programOpts.json) {
    useMarkdown = false; // JSON mode takes precedence
  } else if (programOpts.format === 'markdown') {
    useMarkdown = true;
  } else if (programOpts.format === 'text' || programOpts.format === 'plain') {
    useMarkdown = false;
  } else if (programOpts.format && programOpts.format.toLowerCase() === 'auto') {
    // --format auto: explicit CLI choice to auto-detect from TTY; skip config.
    useMarkdown = process.stdout.isTTY === true;
  } else if (configCliFormatMarkdown === true) {
    useMarkdown = true;
  } else if (configCliFormatMarkdown === false) {
    useMarkdown = false;
  }
  // else undefined: let shouldUseFormattedOutput() auto-detect based on TTY
  
  return {
    ...base,
    
    /**
     * Print markdown-rendered output to stdout
     */
    print: (text: string): void => {
      if (programOpts.json) {
        // In JSON mode, just print as-is
        console.log(text);
      } else {
        const rendered = renderCliMarkdown(text, { formatAsMarkdown: useMarkdown, ...opts });
        console.log(rendered);
      }
    },
    
    /**
     * Print markdown-rendered output to stderr
     */
    printError: (text: string): void => {
      if (programOpts.json) {
        console.error(text);
      } else {
        const rendered = renderCliMarkdown(text, { formatAsMarkdown: useMarkdown, ...opts });
        console.error(rendered);
      }
    },
    
    /**
     * Render markdown without printing
     */
    render: (text: string): string => {
      return renderCliMarkdown(text, { formatAsMarkdown: useMarkdown, ...opts });
    },
    
    /**
     * Check if markdown formatting is active
     */
    isFormatted: (): boolean => {
      // If explicitly set to false, not formatted
      if (useMarkdown === false) return false;
      // Otherwise check auto-detection
      return shouldUseFormattedOutput(useMarkdown);
    }
  };
}

/**
 * Check if worklog is initialized and exit if not
 * Outputs proper error messages based on JSON mode
 */
export function createRequireInitialized(program: Command) {
  return (): void => {
    if (!isInitialized()) {
      const isJsonMode = program.opts().json;
      if (isJsonMode) {
        console.log(JSON.stringify({
          success: false,
          initialized: false,
          error: 'Worklog system is not initialized. Run "worklog init" first.'
        }, null, 2));
      } else {
        console.error('Error: Worklog system is not initialized.');
        console.error('Run "worklog init" to initialize the system.');
      }
      process.exit(1);
    }
  };
}

/**
 * Get database instance with optional prefix override
 */
export function getDatabase(prefix?: string, program?: Command): WorklogDatabase {
  const config = loadConfigRelaxed();
  const effectivePrefix = prefix || config?.prefix || getDefaultPrefix();
  const dataPath = getDefaultDataPath();
  
  // Get auto-sync settings from config
  const autoSync = config?.autoSync === true; // Default to false
  
  // Determine silent mode: suppress output unless verbose OR not in JSON mode
  const isJsonMode = program?.opts?.()?.json || false;
  const isVerbose = program?.opts?.()?.verbose || false;
  const silent = isJsonMode || !isVerbose;
  
  return new WorklogDatabase(effectivePrefix, undefined, dataPath, silent, autoSync);
}

/**
 * Get prefix from config or use override
 */
export function getPrefix(overridePrefix?: string): string {
  if (overridePrefix) {
    return overridePrefix.toUpperCase();
  }
  return getDefaultPrefix();
}

/**
 * Normalize an ID provided on the CLI. If the value already contains a dash
 * (assumed to include a prefix) it will be upper-cased and returned as-is.
 * Otherwise the configured default prefix (or provided override) is prepended
 * and the resulting ID is returned in upper-case. Returns undefined for
 * undefined/empty input.
 */
export function normalizeCliId(id?: string, overridePrefix?: string): string | undefined {
  if (!id && id !== '') return undefined;
  const trimmed = (id || '').toString().trim();
  if (trimmed === '') return undefined;

  // If it already contains a dash, assume it has a prefix and normalize casing
  if (trimmed.includes('-')) return trimmed.toUpperCase();

  const prefix = getPrefix(overridePrefix);
  return `${prefix}-${trimmed.toUpperCase()}`;
}

/**
 * Create shared plugin context
 */
export function createPluginContext(program: Command): PluginContext {
  const markdownOutput = createMarkdownOutputHelpers(program);
  return {
    program,
    version: WORKLOG_VERSION,
    dataPath: getDefaultDataPath(),
    output: createOutputHelpers(program),
    markdown: {
      print: markdownOutput.print,
      printError: markdownOutput.printError,
      render: markdownOutput.render,
      isFormatted: markdownOutput.isFormatted
    },
    utils: {
      requireInitialized: createRequireInitialized(program),
      getDatabase: (prefix?: string) => getDatabase(prefix, program),
      getConfig: loadConfig,
      getPrefix,
      normalizeCliId,
      isJsonMode: () => program.opts().json
    }
  };
}

/**
 * Get Worklog version
 */
export function getVersion(): string {
  try {
    // Resolve package.json relative to project root (where this module is
    // located). Use dynamic import so this works under ESM and in tests.
    // Keep this synchronous-ish by using require-style read via fs.
    // Use a try/catch to avoid throwing in environments where filesystem
    // access is restricted.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    const pkgPath = path.resolve(process.cwd(), 'package.json');
    // We deliberately avoid require() because of ESM; use fs.readFileSync instead.
    // Import fs lazily to keep startup cost low.
    const fs = require('fs');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw);
    if (pkg && pkg.version) return String(pkg.version);
  } catch (_) {
    // ignore and fall back
  }
  return WORKLOG_VERSION;
}
