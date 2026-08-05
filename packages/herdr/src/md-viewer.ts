/**
 * packages/herdr/src/md-viewer.ts — Generic markdown document viewer helpers
 * for the Herdr worklist-selection-list plugin.
 *
 * Pure, dependency-free rendering helpers used to preview an episode file
 * (opened from a work item's `Key Files:`) in a viewer pane, and to render
 * inline `[NOTE <id>: ...]` markers (PRD §7.1) as clickable links to the
 * note work items (operator decision: marker-as-link rendering is required).
 *
 * The functions here are intentionally minimal and side-effect free so they
 * can be unit-tested without a terminal or pane harness:
 * - `renderMarkdownViewer()` — formats a markdown file body as terminal
 *   lines (paragraphs, headings, lists, fenced code blocks) with NOTE
 *   markers rendered as links.
 * - `renderNoteLinks()` — rewrites inline `[NOTE <id>: ...]` markers into a
 *   link representation (id + "↗" indicator) and returns the note ids.
 */

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

// ── Markdown viewer rendering ─────────────────────────────────────────

/** ANSI dim/glyph helpers for viewer output (kept minimal). */
const VIEWER_GLYPHS = {
  heading: '█',
  bullet: '•',
  code: '│',
} as const;

/**
 * Render a markdown document body as terminal viewer lines.
 *
 * Supports the constructs used in `.podcast.md` episode files and work-item
 * descriptions: ATX headings (`#`…`######`), bullet lists, fenced code
 * blocks, blank-line-separated paragraphs, and inline `[NOTE <id>: ...]`
 * markers (rendered as links, see `renderNoteLinks`). YAML frontmatter
 * (`---`-delimited) is skipped.
 *
 * @param mdText - Raw markdown document text.
 * @param maxCols - Terminal width to wrap/truncate lines to.
 * @returns Viewer lines (no trailing padding; callers pad to viewport).
 */
export function renderMarkdownViewer(mdText: string, maxCols: number): string[] {
  if (!mdText) return [];

  const rawLines = mdText.split('\n');
  const lines: string[] = [];
  let inFrontmatter = false;
  let inCodeBlock = false;
  let sawFrontmatterClose = false;

  for (const raw of rawLines) {
    const line = raw.trimEnd();

    // YAML frontmatter: skip everything between a leading `---` and its close.
    if (!inFrontmatter && !sawFrontmatterClose && line.trim() === '---') {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (line.trim() === '---') {
        inFrontmatter = false;
        sawFrontmatterClose = true;
      }
      continue;
    }

    // Fenced code blocks.
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      lines.push('');
      continue;
    }
    if (inCodeBlock) {
      lines.push(` ${VIEWER_GLYPHS.code} ${renderNoteLinks(line)}`);
      continue;
    }

    const trimmed = line.trim();

    // ATX headings.
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      lines.push(`${VIEWER_GLYPHS.heading} ${renderNoteLinks(heading[2])}`);
      continue;
    }

    // Bullet lists.
    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      lines.push(` ${VIEWER_GLYPHS.bullet} ${renderNoteLinks(bullet[1])}`);
      continue;
    }

    // Blank line → blank viewer line.
    if (trimmed === '') {
      lines.push('');
      continue;
    }

    // Plain paragraph line.
    lines.push(` ${renderNoteLinks(line)}`);
  }

  // Wrap/truncate to maxCols.
  return lines.map(l => (l.length > maxCols ? l.slice(0, maxCols) : l));
}
