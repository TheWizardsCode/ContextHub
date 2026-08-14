/**
 * Unit tests for packages/herdr/src/md-viewer.ts — the generic markdown
 * document viewer helpers, NOTE-marker link rendering, and podcast item
 * stage grouping (PRD §7.1 / OSL-0MSDYOVER005FT15).
 *
 * Run: npx vitest run packages/herdr/src/md-viewer.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  NOTE_MARKER_RE,
  extractNoteIds,
  renderNoteLinks,
  renderMarkdownViewer,
} from './md-viewer.js';
import {
  formatDetailContent,
  firstMarkdownKeyFile,
  renderFileViewer,
} from './worklist.js';
import { assignItemGroups, regroupWorkItems, type GroupableItem } from './grouping.js';
import type { WorkItem } from './fetcher.js';

// ── Fixtures ──────────────────────────────────────────────────────────

/** A real converted paragraph-format episode excerpt (PRD §7.1). */
const EPISODE_MD = `---
pipeline_stage: produced
version: "0.2"
---

# Episode One

Nova: We've all been told that training massive language models requires a perfect, uniform grid of top-tier GPUs.

Sorra: It's a fantastic way to frame it. [NOTE OSL-0MSG7Y0C6005QFES: WIKI FACT CHECK: The script was revised to remove the unsupported claim.]

- A list item
- Another item

\`\`\`
code block
\`\`\`
`;

// ── NOTE-marker extraction / link rendering ───────────────────────────

describe('extractNoteIds', () => {
  it('extracts note work-item ids from inline markers', () => {
    const ids = extractNoteIds(
      'Nova: First [NOTE OSL-AAA: note one] then [NOTE OSL-BBB: DONE note two]',
    );
    expect(ids).toEqual(['OSL-AAA', 'OSL-BBB']);
  });

  it('returns no duplicates', () => {
    const ids = extractNoteIds('[NOTE OSL-AAA: a] [NOTE OSL-AAA: b]');
    expect(ids).toEqual(['OSL-AAA']);
  });

  it('returns empty for text without markers', () => {
    expect(extractNoteIds('No markers here.')).toEqual([]);
    expect(extractNoteIds('')).toEqual([]);
  });
});

describe('renderNoteLinks', () => {
  it('renders a marker as an id link (marker text dropped)', () => {
    const out = renderNoteLinks('Sorra: text [NOTE OSL-0MSG7Y0C6005QFES: WIKI FACT CHECK: note]');
    expect(out).toBe('Sorra: text OSL-0MSG7Y0C6005QFES↗');
  });

  it('handles DONE variants', () => {
    const out = renderNoteLinks('Nova: hi [NOTE OSL-BBB: DONE fixed]');
    expect(out).toBe('Nova: hi OSL-BBB↗');
  });

  it('leaves text without markers unchanged', () => {
    const text = 'Plain dialogue, no notes.';
    expect(renderNoteLinks(text)).toBe(text);
    expect(renderNoteLinks('')).toBe('');
  });

  it('matches real corpus markers', () => {
    const marker =
      '[NOTE OSL-0MSG7Y0C6005QFES: WIKI FACT CHECK: The script was revised to remove the unsupported claim about developers not having to think about hardware, aligning with the source that it abstracts differences from the API.]';
    expect(NOTE_MARKER_RE.test(marker)).toBe(true);
    expect(renderNoteLinks(marker)).toBe('OSL-0MSG7Y0C6005QFES↗');
  });
});

// ── Markdown viewer rendering ─────────────────────────────────────────

describe('renderMarkdownViewer', () => {
  it('renders a paragraph-format episode: frontmatter skipped, headings and dialogue shown', () => {
    const lines = renderMarkdownViewer(EPISODE_MD, 80);
    const joined = lines.join('\n');
    // Frontmatter is not rendered.
    expect(joined).not.toContain('pipeline_stage');
    expect(joined).not.toContain('version:');
    // Heading rendered (h1 glyph; bold ANSI wraps the heading text).
    expect(visibleOf(lines)).toContain('██ Episode One');
    // Dialogue paragraphs rendered.
    expect(joined).toContain('Nova:');
    expect(joined).toContain('Sorra:');
    // List items rendered.
    expect(joined).toContain('• A list item');
    // Code block rendered.
    expect(joined).toContain('│ code block');
  });

  it('renders inline NOTE markers as links in the viewer', () => {
    const lines = renderMarkdownViewer(EPISODE_MD, 120);
    const joined = lines.join('\n');
    expect(joined).toContain('OSL-0MSG7Y0C6005QFES↗');
    expect(joined).not.toContain('[NOTE');
  });

  it('returns empty for empty input', () => {
    expect(renderMarkdownViewer('', 80)).toEqual([]);
  });

  it('truncates long lines to maxCols', () => {
    const long = 'Nova: ' + 'word '.repeat(100);
    const lines = renderMarkdownViewer(long, 40);
    expect(lines[0].length).toBeLessThanOrEqual(40);
  });
});

// ── GFM rendering (WL-0MSKFFJWD002BQJ5) ───────────────────────────────

/** Strip ANSI SGR codes so tests assert on visible text. */
function visibleOf(lines: string[]): string {
  return lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
}

describe('renderMarkdownViewer — GFM constructs', () => {
  it('renders heading hierarchy with distinct glyphs per depth', () => {
    const joined = visibleOf(renderMarkdownViewer('# One\n\n## Two\n\n### Three\n\n###### Six', 80));
    expect(joined).toContain('██ One');
    expect(joined).toContain('█ Two');
    expect(joined).toContain('▌ Three');
    expect(joined).toContain('▌ Six');
  });

  it('renders ordered and nested bullet lists', () => {
    const md = [
      '1. first',
      '2. second',
      '',
      '- top',
      '  - nested one',
      '    - deep two',
      '- bottom',
    ].join('\n');
    const joined = visibleOf(renderMarkdownViewer(md, 80));
    expect(joined).toContain('1. first');
    expect(joined).toContain('2. second');
    expect(joined).toContain('• top');
    expect(joined).toContain('  • nested one');
    expect(joined).toContain('    • deep two');
    expect(joined).toContain('• bottom');
  });

  it('renders blockquotes indented with a quote glyph', () => {
    const joined = visibleOf(renderMarkdownViewer('> quoted line one\n> quoted line two', 80));
    expect(joined).toContain('▌ quoted line one');
    expect(joined).toContain('▌ quoted line two');
  });

  it('renders GFM tables as aligned columns with a header row', () => {
    const md = [
      '| Left | Center | Right |',
      '|:-----|:------:|------:|',
      '| a    | b      | c     |',
      '| long | mid    | x     |',
    ].join('\n');
    const visible = visibleOf(renderMarkdownViewer(md, 80));
    // Header row and alignment (center column padded both sides, right
    // column right-aligned) render with column separators.
    expect(visible).toContain('│ Left │');
    expect(visible).toContain('│ a    │   b    │     c │');
    expect(visible).toContain('│ long │  mid   │     x │');
    // Separator row between header and body.
    expect(visible).toMatch(/├.*┼.*┤/);
  });

  it('renders bold, italic, strikethrough, and inline code with styling', () => {
    const md = 'Para **bold** *italic* ~~struck~~ `inline code`.';
    const joined = renderMarkdownViewer(md, 80).join('\n');
    // Visible text survives styling.
    expect(joined).toContain('bold');
    expect(joined).toContain('italic');
    expect(joined).toContain('struck');
    // Styles applied: ANSI bold around bold text, italic around italic,
    // strikethrough around struck, cyan inside backticks for code.
    expect(joined).toContain(`\x1b[1mbold\x1b[0m`);
    expect(joined).toContain(`\x1b[3mitalic\x1b[0m`);
    expect(joined).toContain(`\x1b[9mstruck\x1b[0m`);
    expect(joined).toContain('`\x1b[36minline code\x1b[0m`');
  });

  it('renders links underlined/colored with the href shown dimmed', () => {
    const joined = renderMarkdownViewer('See [the docs](https://example.com/guide).', 80).join('\n');
    expect(joined).toContain(`\x1b[4m\x1b[34mthe docs\x1b[0m`);
    expect(joined).toContain(`\x1b[2m (https://example.com/guide)\x1b[0m`);
  });

  it('renders horizontal rules as a line of dashes', () => {
    const joined = visibleOf(renderMarkdownViewer('before\n\n---\n\nafter', 80));
    expect(joined).toContain('before');
    expect(joined).toContain('after');
    expect(joined).toMatch(/\n─{3,}\n/);
  });

  it('renders NOTE markers as links inside GFM content', () => {
    const md = '# H\n\nA line with [NOTE OSL-CCC: hidden note text] inside.';
    const joined = renderMarkdownViewer(md, 120).join('\n');
    expect(joined).toContain('OSL-CCC↗');
    expect(joined).not.toContain('[NOTE');
    expect(joined).not.toContain('hidden note text');
  });
});

// ── Podcast item stage grouping (standard stages only) ────────────────

/** Build a minimal WorkItem with a stage (podcast items use standard stages). */
function makeItem(id: string, stage: string, priority = 'medium'): WorkItem {
  return {
    id,
    title: `Episode ${id}`,
    status: 'open',
    stage,
    priority,
    description: `**Key Files:**\n- \`podcast/${id}.podcast.md\``,
  };
}

/** Map WorkItems to the GroupableItem shape assignItemGroups expects. */
function toGroupable(item: WorkItem): GroupableItem {
  return {
    id: item.id,
    stage: item.stage,
    priority: item.priority,
    filePaths: item.description ? ['podcast/' + item.id + '.podcast.md'] : [],
  };
}

describe('podcast item stage grouping', () => {
  it('groups podcast items by standard lifecycle stages with no custom values', () => {
    const items: WorkItem[] = [
      makeItem('ep-idea', 'idea'),
      makeItem('ep-drafted', 'plan_complete'),
      makeItem('ep-written', 'in_review'),
      makeItem('ep-produced', 'done'),
    ];
    const groups = assignItemGroups(items.map(toGroupable));

    // Group labels must come from the standard stage mapping; no custom
    // stage strings appear in any label.
    const labels = [...groups.values()].map(g => g.groupLabel);
    const allLabels = labels.join(' ');
    expect(allLabels).not.toMatch(/sourced|drafted|written|produced/);

    // Idea → 'Idea', plan_complete → 'Group N', in_review → 'In Review'.
    expect(groups.get('ep-idea')?.groupLabel).toBe('Idea');
    expect(groups.get('ep-drafted')?.groupLabel).toMatch(/^Group \d+$/);
    expect(groups.get('ep-written')?.groupLabel).toBe('In Review');
    // done is not one of the known buckets → 'Other'.
    expect(groups.get('ep-produced')?.groupLabel).toBe('Other');
  });

  it('regroupWorkItems keeps podcast stage groups stable after reorder', () => {
    const items: WorkItem[] = [
      makeItem('ep-idea', 'idea'),
      makeItem('ep-drafted', 'plan_complete'),
      makeItem('ep-written', 'in_review'),
    ];
    // Shuffle to simulate a merged-then-reordered list.
    const shuffled: WorkItem[] = [items[2], items[0], items[1]];
    const regrouped = regroupWorkItems(shuffled);

    const byId = new Map(regrouped.map(i => [i.id, i]));
    // In Review must come last.
    expect(byId.get('ep-written')?.groupLabel).toBe('In Review');
    expect(byId.get('ep-idea')?.groupLabel).toBe('Idea');
    expect(byId.get('ep-drafted')?.groupLabel).toMatch(/^Group \d+$/);
  });
});

// ── Detail-view wiring: NOTE links + Key Files md viewer ──────────────

describe('detail-view wiring', () => {
  /** Build a WorkItem whose description references a Key Files .md. */
  function makeEpisodeItem(description: string): WorkItem {
    return {
      id: 'OSL-EP1',
      title: 'Episode One',
      status: 'open',
      stage: 'in_review',
      priority: 'medium',
      description,
    };
  }

  it('firstMarkdownKeyFile returns the first .md path from Key Files', () => {
    const desc = '**Key Files:**\n- `podcast/episode-one.podcast.md`\n- `src/notes.txt`';
    expect(firstMarkdownKeyFile(desc)).toBe('podcast/episode-one.podcast.md');
  });

  it('firstMarkdownKeyFile returns empty when no .md path exists', () => {
    expect(firstMarkdownKeyFile('**Key Files:**\n- `src/notes.txt`')).toBe('');
    expect(firstMarkdownKeyFile('No key files')).toBe('');
    expect(firstMarkdownKeyFile(undefined)).toBe('');
  });

  it('renderFileViewer renders the Key Files .md via the md viewer', () => {
    const item = makeEpisodeItem(
      '**Key Files:**\n- `podcast/episode-one.podcast.md`',
    );
    const readFile = (p: string): string | null =>
      p === 'podcast/episode-one.podcast.md'
        ? '# Episode\n\nNova: Hello [NOTE OSL-AAA: fix me]'
        : null;
    const lines = renderFileViewer(item, 80, readFile);
    expect(lines.join('\n')).toContain('Episode');
    expect(lines.join('\n')).toContain('OSL-AAA↗');
  });

  it('renderFileViewer returns [] when the file is unreadable', () => {
    const item = makeEpisodeItem(
      '**Key Files:**\n- `podcast/episode-one.podcast.md`',
    );
    expect(renderFileViewer(item, 80, () => null)).toEqual([]);
  });

  it('formatDetailContent renders NOTE markers as links in the description', () => {
    const item = makeEpisodeItem(
      'Sorra: text [NOTE OSL-0MSG7Y0C6005QFES: WIKI FACT CHECK: unsupported claim]',
    );
    const joined = formatDetailContent(item, 120).join('\n');
    expect(joined).toContain('OSL-0MSG7Y0C6005QFES↗');
    expect(joined).not.toContain('[NOTE');
  });

  it('formatDetailContent renders the description as GFM (table, bold, italic, code, links, lists)', () => {
    const item = makeEpisodeItem(
      [
        '**Bold** and *italic* and `code` and [a link](https://example.com).',
        '',
        '| A | B |',
        '|---|---|',
        '| 1 | 2 |',
        '',
        '- one',
        '- two',
      ].join('\n'),
    );
    const visible = formatDetailContent(item, 120).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    // Bold/italic/code/link text renders.
    expect(visible).toContain('Bold');
    expect(visible).toContain('italic');
    expect(visible).toContain('`code`');
    expect(visible).toContain('a link');
    // Table renders with aligned columns.
    expect(visible).toContain('│ A │ B │');
    expect(visible).toContain('│ 1 │ 2 │');
    // Lists render as bullets.
    expect(visible).toContain('• one');
    expect(visible).toContain('• two');
  });

  it('formatDetailContent embeds the md viewer section when readFile is provided', () => {
    const item = makeEpisodeItem(
      '**Key Files:**\n- `podcast/episode-one.podcast.md`\n\nSome description.',
    );
    const readFile = (p: string): string | null =>
      p === 'podcast/episode-one.podcast.md'
        ? '# Episode One\n\nNova: Hello [NOTE OSL-AAA: fix me]'
        : null;
    const joined = formatDetailContent(item, 120, readFile).join('\n');
    expect(joined).toContain('Episode file (md viewer)');
    expect(joined).toContain('Episode One');
    expect(joined).toContain('OSL-AAA↗');
  });
});

// ── Inline-note editing: viewer cursor ↔ paragraph mapping (WL-0MSKV6SKK008MMXR)
// Red-phase: these tests pin the md-note-edit cursor mapping contract used
// by the viewer cursor (child #3). The module does not exist yet, so these
// tests are expected to FAIL (RED) until child #2 lands. Dynamic imports
// keep this file loadable so pre-existing tests stay green.

describe('inline-note cursor mapping (WL-0MSKV6SKK008MMXR)', () => {
  const viewerDoc = `# Title

Paragraph one with some text.

Paragraph two here.`;

  it('mapCursorToParagraph maps a source cursor line to its paragraph index', async () => {
    const { mapCursorToParagraph } = await import('./md-note-edit.js');
    // Cursor on "Paragraph one." (source line 2) → paragraph index 1.
    expect(mapCursorToParagraph(viewerDoc, 2)).toBe(1);
  });

  it('mapCursorToParagraph maps the first source line to paragraph 0', async () => {
    const { mapCursorToParagraph } = await import('./md-note-edit.js');
    expect(mapCursorToParagraph(viewerDoc, 0)).toBe(0);
  });

  it('mapParagraphToMarker locates the marker of the paragraph under the cursor', async () => {
    const { mapParagraphToMarker } = await import('./md-note-edit.js');
    const doc = '# Title\n\nParagraph one. [NOTE AAA: note]\n\nParagraph two.';
    const marker = mapParagraphToMarker(doc, 1);
    expect(marker).not.toBeNull();
    expect(marker?.noteId).toBe('AAA');
  });

  it('the md viewer renders NOTE markers identically for generic markdown (not just podcast scripts)', () => {
    // Guard: existing inline-note link rendering must keep working for any
    // .md file opened in the viewer (PRD §7.1/§7.3).
    const genericMd = '# Notes\n\nAction item: fix the flaky test [NOTE LOCAL-a1b2c3: investigate]\n';
    const joined = renderMarkdownViewer(genericMd, 80).join('\n');
    expect(joined).toContain('LOCAL-a1b2c3↗');
    expect(joined).not.toContain('[NOTE');
  });
});
