import { describe, it, expect } from 'vitest';
import { renderMarkdownToTags } from '../../src/tui/markdown-renderer.js';

describe('markdown renderer', () => {
  it('renders headers and inline code', () => {
    const md = '# Title\nSome `inline` code.';
    const out = renderMarkdownToTags(md);
    expect(out).toContain('{white-fg}{bold}Title{/}');
    expect(out).toContain('{magenta-fg}inline{/}');
  });

  it('renders code fences with language label', () => {
    const md = '```js\nconsole.log(1);\n```';
    const out = renderMarkdownToTags(md);
    expect(out).toContain('--- js ---');
    expect(out).toContain('{gray-fg}console.log(1);{/}');
  });

  it('renders lists and links', () => {
    const md = '- item1\n- item2\n[link](http://example.com)';
    const out = renderMarkdownToTags(md);
    expect(out).toContain('• item1');
    expect(out).toContain('{underline}{blue-fg}link{/} (http://example.com)');
  });

  it('falls back for very large inputs', () => {
    const big = 'a'.repeat(200_000);
    const out = renderMarkdownToTags(big);
    expect(out).toBe(big);
  });
});
