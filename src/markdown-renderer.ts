/**
 * Markdown renderer for CLI output.
 *
 * Renders a small subset of markdown (headers, lists, inline code, code
 * fences, links) into ANSI-colored output using chalk directly.
 *
 * Replaces the previous blessed-style tag renderer that produced
 * {color-fg} tags. The API signature (renderMarkdownToTags, RendererOptions)
 * is preserved for backward compatibility even though the name "ToTags" is
 * now a misnomer — the output is actually chalk ANSI strings.
 */

import chalk from 'chalk';

export interface RendererOptions {
  maxSize?: number; // characters
}

export function renderMarkdownToTags(input: string, opts?: RendererOptions): string {
  const maxSize = opts?.maxSize ?? 100_000;
  if (!input) return '';
  if (input.length > maxSize) return input;

  let out = String(input);

  // Normalize line endings
  out = out.replace(/\r\n?/g, '\n');

  // Code fences: ```lang\n...``` -> header and indented code lines
  out = out.replace(/```(?:([a-zA-Z0-9_+-]+)\n)?([\s\S]*?)```/g, (_m, lang, code) => {
    const language = lang || 'code';
    const lines = String(code).split('\n');
    const renderedLines = lines.map(l => `  ${chalk.gray(l)}`).join('\n');
    return `\n${chalk.cyan(chalk.bold(`--- ${language} ---`))}\n${renderedLines}\n`;
  });

  // Headers: # Header -> bold white
  out = out.replace(/^#{1,6}\s*(.*)$/gm, (_m, txt) => {
    const t = String(txt).trim();
    return chalk.white(chalk.bold(t));
  });

  // Inline code: `code` -> magenta
  out = out.replace(/`([^`]+)`/g, (_m, c) => chalk.magenta(c));

  // Links: [text](url) -> underlined blue text (url shown after)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, url) => `${chalk.blue(chalk.underline(text))} (${url})`);

  // Unordered list markers: - or * -> bullet
  out = out.replace(/^(\s*)[-*]\s+/gm, (_m, indent) => `${indent}• `);

  // Ordered list: 1. -> keep as is but normalized spacing
  out = out.replace(/^\s*\d+\.\s+/gm, (m) => m.replace(/\s+/g, ' '));

  return out;
}

export default renderMarkdownToTags;
