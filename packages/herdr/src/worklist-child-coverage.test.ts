/**
 * packages/herdr/src/worklist-child-coverage.test.ts — List/metadata
 * rendering of derived child-audit coverage (WL-0MUBVH8QG0020H9L).
 *
 * A child whose direct parent has a fresh audit is *covered*: the list row
 * and metadata Stage row show the parent's audit-result symbol in a
 * dimmed/grey style (visually distinct from a bright own-audit icon) and the
 * metadata panel names the covering parent. Uncovered children keep the plain
 * in_review stage icon (AC3/AC4).
 *
 * Run: npx vitest run packages/herdr/src/worklist-child-coverage.test.ts
 */
import { describe, it, expect } from 'vitest';
import { ANSI, buildMetaRows, formatItemLine, WorkItemListState } from './worklist.js';
import { stringDisplayWidth } from '@worklog/shared/icons';
import type { WorkItem } from './fetcher.js';

const AUDIT_READY = '\u{2705}'; // ✅
const AUDIT_NOT_READY = '\u{274C}'; // ❌
const STAGE_IN_REVIEW = '\u{1F50D}'; // 🔍
const STATUS_COMPLETED = '\u{2714}\u{FE0F}'; // ✔️

const DIM = ANSI.dim;
const RESET = ANSI.reset;

/** A fresh parent audit (within the 60 s time gate). */
const FRESH_AUDIT = {
  auditResult: true,
  auditedAt: '2026-08-02T10:00:30.000Z',
  updatedAt: '2026-08-02T10:00:00.000Z',
};

/** A stale parent audit (well beyond the 60 s time gate). */
const STALE_AUDIT = {
  auditResult: true,
  auditedAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-02T10:00:00.000Z',
};

function child(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'WL-CHILD1',
    title: 'Covered child',
    status: 'completed',
    stage: 'in_review',
    parentId: 'WL-PARENT1',
    updatedAt: '2026-08-02T10:00:00.000Z',
    ...over,
  };
}

describe('formatItemLine — dimmed covered indicator (AC3)', () => {
  it('dims the parent audit symbol for a covered child', () => {
    const line = formatItemLine(child({ parentAudit: FRESH_AUDIT }), 200);
    expect(line).toContain(`${DIM}${AUDIT_READY}${RESET}`);
  });

  it('does not dim the status icon — only the covered stage indicator is greyed', () => {
    const line = formatItemLine(child({ parentAudit: FRESH_AUDIT }), 200);
    expect(line).toContain(`${DIM}${AUDIT_READY}${RESET}`);
    expect(line).not.toContain(`${DIM}${STATUS_COMPLETED}${RESET}`);
  });

  it('renders the parent verdict for a failing parent audit (❌)', () => {
    const line = formatItemLine(
      child({ parentAudit: { ...FRESH_AUDIT, auditResult: false } }),
      200,
    );
    expect(line).toContain(`${DIM}${AUDIT_NOT_READY}${RESET}`);
  });

  it('shows the plain stage icon (no dim) for an uncovered child', () => {
    const line = formatItemLine(child({ parentAudit: STALE_AUDIT }), 200);
    expect(line).toContain(STAGE_IN_REVIEW);
    expect(line).not.toContain(`${DIM}${AUDIT_READY}${RESET}`);
  });

  it('shows the plain stage icon for a child whose parent audit is unavailable', () => {
    const line = formatItemLine(child({ parentAudit: null }), 200);
    expect(line).toContain(STAGE_IN_REVIEW);
    expect(line).not.toContain(`${DIM}`);
  });

  it('renders the [COVERED] fallback in noIcons mode', () => {
    const line = formatItemLine(child({ parentAudit: FRESH_AUDIT }), 200, false, true);
    expect(line).toContain('[COVERED]');
    expect(line).not.toContain(DIM);
  });

  it('keeps the item-ID column aligned whether or not the child is covered', () => {
    const covered = formatItemLine(child({ parentAudit: FRESH_AUDIT }), 200);
    const uncovered = formatItemLine(child({ parentAudit: STALE_AUDIT }), 200);
    // The covered glyph (✅) and the plain stage glyph (🔍) have different
    // code-unit lengths, so compare DISPLAY columns after stripping ANSI.
    const visible = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '');
    const idCol = (line: string): number => {
      const plain = visible(line);
      return stringDisplayWidth(plain.slice(0, plain.indexOf('WL-CHILD1')));
    };
    expect(idCol(covered)).toBe(idCol(uncovered));
    expect(idCol(covered)).toBeGreaterThan(0);
  });
});

describe('WorkItemListState — children are enriched with parent audit state (AC1/AC3)', () => {
  function makeTree(audit: Record<string, unknown>): WorkItem[] {
    return [
      {
        id: 'WL-PARENT1',
        title: 'Parent',
        status: 'completed',
        stage: 'in_review',
        childCount: 1,
        updatedAt: '2026-08-02T10:00:00.000Z',
        ...audit,
        children: [child({ depth: 1 })],
      },
    ];
  }

  it('derives coverage on the flattened child from the direct parent audit', () => {
    const state = new WorkItemListState(makeTree(FRESH_AUDIT), { rows: 24, cols: 80 });
    state.toggleExpand('WL-PARENT1');
    const flat = state.getFlattenedItems();
    const enriched = flat.find((i) => i.id === 'WL-CHILD1');
    expect(enriched?.parentAudit).toEqual(FRESH_AUDIT);
    // The row renders the covered indicator (dimmed) end-to-end.
    expect(flat.map((i) => formatItemLine(i, 200)).join('\n')).toContain(
      `${DIM}${AUDIT_READY}${RESET}`,
    );
  });

  it('does not cover the child when the parent audit is stale (AC5c)', () => {
    const state = new WorkItemListState(makeTree(STALE_AUDIT), { rows: 24, cols: 80 });
    state.toggleExpand('WL-PARENT1');
    const enriched = state.getFlattenedItems().find((i) => i.id === 'WL-CHILD1');
    expect(enriched?.parentAudit?.auditedAt).toBe(STALE_AUDIT.auditedAt);
    const line = formatItemLine(enriched!, 200);
    expect(line).toContain(STAGE_IN_REVIEW);
    expect(line).not.toContain(`${DIM}${AUDIT_READY}${RESET}`);
  });

  it('does not enrich a root item with coverage', () => {
    const root = makeTree(FRESH_AUDIT)[0];
    const state = new WorkItemListState([{ ...root, childCount: 0, children: undefined }], {
      rows: 24,
      cols: 80,
    });
    expect(state.getFlattenedItems()[0].parentAudit).toBeUndefined();
  });
});

describe('buildMetaRows — covered child Stage row and parent reference (AC3)', () => {
  it('dims the covered glyph and adds a `Covered by` row naming the parent', () => {
    const rows = new Map(buildMetaRows(child({ parentAudit: FRESH_AUDIT })));
    expect(rows.get('Stage')).toBe(`${DIM}${AUDIT_READY}${RESET} in_review`);
    expect(rows.get('Covered by')).toBe('WL-PARENT1');
  });

  it('omits the `Covered by` row for an uncovered child', () => {
    const rows = new Map(buildMetaRows(child({ parentAudit: STALE_AUDIT })));
    expect(rows.get('Covered by')).toBeUndefined();
    expect(rows.get('Stage')).toBe(`${STAGE_IN_REVIEW} in_review`);
  });

  it('omits the `Covered by` row when the parent audit state is unavailable (never guesses)', () => {
    const rows = new Map(buildMetaRows(child({ parentAudit: null })));
    expect(rows.get('Covered by')).toBeUndefined();
  });

  it('keeps the metadata Stage row honest in noIcons mode while naming the parent', () => {
    const rows = new Map(buildMetaRows(child({ parentAudit: FRESH_AUDIT }), true));
    // noIcons metadata deliberately avoids [BRACKET] fallbacks; the textual
    // `Covered by` row is the source of truth.
    expect(rows.get('Stage')).toBe('in_review');
    expect(rows.get('Covered by')).toBe('WL-PARENT1');
    expect(rows.get('Stage')).not.toContain(DIM);
  });
});
