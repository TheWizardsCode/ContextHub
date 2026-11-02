/**
 * packages/herdr/src/worklist.detail.ts — the detail view's content and the
 * markdown Key Files viewer.
 *
 * Single responsibility: render a work item's detail view — the Related Docs
 * table of contents (`formatDetailToC`), the full unpadded content
 * (`formatDetailContent`, whose header height is `DETAIL_HEADER_LINES`) and
 * the Key Files markdown viewer (`renderFileViewer` + `firstMarkdownKeyFile`).
 * No list state, no scrolling, no input handling. Imports the metadata row
 * builders from `worklist.meta.ts` and formatting from `worklist.format.ts`
 * (parent WL-0MVGKGD2Y0038S6B AC4 — one-way edges, no barrel imports, no new
 * cycles).
 *
 * Moved verbatim out of `worklist.ts` (parent WL-0MVGKGD2Y0038S6B; extraction
 * WL-0MVND6F9V004IQ3V). Move-only: no logic or rendered-output change.
 */

import type { BlockerRef, WorkItem } from './fetcher.js';
import { extractFilePaths } from './grouping.js';
import { renderMarkdown, renderMarkdownViewer } from './md-viewer.js';
import { ANSI } from './worklist.constants.js';
import { truncateLine, formatTitleWithAssignee } from './worklist.format.js';
import { buildMetaRows, formatBlockerValue, pairMetaRows } from './worklist.meta.js';

/**
 * Build the Related Docs Table of Contents (ToC) lines for the detail view
 * (WL-0MSHWHULZ001FL8I).
 *
 * Lists every `.md` Key File of the item, numbered, with a focus indicator
 * (`▸`) on the selected entry. Returns [] when the item has no `.md` Key
 * Files so the detail view renders exactly as before.
 *
 * @param item - Work item whose `Key Files:` section is scanned.
 * @param maxCols - Terminal width.
 * @param detailToCIndex - Selected ToC entry (0-based).
 * @param detailToCFocus - Whether keyboard focus is on the ToC (unused for
 *   rendering; kept for parity with the state and future dimming).
 * @param noIcons - Icons gated off (focus indicator is a plain text marker).
 * @returns ToC lines, or [] when the item has no `.md` Key Files.
 */
export function formatDetailToC(
  item: WorkItem | null,
  maxCols: number,
  detailToCIndex = 0,
  detailToCFocus = true,
  noIcons = false,
): string[] {
  if (!item) return [];
  const mdPaths = extractFilePaths(item.description ?? '').filter(p => p.endsWith('.md'));
  if (mdPaths.length === 0) return [];

  const lines: string[] = [];
  lines.push('');
  lines.push(` ${ANSI.underline}Related Docs${ANSI.reset}`);
  lines.push('');
  mdPaths.forEach((path, i) => {
    const marker = i === detailToCIndex ? '▸' : ' ';
    lines.push(` ${marker} ${i + 1}. ${path}`);
  });
  lines.push('');
  return lines;
}

/**
 * Build the full content lines for a detail view (without scrolling).
 * Returns an array of lines ready for viewport rendering.
 *
 * Metadata section includes: Status, Priority, Stage, Type, Risk, Effort,
 * Children, Tags, GitHub Issue (number), Created, Updated, Audit
 * (auditResult icon + text label), and Audited At (ISO timestamp). Rendered as a markdown
 * table; icon-bearing values are `icon + text` via the shared
 * {@link buildMetaRows} (WL-0MSGIXHHI009KFW9). ID and Title are shown in
 * the header (from the shared {@link buildMetaRows} set they are omitted
 * from the table to avoid duplication).
 *
 * `Blocked By` rows (WL-0MVBMLY2Z0032CYR): the detail view renders the
 * SAME active blockers the selection-list metadata panel shows — one row
 * per blocker (`<id> — <title> <status-icon> <status>`) appended to the
 * metadata table, reversing the documented divergence (WL-0MV8Q5X8U004KKAP
 * AC-5). The rows arrive pre-resolved from the render loop via the same
 * single-flight + signature-keyed cache as the preview, so the detail view
 * never spawns an uncoordinated async lookup and cannot re-open the
 * WL-0MV8Q5X8U004KKAP flicker class; an expired/failed lookup simply
 * passes no rows (fail-open).
 */
export function formatDetailContent(
  item: WorkItem | null,
  maxCols: number,
  readFile?: (filePath: string) => string | null,
  noIcons = false,
  detailToCIndex = 0,
  detailToCFocus = true,
  detailRenderedIndex = 0,
  blockedBy?: BlockerRef[] | null,
): string[] {
  if (!item) return [];

  const lines: string[] = [];
  const contentWidth = maxCols - 2;
  const separator = '─'.repeat(Math.min(contentWidth, 72));

  // Header — the title carries the shared `[assignee] ` prefix
  // (WL-0MVTPEB3A0091RDH AC2), so a producer hold or agent claim is visible
  // without opening the metadata table.
  lines.push('');
  lines.push(` ${item.id}`);
  lines.push(` ${ANSI.bold}${formatTitleWithAssignee(item.title, item.assignee)}${ANSI.reset}`);
  lines.push(separator);

  // Related Docs ToC — pinned at the top of the detail view
  // (WL-0MSHWHULZ001FL8I).
  lines.push(...formatDetailToC(item, maxCols, detailToCIndex, detailToCFocus, noIcons));

  // Metadata — rendered as a markdown table (shared row builder; ID and
  // Title are already shown in the header above, so they are filtered out
  // here to avoid duplicating them). Apply compound row pairing for a
  // more compact display (WL-0MSNIX4V60012266).
  const metaRows = pairMetaRows(
    buildMetaRows(item, noIcons).filter(([label]) => label !== 'ID' && label !== 'Title'),
  );
  // `Blocked By` rows (WL-0MVBMLY2Z0032CYR) — one row per ACTIVE blocker
  // after the metadata table, mirroring the selection-list preview:
  // ``<id> — <title>`` plus the blocker's status (icon + text) when the
  // edge carries one. Omitted entirely when there are none, so an
  // unblocked item's detail view is unchanged.
  for (const blocker of blockedBy ?? []) {
    if (!blocker || !blocker.id) continue;
    metaRows.push(['Blocked By', formatBlockerValue(blocker, noIcons)]);
  }

  // Render the metadata as a markdown table
  if (metaRows.length > 0) {
    const fieldWidth = Math.max(...metaRows.map(([l]) => l.length), 6);
    for (const [label, value] of metaRows) {
      lines.push(`| ${label.padEnd(fieldWidth)} | ${value} |`);
    }
  }

  lines.push(separator);

  // Description
  if (item.description) {
    lines.push('');
    lines.push(` ${ANSI.underline}Description${ANSI.reset}`);
    lines.push('');
    // Render the description as GFM (tables, bold/italic, inline code,
    // links, lists, headings) via the shared markdown renderer; NOTE
    // markers render as `<id>↗` links inside the rendered output. Wrap to
    // the content width minus the 2-space indent.
    const indent = 2;
    const wrapWidth = contentWidth - indent - 2;
    const descLines = renderMarkdown(item.description, Math.max(wrapWidth, 20));
    for (const dl of descLines) {
      lines.push(`  ${dl}`);
      // Limit total lines
      if (lines.length > 500) {
        lines.push(`  ... (truncated, ${item.description.split('\n').length} total description lines)`);
        break;
      }
    }
  }

  // Generic md-document viewer for a Key Files: .podcast.md episode file
  // (any .md Key File). When a readFile callback is provided and the item
  // references a readable .md file, render it in place of the raw
  // description so the producer sees the paragraph-format episode.
  // Inline-note markers can be edited from the viewer via the n,e / n,d
  // chords (WL-0MSKV6SKK008MMXR). Renders the file at detailRenderedIndex
  // (default 0 = first file, the existing auto-render); Enter on a ToC
  // entry selects another file
  // (WL-0MSHWHULZ001FL8I).
  if (readFile) {
    const mdPaths = extractFilePaths(item.description ?? '').filter(p => p.endsWith('.md'));
    const mdPath = mdPaths[detailRenderedIndex] ?? mdPaths[0];
    const mdViewerLines = renderFileViewer(item, maxCols, readFile, mdPath);
    if (mdViewerLines.length > 0) {
      lines.push('');
      lines.push(` ${ANSI.underline}Episode file (md viewer)${ANSI.reset}`);
      lines.push('');
      lines.push(...mdViewerLines);
    }
  }

  // Ensure every line fits within the terminal width
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > 0) {
      lines[i] = truncateLine(lines[i], maxCols);
    }
  }

  lines.push(separator);
  lines.push(` ${ANSI.dim}[↑↓/j:k] scroll  [g/G] top/bot  [esc] back  [q] quit  [click] select  [dbl-click] open  [wheel] scroll${ANSI.reset}`);

  return lines;
}

/**
 * Render a Key Files: .md document (e.g. an episode .podcast.md) for the
 * detail view via the generic markdown viewer.
 *
 * @param item - The work item whose description carries a `Key Files:` path.
 * @param maxCols - Terminal width.
 * @param readFile - Synchronous file reader (path -> content or null).
 * @param mdPath - Optional explicit .md path to render. When omitted,
 *   falls back to the first .md Key File (existing auto-render behavior).
 * @returns Viewer lines, or [] when no readable .md file is referenced.
 */
export function renderFileViewer(
  item: WorkItem | null,
  maxCols: number,
  readFile: (filePath: string) => string | null,
  mdPath?: string,
): string[] {
  if (!item) return [];
  const path = mdPath ?? firstMarkdownKeyFile(item.description);
  if (!path) return [];
  const content = readFile(path);
  if (content == null) return [];
  return renderMarkdownViewer(content, maxCols);
}

/**
 * Return the first `Key Files:` path ending in `.md` (or empty).
 *
 * Mirrors the `Key Files:` convention used by Worklog descriptions; the
 * plugin's `extractFilePaths` in grouping.ts provides the full list, and
 * this helper picks the first markdown document among them.
 */
export function firstMarkdownKeyFile(description: string | undefined): string {
  if (!description) return '';
  const paths = extractFilePaths(description);
  const md = paths.find(p => p.endsWith('.md'));
  return md ?? '';
}

/** Fixed height of the detail-view header block (blank, id, title, separator). */
export const DETAIL_HEADER_LINES = 4;
