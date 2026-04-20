import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  renderCliMarkdown,
  stripBlessedTags,
  createCliOutput,
  isTty,
  shouldUseFormattedOutput
} from '../../src/cli-output.js';

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

    it('falls back for large inputs', () => {
      const big = '# Header\n' + 'a'.repeat(150_000);
      const output = renderCliMarkdown(big, { formatAsMarkdown: true, maxSize: 100_000 });
      // Should return original (or stripped) without rendering
      expect(output).toContain('a'.repeat(100));
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
});