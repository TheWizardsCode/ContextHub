/**
 * Plugins command - List discovered plugins and their load status.
 *
 * Shows plugins from both project-local and global directories,
 * indicating the source of each plugin.
 */

import type { PluginContext } from '../plugin-types.js';
import { resolvePluginDir, getDefaultPluginDir, getGlobalPluginDir, discoverAllPlugins, discoverPlugins } from '../plugin-loader.js';
import * as fs from 'fs';
import * as path from 'path';

interface PluginsCommandOptions {
  verbose?: boolean;
}

export default function register(ctx: PluginContext): void {
  const { program, output } = ctx;
  
  program
    .command('plugins')
    .description('List discovered plugins and their load status')
    .action((options: PluginsCommandOptions) => {
      const verbose = program.opts().verbose || options.verbose;
      const hasExplicitOverride = !!(process.env.WORKLOG_PLUGIN_DIR || false);

      if (hasExplicitOverride) {
        // Legacy single-directory mode when WORKLOG_PLUGIN_DIR is set
        const pluginDir = resolvePluginDir({ verbose: options.verbose });
        const dirExists = fs.existsSync(pluginDir);

        if (ctx.utils.isJsonMode()) {
          const plugins = dirExists
            ? discoverPlugins(pluginDir).map(p => ({
                name: path.basename(p),
                path: p,
                size: fs.statSync(p).size,
                source: pluginDir
              }))
            : [];

          output.json({
            success: true,
            pluginDirs: [{ path: pluginDir, exists: dirExists, label: 'override' }],
            // Keep the legacy field for backwards compatibility
            pluginDir,
            dirExists,
            count: plugins.length,
            plugins
          });
        } else {
          console.log(`Plugin directory (override): ${pluginDir}`);
          console.log(`Status: ${dirExists ? 'Exists' : 'Does not exist'}`);
          printPluginList(pluginDir, dirExists, verbose);
        }
        return;
      }

      // Multi-directory mode: project-local + global
      const localDir = getDefaultPluginDir();
      const globalDir = getGlobalPluginDir();
      const localExists = fs.existsSync(localDir);
      const globalExists = fs.existsSync(globalDir);
      const allPlugins = discoverAllPlugins([localDir, globalDir]);

      if (ctx.utils.isJsonMode()) {
        const plugins = allPlugins.map(({ filePath, source }) => ({
          name: path.basename(filePath),
          path: filePath,
          size: fs.statSync(filePath).size,
          source
        }));

        output.json({
          success: true,
          pluginDirs: [
            { path: localDir, exists: localExists, label: 'local' },
            { path: globalDir, exists: globalExists, label: 'global' }
          ],
          // Legacy compat: report the local directory as the primary
          pluginDir: localDir,
          dirExists: localExists,
          count: plugins.length,
          plugins
        });
      } else {
        console.log('Plugin directories:');
        console.log(`  Local:  ${localDir} (${localExists ? 'exists' : 'does not exist'})`);
        console.log(`  Global: ${globalDir} (${globalExists ? 'exists' : 'does not exist'})`);
        console.log(`\nDiscovered ${allPlugins.length} plugin(s):\n`);

        if (allPlugins.length === 0) {
          console.log('  (none)');
          console.log('\nTo add plugins:');
          console.log('  1. Create compiled ESM plugin files (.js or .mjs)');
          console.log(`  2. Place them in ${localDir} (project) or ${globalDir} (global)`);
          console.log('  3. Run worklog --help to see new commands');
        } else {
          allPlugins.forEach(({ filePath, source }) => {
            const name = path.basename(filePath);
            const stat = fs.statSync(filePath);
            const size = stat.size;
            const label = source === localDir ? 'local' : source === globalDir ? 'global' : 'override';
            console.log(`  • ${name} (${size} bytes) [${label}]`);
            if (verbose) {
              console.log(`    Path: ${filePath}`);
            }
          });

          console.log('\nNote: Plugins are loaded at CLI startup.');
          console.log('Project-local plugins take precedence over global plugins with the same name.');
          console.log('Run with --verbose to see plugin load diagnostics.');
        }
      }
    });
}

/**
 * Helper: print a single-directory plugin list (used for override mode).
 */
function printPluginList(pluginDir: string, dirExists: boolean, verbose: boolean | undefined): void {
  if (!dirExists) {
    console.log('\nNo plugins configured.');
      console.log(
        `\nTo add plugins, create ${pluginDir} and add .js or .mjs files. See https://github.com/TheWizardsCode/ContextHub/blob/main/PLUGIN_GUIDE.md for details.`
      );
    return;
  }

  const pluginPaths = discoverPlugins(pluginDir);
  console.log(`\nDiscovered ${pluginPaths.length} plugin(s):\n`);

  if (pluginPaths.length === 0) {
    console.log('  (none)');
    console.log('\nTo add plugins:');
    console.log('  1. Create compiled ESM plugin files (.js or .mjs)');
    console.log(`  2. Place them in ${pluginDir}`);
    console.log('  3. Run worklog --help to see new commands');
  } else {
    pluginPaths.forEach(p => {
      const name = path.basename(p);
      const stat = fs.statSync(p);
      const size = stat.size;
      console.log(`  • ${name} (${size} bytes)`);
      if (verbose) {
        console.log(`    Path: ${p}`);
      }
    });

    console.log('\nNote: Plugins are loaded at CLI startup.');
    console.log('Run with --verbose to see plugin load diagnostics.');
  }
}
