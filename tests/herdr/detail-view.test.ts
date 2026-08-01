/**
 * tests/herdr/detail-view.test.ts — Tests for scrollable detail view
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  formatDetailView,
  formatDetailContent,
  WorkItemListState,
  handleKeypress,
  createListRenderer,
  type WorkItem,
} from '../../packages/herdr/src/worklist.js';

// ── Fixtures ──────────────────────────────────────────────────────────

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'WL-TEST001',
    title: 'Test Work Item',
    status: 'open',
    stage: 'in_progress',
    priority: 'high',
    issueType: 'feature',
    description: 'A test work item description for testing.',
    risk: 'low',
    effort: 'small',
    childCount: 0,
    tags: ['test', 'example'],
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-15T00:00:00Z',
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('formatDetailContent', () => {
  it('returns an array of content lines', () => {
    const item = makeItem();
    const lines = formatDetailContent(item, 80);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
  });

  it('includes item ID and title in first lines', () => {
    const item = makeItem();
    const lines = formatDetailContent(item, 80);
    const joined = lines.join('\n');
    expect(joined).toContain('WL-TEST001');
    expect(joined).toContain('Test Work Item');
  });

  it('includes all metadata fields', () => {
    const item = makeItem({
      status: 'in-progress',
      priority: 'high',
      stage: 'plan_complete',
      issueType: 'feature',
      risk: 'medium',
      effort: 'large',
      childCount: 3,
    });
    const lines = formatDetailContent(item, 80);
    const joined = lines.join('\n');
    expect(joined).toContain('in-progress');
    expect(joined).toContain('high');
    expect(joined).toContain('plan_complete');
    expect(joined).toContain('feature');
    expect(joined).toContain('medium');
    expect(joined).toContain('large');
    expect(joined).toContain('3');
  });

  it('includes tags when present', () => {
    const item = makeItem({ tags: ['urgent', 'frontend'] });
    const lines = formatDetailContent(item, 80);
    const joined = lines.join('\n');
    expect(joined).toContain('urgent');
    expect(joined).toContain('frontend');
  });

  it('includes description when present', () => {
    const item = makeItem({ description: 'A long description here.' });
    const lines = formatDetailContent(item, 80);
    const joined = lines.join('\n');
    expect(joined).toContain('A long description here.');
  });

  it('wraps long descriptions to fit width', () => {
    const longWord = 'word '.repeat(100);
    const item = makeItem({ description: longWord });
    const lines = formatDetailContent(item, 40);
    // Some lines may exceed due to metadata header; focus on description lines
    const descLines = lines.filter(l => l.trim().startsWith('word'));
    for (const line of descLines) {
      const stripped = line.replace(/\x1b\[[0-9;]*m/g, '');
      // Wrap width is maxCols - 4 = 36 for description text, plus 2-char indent = 38
      expect(stripped.length).toBeLessThanOrEqual(43);
    }
  });

  it('shows truncated indicator for very long descriptions', () => {
    const longDesc = 'line\n'.repeat(500);
    const item = makeItem({ description: longDesc });
    const lines = formatDetailContent(item, 80);
    const joined = lines.join('\n');
    expect(joined).toContain('truncated');
  });

  it('returns empty array for null item', () => {
    expect(formatDetailContent(null, 80)).toEqual([]);
  });

  // ── Audit fields ──────────────────────────────────────────────

  it('displays auditResult=true with ready indicator', () => {
    const item = makeItem({ auditResult: true });
    const lines = formatDetailContent(item, 80);
    const joined = lines.join('\n');
    expect(joined).toContain('Audit');
    expect(joined).toContain('\u2705'); // AUDIT_READY (✅)
  });

  it('displays auditResult=false with failed indicator', () => {
    const item = makeItem({ auditResult: false });
    const lines = formatDetailContent(item, 80);
    const joined = lines.join('\n');
    expect(joined).toContain('Audit');
    expect(joined).toContain('\u274C'); // AUDIT_NOT_READY (❌)
  });

  it('displays auditResult=null with unknown indicator', () => {
    const item = makeItem({ auditResult: null });
    const lines = formatDetailContent(item, 80);
    const joined = lines.join('\n');
    expect(joined).toContain('Audit');
    expect(joined).toContain('\u2753'); // AUDIT_UNKNOWN (❓)
  });

  it('displays auditedAt when present', () => {
    const item = makeItem({ auditedAt: '2025-06-15T10:30:00Z' });
    const lines = formatDetailContent(item, 80);
    const joined = lines.join('\n');
    expect(joined).toContain('Audited At');
    expect(joined).toContain('2025-06-15T10:30:00Z');
  });

  it('omits auditedAt when absent', () => {
    const item = makeItem({ auditedAt: undefined });
    const lines = formatDetailContent(item, 80);
    const joined = lines.join('\n');
    expect(joined).not.toContain('Audited At');
  });

  it('displays needsProducerReview=true with review-needed indicator', () => {
    const item = makeItem({ needsProducerReview: true });
    const lines = formatDetailContent(item, 80);
    const joined = lines.join('\n');
    expect(joined).toContain('Reviewed');
    expect(joined).toContain('\u274C'); // NEEDS_REVIEW_ICON (❌)
  });

  it('displays needsProducerReview=false with reviewed indicator', () => {
    const item = makeItem({ needsProducerReview: false });
    const lines = formatDetailContent(item, 80);
    const joined = lines.join('\n');
    expect(joined).toContain('Reviewed');
    expect(joined).toContain('\u2705'); // REVIEW_DONE_ICON (✅)
  });

  it('omits needsProducerReview when undefined', () => {
    const item = makeItem({ needsProducerReview: undefined });
    const lines = formatDetailContent(item, 80);
    const joined = lines.join('\n');
    expect(joined).not.toContain('Reviewed');
  });

  it('displays githubIssueNumber when present', () => {
    const item = makeItem({ githubIssueNumber: '123' });
    const lines = formatDetailContent(item, 80);
    const joined = lines.join('\n');
    expect(joined).toContain('GitHub Issue');
    expect(joined).toContain('#123');
  });

  it('omits githubIssueNumber when absent', () => {
    const item = makeItem({ githubIssueNumber: undefined });
    const lines = formatDetailContent(item, 80);
    const joined = lines.join('\n');
    expect(joined).not.toContain('GitHub Issue');
  });

  it('includes all audit fields in metadata section', () => {
    const item = makeItem({
      auditResult: true,
      auditedAt: '2025-06-15T10:30:00Z',
      needsProducerReview: false,
    });
    const lines = formatDetailContent(item, 80);
    const joined = lines.join('\n');
    // All three audit labels should be present
    expect(joined).toContain('Audit');
    expect(joined).toContain('Audited At');
    expect(joined).toContain('Reviewed');
  });
});

describe('formatDetailView (scrollable)', () => {
  it('renders a viewport of content lines', () => {
    const item = makeItem({ description: 'line\n'.repeat(100) });
    const result = formatDetailView(item, 80, 0, 20);
    expect(result).toContain('WL-TEST001');
    expect(result).toContain('Test Work Item');
  });

  it('scrolls content by offset', () => {
    const item = makeItem({ description: 'line\n'.repeat(100) });
    // At scroll offset 50, the content should be shifted (header is gone)
    const result = formatDetailView(item, 80, 50, 20);
    expect(result).not.toContain('WL-TEST001');
    expect(result).toContain('scroll');
    // The viewport shows description lines starting from line 50
    const lines = result.split('\n');
    expect(lines.length).toBeLessThanOrEqual(25);
  });

  it('shows scroll position when content exceeds viewport', () => {
    const item = makeItem({ description: 'line\n'.repeat(100) });
    const result = formatDetailView(item, 80, 0, 10);
    expect(result).toContain('1-');
    expect(result).toContain('scroll');
  });

  it('shows footer on last page', () => {
    const item = makeItem();
    const result = formatDetailView(item, 80, 0, 30);
    expect(result).toContain('esc');
    expect(result).toContain('back');
  });
});

describe('WorkItemListState detail scroll', () => {
  it('initializes detailScrollOffset to 0', () => {
    const items = [makeItem()];
    const state = new WorkItemListState(items, { rows: 24, cols: 80 });
    expect(state.detailScrollOffset).toBe(0);
  });

  it('detailScrollUp decrements the offset', () => {
    const items = [makeItem()];
    const state = new WorkItemListState(items, { rows: 24, cols: 80 });
    state.detailScrollOffset = 5;
    state.detailScrollUp();
    expect(state.detailScrollOffset).toBe(4);
  });

  it('detailScrollUp clamps at 0', () => {
    const items = [makeItem()];
    const state = new WorkItemListState(items, { rows: 24, cols: 80 });
    state.detailScrollUp();
    expect(state.detailScrollOffset).toBe(0);
  });

  it('detailScrollDown increments the offset', () => {
    const items = [makeItem({ description: 'line\n'.repeat(100) })];
    const state = new WorkItemListState(items, { rows: 24, cols: 80 });
    state.detailItem = items[0];
    state.detailScrollOffset = 0;
    state.detailScrollDown();
    expect(state.detailScrollOffset).toBe(1);
  });

  it('detailScrollDown clamps at max', () => {
    const items = [makeItem({ description: 'short' })];
    const state = new WorkItemListState(items, { rows: 24, cols: 80 });
    state.mode = 'detail';
    state.detailItem = items[0];
    state.detailScrollDown();
    // Should clamp at the max scroll offset for this content
    expect(state.detailScrollOffset).toBeGreaterThanOrEqual(0);
  });

  it('resets scroll offset when entering detail mode', () => {
    const items = [makeItem()];
    const state = new WorkItemListState(items, { rows: 24, cols: 80 });
    state.detailScrollOffset = 10;
    state.selectItem();
    expect(state.detailScrollOffset).toBe(0);
  });
});

describe('handleKeypress in detail mode', () => {
  it('scrolls down with j key', () => {
    const items = [makeItem({ description: 'line\n'.repeat(100) })];
    const state = new WorkItemListState(items, { rows: 24, cols: 80 });
    state.mode = 'detail';
    state.detailItem = items[0];
    handleKeypress(state, 'j', { rows: 24, cols: 80 });
    expect(state.detailScrollOffset).toBe(1);
  });

  it('scrolls down with down arrow', () => {
    const items = [makeItem({ description: 'line\n'.repeat(100) })];
    const state = new WorkItemListState(items, { rows: 24, cols: 80 });
    state.mode = 'detail';
    state.detailItem = items[0];
    handleKeypress(state, '\x1b[B', { rows: 24, cols: 80 });
    expect(state.detailScrollOffset).toBe(1);
  });

  it('scrolls up with k key', () => {
    const items = [makeItem({ description: 'line\n'.repeat(100) })];
    const state = new WorkItemListState(items, { rows: 24, cols: 80 });
    state.mode = 'detail';
    state.detailItem = items[0];
    state.detailScrollOffset = 5;
    handleKeypress(state, 'k', { rows: 24, cols: 80 });
    expect(state.detailScrollOffset).toBe(4);
  });

  it('scrolls up with up arrow', () => {
    const items = [makeItem({ description: 'line\n'.repeat(100) })];
    const state = new WorkItemListState(items, { rows: 24, cols: 80 });
    state.mode = 'detail';
    state.detailItem = items[0];
    state.detailScrollOffset = 5;
    handleKeypress(state, '\x1b[A', { rows: 24, cols: 80 });
    expect(state.detailScrollOffset).toBe(4);
  });

  it('handles page down in detail mode', () => {
    const items = [makeItem({ description: 'line\n'.repeat(100) })];
    const state = new WorkItemListState(items, { rows: 24, cols: 80 });
    state.mode = 'detail';
    state.detailItem = items[0];
    handleKeypress(state, '\x1b[6~', { rows: 24, cols: 80 });
    expect(state.detailScrollOffset).toBeGreaterThan(1);
  });

  it('handles page up in detail mode', () => {
    const items = [makeItem({ description: 'line\n'.repeat(100) })];
    const state = new WorkItemListState(items, { rows: 24, cols: 80 });
    state.mode = 'detail';
    state.detailItem = items[0];
    state.detailScrollOffset = 20;
    handleKeypress(state, '\x1b[5~', { rows: 24, cols: 80 });
    expect(state.detailScrollOffset).toBeLessThan(20);
  });

  it('goes to top with g in detail mode', () => {
    const items = [makeItem({ description: 'line\n'.repeat(100) })];
    const state = new WorkItemListState(items, { rows: 24, cols: 80 });
    state.mode = 'detail';
    state.detailItem = items[0];
    state.detailScrollOffset = 20;
    handleKeypress(state, 'g', { rows: 24, cols: 80 });
    expect(state.detailScrollOffset).toBe(0);
  });

  it('goes to bottom with G in detail mode', () => {
    const items = [makeItem({ description: 'line\n'.repeat(100) })];
    const state = new WorkItemListState(items, { rows: 24, cols: 80 });
    state.mode = 'detail';
    state.detailItem = items[0];
    handleKeypress(state, 'G', { rows: 24, cols: 80 });
    // Should scroll near the bottom
    expect(state.detailScrollOffset).toBeGreaterThan(50);
  });

  it('still quits from detail mode with q', () => {
    const items = [makeItem()];
    const state = new WorkItemListState(items, { rows: 24, cols: 80 });
    state.mode = 'detail';
    state.detailItem = items[0];
    const action = handleKeypress(state, 'q', { rows: 24, cols: 80 });
    expect(action).toBe('back');
    expect(state.mode).toBe('list');
  });

  it('still goes back from detail mode with escape', () => {
    const items = [makeItem()];
    const state = new WorkItemListState(items, { rows: 24, cols: 80 });
    state.mode = 'detail';
    state.detailItem = items[0];
    const action = handleKeypress(state, '\x1b', { rows: 24, cols: 80 });
    expect(action).toBe('back');
    expect(state.mode).toBe('list');
  });
});

describe('createListRenderer with scrollable detail', () => {
  it('passes detailScrollOffset to formatDetailView', () => {
    const item = makeItem({ description: 'line\n'.repeat(100) });
    const renderer = createListRenderer();
    const result = renderer(
      [item],
      0,
      0,
      { rows: 24, cols: 80 },
      null,
      'detail',
      item,
      undefined,
      undefined,
      5,
    );
    expect(result).toContain('scroll');
  });
});
