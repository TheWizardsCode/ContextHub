/**
 * Integration tests for external plugin loading
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { createTempDir, cleanupTempDir } from './test-utils.js';
import { fileURLToPath } from 'url';

const execAsync = promisify(childProcess.exec);

// Get the project root directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const cliPath = path.join(projectRoot, 'dist', 'cli.js');

describe('Plugin Integration Tests', () => {
  let tempDir: string;
  let pluginDir: string;
  let originalCwd: string;

  /**
   * Build an environment that isolates the test from the real global
   * plugin directory by pointing XDG_CONFIG_HOME to a non-existent temp
   * subdirectory and unsetting WORKLOG_PLUGIN_DIR.
   */
  function isolatedEnv(): Record<string, string> {
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    env.XDG_CONFIG_HOME = path.join(tempDir, 'xdg-isolated');
    delete env.WORKLOG_PLUGIN_DIR;
    return env;
  }

  beforeEach(() => {
    tempDir = createTempDir();
    pluginDir = path.join(tempDir, '.worklog', 'plugins');
    fs.mkdirSync(pluginDir, { recursive: true });
    
    originalCwd = process.cwd();
    process.chdir(tempDir);
    
    // Create a basic config
    fs.writeFileSync(
      path.join(tempDir, '.worklog', 'config.yaml'),
      [
        'projectName: Test Project',
        'prefix: TEST',
        'statuses:',
        '  - value: open',
        '    label: Open',
        '  - value: in-progress',
        '    label: In Progress',
        '  - value: blocked',
        '    label: Blocked',
        '  - value: completed',
        '    label: Completed',
        '  - value: deleted',
        '    label: Deleted',
        'stages:',
        '  - value: ""',
        '    label: Undefined',
        '  - value: idea',
        '    label: Idea',
        '  - value: prd_complete',
        '    label: PRD Complete',
        '  - value: plan_complete',
        '    label: Plan Complete',
        '  - value: in_progress',
        '    label: In Progress',
        '  - value: in_review',
        '    label: In Review',
        '  - value: done',
        '    label: Done',
        'statusStageCompatibility:',
        '  open: ["", idea, prd_complete, plan_complete, in_progress]',
        '  in-progress: [in_progress]',
        '  blocked: ["", idea, prd_complete, plan_complete, in_progress]',
        '  completed: [in_review, done]',
        '  deleted: [""]'
      ].join('\n'),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(tempDir, '.worklog', 'initialized'),
      JSON.stringify({
        version: '1.0.0',
        initializedAt: '2024-01-23T12:00:00.000Z'
      }),
      'utf-8'
    );
  });

  afterEach(() => {
    process.chdir(originalCwd);
    cleanupTempDir(tempDir);
  });

  it('should load and execute a simple external plugin', async () => {
    // Create a simple plugin that adds a "hello" command
    const pluginContent = `
export default function register(ctx) {
  ctx.program
    .command('hello')
    .description('Say hello')
    .option('-n, --name <name>', 'Name to greet', 'World')
    .action((options) => {
      if (ctx.utils.isJsonMode()) {
        ctx.output.json({ success: true, message: \`Hello, \${options.name}!\` });
      } else {
        console.log(\`Hello, \${options.name}!\`);
      }
    });
}
`;
    
    fs.writeFileSync(path.join(pluginDir, 'hello.mjs'), pluginContent);
    
    // Verify the plugin command appears in help
    const { stdout: helpOutput } = await execAsync(`node ${cliPath} --help`, { env: isolatedEnv() });
    expect(helpOutput).toContain('hello');
    expect(helpOutput).toContain('Say hello');
    
    // Test the plugin command
    const { stdout } = await execAsync(`node ${cliPath} hello --json`, { env: isolatedEnv() });
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.message).toBe('Hello, World!');
    
    // Test with custom name
    const { stdout: stdout2 } = await execAsync(`node ${cliPath} hello --json --name Copilot`, { env: isolatedEnv() });
    const result2 = JSON.parse(stdout2);
    expect(result2.success).toBe(true);
    expect(result2.message).toBe('Hello, Copilot!');
  });

  it('should load multiple plugins in lexicographic order', async () => {
    // Create multiple plugins
    const plugin1 = `
export default function register(ctx) {
  ctx.program.command('cmd-alpha').description('Alpha command');
}
`;
    
    const plugin2 = `
export default function register(ctx) {
  ctx.program.command('cmd-beta').description('Beta command');
}
`;
    
    const plugin3 = `
export default function register(ctx) {
  ctx.program.command('cmd-gamma').description('Gamma command');
}
`;
    
    fs.writeFileSync(path.join(pluginDir, 'z-third.mjs'), plugin3);
    fs.writeFileSync(path.join(pluginDir, 'a-first.mjs'), plugin1);
    fs.writeFileSync(path.join(pluginDir, 'm-second.mjs'), plugin2);
    
    // Verify all commands appear in help
    const { stdout } = await execAsync(`node ${cliPath} --help`, { env: isolatedEnv() });
    expect(stdout).toContain('cmd-alpha');
    expect(stdout).toContain('cmd-beta');
    expect(stdout).toContain('cmd-gamma');
  });

  it('should continue working even if a plugin fails to load', async () => {
    // Create a good plugin
    const goodPlugin = `
export default function register(ctx) {
  ctx.program.command('good').description('Good command');
}
`;
    
    // Create a bad plugin with syntax error
    const badPlugin = `
export default function register(ctx) {
  this is not valid javascript ;;;
}
`;
    
    fs.writeFileSync(path.join(pluginDir, 'good.mjs'), goodPlugin);
    fs.writeFileSync(path.join(pluginDir, 'bad.mjs'), badPlugin);
    
    // The CLI should still work and the good plugin should load
    const { stdout: helpOut } = await execAsync(`node ${cliPath} --help`, { env: isolatedEnv() });
    expect(helpOut).toContain('good');
    
    // Built-in commands should still work
    expect(helpOut).toContain('create');
    expect(helpOut).toContain('list');
  });

  it('should show plugin information with plugins command', async () => {
    // Create test plugins
    fs.writeFileSync(path.join(pluginDir, 'plugin1.mjs'), 'export default function register(ctx) {}');
    fs.writeFileSync(path.join(pluginDir, 'plugin2.js'), 'export default function register(ctx) {}');
    
    const { stdout } = await execAsync(`node ${cliPath} plugins --json`, { env: isolatedEnv() });
    const result = JSON.parse(stdout);
    
    expect(result.success).toBe(true);
    expect(result.dirExists).toBe(true);
    expect(result.count).toBe(2);
    expect(result.plugins).toHaveLength(2);
    expect(result.plugins[0].name).toBe('plugin1.mjs');
    expect(result.plugins[1].name).toBe('plugin2.js');
  });

  it('should handle empty plugin directory gracefully', async () => {
    const { stdout: emptyStdout } = await execAsync(`node ${cliPath} plugins --json`, { env: isolatedEnv() });
    const result = JSON.parse(emptyStdout);
    
    expect(result.success).toBe(true);
    expect(result.dirExists).toBe(true);
    expect(result.count).toBe(0);
    expect(result.plugins).toEqual([]);
  });

  it('should handle non-existent plugin directory gracefully', async () => {
    // Remove the plugin directory
    fs.rmdirSync(pluginDir);
    
    const { stdout } = await execAsync(`node ${cliPath} plugins --json`, { env: isolatedEnv() });
    const result = JSON.parse(stdout);
    
    expect(result.success).toBe(true);
    expect(result.dirExists).toBe(false);
    expect(result.plugins).toEqual([]);
  });

  it('should allow plugin to access worklog database', async () => {
    // Create a plugin that uses the database
    const dbPlugin = `
export default function register(ctx) {
  ctx.program
    .command('count-items')
    .description('Count work items')
    .action(() => {
      ctx.utils.requireInitialized();
      const db = ctx.utils.getDatabase();
      const items = db.getAll();
      ctx.output.json({ success: true, count: items.length });
    });
}
`;
    
    fs.writeFileSync(path.join(pluginDir, 'db-plugin.mjs'), dbPlugin);
    
    // Create a work item first
    await execAsync(`node ${cliPath} create --json -t "Test item"`, { env: isolatedEnv() });
    
    // Test the plugin command
    const { stdout } = await execAsync(`node ${cliPath} count-items`, { env: isolatedEnv() });
    const result = JSON.parse(stdout);
    
    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
  });

  it('should respect WORKLOG_PLUGIN_DIR environment variable', async () => {
    // Create a custom plugin directory
    const customPluginDir = path.join(tempDir, 'custom-plugins');
    fs.mkdirSync(customPluginDir, { recursive: true });
    
    const plugin = `
export default function register(ctx) {
  ctx.program.command('custom-cmd').description('Custom command');
}
`;
    
    fs.writeFileSync(path.join(customPluginDir, 'custom.mjs'), plugin);
    
    // Set environment variable
    const env = { ...isolatedEnv, WORKLOG_PLUGIN_DIR: customPluginDir };
    
    const { stdout } = await execAsync(`node ${cliPath} --help`, { env });
    expect(stdout).toContain('custom-cmd');
  });

  it('should not load .d.ts or .map files as plugins', async () => {
    // Create files that should be ignored
    fs.writeFileSync(path.join(pluginDir, 'types.d.ts'), '// types');
    fs.writeFileSync(path.join(pluginDir, 'source.js.map'), '// map');
    
    // Create a valid plugin
    const validPlugin = `
export default function register(ctx) {
  ctx.program.command('valid').description('Valid command');
}
`;
    fs.writeFileSync(path.join(pluginDir, 'valid.mjs'), validPlugin);
    
    const { stdout } = await execAsync(`node ${cliPath} plugins --json`, { env: isolatedEnv() });
    const result = JSON.parse(stdout);
    
    // Should only find the valid plugin
    expect(result.count).toBe(1);
    expect(result.plugins[0].name).toBe('valid.mjs');
  });
});

describe('Global Plugin Discovery Integration Tests', () => {
  let tempDir: string;
  let localPluginDir: string;
  let globalPluginDir: string;
  let originalCwd: string;
  let originalXdg: string | undefined;

  beforeEach(() => {
    tempDir = createTempDir();
    localPluginDir = path.join(tempDir, '.worklog', 'plugins');
    globalPluginDir = path.join(tempDir, 'xdg-config', 'opencode', '.worklog', 'plugins');
    fs.mkdirSync(localPluginDir, { recursive: true });
    fs.mkdirSync(globalPluginDir, { recursive: true });
    
    originalCwd = process.cwd();
    originalXdg = process.env.XDG_CONFIG_HOME;
    process.chdir(tempDir);
    
    // Point XDG_CONFIG_HOME to our temp dir so getGlobalPluginDir() resolves there
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'xdg-config');
    
    // Create a basic config
    fs.writeFileSync(
      path.join(tempDir, '.worklog', 'config.yaml'),
      [
        'projectName: Test Project',
        'prefix: TEST',
        'statuses:',
        '  - value: open',
        '    label: Open',
        '  - value: in-progress',
        '    label: In Progress',
        '  - value: blocked',
        '    label: Blocked',
        '  - value: completed',
        '    label: Completed',
        '  - value: deleted',
        '    label: Deleted',
        'stages:',
        '  - value: ""',
        '    label: Undefined',
        '  - value: idea',
        '    label: Idea',
        '  - value: prd_complete',
        '    label: PRD Complete',
        '  - value: plan_complete',
        '    label: Plan Complete',
        '  - value: in_progress',
        '    label: In Progress',
        '  - value: in_review',
        '    label: In Review',
        '  - value: done',
        '    label: Done',
        'statusStageCompatibility:',
        '  open: ["", idea, prd_complete, plan_complete, in_progress]',
        '  in-progress: [in_progress]',
        '  blocked: ["", idea, prd_complete, plan_complete, in_progress]',
        '  completed: [in_review, done]',
        '  deleted: [""]'
      ].join('\n'),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(tempDir, '.worklog', 'initialized'),
      JSON.stringify({
        version: '1.0.0',
        initializedAt: '2024-01-23T12:00:00.000Z'
      }),
      'utf-8'
    );
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdg;
    }
    cleanupTempDir(tempDir);
  });

  it('should load plugins from the global directory', async () => {
    const globalPlugin = `
export default function register(ctx) {
  ctx.program.command('global-hello').description('Global hello');
}
`;
    fs.writeFileSync(path.join(globalPluginDir, 'global-hello.mjs'), globalPlugin);

    const env: Record<string, string> = { ...process.env as Record<string, string>, XDG_CONFIG_HOME: path.join(tempDir, 'xdg-config') };
    // Ensure WORKLOG_PLUGIN_DIR is not set (would override multi-dir)
    delete env.WORKLOG_PLUGIN_DIR;

    const { stdout } = await execAsync(`node ${cliPath} --help`, { env, cwd: tempDir });
    expect(stdout).toContain('global-hello');
  });

  it('should load plugins from both local and global directories', async () => {
    const localPlugin = `
export default function register(ctx) {
  ctx.program.command('local-cmd').description('Local command');
}
`;
    const globalPlugin = `
export default function register(ctx) {
  ctx.program.command('global-cmd').description('Global command');
}
`;
    fs.writeFileSync(path.join(localPluginDir, 'local.mjs'), localPlugin);
    fs.writeFileSync(path.join(globalPluginDir, 'global.mjs'), globalPlugin);

    const env: Record<string, string> = { ...process.env as Record<string, string>, XDG_CONFIG_HOME: path.join(tempDir, 'xdg-config') };
    delete env.WORKLOG_PLUGIN_DIR;

    const { stdout } = await execAsync(`node ${cliPath} --help`, { env, cwd: tempDir });
    expect(stdout).toContain('local-cmd');
    expect(stdout).toContain('global-cmd');
  });

  it('should give local plugin precedence over global with same filename', async () => {
    // Both dirs have shared.mjs, but local wins — its command should register
    const localPlugin = `
export default function register(ctx) {
  ctx.program
    .command('shared-cmd')
    .description('Shared command')
    .action(() => {
      ctx.output.json({ success: true, source: 'local' });
    });
}
`;
    const globalPlugin = `
export default function register(ctx) {
  ctx.program
    .command('shared-cmd')
    .description('Shared command')
    .action(() => {
      ctx.output.json({ success: true, source: 'global' });
    });
}
`;
    fs.writeFileSync(path.join(localPluginDir, 'shared.mjs'), localPlugin);
    fs.writeFileSync(path.join(globalPluginDir, 'shared.mjs'), globalPlugin);

    const env: Record<string, string> = { ...process.env as Record<string, string>, XDG_CONFIG_HOME: path.join(tempDir, 'xdg-config') };
    delete env.WORKLOG_PLUGIN_DIR;

    const { stdout } = await execAsync(`node ${cliPath} shared-cmd --json`, { env, cwd: tempDir });
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.source).toBe('local');
  });

  it('should show both directories in plugins command JSON output', async () => {
    const localPlugin = `
export default function register(ctx) {}
`;
    const globalPlugin = `
export default function register(ctx) {}
`;
    fs.writeFileSync(path.join(localPluginDir, 'local-only.mjs'), localPlugin);
    fs.writeFileSync(path.join(globalPluginDir, 'global-only.mjs'), globalPlugin);

    const env: Record<string, string> = { ...process.env as Record<string, string>, XDG_CONFIG_HOME: path.join(tempDir, 'xdg-config') };
    delete env.WORKLOG_PLUGIN_DIR;

    const { stdout } = await execAsync(`node ${cliPath} plugins --json`, { env, cwd: tempDir });
    const result = JSON.parse(stdout);

    expect(result.success).toBe(true);
    expect(result.pluginDirs).toHaveLength(2);
    expect(result.pluginDirs[0].label).toBe('local');
    expect(result.pluginDirs[1].label).toBe('global');
    expect(result.count).toBe(2);

    const names = result.plugins.map((p: any) => p.name);
    expect(names).toContain('local-only.mjs');
    expect(names).toContain('global-only.mjs');

    // Each plugin should have source info (source is the directory path)
    const localP = result.plugins.find((p: any) => p.name === 'local-only.mjs');
    const globalP = result.plugins.find((p: any) => p.name === 'global-only.mjs');
    expect(localP.source).toContain('.worklog');
    expect(localP.source).toContain('plugins');
    expect(globalP.source).toContain('opencode');
    expect(globalP.source).toContain('plugins');
  });

  it('should still use WORKLOG_PLUGIN_DIR as single override when set', async () => {
    const overrideDir = path.join(tempDir, 'override-plugins');
    fs.mkdirSync(overrideDir, { recursive: true });

    const overridePlugin = `
export default function register(ctx) {
  ctx.program.command('override-cmd').description('Override command');
}
`;
    // Put a plugin in local and global too — they should NOT be loaded
    const localPlugin = `
export default function register(ctx) {
  ctx.program.command('local-should-not-load').description('Should not load');
}
`;
    fs.writeFileSync(path.join(overrideDir, 'override.mjs'), overridePlugin);
    fs.writeFileSync(path.join(localPluginDir, 'local.mjs'), localPlugin);

    const env = {
      ...process.env,
      XDG_CONFIG_HOME: path.join(tempDir, 'xdg-config'),
      WORKLOG_PLUGIN_DIR: overrideDir
    };

    const { stdout } = await execAsync(`node ${cliPath} --help`, { env, cwd: tempDir });
    expect(stdout).toContain('override-cmd');
    expect(stdout).not.toContain('local-should-not-load');
  });
});
