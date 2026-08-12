/**
 * packages/herdr/src/md-viewer.ts — Generic markdown document viewer helpers
 * for the Herdr worklist-selection-list plugin.
 *
 * Pure, dependency-injectable rendering helpers used to preview an episode
 * file (opened from a work item's `Key Files:`) in a viewer pane, and to
 * render inline `[NOTE <id>: ...]` markers (PRD §7.1) as clickable links to
 * the note work items (operator decision: marker-as-link rendering is
 * required).
 *
 * Markdown is parsed with the `marked` library (declared dependency of
 * `packages/herdr`) and rendered to ANSI-styled terminal lines via a custom
 * token walker that emits the constructs used in `.podcast.md` episode
 * files and work-item descriptions:
 *
 * - ATX heading hierarchy (`#`…`######`, distinct glyphs per level),
 * - ordered and nested bullet lists,
 * - blockquotes,
 * - GFM tables (aligned columns),
 * - fenced code blocks and inline code spans,
 * - bold / italic / strikethrough / links,
 * - horizontal rules,
 * - paragraphs (word-wrapped to the terminal width).
 *
 * The functions here are intentionally side-effect free so they can be
 * unit-tested without a terminal or pane harness:
 * - `renderMarkdown()` — core renderer (NOTE markers always rendered as
 *   links; optional YAML frontmatter skip for file bodies).
 * - `renderMarkdownViewer()` — formats a markdown file body as terminal
 *   lines with YAML frontmatter skipped.
 * - `renderNoteLinks()` — rewrites inline `[NOTE <id>: ...]` markers into a
 *   link representation (id + "↗" indicator) and returns the note ids.
 */

import { lexer, type Token, type Tokens } from 'marked';

// ── NOTE-marker handling ──────────────────────────────────────────────

/**
 * Compiled regex for inline `[NOTE <id>: ...]` review-note markers (PRD §7.1).
 * `<id>` is a Worklog note-child id (e.g. OSL-0MSG7Y0C6005QFES); the note
 * text runs to the first `]` and may span multiple lines. DONE variants
 * (`[NOTE <id>: DONE ...]`) match the same pattern.
 */
export const NOTE_MARKER_RE = /\[NOTE\s+([A-Za-z0-9-]+):.*?\]/gs;

/**
 * Extract the note work-item ids from inline `[NOTE <id>: ...]` markers.
 *
 * @param text - Text that may contain inline NOTE markers.
 * @returns Array of note work-item ids in marker order (no duplicates).
 */
export function extractNoteIds(text: string): string[] {
  if (!text) return [];
  const ids: string[] = [];
  for (const match of text.matchAll(NOTE_MARKER_RE)) {
    const id = match[1];
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Render inline `[NOTE <id>: ...]` markers as clickable links.
 *
 * Each marker is replaced with `<id>↗` (the note work-item id plus a link
 * glyph) so the marker is visibly a link to the note child work item. The
 * note text itself is dropped from the rendered line (it is not dialogue).
 *
 * @param text - Text that may contain inline NOTE markers.
 * @returns The text with NOTE markers rendered as `<id>↗` links.
 */
export function renderNoteLinks(text: string): string {
  if (!text) return '';
  return text.replace(NOTE_MARKER_RE, (_marker, id: string) => `${id}↗`);
}

// ── ANSI styling and width helpers ────────────────────────────────────

/** ANSI escape sequences used for terminal markdown rendering. */
const STYLE = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  strike: '\x1b[9m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
} as const;

/** ANSI dim/glyph helpers for viewer output (kept minimal). */
const VIEWER_GLYPHS = {
  headingH1: '██',
  heading: '█',
  headingDeep: '▌',
  bullet: '•',
  code: '│',
  quote: '▌',
  table: '│',
  hr: '─',
} as const;

/** Strip ANSI escape sequences (SGR codes) from a styled string. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Truncate a styled line to at most `maxCols` visible characters, copying
 * ANSI escape sequences through and closing any open styling at the end.
 */
function truncateAnsi(line: string, maxCols: number): string {
  if (stripAnsi(line).length <= maxCols) return line;
  let result = '';
  let vis = 0;
  let i = 0;
  while (vis < maxCols && i < line.length) {
    if (line[i] === '\x1b' && line[i + 1] === '[') {
      const end = line.indexOf('m', i);
      if (end >= 0) {
        result += line.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    result += line[i];
    vis += 1;
    i += 1;
  }
  return `${result}${STYLE.reset}`;
}

/**
 * Word-wrap a styled string to at most `maxCols` visible characters per
 * line, honouring ANSI sequences for width. Words longer than `maxCols`
 * are truncated (with open styling closed) so a single line never exceeds
 * the terminal width.
 */
function wrapText(text: string, maxCols: number): string[] {
  if (maxCols <= 0) return [text];
  const out: string[] = [];
  let cur = '';
  let curPlain = 0;
  for (const word of text.split(/\s+/)) {
    if (word === '') continue;
    const wordPlain = stripAnsi(word).length;
    if (cur && curPlain + 1 + wordPlain > maxCols) {
      out.push(cur);
      cur = '';
      curPlain = 0;
    }
    if (wordPlain > maxCols) {
      if (cur) {
        out.push(cur);
        cur = '';
        curPlain = 0;
      }
      out.push(truncateAnsi(word, maxCols));
      continue;
    }
    if (cur) {
      cur += ' ';
      curPlain += 1;
    }
    cur += word;
    curPlain += wordPlain;
  }
  if (cur) out.push(cur);
  return out.length > 0 ? out : [''];
}

// ── Inline token rendering ────────────────────────────────────────────

/**
 * Render a list of inline tokens to an ANSI-styled string.
 *
 * @param tokens - Inline tokens (from a paragraph/heading/table cell/...).
 * @returns Styled text; embedded `\n` (hard line breaks) are preserved.
 */
function renderInline(tokens: Token[]): string {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'text':
      case 'escape':
        out += tok.text;
        break;
      case 'strong':
        out += `${STYLE.bold}${renderInline(tok.tokens ?? [])}${STYLE.reset}`;
        break;
      case 'em':
        out += `${STYLE.italic}${renderInline(tok.tokens ?? [])}${STYLE.reset}`;
        break;
      case 'del':
        out += `${STYLE.strike}${renderInline(tok.tokens ?? [])}${STYLE.reset}`;
        break;
      case 'codespan':
        out += `\`${STYLE.cyan}${tok.text}${STYLE.reset}\``;
        break;
      case 'link': {
        const label = renderInline(tok.tokens ?? []);
        out += `${STYLE.underline}${STYLE.blue}${label}${STYLE.reset}`;
        if (tok.href && tok.href !== label) {
          out += `${STYLE.dim} (${tok.href})${STYLE.reset}`;
        }
        break;
      }
      case 'image':
        out += `${STYLE.dim}[image: ${tok.text}]${STYLE.reset}`;
        break;
      case 'checkbox':
        out += tok.checked ? '[x]' : '[ ]';
        break;
      case 'br':
        out += '\n';
        break;
      case 'html':
        // Raw inline HTML tags are not rendered; strip them so the text
        // content (if any) still shows.
        out += tok.text.replace(/<[^>]*>/g, '');
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * Inline children of a token, or the token itself as a single inline
 * token when it carries no children (e.g. block-level `text` tokens from
 * tight list items keep their inline-parsed children in `tokens`).
 */
function inlineChildren(tok: Token): Token[] {
  return 'tokens' in tok && Array.isArray(tok.tokens) && tok.tokens.length > 0
    ? tok.tokens
    : [tok];
}

// ── Block token rendering ─────────────────────────────────────────────

/** Heading glyph per ATX depth: h1 = `██`, h2 = `█`, h3+ = `▌`. */
function headingGlyph(depth: number): string {
  if (depth <= 1) return VIEWER_GLYPHS.headingH1;
  if (depth === 2) return VIEWER_GLYPHS.heading;
  return VIEWER_GLYPHS.headingDeep;
}

/** Render a GFM table as aligned terminal columns. */
function renderTable(tok: Tokens.Table, pad: string): string[] {
  const renderCell = (cell: Tokens.TableCell, header: boolean): { styled: string; plain: string } => {
    const text = renderInline(cell.tokens);
    const styled = header ? `${STYLE.bold}${text}${STYLE.reset}` : text;
    return { styled, plain: stripAnsi(styled) };
  };
  const header = tok.header.map(c => renderCell(c, true));
  const rows = tok.rows.map(r => r.map(c => renderCell(c, false)));

  // Column widths from the visible (ANSI-stripped) text.
  const widths = tok.header.map((_c, col) => {
    let w = header[col]?.plain.length ?? 0;
    for (const row of rows) w = Math.max(w, row[col]?.plain.length ?? 0);
    return w;
  });

  const padCell = (cell: { styled: string; plain: string }, width: number, align: 'center' | 'left' | 'right' | null): string => {
    const diff = width - cell.plain.length;
    let left = 0;
    let right = diff;
    if (align === 'center') {
      left = Math.floor(diff / 2);
      right = Math.ceil(diff / 2);
    } else if (align === 'right') {
      left = diff;
      right = 0;
    }
    return `${' '.repeat(left)}${cell.styled}${' '.repeat(right)}`;
  };

  const renderRow = (cells: { styled: string; plain: string }[]): string =>
    `${VIEWER_GLYPHS.table}${cells.map((c, i) => ` ${padCell(c, widths[i], tok.align[i] ?? null)} `).join(VIEWER_GLYPHS.table)}${VIEWER_GLYPHS.table}`;

  const lines: string[] = [];
  lines.push(pad + renderRow(header));
  lines.push(pad + `├${widths.map(w => `${VIEWER_GLYPHS.hr.repeat(w + 2)}`).join('┼')}┤`);
  for (const row of rows) lines.push(pad + renderRow(row));
  return lines;
}

/**
 * Render a block-level token list to terminal lines.
 *
 * @param tokens - Block tokens (from `marked.lexer`).
 * @param pad - Indentation prefix applied to every emitted line.
 * @param maxCols - Terminal width used for word-wrapping/truncation.
 * @returns Terminal lines (styled, no trailing padding).
 */
function renderBlocks(tokens: Token[], pad: string, maxCols: number): string[] {
  const lines: string[] = [];
  /** Push inline-rendered text as wrapped, padded lines. */
  const pushWrapped = (text: string): void => {
    for (const seg of text.split('\n')) {
      for (const l of wrapText(seg, maxCols - pad.length)) lines.push(`${pad}${l}`);
    }
  };
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space':
        // A blank source line renders as a blank viewer line (deduped).
        if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
        break;
      case 'heading': {
        const t = tok as Tokens.Heading;
        const text = renderInline(t.tokens ?? []);
        const style = t.depth <= 2 ? STYLE.bold : `${STYLE.bold}${STYLE.dim}`;
        lines.push(`${pad}${headingGlyph(t.depth)} ${style}${text}${STYLE.reset}`);
        break;
      }
      case 'paragraph':
        pushWrapped(renderInline(tok.tokens ?? []));
        break;
      case 'text':
        pushWrapped(renderInline(inlineChildren(tok)));
        break;
      case 'list': {
        const list = tok as Tokens.List;
        list.items.forEach((item, idx) => {
          const marker = list.ordered
            ? `${(list.start === '' ? 1 : Number(list.start)) + idx}.`
            : VIEWER_GLYPHS.bullet;
          const prefix = `${marker} `;
          const contentPad = `${pad}${' '.repeat(prefix.length)}`;
          const itemLines = renderBlocks(item.tokens, contentPad, maxCols);
          if (itemLines.length === 0) {
            lines.push(`${pad}${prefix}`);
            return;
          }
          lines.push(`${pad}${prefix}${itemLines[0].slice(contentPad.length)}`);
          lines.push(...itemLines.slice(1));
        });
        break;
      }
      case 'code':
        for (const line of tok.text.split('\n')) {
          lines.push(`${pad} ${VIEWER_GLYPHS.code} ${line}`);
        }
        break;
      case 'blockquote':
        lines.push(...renderBlocks(tok.tokens ?? [], `${pad}${VIEWER_GLYPHS.quote} `, maxCols));
        break;
      case 'table':
        lines.push(...renderTable(tok as Tokens.Table, pad));
        break;
      case 'hr': {
        const width = Math.min(30, Math.max(1, maxCols - pad.length));
        lines.push(`${pad}${VIEWER_GLYPHS.hr.repeat(width)}`);
        break;
      }
      case 'html':
        lines.push(`${pad}${tok.text.replace(/<[^>]*>/g, '').trim()}`);
        break;
      case 'def':
        break; // definition links are consumed by the linker — nothing to show
      default:
        break;
    }
  }
  return lines;
}

// ── Markdown rendering entry points ───────────────────────────────────

/** Leading YAML frontmatter block (`---` delimited at the start of file). */
const YAML_FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/** Strip a leading YAML frontmatter block, if present. */
function stripYamlFrontmatter(text: string): string {
  const match = text.match(YAML_FRONTMATTER_RE);
  return match ? text.slice(match[0].length) : text;
}

export interface RenderMarkdownOptions {
  /** Skip a leading YAML frontmatter block (`---` delimited). */
  skipFrontmatter?: boolean;
}

/**
 * Render markdown text as ANSI-styled terminal viewer lines.
 *
 * Inline `[NOTE <id>: ...]` markers are always rendered as `<id>↗` links
 * (see `renderNoteLinks`). Renders the full GFM construct set used in
 * `.podcast.md` episode files and work-item descriptions: heading
 * hierarchy, ordered + nested bullet lists, blockquotes, tables, fenced
 * and inline code, bold/italic/strikethrough, links, and horizontal rules.
 *
 * Fail-open: on a parse error the raw text is returned as plain lines so
 * the viewer never crashes on unexpected input.
 *
 * @param mdText - Raw markdown document text.
 * @param maxCols - Terminal width to wrap/truncate lines to.
 * @param opts - Rendering options.
 * @returns Viewer lines (no trailing padding; callers pad to viewport).
 */
export function renderMarkdown(mdText: string, maxCols: number, opts: RenderMarkdownOptions = {}): string[] {
  if (!mdText) return [];
  let text = renderNoteLinks(mdText);
  if (opts.skipFrontmatter) text = stripYamlFrontmatter(text);
  try {
    const tokens = lexer(text);
    const lines = renderBlocks(tokens, '', maxCols);
    return lines.map(l => truncateAnsi(l, maxCols));
  } catch {
    // Fail-open: never crash the viewer on malformed markdown.
    return text.split('\n').map(l => truncateAnsi(l, maxCols));
  }
}

/**
 * Render a markdown document body as terminal viewer lines.
 *
 * YAML frontmatter (`---`-delimited, leading) is skipped; inline
 * `[NOTE <id>: ...]` markers are rendered as `<id>↗` links.
 *
 * @param mdText - Raw markdown document text.
 * @param maxCols - Terminal width to wrap/truncate lines to.
 * @returns Viewer lines (no trailing padding; callers pad to viewport).
 */
export function renderMarkdownViewer(mdText: string, maxCols: number): string[] {
  return renderMarkdown(mdText, maxCols, { skipFrontmatter: true });
}
