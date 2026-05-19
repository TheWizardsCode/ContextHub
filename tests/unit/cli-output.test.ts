import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  renderCliMarkdown,
  stripBlessedTags,
  createCliOutput,
  createCliOutputFromCommand,
  isTty,
  shouldUseFormattedOutput,
  resolveFormatToMarkdown,
  onCliRenderEvent,
  type CliRenderTelemetryEvent
} from '../../src/cli-output.js';
import * as markdownRenderer from '../../src/tui/markdown-renderer.js';

describe('cli-output', () => {
  describe('renderCliMarkdown', () => {
    it('renders empty input as empty string', () => {
      expect(renderCliMarkdown('')).toBe('');
      expect(renderCliMarkdown(undefined as any)).toBe('');
    });

    it('renders headers', () => {
      const input = '# Hello World';
      const output = renderCliMarkdown(input, { formatAsMarkdown: true });
      expect(output).toContain('{white-fg}{bold}Hello World{/}');
    });

    it('renders inline code', () => {
      const input = 'Run `wl status` for details';
      const output = renderCliMarkdown(input, { formatAsMarkdown: true });
      expect(output).toContain('{magenta-fg}wl status{/}');
    });

    it('renders code fences with language', () => {
      const input = '```js\nconsole.log("test");\n```';
      const output = renderCliMarkdown(input, { formatAsMarkdown: true });
      expect(output).toContain('--- js ---');
      expect(output).toContain('{gray-fg}console.log("test");{/}');
    });

    it('renders lists', () => {
      const input = '- item 1\n- item 2';
      const output = renderCliMarkdown(input, { formatAsMarkdown: true });
      expect(output).toContain('• item 1');
      expect(output).toContain('• item 2');
    });

    it('renders links', () => {
      const input = 'See [docs](http://example.com) for info';
      const output = renderCliMarkdown(input, { formatAsMarkdown: true });
      expect(output).toContain('{underline}{blue-fg}docs{/} (http://example.com)');
    });

    it('falls back to plain text when disabled', () => {
      const input = '# Header\nSome `code`';
      const output = renderCliMarkdown(input, { formatAsMarkdown: false });
      // Should strip blessed tags
      expect(output).not.toContain('{white-fg}');
      expect(output).not.toContain('{magenta-fg}');
      expect(output).toContain('Header');
      expect(output).toContain('code');
    });

    it('falls back for large inputs over maxSize', () => {
      const big = '# Header\n' + 'a'.repeat(150_000);
      const output = renderCliMarkdown(big, { formatAsMarkdown: true, maxSize: 100_000 });
      // Should strip blessed tags when falling back for size guard
      expect(output).not.toContain('{white-fg}');
      expect(output).not.toContain('{bold}');
      expect(output).toContain('# Header');
      expect(output).toContain('a');
    });

    it('renders input exactly at maxSize boundary', () => {
      const input = '# ' + 'a'.repeat(20);
      const output = renderCliMarkdown(input, { formatAsMarkdown: true, maxSize: input.length });
      expect(output).toContain('{white-fg}{bold}');
    });

    it('uses fallback value when renderer throws', () => {
      const spy = vi.spyOn(markdownRenderer, 'renderMarkdownToTags').mockImplementation(() => {
        throw new Error('renderer failure');
      });

      const output = renderCliMarkdown('# Header', { formatAsMarkdown: true, fallback: 'fallback text' });
      expect(output).toBe('fallback text');

      spy.mockRestore();
    });

    it('strips blessed tags on renderer failure when no fallback provided', () => {
      const spy = vi.spyOn(markdownRenderer, 'renderMarkdownToTags').mockImplementation(() => {
        throw new Error('renderer failure');
      });

      // Input contains a blessed tag that should be stripped on failure
      const input = '# Hello {magenta-fg}world{/}';
      const output = renderCliMarkdown(input, { formatAsMarkdown: true });
      expect(output).not.toContain('{magenta-fg}');
      expect(output).toContain('Hello');
      expect(output).toContain('world');

      spy.mockRestore();
    });

    // Size guard: blessed tags are stripped from oversize input
    it('strips blessed tags from oversize input (no control characters in output)', () => {
      const input = '# Title\n{magenta-fg}inline code{/}\n' + 'x'.repeat(200_000);
      const output = renderCliMarkdown(input, { formatAsMarkdown: true, maxSize: 100_000 });
      // Should NOT contain any blessed tags in size-guarded fallback
      expect(output).not.toContain('{magenta-fg}');
      expect(output).not.toContain('{/}');
      expect(output).not.toContain('{white-fg}');
      expect(output).not.toContain('{bold}');
      // Should still contain the plain text
      expect(output).toContain('Title');
    });

    it('size guard fallback preserves input text but strips tags', () => {
      const taggedInput = '# Header\n{cyan-fg}some code{/}\n' + 'a'.repeat(150_000);
      const output = renderCliMarkdown(taggedInput, { formatAsMarkdown: true, maxSize: 100_000 });
      // Plain text content should be preserved
      expect(output).toContain('Header');
      expect(output).toContain('some code');
      // No blessed tags should remain
      expect(output).not.toContain('{cyan-fg}');
    });
  });

  describe('stripBlessedTags', () => {
    it('removes blessed tag patterns', () => {
      const input = '{white-fg}{bold}Title{/} and {magenta-fg}code{/}';
      const output = stripBlessedTags(input);
      expect(output).toBe('Title and code');
    });

    it('handles empty and undefined', () => {
      expect(stripBlessedTags('')).toBe('');
      expect(stripBlessedTags(undefined as any)).toBe('');
    });

    it('handles text without tags', () => {
      expect(stripBlessedTags('plain text')).toBe('plain text');
    });

    it('strips multiple nested tags', () => {
      const input = '{red-fg}{bold}Error:{/} file not found{/}';
      const output = stripBlessedTags(input);
      expect(output).toBe('Error: file not found');
    });

    it('strips tags from markdown-rendered output', () => {
      // Simulate what renderMarkdownToTags returns
      const input = '{white-fg}{bold}Header{/}\n• Item with {magenta-fg}code{/}';
      const output = stripBlessedTags(input);
      expect(output).toBe('Header\n• Item with code');
      // Most importantly, no curly-brace tags remain
      expect(output).not.toContain('{');
    });
  });

  describe('createCliOutput', () => {
    it('creates output helpers', () => {
      const out = createCliOutput({ formatAsMarkdown: true });
      expect(out.print).toBeDefined();
      expect(out.printError).toBeDefined();
      expect(out.render).toBeDefined();
      expect(out.isFormatted).toBeDefined();
    });

    it('respects formatAsMarkdown option', () => {
      const out = createCliOutput({ formatAsMarkdown: false });
      const result = out.render('# Test');
      expect(result).not.toContain('{white-fg}');
    });
  });

  describe('isTty', () => {
    it('returns boolean', () => {
      const result = isTty();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('shouldUseFormattedOutput', () => {
    it('respects explicit false to disable', () => {
      expect(shouldUseFormattedOutput(false)).toBe(false);
    });

    it('respects explicit true to enable', () => {
      expect(shouldUseFormattedOutput(true)).toBe(true);
    });

    it('defaults to TTY detection when undefined', () => {
      const result = shouldUseFormattedOutput(undefined);
      expect(typeof result).toBe('boolean');
    });
  });

  describe('resolveFormatToMarkdown', () => {
    it('resolves markdown to true', () => {
      expect(resolveFormatToMarkdown('markdown')).toBe(true);
    });

    it('resolves plain to false', () => {
      expect(resolveFormatToMarkdown('plain')).toBe(false);
    });

    it('resolves text to false', () => {
      expect(resolveFormatToMarkdown('text')).toBe(false);
    });

    it('resolves auto to undefined (let TTY auto-detect decide)', () => {
      expect(resolveFormatToMarkdown('auto')).toBeUndefined();
    });

    it('resolves other formats to undefined (no effect on markdown)', () => {
      expect(resolveFormatToMarkdown('full')).toBeUndefined();
      expect(resolveFormatToMarkdown('concise')).toBeUndefined();
      expect(resolveFormatToMarkdown('summary')).toBeUndefined();
      expect(resolveFormatToMarkdown('normal')).toBeUndefined();
      expect(resolveFormatToMarkdown('raw')).toBeUndefined();
    });

    it('handles empty and undefined input', () => {
      expect(resolveFormatToMarkdown(undefined)).toBeUndefined();
      expect(resolveFormatToMarkdown('')).toBeUndefined();
    });

    it('is case insensitive', () => {
      expect(resolveFormatToMarkdown('MARKDOWN')).toBe(true);
      expect(resolveFormatToMarkdown('Plain')).toBe(false);
      expect(resolveFormatToMarkdown('AUTO')).toBeUndefined();
    });
  });

  describe('createCliOutputFromCommand - precedence', () => {
    it('CLI --format markdown takes priority over config', () => {
      const out = createCliOutputFromCommand(
        { format: 'markdown' },
        { cliFormatMarkdown: false }
      );
      expect(out.isFormatted()).toBe(true);
    });

    it('CLI --format plain takes priority over config', () => {
      const out = createCliOutputFromCommand(
        { format: 'plain' },
        { cliFormatMarkdown: true }
      );
      expect(out.isFormatted()).toBe(false);
    });

    it('CLI --format text takes priority over config', () => {
      const out = createCliOutputFromCommand(
        { format: 'text' },
        { cliFormatMarkdown: true }
      );
      expect(out.isFormatted()).toBe(false);
    });

    it('CLI --format auto defers to TTY auto-detect (ignoring config)', () => {
      // --format auto means "auto-detect", so config should NOT override it
      const out = createCliOutputFromCommand(
        { format: 'auto' },
        { cliFormatMarkdown: true }
      );
      // Result depends on TTY detection in test env
      expect(typeof out.isFormatted()).toBe('boolean');
    });

    it('config cliFormatMarkdown true enables when no CLI flag', () => {
      const out = createCliOutputFromCommand(
        { format: undefined },
        { cliFormatMarkdown: true }
      );
      expect(out.isFormatted()).toBe(true);
    });

    it('config cliFormatMarkdown false disables when no CLI flag', () => {
      const out = createCliOutputFromCommand(
        { format: undefined },
        { cliFormatMarkdown: false }
      );
      expect(out.isFormatted()).toBe(false);
    });

    it('no flags or config: falls back to TTY auto-detect', () => {
      const out = createCliOutputFromCommand({});
      expect(typeof out.isFormatted()).toBe('boolean');
    });

    it('CLI formatAsMarkdown flag works', () => {
      const out = createCliOutputFromCommand(
        { formatAsMarkdown: true },
        { cliFormatMarkdown: false }
      );
      expect(out.isFormatted()).toBe(true);
    });

    it('respects formatAsMarkdown false even when config is true', () => {
      const out = createCliOutputFromCommand(
        { formatAsMarkdown: false },
        { cliFormatMarkdown: true }
      );
      expect(out.isFormatted()).toBe(false);
    });
  });

  describe('telemetry events', () => {
    it('emits cli_render_used event on successful rendering', () => {
      const events: CliRenderTelemetryEvent[] = [];
      const unsubscribe = onCliRenderEvent((event) => events.push(event));

      renderCliMarkdown('# Hello', { formatAsMarkdown: true });

      const usedEvents = events.filter(e => e.event === 'cli_render_used');
      expect(usedEvents.length).toBe(1);
      expect(usedEvents[0].inputSize).toBe('# Hello'.length);
      expect(typeof usedEvents[0].isTty).toBe('boolean');

      unsubscribe();
    });

    it('emits cli_render_fallback_size event when input exceeds maxSize', () => {
      const events: CliRenderTelemetryEvent[] = [];
      const unsubscribe = onCliRenderEvent((event) => events.push(event));

      const bigInput = 'x'.repeat(150_000);
      renderCliMarkdown(bigInput, { formatAsMarkdown: true, maxSize: 100_000 });

      const fallbackEvents = events.filter(e => e.event === 'cli_render_fallback_size');
      expect(fallbackEvents.length).toBe(1);
      expect(fallbackEvents[0].inputSize).toBe(150_000);
      expect(fallbackEvents[0].maxAllowed).toBe(100_000);

      unsubscribe();
    });

    it('emits cli_render_error event when renderer throws', () => {
      const events: CliRenderTelemetryEvent[] = [];
      const unsubscribe = onCliRenderEvent((event) => events.push(event));

      const spy = vi.spyOn(markdownRenderer, 'renderMarkdownToTags').mockImplementation(() => {
        throw new Error('test render failure');
      });

      renderCliMarkdown('# Test', { formatAsMarkdown: true });

      const errorEvents = events.filter(e => e.event === 'cli_render_error');
      expect(errorEvents.length).toBe(1);
      expect(errorEvents[0].errorType).toBe('test render failure');

      spy.mockRestore();
      unsubscribe();
    });

    it('unsubscribe stops receiving events', () => {
      const events: CliRenderTelemetryEvent[] = [];
      const unsubscribe = onCliRenderEvent((event) => events.push(event));

      renderCliMarkdown('# First', { formatAsMarkdown: true });
      expect(events.length).toBe(1);

      unsubscribe();
      renderCliMarkdown('# Second', { formatAsMarkdown: true });
      // Should not have received the second event
      expect(events.length).toBe(1);
    });

    it('does not emit events when formatting is disabled', () => {
      const events: CliRenderTelemetryEvent[] = [];
      const unsubscribe = onCliRenderEvent((event) => events.push(event));

      renderCliMarkdown('# Hello', { formatAsMarkdown: false });
      expect(events.length).toBe(0);

      unsubscribe();
    });
  });

  describe('help text rendering', () => {
    it('renders help-style text with inline code through markdown renderer', () => {
      // Simulating what help text might contain
      const helpText = 'Run `wl show <id>` to display details';
      const result = renderCliMarkdown(helpText, { formatAsMarkdown: true });
      expect(result).toContain('{magenta-fg}wl show <id>{/}');
    });

    it('renders help text with headers', () => {
      const helpText = '# Commands\nSome description';
      const result = renderCliMarkdown(helpText, { formatAsMarkdown: true });
      expect(result).toContain('{white-fg}{bold}Commands{/}');
    });

    it('renders help text with lists', () => {
      const helpText = '- create: Create a new work item\n- show: Show work item details';
      const result = renderCliMarkdown(helpText, { formatAsMarkdown: true });
      expect(result).toContain('• create: Create a new work item');
      expect(result).toContain('• show: Show work item details');
    });

    it('renders help text with code fences', () => {
      const helpText = 'Example:\n```bash\nwl show WL-123\n```';
      const result = renderCliMarkdown(helpText, { formatAsMarkdown: true });
      expect(result).toContain('--- bash ---');
      expect(result).toContain('{gray-fg}wl show WL-123{/}');
    });

    it('strips tags from help text when formatting disabled', () => {
      const helpText = 'Run `wl status` for details';
      const result = renderCliMarkdown(helpText, { formatAsMarkdown: false });
      expect(result).not.toContain('{magenta-fg}');
      expect(result).toContain('wl status');
    });
  });
});