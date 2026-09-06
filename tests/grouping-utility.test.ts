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
      { id: 'WL-IP1', stage: 'in_progress', filePaths: ['src/ip1.ts'], priority: 'high' },
      { id: 'WL-idea', stage: 'idea', filePaths: [], priority: 'low' },
      { id: 'WL-other', stage: undefined, filePaths: [], priority: 'medium' },
      { id: 'WL-R1', stage: 'in_review', filePaths: [], priority: 'medium' },
    ];
    const groups = assignItemGroups(items, 3);
    const groupOf = (id: string): number => groups.get(id)!.group;
    // Critical group comes first.
    expect(groups.get('WL-C1')!.groupLabel).toBe('Critical Group 1');
    expect(groupOf('WL-C1')).toBeLessThan(groupOf('WL-P1'));
    // Plan/intake/in_progress items share Group N (no stage prefix in the label).
    expect(groups.get('WL-P1')!.groupLabel).toBe('Group 1');
    expect(groups.get('WL-I1')!.groupLabel).toBe('Group 1');
    expect(groups.get('WL-IP1')!.groupLabel).toBe('Group 1');
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
      { id: 'WL-other', stage: 'custom', filePaths: [], priority: 'medium' },
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

describe('assignItemGroups — Group N (in_progress + plan_complete + intake_complete)', () => {
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

  it('includes in_progress items in Group N alongside plan_complete/intake_complete', () => {
    const items = [
      { id: 'WL-P1', stage: 'plan_complete', filePaths: ['src/a.ts'], priority: 'high' },
      { id: 'WL-IP1', stage: 'in_progress', filePaths: ['src/b.ts'], priority: 'high' },
      { id: 'WL-I1', stage: 'intake_complete', filePaths: ['src/c.ts'], priority: 'medium' },
      // Conflicts with WL-P1 via src/a.ts → lands in a different Group N.
      { id: 'WL-IP2', stage: 'in_progress', filePaths: ['src/a.ts'], priority: 'medium' },
    ];
    const groups = assignItemGroups(items, 3);
    expect(groups.get('WL-P1')!.groupLabel).toBe('Group 1');
    expect(groups.get('WL-IP1')!.groupLabel).toBe('Group 1');
    expect(groups.get('WL-I1')!.groupLabel).toBe('Group 1');
    expect(groups.get('WL-IP2')!.groupLabel).toBe('Group 2');
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
    // `done` and unknown/custom stages fall back to "Other" (safety net).
    const items = [
      { id: 'WL-1', stage: 'done', filePaths: [] },
      { id: 'WL-2', stage: undefined, filePaths: ['src/bar.ts'] },
    ];
    const groups = assignItemGroups(items, 3);
    expect(groups.get('WL-1')!.groupLabel).toBe('Other');
    expect(groups.get('WL-2')!.groupLabel).toBe('Other');
    expect(groups.get('WL-1')!.group).toBe(groups.get('WL-2')!.group);
  });

  it('never places canonical stages in "Other" (in_progress joins Group N)', () => {
    // Every canonical stage that can appear in the default selection list maps
    // to a named group; "Other" is only the safety net for unknown/custom stages.
    // (`done` items are excluded from the default list by smart selection, so
    // they are not asserted here; when explicitly included they still fall back
    // to "Other".)
    const items = [
      { id: 'WL-idea', stage: 'idea', filePaths: ['src/idea.ts'], priority: 'medium' },
      { id: 'WL-intake', stage: 'intake_complete', filePaths: ['src/intake.ts'], priority: 'medium' },
      { id: 'WL-plan', stage: 'plan_complete', filePaths: ['src/plan.ts'], priority: 'medium' },
      { id: 'WL-progress', stage: 'in_progress', filePaths: ['src/progress.ts'], priority: 'medium' },
      { id: 'WL-review', stage: 'in_review', filePaths: ['src/review.ts'], priority: 'medium' },
    ];
    const groups = assignItemGroups(items, 3);
    for (const [, assignment] of groups) {
      expect(assignment.groupLabel).not.toBe('Other');
    }
    // Unknown/custom stages and `done` (when explicitly included) still fall
    // back to "Other" as the safety net.
    const unknown = assignItemGroups([{ id: 'WL-x', stage: 'custom', filePaths: [], priority: 'medium' }], 3);
    expect(unknown.get('WL-x')!.groupLabel).toBe('Other');
    const noStage = assignItemGroups([{ id: 'WL-y', stage: undefined, filePaths: [], priority: 'medium' }], 3);
    expect(noStage.get('WL-y')!.groupLabel).toBe('Other');
    const done = assignItemGroups([{ id: 'WL-done', stage: 'done', filePaths: [], priority: 'medium' }], 3);
    expect(done.get('WL-done')!.groupLabel).toBe('Other');
  });

  it('places all in_review items in a single "In Review" group placed after Other', () => {
    const items = [
      { id: 'WL-R1', stage: 'in_review', filePaths: ['src/foo.ts'] },
      { id: 'WL-other', stage: 'done', filePaths: [] },
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
  it('orders in_progress before plan_complete before intake_complete before remaining stages', () => {
    const progress = { id: 'IP', stage: 'in_progress', filePaths: [], priority: 'medium' };
    const plan = { id: 'P', stage: 'plan_complete', filePaths: [], priority: 'medium' };
    const intake = { id: 'I', stage: 'intake_complete', filePaths: [], priority: 'medium' };
    const other = { id: 'O', stage: 'done', filePaths: [], priority: 'medium' };
    expect(compareGroupableItems(progress, plan)).toBeLessThan(0);
    expect(compareGroupableItems(plan, intake)).toBeLessThan(0);
    expect(compareGroupableItems(intake, other)).toBeLessThan(0);
    expect(compareGroupableItems(progress, other)).toBeLessThan(0);
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

  it('sorts in_progress items to the top of a mixed group, then plan_complete, then intake_complete', () => {
    const items = [
      { id: 'I-low', stage: 'intake_complete', filePaths: [], priority: 'low' },
      { id: 'P-med', stage: 'plan_complete', filePaths: [], priority: 'medium' },
      { id: 'IP-high', stage: 'in_progress', filePaths: [], priority: 'high' },
      { id: 'IP-low', stage: 'in_progress', filePaths: [], priority: 'low' },
      { id: 'P-high', stage: 'plan_complete', filePaths: [], priority: 'high' },
    ];
    const sorted = items.slice().sort(compareGroupableItems);
    expect(sorted.map(i => i.id)).toEqual(['IP-high', 'IP-low', 'P-high', 'P-med', 'I-low']);
  });

  it('sorts a critical group with the same stage sub-sort', () => {
    const items = [
      { id: 'C-other', stage: 'in_progress', filePaths: [], priority: 'critical' },
      { id: 'C-intake', stage: 'intake_complete', filePaths: [], priority: 'critical' },
      { id: 'C-plan', stage: 'plan_complete', filePaths: [], priority: 'critical' },
    ];
    const sorted = items.slice().sort(compareGroupableItems);
    expect(sorted.map(i => i.id)).toEqual(['C-other', 'C-plan', 'C-intake']);
  });
});

// ── in_review 6-bucket sort (WL-0MSLPM5ZB003TADT) ──────────────────────

import { inReviewBucket, compareInReviewItems } from '../src/commands/grouping.js';

describe('in_review 6-bucket sort (WL-0MSLPM5ZB003TADT)', () => {
  // isAuditFresh(auditedAt, updatedAt) → auditedAt > updatedAt - 60s
  // So auditedAt === updatedAt is fresh; auditedAt 10m before updatedAt is stale.
  const updatedAt = '2026-01-10T10:00:00.000Z';
  const freshAuditedAt = '2026-01-10T10:00:00.000Z'; // same instant → fresh
  const staleAuditedAt = '2026-01-10T09:40:00.000Z'; // 20m earlier → stale

  function inReviewItem(overrides: Record<string, unknown> = {}) {
    return { id: 'WL-x', stage: 'in_review', filePaths: [], priority: 'medium', ...overrides };
  }

  it('inReviewBucket returns correct bucket for each category', () => {
    expect(inReviewBucket({
      stage: 'in_review', needsProducerReview: true,
      auditResult: null, auditedAt: null, updatedAt,
    })).toBe(1);
    expect(inReviewBucket({
      stage: 'in_review', auditResult: false, auditedAt: freshAuditedAt, updatedAt,
    })).toBe(2);
    expect(inReviewBucket({
      stage: 'in_review', auditResult: false, auditedAt: staleAuditedAt, updatedAt,
    })).toBe(3);
    expect(inReviewBucket({
      stage: 'in_review', auditResult: null, auditedAt: null, updatedAt,
    })).toBe(4);
    expect(inReviewBucket({
      stage: 'in_review', auditResult: true, auditedAt: staleAuditedAt, updatedAt,
    })).toBe(5);
    expect(inReviewBucket({
      stage: 'in_review', auditResult: true, auditedAt: freshAuditedAt, updatedAt,
    })).toBe(6);
    // Non in_review stages return sentinel 0
    expect(inReviewBucket({
      stage: 'plan_complete', auditResult: false, auditedAt: freshAuditedAt, updatedAt,
    })).toBe(0);
  });

  it('orders the six buckets: needsProducerReview → failed fresh → failed stale → no audit → passed stale → passed fresh', () => {
    const items = [
      inReviewItem({ id: 'WL-passed-fresh', auditResult: true, auditedAt: freshAuditedAt, updatedAt }),
      inReviewItem({ id: 'WL-passed-stale', auditResult: true, auditedAt: staleAuditedAt, updatedAt }),
      inReviewItem({ id: 'WL-no-audit', auditResult: null, auditedAt: null, updatedAt }),
      inReviewItem({ id: 'WL-failed-stale', auditResult: false, auditedAt: staleAuditedAt, updatedAt }),
      inReviewItem({ id: 'WL-failed-fresh', auditResult: false, auditedAt: freshAuditedAt, updatedAt }),
      inReviewItem({ id: 'WL-needs-producer', needsProducerReview: true, auditResult: false, auditedAt: freshAuditedAt, updatedAt }),
    ];
    // Shuffle then sort
    const shuffled = [items[0], items[3], items[1], items[5], items[2], items[4]];
    const sorted = shuffled.slice().sort(compareGroupableItems);
    expect(sorted.map(i => (i as { id: string }).id)).toEqual([
      'WL-needs-producer',
      'WL-failed-fresh',
      'WL-failed-stale',
      'WL-no-audit',
      'WL-passed-stale',
      'WL-passed-fresh',
    ]);
  });

  it('within the same bucket orders by priority high → medium → low', () => {
    const items = [
      inReviewItem({ id: 'WL-low', priority: 'low', auditResult: null }),
      inReviewItem({ id: 'WL-high', priority: 'high', auditResult: null }),
      inReviewItem({ id: 'WL-med', priority: 'medium', auditResult: null }),
    ];
    const sorted = items.slice().sort(compareGroupableItems);
    expect(sorted.map(i => (i as { id: string }).id)).toEqual(['WL-high', 'WL-med', 'WL-low']);
  });

  it('within same bucket and priority orders by updatedAt older first', () => {
    const items = [
      inReviewItem({ id: 'WL-newer', auditResult: null, updatedAt: '2026-01-10T12:00:00.000Z' }),
      inReviewItem({ id: 'WL-older', auditResult: null, updatedAt: '2026-01-10T08:00:00.000Z' }),
      inReviewItem({ id: 'WL-mid', auditResult: null, updatedAt: '2026-01-10T10:00:00.000Z' }),
    ];
    const sorted = items.slice().sort(compareGroupableItems);
    expect(sorted.map(i => (i as { id: string }).id)).toEqual(['WL-older', 'WL-mid', 'WL-newer']);
  });

  it('uses id as deterministic tie-break when bucket, priority, and timestamp are equal', () => {
    const items = [
      inReviewItem({ id: 'WL-b', auditResult: null, updatedAt }),
      inReviewItem({ id: 'WL-a', auditResult: null, updatedAt }),
      inReviewItem({ id: 'WL-c', auditResult: null, updatedAt }),
    ];
    const sorted = items.slice().sort(compareGroupableItems);
    expect(sorted.map(i => (i as { id: string }).id)).toEqual(['WL-a', 'WL-b', 'WL-c']);
  });

  it('does not apply bucket sort to non-in_review items', () => {
    const a = { id: 'WL-a', stage: 'plan_complete', filePaths: [], priority: 'medium', needsProducerReview: true };
    const b = { id: 'WL-b', stage: 'plan_complete', filePaths: [], priority: 'medium' };
    expect(compareGroupableItems(a, b)).toBeLessThan(0); // WL-a < WL-b lexicographically
  });

  it('compareInReviewItems returns 0 for non-in_review items', () => {
    const a = { id: 'WL-a', stage: 'plan_complete', filePaths: [], priority: 'medium', needsProducerReview: true } as any;
    const b = { id: 'WL-b', stage: 'intake_complete', filePaths: [], priority: 'medium' } as any;
    expect(compareInReviewItems(a, b)).toBe(0);
  });
});
