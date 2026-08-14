/**
 * `md-note-edit.ts` — inline note marker editing helpers for the Herdr
 * markdown viewer (WL-0MSKV6SKK008MMXR / PRD §7.1/§7.3).
 *
 * Sibling of `md-viewer.ts` (which stays render-only): this module detects,
 * inserts, updates, and removes inline `[NOTE <id>: ...]` markers on
 * paragraphs, splits documents into paragraph blocks, maps viewer cursors
 * to paragraphs, resolves the episode work-item id for podcast scripts,
 * and (via dependency-injected `wl` CLI helpers) drives the PRD §7.3
 * note-child lifecycle.
 *
 * All helpers are pure with respect to the document text: edits are
 * surgical paragraph-level replacements, so every other byte of the file
 * is preserved.  The `wl` CLI helpers take their exec function through the
 * fetcher's injectable `setExecFileAsync`/`getExecFileAsync` seam so tests
 * can mock the CLI without spawning processes.
 *
 * Marker format (unchanged from `md-viewer.ts`): `[NOTE <id>: ...]` where
 * `<id>` is a Worklog note-child id (or a `LOCAL-<seq>` placeholder) and
 * the note text runs to the first `]` and may span multiple lines.
 * Resolved notes use the PRD §7.3 addressed form `[NOTE <id>: DONE ...]`.
 */

import { NOTE_MARKER_RE as MD_VIEWER_NOTE_RE } from './md-viewer.js';
import type { WorkItem } from './fetcher.js';
import { buildWlArgs, getExecFileAsync } from './fetcher.js';

// ── NOTE marker regex (stateless wrapper) ─────────────────────────────

/**
 * The NOTE-marker regex, exported for callers that need to match markers
 * directly.  Wraps `md-viewer.ts`'s `NOTE_MARKER_RE` (same source and
 * flags) in a subclass that resets `lastIndex` before each `test()` so
 * sequential assertions behave deterministically (the plain `/g` regex is
 * stateful across `test()` calls).
 */
export class NoteMarkerRe extends RegExp {
  constructor() {
    super(MD_VIEWER_NOTE_RE.source, MD_VIEWER_NOTE_RE.flags);
  }

  override test(input: string): boolean {
    this.lastIndex = 0;
    return super.test(input);
  }
}

export const NOTE_MARKER_RE: RegExp = new NoteMarkerRe();

// ── Types ─────────────────────────────────────────────────────────────

/** A parsed inline note marker. */
export interface NoteMarker {
  id: string;
  body: string;
  done: boolean;
}

/** Result of a document edit: the new document plus metadata. */
export interface NoteEditResult {
  doc: string;
  /** Offset of the inserted/updated/removed marker (or -1 when no-op). */
  byteOffset: number;
  /** The note id written into the marker (insert only). */
  newNoteId?: string;
  /** Set when the operation could not fully sync (e.g. no episode). */
  warning?: string;
}

/** A paragraph block from `splitParagraphs`. */
export interface ParagraphBlock {
  /** 0-based doc line index of the first line of the block. */
  startLine: number;
  /** 0-based doc line index of the last line of the block. */
  endLine: number;
  /** The block's text (lines joined with `\n`, no blank separators). */
  text: string;
}

// ── findNoteInParagraph ───────────────────────────────────────────────

/**
 * Find the first inline note marker in a paragraph's text.
 *
 * @param text - Paragraph text that may contain a `[NOTE <id>: ...]`
 *   marker (PRD §7.1), including `DONE` variants (§7.3) and multi-line
 *   bodies.
 * @returns The marker's id, body, and done flag, or `null` when the text
 *   carries no marker.
 */
export function findNoteInParagraph(text: string): NoteMarker | null {
  if (!text) return null;
  const re = new NoteMarkerRe();
  const match = re.exec(text);
  if (!match) return null;
  const id = match[1];
  // Body is everything after the first ': ' up to the closing ']'.
  const colonIndex = match[0].indexOf(':');
  let body = match[0].slice(colonIndex + 1, -1).trim();
  let done = false;
  if (body.startsWith('DONE ')) {
    done = true;
    body = body.slice('DONE '.length).trim();
  } else if (body === 'DONE') {
    done = true;
    body = '';
  }
  return { id, body, done };
}

// ── Paragraph splitting and cursor mapping ────────────────────────────

/** Leading YAML frontmatter block (`---` delimited at the start of file). */
const YAML_FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/**
 * Split a document into paragraph blocks separated by blank lines.
 *
 * A leading YAML frontmatter block is skipped (viewer convention), but its
 * line count is carried into the reported `startLine`/`endLine` so those
 * stay doc-relative (usable for byte-offset math).  A "paragraph" is one
 * or more consecutive non-blank lines.
 *
 * @param doc - Full document text.
 * @returns Array of paragraph blocks in document order.
 */
export function splitParagraphs(doc: string): ParagraphBlock[] {
  if (!doc) return [];
  const fmMatch = doc.match(YAML_FRONTMATTER_RE);
  const body = fmMatch ? doc.slice(fmMatch[0].length) : doc;
  const fmLines = fmMatch ? (fmMatch[0].match(/\n/g)?.length ?? 0) : 0;
  const lines = body.split('\n');
  const blocks: ParagraphBlock[] = [];
  let current: ParagraphBlock | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      current = null;
      continue;
    }
    const docLine = fmLines + i;
    if (current === null) {
      current = { startLine: docLine, endLine: docLine, text: line };
      blocks.push(current);
    } else {
      current.endLine = docLine;
      current.text = `${current.text}\n${line}`;
    }
  }
  return blocks;
}

/**
 * Map a source cursor line to the paragraph block containing it.
 *
 * Blank lines map to the nearest preceding paragraph.  Out-of-range and
 * empty documents return -1.
 *
 * @param doc - Full document text.
 * @param cursorLine - 0-based source line index of the cursor.
 * @returns The paragraph index, or -1 when the cursor is out of bounds.
 */
export function mapCursorToParagraph(doc: string, cursorLine: number): number {
  if (!doc || cursorLine < 0) return -1;
  const blocks = splitParagraphs(doc);
  if (blocks.length === 0) return -1;
  const lastLine = doc.split('\n').length - 1;
  if (cursorLine > lastLine) return -1;
  let paragraph = -1;
  for (let i = 0; i < blocks.length; i++) {
    if (cursorLine < blocks[i].startLine) break;
    paragraph = i;
  }
  return paragraph;
}

/**
 * Locate the note marker carried by a specific paragraph.
 *
 * @param doc - Full document text.
 * @param paragraphIndex - Index into `splitParagraphs(doc)`.
 * @returns The marker info plus the paragraph index, or `null` when the
 *   paragraph carries no marker (or the index is out of range).
 */
export function mapParagraphToMarker(
  doc: string,
  paragraphIndex: number,
): { markerIndex: number; noteId: string } | null {
  const blocks = splitParagraphs(doc);
  if (paragraphIndex < 0 || paragraphIndex >= blocks.length) return null;
  const marker = findNoteInParagraph(blocks[paragraphIndex].text);
  if (!marker) return null;
  return { markerIndex: paragraphIndex, noteId: marker.id };
}

// ── Local placeholder ids ─────────────────────────────────────────────

/**
 * Deterministic local placeholder note id for a paragraph.
 *
 * Generic markdown documents (no resolvable episode) use the documented
 * `LOCAL-<seq>` scheme: a stable hash of the document text plus the
 * paragraph index, so the same paragraph in an unchanged document gets the
 * same id across re-opens.
 *
 * @param paragraphIndex - Index of the paragraph in `splitParagraphs(doc)`.
 * @param doc - Full document text.
 * @returns A `LOCAL-<hex>` id.
 */
export function localNoteId(paragraphIndex: number, doc: string): string {
  // FNV-1a over "<doc>\u0000<index>".
  let hash = 0x811c9dc5;
  const input = `${doc}\u0000${paragraphIndex}`;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `LOCAL-${hash.toString(16)}`;
}

// ── Byte offsets ──────────────────────────────────────────────────────

/** Byte offset (char index) of a paragraph block's first character. */
function offsetOfBlock(doc: string, paragraphIndex: number): number {
  const blocks = splitParagraphs(doc);
  const block = blocks[paragraphIndex];
  const lines = doc.split('\n');
  let offset = 0;
  for (let i = 0; i < block.startLine; i++) {
    offset += lines[i].length + 1; // +1 for the '\n'
  }
  return offset;
}

/** Find the span of the first marker with the given id, or null. */
function findMarkerSpan(doc: string, noteId: string): { start: number; len: number } | null {
  const re = new NoteMarkerRe();
  let match: RegExpExecArray | null;
  while ((match = re.exec(doc)) !== null) {
    if (match[1] === noteId) return { start: match.index, len: match[0].length };
  }
  return null;
}

// ── insertNoteMarker ──────────────────────────────────────────────────

/**
 * Insert a `[NOTE <id>: ...]` marker at the start of a paragraph.
 *
 * When the paragraph already carries a marker, the existing marker is
 * replaced in place with the new body, keeping its id (exactly one marker
 * per paragraph; the viewer routes add vs edit modes, but the helper stays
 * deterministic).  The marker's id is the given `idOverride` when provided
 * (podcast sync path writes the real note-child id), otherwise a
 * deterministic `LOCAL-<seq>` placeholder.  All other document content is
 * preserved byte-for-byte.
 *
 * @param doc - Full document text.
 * @param paragraphIndex - Index into `splitParagraphs(doc)`.
 * @param text - The note body text.
 * @param idOverride - Optional explicit note id (podcast sync path); when
 *   omitted a `LOCAL-<seq>` id is generated for new markers.
 * @returns The new document, the byte offset of the written marker, and
 *   the note id in the marker.
 */
export function insertNoteMarker(
  doc: string,
  paragraphIndex: number,
  text: string,
  idOverride?: string,
): NoteEditResult {
  const blocks = splitParagraphs(doc);
  if (paragraphIndex < 0 || paragraphIndex >= blocks.length) {
    return { doc, byteOffset: -1, newNoteId: idOverride ?? localNoteId(paragraphIndex, doc) };
  }
  const block = blocks[paragraphIndex];
  const blockOffset = offsetOfBlock(doc, paragraphIndex);
  const existing = findNoteInParagraph(block.text);
  if (existing) {
    // Replace the existing marker in place, keeping its id.  Locate the
    // marker span within THIS block (not an earlier occurrence elsewhere).
    const blockRe = new NoteMarkerRe();
    const match = blockRe.exec(block.text);
    if (!match) return { doc, byteOffset: -1, newNoteId: existing.id };
    const markerStart = blockOffset + match.index;
    const markerText = `[NOTE ${existing.id}: ${text}]`;
    const newDoc = `${doc.slice(0, markerStart)}${markerText}${doc.slice(markerStart + match[0].length)}`;
    return { doc: newDoc, byteOffset: markerStart, newNoteId: existing.id };
  }
  const id = idOverride ?? localNoteId(paragraphIndex, doc);
  const markerText = `[NOTE ${id}: ${text}]`;
  const newDoc = `${doc.slice(0, blockOffset)}${markerText} ${doc.slice(blockOffset)}`;
  return { doc: newDoc, byteOffset: blockOffset, newNoteId: id };
}

// ── updateNoteMarker ──────────────────────────────────────────────────

/**
 * Update the body of a note marker identified by id.
 *
 * When `done` is true the marker is rewritten in the PRD §7.3 addressed
 * form `[NOTE <id>: DONE <text>]`; otherwise `[NOTE <id>: <text>]`.  All
 * content outside the marker is preserved byte-for-byte.
 *
 * @param doc - Full document text.
 * @param noteId - The marker's note id.
 * @param opts - `text` (new body) and optional `done` flag.
 * @returns The new document and the byte offset of the updated marker (or
 *   `-1` when no marker with that id exists).
 */
export function updateNoteMarker(
  doc: string,
  noteId: string,
  opts: { text: string; done?: boolean },
): NoteEditResult {
  const span = findMarkerSpan(doc, noteId);
  if (!span) return { doc, byteOffset: -1 };
  const body = opts.done ? `DONE ${opts.text}` : opts.text;
  const replacement = `[NOTE ${noteId}: ${body}]`;
  const newDoc = `${doc.slice(0, span.start)}${replacement}${doc.slice(span.start + span.len)}`;
  return { doc: newDoc, byteOffset: span.start };
}

// ── removeNoteMarker ──────────────────────────────────────────────────

/**
 * Remove a note marker identified by id.
 *
 * An inline marker is removed leaving the surrounding text intact.  A
 * marker that occupies its own line is removed together with the preceding
 * blank line's newline so the document does not accumulate double blanks.
 * All other content is preserved byte-for-byte.
 *
 * @param doc - Full document text.
 * @param noteId - The marker's note id.
 * @returns The new document and the byte offset of the removed marker (or
 *   `-1` when no marker with that id exists).
 */
export function removeNoteMarker(doc: string, noteId: string): NoteEditResult {
  const span = findMarkerSpan(doc, noteId);
  if (!span) return { doc, byteOffset: -1 };
  const startOfLine = doc.lastIndexOf('\n', span.start - 1) + 1;
  const lineEndIdx = doc.indexOf('\n', span.start + span.len);
  const endOfLine = lineEndIdx === -1 ? doc.length : lineEndIdx;
  const beforeOnLine = doc.slice(startOfLine, span.start).trim();
  const afterOnLine = doc.slice(span.start + span.len, endOfLine).trim();
  let removeStart = span.start;
  let removeEnd = span.start + span.len;
  if (beforeOnLine === '' && afterOnLine === '') {
    // Marker occupies its own line: absorb the preceding blank line and the
    // line's own newline so the document does not accumulate double blanks.
    if (span.start > 0 && doc[span.start - 1] === '\n') removeStart = span.start - 1;
    if (doc[span.start + span.len] === '\n') removeEnd = span.start + span.len + 1;
  }
  const newDoc = `${doc.slice(0, removeStart)}${doc.slice(removeEnd)}`;
  return { doc: newDoc, byteOffset: span.start };
}

// ── Episode id resolution ─────────────────────────────────────────────

/** YAML frontmatter block extractor (leading `---`-delimited block). */
function parseFrontmatter(script: string): Record<string, string> {
  const match = script.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (kv) out[kv[1].trim()] = kv[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

/**
 * Resolve the episode work-item id for a podcast script.
 *
 * Follows the podcast-script skill convention: the episode is taken from
 * the script frontmatter `podcast_title` / `source_doc` fields matched
 * against the title (or id) of the given work items.
 *
 * @param script - Full podcast script text.
 * @param items - Candidate episode work items.
 * @returns The episode work-item id, or `null` when unresolvable.
 */
export function resolveEpisodeId(script: string, items: WorkItem[]): string | null {
  if (!script || items.length === 0) return null;
  const fm = parseFrontmatter(script);
  const value = fm.podcast_title ?? fm.source_doc;
  if (!value) return null;
  const item = items.find((i) => i.title === value || i.id === value);
  return item?.id ?? null;
}

// ── Note-child sync helpers (mocked-wl testable) ──────────────────────

/**
 * Create a note-child work item under an episode (`wl create --parent`).
 *
 * Runs `wl` through the fetcher's injectable exec seam (`setExecFileAsync`
 * / `getExecFileAsync`) so tests can mock the CLI.
 *
 * @param episodeId - Parent episode work-item id.
 * @param noteText - The note body (used as the child's title).
 * @returns The created note-child work-item id.
 */
export async function createNoteChild(episodeId: string, noteText: string): Promise<string> {
  const execFileAsync = getExecFileAsync();
  const args = buildWlArgs(['create', '--parent', episodeId, '--json', '--title', noteText]);
  const result = await execFileAsync('wl', args);
  const parsed = JSON.parse(result.stdout) as { workItem?: { id?: string } };
  const id = parsed?.workItem?.id;
  if (!id) throw new Error(`wl create returned no work item id: ${result.stdout}`);
  return id;
}

/**
 * Post a resolution comment on a note child (`wl comment add`).
 *
 * @param noteId - The note-child work-item id.
 * @param comment - The resolution comment text (PRD §7.3).
 */
export async function commentOnNote(noteId: string, comment: string): Promise<void> {
  const execFileAsync = getExecFileAsync();
  const args = buildWlArgs(['comment', 'add', noteId, '--comment', comment, '--json']);
  await execFileAsync('wl', args);
}

/**
 * Add a note with note-child sync (podcast path).
 *
 * When the document resolves to an episode work item, a note child is
 * created via `wl create --parent <episode>` and the real note-child id is
 * written into the marker.  When the episode cannot be resolved, a
 * `LOCAL-<seq>` placeholder id is used and a prominent `warning` is
 * returned — note recording is never silently skipped.
 *
 * @param doc - Full document text.
 * @param paragraphIndex - Index into `splitParagraphs(doc)`.
 * @param text - The note body text.
 * @param items - Candidate episode work items for resolution.
 */
export async function addNoteWithSync(
  doc: string,
  paragraphIndex: number,
  text: string,
  items: WorkItem[],
): Promise<NoteEditResult> {
  const episodeId = resolveEpisodeId(doc, items);
  if (episodeId) {
    const noteId = await createNoteChild(episodeId, text);
    return insertNoteMarker(doc, paragraphIndex, text, noteId);
  }
  const result = insertNoteMarker(doc, paragraphIndex, text);
  return {
    ...result,
    warning:
      `Episode work item not resolvable from script frontmatter — inserted local ` +
      `placeholder note id ${result.newNoteId} (no wl child created).`,
  };
}

/**
 * Resolve a note with sync (podcast path): mark the marker `DONE` and post
 * a resolution comment on the note child (PRD §7.3).
 *
 * When the marker is absent the document is returned unchanged and no `wl`
 * call is made.
 *
 * @param doc - Full document text.
 * @param noteId - The note-child id carried by the marker.
 * @param resolutionText - The resolution summary (written after `DONE` and
 *   as the comment body).
 * @param _items - Candidate episodes (unused; present for signature
 *   symmetry with `addNoteWithSync`).
 */
export async function resolveNoteWithSync(
  doc: string,
  noteId: string,
  resolutionText: string,
  _items?: WorkItem[],
): Promise<NoteEditResult> {
  const span = findMarkerSpan(doc, noteId);
  if (!span) return { doc, byteOffset: -1 };
  const updated = updateNoteMarker(doc, noteId, { done: true, text: resolutionText });
  await commentOnNote(noteId, resolutionText);
  return updated;
}
