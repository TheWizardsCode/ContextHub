import { describe, it, expect } from 'vitest';
import { renderMarkdownToTags } from '../../src/markdown-renderer.js';

describe('markdown renderer', () => {
  it('renders headers and inline code', () => {
    const md = '# Title\nSome `inline` code.';
    const out = renderMarkdownToTags(md);
    // Post-F2: output uses ANSI/chalk, not blessed-style tags
    expect(out).not.toContain('{white-fg}');
    expect(out).not.toContain('{magenta-fg}');
    expect(out).not.toContain('{/');
    expect(out).toContain('Title');
    expect(out).toContain('inline');
  });

  it('renders code fences with language label', () => {
    const md = '```js\nconsole.log(1);\n```';
    const out = renderMarkdownToTags(md);
    expect(out).not.toContain('{gray-fg}');
    expect(out).not.toContain('{/');
    expect(out).toContain('--- js ---');
    expect(out).toContain('console.log(1);');
  });

  it('renders lists and links', () => {
    const md = '- item1\n- item2\n[link](http://example.com)';
    const out = renderMarkdownToTags(md);
    expect(out).not.toContain('{underline}');
    expect(out).not.toContain('{blue-fg}');
    expect(out).not.toContain('{/');
    expect(out).toContain('• item1');
    expect(out).toContain('link');
    expect(out).toContain('http://example.com');
  });

  it('falls back for very large inputs', () => {
    const big = 'a'.repeat(200_000);
    const out = renderMarkdownToTags(big);
    expect(out).toBe(big);
  });
});
