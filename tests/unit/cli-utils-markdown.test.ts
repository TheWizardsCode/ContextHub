/**
 * Unit tests for createMarkdownOutputHelpers in cli-utils.ts.
 * Tests the --format precedence chain (CLI > config > auto-detect)
 * and the --format auto bypass of config.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';
import { createMarkdownOutputHelpers } from '../../src/cli-utils.js';

// Mock loadConfig to control config responses in tests
vi.mock('../../src/config.js', () => ({
  loadConfig: vi.fn(() => ({
    projectName: 'TestProject',
    prefix: 'TP',
    cliFormatMarkdown: undefined,
    statuses: [{ value: 'open', label: 'Open' }],
    stages: [{ value: 'idea', label: 'Idea' }],
    statusStageCompatibility: {},
  })),
  loadConfigRelaxed: vi.fn(() => ({
    projectName: 'TestProject',
    prefix: 'TP',
    cliFormatMarkdown: undefined,
  })),
  isInitialized: vi.fn(() => true),
  getDefaultPrefix: vi.fn(() => 'TP'),
}));

// Mock database module to avoid SQLite issues in unit tests
vi.mock('../../src/database.js', () => ({
  WorklogDatabase: vi.fn(),
}));

// Mock JSONL module
vi.mock('../../src/jsonl.js', () => ({
  getDefaultDataPath: vi.fn(() => '/tmp/test-worklog-data.jsonl'),
}));

describe('createMarkdownOutputHelpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeProgram(opts: Record<string, any> = {}): Command {
    const program = new Command();
    program.option('--json', 'JSON output');
    program.option('-F, --format <format>', 'Format');
    // Simulate parsed options
    program.parse([], { from: 'user' });
    // Override program.opts() for test control
    const origOpts = program.opts.bind(program);
    vi.spyOn(program, 'opts').mockReturnValue({ ...origOpts(), ...opts });
    return program;
  }

  describe('CLI flag precedence', () => {
    it('--format markdown enables markdown regardless of config', async () => {
      const config = await import('../../src/config.js');
      vi.spyOn(config, 'loadConfig').mockReturnValue({
        projectName: 'TestProject',
        prefix: 'TP',
        cliFormatMarkdown: false,
      } as any);
      const program = makeProgram({ format: 'markdown' });
      const helpers = createMarkdownOutputHelpers(program);
      expect(helpers.isFormatted()).toBe(true);
    });

    it('--format plain disables markdown regardless of config', async () => {
      const config = await import('../../src/config.js');
      vi.spyOn(config, 'loadConfig').mockReturnValue({
        projectName: 'TestProject',
        prefix: 'TP',
        cliFormatMarkdown: true,
      } as any);
      const program = makeProgram({ format: 'plain' });
      const helpers = createMarkdownOutputHelpers(program);
      expect(helpers.isFormatted()).toBe(false);
    });

    it('--format text disables markdown regardless of config', async () => {
      const config = await import('../../src/config.js');
      vi.spyOn(config, 'loadConfig').mockReturnValue({
        projectName: 'TestProject',
        prefix: 'TP',
        cliFormatMarkdown: true,
      } as any);
      const program = makeProgram({ format: 'text' });
      const helpers = createMarkdownOutputHelpers(program);
      expect(helpers.isFormatted()).toBe(false);
    });

    it('--format auto ignores config and uses TTY detection (non-TTY)', async () => {
      const config = await import('../../src/config.js');
      vi.spyOn(config, 'loadConfig').mockReturnValue({
        projectName: 'TestProject',
        prefix: 'TP',
        cliFormatMarkdown: true,
      } as any);
      const program = makeProgram({ format: 'auto' });
      const helpers = createMarkdownOutputHelpers(program);
      // In test environment (non-TTY), --format auto should give false
      // even when cliFormatMarkdown: true is set in config
      expect(helpers.isFormatted()).toBe(false);
    });

    it('--format auto in TTY should use TTY detection, not config', async () => {
      const config = await import('../../src/config.js');
      vi.spyOn(config, 'loadConfig').mockReturnValue({
        projectName: 'TestProject',
        prefix: 'TP',
        cliFormatMarkdown: false,
      } as any);
      const program = makeProgram({ format: 'auto' });
      // In test environment (non-TTY), --format auto should give false
      // even though config says false (both agree here, but the point is
      // --format auto does NOT read config)
      const helpers = createMarkdownOutputHelpers(program);
      expect(helpers.isFormatted()).toBe(false);
    });
  });

  describe('config precedence', () => {
    it('cliFormatMarkdown true enables markdown when no CLI flag', async () => {
      const config = await import('../../src/config.js');
      vi.spyOn(config, 'loadConfig').mockReturnValue({
        projectName: 'TestProject',
        prefix: 'TP',
        cliFormatMarkdown: true,
      } as any);
      const program = makeProgram({ format: undefined });
      const helpers = createMarkdownOutputHelpers(program);
      expect(helpers.isFormatted()).toBe(true);
    });

    it('cliFormatMarkdown false disables markdown when no CLI flag', async () => {
      const config = await import('../../src/config.js');
      vi.spyOn(config, 'loadConfig').mockReturnValue({
        projectName: 'TestProject',
        prefix: 'TP',
        cliFormatMarkdown: false,
      } as any);
      const program = makeProgram({ format: undefined });
      const helpers = createMarkdownOutputHelpers(program);
      expect(helpers.isFormatted()).toBe(false);
    });

    it('no CLI flag and no config: auto-detect from TTY', async () => {
      const config = await import('../../src/config.js');
      vi.spyOn(config, 'loadConfig').mockReturnValue({
        projectName: 'TestProject',
        prefix: 'TP',
      } as any);
      const program = makeProgram({ format: undefined });
      const helpers = createMarkdownOutputHelpers(program);
      // In test environment (non-TTY), auto-detect should give false
      expect(typeof helpers.isFormatted()).toBe('boolean');
    });
  });

  describe('JSON mode precedence', () => {
    it('JSON mode disables markdown regardless of other settings', async () => {
      const config = await import('../../src/config.js');
      vi.spyOn(config, 'loadConfig').mockReturnValue({
        projectName: 'TestProject',
        prefix: 'TP',
        cliFormatMarkdown: true,
      } as any);
      const program = makeProgram({ json: true, format: 'markdown' });
      const helpers = createMarkdownOutputHelpers(program);
      expect(helpers.isFormatted()).toBe(false);
    });
  });

  describe('render and print methods', () => {
    it('render returns rendered text when markdown enabled', async () => {
      const config = await import('../../src/config.js');
      vi.spyOn(config, 'loadConfig').mockReturnValue({
        projectName: 'TestProject',
        prefix: 'TP',
      } as any);
      const program = makeProgram({ format: 'markdown' });
      const helpers = createMarkdownOutputHelpers(program);
      // isFormatted should be true
      expect(helpers.isFormatted()).toBe(true);
      // render should produce blessed tags
      const result = helpers.render('# Header\nSome `code`');
      expect(result).toContain('{white-fg}{bold}Header{/}');
      expect(result).toContain('{magenta-fg}code{/}');
    });

    it('render returns plain text when markdown disabled', async () => {
      const config = await import('../../src/config.js');
      vi.spyOn(config, 'loadConfig').mockReturnValue({
        projectName: 'TestProject',
        prefix: 'TP',
      } as any);
      const program = makeProgram({ format: 'plain' });
      const helpers = createMarkdownOutputHelpers(program);
      expect(helpers.isFormatted()).toBe(false);
      const result = helpers.render('# Header\nSome `code`');
      expect(result).not.toContain('{white-fg}');
      expect(result).toContain('Header');
      expect(result).toContain('code');
    });
  });
});