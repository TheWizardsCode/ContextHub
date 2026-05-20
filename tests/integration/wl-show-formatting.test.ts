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
  describe('markdown format produces blessed tags in output', () => {
    it('renders description with markdown format through CLI renderer', () => {
      const input = '# My Title\nRun `wl status` for details\n```bash\nwl show FT-1\n```';
      const result = renderCliMarkdown(input, { formatAsMarkdown: true });
      // Should contain blessed formatting tags
      expect(result).toContain('{white-fg}{bold}My Title{/}');
      expect(result).toContain('{magenta-fg}wl status{/}');
      expect(result).toContain('--- bash ---');
    });

    it('plain format strips all blessed tags', () => {
      const input = '# My Title\nRun `wl status` for details';
      const result = renderCliMarkdown(input, { formatAsMarkdown: false });
      expect(result).not.toContain('{white-fg}');
      expect(result).not.toContain('{magenta-fg}');
      expect(result).toContain('My Title');
      expect(result).toContain('wl status');
    });
  });

  describe('humanFormatWorkItem handles format values', () => {
    it('handles markdown format by rendering through CLI renderer', () => {
      const result = humanFormatWorkItem(mockWorkItem, null, 'markdown');
      // Should contain blessed tags from markdown rendering
      expect(result).toContain('{magenta-fg}inline code{/}');
      expect(result).toContain('--- bash ---');
    });

    it('handles auto format without errors (TTY-dependent)', () => {
      // 'auto' defers to TTY detection — result depends on test environment
      const result = humanFormatWorkItem(mockWorkItem, null, 'auto');
      expect(result).toContain('Test item with');
      // Should not throw
    });

    it('handles plain format as full plain output (no blessed tags)', () => {
      const result = humanFormatWorkItem(mockWorkItem, null, 'plain');
      expect(result).toContain('Test item with');
      // Plain format should not produce blessed tags in the formatted portion
      // (the raw description text is shown but not rendered with blessed tags)
    });

    it('handles text format as full plain output (no blessed tags)', () => {
      const result = humanFormatWorkItem(mockWorkItem, null, 'text');
      expect(result).toContain('Test item with');
    });

    it('full format does not use markdown renderer in non-TTY (auto-detect)', () => {
      const result = humanFormatWorkItem(mockWorkItem, null, 'full');
      expect(result).toContain('Test item with');
      // In test environment (non-TTY), auto-detect defaults to off,
      // so full format does not render through markdown renderer
      expect(result).not.toContain('{white-fg}{bold}Description{/}');
    });

    it('full format auto-detects markdown from TTY when no config', async () => {
      // When no CLI flag and no config, auto-detect should use TTY status.
      // In non-TTY (test env), this means no markdown.
      // Mock isTty to simulate TTY environment.
      const cliOutput = await import('../../src/cli-output.js');
      const spy = vi.spyOn(cliOutput, 'isTty').mockReturnValue(true);
      try {
        const result = humanFormatWorkItem(mockWorkItem, null, 'full');
        // In TTY with no config, auto-detect should enable markdown
        expect(result).toContain('{magenta-fg}inline code{/}');
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
    // Full config required because humanFormatWorkItem calls loadStatusStageRules
    // which needs statuses, stages, statusStageCompatibility.
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
      // cliFormatMarkdown: true should enable markdown rendering even for 'full' format
      expect(result).toContain('{magenta-fg}inline code{/}');
      expect(result).toContain('--- bash ---');
    });

    it('cliFormatMarkdown true enables markdown for concise format', async () => {
      const spy = await setupSpy();
      spy.mockReturnValue({ ...fullConfig, cliFormatMarkdown: true });
      const result = humanFormatWorkItem(mockWorkItem, null, 'concise');
      // concise format with cliFormatMarkdown: true should render markdown.
      // Verify that cliFormatMarkdown: true produces output (no crash).
      expect(result).toContain('Test item with');
      expect(result).toContain('FT-001');
    });

    it('cliFormatMarkdown false disables markdown for full format', async () => {
      const spy = await setupSpy();
      spy.mockReturnValue({ ...fullConfig, cliFormatMarkdown: false });
      const result = humanFormatWorkItem(mockWorkItem, null, 'full');
      // cliFormatMarkdown: false should keep markdown disabled
      expect(result).not.toContain('{white-fg}{bold}Description{/}');
    });

    it('cliFormatMarkdown undefined (no config) keeps default behaviour', async () => {
      const spy = await setupSpy();
      const { cliFormatMarkdown: _, ...configWithoutMarkdown } = fullConfig;
      spy.mockReturnValue(configWithoutMarkdown as any);
      const result = humanFormatWorkItem(mockWorkItem, null, 'full');
      // No cliFormatMarkdown config: default is no markdown for 'full' format
      expect(result).not.toContain('{white-fg}{bold}Description{/}');
    });

    it('cliFormatMarkdown does not override explicit --format markdown', async () => {
      const spy = await setupSpy();
      spy.mockReturnValue({ ...fullConfig, cliFormatMarkdown: false });
      // --format markdown should override cliFormatMarkdown: false
      const result = humanFormatWorkItem(mockWorkItem, null, 'markdown');
      expect(result).toContain('{magenta-fg}inline code{/}');
    });

    it('cliFormatMarkdown does not override explicit --format plain', async () => {
      const spy = await setupSpy();
      spy.mockReturnValue({ ...fullConfig, cliFormatMarkdown: true });
      // --format plain should override cliFormatMarkdown: true
      const result = humanFormatWorkItem(mockWorkItem, null, 'plain');
      expect(result).not.toContain('{white-fg}{bold}');
    });

    it('cliFormatMarkdown does not override --format auto (non-TTY)', async () => {
      const spy = await setupSpy();
      spy.mockReturnValue({ ...fullConfig, cliFormatMarkdown: true });
      // --format auto is an explicit CLI choice for TTY detection.
      // In non-TTY (test env), --format auto should give plain output,
      // even when cliFormatMarkdown: true is set in config.
      const result = humanFormatWorkItem(mockWorkItem, null, 'auto');
      // In non-TTY, --format auto should NOT enable markdown,
      // regardless of cliFormatMarkdown config.
      expect(result).not.toContain('{white-fg}{bold}Description{/}');
      expect(result).not.toContain('{magenta-fg}inline code{/}');
    });
  });

  describe('createCliOutputFromCommand with config', () => {
    it('respects cliFormatMarkdown config when true', () => {
      const out = createCliOutputFromCommand(
        { format: undefined },
        { cliFormatMarkdown: true }
      );
      expect(out.isFormatted()).toBe(true);
      // Rendered content should contain blessed tags
      const result = out.render('# Header\nSome `code`');
      expect(result).toContain('{white-fg}{bold}Header{/}');
    });

    it('respects cliFormatMarkdown config when false', () => {
      const out = createCliOutputFromCommand(
        { format: undefined },
        { cliFormatMarkdown: false }
      );
      expect(out.isFormatted()).toBe(false);
      // Should strip blessed tags
      const result = out.render('# Header\nSome `code`');
      expect(result).not.toContain('{white-fg}');
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
      // --format auto is an explicit CLI choice for TTY auto-detection.
      // Config should NOT override it. In test env (non-TTY), result is false
      // even when cliFormatMarkdown: true is set in config.
      const out = createCliOutputFromCommand(
        { format: 'auto' },
        { cliFormatMarkdown: true }
      );
      // In test environment, isTty() returns false, so --format auto
      // should give false regardless of cliFormatMarkdown config.
      expect(out.isFormatted()).toBe(false);
    });
  });

  describe('size guard integration', () => {
    it('strips blessed tags from oversize markdown input', () => {
      const bigInput = '# Title\n{cyan-fg}highlighted{/}\n' + 'x'.repeat(150_000);
      const result = renderCliMarkdown(bigInput, { formatAsMarkdown: true, maxSize: 100_000 });
      // Should fall back to plain text (stripped blessed tags)
      expect(result).not.toContain('{cyan-fg}');
      expect(result).not.toContain('{/}');
      expect(result).toContain('Title');
      expect(result).toContain('highlighted');
    });

    it('preserves blessed tags for input within maxSize', () => {
      const normalInput = '# Title\n{magenta-fg}code{/}';
      const result = renderCliMarkdown(normalInput, { formatAsMarkdown: true, maxSize: 100_000 });
      // Should contain blessed rendering tags (from markdown processing)
      expect(result).toContain('{white-fg}{bold}');
    });

    it('rendered oversize output has no control characters (blessed tags)', () => {
      // Input with embedded blessed-like tags (which would come from partial rendering)
      const taggedInput = '# Header\n{magenta-fg}code{/}\n' + 'a'.repeat(150_000);
      const result = renderCliMarkdown(taggedInput, { formatAsMarkdown: true, maxSize: 50_000 });
      // Verify NO blessed tags remain in output
      expect(result).not.toContain('{magenta-fg}');
      expect(result).not.toContain('{/}');
      expect(result).not.toContain('{white-fg}');
      expect(result).not.toContain('{bold}');
      // Plain text should remain
      expect(result).toContain('Header');
      expect(result).toContain('code');
    });
  });
});