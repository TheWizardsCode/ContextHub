/**
 * Plugin loader - discovers and loads CLI command plugins
 *
 * Plugins are discovered from two directories (in priority order):
 *   1. Project-local: <project>/.worklog/plugins/  (highest priority)
 *   2. Global: ${XDG_CONFIG_HOME:-$HOME/.config}/worklog/.worklog/plugins/
 *
 * When the same plugin filename exists in both directories the project-local
 * version takes precedence and the global copy is silently skipped.
 *
 * The WORKLOG_PLUGIN_DIR environment variable overrides **both** directories
 * (only the single path it specifies is scanned).
 */
import type { PluginContext, PluginInfo, PluginLoaderOptions } from './plugin-types.js';
/**
 * Get the default (project-local) plugin directory path.
 * @returns Absolute path to the project-local plugin directory
 */
export declare function getDefaultPluginDir(): string;
/**
 * Get the global plugin directory path.
 *
 * Resolution: ${XDG_CONFIG_HOME}/worklog/.worklog/plugins/
 * Falls back to $HOME/.config/worklog/.worklog/plugins/ when
 * XDG_CONFIG_HOME is unset.
 *
 * @returns Absolute path to the global plugin directory
 */
export declare function getGlobalPluginDir(): string;
/**
 * Resolve the plugin directory based on config and environment.
 * Priority: WORKLOG_PLUGIN_DIR env var > provided option > default
 *
 * NOTE: When WORKLOG_PLUGIN_DIR is set it acts as a single-directory
 * override and the global directory is **not** scanned.
 */
export declare function resolvePluginDir(options?: PluginLoaderOptions): string;
/**
 * Discover plugin files in the plugin directory.
 * Only includes .js and .mjs files, excludes .d.ts, .map, etc.
 */
export declare function discoverPlugins(pluginDir: string): string[];
/**
 * Discover plugins from multiple directories with precedence.
 *
 * Scans each directory in order.  If a plugin filename appears in more than
 * one directory the version from the **first** directory that contains it
 * wins (project-local before global).
 *
 * @param dirs  Ordered list of plugin directories (highest priority first)
 * @returns     Deduplicated list of { filePath, source } entries in
 *              deterministic lexicographic order by filename.
 */
export declare function discoverAllPlugins(dirs: string[]): Array<{
    filePath: string;
    source: string;
}>;
/**
 * Load a single plugin file.
 * @returns Plugin info with load status
 */
export declare function loadPlugin(pluginPath: string, ctx: PluginContext, verbose?: boolean, source?: string): Promise<PluginInfo>;
/**
 * Load all plugins from the configured plugin directories.
 *
 * When WORKLOG_PLUGIN_DIR or `options.pluginDir` is set, only that single
 * directory is scanned (backwards-compatible behaviour).
 *
 * Otherwise, plugins are discovered from:
 *   1. Project-local: <project>/.worklog/plugins/
 *   2. Global: ${XDG_CONFIG_HOME:-$HOME/.config}/worklog/.worklog/plugins/
 *
 * Project-local plugins override global plugins with the same filename.
 *
 * @returns Array of plugin info objects
 */
export declare function loadPlugins(ctx: PluginContext, options?: PluginLoaderOptions): Promise<PluginInfo[]>;
/**
 * Check if a command name is already registered
 */
export declare function hasCommand(program: any, commandName: string): boolean;
//# sourceMappingURL=plugin-loader.d.ts.map