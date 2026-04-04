// Minimal markdown -> blessed tag renderer.
// Purpose: lightweight, dependency-free rendering for the TUI. Only a
// small subset of Markdown is supported (headers, lists, inline code,
// code fences, links). Behavior is intentionally simple and safe — for
// very large inputs the renderer returns the original text to avoid
// expensive processing in the TUI.

export interface RendererOptions {
  maxSize?: number; // characters
}

export function renderMarkdownToTags(input: string, opts?: RendererOptions): string {
  const maxSize = opts?.maxSize ?? 100_000; // safe default fallback
  if (!input) return '';
  if (input.length > maxSize) return input; // fallback for very large content

  let out = String(input);

  // Normalize line endings
  out = out.replace(/\r\n?/g, '\n');

  // Code fences: ```lang\n...``` -> header and indented code lines
  out = out.replace(/```(?:([a-zA-Z0-9_+-]+)\n)?([\s\S]*?)```/g, (_m, lang, code) => {
    const language = lang || 'code';
    const lines = String(code).split('\n');
    const renderedLines = lines.map(l => `  {gray-fg}${l}{/}`).join('\n');
    return `\n{cyan-fg}{bold}--- ${language} ---{/}\n${renderedLines}\n`;
  });

  // Headers: # Header -> bold white
  out = out.replace(/^#{1,6}\s*(.*)$/gm, (_m, txt) => {
    const t = String(txt).trim();
    return `{white-fg}{bold}${t}{/}`;
  });

  // Inline code: `code` -> magenta (without backticks)
  out = out.replace(/`([^`]+)`/g, (_m, c) => `{magenta-fg}${c}{/}`);

  // Links: [text](url) -> underlined blue text (url shown after)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, url) => `{underline}{blue-fg}${text}{/} (${url})`);

  // Unordered list markers: - or * -> bullet
  out = out.replace(/^(\s*)[-*]\s+/gm, (_m, indent) => `${indent}• `);

  // Ordered list: 1. -> keep as is but normalized spacing
  out = out.replace(/^\s*\d+\.\s+/gm, (m) => m.replace(/\s+/g, ' '));

  return out;
}

export default renderMarkdownToTags;
