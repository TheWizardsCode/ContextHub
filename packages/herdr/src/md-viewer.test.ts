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
    // Heading rendered.
    expect(joined).toContain('█ Episode One');
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
