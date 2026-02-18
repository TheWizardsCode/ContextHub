/**
 * Plugin loader - discovers and loads CLI command plugins
 *
 * Plugins are discovered from two directories (in priority order):
 *   1. Project-local: <project>/.worklog/plugins/  (highest priority)
 *   2. Global: ${XDG_CONFIG_HOME:-$HOME/.config}/opencode/.worklog/plugins/
 *
 * When the same plugin filename exists in both directories the project-local
 * version takes precedence and the global copy is silently skipped.
 *
 * The WORKLOG_PLUGIN_DIR environment variable overrides **both** directories
 * (only the single path it specifies is scanned).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import type { PluginContext, PluginInfo, PluginLoaderOptions, PluginModule } from './plugin-types.js';
import { resolveWorklogDir } from './worklog-paths.js';
import { Logger } from './logger.js';

/**
 * Get the default (project-local) plugin directory path.
 * @returns Absolute path to the project-local plugin directory
 */
export function getDefaultPluginDir(): string {
  return path.join(resolveWorklogDir(), 'plugins');
}

/**
 * Get the global plugin directory path.
 *
 * Resolution: ${XDG_CONFIG_HOME}/opencode/.worklog/plugins/
 * Falls back to $HOME/.config/opencode/.worklog/plugins/ when
 * XDG_CONFIG_HOME is unset.
 *
 * @returns Absolute path to the global plugin directory
 */
export function getGlobalPluginDir(): string {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'opencode', '.worklog', 'plugins');
}

/**
 * Resolve the plugin directory based on config and environment.
 * Priority: WORKLOG_PLUGIN_DIR env var > provided option > default
 *
 * NOTE: When WORKLOG_PLUGIN_DIR is set it acts as a single-directory
 * override and the global directory is **not** scanned.
 */
export function resolvePluginDir(options?: PluginLoaderOptions): string {
  // Check environment variable first
  if (process.env.WORKLOG_PLUGIN_DIR) {
    return path.resolve(process.env.WORKLOG_PLUGIN_DIR);
  }
  
  // Use provided option
  if (options?.pluginDir) {
    return path.resolve(options.pluginDir);
  }
  
  // Fall back to default
  return getDefaultPluginDir();
}

/**
 * Discover plugin files in the plugin directory.
 * Only includes .js and .mjs files, excludes .d.ts, .map, etc.
 */
export function discoverPlugins(pluginDir: string): string[] {
  // Check if plugin directory exists
  if (!fs.existsSync(pluginDir)) {
    return [];
  }
  
  // Read directory
  const entries = fs.readdirSync(pluginDir, { withFileTypes: true });
  
  // Filter to only .js and .mjs files (excluding .d.ts, .map, etc.)
  const plugins = entries
    .filter(entry => {
      if (!entry.isFile()) return false;
      const name = entry.name;
      // Must end with .js or .mjs, but not .d.ts
      return (name.endsWith('.js') || name.endsWith('.mjs')) && !name.endsWith('.d.ts');
    })
    .map(entry => path.join(pluginDir, entry.name))
    .sort(); // Deterministic lexicographic order
  
  return plugins;
}

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
export function discoverAllPlugins(dirs: string[]): Array<{ filePath: string; source: string }> {
  const seen = new Map<string, { filePath: string; source: string }>();

  for (const dir of dirs) {
    const files = discoverPlugins(dir);
    for (const filePath of files) {
      const name = path.basename(filePath);
      if (!seen.has(name)) {
        seen.set(name, { filePath, source: dir });
      }
      // else: skip — higher-priority directory already registered this filename
    }
  }

  // Return in deterministic lexicographic order by filename
  return Array.from(seen.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, entry]) => entry);
}

/**
 * Load a single plugin file.
 * @returns Plugin info with load status
 */
export async function loadPlugin(
  pluginPath: string,
  ctx: PluginContext,
  verbose: boolean = false,
  source?: string
): Promise<PluginInfo> {
  const name = path.basename(pluginPath);
  const logger = new Logger({ verbose, jsonMode: false });
  
  try {
    logger.debug(`Loading plugin: ${name}`);
    
    // Convert file path to file URL for ESM import
    const fileUrl = pathToFileURL(pluginPath).href;
    
    // Dynamic import
    const module = await import(fileUrl) as PluginModule;
    
    // Check for default export
    if (!module.default || typeof module.default !== 'function') {
      throw new Error('Plugin must export a default register function');
    }
    
    // Call the register function
    await module.default(ctx);
    
    logger.debug(`Loaded plugin: ${name}`);
    
    return {
      name,
      path: pluginPath,
      loaded: true,
      source
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    logger.error(`Failed to load plugin ${name}: ${errorMessage}`);
    
    return {
      name,
      path: pluginPath,
      loaded: false,
      error: errorMessage,
      source
    };
  }
}

/**
 * Load all plugins from the configured plugin directories.
 *
 * When WORKLOG_PLUGIN_DIR or `options.pluginDir` is set, only that single
 * directory is scanned (backwards-compatible behaviour).
 *
 * Otherwise, plugins are discovered from:
 *   1. Project-local: <project>/.worklog/plugins/
 *   2. Global: ${XDG_CONFIG_HOME:-$HOME/.config}/opencode/.worklog/plugins/
 *
 * Project-local plugins override global plugins with the same filename.
 *
 * @returns Array of plugin info objects
 */
export async function loadPlugins(
  ctx: PluginContext,
  options?: PluginLoaderOptions
): Promise<PluginInfo[]> {
  const verbose = options?.verbose || false;
  const logger = new Logger({ verbose, jsonMode: false });

  // When an explicit override is in effect, scan only that single directory
  // (preserves existing semantics of WORKLOG_PLUGIN_DIR / pluginDir option).
  const hasExplicitOverride = !!(process.env.WORKLOG_PLUGIN_DIR || options?.pluginDir);

  let pluginEntries: Array<{ filePath: string; source: string }>;

  if (hasExplicitOverride) {
    const dir = resolvePluginDir(options);
    logger.debug(`Plugin directory (override): ${dir}`);
    pluginEntries = discoverPlugins(dir).map(fp => ({ filePath: fp, source: dir }));
  } else {
    const localDir = getDefaultPluginDir();
    const globalDir = getGlobalPluginDir();
    logger.debug(`Plugin directories: local=${localDir}, global=${globalDir}`);
    pluginEntries = discoverAllPlugins([localDir, globalDir]);
  }

  if (pluginEntries.length === 0) {
    logger.debug('No plugins found');
    return [];
  }

  logger.debug(`Found ${pluginEntries.length} plugin(s)`);

  // Load plugins sequentially to maintain deterministic order
  const results: PluginInfo[] = [];
  for (const { filePath, source } of pluginEntries) {
    const result = await loadPlugin(filePath, ctx, verbose, source);
    results.push(result);
  }

  return results;
}

/**
 * Check if a command name is already registered
 */
export function hasCommand(program: any, commandName: string): boolean {
  const commands = program.commands || [];
  return commands.some((cmd: any) => cmd.name() === commandName);
}
