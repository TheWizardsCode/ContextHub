/**
 * Shared CLI utilities and context factory
 */
import type { Command } from 'commander';
import { WorklogDatabase } from './database.js';
import type { PluginContext } from './plugin-types.js';
import { type CliOutputOptions } from './cli-output.js';
/**
 * Output formatting helpers
 */
export declare function createOutputHelpers(program: Command): {
    json: (data: any) => void;
    success: (message: string, jsonData?: any) => void;
    error: (message: string, jsonData?: any) => void;
};
/**
 * Create markdown-formatted output helpers for the CLI.
 * Uses the CLI format option to determine whether to render markdown.
 * In JSON mode, output is unchanged (JSON consumers handle their own formatting).
 *
 * @param program - The commander program instance
 * @param opts - Optional CLI output options for markdown rendering
 * @returns Output helpers with markdown rendering support
 */
export declare function createMarkdownOutputHelpers(program: Command, opts?: CliOutputOptions): {
    /**
     * Print markdown-rendered output to stdout
     */
    print: (text: string) => void;
    /**
     * Print markdown-rendered output to stderr
     */
    printError: (text: string) => void;
    /**
     * Render markdown without printing
     */
    render: (text: string) => string;
    /**
     * Check if markdown formatting is active
     */
    isFormatted: () => boolean;
    json: (data: any) => void;
    success: (message: string, jsonData?: any) => void;
    error: (message: string, jsonData?: any) => void;
};
/**
 * Check if worklog is initialized and exit if not
 * Outputs proper error messages based on JSON mode
 */
export declare function createRequireInitialized(program: Command): () => void;
/**
 * Get database instance with optional prefix override
 */
export declare function getDatabase(prefix?: string, program?: Command): WorklogDatabase;
/**
 * Get prefix from config or use override
 */
export declare function getPrefix(overridePrefix?: string): string;
/**
 * Normalize an ID provided on the CLI. If the value already contains a dash
 * (assumed to include a prefix) it will be upper-cased and returned as-is.
 * Otherwise the configured default prefix (or provided override) is prepended
 * and the resulting ID is returned in upper-case. Returns undefined for
 * undefined/empty input.
 */
export declare function normalizeCliId(id?: string, overridePrefix?: string): string | undefined;
/**
 * Create shared plugin context
 */
export declare function createPluginContext(program: Command): PluginContext;
/**
 * Get Worklog version
 */
export declare function getVersion(): string;
//# sourceMappingURL=cli-utils.d.ts.map