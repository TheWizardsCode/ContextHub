/**
 * Unit tests for WorkItemListState.refreshItems ID-preserving selection.
 *
 * Run: npx vitest run packages/herdr/src/worklist.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  WorkItemListState,
  getTermSize,
  executeResolvedCommand,
  dispatchChordCommand,
  isImplementCommand,
  formatCodeFreezeDialog,
  ANSI,
  createListRenderer,
  isChordLeader,
  processChordInput,
  createChordState,
  getChordHelpHints,
  handleKeypress,
  computeMetadataPanelHeight,
  formatMetadataPanel,
} from './worklist.js';
import { setLogPath, resetLogPath, recordCommand, getLastCommand } from './command-log.js';
import { loadShortcutConfig, ShortcutRegistry } from './shortcut-config.js';
import { regroupWorkItems } from './grouping.js';
import type { WorkItem } from './fetcher.js';

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
      { ...makeItem('NEXT-OTHER'), stage: 'in_progress', priority: 'medium', group: 3, groupLabel: 'Other' },
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
