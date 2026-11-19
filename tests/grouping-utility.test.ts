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
import {
  groupItemsByFilePaths,
  assignItemGroups,
  compareGroupableItems,
  compareGroupingContentKey,
} from '../src/commands/grouping.js';

/** Every ordering of `items` (all permutations) — used by the stability tests. */
function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const result: T[][] = [];
  items.forEach((item, index) => {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) result.push([item, ...tail]);
  });
  return result;
}

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

// ── Grouping stability (WL-0MVVLBTTP003Y4XO) ──────────────────────────

/**
 * A set whose greedy first-fit packing genuinely depends on the input order
 * when it is *not* canonicalised: with A→x, B→x+y, C→y, feeding A,B,C puts A
 * and C together in group 1, while feeding B,A,C puts A and C together in
 * group 2. Canonicalisation must erase that difference.
 */
const conflictingSet = [
  { id: 'WL-A', stage: 'plan_complete', filePaths: ['src/x.ts'], priority: 'medium' },
  { id: 'WL-B', stage: 'plan_complete', filePaths: ['src/x.ts', 'src/y.ts'], priority: 'medium' },
  { id: 'WL-C', stage: 'plan_complete', filePaths: ['src/y.ts'], priority: 'medium' },
];

describe('grouping stability — content-deterministic grouping', () => {
  it('packs the same item set into the same groups for every input order', () => {
    const reference = groupItemsByFilePaths(conflictingSet, 3);
    expect(reference.get('WL-A')).toBe(1);
    expect(reference.get('WL-B')).toBe(2);
    expect(reference.get('WL-C')).toBe(1);
    for (const permuted of permutations(conflictingSet)) {
      expect(groupItemsByFilePaths(permuted, 3)).toEqual(reference);
    }
  });

  it('assignItemGroups assigns identical groups and labels for every input order', () => {
    const items = [
      ...conflictingSet,
      { id: 'WL-D', stage: 'intake_complete', filePaths: [], priority: 'high' },
      { id: 'WL-E', stage: 'idea', filePaths: ['src/z.ts'], priority: 'low' },
      { id: 'WL-F', stage: 'plan_complete', filePaths: ['src/x.ts'], priority: 'critical' },
      { id: 'WL-G', stage: 'in_review', filePaths: [], priority: 'medium' },
    ];
    const reference = assignItemGroups(items, 3);
    for (const permuted of permutations(items)) {
      const got = assignItemGroups(permuted, 3);
      expect(got.size).toBe(reference.size);
      for (const [id, assignment] of reference) {
        expect(got.get(id)).toEqual(assignment);
      }
    }
  });

  it('never changes group membership when only updatedAt changes (comment/audit churn)', () => {
    const reference = assignItemGroups(conflictingSet, 3);
    const churned = conflictingSet.map((item, index) => ({
      ...item,
      // A stationary item can gain a comment or an audit result at any time.
      updatedAt: `2026-01-0${index + 1}T00:00:00.000Z`,
      auditedAt: index % 2 === 0 ? `2026-01-0${index + 1}T00:00:00.000Z` : null,
      auditResult: index % 2 === 0,
    }));
    expect(assignItemGroups(churned, 3)).toEqual(reference);
  });

  it.fails('moves an item between groups only when a material input changes (key files)', () => {
    const before = [
      { id: 'WL-A', stage: 'plan_complete', filePaths: ['src/x.ts'], priority: 'medium' },
      { id: 'WL-B', stage: 'plan_complete', filePaths: ['src/y.ts'], priority: 'medium' },
    ];
    expect(assignItemGroups(before, 3).get('WL-B')!.groupLabel).toBe('Medium Group 1');
    const after = before.map(item =>
      item.id === 'WL-B' ? { ...item, filePaths: ['src/x.ts'] } : item,
    );
    expect(assignItemGroups(after, 3).get('WL-B')!.groupLabel).toBe('Medium Group 2');
  });

  it.fails('moves an item into the Critical band when its priority becomes critical (material change)', () => {
    const before = [{ id: 'WL-A', stage: 'plan_complete', filePaths: ['src/x.ts'], priority: 'high' }];
    expect(assignItemGroups(before, 3).get('WL-A')!.groupLabel).toBe('High Group 1');
    const after = before.map(item => ({ ...item, priority: 'critical' }));
    expect(assignItemGroups(after, 3).get('WL-A')!.groupLabel).toBe('Critical Group 1');
  });

  it('compareGroupingContentKey is a pure function of priority, stage sub-order and id', () => {
    const base = {
      id: 'WL-A',
      stage: 'plan_complete',
      filePaths: [] as string[],
      priority: 'high',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    // Same content, different timestamps → equal keys (timestamps are not an input).
    expect(compareGroupingContentKey(base, { ...base, updatedAt: '2030-01-01T00:00:00.000Z' })).toBe(0);
    // Priority dominates stage.
    expect(
      compareGroupingContentKey(
        { ...base, id: 'WL-Z', priority: 'high', stage: 'intake_complete' },
        { ...base, id: 'WL-A', priority: 'medium', stage: 'plan_complete' },
      ),
    ).toBeLessThan(0);
    // Stage sub-order breaks a same-priority tie.
    expect(
      compareGroupingContentKey(
        { ...base, id: 'WL-Z', stage: 'plan_complete' },
        { ...base, id: 'WL-A', stage: 'intake_complete' },
      ),
    ).toBeLessThan(0);
    // Id breaks a full tie.
    expect(compareGroupingContentKey({ ...base, id: 'WL-A' }, { ...base, id: 'WL-B' })).toBeLessThan(0);
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
  // Red witness — priority-band section ordering (WL-0MWMQ6AV6007ZUNK): the
  // core copy used by `wl next --groups` must mirror herdr band-first order.
  it.fails('produces the band-first group order: Critical → High → Medium → Low → In Review', () => {
    const items = [
      { id: 'WL-C1', stage: 'plan_complete', filePaths: ['src/c.ts'], priority: 'critical' },
      { id: 'WL-P1', stage: 'plan_complete', filePaths: ['src/p1.ts'], priority: 'high' },
      { id: 'WL-I1', stage: 'intake_complete', filePaths: ['src/i1.ts'], priority: 'medium' },
      { id: 'WL-IP1', status: 'in-progress', stage: 'plan_complete', filePaths: ['src/ip1.ts'], priority: 'high' },
      { id: 'WL-idea', stage: 'idea', filePaths: [], priority: 'low' },
      { id: 'WL-other', stage: undefined, filePaths: [], priority: 'medium' },
      { id: 'WL-R1', stage: 'in_review', filePaths: [], priority: 'medium' },
    ];
    const groups = assignItemGroups(items, 3);
    const groupOf = (id: string): number => groups.get(id)!.group;
    // Critical band comes first.
    expect(groups.get('WL-C1')!.groupLabel).toBe('Critical Group 1');
    // Plan/intake/actively-worked items join their band's Group N (band-prefixed).
    expect(groups.get('WL-P1')!.groupLabel).toBe('High Group 1');
    expect(groups.get('WL-I1')!.groupLabel).toBe('Medium Group 1');
    expect(groups.get('WL-IP1')!.groupLabel).toBe('High Group 1');
    expect(groups.get('WL-other')!.groupLabel).toBe('Medium Other');
    expect(groupOf('WL-C1'), 'critical band precedes the high band').toBeLessThan(groupOf('WL-P1'));
    expect(groupOf('WL-P1'), 'high band precedes the medium band').toBeLessThan(groupOf('WL-I1'));
    expect(groupOf('WL-I1'), 'medium band precedes the low band').toBeLessThan(groupOf('WL-idea'));
    expect(groupOf('WL-other'), 'the medium band precedes the low band').toBeLessThan(groupOf('WL-idea'));
    expect(groupOf('WL-idea'), 'low band precedes the pinned In Review section').toBeLessThan(groupOf('WL-R1'));
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

  it.fails('excludes critical items from their band stage groups (Idea/Other/In Review)', () => {
    const items = [
      { id: 'WL-C1', stage: 'idea', filePaths: [], priority: 'critical' },
      { id: 'WL-idea', stage: 'idea', filePaths: [], priority: 'medium' },
      { id: 'WL-other', stage: 'custom', filePaths: [], priority: 'medium' },
    ];
    const groups = assignItemGroups(items, 3);
    expect(groups.get('WL-C1')!.groupLabel).toBe('Critical Group 1');
    // Non-critical idea/other items land in later band groups (not the critical one).
    expect(groups.get('WL-idea')!.groupLabel).toBe('Medium Idea');
    expect(groups.get('WL-idea')!.group).toBeGreaterThan(groups.get('WL-C1')!.group);
    expect(groups.get('WL-other')!.groupLabel).toBe('Medium Other');
    expect(groups.get('WL-other')!.group).toBeGreaterThan(groups.get('WL-idea')!.group);
  });
});

describe('assignItemGroups — Group N (in_progress + plan_complete + intake_complete)', () => {
  it.fails('partitions plan_complete and intake_complete items into per-band <Band> Group N labels', () => {
    const items = [
      { id: 'WL-P1', stage: 'plan_complete', filePaths: ['src/a.ts'], priority: 'high' },
      { id: 'WL-I1', stage: 'intake_complete', filePaths: ['src/b.ts'], priority: 'medium' },
      { id: 'WL-P2', stage: 'plan_complete', filePaths: ['src/a.ts'], priority: 'high' },
    ];
    const groups = assignItemGroups(items, 3);
    expect(groups.get('WL-P1')!.groupLabel).toBe('High Group 1');
    expect(groups.get('WL-I1')!.groupLabel).toBe('Medium Group 1');
    expect(groups.get('WL-P2')!.groupLabel).toBe('High Group 2');
  });

  it.fails('includes in-progress items in their band Group N alongside plan_complete/intake_complete', () => {
    const items = [
      { id: 'WL-P1', stage: 'plan_complete', filePaths: ['src/a.ts'], priority: 'high' },
      { id: 'WL-IP1', status: 'in-progress', stage: 'plan_complete', filePaths: ['src/b.ts'], priority: 'high' },
      { id: 'WL-I1', stage: 'intake_complete', filePaths: ['src/c.ts'], priority: 'medium' },
      // Shares a Key File with WL-P1, but P1 is in the high band and this item
      // is in the medium band, so the conflict is evaluated per band.
      { id: 'WL-IP2', status: 'in-progress', stage: 'plan_complete', filePaths: ['src/a.ts'], priority: 'medium' },
    ];
    const groups = assignItemGroups(items, 3);
    expect(groups.get('WL-P1')!.groupLabel).toBe('High Group 1');
    expect(groups.get('WL-IP1')!.groupLabel).toBe('High Group 1');
    expect(groups.get('WL-I1')!.groupLabel).toBe('Medium Group 1');
    expect(groups.get('WL-IP2')!.groupLabel).toBe('Medium Group 1');
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
  it.fails('places all idea items of a band in a single "<Band> Idea" group', () => {
    const items = [
      { id: 'WL-1', stage: 'idea', filePaths: [] },
      { id: 'WL-2', stage: 'idea', filePaths: ['src/foo.ts'] },
    ];
    const groups = assignItemGroups(items, 3);
    expect(groups.get('WL-1')!.group).toBe(1);
    expect(groups.get('WL-1')!.groupLabel).toBe('Medium Idea');
    expect(groups.get('WL-2')!.group).toBe(1);
    expect(groups.get('WL-2')!.groupLabel).toBe('Medium Idea');
  });

  it.fails('places all remaining items of a band in a single "<Band> Other" group', () => {
    // `done` and unknown/custom stages fall back to a band-prefixed Other group.
    const items = [
      { id: 'WL-1', stage: 'done', filePaths: [] },
      { id: 'WL-2', stage: undefined, filePaths: ['src/bar.ts'] },
    ];
    const groups = assignItemGroups(items, 3);
    expect(groups.get('WL-1')!.groupLabel).toBe('Medium Other');
    expect(groups.get('WL-2')!.groupLabel).toBe('Medium Other');
    expect(groups.get('WL-1')!.group).toBe(groups.get('WL-2')!.group);
  });

  it.fails('never places canonical stages in a band "Other" group (in-progress joins a band Group N)', () => {
    const items = [
      { id: 'WL-idea', stage: 'idea', filePaths: ['src/idea.ts'], priority: 'medium' },
      { id: 'WL-intake', stage: 'intake_complete', filePaths: ['src/intake.ts'], priority: 'medium' },
      { id: 'WL-plan', stage: 'plan_complete', filePaths: ['src/plan.ts'], priority: 'medium' },
      { id: 'WL-progress', status: 'in-progress', stage: 'plan_complete', filePaths: ['src/progress.ts'], priority: 'medium' },
      { id: 'WL-review', stage: 'in_review', filePaths: ['src/review.ts'], priority: 'medium' },
    ];
    const groups = assignItemGroups(items, 3);
    for (const [, assignment] of groups) {
      expect(assignment.groupLabel).not.toBe('Other');
    }
    // Unknown/custom stages and `done` (when explicitly included) still fall
    // back to a band-prefixed Other group as the safety net.
    const unknown = assignItemGroups([{ id: 'WL-x', stage: 'custom', filePaths: [], priority: 'medium' }], 3);
    expect(unknown.get('WL-x')!.groupLabel).toBe('Medium Other');
    const noStage = assignItemGroups([{ id: 'WL-y', stage: undefined, filePaths: [], priority: 'medium' }], 3);
    expect(noStage.get('WL-y')!.groupLabel).toBe('Medium Other');
    const done = assignItemGroups([{ id: 'WL-done', stage: 'done', filePaths: [], priority: 'medium' }], 3);
    expect(done.get('WL-done')!.groupLabel).toBe('Medium Other');
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

  it.fails('handles a single item', () => {
    const groups = assignItemGroups([{ id: 'WL-1', stage: 'idea', filePaths: [] }], 3);
    expect(groups.get('WL-1')!.groupLabel).toBe('Medium Idea');
  });
});

// ── compareGroupableItems — within-group ordering ─────────────────────

describe('compareGroupableItems — within-group ordering', () => {
  it('orders plan_complete before intake_complete before remaining stages (WL-0MTQZ7HZY: in_progress is now remaining)', () => {
    const progress = { id: 'IP', stage: 'in_progress', filePaths: [], priority: 'medium' };
    const plan = { id: 'P', stage: 'plan_complete', filePaths: [], priority: 'medium' };
    const intake = { id: 'I', stage: 'intake_complete', filePaths: [], priority: 'medium' };
    const other = { id: 'O', stage: 'done', filePaths: [], priority: 'medium' };
    expect(compareGroupableItems(plan, intake)).toBeLessThan(0);
    expect(compareGroupableItems(intake, other)).toBeLessThan(0);
    expect(compareGroupableItems(plan, other)).toBeLessThan(0);
    // in_progress is now Remaining (same bucket as done), ordered by id tie-break after stage/priority
    expect(compareGroupableItems(plan, progress)).toBeLessThan(0);
    expect(compareGroupableItems(intake, progress)).toBeLessThan(0);
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

  it('sorts a mixed plan+intake group by priority first, then stage sub-order (WL-0MVVLBTTP003Y4XO)', () => {
    const items = [
      { id: 'I-low', stage: 'intake_complete', filePaths: [], priority: 'low' },
      { id: 'P-med', stage: 'plan_complete', filePaths: [], priority: 'medium' },
      { id: 'I-high', stage: 'intake_complete', filePaths: [], priority: 'high' },
      { id: 'P-high', stage: 'plan_complete', filePaths: [], priority: 'high' },
    ];
    const sorted = items.slice().sort(compareGroupableItems);
    // Priority is the primary key, so all high items precede all medium items,
    // which precede all low items; the stage sub-order decides ties.
    expect(sorted.map(i => i.id)).toEqual(['P-high', 'I-high', 'P-med', 'I-low']);
  });

  it('sorts plan_complete first, then intake_complete, then remaining — within one priority band (WL-0MTQZ7HZY)', () => {
    const items = [
      { id: 'I-low', stage: 'intake_complete', filePaths: [], priority: 'high' },
      { id: 'P-med', stage: 'plan_complete', filePaths: [], priority: 'high' },
      { id: 'IP-high', stage: 'in_progress', filePaths: [], priority: 'high' },
      { id: 'IP-low', stage: 'in_progress', filePaths: [], priority: 'high' },
      { id: 'P-high', stage: 'plan_complete', filePaths: [], priority: 'high' },
    ];
    const sorted = items.slice().sort(compareGroupableItems);
    // WL-0MTQZ7HZY: in_progress is Remaining (order 3), so plan_complete (0) < intake_complete (1) < remaining (3)
    expect(sorted.map(i => i.id)).toEqual(['P-high', 'P-med', 'I-low', 'IP-high', 'IP-low']);
  });

  it('ranks every high-priority item ahead of every medium item, and medium ahead of low (WL-0MVVLBTTP003Y4XO)', () => {
    const items = [
      { id: 'P-high', stage: 'plan_complete', filePaths: [], priority: 'high' },
      { id: 'I-high', stage: 'intake_complete', filePaths: [], priority: 'high' },
      { id: 'D-high', stage: 'done', filePaths: [], priority: 'high' },
      { id: 'P-med', stage: 'plan_complete', filePaths: [], priority: 'medium' },
      { id: 'I-med', stage: 'intake_complete', filePaths: [], priority: 'medium' },
      { id: 'P-low', stage: 'plan_complete', filePaths: [], priority: 'low' },
    ];
    const sorted = items.slice().sort(compareGroupableItems);
    expect(sorted.map(i => i.id)).toEqual(['P-high', 'I-high', 'D-high', 'P-med', 'I-med', 'P-low']);
  });

  it('sorts a critical group with the same stage sub-sort (WL-0MTQZ7HZY: in_progress is remaining)', () => {
    const items = [
      { id: 'C-other', stage: 'in_progress', filePaths: [], priority: 'critical' },
      { id: 'C-intake', stage: 'intake_complete', filePaths: [], priority: 'critical' },
      { id: 'C-plan', stage: 'plan_complete', filePaths: [], priority: 'critical' },
    ];
    const sorted = items.slice().sort(compareGroupableItems);
    // WL-0MTQZ7HZY: in_progress is Remaining
    expect(sorted.map(i => i.id)).toEqual(['C-plan', 'C-intake', 'C-other']);
  });
});

// ── in_review 6-bucket sort (WL-0MSLPM5ZB003TADT) ──────────────────────

import { inReviewBucket, compareInReviewItems } from '../src/commands/grouping.js';

describe('in_review 6-bucket sort (WL-0MSLPM5ZB003TADT)', () => {
  // isAuditFresh(auditedAt, updatedAt): auditedAt within
  // AUDIT_FRESHNESS_AT_NEAR_TOLERANCE_MS of updatedAt → fresh
  // So auditedAt === updatedAt is fresh; auditedAt 10m before updatedAt is stale.
  const updatedAt = '2026-01-10T10:00:00.000Z';
  const freshAuditedAt = '2026-01-10T10:00:00.000Z'; // same instant → fresh
  const staleAuditedAt = '2026-01-10T09:40:00.000Z'; // 20m earlier → stale

  function inReviewItem(overrides: Record<string, unknown> = {}) {
    return { id: 'WL-x', stage: 'in_review', filePaths: [], priority: 'medium', ...overrides };
  }

  it('inReviewBucket returns all six buckets with needsProducerReview first (F3 restored core grouping)', () => {
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

  it('orders the six buckets: needsProducerReview → failed fresh → failed stale → no audit → passed stale → passed fresh (F3 restored core grouping)', () => {
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

  it('does not apply bucket sort to non-in_review items even when flagged (restored contract WL-0MVAMS4RO000H3B0 F1)', () => {
    const a = { id: 'WL-a', stage: 'plan_complete', filePaths: [], priority: 'medium', needsProducerReview: true };
    const b = { id: 'WL-b', stage: 'plan_complete', filePaths: [], priority: 'medium' };
    expect(compareGroupableItems(a, b)).toBeLessThan(0); // WL-a < WL-b lexicographically
  });

  it('compareInReviewItems returns 0 for non-in_review items even when flagged (restored contract WL-0MVAMS4RO000H3B0 F1)', () => {
    const a = { id: 'WL-a', stage: 'plan_complete', filePaths: [], priority: 'medium', needsProducerReview: true } as any;
    const b = { id: 'WL-b', stage: 'intake_complete', filePaths: [], priority: 'medium' } as any;
    expect(compareInReviewItems(a, b)).toBe(0);
  });

  it('priority is the primary key, so a high no-audit item leads a medium failed-audit item (WL-0MUWDW0N6003KF6G)', () => {
    // Producer-reported symptom: the audit bucket used to be the primary key,
    // so a medium item with a failed (stale) audit (bucket 3) ranked ahead of
    // a high item with no audit (bucket 4). Priority must dominate; the bucket
    // then orders items within the same priority band.
    const items = [
      inReviewItem({ id: 'WL-medium-no-audit', priority: 'medium', auditResult: null, auditedAt: null, updatedAt }),
      inReviewItem({ id: 'WL-medium-failed', priority: 'medium', auditResult: false, auditedAt: staleAuditedAt, updatedAt }),
      inReviewItem({ id: 'WL-high-no-audit', priority: 'high', auditResult: null, auditedAt: null, updatedAt }),
      inReviewItem({ id: 'WL-low-no-audit', priority: 'low', auditResult: null, auditedAt: null, updatedAt }),
    ];
    const sorted = items.slice().sort(compareGroupableItems);
    expect(sorted.map(i => (i as { id: string }).id)).toEqual([
      'WL-high-no-audit',
      'WL-medium-failed',
      'WL-medium-no-audit',
      'WL-low-no-audit',
    ]);
  });

  it('applies the 6-bucket order within each priority band (WL-0MUWDW0N6003KF6G)', () => {
    const items = [
      inReviewItem({ id: 'WL-high-passed', priority: 'high', auditResult: true, auditedAt: freshAuditedAt, updatedAt }),
      inReviewItem({ id: 'WL-high-no-audit', priority: 'high', auditResult: null, auditedAt: null, updatedAt }),
      inReviewItem({ id: 'WL-medium-no-audit', priority: 'medium', auditResult: null, auditedAt: null, updatedAt }),
      inReviewItem({ id: 'WL-medium-failed', priority: 'medium', auditResult: false, auditedAt: staleAuditedAt, updatedAt }),
    ];
    const sorted = items.slice().sort(compareGroupableItems);
    expect(sorted.map(i => (i as { id: string }).id)).toEqual([
      'WL-high-no-audit',
      'WL-high-passed',
      'WL-medium-failed',
      'WL-medium-no-audit',
    ]);
  });
});

// ── Priority-band section ordering (WL-0MWMQ6AV6007ZUNK) ──────────────
//
// RED WITNESS (test-first child WL-0MWMRFX27007NC0G). This block specifies the
// CORE mirror used by `wl next --groups` so the two hand-synchronised copies
// are pinned to the same band-first contract: critical → high → medium → low →
// In Review, with stage used only as the intra-band sub-order and file-path
// conflict grouping applied per band.
//
// Every `it.fails` block throws against today's sources (its assertions encode
// the new contract); the suite stays green while the specification is red — the
// repo's documented red-witness pattern. The core mirror implementation child
// (WL-0MWMRG3HL007PDZ6) flips each `it.fails` to `it`.
describe('assignItemGroups — priority-band first ordering (WL-0MWMQ6AV6007ZUNK)', () => {
  it.fails('regroups a high@idea item below every medium@plan_complete item (the inversion)', () => {
    const items = [
      { id: 'WL-idea-high', stage: 'idea', filePaths: [], priority: 'high' },
      { id: 'WL-plan-med-1', stage: 'plan_complete', filePaths: ['src/a.ts'], priority: 'medium' },
      { id: 'WL-plan-med-2', stage: 'plan_complete', filePaths: ['src/b.ts'], priority: 'medium' },
    ];
    const groups = assignItemGroups(items, 3);
    const highGroup = groups.get('WL-idea-high')!.group;
    expect(
      highGroup,
      'high@idea must group ABOVE medium@plan_complete — priority band must beat the stage bucket',
    ).toBeLessThan(groups.get('WL-plan-med-1')!.group);
    expect(
      highGroup,
      'high@idea must group above EVERY medium@plan_complete item',
    ).toBeLessThan(groups.get('WL-plan-med-2')!.group);
  });

  it.fails('orders every high item before every medium item before every low item, regardless of stage', () => {
    const items = [
      { id: 'WL-low-plan', stage: 'plan_complete', filePaths: ['src/l.ts'], priority: 'low' },
      { id: 'WL-med-intake', stage: 'intake_complete', filePaths: ['src/m.ts'], priority: 'medium' },
      { id: 'WL-high-idea', stage: 'idea', filePaths: [], priority: 'high' },
    ];
    const groups = assignItemGroups(items, 3);
    expect(groups.get('WL-high-idea')!.group, 'the high band must precede the medium band').toBeLessThan(
      groups.get('WL-med-intake')!.group,
    );
    expect(groups.get('WL-med-intake')!.group, 'the medium band must precede the low band').toBeLessThan(
      groups.get('WL-low-plan')!.group,
    );
  });

  it.fails('labels sections with the band scheme: <Band> Group N, <Band> Idea, <Band> Other', () => {
    const items = [
      { id: 'WL-C', stage: 'plan_complete', filePaths: ['src/c.ts'], priority: 'critical' },
      { id: 'WL-H', stage: 'plan_complete', filePaths: ['src/h.ts'], priority: 'high' },
      { id: 'WL-M', stage: 'plan_complete', filePaths: ['src/m.ts'], priority: 'medium' },
      { id: 'WL-L', stage: 'plan_complete', filePaths: ['src/l.ts'], priority: 'low' },
      { id: 'WL-H-idea', stage: 'idea', filePaths: [], priority: 'high' },
      { id: 'WL-L-other', stage: 'custom', filePaths: [], priority: 'low' },
    ];
    const groups = assignItemGroups(items, 3);
    expect(groups.get('WL-C')!.groupLabel).toBe('Critical Group 1');
    expect(groups.get('WL-H')!.groupLabel).toBe('High Group 1');
    expect(groups.get('WL-M')!.groupLabel).toBe('Medium Group 1');
    expect(groups.get('WL-L')!.groupLabel).toBe('Low Group 1');
    expect(groups.get('WL-H-idea')!.groupLabel).toBe('High Idea');
    expect(groups.get('WL-L-other')!.groupLabel).toBe('Low Other');
  });

  it.fails('applies file-path conflict grouping per band: a same-band Key-File share never shares a group', () => {
    const groups = assignItemGroups([
      { id: 'WL-h1', stage: 'plan_complete', filePaths: ['src/shared.ts'], priority: 'high' },
      { id: 'WL-h2', stage: 'plan_complete', filePaths: ['src/shared.ts'], priority: 'high' },
      { id: 'WL-m1', stage: 'plan_complete', filePaths: ['src/shared.ts'], priority: 'medium' },
    ], 3);
    expect(groups.get('WL-h1')!.groupLabel, 'the high band label counter starts at 1').toBe('High Group 1');
    expect(groups.get('WL-h2')!.groupLabel, 'same-band Key-File share must split groups').toBe('High Group 2');
    expect(groups.get('WL-m1')!.groupLabel, 'a different band restarts its own label counter').toBe('Medium Group 1');
  });

  it.fails('orders intra-band stage sub-sections: in-progress → plan_complete → intake_complete → idea → other', () => {
    // Ids deliberately sort against the expected stage order so a pure id
    // tie-break cannot accidentally satisfy the test.
    const items = [
      { id: 'a-other', stage: 'custom', filePaths: [], priority: 'high' },
      { id: 'z-idea', stage: 'idea', filePaths: [], priority: 'high' },
      { id: 'c-intake', stage: 'intake_complete', filePaths: [], priority: 'high' },
      { id: 'b-plan', stage: 'plan_complete', filePaths: [], priority: 'high' },
      { id: 'a-active', status: 'in-progress', stage: 'plan_complete', filePaths: [], priority: 'high' },
    ];
    const sorted = items.slice().sort(compareGroupableItems);
    expect(sorted.map(i => i.id), 'intra-band stage sub-order must be in-progress → plan → intake → idea → other').toEqual([
      'a-active',
      'b-plan',
      'c-intake',
      'z-idea',
      'a-other',
    ]);
  });

  // Unchanged by this work — kept green as a regression guard: the review
  // queue stays a single global section pinned last, whatever its members'
  // priorities (it never becomes a priority band of its own).
  it('pins In Review as the final single section regardless of member priority', () => {
    const groups = assignItemGroups([
      { id: 'WL-r-high', stage: 'in_review', filePaths: [], priority: 'high' },
      { id: 'WL-r-low', stage: 'in_review', filePaths: [], priority: 'low' },
      { id: 'WL-plan-high', stage: 'plan_complete', filePaths: ['src/p.ts'], priority: 'high' },
    ], 3);
    expect(groups.get('WL-r-high')!.groupLabel).toBe('In Review');
    expect(groups.get('WL-r-low')!.groupLabel).toBe('In Review');
    expect(groups.get('WL-r-high')!.group).toBe(groups.get('WL-r-low')!.group);
    expect(groups.get('WL-plan-high')!.group, 'In Review renders after every priority band').toBeLessThan(
      groups.get('WL-r-high')!.group,
    );
  });
});
