/**
 * Tests for the work-item grouping utility used by `wl next --groups/-g`.
 *
 * Tests cover:
 * - File path extraction from descriptions
 * - Greedy first-fit grouping algorithm
 * - Edge cases (no paths, empty descriptions, all items conflict, none conflict)
 */

import { describe, it, expect } from 'vitest';
import { extractFilePaths } from '../src/commands/helpers.js';
import { groupItemsByFilePaths, assignItemGroups, compareGroupableItems } from '../src/commands/grouping.js';

// ── File path extraction ──────────────────────────────────────────────

describe('extractFilePaths', () => {
  it('extracts paths from a **Key Files:** section', () => {
    const description = `## Summary\nDo the thing.\n\n**Key Files:**\n- \`src/commands/next.ts\`\n- \`src/commands/helpers.ts\`\n- \`docs/CLI.md\``;
    const paths = extractFilePaths(description);
    expect(paths).toEqual([
      'src/commands/next.ts',
      'src/commands/helpers.ts',
      'docs/CLI.md',
    ]);
  });

  it('extracts paths from "Key Files:" section without bold markers', () => {
    const description = `Key Files:\n- \`src/foo.ts\`\n- \`src/bar.ts\``;
    const paths = extractFilePaths(description);
    expect(paths).toContain('src/foo.ts');
    expect(paths).toContain('src/bar.ts');
  });

  it('returns empty array when no Key Files section exists', () => {
    const description = `Just a regular description with no paths.`;
    const paths = extractFilePaths(description);
    expect(paths).toEqual([]);
  });

  it('returns empty array for empty description', () => {
    expect(extractFilePaths('')).toEqual([]);
  });

  it('returns empty array when Key Files section has no bullet items', () => {
    const description = `**Key Files:**\nNone yet.`;
    const paths = extractFilePaths(description);
    // The regex looks for backtick-wrapped paths in list items following Key Files
    expect(paths).toEqual([]);
  });

  it('extracts paths with nested directories', () => {
    const description = `**Key Files:**\n- \`packages/shared/src/database.ts\`\n- \`tests/next-regression.test.ts\``;
    const paths = extractFilePaths(description);
    expect(paths).toEqual([
      'packages/shared/src/database.ts',
      'tests/next-regression.test.ts',
    ]);
  });

  it('extracts paths from case-insensitive "key files:" header', () => {
    const description = `key files:\n- \`src/a.ts\`\n- \`src/b.ts\``;
    const paths = extractFilePaths(description);
    expect(paths).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('extracts paths without backticks when listed as plain bullets', () => {
    const description = `Key Files:\n- src/commands/next.ts\n- docs/CLI.md`;
    const paths = extractFilePaths(description);
    expect(paths).toEqual(['src/commands/next.ts', 'docs/CLI.md']);
  });

  it('skips non-path list items under Key Files (URLs, plain words)', () => {
    const description = `**Key Files:**\n- \`src/app.ts\`\n- https://example.com\n- some text\n- \`src/utils.ts\``;
    const paths = extractFilePaths(description);
    expect(paths).toEqual(['src/app.ts', 'src/utils.ts']);
  });

  it('handles paths with dots and hyphens', () => {
    const description = `**Key Files:**\n- \`src/utils/file-helpers.ts\`\n- \`docs/my-doc-file.md\``;
    const paths = extractFilePaths(description);
    expect(paths).toEqual([
      'src/utils/file-helpers.ts',
      'docs/my-doc-file.md',
    ]);
  });

  it('extracts from multiple Key Files sections (only first)', () => {
    // Only the first Key Files section should be processed
    const description = `**Key Files:**\n- \`src/a.ts\`\nSome text\n**Key Files:**\n- \`src/b.ts\``;
    const paths = extractFilePaths(description);
    expect(paths).toEqual(['src/a.ts']);
  });

  it('extracts backtick-wrapped paths with trailing description text', () => {
    // Many work items add a description after the path, e.g.:
    // - `path/to/file.ts` — New: some description
    const description = `**Key Files:**\n- \`src/commands/helpers.ts\` — Shared helper functions\n- \`src/commands/grouping.ts\`: Grouping algorithm\n- \`docs/CLI.md\` (CLI reference)\n- \`src/foo.ts\``;
    const paths = extractFilePaths(description);
    expect(paths).toEqual([
      'src/commands/helpers.ts',
      'src/commands/grouping.ts',
      'docs/CLI.md',
      'src/foo.ts',
    ]);
  });

  it('extracts paths from ## Key Files heading (no colon, heading style)', () => {
    // Work items often use a Markdown heading `## Key Files` without a trailing colon
    const description = `## Key Files\n- \`src/commands/next.ts\`\n- \`src/commands/helpers.ts\`\n- \`docs/CLI.md\``;
    const paths = extractFilePaths(description);
    expect(paths).toEqual([
      'src/commands/next.ts',
      'src/commands/helpers.ts',
      'docs/CLI.md',
    ]);
  });

  it('extracts paths from ## Key Files heading with trailing description text', () => {
    // Combined: heading style header + paths with trailing descriptions
    const description = `## Key Files\n- \`src/commands/helpers.ts\` — Shared helper functions\n- \`src/commands/grouping.ts\`: Grouping algorithm\n- \`docs/CLI.md\` (CLI reference)`;
    const paths = extractFilePaths(description);
    expect(paths).toEqual([
      'src/commands/helpers.ts',
      'src/commands/grouping.ts',
      'docs/CLI.md',
    ]);
  });
});

// ── Grouping algorithm ────────────────────────────────────────

describe('groupItemsByFilePaths', () => {
  it('places conflicting items in different groups', () => {
    const items = [
      { id: 'WL-1', filePaths: ['src/foo.ts'] },
      { id: 'WL-2', filePaths: ['src/foo.ts'] },  // conflicts with WL-1
    ];
    const groups = groupItemsByFilePaths(items, 3);
    expect(groups.get('WL-1')).toBe(1);
    expect(groups.get('WL-2')).toBe(2);  // different group
  });

  it('places non-conflicting items in the same group', () => {
    const items = [
      { id: 'WL-1', filePaths: ['src/foo.ts'] },
      { id: 'WL-2', filePaths: ['src/bar.ts'] },  // no conflict
    ];
    const groups = groupItemsByFilePaths(items, 3);
    expect(groups.get('WL-1')).toBe(1);
    expect(groups.get('WL-2')).toBe(1);  // same group
  });

  it('assigns items with unknown (empty) file paths to singleton groups', () => {
    const items = [
      { id: 'WL-1', filePaths: [] },
      { id: 'WL-2', filePaths: ['src/bar.ts'] },
    ];
    const groups = groupItemsByFilePaths(items, 3);
    expect(groups.get('WL-1')).toBe(1);   // unknown = group 1 (singleton)
    expect(groups.get('WL-2')).toBe(2);   // group 2
  });

  it('assigns multiple unknown items to separate singleton groups', () => {
    const items = [
      { id: 'WL-1', filePaths: [] },
      { id: 'WL-2', filePaths: [] },
      { id: 'WL-3', filePaths: ['src/bar.ts'] },
    ];
    const groups = groupItemsByFilePaths(items, 3);
    // WL-1 is group 1 (unknown singleton)
    // WL-2 is group 2 (unknown singleton)
    // WL-3 is group 3 (no conflict with unknowns since unknowns are singletons)
    expect(groups.get('WL-1')).toBe(1);
    expect(groups.get('WL-2')).toBe(2);
    expect(groups.get('WL-3')).toBe(3);
  });

  it('respects the maxGroups limit', () => {
    // 5 items, all mutually conflicting (same path), maxGroups=3
    // Items 1-3 go into groups 1-3. Items 4-5 also get singletons (exceeding maxGroups)
    const items = Array.from({ length: 5 }, (_, i) => ({
      id: `WL-${i + 1}`,
      filePaths: ['src/shared.ts'],
    }));
    const groups = groupItemsByFilePaths(items, 3);
    // First 3 items get groups 1-3
    expect(groups.get('WL-1')).toBe(1);
    expect(groups.get('WL-2')).toBe(2);
    expect(groups.get('WL-3')).toBe(3);
    // Items beyond maxGroups get singleton groups too (4, 5, ...)
    expect(typeof groups.get('WL-4')).toBe('number');
    expect(typeof groups.get('WL-5')).toBe('number');
    // All group numbers should be unique (each item is isolated due to conflict)
    const groupNums = new Set(items.map(i => groups.get(i.id)));
    expect(groupNums.size).toBe(items.length);
  });

  it('places item in first non-conflicting group', () => {
    const items = [
      { id: 'WL-1', filePaths: ['src/foo.ts'] },
      { id: 'WL-2', filePaths: ['src/bar.ts'] },  // no conflict with WL-1 → group 1
      { id: 'WL-3', filePaths: ['src/foo.ts'] },  // conflicts with WL-1 → group 2
      { id: 'WL-4', filePaths: ['src/bar.ts'] },  // conflicts with WL-2, but WL-1's group has WL-2 (no conflict with foo) → group 1
    ];
    const groups = groupItemsByFilePaths(items, 3);
    // WL-1 has foo, WL-2 has bar → both in group 1
    // WL-3 has foo → conflicts with WL-1 → group 2
    // WL-4 has bar → conflicts with WL-2 in group 1, but also check group 2...
    // WL-4 has bar, WL-3 has foo → no conflict → group 2! Wait, but greedy first-fit checks group 1 first.
    // Actually, WL-4 checks group 1 first: conflicts with WL-2 (bar). Then group 2: WL-3 has foo, no conflict with bar → group 2
    expect(groups.get('WL-1')).toBe(1);
    expect(groups.get('WL-2')).toBe(1);
    expect(groups.get('WL-3')).toBe(2);
    expect(groups.get('WL-4')).toBe(2); // group 2 because food & bar don't conflict
  });

  it('handles empty items array', () => {
    const groups = groupItemsByFilePaths([], 3);
    expect(groups.size).toBe(0);
  });

  it('handles single item', () => {
    const items = [{ id: 'WL-1', filePaths: ['src/foo.ts'] }];
    const groups = groupItemsByFilePaths(items, 3);
    expect(groups.get('WL-1')).toBe(1);
  });

  it('gives items with no paths to their own singleton groups', () => {
    // Items 1,3 have no paths. Item 2 has paths.
    // The no-path items don't conflict with paths or with each other (each is a singleton)
    const items = [
      { id: 'WL-1', filePaths: [] },
      { id: 'WL-2', filePaths: ['src/a.ts'] },
      { id: 'WL-3', filePaths: [] },
    ];
    const groups = groupItemsByFilePaths(items, 3);
    expect(groups.get('WL-1')).toBe(1);
    expect(groups.get('WL-2')).toBe(2);   // goes into a clean group
    expect(groups.get('WL-3')).toBe(3);
  });

  it('produces deterministic group assignments for same input', () => {
    const items = [
      { id: 'WL-1', filePaths: ['src/foo.ts'] },
      { id: 'WL-2', filePaths: ['src/bar.ts'] },
      { id: 'WL-3', filePaths: ['src/foo.ts'] },
      { id: 'WL-4', filePaths: ['src/baz.ts'] },
    ];
    const run1 = groupItemsByFilePaths(items, 3);
    const run2 = groupItemsByFilePaths(items, 3);
    expect(run1).toEqual(run2);
  });

  it('handles items with multiple file paths', () => {
    const items = [
      { id: 'WL-1', filePaths: ['src/a.ts', 'src/b.ts'] },
      { id: 'WL-2', filePaths: ['src/b.ts'] },  // conflicts with WL-1 via b.ts
      { id: 'WL-3', filePaths: ['src/c.ts'] },  // no conflict
    ];
    const groups = groupItemsByFilePaths(items, 3);
    expect(groups.get('WL-1')).toBe(1);
    expect(groups.get('WL-2')).toBe(2);  // different group (conflict via b.ts)
    expect(groups.get('WL-3')).toBe(1);  // same as WL-1 (no conflict)
  });

  it('handles maxGroups=1 (single group)', () => {
    const items = [
      { id: 'WL-1', filePaths: ['src/a.ts'] },
      { id: 'WL-2', filePaths: ['src/b.ts'] },  // no conflict
    ];
    const groups = groupItemsByFilePaths(items, 1);
    expect(groups.get('WL-1')).toBe(1);
    expect(groups.get('WL-2')).toBe(1);  // all in group 1 since no conflict
  });
});

// ── assignItemGroups ──────────────────────────────────────────────────

// ── assignItemGroups (new spec) ───────────────────────────────────────

/**
 * New spec (WL-0MSAK8YLB0025EGW): group display order is
 * Critical Group 1..x → Group 1..x (plan_complete + intake_complete) →
 * Idea → Other → In Review (last). Critical items are partitioned by
 * file-path conflicts into `Critical Group N` (no single all-inclusive
 * "Critical" group). plan_complete/intake_complete items are partitioned
 * into `Group N` (no stage prefix in the label).
 */

describe('assignItemGroups — new group order', () => {
  it('produces the full group order: Critical Group N → Group N → Idea → Other → In Review', () => {
    const items = [
      { id: 'WL-C1', stage: 'plan_complete', filePaths: ['src/c.ts'], priority: 'critical' },
      { id: 'WL-P1', stage: 'plan_complete', filePaths: ['src/p1.ts'], priority: 'high' },
      { id: 'WL-I1', stage: 'intake_complete', filePaths: ['src/i1.ts'], priority: 'medium' },
      { id: 'WL-idea', stage: 'idea', filePaths: [], priority: 'low' },
      { id: 'WL-other', stage: 'in_progress', filePaths: [], priority: 'medium' },
      { id: 'WL-R1', stage: 'in_review', filePaths: [], priority: 'medium' },
    ];
    const groups = assignItemGroups(items, 3);
    const groupOf = (id: string): number => groups.get(id)!.group;
    // Critical group comes first.
    expect(groups.get('WL-C1')!.groupLabel).toBe('Critical Group 1');
    expect(groupOf('WL-C1')).toBeLessThan(groupOf('WL-P1'));
    // Plan/intake groups come before Idea.
    expect(groups.get('WL-P1')!.groupLabel).toBe('Group 1');
    expect(groups.get('WL-I1')!.groupLabel).toBe('Group 1');
    expect(groupOf('WL-P1')).toBeLessThan(groupOf('WL-idea'));
    // Idea before Other.
    expect(groupOf('WL-idea')).toBeLessThan(groupOf('WL-other'));
    // Other before In Review (In Review last).
    expect(groupOf('WL-other')).toBeLessThan(groupOf('WL-R1'));
    expect(groups.get('WL-R1')!.groupLabel).toBe('In Review');
  });

  it('does not emit a single all-inclusive "Critical" group', () => {
    const items = [
      { id: 'WL-C1', stage: 'plan_complete', filePaths: ['src/a.ts'], priority: 'critical' },
      { id: 'WL-C2', stage: 'plan_complete', filePaths: ['src/b.ts'], priority: 'critical' },
    ];
    const groups = assignItemGroups(items, 3);
    for (const [, assignment] of groups) {
      expect(assignment.groupLabel).not.toBe('Critical');
    }
  });
});

describe('assignItemGroups — Critical Group N', () => {
  it('partitions conflicting critical items into separate Critical Group N labels', () => {
    const items = [
      { id: 'WL-C1', stage: 'plan_complete', filePaths: ['src/foo.ts'], priority: 'critical' },
      { id: 'WL-C2', stage: 'plan_complete', filePaths: ['src/foo.ts'], priority: 'critical' },
    ];
    const groups = assignItemGroups(items, 3);
    expect(groups.get('WL-C1')!.groupLabel).toBe('Critical Group 1');
    expect(groups.get('WL-C2')!.groupLabel).toBe('Critical Group 2');
  });

  it('gives critical items with unknown paths singleton Critical Group N labels', () => {
    const items = [
      { id: 'WL-C1', stage: 'plan_complete', filePaths: ['src/foo.ts'], priority: 'critical' },
      { id: 'WL-C2', stage: 'idea', filePaths: [], priority: 'critical' },
    ];
    const groups = assignItemGroups(items, 3);
    expect(groups.get('WL-C1')!.groupLabel).toBe('Critical Group 1');
    expect(groups.get('WL-C2')!.groupLabel).toBe('Critical Group 2');
  });

  it('places non-conflicting critical items in the same Critical Group', () => {
    const items = [
      { id: 'WL-C1', stage: 'plan_complete', filePaths: ['src/a.ts'], priority: 'critical' },
      { id: 'WL-C2', stage: 'intake_complete', filePaths: ['src/b.ts'], priority: 'critical' },
    ];
    const groups = assignItemGroups(items, 3);
    expect(groups.get('WL-C1')!.groupLabel).toBe('Critical Group 1');
    expect(groups.get('WL-C2')!.groupLabel).toBe('Critical Group 1');
  });

  it('excludes critical items from their stage groups (Idea/Other/In Review)', () => {
    const items = [
      { id: 'WL-C1', stage: 'idea', filePaths: [], priority: 'critical' },
      { id: 'WL-idea', stage: 'idea', filePaths: [], priority: 'medium' },
      { id: 'WL-other', stage: 'in_progress', filePaths: [], priority: 'medium' },
    ];
    const groups = assignItemGroups(items, 3);
    expect(groups.get('WL-C1')!.groupLabel).toBe('Critical Group 1');
    // Non-critical idea/other items land in later groups (not the critical one).
    expect(groups.get('WL-idea')!.groupLabel).toBe('Idea');
    expect(groups.get('WL-idea')!.group).toBeGreaterThan(groups.get('WL-C1')!.group);
    expect(groups.get('WL-other')!.groupLabel).toBe('Other');
    expect(groups.get('WL-other')!.group).toBeGreaterThan(groups.get('WL-idea')!.group);
  });
});

describe('assignItemGroups — Group N (plan_complete + intake_complete)', () => {
  it('partitions plan_complete and intake_complete items into Group N labels (no stage prefix)', () => {
    const items = [
      { id: 'WL-P1', stage: 'plan_complete', filePaths: ['src/a.ts'], priority: 'high' },
      { id: 'WL-I1', stage: 'intake_complete', filePaths: ['src/b.ts'], priority: 'medium' },
      { id: 'WL-P2', stage: 'plan_complete', filePaths: ['src/a.ts'], priority: 'high' },
    ];
    const groups = assignItemGroups(items, 3);
    expect(groups.get('WL-P1')!.groupLabel).toBe('Group 1');
    expect(groups.get('WL-I1')!.groupLabel).toBe('Group 1');
    expect(groups.get('WL-P2')!.groupLabel).toBe('Group 2');
  });

  it('does not emit "Plan Complete Group" or "Intake Complete" labels', () => {
    const items = [
      { id: 'WL-P1', stage: 'plan_complete', filePaths: ['src/a.ts'], priority: 'high' },
      { id: 'WL-I1', stage: 'intake_complete', filePaths: ['src/b.ts'], priority: 'medium' },
    ];
    const groups = assignItemGroups(items, 3);
    for (const [, assignment] of groups) {
      expect(assignment.groupLabel).not.toContain('Plan Complete Group');
      expect(assignment.groupLabel).not.toBe('Intake Complete');
    }
  });
});

describe('assignItemGroups — Idea / Other / In Review', () => {
  it('places all idea items in a single "Idea" group', () => {
    const items = [
      { id: 'WL-1', stage: 'idea', filePaths: [] },
      { id: 'WL-2', stage: 'idea', filePaths: ['src/foo.ts'] },
    ];
    const groups = assignItemGroups(items, 3);
    expect(groups.get('WL-1')!.group).toBe(1);
    expect(groups.get('WL-1')!.groupLabel).toBe('Idea');
    expect(groups.get('WL-2')!.group).toBe(1);
    expect(groups.get('WL-2')!.groupLabel).toBe('Idea');
  });

  it('places all remaining items in a single "Other" group', () => {
    const items = [
      { id: 'WL-1', stage: 'in_progress', filePaths: [] },
      { id: 'WL-2', stage: undefined, filePaths: ['src/bar.ts'] },
    ];
    const groups = assignItemGroups(items, 3);
    expect(groups.get('WL-1')!.groupLabel).toBe('Other');
    expect(groups.get('WL-2')!.groupLabel).toBe('Other');
    expect(groups.get('WL-1')!.group).toBe(groups.get('WL-2')!.group);
  });

  it('places all in_review items in a single "In Review" group placed after Other', () => {
    const items = [
      { id: 'WL-R1', stage: 'in_review', filePaths: ['src/foo.ts'] },
      { id: 'WL-other', stage: 'in_progress', filePaths: [] },
      { id: 'WL-R2', stage: 'in_review', filePaths: ['src/bar.ts'] },
    ];
    const groups = assignItemGroups(items, 3);
    expect(groups.get('WL-R1')!.groupLabel).toBe('In Review');
    expect(groups.get('WL-R2')!.groupLabel).toBe('In Review');
    expect(groups.get('WL-R1')!.group).toBe(groups.get('WL-R2')!.group);
    expect(groups.get('WL-other')!.group).toBeLessThan(groups.get('WL-R1')!.group);
  });

  it('does not show an In Review group when no in_review items exist', () => {
    const items = [
      { id: 'WL-1', stage: 'idea', filePaths: [] },
      { id: 'WL-2', stage: 'in_progress', filePaths: [] },
    ];
    const groups = assignItemGroups(items, 3);
    for (const [, assignment] of groups) {
      expect(assignment.groupLabel).not.toBe('In Review');
    }
  });

  it('handles empty items array', () => {
    expect(assignItemGroups([], 3).size).toBe(0);
  });

  it('handles a single item', () => {
    const groups = assignItemGroups([{ id: 'WL-1', stage: 'idea', filePaths: [] }], 3);
    expect(groups.get('WL-1')!.groupLabel).toBe('Idea');
  });
});

// ── compareGroupableItems — within-group ordering ─────────────────────

describe('compareGroupableItems — within-group ordering', () => {
  it('orders plan_complete before intake_complete before remaining stages', () => {
    const plan = { id: 'P', stage: 'plan_complete', filePaths: [], priority: 'medium' };
    const intake = { id: 'I', stage: 'intake_complete', filePaths: [], priority: 'medium' };
    const other = { id: 'O', stage: 'in_progress', filePaths: [], priority: 'medium' };
    expect(compareGroupableItems(plan, intake)).toBeLessThan(0);
    expect(compareGroupableItems(intake, other)).toBeLessThan(0);
    expect(compareGroupableItems(plan, other)).toBeLessThan(0);
  });

  it('orders by priority (high → medium → low) within the same stage sub-group', () => {
    const high = { id: 'H', stage: 'intake_complete', filePaths: [], priority: 'high' };
    const medium = { id: 'M', stage: 'intake_complete', filePaths: [], priority: 'medium' };
    const low = { id: 'L', stage: 'intake_complete', filePaths: [], priority: 'low' };
    expect(compareGroupableItems(high, medium)).toBeLessThan(0);
    expect(compareGroupableItems(medium, low)).toBeLessThan(0);
    expect(compareGroupableItems(high, low)).toBeLessThan(0);
  });

  it('treats unknown priority as medium', () => {
    const unknown = { id: 'U', stage: 'idea', filePaths: [], priority: undefined };
    const high = { id: 'H', stage: 'idea', filePaths: [], priority: 'high' };
    const low = { id: 'L', stage: 'idea', filePaths: [], priority: 'low' };
    expect(compareGroupableItems(high, unknown)).toBeLessThan(0);
    expect(compareGroupableItems(unknown, low)).toBeLessThan(0);
  });

  it('uses id as a deterministic tie-break', () => {
    const a = { id: 'A', stage: 'idea', filePaths: [], priority: 'high' };
    const b = { id: 'B', stage: 'idea', filePaths: [], priority: 'high' };
    expect(compareGroupableItems(a, b)).toBeLessThan(0);
    expect(compareGroupableItems(b, a)).toBeGreaterThan(0);
  });

  it('sorts a mixed plan+intake group: plan_complete first then intake_complete, each by priority', () => {
    const items = [
      { id: 'I-low', stage: 'intake_complete', filePaths: [], priority: 'low' },
      { id: 'P-med', stage: 'plan_complete', filePaths: [], priority: 'medium' },
      { id: 'I-high', stage: 'intake_complete', filePaths: [], priority: 'high' },
      { id: 'P-high', stage: 'plan_complete', filePaths: [], priority: 'high' },
    ];
    const sorted = items.slice().sort(compareGroupableItems);
    expect(sorted.map(i => i.id)).toEqual(['P-high', 'P-med', 'I-high', 'I-low']);
  });

  it('sorts a critical group with the same stage sub-sort', () => {
    const items = [
      { id: 'C-other', stage: 'in_progress', filePaths: [], priority: 'critical' },
      { id: 'C-intake', stage: 'intake_complete', filePaths: [], priority: 'critical' },
      { id: 'C-plan', stage: 'plan_complete', filePaths: [], priority: 'critical' },
    ];
    const sorted = items.slice().sort(compareGroupableItems);
    expect(sorted.map(i => i.id)).toEqual(['C-plan', 'C-intake', 'C-other']);
  });
});
