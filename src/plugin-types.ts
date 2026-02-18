/**
 * Plugin system type definitions
 */

import type { Command } from 'commander';
import type { WorklogDatabase } from './database.js';
import type { WorklogConfig } from './types.js';

/**
 * Shared context passed to all plugin register functions
 */
export interface PluginContext {
  /** Commander program instance */
  program: Command;
  
  /** Worklog version */
  version: string;
  
  /** Default data path */
  dataPath: string;
  
  /** Output helpers */
  output: {
    /** Output data as JSON */
    json: (data: any) => void;
    /** Output success message (respects --json flag) */
    success: (message: string, jsonData?: any) => void;
    /** Output error message (respects --json flag) */
    error: (message: string, jsonData?: any) => void;
  };
  
  /** Utilities */
  utils: {
    /** Check if worklog is initialized */
    requireInitialized: () => void;
    /** Get database instance with optional prefix override */
    getDatabase: (prefix?: string) => WorklogDatabase;
    /** Get current configuration */
    getConfig: () => WorklogConfig | null;
    /** Get prefix from config or override */
    getPrefix: (overridePrefix?: string) => string;
    /** Normalize a CLI-provided ID by applying default prefix if missing */
    normalizeCliId: (id?: string, overridePrefix?: string) => string | undefined;
    /** Check if in JSON output mode */
    isJsonMode: () => boolean;
  };
}

/**
 * Plugin registration function signature
 */
export type PluginRegisterFn = (ctx: PluginContext) => void | Promise<void>;

/**
 * Plugin module interface - ESM default export
 */
export interface PluginModule {
  default: PluginRegisterFn;
}

/**
 * Information about a discovered plugin
 */
export interface PluginInfo {
  /** Plugin file name */
  name: string;
  /** Absolute path to plugin file */
  path: string;
  /** Whether the plugin loaded successfully */
  loaded: boolean;
  /** Error message if loading failed */
  error?: string;
  /** Directory the plugin was discovered in (e.g. project-local or global) */
  source?: string;
}

/**
 * Plugin loader configuration
 */
export interface PluginLoaderOptions {
  /** Plugin directory path (absolute or relative to cwd) */
  pluginDir?: string;
  /** Whether to enable verbose logging */
  verbose?: boolean;
}
