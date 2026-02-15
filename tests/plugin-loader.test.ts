/**
 * Tests for plugin loader and discovery
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createTempDir, cleanupTempDir } from './test-utils.js';
import { discoverPlugins, resolvePluginDir, getDefaultPluginDir, loadPlugin } from '../src/plugin-loader.js';
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
});
