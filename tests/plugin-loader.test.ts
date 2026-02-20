/**
 * Tests for plugin loader and discovery
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTempDir, cleanupTempDir } from './test-utils.js';
import { discoverPlugins, discoverAllPlugins, resolvePluginDir, getDefaultPluginDir, getGlobalPluginDir, loadPlugin } from '../src/plugin-loader.js';
import { createPluginContext } from '../src/cli-utils.js';
import { Command } from 'commander';
import { fileURLToPath } from 'url';

describe('Plugin Loader', () => {
  let tempDir: string;
  let pluginDir: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    tempDir = createTempDir();
    pluginDir = path.join(tempDir, '.worklog', 'plugins');
    fs.mkdirSync(pluginDir, { recursive: true });

    // Set up environment to use temp directory
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    cleanupTempDir(tempDir);
  });

  describe('resolvePluginDir', () => {
    it('should return default plugin directory when no options provided', () => {
      const resolved = resolvePluginDir();
      expect(resolved).toBe(path.join(process.cwd(), '.worklog', 'plugins'));
    });

    it('should use WORKLOG_PLUGIN_DIR environment variable if set', () => {
      const customDir = path.join(tempDir, 'custom-plugins');
      process.env.WORKLOG_PLUGIN_DIR = customDir;
      
      const resolved = resolvePluginDir();
      expect(resolved).toBe(customDir);
      
      delete process.env.WORKLOG_PLUGIN_DIR;
    });

    it('should use provided option over default', () => {
      const customDir = path.join(tempDir, 'option-plugins');
      const resolved = resolvePluginDir({ pluginDir: customDir });
      expect(resolved).toBe(path.resolve(customDir));
    });

    it('should prioritize env var over option', () => {
      const envDir = path.join(tempDir, 'env-plugins');
      const optionDir = path.join(tempDir, 'option-plugins');
      
      process.env.WORKLOG_PLUGIN_DIR = envDir;
      const resolved = resolvePluginDir({ pluginDir: optionDir });
      expect(resolved).toBe(envDir);
      
      delete process.env.WORKLOG_PLUGIN_DIR;
    });
  });

  describe('discoverPlugins', () => {
    it('should return empty array when plugin directory does not exist', () => {
      const nonExistentDir = path.join(tempDir, 'nonexistent');
      const plugins = discoverPlugins(nonExistentDir);
      expect(plugins).toEqual([]);
    });

    it('should discover .js files in plugin directory', () => {
      fs.writeFileSync(path.join(pluginDir, 'plugin1.js'), '// plugin 1');
      fs.writeFileSync(path.join(pluginDir, 'plugin2.js'), '// plugin 2');
      
      const plugins = discoverPlugins(pluginDir);
      expect(plugins).toHaveLength(2);
      expect(plugins[0]).toContain('plugin1.js');
      expect(plugins[1]).toContain('plugin2.js');
    });

    it('should discover .mjs files in plugin directory', () => {
      fs.writeFileSync(path.join(pluginDir, 'plugin.mjs'), '// plugin');
      
      const plugins = discoverPlugins(pluginDir);
      expect(plugins).toHaveLength(1);
      expect(plugins[0]).toContain('plugin.mjs');
    });

    it('should exclude .d.ts files', () => {
      fs.writeFileSync(path.join(pluginDir, 'plugin.d.ts'), '// types');
      fs.writeFileSync(path.join(pluginDir, 'plugin.js'), '// plugin');
      
      const plugins = discoverPlugins(pluginDir);
      expect(plugins).toHaveLength(1);
      expect(plugins[0]).toContain('plugin.js');
      expect(plugins[0]).not.toContain('.d.ts');
    });

    it('should exclude .map files', () => {
      fs.writeFileSync(path.join(pluginDir, 'plugin.js.map'), '// map');
      fs.writeFileSync(path.join(pluginDir, 'plugin.js'), '// plugin');
      
      const plugins = discoverPlugins(pluginDir);
      expect(plugins).toHaveLength(1);
      expect(plugins[0]).toContain('plugin.js');
    });

    it('should return plugins in deterministic lexicographic order', () => {
      fs.writeFileSync(path.join(pluginDir, 'zebra.js'), '// z');
      fs.writeFileSync(path.join(pluginDir, 'apple.js'), '// a');
      fs.writeFileSync(path.join(pluginDir, 'middle.js'), '// m');
      
      const plugins = discoverPlugins(pluginDir);
      expect(plugins).toHaveLength(3);
      expect(path.basename(plugins[0])).toBe('apple.js');
      expect(path.basename(plugins[1])).toBe('middle.js');
      expect(path.basename(plugins[2])).toBe('zebra.js');
    });

    it('should ignore subdirectories', () => {
      fs.writeFileSync(path.join(pluginDir, 'plugin.js'), '// plugin');
      fs.mkdirSync(path.join(pluginDir, 'subdir'));
      fs.writeFileSync(path.join(pluginDir, 'subdir', 'nested.js'), '// nested');
      
      const plugins = discoverPlugins(pluginDir);
      expect(plugins).toHaveLength(1);
      expect(plugins[0]).toContain('plugin.js');
    });
  });

  describe('loadPlugin', () => {
    it('should successfully load a valid plugin', async () => {
      const program = new Command();
      const ctx = createPluginContext(program);
      
      // Create a simple test plugin
      const pluginPath = path.join(pluginDir, 'test-plugin.mjs');
      fs.writeFileSync(pluginPath, `
        export default function register(ctx) {
          ctx.program.command('test-cmd').description('Test command');
        }
      `);
      
      const result = await loadPlugin(pluginPath, ctx, false);
      
      expect(result.loaded).toBe(true);
      expect(result.name).toBe('test-plugin.mjs');
      expect(result.error).toBeUndefined();
      
      // Verify command was registered
      const commands = program.commands.map((c: any) => c.name());
      expect(commands).toContain('test-cmd');
    });

    it('should fail when plugin has no default export', async () => {
      const program = new Command();
      const ctx = createPluginContext(program);
      
      const pluginPath = path.join(pluginDir, 'bad-plugin.mjs');
      fs.writeFileSync(pluginPath, `
        export function notDefault() {}
      `);
      
      const result = await loadPlugin(pluginPath, ctx, false);
      
      expect(result.loaded).toBe(false);
      expect(result.error).toContain('default register function');
    });

    it('should fail when plugin default export is not a function', async () => {
      const program = new Command();
      const ctx = createPluginContext(program);
      
      const pluginPath = path.join(pluginDir, 'bad-plugin.mjs');
      fs.writeFileSync(pluginPath, `
        export default { notAFunction: true };
      `);
      
      const result = await loadPlugin(pluginPath, ctx, false);
      
      expect(result.loaded).toBe(false);
      expect(result.error).toContain('default register function');
    });

    it('should fail when plugin throws an error', async () => {
      const program = new Command();
      const ctx = createPluginContext(program);
      
      const pluginPath = path.join(pluginDir, 'error-plugin.mjs');
      fs.writeFileSync(pluginPath, `
        export default function register(ctx) {
          throw new Error('Plugin error!');
        }
      `);
      
      const result = await loadPlugin(pluginPath, ctx, false);
      
      expect(result.loaded).toBe(false);
      expect(result.error).toContain('Plugin error!');
    });

    it('should emit a single-line warning to stderr when a plugin fails to load', async () => {
      const program = new Command();
      const ctx = createPluginContext(program);
      
      const pluginPath = path.join(pluginDir, 'warn-plugin.mjs');
      fs.writeFileSync(pluginPath, `
        export default function register(ctx) {
          throw new Error('intentional failure');
        }
      `);
      
      // Logger.warn() uses console.error(), so intercept that to capture output.
      const stderrChunks: string[] = [];
      const origConsoleError = console.error;
      console.error = (...args: any[]) => {
        stderrChunks.push(args.map(a => String(a)).join(' '));
        origConsoleError(...args);
      };

      try {
        const result = await loadPlugin(pluginPath, ctx, false);
        
        expect(result.loaded).toBe(false);
        expect(result.error).toContain('intentional failure');

        const stderrOutput = stderrChunks.join('');
        expect(stderrOutput).toContain('Warning: plugin warn-plugin.mjs skipped:');
        expect(stderrOutput).toContain('intentional failure');
        // Should NOT contain old-style error format
        expect(stderrOutput).not.toContain('Failed to load plugin');
      } finally {
        console.error = origConsoleError;
      }
    });

    it('should fail when plugin file has syntax errors', async () => {
      const program = new Command();
      const ctx = createPluginContext(program);
      
      const pluginPath = path.join(pluginDir, 'syntax-error.mjs');
      fs.writeFileSync(pluginPath, `
        export default function register(ctx) {
          this is not valid javascript ;;;
        }
      `);
      
      const result = await loadPlugin(pluginPath, ctx, false);
      
      expect(result.loaded).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('plugin context', () => {
    it('should provide program instance to plugins', async () => {
      const program = new Command();
      const ctx = createPluginContext(program);
      
      expect(ctx.program).toBe(program);
    });

    it('should provide version to plugins', () => {
      const program = new Command();
      const ctx = createPluginContext(program);
      
      expect(ctx.version).toBeDefined();
      expect(typeof ctx.version).toBe('string');
    });

    it('should provide output helpers to plugins', () => {
      const program = new Command();
      const ctx = createPluginContext(program);
      
      expect(ctx.output).toBeDefined();
      expect(typeof ctx.output.json).toBe('function');
      expect(typeof ctx.output.success).toBe('function');
      expect(typeof ctx.output.error).toBe('function');
    });

    it('should provide utils to plugins', () => {
      const program = new Command();
      const ctx = createPluginContext(program);
      
      expect(ctx.utils).toBeDefined();
      expect(typeof ctx.utils.requireInitialized).toBe('function');
      expect(typeof ctx.utils.getDatabase).toBe('function');
      expect(typeof ctx.utils.getConfig).toBe('function');
      expect(typeof ctx.utils.getPrefix).toBe('function');
      expect(typeof ctx.utils.isJsonMode).toBe('function');
    });
  });

  describe('getGlobalPluginDir', () => {
    const originalXdg = process.env.XDG_CONFIG_HOME;

    afterEach(() => {
      if (originalXdg === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = originalXdg;
      }
    });

    it('should use XDG_CONFIG_HOME when set', () => {
      process.env.XDG_CONFIG_HOME = '/custom/config';
      const dir = getGlobalPluginDir();
      expect(dir).toBe(path.join('/custom/config', 'opencode', '.worklog', 'plugins'));
    });

    it('should fall back to $HOME/.config when XDG_CONFIG_HOME is unset', () => {
      delete process.env.XDG_CONFIG_HOME;
      const dir = getGlobalPluginDir();
      expect(dir).toBe(path.join(os.homedir(), '.config', 'opencode', '.worklog', 'plugins'));
    });

    it('should return an absolute path', () => {
      delete process.env.XDG_CONFIG_HOME;
      const dir = getGlobalPluginDir();
      expect(path.isAbsolute(dir)).toBe(true);
    });
  });

  describe('discoverAllPlugins', () => {
    let localDir: string;
    let globalDir: string;

    beforeEach(() => {
      localDir = path.join(tempDir, 'local-plugins');
      globalDir = path.join(tempDir, 'global-plugins');
      fs.mkdirSync(localDir, { recursive: true });
      fs.mkdirSync(globalDir, { recursive: true });
    });

    it('should discover plugins from both directories', () => {
      fs.writeFileSync(path.join(localDir, 'local-only.mjs'), '// local');
      fs.writeFileSync(path.join(globalDir, 'global-only.mjs'), '// global');

      const results = discoverAllPlugins([localDir, globalDir]);
      expect(results).toHaveLength(2);

      const names = results.map(r => path.basename(r.filePath));
      expect(names).toContain('local-only.mjs');
      expect(names).toContain('global-only.mjs');
    });

    it('should give precedence to the first directory (local over global)', () => {
      fs.writeFileSync(path.join(localDir, 'shared.mjs'), '// local version');
      fs.writeFileSync(path.join(globalDir, 'shared.mjs'), '// global version');

      const results = discoverAllPlugins([localDir, globalDir]);
      expect(results).toHaveLength(1);
      expect(results[0].filePath).toBe(path.join(localDir, 'shared.mjs'));
      expect(results[0].source).toBe(localDir);
    });

    it('should return global plugin when only global has it', () => {
      fs.writeFileSync(path.join(globalDir, 'only-global.mjs'), '// global');

      const results = discoverAllPlugins([localDir, globalDir]);
      expect(results).toHaveLength(1);
      expect(results[0].filePath).toBe(path.join(globalDir, 'only-global.mjs'));
      expect(results[0].source).toBe(globalDir);
    });

    it('should return local plugin when only local has it', () => {
      fs.writeFileSync(path.join(localDir, 'only-local.mjs'), '// local');

      const results = discoverAllPlugins([localDir, globalDir]);
      expect(results).toHaveLength(1);
      expect(results[0].filePath).toBe(path.join(localDir, 'only-local.mjs'));
      expect(results[0].source).toBe(localDir);
    });

    it('should handle empty directories gracefully', () => {
      const results = discoverAllPlugins([localDir, globalDir]);
      expect(results).toEqual([]);
    });

    it('should handle non-existent directories gracefully', () => {
      const results = discoverAllPlugins(['/nonexistent/local', '/nonexistent/global']);
      expect(results).toEqual([]);
    });

    it('should merge and deduplicate correctly with mixed overlap', () => {
      fs.writeFileSync(path.join(localDir, 'alpha.mjs'), '// local alpha');
      fs.writeFileSync(path.join(localDir, 'shared.mjs'), '// local shared');
      fs.writeFileSync(path.join(globalDir, 'shared.mjs'), '// global shared');
      fs.writeFileSync(path.join(globalDir, 'beta.mjs'), '// global beta');

      const results = discoverAllPlugins([localDir, globalDir]);
      expect(results).toHaveLength(3);

      const names = results.map(r => path.basename(r.filePath));
      expect(names).toEqual(['alpha.mjs', 'beta.mjs', 'shared.mjs']); // lexicographic

      // shared.mjs should come from local
      const shared = results.find(r => path.basename(r.filePath) === 'shared.mjs')!;
      expect(shared.source).toBe(localDir);

      // beta.mjs should come from global
      const beta = results.find(r => path.basename(r.filePath) === 'beta.mjs')!;
      expect(beta.source).toBe(globalDir);
    });

    it('should return results in deterministic lexicographic order', () => {
      fs.writeFileSync(path.join(localDir, 'zebra.mjs'), '// z');
      fs.writeFileSync(path.join(globalDir, 'apple.mjs'), '// a');
      fs.writeFileSync(path.join(localDir, 'middle.mjs'), '// m');

      const results = discoverAllPlugins([localDir, globalDir]);
      const names = results.map(r => path.basename(r.filePath));
      expect(names).toEqual(['apple.mjs', 'middle.mjs', 'zebra.mjs']);
    });
  });

  describe('loadPlugin source tracking', () => {
    it('should include source in returned PluginInfo', async () => {
      const program = new Command();
      const ctx = createPluginContext(program);
      
      const pluginPath = path.join(pluginDir, 'source-test.mjs');
      fs.writeFileSync(pluginPath, `
        export default function register(ctx) {
          ctx.program.command('source-test-cmd').description('Test');
        }
      `);
      
      const result = await loadPlugin(pluginPath, ctx, false, '/some/source/dir');
      
      expect(result.loaded).toBe(true);
      expect(result.source).toBe('/some/source/dir');
    });

    it('should include source even on failure', async () => {
      const program = new Command();
      const ctx = createPluginContext(program);
      
      const pluginPath = path.join(pluginDir, 'bad-source.mjs');
      fs.writeFileSync(pluginPath, `
        export default function register(ctx) {
          throw new Error('fail');
        }
      `);
      
      const result = await loadPlugin(pluginPath, ctx, false, '/some/source');
      
      expect(result.loaded).toBe(false);
      expect(result.source).toBe('/some/source');
    });

    it('should have undefined source when not provided', async () => {
      const program = new Command();
      const ctx = createPluginContext(program);
      
      const pluginPath = path.join(pluginDir, 'no-source.mjs');
      fs.writeFileSync(pluginPath, `
        export default function register(ctx) {
          ctx.program.command('no-source-cmd').description('Test');
        }
      `);
      
      const result = await loadPlugin(pluginPath, ctx, false);
      
      expect(result.loaded).toBe(true);
      expect(result.source).toBeUndefined();
    });
  });
});
