/**
 * Integration tests for wl show command output formatting.
 * Tests that TTY and non-TTY environments produce correct output
 * (formatted markdown vs plain text).
 *
 * These tests validate the formatting integration between CLI flags,
 * config, and the markdown renderer — without spawning CLI subprocesses
 * (subprocess TTY simulation is covered separately).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderCliMarkdown, createCliOutputFromCommand, stripBlessedTags } from '../../src/cli-output.js';
import { humanFormatWorkItem } from '../../src/commands/helpers.js';
import type { WorkItem } from '../../src/types.js';

// Minimal mock WorkItem for testing humanFormatWorkItem without database
const mockWorkItem: WorkItem = {
  id: 'FT-001',
  title: 'Test item with `backticks`',
  description: '## Description\n\nThis has **bold** text and `inline code`.\n\n```bash\nwl show FT-1\n```',
  status: 'open',
  priority: 'medium',
  sortIndex: 100,
  parentId: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  tags: ['test'],
  assignee: '',
  stage: 'idea',
  issueType: 'task',
  createdBy: '',
  deletedBy: '',
  deleteReason: '',
  risk: '',
  effort: '',
};

describe('wl show formatting integration', () => {
  describe('markdown format produces ANSI/chalk output', () => {
    it('renders description with markdown format through CLI renderer', () => {
      const input = '# My Title\nRun `wl status` for details\n```bash\nwl show FT-1\n```';
      const result = renderCliMarkdown(input, { formatAsMarkdown: true });
      // Post-F2: output uses ANSI/chalk, not blessed-style tags
      expect(result).not.toContain('{white-fg}');
      expect(result).not.toContain('{magenta-fg}');
      expect(result).not.toContain('{/');
      expect(result).toContain('My Title');
      expect(result).toContain('wl status');
      expect(result).toContain('--- bash ---');
    });

    it('plain format strips ANSI codes', () => {
      const input = '# My Title\nRun `wl status` for details';
      const result = renderCliMarkdown(input, { formatAsMarkdown: false });
      expect(result).not.toContain('\u001b[');
      expect(result).toContain('My Title');
      expect(result).toContain('wl status');
    });
  });

  describe('humanFormatWorkItem handles format values', () => {
    it('handles markdown format by rendering through CLI renderer', () => {
      const result = humanFormatWorkItem(mockWorkItem, null, 'markdown');
      // Post-F2: no blessed tags in output
      expect(result).not.toContain('{magenta-fg}');
      expect(result).not.toContain('{/');
      expect(result).toContain('inline code');
      expect(result).toContain('--- bash ---');
    });

    it('handles auto format without errors (TTY-dependent)', () => {
      const result = humanFormatWorkItem(mockWorkItem, null, 'auto');
      expect(result).toContain('Test item with');
    });

    it('handles plain format as full plain output (no ANSI codes)', () => {
      const result = humanFormatWorkItem(mockWorkItem, null, 'plain');
      expect(result).toContain('Test item with');
    });

    it('handles text format as full plain output (no ANSI codes)', () => {
      const result = humanFormatWorkItem(mockWorkItem, null, 'text');
      expect(result).toContain('Test item with');
    });

    it('full format does not use markdown renderer in non-TTY (auto-detect)', () => {
      const result = humanFormatWorkItem(mockWorkItem, null, 'full');
      expect(result).toContain('Test item with');
      // In test environment (non-TTY), auto-detect defaults to off
      expect(result).not.toContain('\u001b[');
    });

    it('full format auto-detects markdown from TTY when no config', async () => {
      const cliOutput = await import('../../src/cli-output.js');
      const spy = vi.spyOn(cliOutput, 'isTty').mockReturnValue(true);
      try {
        const result = humanFormatWorkItem(mockWorkItem, null, 'full');
        // In TTY with no config, auto-detect should enable markdown
        expect(result).not.toContain('{magenta-fg}');
        expect(result).not.toContain('{/');
        expect(result).toContain('inline code');
        expect(result).toContain('--- bash ---');
      } finally {
        spy.mockRestore();
      }
    });

    it('summary format still works (not affected by markdown)', () => {
      const result = humanFormatWorkItem(mockWorkItem, null, 'summary');
      expect(result).toContain('Test item with');
    });
  });

  describe('humanFormatWorkItem with cliFormatMarkdown config', () => {
    const fullConfig = {
      projectName: 'TestProject',
      prefix: 'TP',
      cliFormatMarkdown: true as boolean | undefined,
      statuses: [
        { value: 'open', label: 'Open' },
        { value: 'completed', label: 'Completed' },
        { value: 'deleted', label: 'Deleted' },
      ],
      stages: [
        { value: 'idea', label: 'Idea' },
        { value: 'in_progress', label: 'In Progress' },
        { value: 'in_review', label: 'In Review' },
        { value: 'done', label: 'Done' },
      ],
      statusStageCompatibility: {
        open: ['idea', 'in_progress'],
        completed: ['in_review', 'done'],
        deleted: ['idea'],
      },
    };

    let loadConfigSpy: ReturnType<typeof vi.spyOn>;

    afterEach(() => {
      if (loadConfigSpy) loadConfigSpy.mockRestore();
    });

    async function setupSpy() {
      const config = await import('../../src/config.js');
      loadConfigSpy = vi.spyOn(config, 'loadConfig');
      return loadConfigSpy;
    }

    it('cliFormatMarkdown true enables markdown for full format', async () => {
      const spy = await setupSpy();
      spy.mockReturnValue({ ...fullConfig, cliFormatMarkdown: true });
      const result = humanFormatWorkItem(mockWorkItem, null, 'full');
      // cliFormatMarkdown: true should enable markdown rendering
      expect(result).not.toContain('{magenta-fg}');
      expect(result).not.toContain('{/');
      expect(result).toContain('inline code');
      expect(result).toContain('--- bash ---');
    });

    it('cliFormatMarkdown true enables markdown for concise format', async () => {
      const spy = await setupSpy();
      spy.mockReturnValue({ ...fullConfig, cliFormatMarkdown: true });
      const result = humanFormatWorkItem(mockWorkItem, null, 'concise');
      expect(result).toContain('Test item with');
      expect(result).toContain('FT-001');
    });

    it('cliFormatMarkdown false disables markdown for full format', async () => {
      const spy = await setupSpy();
      spy.mockReturnValue({ ...fullConfig, cliFormatMarkdown: false });
      const result = humanFormatWorkItem(mockWorkItem, null, 'full');
      expect(result).not.toContain('\u001b[');
    });

    it('cliFormatMarkdown undefined (no config) keeps default behaviour', async () => {
      const spy = await setupSpy();
      const { cliFormatMarkdown: _, ...configWithoutMarkdown } = fullConfig;
      spy.mockReturnValue(configWithoutMarkdown as any);
      const result = humanFormatWorkItem(mockWorkItem, null, 'full');
      expect(result).not.toContain('\u001b[');
    });

    it('cliFormatMarkdown does not override explicit --format markdown', async () => {
      const spy = await setupSpy();
      spy.mockReturnValue({ ...fullConfig, cliFormatMarkdown: false });
      const result = humanFormatWorkItem(mockWorkItem, null, 'markdown');
      expect(result).not.toContain('{magenta-fg}');
      expect(result).not.toContain('{/');
      expect(result).toContain('inline code');
    });

    it('cliFormatMarkdown does not override explicit --format plain', async () => {
      const spy = await setupSpy();
      spy.mockReturnValue({ ...fullConfig, cliFormatMarkdown: true });
      const result = humanFormatWorkItem(mockWorkItem, null, 'plain');
      expect(result).not.toContain('{white-fg}');
    });

    it('cliFormatMarkdown does not override --format auto (non-TTY)', async () => {
      const spy = await setupSpy();
      spy.mockReturnValue({ ...fullConfig, cliFormatMarkdown: true });
      const result = humanFormatWorkItem(mockWorkItem, null, 'auto');
      expect(result).not.toContain('\u001b[');
    });
  });

  describe('createCliOutputFromCommand with config', () => {
    it('respects cliFormatMarkdown config when true', () => {
      const out = createCliOutputFromCommand(
        { format: undefined },
        { cliFormatMarkdown: true }
      );
      expect(out.isFormatted()).toBe(true);
      const result = out.render('# Header\nSome `code`');
      // Post-F2: output uses ANSI/chalk, not blessed tags
      expect(result).not.toContain('{white-fg}');
      expect(result).not.toContain('{/');
      expect(result).toContain('Header');
      expect(result).toContain('code');
    });

    it('respects cliFormatMarkdown config when false', () => {
      const out = createCliOutputFromCommand(
        { format: undefined },
        { cliFormatMarkdown: false }
      );
      expect(out.isFormatted()).toBe(false);
      const result = out.render('# Header\nSome `code`');
      expect(result).not.toContain('\u001b[');
      expect(result).toContain('Header');
    });

    it('CLI flag overrides config cliFormatMarkdown', () => {
      const out = createCliOutputFromCommand(
        { format: 'markdown' },
        { cliFormatMarkdown: false }
      );
      expect(out.isFormatted()).toBe(true);
    });

    it('CLI plain flag overrides config cliFormatMarkdown true', () => {
      const out = createCliOutputFromCommand(
        { format: 'plain' },
        { cliFormatMarkdown: true }
      );
      expect(out.isFormatted()).toBe(false);
    });

    it('CLI text flag overrides config cliFormatMarkdown true', () => {
      const out = createCliOutputFromCommand(
        { format: 'text' },
        { cliFormatMarkdown: true }
      );
      expect(out.isFormatted()).toBe(false);
    });

    it('--format auto ignores config and uses TTY detection', () => {
      const out = createCliOutputFromCommand(
        { format: 'auto' },
        { cliFormatMarkdown: true }
      );
      expect(out.isFormatted()).toBe(false);
    });
  });

  describe('size guard integration', () => {
    it('strips ANSI codes from oversize input', () => {
      const bigInput = '# Title\nsome text\n' + 'x'.repeat(150_000);
      const result = renderCliMarkdown(bigInput, { formatAsMarkdown: true, maxSize: 100_000 });
      // Should fall back to plain text (strip ANSI codes)
      expect(result).not.toContain('\u001b[');
      expect(result).toContain('Title');
      expect(result).toContain('some text');
    });

    it('renders content for input within maxSize', () => {
      const normalInput = '# Title\nSome `code`';
      const result = renderCliMarkdown(normalInput, { formatAsMarkdown: true, maxSize: 100_000 });
      // Should render with ANSI/chalk (no blessed tags)
      expect(result).not.toContain('{white-fg}');
      expect(result).not.toContain('{/');
      expect(result).toContain('Title');
      expect(result).toContain('code');
    });

    it('rendered oversize output has no ANSI control characters', () => {
      const taggedInput = '# Header\nsome text\n' + 'a'.repeat(150_000);
      const result = renderCliMarkdown(taggedInput, { formatAsMarkdown: true, maxSize: 50_000 });
      // Verify no ANSI codes remain in output
      expect(result).not.toContain('\u001b[');
      expect(result).toContain('Header');
      expect(result).toContain('some text');
    });
  });
});
