/**
 * Unit tests for WorkItemListState.refreshItems ID-preserving selection.
 *
 * Run: npx vitest run packages/herdr/src/worklist.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import {
  WorkItemListState,
  getTermSize,
  executeResolvedCommand,
  dispatchChordCommand,
  isImplementCommand,
  formatCodeFreezeDialog,
  ANSI,
  createListRenderer,
  renderDowntimeStatus,
  isChordLeader,
  processChordInput,
  createChordState,
  getChordHelpHints,
  handleKeypress,
  computeMetadataPanelHeight,
  formatMetadataPanel,
  formatTimestamp,
  buildMetaRows,
  resolveKeyFilePath,
  formatDetailContent,
  formatDetailView,
  fetchItemsForView,
  formatChordHintsForHelp,
  resolvePodcastTarget,
} from './worklist.js';
import type { ChordState } from './worklist.js';
import type { DowntimeWorker } from './downtime-worker.js';
import { setLogPath, resetLogPath, recordCommand, getLastCommand } from './command-log.js';
import { loadShortcutConfig, ShortcutRegistry, type ShortcutEntry } from './shortcut-config.js';
import { regroupWorkItems, extractFilePaths } from './grouping.js';
import { setWorklogDir, resetWorklogDir, setExecFileAsync, resetExecFileAsync, type WorkItem } from './fetcher.js';

// ── ANSI helpers ───────────────────────────────────────────────────────
// Regression test: the sync-failed status indicator uses ANSI.yellow
// (WL-0MS4FIUYS001K08K) but `yellow` was missing from the ANSI object,
// breaking `npm run build` (tsc) in packages/herdr.

describe('ANSI helpers', () => {
  it('defines yellow as a valid ANSI escape code', () => {
    expect(ANSI.yellow).toBe('\x1b[33m');
  });
});

/**
 * Build a minimal WorkItem with required fields.
 */
function makeItem(id: string, stage?: string): WorkItem {
  return { id, title: `Item ${id}`, status: 'open', stage };
}

/**
 * Default terminal size (80x24) for test stability.
 */
const TERM_80x24 = { rows: 24, cols: 80 };
getTermSize(); // verify the module loads

// ── Command-log isolation ───────────────────────────────────────────────
// Dispatch-path tests (executeResolvedCommand / dispatchChordCommand) record
// commands against work items via recordCommand(). Point the log at a temp
// file so the user's real ~/.config/herdr log is never touched
// (WL-0MSEPP104006PS7T).
beforeEach(() => {
  setLogPath(join(tmpdir(), `herdr-test-cmdlog-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`));
});
afterEach(() => {
  resetLogPath();
});

// ── Line-count invariant (WL-0MSAAON63003N6LO) ─────────────────────────
// The list renderer must never emit more than `rows - 1` lines (leaving the
// last row for the notification line appended by render()), otherwise the
// terminal scrolls the header/top items off the top of the pane.

describe('createListRenderer — line-count invariant', () => {
  const renderer = createListRenderer();

  it('renders at most rows - 1 lines with multiple group separators', () => {
    const grouped: WorkItem[] = Array.from({ length: 30 }, (_, i) => ({
      ...makeItem(`G${i}`),
      group: i,
      groupLabel: `Group ${i}`,
    }));
    const output = renderer(grouped, 0, 0, TERM_80x24, null, 'list', null);
    expect(output.split('\n').length).toBeLessThanOrEqual(TERM_80x24.rows - 1);
    expect(output).toContain('Work Items');
  });

  it('renders at most rows - 1 lines with no groups', () => {
    const items: WorkItem[] = [makeItem('A'), makeItem('B'), makeItem('C')];
    const output = renderer(items, 0, 0, TERM_80x24, null, 'list', null);
    expect(output.split('\n').length).toBeLessThanOrEqual(TERM_80x24.rows - 1);
    expect(output).toContain('Work Items');
  });

  it('renders at most rows - 1 lines for a short list', () => {
    const items: WorkItem[] = [makeItem('A')];
    const output = renderer(items, 0, 0, TERM_80x24, null, 'list', null);
    expect(output.split('\n').length).toBeLessThanOrEqual(TERM_80x24.rows - 1);
    expect(output).toContain('Work Items');
  });

  it('keeps render plus an active notification line within rows lines', () => {
    const items: WorkItem[] = [makeItem('A'), makeItem('B'), makeItem('C')];
    const output = renderer(items, 0, 0, TERM_80x24, null, 'list', null);
    // Simulate render()'s notification append (see runWorklistTui render()).
    const withNotification =
      output.split('\n').slice(0, TERM_80x24.rows - 1).join('\n') + '\n' + ' [Synced]';
    expect(withNotification.split('\n').length).toBeLessThanOrEqual(TERM_80x24.rows);
  });

  it('regression (WL-0MSAK8YLB0025EGW): renders exactly one In Review section, after Other', () => {
    // Simulated merged list: wl next results carry group metadata (including a
    // non-completed in_review item with an "In Review" label) while mandatory
    // wl list items (completed/in_review) carry none. After regroupWorkItems
    // the renderer must emit exactly one ── In Review ── separator, after Other.
    const merged: WorkItem[] = [
      { ...makeItem('NEXT-PLAN'), stage: 'plan_complete', priority: 'high', group: 2, groupLabel: 'Group 1' },
      { ...makeItem('NEXT-REVIEW'), stage: 'in_review', priority: 'medium', status: 'in-progress', group: 5, groupLabel: 'In Review' },
      { ...makeItem('NEXT-OTHER'), stage: 'custom', priority: 'medium', group: 3, groupLabel: 'Other' },
      // Mandatory wl list subsets — no group metadata.
      { ...makeItem('LIST-CRIT'), stage: 'plan_complete', priority: 'critical' },
      { ...makeItem('LIST-REV'), stage: 'in_review', priority: 'medium', status: 'completed' },
    ];
    const regrouped = regroupWorkItems(merged, 3);
    const output = renderer(regrouped, 0, 0, TERM_80x24, null, 'list', null);
    const inReviewSeparators = (output.match(/── In Review ──/g) ?? []).length;
    expect(inReviewSeparators).toBe(1);
    // In Review separator appears after the Other separator in the rendered output.
    expect(output.indexOf('── Other ──')).toBeGreaterThan(-1);
    expect(output.indexOf('── In Review ──')).toBeGreaterThan(output.indexOf('── Other ──'));
  });
});

// ── Filter chrome removal (WL-0MSGTSPXK007POB1) ────────────────────────
// The list mode no longer emits a blank line after the header/banner nor a
// standalone filter status bar; the active stage filter is indicated in the
// header only (via filterLabel). The two freed rows are given back to the
// item list (page size 11 → 13 on 80x24).

describe('createListRenderer — no blank line, no filter bar', () => {
  const renderer = createListRenderer();

  it('does not render a blank line between the header and the first item', () => {
    const output = renderer([makeItem('A'), makeItem('B'), makeItem('C')], 0, 0, TERM_80x24, null, 'list', null);
    const lines = output.split('\n');
    expect(lines[0]).toContain('Work Items');
    expect(lines[1].trim()).not.toBe('');
    expect(lines[1]).toContain('A');
  });

  it('does not render a blank line between the code-freeze banner and the first item', () => {
    const output = renderer(
      [makeItem('A'), makeItem('B')],
      0,
      0,
      TERM_80x24,
      null,
      'list',
      null,
      undefined,
      null,
      0,
      false,
      undefined,
      undefined,
      0,
      false,
      true, // codeFreezeActive
    );
    const lines = output.split('\n');
    expect(lines[0]).toContain('Work Items');
    expect(lines[1]).toContain('CODE FREEZE');
    expect(lines[2].trim()).not.toBe('');
    expect(lines[2]).toContain('A');
  });

  it('renders no standalone filter bar when unfiltered', () => {
    const output = renderer([makeItem('A')], 0, 0, TERM_80x24, null, 'list', null);
    expect(output).not.toContain('No filter');
    expect(output).not.toContain('press [f]');
  });

  it('renders no standalone filter bar when filtered (header carries the indication)', () => {
    const output = renderer([makeItem('A')], 0, 0, TERM_80x24, 'in_review', 'list', null);
    expect(output).not.toMatch(/Filter: /);
  });

  it('still indicates an active stage filter in the header', () => {
    const output = renderer([makeItem('A')], 0, 0, TERM_80x24, 'in_review', 'list', null);
    const firstLine = output.split('\n')[0];
    expect(firstLine).toContain('Work Items');
    expect(firstLine).toContain('(filtered: in_review)');
    const unfiltered = renderer([makeItem('A')], 0, 0, TERM_80x24, null, 'list', null);
    expect(unfiltered.split('\n')[0]).not.toContain('filtered:');
  });
});

describe('WorkItemListState.refreshItems — preserve selection by ID', () => {
  let items: WorkItem[];

  beforeEach(() => {
    items = [
      makeItem('A', 'idea'),
      makeItem('B', 'intake_complete'),
      makeItem('C', 'plan_complete'),
      makeItem('D', 'in_progress'),
    ];
  });

  it('preserves selection when items are reordered', () => {
    const state = new WorkItemListState(items, TERM_80x24);
    // Select item at index 1 (item 'B')
    state.selectedIndex = 1;
    expect(state.getFlattenedItems()[1].id).toBe('B');

    // Refresh with reordered items — 'B' moves to index 3
    const reordered = [
      makeItem('D', 'in_progress'),
      makeItem('C', 'plan_complete'),
      makeItem('A', 'idea'),
      makeItem('B', 'intake_complete'),
    ];
    state.refreshItems(reordered);

    // Selection should follow 'B' to its new position (index 3)
    expect(state.selectedIndex).toBe(3);
    expect(state.getFlattenedItems()[state.selectedIndex].id).toBe('B');
  });

  it('preserves selection when items are partially reordered', () => {
    const state = new WorkItemListState(items, TERM_80x24);
    // Select item at index 2 (item 'C')
    state.selectedIndex = 2;
    expect(state.getFlattenedItems()[2].id).toBe('C');

    // Refresh: new items array where only 'C' and 'D' swap places
    const reordered = [
      makeItem('A', 'idea'),
      makeItem('B', 'intake_complete'),
      makeItem('D', 'in_progress'),
      makeItem('C', 'plan_complete'),
    ];
    state.refreshItems(reordered);

    // 'C' moved from index 2 to index 3
    expect(state.selectedIndex).toBe(3);
    expect(state.getFlattenedItems()[state.selectedIndex].id).toBe('C');
  });

  it('falls back to clamping when selected item is removed', () => {
    const state = new WorkItemListState(items, TERM_80x24);
    // Select item at index 3 (item 'D')
    state.selectedIndex = 3;
    expect(state.getFlattenedItems()[3].id).toBe('D');

    // Refresh: remove 'D'
    const reduced = [
      makeItem('A', 'idea'),
      makeItem('B', 'intake_complete'),
      makeItem('C', 'plan_complete'),
    ];
    state.refreshItems(reduced);

    // Since selectedIndex was 3 and new flatCount is 3, clamp should set index to 2 (last)
    expect(state.selectedIndex).toBe(2);
    expect(state.getFlattenedItems()[2].id).toBe('C');
  });

  it('falls back to clamping when selected item is filtered out by active filter', () => {
    const state = new WorkItemListState(items, TERM_80x24);
    // Apply a filter for 'idea' stage
    state.applyFilter('idea');
    // After filter, only item 'A' (index 0) should be visible
    expect(state.getFlattenedItems().length).toBe(1);
    expect(state.getFlattenedItems()[0].id).toBe('A');

    // Select item 'A' (the only visible item)
    expect(state.selectedIndex).toBe(0);

    // Refresh with items where no item has stage 'idea'
    const noIdeaItems = [
      makeItem('B', 'intake_complete'),
      makeItem('C', 'plan_complete'),
      makeItem('D', 'in_progress'),
    ];
    state.refreshItems(noIdeaItems);

    // After refresh with filter active, no items match 'idea' filter.
    // The selected item 'A' is gone, so fall back to clamping.
    // _clampSelection sees flatCount=0, sets selectedIndex=0
    expect(state.selectedIndex).toBe(0);
    expect(state.getFlattenedItems().length).toBe(0);
  });

  it('handles empty list gracefully', () => {
    const state = new WorkItemListState(items, TERM_80x24);
    state.selectedIndex = 2;

    // Refresh with empty list
    state.refreshItems([]);

    expect(state.selectedIndex).toBe(0);
    expect(state.getFlattenedItems().length).toBe(0);
  });

  it('handles refresh with no previous selection (empty initial list)', () => {
    const state = new WorkItemListState([], TERM_80x24);
    expect(state.selectedIndex).toBe(0);

    // Refresh with new items
    state.refreshItems(items);

    // First item should be selected (clamp to index 0)
    expect(state.selectedIndex).toBe(0);
    expect(state.getFlattenedItems()[0].id).toBe('A');
  });

  it('preserves selection with expanded children after refresh', () => {
    // Create items with children
    const parentA = makeItem('PARENT-A', 'idea');
    parentA.children = [makeItem('CHILD-A1'), makeItem('CHILD-A2')];
    parentA.childCount = 2;

    const parentB = makeItem('PARENT-B', 'in_progress');
    parentB.children = [makeItem('CHILD-B1')];
    parentB.childCount = 1;

    const withChildren = [parentA, parentB];
    const state = new WorkItemListState(withChildren, TERM_80x24);

    // Expand parent A so children are visible in the flattened list
    state.toggleExpand('PARENT-A');

    // Flattened: [PARENT-A, CHILD-A1, CHILD-A2, PARENT-B]
    expect(state.getFlattenedItems().length).toBe(4);

    // Select CHILD-A1 (index 1)
    state.selectedIndex = 1;
    expect(state.getFlattenedItems()[1].id).toBe('CHILD-A1');

    // Refresh with reordered parents — swap Parent A and Parent B
    const reordered = [parentB, parentA];
    state.refreshItems(reordered);

    // After refresh, expanded state should be preserved via expandedItems Set.
    // So flattened: [PARENT-B, PARENT-A, CHILD-A1, CHILD-A2]
    // CHILD-A1 should be at index 2
    expect(state.selectedIndex).toBe(2);
    expect(state.getFlattenedItems()[state.selectedIndex].id).toBe('CHILD-A1');
  });

  it('keeps expanded children visible when refresh supplies new objects without children (production fetcher shape)', () => {
    // The production fetcher (normalizeItem) never populates `children` on
    // top-level items — each refresh returns NEW object references that only
    // carry childCount. This test models that shape (WL-0MSBVBNGH002RDP5).
    const parentA = makeItem('PARENT-A', 'idea');
    parentA.children = [makeItem('CHILD-A1'), makeItem('CHILD-A2')];
    parentA.childCount = 2;

    const parentB = makeItem('PARENT-B', 'in_progress');
    parentB.children = [makeItem('CHILD-B1')];
    parentB.childCount = 1;

    const state = new WorkItemListState([parentA, parentB], TERM_80x24);
    state.toggleExpand('PARENT-A');

    // Flattened: [PARENT-A, CHILD-A1, CHILD-A2, PARENT-B]
    expect(state.getFlattenedItems().length).toBe(4);
    expect(state.getFlattenedItems()[1].id).toBe('CHILD-A1');

    // Refresh with brand-new objects that LACK `children` — exactly what the
    // fetcher returns (children are fetched separately for expanded parents).
    const freshParentA = { ...makeItem('PARENT-A', 'idea'), childCount: 2 };
    const freshParentB = { ...makeItem('PARENT-B', 'in_progress'), childCount: 1 };
    state.refreshItems([freshParentB, freshParentA]);

    // Expanded children must remain in the flattened view — no momentary
    // collapse window after the swap.
    expect(state.getFlattenedItems().map((i) => i.id)).toEqual([
      'PARENT-B',
      'PARENT-A',
      'CHILD-A1',
      'CHILD-A2',
    ]);
  });

  it('restores selection on a child of an expanded parent after a children-less refresh', () => {
    // A selected CHILD must survive a refresh that swaps in children-less
    // objects (previously the new flattened list lost the child, so selection
    // jumped to the top of the list) — WL-0MSBVBNGH002RDP5 AC-4.
    const parentA = makeItem('PARENT-A', 'idea');
    parentA.children = [makeItem('CHILD-A1'), makeItem('CHILD-A2')];
    parentA.childCount = 2;

    const parentB = makeItem('PARENT-B', 'in_progress');
    parentB.childCount = 1;

    const state = new WorkItemListState([parentA, parentB], TERM_80x24);
    state.toggleExpand('PARENT-A');

    // Select CHILD-A1 (flattened index 1).
    state.selectedIndex = 1;
    expect(state.getFlattenedItems()[1].id).toBe('CHILD-A1');

    // Refresh with children-less NEW objects, reordered (B first).
    const freshParentA = { ...makeItem('PARENT-A', 'idea'), childCount: 2 };
    const freshParentB = { ...makeItem('PARENT-B', 'in_progress'), childCount: 1 };
    state.refreshItems([freshParentB, freshParentA]);

    // CHILD-A1 is still visible and selected (now flattened index 2 after
    // the reorder) — the selection followed the child, not the top of the list.
    expect(state.getFlattenedItems()[2].id).toBe('CHILD-A1');
    expect(state.getFlattenedItems()[state.selectedIndex].id).toBe('CHILD-A1');
  });

  it('does not overwrite fresh children already attached to the new objects (carry-over only fills gaps)', () => {
    // doRefresh attaches freshly fetched children to the new parent objects
    // BEFORE refreshItems; the carry-over must never clobber fresh data with
    // stale children (WL-0MSBVBNGH002RDP5 AC-3 freshness).
    const parentA = makeItem('PARENT-A', 'idea');
    parentA.children = [makeItem('CHILD-OLD')];
    parentA.childCount = 1;

    const state = new WorkItemListState([parentA], TERM_80x24);
    state.toggleExpand('PARENT-A');

    const freshParentA = { ...makeItem('PARENT-A', 'idea'), childCount: 1 };
    freshParentA.children = [makeItem('CHILD-FRESH')];
    state.refreshItems([freshParentA]);

    expect(state.getFlattenedItems().map((i) => i.id)).toEqual(['PARENT-A', 'CHILD-FRESH']);
  });

  it('does not carry children over for a parent that no longer exists after refresh', () => {
    const parentA = makeItem('PARENT-A', 'idea');
    parentA.children = [makeItem('CHILD-A1')];
    parentA.childCount = 1;

    const state = new WorkItemListState([parentA], TERM_80x24);
    state.toggleExpand('PARENT-A');
    expect(state.getFlattenedItems().length).toBe(2);

    // Refresh: PARENT-A is gone; only PARENT-B remains (no children).
    const freshParentB = { ...makeItem('PARENT-B', 'in_progress'), childCount: 0 };
    state.refreshItems([freshParentB]);

    // No orphan children may leak into the flattened view.
    expect(state.getFlattenedItems().map((i) => i.id)).toEqual(['PARENT-B']);
  });

  it('prefers the selected item ID over the collapsed child position', () => {
    // Test that when parent is collapsed and then refreshed with expanded
    // children, the same child ID is found in the new flattened list
    const itemC = makeItem('C', 'in_progress');
    itemC.children = [makeItem('CHILD-X')];
    itemC.childCount = 1;

    const startItems = [
      makeItem('A', 'idea'),
      itemC,
      makeItem('B', 'intake_complete'),
    ];
    const state = new WorkItemListState(startItems, TERM_80x24);

    // Select 'B' (index 2)
    state.selectedIndex = 2;
    expect(state.getFlattenedItems()[2].id).toBe('B');

    // Refresh with same items but reorder
    const reordered = [
      makeItem('B', 'intake_complete'),
      makeItem('A', 'idea'),
      itemC,
    ];
    state.refreshItems(reordered);

    // 'B' should be at index 0 after reorder
    expect(state.selectedIndex).toBe(0);
    expect(state.getFlattenedItems()[0].id).toBe('B');
  });
});

describe('nested expansion — 3+ level hierarchies (WL-0MSQ3FH1K000MMJW)', () => {
  /**
   * Build a 3-level hierarchy: EPIC → FEATURE → TASK. Children carry the
   * depth the fetcher assigns (fetchChildrenForItem), mirroring production
   * shape where grandchildren are fetched with depth = parent depth + 1.
   */
  function makeThreeLevelTree(): WorkItem[] {
    const epic = makeItem('EPIC', 'in_progress');
    const feature = {
      ...makeItem('FEATURE', 'in_progress'),
      depth: 1,
      childCount: 1,
      children: [{ ...makeItem('TASK', 'in_progress'), depth: 2 }],
    };
    epic.childCount = 1;
    epic.children = [feature];
    return [epic];
  }

  it('recursively flattens 3+ level hierarchies with correct depths', () => {
    const state = new WorkItemListState(makeThreeLevelTree(), TERM_80x24);

    // Only EPIC visible initially.
    expect(state.getFlattenedItems().map((i) => [i.id, i.depth])).toEqual([
      ['EPIC', undefined],
    ]);

    // Expand EPIC → FEATURE appears at depth 1; TASK stays hidden (FEATURE
    // not expanded yet).
    state.toggleExpand('EPIC');
    expect(state.getFlattenedItems().map((i) => [i.id, i.depth])).toEqual([
      ['EPIC', undefined],
      ['FEATURE', 1],
    ]);

    // Expand FEATURE → TASK appears at depth 2.
    state.toggleExpand('FEATURE');
    expect(state.getFlattenedItems().map((i) => [i.id, i.depth])).toEqual([
      ['EPIC', undefined],
      ['FEATURE', 1],
      ['TASK', 2],
    ]);
  });

  it('collapsing a child removes its grandchildren from the flattened list', () => {
    const state = new WorkItemListState(makeThreeLevelTree(), TERM_80x24);
    state.toggleExpand('EPIC');
    state.toggleExpand('FEATURE');
    expect(state.getFlattenedItems().map((i) => i.id)).toEqual(['EPIC', 'FEATURE', 'TASK']);

    state.toggleExpand('FEATURE');
    expect(state.getFlattenedItems().map((i) => i.id)).toEqual(['EPIC', 'FEATURE']);
  });

  it('collapsing an ancestor removes the entire nested subtree', () => {
    const state = new WorkItemListState(makeThreeLevelTree(), TERM_80x24);
    state.toggleExpand('EPIC');
    state.toggleExpand('FEATURE');

    state.toggleExpand('EPIC');
    expect(state.getFlattenedItems().map((i) => i.id)).toEqual(['EPIC']);
  });

  it('Enter (select) on a child with children toggles expansion instead of opening the detail view', () => {
    const state = new WorkItemListState(makeThreeLevelTree(), TERM_80x24);
    state.toggleExpand('EPIC');
    // Select FEATURE (flattened index 1).
    state.selectedIndex = 1;
    expect(state.getFlattenedItems()[1].id).toBe('FEATURE');

    const action = handleKeypress(state, '\r', TERM_80x24);

    // Enter toggles expansion — never opens the detail view.
    expect(action).toBe('toggle-expand');
    expect(state.mode).toBe('list');
    expect(state.isExpanded('FEATURE')).toBe(true);
    expect(state.getFlattenedItems().map((i) => i.id)).toEqual(['EPIC', 'FEATURE', 'TASK']);
  });

  it('Enter on a child toggles back to collapsed on the second press', () => {
    const state = new WorkItemListState(makeThreeLevelTree(), TERM_80x24);
    state.toggleExpand('EPIC');
    state.selectedIndex = 1; // FEATURE
    handleKeypress(state, '\r', TERM_80x24); // expand
    handleKeypress(state, '\r', TERM_80x24); // collapse
    expect(state.isExpanded('FEATURE')).toBe(false);
    expect(state.getFlattenedItems().map((i) => i.id)).toEqual(['EPIC', 'FEATURE']);
  });

  it('Tab on a child with childCount > 0 returns toggle-expand even when children not yet loaded', () => {
    // FEATURE has childCount but NO children array yet (production shape:
    // grandchildren are fetched on demand when first expanded).
    const epic = makeItem('EPIC');
    epic.childCount = 1;
    epic.children = [{ ...makeItem('FEATURE'), depth: 1, childCount: 2 }];
    const state = new WorkItemListState([epic], TERM_80x24);
    state.toggleExpand('EPIC');
    state.selectedIndex = 1; // FEATURE

    const action = handleKeypress(state, '\t', TERM_80x24);
    expect(action).toBe('toggle-expand');
  });

  it('Tab on an item without children returns null (no toggle, no crash)', () => {
    const epic = makeItem('EPIC');
    epic.childCount = 1;
    epic.children = [{ ...makeItem('FEATURE'), depth: 1 }]; // no childCount
    const state = new WorkItemListState([epic], TERM_80x24);
    state.toggleExpand('EPIC');
    state.selectedIndex = 1; // FEATURE

    expect(handleKeypress(state, '\t', TERM_80x24)).toBeNull();
  });

  it('getItemDepth reports the hierarchy position (0 = top-level)', () => {
    const state = new WorkItemListState(makeThreeLevelTree(), TERM_80x24);
    expect(state.getItemDepth('EPIC')).toBe(0);
    expect(state.getItemDepth('FEATURE')).toBe(1);
    expect(state.getItemDepth('TASK')).toBe(2);
    // Unknown IDs default to 0 (safe fetch depth).
    expect(state.getItemDepth('UNKNOWN')).toBe(0);
  });

  it('attachChildren attaches fetched children to the live tree object at any depth', () => {
    const state = new WorkItemListState(makeThreeLevelTree(), TERM_80x24);
    const freshGrandchild = { ...makeItem('TASK2'), depth: 2 };
    state.attachChildren('FEATURE', [freshGrandchild]);

    // The tree object (not a flattened copy) received the children.
    const epic = state.items[0];
    const feature = epic.children![0];
    expect(feature.children).toEqual([freshGrandchild]);
    // And the flattened view renders them once FEATURE is expanded.
    state.toggleExpand('EPIC');
    state.toggleExpand('FEATURE');
    expect(state.getFlattenedItems().map((i) => i.id)).toEqual(['EPIC', 'FEATURE', 'TASK2']);
  });

  it('nested expanded state survives refreshItems (carry-over restores the subtree)', () => {
    const state = new WorkItemListState(makeThreeLevelTree(), TERM_80x24);
    state.toggleExpand('EPIC');
    state.toggleExpand('FEATURE');

    // Refresh with a children-less EPIC (production fetcher shape): the
    // carried-over subtree must keep TASK visible.
    const freshEpic = { ...makeItem('EPIC'), childCount: 1 };
    state.refreshItems([freshEpic]);

    expect(state.getFlattenedItems().map((i) => i.id)).toEqual(['EPIC', 'FEATURE', 'TASK']);
  });
});

describe('executeResolvedCommand', () => {
  it('returns noop when command has <id> but no items', () => {
    const state = new WorkItemListState([], TERM_80x24);
    const result = executeResolvedCommand('wl update <id> --priority high', state);
    expect(result).toBe('noop');
  });

  it('returns callback when command is routed to onCommand', () => {
    const state = new WorkItemListState([makeItem('A')], TERM_80x24);
    state.selectedIndex = 0;
    const onCommand = vi.fn();
    const result = executeResolvedCommand('echo hello', state, onCommand);
    expect(result).toBe('callback');
    expect(onCommand).toHaveBeenCalledWith('echo hello', undefined);
  });

  it('resolves <id> placeholder when item is selected', () => {
    const state = new WorkItemListState([makeItem('TEST-123')], TERM_80x24);
    state.selectedIndex = 0;
    const onCommand = vi.fn();
    executeResolvedCommand('wl update <id> --priority high', state, onCommand);
    expect(onCommand).toHaveBeenCalledWith('wl update TEST-123 --priority high', undefined);
  });

  it('returns dispatched for /wl commands handled internally', () => {
    const state = new WorkItemListState([makeItem('A')], TERM_80x24);
    const onCommand = vi.fn();
    const result = executeResolvedCommand('/wl idea', state, onCommand);
    expect(result).toBe('dispatched');
    expect(state.activeFilter).toBe('idea');
  });

  it('routes unknown /wl stage arguments to the callback (error notification, no crash)', () => {
    const state = new WorkItemListState([makeItem('A')], TERM_80x24);
    const onCommand = vi.fn();
    const result = executeResolvedCommand('/wl bogus', state, onCommand);
    expect(result).toBe('callback');
    expect(onCommand).toHaveBeenCalledWith('/wl bogus', undefined);
    expect(state.activeFilter).toBeNull();
  });

  it('returns dispatched for /wl with no arguments and clears the filter (sprint)', () => {
    const state = new WorkItemListState([makeItem('A', 'idea')], TERM_80x24);
    state.applyFilter('idea');
    const onCommand = vi.fn();
    const result = executeResolvedCommand('/wl', state, onCommand);
    expect(result).toBe('dispatched');
    expect(state.activeFilter).toBeNull();
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('returns dispatched for /skill:implement with resolved <id>', () => {
    const state = new WorkItemListState([makeItem('TEST-123')], TERM_80x24);
    state.selectedIndex = 0;
    const onCommand = vi.fn();
    const result = executeResolvedCommand('/skill:implement <id>', state, onCommand);
    expect(result).toBe('dispatched');
    expect(onCommand).toHaveBeenCalledWith('/skill:implement TEST-123', undefined);
  });

  it('propagates error from onCommand callback', () => {
    const state = new WorkItemListState([makeItem('A')], TERM_80x24);
    state.selectedIndex = 0;
    const failingCommand = () => {
      throw new Error('mock command failure');
    };
    expect(() => executeResolvedCommand('echo hello', state, failingCommand)).toThrow('mock command failure');
  });

  it('returns noop for command without <id> but no onCommand', () => {
    const state = new WorkItemListState([], TERM_80x24);
    const result = executeResolvedCommand('echo hello', state);
    expect(result).toBe('callback');
  });
});

describe('dispatchChordCommand', () => {
  it('handles /wl stage filter commands internally', () => {
    const state = new WorkItemListState([makeItem('A', 'idea')], TERM_80x24);
    const result = dispatchChordCommand('/wl review', state);
    expect(result).toBe(true);
    expect(state.activeFilter).toBe('in_review');
  });

  it('accepts canonical stage names and the progress alias for /wl commands', () => {
    const state = new WorkItemListState([makeItem('A', 'idea')], TERM_80x24);
    expect(dispatchChordCommand('/wl progress', state)).toBe(true);
    expect(state.activeFilter).toBe('in_progress');
    expect(dispatchChordCommand('/wl intake_complete', state)).toBe(true);
    expect(state.activeFilter).toBe('intake_complete');
    expect(dispatchChordCommand('/wl plan_complete', state)).toBe(true);
    expect(state.activeFilter).toBe('plan_complete');
    expect(dispatchChordCommand('/wl in_review', state)).toBe(true);
    expect(state.activeFilter).toBe('in_review');
  });

  it('leaves unknown /wl stage arguments unhandled (no crash, no filter)', () => {
    const state = new WorkItemListState([makeItem('A', 'idea')], TERM_80x24);
    const result = dispatchChordCommand('/wl bogus', state);
    expect(result).toBe(false);
    expect(state.activeFilter).toBeNull();
  });

  it('clears the stage filter for /wl with no arguments (sprint, WL-0MSGSE15000746F7)', () => {
    const state = new WorkItemListState([makeItem('A', 'idea')], TERM_80x24);
    state.applyFilter('idea');
    expect(state.activeFilter).toBe('idea');
    const result = dispatchChordCommand('/wl', state);
    expect(result).toBe(true);
    expect(state.activeFilter).toBeNull();
  });

  it('shows the sprint chord in the f-chord help line (WL-0MSGSE15000746F7)', () => {
    const registry = loadShortcutConfig();
    const chords = registry.getChordByPrefix(['f'], 'list', undefined, false);
    const hints = formatChordHintsForHelp(chords, ['f']);
    expect(hints).toContain('s:sprint');
  });

  it('routes agent commands through onCommand', () => {
    const state = new WorkItemListState([makeItem('TEST-123')], TERM_80x24);
    state.selectedIndex = 0;
    const onCommand = vi.fn();
    const result = dispatchChordCommand('/skill:audit <id>', state, onCommand);
    expect(result).toBe(true);
    expect(onCommand).toHaveBeenCalledWith('/skill:audit TEST-123', undefined);
  });

  it('routes !!wl reviewed producer-review commands through onCommand', () => {
    const state = new WorkItemListState([makeItem('TEST-123')], TERM_80x24);
    state.selectedIndex = 0;
    const onCommand = vi.fn();
    const result = dispatchChordCommand(
      "!!wl reviewed <id> && wl comment add <id> --body '<producer_comment>'",
      state,
      onCommand,
    );
    expect(result).toBe(true);
    expect(onCommand).toHaveBeenCalledWith(
      "!!wl reviewed TEST-123 && wl comment add TEST-123 --body '<producer_comment>'",
      undefined,
    );
  });

  it('routes a-y audit-approve compound commands through onCommand', () => {
    const state = new WorkItemListState([makeItem('TEST-123')], TERM_80x24);
    state.selectedIndex = 0;
    const onCommand = vi.fn();
    const result = dispatchChordCommand(
      "!!wl reviewed <id> false && wl audit-set <id> --ready-to-close yes --summary 'Approved by manual review'",
      state,
      onCommand,
    );
    expect(result).toBe(true);
    expect(onCommand).toHaveBeenCalledWith(
      "!!wl reviewed TEST-123 false && wl audit-set TEST-123 --ready-to-close yes --summary 'Approved by manual review'",
      undefined,
    );
  });

  it('routes a-r audit-reject compound commands through onCommand', () => {
    const state = new WorkItemListState([makeItem('TEST-123')], TERM_80x24);
    state.selectedIndex = 0;
    const onCommand = vi.fn();
    const result = dispatchChordCommand(
      "!!wl reviewed <id> false && wl audit-set <id> --ready-to-close no --summary 'Rejected by manual review. <reason>'",
      state,
      onCommand,
    );
    expect(result).toBe(true);
    expect(onCommand).toHaveBeenCalledWith(
      "!!wl reviewed TEST-123 false && wl audit-set TEST-123 --ready-to-close no --summary 'Rejected by manual review. <reason>'",
      undefined,
    );
  });

  it('returns false for unknown commands', () => {
    const state = new WorkItemListState([makeItem('A')], TERM_80x24);
    state.selectedIndex = 0;
    const result = dispatchChordCommand('unknown command', state);
    expect(result).toBe(false);
  });

  it('routes /skill:ship release through onCommand with no <id> substitution (WL-0MSGG5N5Z0074TLY)', () => {
    const state = new WorkItemListState([makeItem('WL-TEST-1')], TERM_80x24);
    state.selectedIndex = 0;
    const onCommand = vi.fn();
    const result = dispatchChordCommand('/skill:ship release', state, onCommand);
    expect(result).toBe(true);
    // The release command is a global dev→main release — the command is
    // routed verbatim, never rewritten with the selected item's id.
    expect(onCommand).toHaveBeenCalledWith('/skill:ship release', undefined);
    expect(onCommand).toHaveBeenCalledTimes(1);
  });

  it('routes /skill:ship release even with no item selected (global command)', () => {
    const state = new WorkItemListState([], TERM_80x24);
    const onCommand = vi.fn();
    const result = dispatchChordCommand('/skill:ship release', state, onCommand);
    expect(result).toBe(true);
    expect(onCommand).toHaveBeenCalledWith('/skill:ship release', undefined);
  });

  it('executeResolvedCommand dispatches /skill:ship release via the standard path', () => {
    const state = new WorkItemListState([makeItem('WL-TEST-1')], TERM_80x24);
    state.selectedIndex = 0;
    const onCommand = vi.fn();
    const result = executeResolvedCommand('/skill:ship release', state, onCommand);
    expect(result).toBe('dispatched');
    expect(onCommand).toHaveBeenCalledWith('/skill:ship release', undefined);
  });

  it('does not block /skill:ship release during a Code Freeze (ship skill gates itself)', () => {
    const state = new WorkItemListState([makeItem('WL-TEST-1')], TERM_80x24);
    state.selectedIndex = 0;
    const onCommand = vi.fn();
    const result = executeResolvedCommand('/skill:ship release', state, onCommand, true);
    expect(result).toBe('dispatched');
    expect(onCommand).toHaveBeenCalledWith('/skill:ship release', undefined);
  });
});

describe('fetchItemsForView — stage-filtered fetch', () => {
  beforeEach(() => {
    resetExecFileAsync();
  });

  it('fetches all open root items in the stage when a filter is active', async () => {
    const stageItems = [makeItem('A', 'idea'), makeItem('B', 'idea')];
    const mockFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ workItems: stageItems }),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);
    const defaultFetcher = vi.fn().mockResolvedValue([makeItem('C')]);

    const items = await fetchItemsForView('idea', defaultFetcher);

    expect(items.map((i) => i.id)).toEqual(['A', 'B']);
    expect(defaultFetcher).not.toHaveBeenCalled();
    const callArgs = mockFn.mock.calls[0][1] as string[];
    expect(callArgs).toContain('list');
    expect(callArgs[callArgs.indexOf('--status') + 1]).toBe('open');
    expect(callArgs[callArgs.indexOf('--stage') + 1]).toBe('idea');
    expect(callArgs).toContain('--root-only');
  });

  it('fetches completed/in-progress items for the in_review stage', async () => {
    // in_review items carry status completed (submitted for review) or
    // in-progress (being re-worked after review feedback) per the project
    // workflow — restricting to status=open would empty the review queue
    // (WL-0MSKCRX730052IIW).
    const stageItems = [
      { ...makeItem('A', 'in_review'), status: 'completed' },
      { ...makeItem('B', 'in_review'), status: 'in-progress' },
    ];
    const mockFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ workItems: stageItems }),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);
    const defaultFetcher = vi.fn().mockResolvedValue([makeItem('C')]);

    const items = await fetchItemsForView('in_review', defaultFetcher);

    expect(items.map((i) => i.id)).toEqual(['A', 'B']);
    expect(defaultFetcher).not.toHaveBeenCalled();
    const callArgs = mockFn.mock.calls[0][1] as string[];
    expect(callArgs).toContain('list');
    const statusArg = callArgs[callArgs.indexOf('--status') + 1];
    expect(statusArg).toContain('completed');
    expect(statusArg).toContain('in-progress');
    expect(callArgs[callArgs.indexOf('--stage') + 1]).toBe('in_review');
    expect(callArgs).toContain('--root-only');
  });

  it('uses the default fetcher when no filter is active', async () => {
    const defaultFetcher = vi.fn().mockResolvedValue([makeItem('C')]);
    const items = await fetchItemsForView(null, defaultFetcher);
    expect(items.map((i) => i.id)).toEqual(['C']);
    expect(defaultFetcher).toHaveBeenCalledTimes(1);
  });

  it('falls back to the default fetcher when the stage fetch fails', async () => {
    const mockFn = vi.fn().mockRejectedValue(new Error('wl failed'));
    setExecFileAsync(mockFn as any);
    const defaultFetcher = vi.fn().mockResolvedValue([makeItem('C')]);

    const items = await fetchItemsForView('idea', defaultFetcher);
    expect(items.map((i) => i.id)).toEqual(['C']);
  });

  it('applies the in_review stage filter client-side regardless of status', () => {
    // Client-side filter (_applyFilters) matches on stage only — items are
    // already status-filtered at fetch time, so completed/in-progress
    // in_review items must survive the client-side pass (WL-0MSKCRX730052IIW).
    const items = [
      { ...makeItem('A', 'in_review'), status: 'completed' },
      { ...makeItem('B', 'in_review'), status: 'in-progress' },
      makeItem('C', 'idea'),
    ];
    const state = new WorkItemListState(items, TERM_80x24);
    state.applyFilter('in_review');
    expect(state.getFlattenedItems().map((i) => i.id)).toEqual(['A', 'B']);
  });
});

describe('Chord-complete error notification handling', () => {
  it('tests that executeResolvedCommand noop is returned correctly when no item selected', () => {
    // This tests the underlying behavior that the chord-complete handler
    // relies on: when there's no selected item and the command uses <id>,
    // executeResolvedCommand returns 'noop' so the chord handler can show
    // appropriate feedback instead of misleading "Sent: ..."
    const state = new WorkItemListState([], TERM_80x24);
    const result = executeResolvedCommand('wl update <id> --priority high', state);
    expect(result).toBe('noop');
  });
});

// ── Code Freeze: implement-command blocking ──────────────────────────────
// When the project is in Code Freeze (ship release in progress) the plugin
// must NOT route /skill:implement commands to the pi agent pane. All other
// commands keep working. See WL-0MSBU4KMA004PKSR.

describe('executeResolvedCommand — code freeze blocking', () => {
  const makeFrozen = () => {
    const state = new WorkItemListState([makeItem('TEST-123')], TERM_80x24);
    state.selectedIndex = 0;
    return state;
  };

  it('blocks /skill:implement when freeze is active (returns blocked, no onCommand)', () => {
    const state = makeFrozen();
    const onCommand = vi.fn();
    const result = executeResolvedCommand('/skill:implement <id>', state, onCommand, true);
    expect(result).toBe('blocked');
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('blocks /skill:implement-single when freeze is active', () => {
    const state = makeFrozen();
    const onCommand = vi.fn();
    const result = executeResolvedCommand('/skill:implement-single <id>', state, onCommand, true);
    expect(result).toBe('blocked');
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('does not resolve <id> or mutate state when blocked', () => {
    const state = makeFrozen();
    const onCommand = vi.fn();
    executeResolvedCommand('/skill:implement <id>', state, onCommand, true);
    expect(onCommand).not.toHaveBeenCalled();
    expect(state.mode).toBe('list'); // no selection/detail side effects
  });

  it('routes /skill:implement normally when freeze is inactive (default)', () => {
    const state = makeFrozen();
    const onCommand = vi.fn();
    const result = executeResolvedCommand('/skill:implement <id>', state, onCommand);
    expect(result).toBe('dispatched');
    expect(onCommand).toHaveBeenCalledWith('/skill:implement TEST-123', undefined);
  });

  it('routes /skill:implement normally when freeze is explicitly false', () => {
    const state = makeFrozen();
    const onCommand = vi.fn();
    const result = executeResolvedCommand('/skill:implement <id>', state, onCommand, false);
    expect(result).toBe('dispatched');
    expect(onCommand).toHaveBeenCalledWith('/skill:implement TEST-123', undefined);
  });

  it('does not block non-implement commands during a freeze', () => {
    const state = makeFrozen();
    const onCommand = vi.fn();
    const auditResult = executeResolvedCommand('/skill:audit <id>', state, onCommand, true);
    expect(auditResult).toBe('dispatched');
    expect(onCommand).toHaveBeenCalledWith('/skill:audit TEST-123', undefined);
  });

  it('does not block wl / intake / plan commands during a freeze', () => {
    const state = makeFrozen();
    const onCommand = vi.fn();
    expect(executeResolvedCommand('/intake <id>', state, onCommand, true)).toBe('dispatched');
    expect(executeResolvedCommand('/plan <id>', state, onCommand, true)).toBe('dispatched');
    expect(executeResolvedCommand('!!wl update <id> --priority high', state, onCommand, true)).toBe('callback');
    expect(onCommand).toHaveBeenCalledTimes(3);
  });
});

describe('isImplementCommand', () => {
  it('matches /skill:implement prefixes', () => {
    expect(isImplementCommand('/skill:implement <id>')).toBe(true);
    expect(isImplementCommand('/skill:implement')).toBe(true);
    expect(isImplementCommand('/skill:implement-single <id>')).toBe(true);
    expect(isImplementCommand('/skill:implementall <id>')).toBe(true);
  });

  it('does not match other agent commands', () => {
    expect(isImplementCommand('/skill:audit <id>')).toBe(false);
    expect(isImplementCommand('/intake <id>')).toBe(false);
    expect(isImplementCommand('/plan <id>')).toBe(false);
    expect(isImplementCommand('!!wl reviewed <id>')).toBe(false);
  });
});

// ── Code Freeze: shortcut registry integration (WL-0MSD81VEL009XHWA) ─────
// The `i` / /skill:implement entry in the REAL shortcuts.json is marked
// `code_freeze: "block"`, so during a freeze it is filtered from the registry:
// it is not a chord leader, does not resolve via processChordInput, and is
// omitted from help hints.

describe('code-freeze shortcut filtering — worklist integration', () => {
  let registry: ShortcutRegistry;

  beforeEach(() => {
    registry = loadShortcutConfig();
  });

  it('does not treat i as a chord leader during a freeze', () => {
    expect(isChordLeader('i', registry, true)).toBe(false);
    expect(isChordLeader('i', registry, false)).toBe(true);
  });

  it('does not resolve the i chord via processChordInput during a freeze', () => {
    const chordState = createChordState();
    chordState.pendingKeys = ['i'];
    const result = processChordInput(chordState, 'i', registry, 'list', undefined, true);
    expect(result).not.toBe('chord-complete');
    expect(chordState.resolvedCommand).toBeNull();
  });

  it('omits blocked shortcuts from chord help hints during a freeze', () => {
    // getChordHelpHints only lists multi-key chord leaders, so use a
    // synthetic registry with a blocked multi-key chord to observe filtering.
    const multi = new ShortcutRegistry([
      { chord: ['i', 'x'], command: '/skill:implement <id>', view: 'both', codeFreeze: 'block' },
      { chord: ['a', 'a'], command: '/skill:audit <id>', view: 'both' },
    ]);
    const hints = getChordHelpHints(multi, true);
    expect(hints).not.toContain('i');
    expect(hints).toContain('a');
    const normalHints = getChordHelpHints(multi, false);
    expect(normalHints).toContain('i');
  });

  it('omits blocked shortcuts from stage entries used for footer hints during a freeze', () => {
    const entries = registry.getEntriesForStage('plan_complete', true);
    expect(entries.some(e => e.chord[0] === 'i')).toBe(false);
    const normalEntries = registry.getEntriesForStage('plan_complete', false);
    expect(normalEntries.some(e => e.chord[0] === 'i')).toBe(true);
  });
});

// ── Issue-type shortcut filtering — worklist integration (WL-0MSKH1J0R003BM2M)
//
// The selected work item's issueType is threaded into the shortcut lookup and
// hint paths so a type-gated chord (e.g. a project-local `w` bound to
// `wiki-podcast-script` for `podcast` items) is hidden on non-matching types,
// and the bundled code-workflow chords n/p/i are hidden on podcast items.

describe('issue-type shortcut filtering — worklist integration', () => {
  let registry: ShortcutRegistry;

  beforeEach(() => {
    registry = loadShortcutConfig();
  });

  it('treats i as a chord leader only for code and docs item types', () => {
    expect(isChordLeader('i', registry, false, 'feature')).toBe(true);
    expect(isChordLeader('i', registry, false, 'docs')).toBe(true);
    expect(isChordLeader('i', registry, false, 'podcast')).toBe(false);
  });

  it('treats n and p as chord leaders only for code item types', () => {
    expect(isChordLeader('n', registry, false, 'bug')).toBe(true);
    expect(isChordLeader('n', registry, false, 'podcast')).toBe(false);
    expect(isChordLeader('p', registry, false, 'task')).toBe(true);
    expect(isChordLeader('p', registry, false, 'podcast')).toBe(false);
  });

  it('keeps generic chords as leaders on every type', () => {
    expect(isChordLeader('r', registry, false, 'podcast')).toBe(true);
    expect(isChordLeader('c', registry, false, 'podcast')).toBe(true);
    expect(isChordLeader('s', registry, false, 'podcast')).toBe(true);
    expect(isChordLeader('a', registry, false, 'podcast')).toBe(true);
    expect(isChordLeader('u', registry, false, 'podcast')).toBe(true);
  });

  it('does not resolve the i chord via processChordInput on a podcast item', () => {
    const chordState = createChordState();
    chordState.pendingKeys = ['i'];
    const result = processChordInput(chordState, 'i', registry, 'list', 'plan_complete', false, 'podcast');
    expect(result).toBe('chord-cancel');
    expect(chordState.resolvedCommand).toBeNull();
  });

  it('resolves the i chord via processChordInput on a code item', () => {
    const chordState = createChordState();
    const result = processChordInput(chordState, 'i', registry, 'list', 'plan_complete', false, 'feature');
    expect(result).toBe('chord-complete');
    expect(chordState.resolvedCommand).toBe('/skill:implement <id>');
  });

  it('omits code-workflow chords from stage entries used for footer hints on podcast items', () => {
    const podcastEntries = registry.getEntriesForStage('plan_complete', false, 'podcast');
    expect(podcastEntries.some(e => e.chord[0] === 'i')).toBe(false);
    expect(podcastEntries.some(e => e.chord[0] === 'p')).toBe(false);
    const codeEntries = registry.getEntriesForStage('plan_complete', false, 'feature');
    expect(codeEntries.some(e => e.chord[0] === 'i')).toBe(true);
  });

  it('keeps generic housekeeping chords in footer hints on podcast items', () => {
    const podcastEntries = registry.getEntriesForStage('in_review', false, 'podcast');
    const chords = podcastEntries.map(e => e.chord.join(''));
    expect(chords).toContain('aa');
    expect(chords).toContain('ay');
    expect(chords).toContain('ar');
    expect(chords).toContain('r');
  });

  it('excludes a type-gated local chord on non-matching types via the merged registry', () => {
    // A project-local podcast-gated chord merges over the bundled defaults;
    // verify the merged registry honors the gating per item type.
    const root = mkdtempSync(join(tmpdir(), 'herdr-issue-type-'));
    try {
      writeFileSync(join(root, 'shortcuts.json'), JSON.stringify([
        { chord: ['w'], command: '/skill:wiki-podcast-script <id>', view: 'both', label: 'write script', work_item_types: ['podcast'] },
      ]));
      const merged = loadShortcutConfig(root);
      expect(merged.lookupChord(['w'], 'list', undefined, false, 'podcast')).toBe('/skill:wiki-podcast-script <id>');
      expect(merged.lookupChord(['w'], 'list', undefined, false, 'feature')).toBeUndefined();
      // Bundled code chords still gated by type in the merged registry.
      expect(merged.lookupChord(['i'], 'list', undefined, false, 'feature')).toBe('/skill:implement <id>');
      expect(merged.lookupChord(['i'], 'list', undefined, false, 'podcast')).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── Podcast-progression dispatch (OSL-0MSKFXM380098LFL / OSL-0MSHFQ51L009IUOS)
//
// The project-local `w` (wiki-podcast-script) and `t` (wiki-tts-generate)
// chords use `<podcast-target>` / `<podcast-script>` markers resolved from
// the selected item's `Key Files:` + lifecycle context at dispatch time.

describe('resolvePodcastTarget — podcast-progression dispatch', () => {
  const sourcedItem: WorkItem = {
    id: 'OSL-1',
    title: 'Episode',
    status: 'open',
    stage: 'intake_complete',
    issueType: 'podcast',
    description: '## Key Files:\n- wiki/syntheses/foo.md\n',
  };

  const draftedItem: WorkItem = {
    id: 'OSL-2',
    title: 'Episode',
    status: 'open',
    stage: 'in_review',
    issueType: 'podcast',
    description: '## Key Files:\n- foo/foo.podcast.md\n',
  };

  const noKeyFilesItem: WorkItem = {
    id: 'OSL-3',
    title: 'Episode',
    status: 'open',
    stage: 'intake_complete',
    issueType: 'podcast',
    description: 'No key files here.',
  };

  it('returns the command unchanged when it carries no podcast markers', async () => {
    const result = await resolvePodcastTarget('/skill:audit <id>', sourcedItem);
    expect(result).toEqual({ command: '/skill:audit <id>' });
  });

  it('errors when no item is selected', async () => {
    const result = await resolvePodcastTarget('/skill:wiki-podcast-script <podcast-target>', null);
    expect(result.error).toMatch(/no work item selected/i);
    expect(result.command).toBeUndefined();
  });

  it('resolves <podcast-target> to --doc --force-single on sourced episodes', async () => {
    const result = await resolvePodcastTarget('/skill:wiki-podcast-script <podcast-target>', sourcedItem);
    expect(result).toEqual({ command: '/skill:wiki-podcast-script --doc wiki/syntheses/foo.md --force-single' });
  });

  it('errors on a sourced episode with no synthesis in Key Files', async () => {
    const result = await resolvePodcastTarget('/skill:wiki-podcast-script <podcast-target>', noKeyFilesItem);
    expect(result.error).toMatch(/no source synthesis/i);
  });

  it('resolves <podcast-target> to --rewrite when open note children exist', async () => {
    const children = [
      { id: 'OSL-2-N1', title: 'Note', status: 'open' } as WorkItem,
      { id: 'OSL-2-N2', title: 'Done note', status: 'completed' } as WorkItem,
    ];
    const result = await resolvePodcastTarget('/skill:wiki-podcast-script <podcast-target>', draftedItem, async () => children);
    expect(result).toEqual({ command: '/skill:wiki-podcast-script --rewrite foo/foo.podcast.md' });
  });

  it('belt-and-braces: errors when a script exists but there are no open notes', async () => {
    const children = [
      { id: 'OSL-2-N2', title: 'Done note', status: 'completed' } as WorkItem,
    ];
    const result = await resolvePodcastTarget('/skill:wiki-podcast-script <podcast-target>', draftedItem, async () => children);
    expect(result.error).toMatch(/already present/);
    expect(result.command).toBeUndefined();
  });

  it('errors when rewrite is requested but no script is in Key Files', async () => {
    const noScriptItem: WorkItem = { ...draftedItem, description: '## Key Files:\n- wiki/syntheses/foo.md\n' };
    const result = await resolvePodcastTarget('/skill:wiki-podcast-script <podcast-target>', noScriptItem, async () => [
      { id: 'X', title: 'Note', status: 'open' } as WorkItem,
    ]);
    expect(result.error).toMatch(/no podcast script/i);
  });

  it('resolves <podcast-script> to a wiki-dir-relative podcast file path', async () => {
    const result = await resolvePodcastTarget('/skill:wiki-tts-generate --podcast-file <podcast-script>', draftedItem);
    expect(result).toEqual({ command: '/skill:wiki-tts-generate --podcast-file podcast/foo/foo.podcast.md' });
  });

  it('keeps an already-wiki-relative <podcast-script> path as-is', async () => {
    const wikiItem: WorkItem = { ...draftedItem, description: '## Key Files:\n- wiki/podcast/foo/foo.podcast.md\n' };
    const result = await resolvePodcastTarget('/skill:wiki-tts-generate --podcast-file <podcast-script>', wikiItem);
    expect(result).toEqual({ command: '/skill:wiki-tts-generate --podcast-file wiki/podcast/foo/foo.podcast.md' });
  });

  it('errors on <podcast-script> when no script exists', async () => {
    const result = await resolvePodcastTarget('/skill:wiki-tts-generate --podcast-file <podcast-script>', sourcedItem);
    expect(result.error).toMatch(/no podcast script/i);
  });

  it('errors on <podcast-script> for a synthesis-only episode (script must exist first)', async () => {
    const synthItem: WorkItem = { ...sourcedItem, description: '## Key Files:\n- wiki/syntheses/foo.md\n' };
    const result = await resolvePodcastTarget('/skill:wiki-tts-generate --podcast-file <podcast-script>', synthItem);
    expect(result.error).toMatch(/no podcast script/i);
  });

  it('resolves <podcast-review> to the raw script path (w-r write-review chord)', async () => {
    const result = await resolvePodcastTarget('/skill:wiki-podcast-script --review <podcast-review>', draftedItem);
    expect(result).toEqual({ command: '/skill:wiki-podcast-script --review foo/foo.podcast.md' });
  });

  it('belt-and-braces: errors on <podcast-review> when no script is in Key Files', async () => {
    const result = await resolvePodcastTarget('/skill:wiki-podcast-script --review <podcast-review>', sourcedItem);
    expect(result.error).toMatch(/no podcast script/i);
    expect(result.command).toBeUndefined();
  });

  it('resolves <podcast-both> to the raw script path (w-b write-both chord)', async () => {
    const result = await resolvePodcastTarget('/skill:wiki-podcast-script --review-rewrite <podcast-both>', draftedItem);
    expect(result).toEqual({ command: '/skill:wiki-podcast-script --review-rewrite foo/foo.podcast.md' });
  });

  it('belt-and-braces: errors on <podcast-both> when no script is in Key Files', async () => {
    const result = await resolvePodcastTarget('/skill:wiki-podcast-script --review-rewrite <podcast-both>', sourcedItem);
    expect(result.error).toMatch(/no podcast script/i);
    expect(result.command).toBeUndefined();
  });

  it('resolves review markers on wiki-dir-relative script paths as-is (raw form)', async () => {
    const wikiItem: WorkItem = { ...draftedItem, description: '## Key Files:\n- wiki/podcast/foo/foo.podcast.md\n' };
    const result = await resolvePodcastTarget('/skill:wiki-podcast-script --review <podcast-review>', wikiItem);
    expect(result).toEqual({ command: '/skill:wiki-podcast-script --review wiki/podcast/foo/foo.podcast.md' });
  });

  it('returns the command unchanged for a command with no podcast markers (review marker absent)', async () => {
    const result = await resolvePodcastTarget('/skill:wiki-podcast-script --review foo/foo.podcast.md', draftedItem);
    expect(result).toEqual({ command: '/skill:wiki-podcast-script --review foo/foo.podcast.md' });
  });
});

// ── w chord leader: sub-chord hints ──────────────────────────────────────
// The `w` single-key write-script chord is split into w-r/w-s/w-b sub-chords
// (OSL-0MSKVB5K6008XFOQ). Pressing `w` must collapse to `w:write...` and
// expand to the per-sub-chord hints via the existing formatChordHintsForHelp
// machinery, respecting per-stage visibility.

describe('w chord leader — sub-chord hints and stage gating', () => {
  const wChords: ShortcutEntry[] = [
    {
      chord: ['w', 'r'],
      command: '/skill:wiki-podcast-script --review <podcast-review>',
      view: 'both',
      label: 'write review',
      stages: ['plan_complete', 'in_review', 'done'],
    },
    {
      chord: ['w', 's'],
      command: '/skill:wiki-podcast-script <podcast-target>',
      view: 'both',
      label: 'write script',
      stages: ['intake_complete', 'plan_complete', 'in_review', 'done'],
    },
    {
      chord: ['w', 'b'],
      command: '/skill:wiki-podcast-script --review-rewrite <podcast-both>',
      view: 'both',
      label: 'write both',
      stages: ['plan_complete', 'in_review', 'done'],
    },
  ];

  it('shows w as a chord leader hint in the footer (collapsed)', () => {
    const registry = new ShortcutRegistry([...wChords]);
    const hints = getChordHelpHints(registry);
    expect(hints).toContain('[w] chords');
  });

  it('expands to r/s/b sub-chord hints at a script-bearing stage', () => {
    const registry = new ShortcutRegistry([...wChords]);
    const nextChords = registry.getChordByPrefix(['w'], 'list', 'plan_complete');
    const hints = formatChordHintsForHelp(nextChords, ['w']);
    expect(hints).toContain('r:review');
    expect(hints).toContain('s:script');
    expect(hints).toContain('b:both');
  });

  it('shows only the s sub-chord at intake_complete (w-r/w-b hidden)', () => {
    const registry = new ShortcutRegistry([...wChords]);
    const nextChords = registry.getChordByPrefix(['w'], 'list', 'intake_complete');
    const hints = formatChordHintsForHelp(nextChords, ['w']);
    expect(hints).toContain('s:script');
    expect(hints).not.toContain('r:review');
    expect(hints).not.toContain('b:both');
  });

  it('hides all w sub-chords at idea (no stage gate matches)', () => {
    const registry = new ShortcutRegistry([...wChords]);
    const nextChords = registry.getChordByPrefix(['w'], 'list', 'idea');
    expect(nextChords).toHaveLength(0);
  });
});

// ── Code Freeze: banner rendering ────────────────────────────────────────
// The banner must appear only when freeze is active and must never break the
// `rows - 1` line-count invariant (WL-0MSAAON63003N6LO).

describe('createListRenderer — code freeze banner', () => {
  const renderer = createListRenderer();

  it('renders a CODE FREEZE banner when freeze is active', () => {
    const output = renderer(
      [makeItem('A'), makeItem('B')],
      0,
      0,
      TERM_80x24,
      null,
      'list',
      null,
      undefined,
      null,
      0,
      false,
      undefined,
      undefined,
      0,
      false,
      true, // codeFreezeActive
    );
    expect(output).toContain('CODE FREEZE');
    expect(output).toContain('implement');
  });

  it('does not render a banner when freeze is inactive (default)', () => {
    const output = renderer([makeItem('A')], 0, 0, TERM_80x24, null, 'list', null);
    expect(output).not.toContain('CODE FREEZE');
  });

  it('keeps the rows - 1 line-count invariant with the banner', () => {
    const grouped: WorkItem[] = Array.from({ length: 30 }, (_, i) => ({
      ...makeItem(`G${i}`),
      group: i,
      groupLabel: `Group ${i}`,
    }));
    const output = renderer(
      grouped,
      0,
      0,
      TERM_80x24,
      null,
      'list',
      null,
      undefined,
      null,
      0,
      false,
      undefined,
      undefined,
      0,
      false,
      true, // codeFreezeActive
    );
    expect(output.split('\n').length).toBeLessThanOrEqual(TERM_80x24.rows - 1);
  });

  it('renders the Ambiguous Codefreeze marker banner when the marker is ambiguous', () => {
    const output = renderer(
      [makeItem('A')],
      0,
      0,
      TERM_80x24,
      null,
      'list',
      null,
      undefined,
      null,
      0,
      false,
      undefined,
      undefined,
      0,
      false,
      false, // codeFreezeActive (fail-open: browsing stays unblocked)
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true, // showHelpText
      true, // codeFreezeAmbiguous
    );
    expect(output).toContain('Ambiguous Codefreeze marker');
    // The ambiguous banner is distinct from the active-freeze banner: an
    // ambiguous marker must NOT show the red CODE FREEZE banner (browsing
    // and shortcut blocking keep their fail-open semantics).
    expect(output).not.toContain('CODE FREEZE');
  });

  it('does not render the ambiguous banner when the marker is unambiguous (default)', () => {
    const output = renderer([makeItem('A')], 0, 0, TERM_80x24, null, 'list', null);
    expect(output).not.toContain('Ambiguous Codefreeze marker');
  });

  it('keeps the rows - 1 line-count invariant with the ambiguous banner', () => {
    const grouped: WorkItem[] = Array.from({ length: 30 }, (_, i) => ({
      ...makeItem(`G${i}`),
      group: i,
      groupLabel: `Group ${i}`,
    }));
    const output = renderer(
      grouped,
      0,
      0,
      TERM_80x24,
      null,
      'list',
      null,
      undefined,
      null,
      0,
      false,
      undefined,
      undefined,
      0,
      false,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      true, // codeFreezeAmbiguous
    );
    expect(output.split('\n').length).toBeLessThanOrEqual(TERM_80x24.rows - 1);
  });
});

// ── Chord-mode footer gating (WL-0MSGJDSMJ004128E) ─────────────────────
// The chord-in-progress footer (`chord: <keys> _ <hints>`) must be gated by
// `showHelpText` like the normal shortcut hint line, so `showHelpText: false`
// hides ALL shortcut hint lines (consistent with the pi browse widget). The
// gating must only affect rendering — chord state accumulation is untouched.

describe('createListRenderer — chord-mode footer gating', () => {
  const renderer = createListRenderer();

  function chordStateWithPending(keys: string[], hints = 'update ...'): ChordState {
    const state = createChordState();
    state.pendingKeys = keys;
    state.hints = hints;
    return state;
  }

  it('suppresses the chord footer when showHelpText is false', () => {
    const output = renderer(
      [makeItem('A')],
      0,
      0,
      TERM_80x24,
      null,
      'list',
      null,
      undefined,
      chordStateWithPending(['u']),
      0,
      false,
      undefined,
      undefined,
      0,
      false,
      false,
      0,
      undefined,
      undefined,
      undefined,
      0,
      true,
      0,
      false, // showHelpText
    );
    expect(output).not.toContain('chord:');
    expect(output).not.toContain('update ...');
  });

  it('renders the chord footer when showHelpText is true', () => {
    const output = renderer(
      [makeItem('A')],
      0,
      0,
      TERM_80x24,
      null,
      'list',
      null,
      undefined,
      chordStateWithPending(['u']),
      0,
      false,
      undefined,
      undefined,
      0,
      false,
      false,
      0,
      undefined,
      undefined,
      undefined,
      0,
      true,
      0,
      true, // showHelpText
    );
    expect(output).toContain('chord:');
    expect(output).toContain('u _');
    expect(output).toContain('update ...');
  });

  it('renders the chord footer when showHelpText is unset (default true)', () => {
    // Backwards compatibility: existing positional callers that do not pass
    // the trailing showHelpText argument keep the chord footer visible.
    const output = renderer(
      [makeItem('A')],
      0,
      0,
      TERM_80x24,
      null,
      'list',
      null,
      undefined,
      chordStateWithPending(['u']),
      0,
      false,
      undefined,
      undefined,
      0,
      false,
      false,
      0,
      undefined,
      undefined,
      undefined,
      0,
      true,
      0,
    );
    expect(output).toContain('chord:');
    expect(output).toContain('u _');
  });

  it('does not mutate chord state while rendering with showHelpText false', () => {
    // The fix gates rendering only; the chord key handling state machine must
    // keep accumulating even when the footer is hidden (WL-0MSGJDSMJ004128E).
    const chordState = chordStateWithPending(['u', 'c']);
    renderer(
      [makeItem('A')],
      0,
      0,
      TERM_80x24,
      null,
      'list',
      null,
      undefined,
      chordState,
      0,
      false,
      undefined,
      undefined,
      0,
      false,
      false,
      0,
      undefined,
      undefined,
      undefined,
      0,
      true,
      0,
      false, // showHelpText
    );
    expect(chordState.pendingKeys).toEqual(['u', 'c']);
    expect(chordState.hints).toBe('update ...');
  });
});

// ── Code Freeze: dialog rendering ────────────────────────────────────────

describe('formatCodeFreezeDialog', () => {
  it('renders a bordered dialog with the freeze message and dismiss hint', () => {
    const dialog = formatCodeFreezeDialog(80, 24, 'ship release in progress');
    expect(dialog).toContain('CODE FREEZE');
    expect(dialog).toContain('ship release in progress');
    expect(dialog).toContain('Esc');
    expect(dialog).toContain('Enter');
  });

  it('renders a fallback message when no reason is provided', () => {
    const dialog = formatCodeFreezeDialog(80, 24);
    expect(dialog).toContain('CODE FREEZE');
  });
});

// ── Metadata panel (WL-0MSAYNVBY006LM9X-FT3) ─────────────────────────────
// The list renderer reserves 20–40% of the pane height for a metadata panel
// below the selection list. Tests cover the height ramp, field rendering,
// selection-driven updates, independent scrolling, and regressions.

function makeRichItem(): WorkItem {
  return {
    id: 'WL-RICH1',
    title: 'Rich metadata item',
    status: 'in_progress',
    stage: 'in_progress',
    priority: 'high',
    issueType: 'feature',
    risk: 'medium',
    effort: '3',
    tags: ['frontend', 'ui'],
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-02T10:00:00.000Z',
    childCount: 2,
    needsProducerReview: true,
    auditResult: true,
    auditedAt: '2026-08-03T10:00:00.000Z',
    githubIssueNumber: '42',
    parentId: 'WL-PARENT1',
  };
}

describe('computeMetadataPanelHeight — responsive ramp', () => {
  it('stays within 20%–40% of pane rows', () => {
    for (const rows of [12, 18, 24, 30, 40, 50, 80]) {
      const panel = computeMetadataPanelHeight(rows);
      // Min-3 clamp allows a small overshoot of the 20% floor on tiny panes.
      expect(panel).toBeGreaterThanOrEqual(Math.round(rows * 0.2) - 1);
      expect(panel).toBeLessThanOrEqual(Math.round(rows * 0.4));
      expect(panel).toBeLessThan(rows);
    }
  });

  it('grows monotonically with pane height', () => {
    const small = computeMetadataPanelHeight(12);
    const medium = computeMetadataPanelHeight(24);
    const tall = computeMetadataPanelHeight(40);
    expect(medium).toBeGreaterThanOrEqual(small);
    expect(tall).toBeGreaterThanOrEqual(medium);
  });

  it('leaves at least 60% of the pane for the list', () => {
    for (const rows of [12, 18, 24, 30, 40, 50]) {
      const panel = computeMetadataPanelHeight(rows);
      expect(rows - panel).toBeGreaterThanOrEqual(Math.floor(rows * 0.6) - 1); // rounding slack
    }
  });
});

describe('formatMetadataPanel — field rendering and scrolling', () => {
  it('renders all WorkItem metadata fields for the selected item', () => {
    const joined = formatMetadataPanel(makeRichItem(), 80, 20, 0).join('\n');
    expect(joined).toContain('WL-RICH1');
    expect(joined).toContain('Rich metadata item');
    expect(joined).toContain('Status');
    expect(joined).toContain('in_progress');
    expect(joined).toContain('Priority');
    expect(joined).toContain('high');
    expect(joined).toContain('Type');
    expect(joined).toContain('feature');
    expect(joined).toContain('Risk');
    expect(joined).toContain('medium');
    expect(joined).toContain('Effort');
    expect(joined).toContain('3');
    expect(joined).toContain('Tags');
    expect(joined).toContain('frontend, ui');
    expect(joined).toContain('Created');
    expect(joined).toContain('Updated');
    expect(joined).toContain('Children');
    expect(joined).toContain('2');
    expect(joined).toContain('Reviewed');
    expect(joined).toContain('Audit');
    expect(joined).toContain('GitHub Issue');
    expect(joined).toContain('#42');
    expect(joined).toContain('Parent');
    expect(joined).toContain('WL-PARENT1');
  });

  it('returns exactly panelRows lines', () => {
    expect(formatMetadataPanel(makeRichItem(), 80, 7, 0).length).toBe(7);
  });

  it('handles null item with a blank panel', () => {
    const lines = formatMetadataPanel(null, 80, 7, 0);
    expect(lines.length).toBe(7);
    expect(lines.join('').trim()).toBe('');
  });

  it('scrolls independently when content overflows', () => {
    const full = formatMetadataPanel(makeRichItem(), 80, 3, 0);
    const scrolled = formatMetadataPanel(makeRichItem(), 80, 3, 1);
    expect(scrolled[0]).not.toBe(full[0]);
    // Huge offset clamps to the last viewport
    expect(formatMetadataPanel(makeRichItem(), 80, 3, 999).length).toBe(3);
    // Offset 0 returns the first viewport
    expect(formatMetadataPanel(makeRichItem(), 80, 3, 0)[0]).toBe(full[0]);
  });

  it('truncates long lines to the terminal width', () => {
    const longTags = { ...makeRichItem(), tags: ['x'.repeat(120)] };
    const lines = formatMetadataPanel(longTags, 40, 20, 0);
    for (const line of lines) {
      expect(line.replace(/\x1b\[[0-9;]*m/g, '').length).toBeLessThanOrEqual(40);
    }
  });
});

describe('formatMetadataPanel — description preview (WL-0MSFZKQL700381P3)', () => {
  it('renders a Description section for items with a description', () => {
    const item = { ...makeRichItem(), description: '# Fix the bug\n\nMake it work better.' };
    const joined = formatMetadataPanel(item, 80, 30, 0).join('\n');
    expect(joined).toContain('Description');
    expect(joined).toContain('# Fix the bug');
    expect(joined).toContain('Make it work better.');
  });

  it('omits the preview when the description is missing or empty', () => {
    const missing = formatMetadataPanel(makeRichItem(), 80, 20, 0).join('\n');
    expect(missing).not.toContain('Description');
    const blank = formatMetadataPanel({ ...makeRichItem(), description: '   \n\n  ' }, 80, 20, 0).join('\n');
    expect(blank).not.toContain('Description');
  });

  it('shows at most the first 3 non-empty description lines', () => {
    const item = { ...makeRichItem(), description: ['line 1', '', 'line 2', 'line 3', 'line 4'].join('\n') };
    const joined = formatMetadataPanel(item, 80, 30, 0).join('\n');
    expect(joined).toContain('line 1');
    expect(joined).toContain('line 2');
    expect(joined).toContain('line 3');
    expect(joined).not.toContain('line 4');
  });

  it('truncates long description lines to the panel width', () => {
    const item = { ...makeRichItem(), description: 'x'.repeat(200) };
    const lines = formatMetadataPanel(item, 40, 30, 0);
    for (const line of lines) {
      expect(line.replace(/\x1b\[[0-9;]*m/g, '').length).toBeLessThanOrEqual(40);
    }
  });

  it('tolerates markdown fences and long lines without corrupting rendering', () => {
    const description = '```\nconst x = "y";\n```\n\nnormal line';
    const item = { ...makeRichItem(), description };
    const lines = formatMetadataPanel(item, 40, 30, 0);
    const joined = lines.join('\n');
    expect(joined).toContain('```');
    expect(joined).toContain('const x = "y";');
    for (const line of lines) {
      expect(line.replace(/\x1b\[[0-9;]*m/g, '').length).toBeLessThanOrEqual(40);
    }
  });

  it('places the preview after the metadata rows and before the last-command line', () => {
    const item = { ...makeRichItem(), description: 'The description body' };
    const joined = formatMetadataPanel(item, 80, 30, 0, '/skill:audit WL-RICH1').join('\n');
    expect(joined.indexOf('Title')).toBeGreaterThanOrEqual(0);
    expect(joined.indexOf('Title')).toBeLessThan(joined.indexOf('Description'));
    expect(joined.indexOf('Description')).toBeLessThan(joined.indexOf('Last command:'));
  });

  it('scrolls with the rest of the panel content', () => {
    const item = { ...makeRichItem(), description: ['p1', 'p2', 'p3'].join('\n') };
    const top = formatMetadataPanel(item, 80, 3, 0).join('\n');
    expect(top).not.toContain('p1');
    const previewView = formatMetadataPanel(item, 80, 3, 19).join('\n');
    expect(previewView).toContain('p1');
    expect(previewView).toContain('p3');
    // [m/M scroll] indicator still shown when content overflows
    expect(previewView).toContain('[m/M scroll');
  });
});

describe('createListRenderer — metadata panel in list mode', () => {
  const renderer = createListRenderer();

  it('renders a metadata panel for the selected item', () => {
    const output = renderer([makeRichItem(), makeItem('WL-OTHER')], 0, 0, TERM_80x24, null, 'list', null);
    expect(output).toContain('── WL-RICH1 ──'); // panel header separator
    expect(output).toContain('Rich metadata item');
  });

  it('updates the panel when selection changes', () => {
    const items = [makeRichItem(), makeItem('WL-SECOND', 'idea')];
    const first = renderer(items, 0, 0, TERM_80x24, null, 'list', null);
    expect(first).toContain('── WL-RICH1 ──');
    const second = renderer(items, 1, 0, TERM_80x24, null, 'list', null);
    expect(second).toContain('── WL-SECOND ──');
    expect(second).not.toContain('── WL-RICH1 ──');
  });

  it('keeps the rows - 1 line-count invariant with panel + groups + banner', () => {
    const grouped: WorkItem[] = Array.from({ length: 30 }, (_, i) => ({
      ...makeItem(`G${i}`),
      group: i,
      groupLabel: `Group ${i}`,
    }));
    const output = renderer(
      grouped, 0, 0, TERM_80x24, null, 'list', null,
      undefined, null, 0, false, undefined, undefined, 0, false, true, 0, '/skill:audit WL-G0',
    );
    expect(output.split('\n').length).toBeLessThanOrEqual(TERM_80x24.rows - 1);
    expect(output).toContain('CODE FREEZE');
    expect(output).toContain('── Group 0 ──');
  });

  it('keeps render plus notification line within rows lines', () => {
    const items = [makeItem('A'), makeItem('B'), makeItem('C')];
    const output = renderer(
      items, 0, 0, TERM_80x24, null, 'list', null,
      undefined, null, 0, false, undefined, undefined, 0, false, false, 3, undefined,
    );
    const withNotification =
      output.split('\n').slice(0, TERM_80x24.rows - 1).join('\n') + '\n' + ' [Synced]';
    expect(withNotification.split('\n').length).toBeLessThanOrEqual(TERM_80x24.rows);
  });
});

describe('WorkItemListState — metadata scroll state', () => {
  it('resets metaScrollOffset when selection changes', () => {
    const state = new WorkItemListState([makeItem('A'), makeItem('B'), makeItem('C')], TERM_80x24);
    state.metaScrollOffset = 4;
    state.moveDown();
    expect(state.metaScrollOffset).toBe(0);
    state.metaScrollOffset = 4;
    state.moveUp();
    expect(state.metaScrollOffset).toBe(0);
    state.metaScrollOffset = 4;
    state.pageDown();
    expect(state.metaScrollOffset).toBe(0);
    state.metaScrollOffset = 4;
    state.goToFirst();
    expect(state.metaScrollOffset).toBe(0);
    state.metaScrollOffset = 4;
    state.goToLast();
    expect(state.metaScrollOffset).toBe(0);
  });

  it('clamps metaScrollDown to the panel content height', () => {
    const state = new WorkItemListState([makeRichItem()], TERM_80x24);
    const panelHeight = computeMetadataPanelHeight(TERM_80x24.rows);
    const content = formatMetadataPanel(state.getSelectedItem()!, TERM_80x24.cols, panelHeight, 0);
    const maxScroll = Math.max(0, content.length - panelHeight);
    state.metaScrollDown(100);
    expect(state.metaScrollOffset).toBe(maxScroll);
  });

  it('metaScrollUp clamps at zero', () => {
    const state = new WorkItemListState([makeRichItem()], TERM_80x24);
    state.metaScrollOffset = 2;
    state.metaScrollUp(10);
    expect(state.metaScrollOffset).toBe(0);
  });
});

describe('handleKeypress — metadata scroll keys', () => {
  it('scrolls the metadata panel with m/M without moving list selection', () => {
    const state = new WorkItemListState([makeRichItem(), makeItem('B')], TERM_80x24);
    const before = state.selectedIndex;
    expect(handleKeypress(state, 'm', TERM_80x24)).toBe('meta-down');
    expect(state.selectedIndex).toBe(before);
    expect(handleKeypress(state, 'M', TERM_80x24)).toBe('meta-up');
    expect(state.selectedIndex).toBe(before);
  });

  it('does not conflict with list navigation keys j/k', () => {
    const state = new WorkItemListState([makeItem('A'), makeItem('B')], TERM_80x24);
    handleKeypress(state, 'j', TERM_80x24);
    expect(state.selectedIndex).toBe(1);
    handleKeypress(state, 'k', TERM_80x24);
    expect(state.selectedIndex).toBe(0);
  });

  it('pageUp/pageDown navigate by a full page via state', () => {
    const items = Array.from({ length: 30 }, (_, i) => makeItem(`WL-PAGE-${i}`));
    const state = new WorkItemListState(items, TERM_80x24);

    // pageUp clamps at the first item
    state.selectedIndex = 5;
    state.pageUp();
    expect(state.selectedIndex).toBe(0);

    // pageDown advances by the list page size (13 rows on 80x24 — the
    // freed blank + filter-bar chrome rows are given back to the list)
    state.selectedIndex = 0;
    state.pageDown();
    expect(state.selectedIndex).toBe(13);

    // pageDown clamps at the last item
    state.selectedIndex = 29;
    state.pageDown();
    expect(state.selectedIndex).toBe(29);

    // pageUp moves back exactly one page
    state.selectedIndex = 23;
    state.pageUp();
    expect(state.selectedIndex).toBe(10);
  });

  it('goToFirst/goToLast jump to the ends via state', () => {
    const items = Array.from({ length: 10 }, (_, i) => makeItem(`WL-EDGE-${i}`));
    const state = new WorkItemListState(items, TERM_80x24);
    state.selectedIndex = 5;
    state.goToLast();
    expect(state.selectedIndex).toBe(9);
    state.goToFirst();
    expect(state.selectedIndex).toBe(0);
  });

  it('dispatches PgUp/PgDn/g/G keys through handleKeypress', () => {
    const items = Array.from({ length: 30 }, (_, i) => makeItem(`WL-KEY-${i}`));
    const state = new WorkItemListState(items, TERM_80x24);

    // g → first
    state.selectedIndex = 15;
    expect(handleKeypress(state, 'g', TERM_80x24)).toBe('first');
    expect(state.selectedIndex).toBe(0);

    // G → last
    expect(handleKeypress(state, 'G', TERM_80x24)).toBe('last');
    expect(state.selectedIndex).toBe(29);

    // PgUp (\x1b[5~) → pageup
    expect(handleKeypress(state, '\x1b[5~', TERM_80x24)).toBe('pageup');
    expect(state.selectedIndex).toBe(16); // 29 - 13

    // PgDn (\x1b[6~) → pagedown
    state.selectedIndex = 0;
    expect(handleKeypress(state, '\x1b[6~', TERM_80x24)).toBe('pagedown');
    expect(state.selectedIndex).toBe(13);
  });
});

// ── Ship It / manual-sync removal (WL-0MSGG5N5Z0074TLY) ────────────────
// The manual `wl sync` binding on `S` is removed; `S` now resolves through
// the ShortcutRegistry (Ship It dialog) like every other shortcut, and stays
// distinct from lowercase `s` (Search).

describe('keyToAction — manual sync binding removed', () => {
  it('does not map S to the sync action anymore', () => {
    const state = new WorkItemListState([makeItem('A')], TERM_80x24);
    // No registry passed: S is not a navigation key, so handleKeypress
    // must return null (previously 'sync').
    expect(handleKeypress(state, 'S', TERM_80x24)).toBeNull();
  });

  it('keeps s and other navigation keys unchanged', () => {
    const state = new WorkItemListState([makeItem('A')], TERM_80x24);
    // s is not a navigation key either (resolved via registry → Search form).
    expect(handleKeypress(state, 's', TERM_80x24)).toBeNull();
    expect(handleKeypress(state, 'q', TERM_80x24)).toBe('quit');
    expect(handleKeypress(state, 'j', TERM_80x24)).toBe('down');
  });
});

// ── Last-command display (WL-0MSEPP1DE00285TQ-FT6) ───────────────────────
// The metadata panel shows the most recent recorded command when the selected
// item's stage is in_progress, hidden otherwise, with a graceful fallback.

describe('formatMetadataPanel — last command line (in_progress only)', () => {
  it('shows the last command for in_progress items', () => {
    const joined = formatMetadataPanel(makeRichItem(), 80, 20, 0, '/skill:audit WL-RICH1').join('\n');
    expect(joined).toContain('Last command:');
    expect(joined).toContain('/skill:audit WL-RICH1');
  });

  it('hides the last-command line for non-in_progress items', () => {
    const item = { ...makeRichItem(), stage: 'idea', status: 'open' };
    const joined = formatMetadataPanel(item, 80, 20, 0, '/skill:audit WL-RICH1').join('\n');
    expect(joined).not.toContain('Last command:');
  });

  it('shows a graceful fallback when in_progress has no command yet', () => {
    const joined = formatMetadataPanel(makeRichItem(), 80, 20, 0, null).join('\n');
    expect(joined).toContain('Last command:');
    expect(joined).toContain('none yet');
  });
});

describe('metadata panel — command log integration', () => {
  let logPath: string;

  beforeEach(() => {
    logPath = join(tmpdir(), `herdr-cmdlog-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    setLogPath(logPath);
  });

  afterEach(() => {
    resetLogPath();
  });

  it('records a command and displays it in the panel for in_progress items', () => {
    recordCommand('WL-RICH1', '/skill:audit WL-RICH1');
    const last = getLastCommand('WL-RICH1');
    expect(last).not.toBeNull();
    expect(last!.command).toBe('/skill:audit WL-RICH1');
    const joined = formatMetadataPanel(makeRichItem(), 80, 20, 0, last?.command).join('\n');
    expect(joined).toContain('/skill:audit WL-RICH1');
  });

  it('returns null for items without recorded commands', () => {
    expect(getLastCommand('WL-NOPE')).toBeNull();
  });
});

// ── Command recording in dispatch paths (WL-0MSEPP104006PS7T-FT5) ────────
// Every command routed through dispatchChordCommand() / resolveAndRouteCommand()
// that carries a work item ID is recorded in the command log BEFORE it is
// executed, so downstream failures never skip the entry. Commands without an
// item ID are not logged.

describe('command recording in dispatch paths', () => {
  it('records commands routed through resolveAndRouteCommand with <id>', () => {
    const state = new WorkItemListState([makeItem('WL-TEST-1')], TERM_80x24);
    state.selectedIndex = 0;
    const onCommand = vi.fn();
    const result = executeResolvedCommand('/skill:implement <id>', state, onCommand);
    expect(result).toBe('dispatched');
    expect(onCommand).toHaveBeenCalledWith('/skill:implement WL-TEST-1', undefined);
    const last = getLastCommand('WL-TEST-1');
    expect(last).not.toBeNull();
    expect(last!.command).toBe('/skill:implement WL-TEST-1');
  });

  it('records commands with an explicit item ID (no <id> placeholder)', () => {
    const state = new WorkItemListState([], TERM_80x24);
    const onCommand = vi.fn();
    const result = executeResolvedCommand('!!wl reviewed WL-TEST-1', state, onCommand);
    expect(result).toBe('dispatched');
    const last = getLastCommand('WL-TEST-1');
    expect(last).not.toBeNull();
    expect(last!.command).toBe('!!wl reviewed WL-TEST-1');
  });

  it('does not record commands without an item ID', () => {
    const state = new WorkItemListState([makeItem('WL-TEST-1')], TERM_80x24);
    const onCommand = vi.fn();
    expect(executeResolvedCommand('echo hello', state, onCommand)).toBe('callback');
    expect(getLastCommand('WL-TEST-1')).toBeNull();
  });

  it('records before execution so a failing onCommand still logs', () => {
    const state = new WorkItemListState([makeItem('WL-TEST-1')], TERM_80x24);
    state.selectedIndex = 0;
    const failing = () => {
      throw new Error('boom');
    };
    expect(() => executeResolvedCommand('/skill:implement <id>', state, failing)).toThrow('boom');
    const last = getLastCommand('WL-TEST-1');
    expect(last).not.toBeNull();
    expect(last!.command).toBe('/skill:implement WL-TEST-1');
  });

  it('does not record when <id> cannot be resolved (noop)', () => {
    const state = new WorkItemListState([], TERM_80x24);
    const onCommand = vi.fn();
    expect(executeResolvedCommand('wl update <id> --priority high', state, onCommand)).toBe('noop');
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('records dispatchChordCommand-routed agent commands', () => {
    const state = new WorkItemListState([makeItem('WL-TEST-1')], TERM_80x24);
    state.selectedIndex = 0;
    const onCommand = vi.fn();
    expect(dispatchChordCommand('/skill:audit <id>', state, onCommand)).toBe(true);
    const last = getLastCommand('WL-TEST-1');
    expect(last).not.toBeNull();
    expect(last!.command).toBe('/skill:audit WL-TEST-1');
  });

  it('keeps the most recent command per item (bounded log)', () => {
    const state = new WorkItemListState([makeItem('WL-TEST-1')], TERM_80x24);
    state.selectedIndex = 0;
    executeResolvedCommand('/skill:audit <id>', state);
    executeResolvedCommand('/skill:implement <id>', state);
    const last = getLastCommand('WL-TEST-1');
    expect(last!.command).toBe('/skill:implement WL-TEST-1');
  });
});

// ── Readable local timestamps (WL-0MSF8HYUX0012WA9) ─────────────────────
// Timestamps are displayed as DD/MM/YY HH:MM in local time. Expected values
// below are derived from the same Date instants so the tests pass in any
// timezone while still proving local-time conversion and zero-padding.

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local DD/MM/YY HH:MM string for an ISO instant (mirror of the UI format). */
function localDDMMYY(iso: string): string {
  const d = new Date(iso);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${pad2(d.getFullYear() % 100)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

describe('formatTimestamp — readable local DD/MM/YY HH:MM', () => {
  it('formats an ISO-8601 UTC timestamp in local time', () => {
    const iso = '2026-08-04T13:05:09.000Z';
    expect(formatTimestamp(iso)).toBe(localDDMMYY(iso));
  });

  it('zero-pads day, month, year and time components', () => {
    // Local 4 Aug 2026 00:05 — every component needs padding
    const iso = new Date(2026, 7, 4, 0, 5).toISOString();
    expect(formatTimestamp(iso)).toBe('04/08/26 00:05');
  });

  it('uses 24h time and two-digit year for the afternoon', () => {
    const iso = new Date(2026, 11, 31, 23, 59).toISOString();
    expect(formatTimestamp(iso)).toBe('31/12/26 23:59');
  });

  it('returns invalid input unchanged (graceful degradation)', () => {
    expect(formatTimestamp('not-a-date')).toBe('not-a-date');
    expect(formatTimestamp('')).toBe('');
  });
});

describe('buildMetaRows — timestamps rendered via formatTimestamp', () => {
  it('shows Created/Updated/Audited At as local DD/MM/YY HH:MM', () => {
    const rows = new Map(buildMetaRows(makeRichItem()));
    expect(rows.get('Created')).toBe(localDDMMYY('2026-08-01T10:00:00.000Z'));
    expect(rows.get('Updated')).toBe(localDDMMYY('2026-08-02T10:00:00.000Z'));
    expect(rows.get('Audited At')).toBe(localDDMMYY('2026-08-03T10:00:00.000Z'));
    // No raw ISO strings leak into the rendered rows
    for (const [, value] of rows) {
      expect(value).not.toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('omits timestamp rows when the item has none', () => {
    const rows = new Map(buildMetaRows(makeItem('WL-NO-TS')));
    expect(rows.has('Created')).toBe(false);
    expect(rows.has('Updated')).toBe(false);
    expect(rows.has('Audited At')).toBe(false);
  });
});

// ── Downtime status indicator (WL-0MSF49FMW009M06K, F4) ───────────────

describe('renderDowntimeStatus', () => {
  it('renders nothing when no worker is present', () => {
    expect(renderDowntimeStatus(undefined)).toBe('');
  });

  it('renders the continuous idle duration as m:ss', () => {
    const worker = {
      idleSince: Date.now() - 192_000, // 3:12
      dispatching: false,
      enabled: true,
    } as unknown as DowntimeWorker;
    const status = renderDowntimeStatus(worker);
    expect(status).toContain('downtime idle 3:12');
    expect(status).toContain('⏳');
  });

  it('renders the dispatching state', () => {
    const worker = {
      idleSince: Date.now() - 60_000,
      dispatching: true,
      enabled: true,
    } as unknown as DowntimeWorker;
    expect(renderDowntimeStatus(worker)).toContain('downtime dispatching');
  });

  it('renders the disabled state', () => {
    const worker = {
      idleSince: null,
      dispatching: false,
      enabled: false,
    } as unknown as DowntimeWorker;
    expect(renderDowntimeStatus(worker)).toContain('downtime disabled');
  });

  it('renders the paused state during the no-candidate cooldown (no stale idle duration)', () => {
    const worker = {
      idleSince: null,
      dispatching: false,
      enabled: true,
      paused: true,
    } as unknown as DowntimeWorker;
    const status = renderDowntimeStatus(worker);
    expect(status).toContain('downtime paused');
    expect(status).not.toContain('downtime idle');
  });

  it('renders busy when the proxy is not idle', () => {
    const worker = {
      idleSince: null,
      dispatching: false,
      enabled: true,
    } as unknown as DowntimeWorker;
    expect(renderDowntimeStatus(worker)).toContain('downtime busy');
  });

  it('appends the status inline to the list header without adding a row', () => {
    const items = [makeItem('WL-1', 'open')];
    const renderer = createListRenderer();
    const output = renderer(
      items, 0, 0, TERM_80x24, null, 'list', null,
      undefined, null, 0, true, undefined, undefined, 0, false, false,
      0, undefined, undefined,
      ' [⏳ downtime idle 0:05]',
    );
    expect(output).toContain('Work Items');
    expect(output).toContain('[⏳ downtime idle 0:05]');
    expect(output.split('\n').length).toBeLessThanOrEqual(TERM_80x24.rows - 1);
  });
});

// ── showIcons gating (WL-0MSBV4RYO008JL70) ─────────────────────────────
// The renderer consults the getShowIcons getter on EVERY render, so a
// showIcons setting change applies without a plugin restart (same pattern
// as getShowHelpText). When the getter returns false, item lines render
// text fallbacks ([OPEN], [IDEA], ...) instead of emoji icons.

const OPEN_ICON = '\u{1F513}'; // 🔓 — the open-status icon
const AUDIT_UNKNOWN_ICON = '\u{2753}'; // ❓ — audit-unknown icon (metadata panel)

describe('createListRenderer — showIcons gating', () => {
  it('renders emoji icons by default (backwards compatible)', () => {
    const renderer = createListRenderer();
    const output = renderer([makeItem('A', 'idea')], 0, 0, TERM_80x24, null, 'list', null);
    expect(output).toContain(OPEN_ICON);
    expect(output).not.toContain('[OPEN]');
  });

  it('renders text fallbacks instead of icons when getShowIcons returns false', () => {
    const renderer = createListRenderer(() => false);
    const output = renderer([makeItem('A', 'idea')], 0, 0, TERM_80x24, null, 'list', null);
    expect(output).not.toContain(OPEN_ICON);
    expect(output).toContain('[OPEN]'); // status text fallback
    expect(output).toContain('[IDEA]'); // stage text fallback
    expect(output).not.toContain(AUDIT_UNKNOWN_ICON); // metadata panel audit icon
    expect(output).toContain('[?]'); // audit text fallback
  });

  it('re-reads the getter on every render (settings re-read path)', () => {
    let showIcons = true;
    const renderer = createListRenderer(() => showIcons);

    const withIcons = renderer([makeItem('A', 'idea')], 0, 0, TERM_80x24, null, 'list', null);
    expect(withIcons).toContain(OPEN_ICON);

    // Simulate the user editing the config: flip the flag, render again —
    // the getter is consulted per-render, so the change applies immediately.
    showIcons = false;
    const withoutIcons = renderer([makeItem('A', 'idea')], 0, 0, TERM_80x24, null, 'list', null);
    expect(withoutIcons).not.toContain(OPEN_ICON);
    expect(withoutIcons).toContain('[OPEN]');
  });
});

// ── Key Files md path resolution (WL-0MSGEA9AY0080V4Q) ─────────────────
// Regression: readKeyFile resolved `Key Files:` paths against the plugin
// pane's process.cwd() (the herdr plugin source dir), NOT the worklog root,
// so episode .podcast.md files never rendered in the detail view.
// resolveKeyFilePath must prefer the configured worklog root, then the
// legacy podcast-relative base (.llm-wiki/wiki/podcast/), and only fall
// back to process.cwd() as a last resort. Fail-open: no candidate on disk
// yields null so the detail view falls back to the raw description.

describe('resolveKeyFilePath (Key Files md resolution)', () => {
  let root: string;
  let originalCwd: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'herdr-keyfiles-'));
    // Simulate configureWorklogTarget: the resolved worklog root is the
    // parent of the configured .worklog dir
    // (setWorklogDir(join(wlRoot, '.worklog'))).
    setWorklogDir(join(root, '.worklog'));
    originalCwd = process.cwd();
  });

  afterEach(() => {
    resetWorklogDir();
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves Key Files paths against the worklog root, not process.cwd()', () => {
    writeFileSync(join(root, 'episode.podcast.md'), '# Episode');
    const resolved = resolveKeyFilePath('episode.podcast.md');
    expect(resolved).toBe(join(root, 'episode.podcast.md'));
  });

  it('falls back to the legacy podcast-relative base under the worklog root', () => {
    const podcastDir = join(root, '.llm-wiki', 'wiki', 'podcast', 'irish-folklore-fine-tuning');
    mkdirSync(podcastDir, { recursive: true });
    writeFileSync(join(podcastDir, 'irish-folklore-fine-tuning.podcast.md'), '# Episode');
    const resolved = resolveKeyFilePath('irish-folklore-fine-tuning/irish-folklore-fine-tuning.podcast.md');
    expect(resolved).toBe(join(podcastDir, 'irish-folklore-fine-tuning.podcast.md'));
  });

  it('prefers the worklog root over the podcast base when both exist', () => {
    const podcastDir = join(root, '.llm-wiki', 'wiki', 'podcast');
    mkdirSync(podcastDir, { recursive: true });
    writeFileSync(join(root, 'shared.podcast.md'), 'root copy');
    writeFileSync(join(podcastDir, 'shared.podcast.md'), 'podcast copy');
    const resolved = resolveKeyFilePath('shared.podcast.md');
    expect(resolved).toBe(join(root, 'shared.podcast.md'));
  });

  it('falls back to process.cwd() as a last resort when no worklog dir is configured', () => {
    resetWorklogDir();
    const cwdDir = mkdtempSync(join(tmpdir(), 'herdr-keyfiles-cwd-'));
    process.chdir(cwdDir);
    try {
      writeFileSync(join(cwdDir, 'notes.md'), '# Notes');
      const resolved = resolveKeyFilePath('notes.md');
      expect(resolved).toBe(join(cwdDir, 'notes.md'));
    } finally {
      process.chdir(originalCwd);
      rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  it('returns null when no candidate exists on disk', () => {
    expect(resolveKeyFilePath('missing/file.podcast.md')).toBeNull();
  });

  it('accepts absolute Key Files paths directly', () => {
    writeFileSync(join(root, 'abs.podcast.md'), '# Abs');
    const abs = join(root, 'abs.podcast.md');
    expect(resolveKeyFilePath(abs)).toBe(abs);
  });
});

// ── Related Docs row + detail ToC + open-in-viewer (WL-0MSGTLSUT002NF29) ─
// Test-first contract (WL-0MSHWHP0S0036DDU): these tests are written BEFORE
// the Related Docs row (WL-0MSHWHRIF001YHF8) and detail ToC
// (WL-0MSHWHULZ001FL8I) implementations land. New-behavior assertions are
// expected to be RED at creation time and turn GREEN once the row and ToC
// features are implemented. Tests exercise the existing public API
// (buildMetaRows / formatMetadataPanel / formatDetailContent /
// formatDetailView / handleKeypress / WorkItemListState / resolveKeyFilePath)
// plus the ToC state fields that the ToC feature adds to WorkItemListState:
//   - detailToCIndex     : selected ToC entry (0-based; default 0)
//   - detailToCFocus     : true when keyboard focus is on the ToC, false
//                          when focus is on the document scroll region
//   - detailRenderedIndex: which Key File's content is shown in the md
//                          viewer (default 0 = first file, auto-render)
//   - handleKeypress in detail mode: j/k and arrow keys move detailToCIndex
//     when detailToCFocus is true; navigating past the last ToC entry
//     transfers focus to document scrolling (detailToCFocus = false); k at
//     the top of the document returns focus to the ToC. Enter (\r) renders
//     mdPaths[detailToCIndex] by setting detailRenderedIndex.
// formatDetailContent/formatDetailView accept optional trailing params:
//   (…, detailToCIndex, detailToCFocus, detailRenderedIndex) and render a
//   pinned "Related Docs" ToC at the top of the detail view when the item
//   has ≥1 .md Key File.

/** Build an item whose description carries a **Key Files:** section. */
function makeKeyFilesItem(id: string, paths: string[]): WorkItem {
  return {
    ...makeItem(id),
    description: [
      `# ${id} title`,
      '',
      '**Key Files:**',
      ...paths.map(p => `- \`${p}\``),
      '',
      '## Notes',
      'Body text for the description section.',
    ].join('\n'),
  };
}

describe('buildMetaRows — Related Docs row (WL-0MSHWHRIF001YHF8)', () => {
  it('emits a Related Docs row listing every .md path from Key Files, joined with ", "', () => {
    const item = makeKeyFilesItem('WL-REL', ['docs/prd.md', 'docs/episode.podcast.md']);
    const rows = new Map(buildMetaRows(item));
    expect(rows.get('Related Docs')).toBe('docs/prd.md, docs/episode.podcast.md');
  });

  it('omits the row when the item has no Key Files section at all', () => {
    const item = makeItem('WL-PLAIN');
    const rows = new Map(buildMetaRows(item));
    expect(rows.has('Related Docs')).toBe(false);
    const panel = formatMetadataPanel(item, 80, 20, 0, null).join('\n');
    expect(panel).not.toContain('Related Docs');
    const detail = formatDetailContent(item, 80).join('\n');
    expect(detail).not.toContain('Related Docs');
  });

  it('omits the row when Key Files contains no .md files', () => {
    const item = makeKeyFilesItem('WL-NO-MD', ['src/app.ts', 'data.json']);
    const rows = new Map(buildMetaRows(item));
    expect(rows.has('Related Docs')).toBe(false);
    const panel = formatMetadataPanel(item, 80, 20, 0, null).join('\n');
    expect(panel).not.toContain('Related Docs');
    const detail = formatDetailContent(item, 80).join('\n');
    expect(detail).not.toContain('Related Docs');
  });

  it('includes only .md paths from a mixed Key Files list', () => {
    const item = makeKeyFilesItem('WL-MIX', ['src/app.ts', 'docs/guide.md', 'data.json', 'docs/api.md']);
    const rows = new Map(buildMetaRows(item));
    expect(rows.get('Related Docs')).toBe('docs/guide.md, docs/api.md');
  });

  it('renders the row in the metadata panel (formatMetadataPanel)', () => {
    const item = makeKeyFilesItem('WL-PANEL', ['docs/prd.md', 'docs/episode.podcast.md']);
    const joined = formatMetadataPanel(item, 80, 20, 0, null).join('\n');
    expect(joined).toContain('Related Docs');
    expect(joined).toContain('docs/prd.md, docs/episode.podcast.md');
  });

  it('renders the row in the detail-view metadata table (formatDetailContent)', () => {
    const item = makeKeyFilesItem('WL-DETAIL', ['docs/prd.md', 'docs/episode.podcast.md']);
    const joined = formatDetailContent(item, 80).join('\n');
    expect(joined).toContain('Related Docs');
    expect(joined).toContain('docs/prd.md, docs/episode.podcast.md');
  });

  it('truncates very long Related Docs values to the terminal width', () => {
    const paths = Array.from({ length: 10 }, (_, i) => `docs/very-long-document-name-${i}.md`);
    const item = makeKeyFilesItem('WL-LONG', paths);
    const joined = formatMetadataPanel(item, 40, 20, 0, null).join('\n');
    for (const line of joined.split('\n')) {
      const visible = line.replace(/\x1b\[[0-9;]*m/g, '');
      expect(visible.length).toBeLessThanOrEqual(40);
    }
  });
});

describe('detail view ToC for Related Docs (WL-0MSHWHULZ001FL8I)', () => {
  const twoMd = () => {
    const item = makeKeyFilesItem('WL-TOC', ['docs/prd.md', 'docs/episode.podcast.md']);
    // Long body so the document region is scrollable: the focus-transfer
    // tests need maxScroll ≥ 2 (j,j scrolls down, k,k returns to the top,
    // k returns focus to the ToC).
    item.description += '\n\n' + Array.from({ length: 60 }, (_, i) => `lorem ipsum dolor line ${i}`).join('\n');
    return item;
  };

  it('renders a ToC at the top listing every Related Doc when the item has .md Key Files', () => {
    const joined = formatDetailContent(twoMd(), 80, undefined, true, 0, true, 0).join('\n');
    expect(joined).toContain('Related Docs');
    expect(joined).toContain('1. docs/prd.md');
    expect(joined).toContain('2. docs/episode.podcast.md');
  });

  it('renders no ToC when the item has no .md Key Files', () => {
    const item = makeKeyFilesItem('WL-NO-TOC', ['src/app.ts']);
    const joined = formatDetailContent(item, 80, undefined, true, 0, true, 0).join('\n');
    expect(joined).not.toContain('1. ');
    expect(joined).not.toContain('Related Docs');
  });

  it('marks the focused ToC entry with a focus indicator', () => {
    const focusedFirst = formatDetailContent(twoMd(), 80, undefined, true, 0, true, 0).join('\n');
    expect(focusedFirst).toContain('▸ 1. docs/prd.md');
    const focusedSecond = formatDetailContent(twoMd(), 80, undefined, true, 1, true, 0).join('\n');
    expect(focusedSecond).toContain('▸ 2. docs/episode.podcast.md');
  });

  it('moves ToC selection with j/k and arrow keys via handleKeypress', () => {
    const state = new WorkItemListState([twoMd()], TERM_80x24);
    state.selectedIndex = 0;
    state.selectItem();
    expect(state.mode).toBe('detail');
    expect(state.detailToCIndex).toBe(0);
    expect(state.detailToCFocus).toBe(true);

    handleKeypress(state, 'j', TERM_80x24);
    expect(state.detailToCIndex).toBe(1);
    handleKeypress(state, 'k', TERM_80x24);
    expect(state.detailToCIndex).toBe(0);

    handleKeypress(state, '\x1b[B', TERM_80x24); // ↓
    expect(state.detailToCIndex).toBe(1);
    handleKeypress(state, '\x1b[A', TERM_80x24); // ↑
    expect(state.detailToCIndex).toBe(0);
  });

  it('clamps ToC selection at the bounds', () => {
    const state = new WorkItemListState([twoMd()], TERM_80x24);
    state.selectedIndex = 0;
    state.selectItem();
    handleKeypress(state, 'k', TERM_80x24); // above first entry — clamp at 0
    expect(state.detailToCIndex).toBe(0);
    handleKeypress(state, 'j', TERM_80x24);
    handleKeypress(state, 'j', TERM_80x24); // at last entry — stays (focus moves to doc, see below)
    expect(state.detailToCIndex).toBe(1);
  });

  it('navigating past the last ToC entry transfers focus to document scrolling', () => {
    const state = new WorkItemListState([twoMd()], TERM_80x24);
    state.selectedIndex = 0;
    state.selectItem();
    handleKeypress(state, 'j', TERM_80x24); // → entry 1
    handleKeypress(state, 'j', TERM_80x24); // past last → doc focus
    expect(state.detailToCFocus).toBe(false);
    // j now scrolls the document
    const before = state.detailScrollOffset;
    handleKeypress(state, 'j', TERM_80x24);
    expect(state.detailScrollOffset).toBe(before + 1);
  });

  it('navigating up past the top of the document returns focus to the ToC', () => {
    const state = new WorkItemListState([twoMd()], TERM_80x24);
    state.selectedIndex = 0;
    state.selectItem();
    handleKeypress(state, 'j', TERM_80x24); // → entry 1
    handleKeypress(state, 'j', TERM_80x24); // past last → doc focus
    expect(state.detailToCFocus).toBe(false);
    // Scroll down a couple of lines then back up to the top.
    handleKeypress(state, 'j', TERM_80x24);
    handleKeypress(state, 'j', TERM_80x24);
    handleKeypress(state, 'k', TERM_80x24);
    handleKeypress(state, 'k', TERM_80x24);
    expect(state.detailScrollOffset).toBe(0);
    // k at the top returns focus to the ToC
    handleKeypress(state, 'k', TERM_80x24);
    expect(state.detailToCFocus).toBe(true);
    expect(state.detailToCIndex).toBe(1);
  });

  it('keeps the ToC pinned at the top while the document scrolls', () => {
    const item = twoMd();
    // Make the document long enough to scroll well past the ToC.
    item.description += '\n\n' + Array.from({ length: 60 }, (_, i) => `lorem ipsum dolor line ${i}`).join('\n');
    const view = formatDetailView(item, 80, 40, 24, undefined, true, 1, false, 0);
    const lines = view.split('\n');
    const firstLines = lines.slice(0, 8).join('\n');
    expect(firstLines).toContain('Related Docs');
    expect(firstLines).toContain('1. docs/prd.md');
  });
});

describe('Related Docs — open in markdown viewer (WL-0MSGTLSUT002NF29)', () => {
  const readFileFor = (content: Record<string, string>) =>
    (filePath: string): string | null => content[filePath] ?? null;

  it('auto-renders the first .md Key File by default (existing behavior preserved)', () => {
    const item = makeKeyFilesItem('WL-AUTO', ['docs/prd.md', 'docs/episode.podcast.md']);
    const readFile = readFileFor({ 'docs/prd.md': '# PRD content' });
    const joined = formatDetailContent(item, 80, readFile, true, 0, true, 0).join('\n');
    expect(joined).toContain('PRD content');
  });

  it('Enter on a ToC entry renders that specific file in the markdown viewer', () => {
    const item = makeKeyFilesItem('WL-OPEN', ['docs/prd.md', 'docs/episode.podcast.md']);
    const state = new WorkItemListState([item], TERM_80x24);
    state.selectedIndex = 0;
    state.selectItem();
    handleKeypress(state, 'j', TERM_80x24); // ToC → entry 1
    handleKeypress(state, '\r', TERM_80x24); // Enter renders the selected doc
    expect(state.detailRenderedIndex).toBe(1);

    const readFile = readFileFor({
      'docs/prd.md': '# PRD content',
      'docs/episode.podcast.md': '# Episode content',
    });
    const joined = formatDetailContent(item, 80, readFile, true, 1, true, 1).join('\n');
    expect(joined).toContain('Episode content');
    expect(joined).not.toContain('PRD content');
  });

  it('unreadable or missing files fail open without crashing', () => {
    const item = makeKeyFilesItem('WL-MISSING', ['docs/ghost.md']);
    const joined = formatDetailContent(item, 80, readFileFor({}), true, 0, true, 0).join('\n');
    // No crash; the raw description still renders.
    expect(joined).toContain('Body text for the description section.');
  });

  it('resolves Key Files against the worklog root, never process.cwd()', () => {
    const root = mkdtempSync(join(tmpdir(), 'herdr-related-docs-'));
    const originalCwd = process.cwd();
    try {
      setWorklogDir(join(root, '.worklog'));
      mkdirSync(join(root, 'docs'), { recursive: true });
      writeFileSync(join(root, 'docs', 'episode.podcast.md'), '# Worklog root content');

      // Decoy: same relative path in the plugin CWD — must NOT win.
      const cwdDir = mkdtempSync(join(tmpdir(), 'herdr-related-docs-cwd-'));
      process.chdir(cwdDir);
      mkdirSync(join(cwdDir, 'docs'), { recursive: true });
      writeFileSync(join(cwdDir, 'docs', 'episode.podcast.md'), '# CWD decoy content');

      const readFile = (filePath: string): string | null => {
        const resolved = resolveKeyFilePath(filePath);
        return resolved ? readFileSync(resolved, 'utf-8') : null;
      };
      const item = makeKeyFilesItem('WL-ROOT', ['docs/episode.podcast.md']);
      const joined = formatDetailContent(item, 80, readFile, true, 0, true, 0).join('\n');
      expect(joined).toContain('Worklog root content');
      expect(joined).not.toContain('CWD decoy content');
    } finally {
      process.chdir(originalCwd);
      resetWorklogDir();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── Inline-note editing: viewer integration (WL-0MSKV6SKK008MMXR) ─────
// Red-phase: these tests pin the note-edit chord wiring, the paragraph
// cursor state, and the write-back path that children #2/#3 implement.
// New-module symbols are accessed via dynamic imports so this file stays
// loadable — pre-existing tests remain green while these are RED.

describe('inline-note editing — viewer integration (WL-0MSKV6SKK008MMXR)', () => {
  it('registers a note-edit chord for the detail view in shortcuts.json', () => {
    const registry = loadShortcutConfig();
    const entry = registry.lookupChordEntry(['n', 'e'], 'detail');
    expect(entry).toBeDefined();
    expect(entry?.command).toContain('note-edit');
  });

  it('registers a note-delete chord for the detail view in shortcuts.json', () => {
    const registry = loadShortcutConfig();
    const entry = registry.lookupChordEntry(['n', 'd'], 'detail');
    expect(entry).toBeDefined();
    expect(entry?.command).toContain('note-delete');
  });

  it('note chords are not active in list mode', () => {
    const registry = loadShortcutConfig();
    expect(registry.lookupChordEntry(['n', 'e'], 'list')).toBeUndefined();
    expect(registry.lookupChordEntry(['n', 'd'], 'list')).toBeUndefined();
  });

  it('processChordInput resolves the note-edit chord into a command', () => {
    const registry = loadShortcutConfig();
    const chordState = createChordState();
    // Real flow: detail view on a non-idea item — 'n' alone must not
    // resolve the intake chord (stages ['idea']), so it becomes a leader.
    const step1 = processChordInput(chordState, 'n', registry, 'detail', 'in_review');
    const step2 = processChordInput(chordState, 'e', registry, 'detail', 'in_review');
    expect(step1).toBeNull(); // still collecting
    expect(step2).toBe('chord-complete');
    expect(chordState.resolvedCommand).toContain('note-edit');
  });

  it('tracks a paragraph cursor in the md viewer (detailNoteCursor)', async () => {
    // Child #3 adds a cursor-over-paragraphs state field to the detail
    // viewer. It must default to the first paragraph (index 0) and be
    // exposed on the state object for chord handlers to mutate.
    const wl = await import('./worklist.js');
    const state = new wl.WorkItemListState(
      [makeKeyFilesItem('WL-NOTES', ['notes.md'])],
      TERM_80x24,
    );
    expect(state.detailNoteCursor).toBe(0);
  });

  it('applyNoteEditToFile reads, edits, and writes back via injected reader/writer', async () => {
    const wl = await import('./worklist.js');
    const { insertNoteMarker } = await import('./md-note-edit.js');
    const readFile = vi.fn(() => Promise.resolve('# Doc\n\nPara one.\n\nPara two.'));
    const writeFile = vi.fn(() => Promise.resolve());

    const result = await wl.applyNoteEditToFile(
      makeKeyFilesItem('WL-NOTES', ['notes.md']),
      'notes.md',
      { kind: 'insert', paragraphIndex: 1, text: 'new note' },
      readFile,
      writeFile,
    );

    expect(result).toBeDefined();
    expect(writeFile).toHaveBeenCalledWith(
      'notes.md',
      expect.stringContaining('[NOTE'),
    );
  });

  it('applyNoteEditToFile surfaces the new note id for sync', async () => {
    const wl = await import('./worklist.js');
    const readFile = vi.fn(() => Promise.resolve('# Doc\n\nPara one.'));
    const writeFile = vi.fn(() => Promise.resolve());

    const result = await wl.applyNoteEditToFile(
      makeKeyFilesItem('WL-NOTES', ['notes.md']),
      'notes.md',
      { kind: 'insert', paragraphIndex: 1, text: 'note text' },
      readFile,
      writeFile,
    );

    expect(result.newNoteId).toMatch(/^LOCAL-/);
  });

  it('applyNoteEditToFile creates the note child on a podcast script with a resolvable episode (mocked wl)', async () => {
    const wl = await import('./worklist.js');
    const mockExec = vi.fn(async (_bin: string, args: string[]) => {
      if (args.includes('create')) {
        return { stdout: JSON.stringify({ success: true, workItem: { id: 'OSL-NOTE9' } }), stderr: '' };
      }
      return { stdout: JSON.stringify({ success: true }), stderr: '' };
    });
    setExecFileAsync(mockExec as any);

    const script = `---\npodcast_title: Episode One\n---\n\nNova: Line one.\n\nSorra: Line two.`;
    const readFile = vi.fn(() => Promise.resolve(script));
    const writeFile = vi.fn(() => Promise.resolve());
    const episodes = [
      { id: 'OSL-EP1', title: 'Episode One', status: 'open', stage: 'in_review', priority: 'medium', description: 'ep' },
    ];

    const result = await wl.applyNoteEditToFile(
      makeKeyFilesItem('WL-EP', ['episode.podcast.md']),
      'episode.podcast.md',
      { kind: 'insert', paragraphIndex: 1, text: 'fact check' },
      readFile,
      writeFile,
      episodes as any,
    );

    expect(result.newNoteId).toBe('OSL-NOTE9');
    expect(result.warning).toBeUndefined();
    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      expect.arrayContaining(['create', '--parent', 'OSL-EP1']),
    );
    const written = writeFile.mock.calls[0]?.[1] as string;
    expect(written).toContain('[NOTE OSL-NOTE9: fact check]');
  });

  it('applyNoteEditToFile uses a LOCAL id + warning on an unresolvable episode and never calls wl (mocked wl)', async () => {
    const wl = await import('./worklist.js');
    const mockExec = vi.fn(async (_bin: string, _args: string[]) =>
      ({ stdout: JSON.stringify({ success: true }), stderr: '' }));
    setExecFileAsync(mockExec as any);

    const script = '# Doc\n\nPara one. [NOTE LOCAL-abc: existing local note]';
    const readFile = vi.fn(() => Promise.resolve(script));
    const writeFile = vi.fn(() => Promise.resolve());

    const result = await wl.applyNoteEditToFile(
      makeKeyFilesItem('WL-NOTES', ['notes.md']),
      'notes.md',
      { kind: 'insert', paragraphIndex: 1, text: 'another note' },
      readFile,
      writeFile,
      [{ id: 'OSL-EP1', title: 'Episode One', status: 'open', stage: 'in_review', priority: 'medium', description: 'ep' }] as any,
    );

    expect(result.newNoteId).toMatch(/^LOCAL-/);
    expect(result.warning).toBeTruthy();
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('applyNoteEditToFile marks a podcast note DONE and comments on the child on delete (mocked wl)', async () => {
    const wl = await import('./worklist.js');
    const mockExec = vi.fn(async (_bin: string, args: string[]) => {
      if (args.includes('comment')) {
        return { stdout: JSON.stringify({ success: true }), stderr: '' };
      }
      return { stdout: JSON.stringify({ success: true }), stderr: '' };
    });
    setExecFileAsync(mockExec as any);

    const script = 'text [NOTE OSL-0MSG7Y0C6005QFES: original] more';
    const readFile = vi.fn(() => Promise.resolve(script));
    const writeFile = vi.fn(() => Promise.resolve());
    const episodes = [
      { id: 'OSL-EP1', title: 'Episode One', status: 'open', stage: 'in_review', priority: 'medium', description: 'ep' },
    ];

    const result = await wl.applyNoteEditToFile(
      makeKeyFilesItem('WL-EP', ['episode.podcast.md']),
      'episode.podcast.md',
      { kind: 'remove', noteId: 'OSL-0MSG7Y0C6005QFES', text: 'Resolved' },
      readFile,
      writeFile,
      episodes as any,
    );

    expect(result.doc).toContain('[NOTE OSL-0MSG7Y0C6005QFES: DONE Resolved]');
    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      expect.arrayContaining(['comment', 'add', 'OSL-0MSG7Y0C6005QFES']),
    );
    const written = writeFile.mock.calls[0]?.[1] as string;
    expect(written).toContain('DONE Resolved');
  });

  it('applyNoteEditToFile removes a LOCAL marker without any wl call (generic markdown delete)', async () => {
    const wl = await import('./worklist.js');
    const mockExec = vi.fn(async (_bin: string, _args: string[]) =>
      ({ stdout: JSON.stringify({ success: true }), stderr: '' }));
    setExecFileAsync(mockExec as any);

    const script = 'para one [NOTE LOCAL-abc: note] more';
    const readFile = vi.fn(() => Promise.resolve(script));
    const writeFile = vi.fn(() => Promise.resolve());

    const result = await wl.applyNoteEditToFile(
      makeKeyFilesItem('WL-NOTES', ['notes.md']),
      'notes.md',
      { kind: 'remove', noteId: 'LOCAL-abc' },
      readFile,
      writeFile,
      [{ id: 'OSL-EP1', title: 'Episode One', status: 'open', stage: 'in_review', priority: 'medium', description: 'ep' }] as any,
    );

    expect(result.doc).not.toContain('[NOTE');
    expect(mockExec).not.toHaveBeenCalled();
  });
});
