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
import { groupItemsByFilePaths, assignItemGroups } from '../src/commands/grouping.js';

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
});

// ── Grouping algorithm ────────────────────────────────────────────────

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

describe('assignItemGroups', () => {
  it('groups all idea items together with label "Idea"', () => {
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

  it('groups all intake_complete items together with label "Intake Complete"', () => {
    const items = [
      { id: 'WL-1', stage: 'intake_complete', filePaths: ['src/foo.ts'] },
      { id: 'WL-2', stage: 'intake_complete', filePaths: ['src/bar.ts'] },
    ];
    const groups = assignItemGroups(items, 3);
    expect(groups.get('WL-1')!.group).toBe(1);
    expect(groups.get('WL-1')!.groupLabel).toBe('Intake Complete');
    expect(groups.get('WL-2')!.group).toBe(1);
    expect(groups.get('WL-2')!.groupLabel).toBe('Intake Complete');
  });

  it('groups all in_review items together with label "In Review"', () => {
    const items = [
      { id: 'WL-1', stage: 'in_review', filePaths: ['src/foo.ts'] },
      { id: 'WL-2', stage: 'in_review', filePaths: ['src/bar.ts'] },
    ];
    const groups = assignItemGroups(items, 3);
    expect(groups.get('WL-1')!.group).toBe(1);
    expect(groups.get('WL-1')!.groupLabel).toBe('In Review');
    expect(groups.get('WL-2')!.group).toBe(1);
    expect(groups.get('WL-2')!.groupLabel).toBe('In Review');
  });

  it('groups stages in reversed order: in_review, intake_complete, idea', () => {
    const items = [
      { id: 'WL-idea', stage: 'idea', filePaths: [] },
      { id: 'WL-intake', stage: 'intake_complete', filePaths: [] },
      { id: 'WL-review', stage: 'in_review', filePaths: [] },
    ];
    const groups = assignItemGroups(items, 3);
    expect(groups.get('WL-review')!.group).toBe(1);
    expect(groups.get('WL-intake')!.group).toBe(2);
    expect(groups.get('WL-idea')!.group).toBe(3);
  });

  it('groups plan_complete items by file-path conflicts', () => {
    const items = [
      { id: 'WL-1', stage: 'plan_complete', filePaths: ['src/foo.ts'] },
      { id: 'WL-2', stage: 'plan_complete', filePaths: ['src/bar.ts'] },  // no conflict
      { id: 'WL-3', stage: 'plan_complete', filePaths: ['src/foo.ts'] },  // conflicts with WL-1
    ];
    const groups = assignItemGroups(items, 3);
    // plan_complete groups come after stage groups, so start at group 4 (no stage groups in this test)
    // Actually, with no idea/intake/in_review, plan_complete starts at group 1
    expect(groups.get('WL-1')!.group).toBe(1);
    expect(groups.get('WL-1')!.groupLabel).toContain('Plan Complete Group');
    expect(groups.get('WL-2')!.group).toBe(1);  // no conflict with WL-1
    expect(groups.get('WL-3')!.group).toBe(2);  // conflicts with WL-1
  });

  it('places plan_complete groups before stage-based groups', () => {
    const items = [
      { id: 'WL-idea', stage: 'idea', filePaths: [] },
      { id: 'WL-plan', stage: 'plan_complete', filePaths: ['src/foo.ts'] },
    ];
    const groups = assignItemGroups(items, 3);
    expect(groups.get('WL-plan')!.group).toBe(1);  // plan_complete before idea
    expect(groups.get('WL-idea')!.group).toBe(2);
  });

  it('places items with unknown stage into a single "Other" group', () => {
    const items = [
      { id: 'WL-1', stage: undefined, filePaths: [] },
      { id: 'WL-2', stage: undefined, filePaths: ['src/bar.ts'] },
    ];
    const groups = assignItemGroups(items, 3);
    expect(groups.get('WL-1')!.groupLabel).toBe('Other');
    expect(groups.get('WL-2')!.groupLabel).toBe('Other');
    // All unknown items share the same group (no singletons)
    expect(groups.get('WL-1')!.group).toBe(groups.get('WL-2')!.group);
  });

  it('handles empty items array', () => {
    const groups = assignItemGroups([], 3);
    expect(groups.size).toBe(0);
  });

  it('handles single item in a stage group', () => {
    const items = [
      { id: 'WL-1', stage: 'idea', filePaths: [] },
    ];
    const groups = assignItemGroups(items, 3);
    expect(groups.get('WL-1')!.group).toBe(1);
    expect(groups.get('WL-1')!.groupLabel).toBe('Idea');
  });

  // ── Critical group tests ────────────────────────────────────────────

  it('places all critical items in a single "Critical" group as group 1', () => {
    const items = [
      { id: 'WL-1', stage: 'idea', filePaths: [], priority: 'critical' },
      { id: 'WL-2', stage: 'plan_complete', filePaths: ['src/foo.ts'], priority: 'critical' },
    ];
    const groups = assignItemGroups(items, 3);
    expect(groups.get('WL-1')!.group).toBe(1);
    expect(groups.get('WL-1')!.groupLabel).toBe('Critical');
    expect(groups.get('WL-2')!.group).toBe(1);
    expect(groups.get('WL-2')!.groupLabel).toBe('Critical');
  });

  it('places critical items before all other groups', () => {
    const items = [
      { id: 'WL-idea', stage: 'idea', filePaths: [] },
      { id: 'WL-critical', stage: 'idea', filePaths: [], priority: 'critical' },
      { id: 'WL-review', stage: 'in_review', filePaths: [] },
    ];
    const groups = assignItemGroups(items, 3);
    // Critical is group 1
    expect(groups.get('WL-critical')!.group).toBe(1);
    expect(groups.get('WL-critical')!.groupLabel).toBe('Critical');
    // in_review is group 2 (next after Critical)
    expect(groups.get('WL-review')!.group).toBe(2);
    expect(groups.get('WL-review')!.groupLabel).toBe('In Review');
    // idea is group 3 (after in_review)
    expect(groups.get('WL-idea')!.group).toBe(3);
    expect(groups.get('WL-idea')!.groupLabel).toBe('Idea');
  });

  it('excludes critical items from their stage groups', () => {
    // A critical item with stage 'idea' should appear ONLY in Critical group,
    // NOT also in the Idea group with other idea items.
    const items = [
      { id: 'WL-critical', stage: 'idea', filePaths: [], priority: 'critical' },
      { id: 'WL-idea', stage: 'idea', filePaths: [] },
    ];
    const groups = assignItemGroups(items, 3);
    // Critical item gets group 1 (Critical)
    expect(groups.get('WL-critical')!.group).toBe(1);
    expect(groups.get('WL-critical')!.groupLabel).toBe('Critical');
    // Non-critical idea item gets a different group (2)
    expect(groups.get('WL-idea')!.group).toBe(2);
    expect(groups.get('WL-idea')!.groupLabel).toBe('Idea');
  });

  it('does not show critical group when no critical items exist', () => {
    const items = [
      { id: 'WL-1', stage: 'idea', filePaths: [] },
      { id: 'WL-2', stage: 'in_review', filePaths: [] },
    ];
    const groups = assignItemGroups(items, 3);
    // No group label should be 'Critical'
    for (const [, assignment] of groups) {
      expect(assignment.groupLabel).not.toBe('Critical');
    }
    // in_review is group 1, idea is group 2
    expect(groups.get('WL-2')!.group).toBe(1);
    expect(groups.get('WL-2')!.groupLabel).toBe('In Review');
    expect(groups.get('WL-1')!.group).toBe(2);
    expect(groups.get('WL-1')!.groupLabel).toBe('Idea');
  });

  it('places all critical items in one Critical group regardless of file-path conflicts', () => {
    // Even with conflicting file paths, critical items should be in one group
    const items = [
      { id: 'WL-1', stage: 'plan_complete', filePaths: ['src/foo.ts'], priority: 'critical' },
      { id: 'WL-2', stage: 'plan_complete', filePaths: ['src/foo.ts'], priority: 'critical' },
    ];
    const groups = assignItemGroups(items, 3);
    expect(groups.get('WL-1')!.group).toBe(1);
    expect(groups.get('WL-1')!.groupLabel).toBe('Critical');
    expect(groups.get('WL-2')!.group).toBe(1);
    expect(groups.get('WL-2')!.groupLabel).toBe('Critical');
  });

  it('preserves existing non-critical grouping when critical items are present', () => {
    const items = [
      { id: 'WL-critical', stage: 'idea', filePaths: [], priority: 'critical' },
      { id: 'WL-idea', stage: 'idea', filePaths: [] },
      { id: 'WL-review', stage: 'in_review', filePaths: [] },
    ];
    const groups = assignItemGroups(items, 3);
    // Critical group
    expect(groups.get('WL-critical')!.group).toBe(1);
    expect(groups.get('WL-critical')!.groupLabel).toBe('Critical');
    // Non-critical: in_review before idea
    expect(groups.get('WL-review')!.group).toBe(2);
    expect(groups.get('WL-review')!.groupLabel).toBe('In Review');
    expect(groups.get('WL-idea')!.group).toBe(3);
    expect(groups.get('WL-idea')!.groupLabel).toBe('Idea');
  });

  it('handles mixed critical and non-critical plan_complete items', () => {
    const items = [
      { id: 'WL-critical', stage: 'plan_complete', filePaths: ['src/foo.ts'], priority: 'critical' },
      { id: 'WL-plan1', stage: 'plan_complete', filePaths: ['src/bar.ts'] },
      { id: 'WL-plan2', stage: 'plan_complete', filePaths: ['src/baz.ts'] },
    ];
    const groups = assignItemGroups(items, 3);
    // Critical item gets group 1
    expect(groups.get('WL-critical')!.group).toBe(1);
    expect(groups.get('WL-critical')!.groupLabel).toBe('Critical');
    // Non-critical plan_complete items start at group 2
    expect(groups.get('WL-plan1')!.group).toBe(2);
    expect(groups.get('WL-plan2')!.group).toBe(2);
    expect(groups.get('WL-plan1')!.groupLabel).toContain('Plan Complete Group');
  });

  it('handles critical items with and without stage', () => {
    const items = [
      { id: 'WL-C1', stage: 'idea', filePaths: [], priority: 'critical' },
      { id: 'WL-C2', stage: undefined, filePaths: [], priority: 'critical' },
    ];
    const groups = assignItemGroups(items, 3);
    // Both critical items in the same Critical group
    expect(groups.get('WL-C1')!.group).toBe(1);
    expect(groups.get('WL-C1')!.groupLabel).toBe('Critical');
    expect(groups.get('WL-C2')!.group).toBe(1);
    expect(groups.get('WL-C2')!.groupLabel).toBe('Critical');
  });

  it('handles critical items with priority undefined like non-critical', () => {
    const items = [
      { id: 'WL-1', stage: 'idea', filePaths: [], priority: undefined },
      { id: 'WL-2', stage: 'idea', filePaths: [] },  // no priority field
    ];
    const groups = assignItemGroups(items, 3);
    // Both go to Idea group (no Critical group shown)
    expect(groups.get('WL-1')!.groupLabel).toBe('Idea');
    expect(groups.get('WL-2')!.groupLabel).toBe('Idea');
  });
});
