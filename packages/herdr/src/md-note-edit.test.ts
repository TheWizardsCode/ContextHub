/**
 * Unit tests for `md-note-edit.ts` — inline note marker editing in the
 * Herdr markdown viewer (WL-0MSKV6SKK008MMXR / PRD §7.1/§7.3).
 *
 * **Red-phase** test commit for child #1.  These tests pin the public API
 * contract of the *future* `md-note-edit.ts` module; the module does not
 * exist yet, so this file fails to load (verified red) and turns GREEN as
 * children #2 (marker helpers), #4 (note-child sync) land.
 *
 * Mocked `wl` CLI: the sync helpers (`createNoteChild`, `commentOnNote`,
 * `addNoteWithSync`, `resolveNoteWithSync`) run `wl` through the fetcher's
 * injectable exec seam — tests mock via `setExecFileAsync()` (same pattern
 * as `worklist-inflight.test.ts`).
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import type { WorkItem } from './fetcher.js';
import { setExecFileAsync, resetExecFileAsync } from './fetcher.js';
import {
  NOTE_MARKER_RE,
  findNoteInParagraph,
  insertNoteMarker,
  updateNoteMarker,
  removeNoteMarker,
  splitParagraphs,
  mapParagraphToMarker,
  mapCursorToParagraph,
  localNoteId,
  resolveEpisodeId,
  createNoteChild,
  commentOnNote,
  addNoteWithSync,
  resolveNoteWithSync,
} from './md-note-edit.js';

// ── Fixtures ──────────────────────────────────────────────────────────

const SAMPLE_DOC = `# Title

Paragraph one with some text.

Paragraph two here.

Paragraph three.`;

const DOC_WITH_MARKER = `# Title

Text [NOTE ABC-123: original note] more text.`;

const DOC_WITH_MARKER_ON_OWN_LINE = `# Title

Paragraph one.

[NOTE XYZ-789: note on own line]

Paragraph two.`;

const MULTI_MARKER_DOC = 'a [NOTE AAA: first] b [NOTE BBB: second] c';

const UTF8_DOC = `# Title

UTF-8 content: café naïve 🎵 [NOTE AAA: note with emoji 🚀]

More café.`;

const CRLF_DOC = 'line one\r\n[NOTE AAA: test]\r\nline two\r\n';

/** A real converted paragraph-format episode excerpt (PRD §7.1). */
const EPISODE_MD = `---
pipeline_stage: produced
podcast_title: Episode One
version: "0.2"
---

# Episode One

Nova: We've all been told that training massive language models requires a perfect, uniform grid of top-tier GPUs.

Sorra: It's a fantastic way to frame it. [NOTE OSL-0MSG7Y0C6005QFES: WIKI FACT CHECK: The script was revised.]

- A list item
- Another item
`;

/** A generic (non-podcast) markdown document. */
const GENERIC_MD = `# Meeting Notes

Action item: fix the flaky test [NOTE LOCAL-a1b2c3: investigate flaky suite]

Owner: Alice.`;

function makePodcastItems(): WorkItem[] {
  return [
    {
      id: 'OSL-EP1',
      title: 'Episode One',
      status: 'open',
      stage: 'in_review',
      priority: 'medium',
      description: 'Episode 1 script',
    },
    {
      id: 'OSL-EP2',
      title: 'Episode Two',
      status: 'open',
      stage: 'in_review',
      priority: 'medium',
      description: 'Episode 2 script',
    },
  ];
}

// ── execFileAsync mock (mocked wl CLI) ────────────────────────────────

/** Build a mock execFileAsync that answers `wl create` / `wl comment add`. */
function makeWlMock(createdId = 'OSL-NOTE1'): Mock {
  return vi.fn(async (bin: string, args: string[]) => {
    if (args.includes('create')) {
      return {
        stdout: JSON.stringify({ success: true, workItem: { id: createdId } }),
        stderr: '',
      };
    }
    if (args.includes('comment')) {
      return { stdout: JSON.stringify({ success: true }), stderr: '' };
    }
    return { stdout: JSON.stringify({ success: true }), stderr: '' };
  });
}

beforeEach(() => resetExecFileAsync());
afterEach(() => resetExecFileAsync());

// ── NOTE_MARKER_RE — regex contract ───────────────────────────────────

describe('NOTE_MARKER_RE', () => {
  it('matches a standard NOTE marker', () => {
    expect(NOTE_MARKER_RE.test('[NOTE ABC-123: some note text]')).toBe(true);
  });

  it('matches a DONE marker', () => {
    expect(NOTE_MARKER_RE.test('[NOTE ABC-123: DONE resolved issue]')).toBe(true);
  });

  it('matches LOCAL-* placeholder markers', () => {
    expect(NOTE_MARKER_RE.test('[NOTE LOCAL-abc123: draft note]')).toBe(true);
  });

  it('does NOT match text without the NOTE prefix', () => {
    expect(NOTE_MARKER_RE.test('ABC-123: some note text')).toBe(false);
  });

  it('matches multiple markers in one document', () => {
    expect(MULTI_MARKER_DOC.match(NOTE_MARKER_RE)).toHaveLength(2);
  });

  it('matches markers inside podcast dialogue (PRD §7.1 corpus)', () => {
    expect(NOTE_MARKER_RE.test(EPISODE_MD)).toBe(true);
  });
});

// ── findNoteInParagraph ──────────────────────────────────────────────

describe('findNoteInParagraph', () => {
  it('returns marker id and body from a paragraph containing a marker', () => {
    const result = findNoteInParagraph('Text [NOTE ABC-123: hello world] end');
    expect(result).toBeDefined();
    expect(result?.id).toBe('ABC-123');
    expect(result?.body).toBe('hello world');
    expect(result?.done).toBe(false);
  });

  it('flags DONE markers', () => {
    const result = findNoteInParagraph('Text [NOTE ABC-123: DONE resolved] end');
    expect(result?.done).toBe(true);
    expect(result?.body).toBe('resolved');
  });

  it('returns null when no marker is present', () => {
    expect(findNoteInParagraph('plain text without markers')).toBeNull();
    expect(findNoteInParagraph('')).toBeNull();
  });

  it('handles LOCAL-* placeholder ids', () => {
    const result = findNoteInParagraph('Text [NOTE LOCAL-def456: draft] end');
    expect(result?.id).toBe('LOCAL-def456');
  });

  it('handles multi-line marker bodies', () => {
    const paragraph = 'Text [NOTE ABC-123: line one\nline two] end';
    const result = findNoteInParagraph(paragraph);
    expect(result?.body).toBe('line one\nline two');
  });
});

// ── insertNoteMarker ─────────────────────────────────────────────────

describe('insertNoteMarker', () => {
  it('inserts a marker at the given paragraph index', () => {
    const result = insertNoteMarker(SAMPLE_DOC, 1, 'new note');
    expect(result.doc).toContain('[NOTE');
    expect(result.doc).toContain('new note');
    expect(result.doc).toContain(']');
  });

  it('generates a LOCAL- prefixed id', () => {
    const result = insertNoteMarker(SAMPLE_DOC, 1, 'new note');
    expect(result.newNoteId).toMatch(/^LOCAL-[a-f0-9]+$/);
  });

  it('returns the byte offset of the inserted marker', () => {
    const result = insertNoteMarker(SAMPLE_DOC, 1, 'new note');
    expect(result.byteOffset).toBeGreaterThanOrEqual(0);
    expect(result.doc.slice(result.byteOffset)).toMatch(/^\[NOTE/);
  });

  it('does not modify non-adjacent paragraphs (byte preservation)', () => {
    const result = insertNoteMarker(SAMPLE_DOC, 1, 'new note');
    expect(result.doc).toContain('Paragraph one with some text.');
    expect(result.doc).toContain('Paragraph three.');
  });

  it('preserves the trailing newline when present', () => {
    const result = insertNoteMarker(SAMPLE_DOC + '\n', 1, 'new note');
    expect(result.doc.endsWith('\n')).toBe(true);
  });

  it('does not add a trailing newline when the doc has none', () => {
    const result = insertNoteMarker(SAMPLE_DOC, 1, 'new note');
    expect(result.doc.endsWith('\n')).toBe(false);
  });

  it('preserves UTF-8 multi-byte characters (byte preservation)', () => {
    const result = insertNoteMarker(UTF8_DOC, 1, 'new note');
    expect(result.doc).toContain('café');
    expect(result.doc).toContain('naïve');
    expect(result.doc).toContain('🎵');
    expect(result.doc).toContain('🚀');
  });

  it('appends on a paragraph that already carries a marker (replaces it)', () => {
    // The viewer guards add/edit modes, but the helper stays deterministic:
    // inserting on an already-marked paragraph keeps exactly one marker.
    const result = insertNoteMarker(DOC_WITH_MARKER, 1, 'replacement note');
    expect(result.doc).toContain('[NOTE');
    expect(result.doc).not.toContain('ABC-123: original note');
  });
});

// ── updateNoteMarker ─────────────────────────────────────────────────

describe('updateNoteMarker', () => {
  it('updates the marker text', () => {
    const result = updateNoteMarker(DOC_WITH_MARKER, 'ABC-123', { text: 'updated' });
    expect(result.doc).toContain('[NOTE ABC-123: updated]');
    expect(result.doc).not.toContain('original note');
  });

  it('marks a note DONE with the PRD §7.3 addressed form', () => {
    const result = updateNoteMarker(DOC_WITH_MARKER, 'ABC-123', {
      done: true,
      text: 'resolved',
    });
    expect(result.doc).toContain('[NOTE ABC-123: DONE resolved]');
  });

  it('does not add a DONE prefix when done is omitted', () => {
    const result = updateNoteMarker(DOC_WITH_MARKER, 'ABC-123', { text: 'new text' });
    expect(result.doc).toContain('[NOTE ABC-123: new text]');
    expect(result.doc).not.toContain('DONE');
  });

  it('returns the doc unchanged when the note id is not found', () => {
    const result = updateNoteMarker(DOC_WITH_MARKER, 'XYZ-999', { text: 'no-op' });
    expect(result.doc).toBe(DOC_WITH_MARKER);
    expect(result.byteOffset).toBe(-1);
  });

  it('preserves surrounding text', () => {
    const result = updateNoteMarker(DOC_WITH_MARKER, 'ABC-123', { text: 'updated' });
    expect(result.doc).toContain('Text ');
    expect(result.doc).toContain(' more text.');
  });

  it('returns the byte offset of the updated marker', () => {
    const result = updateNoteMarker(DOC_WITH_MARKER, 'ABC-123', { text: 'updated' });
    expect(result.byteOffset).toBeGreaterThanOrEqual(0);
    expect(result.doc.slice(result.byteOffset)).toMatch(/^\[NOTE/);
  });

  it('preserves UTF-8 multi-byte characters (byte preservation)', () => {
    const result = updateNoteMarker(UTF8_DOC, 'AAA', { text: 'Résolu' });
    expect(result.doc).toContain('café');
    expect(result.doc).toContain('Résolu');
  });

  it('preserves CRLF line endings (byte preservation)', () => {
    const result = updateNoteMarker(CRLF_DOC, 'AAA', { text: 'updated' });
    expect(result.doc).toContain('\r\n');
    expect(result.doc).toContain('[NOTE AAA: updated]');
  });
});

// ── removeNoteMarker ─────────────────────────────────────────────────

describe('removeNoteMarker', () => {
  it('removes an inline marker and leaves surrounding text intact', () => {
    const result = removeNoteMarker(DOC_WITH_MARKER, 'ABC-123');
    expect(result.doc).toContain('Text  more text.');
    expect(result.doc).not.toContain('[NOTE');
    expect(result.doc).not.toContain('ABC-123');
  });

  it('removes a marker on its own line plus one surrounding blank line', () => {
    const result = removeNoteMarker(DOC_WITH_MARKER_ON_OWN_LINE, 'XYZ-789');
    expect(result.doc).toContain('Paragraph one.\n\nParagraph two.');
    expect(result.doc).not.toContain('[NOTE');
  });

  it('returns the doc unchanged when the note id is not found', () => {
    const result = removeNoteMarker(DOC_WITH_MARKER, 'XYZ-999');
    expect(result.doc).toBe(DOC_WITH_MARKER);
    expect(result.byteOffset).toBe(-1);
  });

  it('returns the byte offset of the removed marker', () => {
    const result = removeNoteMarker(DOC_WITH_MARKER, 'ABC-123');
    expect(result.byteOffset).toBeGreaterThanOrEqual(0);
  });

  it('removes only the specified marker when multiple exist', () => {
    const result = removeNoteMarker(MULTI_MARKER_DOC, 'AAA');
    expect(result.doc).toContain('NOTE BBB');
    expect(result.doc).not.toContain('NOTE AAA');
  });

  it('preserves UTF-8 multi-byte characters (byte preservation)', () => {
    const result = removeNoteMarker(UTF8_DOC, 'AAA');
    expect(result.doc).toContain('café');
    expect(result.doc).toContain('🎵');
  });
});

// ── splitParagraphs ──────────────────────────────────────────────────

describe('splitParagraphs', () => {
  it('splits a document into paragraph blocks by blank lines', () => {
    const blocks = splitParagraphs(SAMPLE_DOC);
    expect(blocks).toHaveLength(4); // title + 3 paragraphs
  });

  it('records startLine/endLine (0-based) for each block', () => {
    const blocks = splitParagraphs(SAMPLE_DOC);
    expect(blocks[0].startLine).toBe(0);
    expect(blocks[0].endLine).toBe(0);
    expect(blocks[0].text).toBe('# Title');
  });

  it('captures paragraph text', () => {
    const blocks = splitParagraphs(SAMPLE_DOC);
    expect(blocks[1].text).toContain('Paragraph one with some text.');
  });

  it('skips YAML frontmatter (viewer convention)', () => {
    const blocks = splitParagraphs(EPISODE_MD);
    expect(blocks[0].text).toBe('# Episode One');
    expect(blocks.every((b) => !b.text.includes('pipeline_stage'))).toBe(true);
  });
});

// ── mapParagraphToMarker ─────────────────────────────────────────────

describe('mapParagraphToMarker', () => {
  const doc = `# Title

Paragraph one. [NOTE AAA: inline note]

Paragraph two. [NOTE BBB: DONE done]

Paragraph three.`;

  it('returns the marker for a paragraph that carries one', () => {
    const result = mapParagraphToMarker(doc, 1);
    expect(result).toBeDefined();
    expect(result?.markerIndex).toBe(1);
    expect(result?.noteId).toBe('AAA');
  });

  it('returns null for a paragraph without a marker', () => {
    expect(mapParagraphToMarker(doc, 0)).toBeNull();
    expect(mapParagraphToMarker(doc, 3)).toBeNull();
  });

  it('returns markers on generic markdown documents too', () => {
    const result = mapParagraphToMarker(GENERIC_MD, 1);
    expect(result?.noteId).toBe('LOCAL-a1b2c3');
  });

  it('handles documents with no markers', () => {
    expect(mapParagraphToMarker('Para one.\n\nPara two.', 0)).toBeNull();
  });
});

// ── mapCursorToParagraph ─────────────────────────────────────────────

describe('mapCursorToParagraph', () => {
  it('maps a cursor within the first paragraph to paragraph index 0', () => {
    expect(mapCursorToParagraph(SAMPLE_DOC, 0)).toBe(0);
  });

  it('maps a cursor within a paragraph to its paragraph index', () => {
    expect(mapCursorToParagraph(SAMPLE_DOC, 2)).toBe(1); // "Paragraph one."
    expect(mapCursorToParagraph(SAMPLE_DOC, 4)).toBe(2); // "Paragraph two here."
  });

  it('maps a cursor in blank space to the nearest preceding paragraph', () => {
    expect(mapCursorToParagraph(SAMPLE_DOC, 1)).toBe(0);
    expect(mapCursorToParagraph(SAMPLE_DOC, 3)).toBe(1);
  });

  it('returns -1 for an out-of-bounds cursor', () => {
    expect(mapCursorToParagraph(SAMPLE_DOC, 100)).toBe(-1);
  });

  it('returns -1 for an empty document', () => {
    expect(mapCursorToParagraph('', 0)).toBe(-1);
  });
});

// ── localNoteId ──────────────────────────────────────────────────────

describe('localNoteId', () => {
  it('is deterministic for an unchanged document (stable across re-opens)', () => {
    const id1 = localNoteId(1, SAMPLE_DOC);
    const id2 = localNoteId(1, SAMPLE_DOC);
    expect(id1).toBe(id2);
  });

  it('uses the LOCAL-<seq> placeholder scheme', () => {
    expect(localNoteId(1, SAMPLE_DOC)).toMatch(/^LOCAL-[a-f0-9]+$/);
  });

  it('differs across paragraph indices', () => {
    expect(localNoteId(0, SAMPLE_DOC)).not.toBe(localNoteId(1, SAMPLE_DOC));
  });

  it('differs across documents', () => {
    expect(localNoteId(0, SAMPLE_DOC)).not.toBe(localNoteId(0, GENERIC_MD));
  });
});

// ── resolveEpisodeId ─────────────────────────────────────────────────

describe('resolveEpisodeId', () => {
  it('resolves the episode from frontmatter podcast_title', () => {
    const script = '---\npodcast_title: Episode One\n---\nScript content';
    expect(resolveEpisodeId(script, makePodcastItems())).toBe('OSL-EP1');
  });

  it('resolves the episode from frontmatter source_doc', () => {
    const script = '---\nsource_doc: Episode Two\n---\nScript content';
    expect(resolveEpisodeId(script, makePodcastItems())).toBe('OSL-EP2');
  });

  it('returns null when no matching episode is found', () => {
    const script = '---\npodcast_title: Episode Nine\n---\nScript content';
    expect(resolveEpisodeId(script, makePodcastItems())).toBeNull();
  });

  it('returns null for scripts without frontmatter', () => {
    expect(resolveEpisodeId('Plain script text', makePodcastItems())).toBeNull();
    expect(resolveEpisodeId('', makePodcastItems())).toBeNull();
  });

  it('returns null for an empty item list', () => {
    const script = '---\npodcast_title: Episode One\n---\nScript content';
    expect(resolveEpisodeId(script, [])).toBeNull();
  });
});

// ── Note-child sync helpers (mocked wl CLI) ──────────────────────────

describe('createNoteChild (mocked wl CLI)', () => {
  it('runs `wl create --parent <episode>` and returns the new work-item id', async () => {
    const mockExec = makeWlMock('OSL-NOTE1');
    setExecFileAsync(mockExec);

    const id = await createNoteChild('OSL-EP1', 'Note text');
    expect(id).toBe('OSL-NOTE1');
    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      expect.arrayContaining(['create', '--parent', 'OSL-EP1', '--json']),
    );
  });

  it('propagates the note text into the wl create arguments', async () => {
    const mockExec = makeWlMock('OSL-NOTE1');
    setExecFileAsync(mockExec);

    await createNoteChild('OSL-EP1', 'Important note');
    const [, args] = mockExec.mock.calls[0];
    expect(args.join(' ')).toContain('Important note');
  });
});

describe('commentOnNote (mocked wl CLI)', () => {
  it('runs `wl comment add <id> --comment` with the resolution text', async () => {
    const mockExec = makeWlMock();
    setExecFileAsync(mockExec);

    await commentOnNote('OSL-NOTE1', 'Resolved by agent');
    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      expect.arrayContaining(['comment', 'add', 'OSL-NOTE1', '--comment']),
    );
  });
});

describe('addNoteWithSync (mocked wl CLI)', () => {
  it('creates the note child, inserts the marker with the REAL id, and returns it', async () => {
    const mockExec = makeWlMock('OSL-NOTE1');
    setExecFileAsync(mockExec);

    const result = await addNoteWithSync(EPISODE_MD, 1, 'fact check', makePodcastItems());
    expect(result.newNoteId).toBe('OSL-NOTE1');
    expect(result.doc).toContain('[NOTE OSL-NOTE1: fact check]');
    expect(result.doc).not.toContain('LOCAL-');
    // Episode resolved → wl create was invoked with the episode as parent.
    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      expect.arrayContaining(['create', '--parent', 'OSL-EP1']),
    );
  });

  it('falls back to a LOCAL-* id with a warning when the episode is unresolvable (no silent skip)', async () => {
    const mockExec = makeWlMock();
    setExecFileAsync(mockExec);

    const result = await addNoteWithSync(GENERIC_MD, 1, 'todo', makePodcastItems());
    expect(result.newNoteId).toMatch(/^LOCAL-/);
    expect(result.doc).toContain('[NOTE LOCAL-');
    expect(result.warning).toBeTruthy();
    // No episode → no wl create call.
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('still inserts the marker on a generic doc even with no resolvable episode', async () => {
    setExecFileAsync(makeWlMock());
    const result = await addNoteWithSync(GENERIC_MD, 1, 'todo', []);
    expect(result.doc).toContain('todo');
    expect(result.doc).toContain('[NOTE');
  });

  it('preserves all other content byte-for-byte on the sync path', async () => {
    setExecFileAsync(makeWlMock('OSL-NOTE1'));
    const result = await addNoteWithSync(EPISODE_MD, 1, 'fact check', makePodcastItems());
    expect(result.doc).toContain('Nova: We\'ve all been told');
    expect(result.doc).toContain('- A list item');
    expect(result.doc).toContain('pipeline_stage'); // frontmatter untouched
  });
});

describe('resolveNoteWithSync (mocked wl CLI)', () => {
  it('marks the marker DONE and comments on the note child', async () => {
    const mockExec = makeWlMock();
    setExecFileAsync(mockExec);

    const doc = 'text [NOTE OSL-0MSG7Y0C6005QFES: original] more';
    const result = await resolveNoteWithSync(doc, 'OSL-0MSG7Y0C6005QFES', 'Resolved', makePodcastItems());
    expect(result.doc).toContain('[NOTE OSL-0MSG7Y0C6005QFES: DONE Resolved]');
    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      expect.arrayContaining(['comment', 'add', 'OSL-0MSG7Y0C6005QFES']),
    );
  });

  it('returns the doc unchanged and no wl call when the marker is missing', async () => {
    const mockExec = makeWlMock();
    setExecFileAsync(mockExec);

    const doc = 'text without markers';
    const result = await resolveNoteWithSync(doc, 'OSL-NOPE', 'no-op', makePodcastItems());
    expect(result.doc).toBe(doc);
    expect(mockExec).not.toHaveBeenCalled();
  });
});

// ── Generic markdown (non-podcast) parity ─────────────────────────────

describe('generic markdown parity (PRD §7.3)', () => {
  it('marker helpers work on generic md docs, not just podcast scripts', () => {
    // insert
    const inserted = insertNoteMarker(GENERIC_MD, 1, 'another action');
    expect(inserted.doc).toContain('[NOTE');
    // update DONE variant
    const updated = updateNoteMarker(inserted.doc, 'LOCAL-a1b2c3', { done: true, text: 'done' });
    expect(updated.doc).toContain('[NOTE LOCAL-a1b2c3: DONE done]');
    // remove
    const removed = removeNoteMarker(updated.doc, 'LOCAL-a1b2c3');
    expect(removed.doc).not.toContain('[NOTE');
    // markers without DONE stay pending
    expect(findNoteInParagraph(GENERIC_MD)?.done).toBe(false);
  });
});
