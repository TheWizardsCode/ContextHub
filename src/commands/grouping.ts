/**
 * Grouping utility for `wl next --groups/-g`.
 *
 * Provides:
 * - File path extraction from work item descriptions (targeting a "Key Files:" section)
 * - Greedy first-fit grouping algorithm for partitioning items into parallel-safe groups
 *
 * The file-path convention targets a structured "**Key Files:**" section in the work item
 * description, where paths are listed as bullet points with or without backticks:
 *
 * ```
 * **Key Files:**
 * - `src/commands/next.ts`
 * - `packages/tui/extensions/lib/browse.ts`
 * ```
 */

// ── File path extraction ──────────────────────────────────────────────

/**
 * Extract file paths from a work item description.
 *
 * Looks for a "Key Files:" section (case-insensitive, with or without bold markers)
 * and extracts path-like strings from subsequent bullet list items.
 *
 * A path is considered valid if it:
 * - Contains at least one `/` (indicating a file in a directory)
 * - Ends with a file extension after a `.` (e.g., `.ts`, `.md`, `.json`)
 *
 * Items can be listed with or without backtick formatting.
 *
 * @param description - The work item description text
 * @returns Array of extracted file paths
 */
export function extractFilePaths(description: string): string[] {
  if (!description || description.trim().length === 0) {
    return [];
  }

  const paths: string[] = [];

  // Match the "Key Files:" header (case-insensitive, optional bold markers)
  // Capture everything after the header line until the next section header or end of string
  const keyFilesRegex = /^#{0,3}\s*\*{0,2}key files:\*{0,2}\s*$/im;
  const match = description.match(keyFilesRegex);

  if (!match) {
    return [];
  }

  const headerIndex = match.index!;
  const afterHeader = description.slice(headerIndex + match[0].length);

  // Split into lines and process each line until we hit another section header
  // or a bold section header (e.g., **Some Section:**)
  const lines = afterHeader.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();

    // Stop if we hit another Markdown heading
    if (/^#{1,3}\s/.test(trimmed)) {
      break;
    }

    // Stop if we hit another bold section header (e.g., **Some Section:**)
    if (/^\*{1,2}\w.*:\*{0,2}\s*$/.test(trimmed) && !/^[-*]\s/.test(trimmed)) {
      break;
    }

    // Stop if we hit another "Key Files:" header (case-insensitive)
    if (/\*{0,2}key files:\*{0,2}\s*$/i.test(trimmed) && !/^[-*]\s/.test(trimmed)) {
      break;
    }

    // Match bullet items: `- ` or `* ` prefix, optionally wrapping path in backticks
    // The path can be inside backticks or just plain text after the bullet marker
    const bulletMatch = trimmed.match(/^[-*]\s+`?([^`]+)`?\s*$/);
    if (!bulletMatch) continue;

    const pathCandidate = bulletMatch[1].trim();

    // Validate that it looks like a file path
    if (isFilePath(pathCandidate)) {
      paths.push(pathCandidate);
    }
  }

  return paths;
}

/**
 * Check if a string looks like a valid file path.
 *
 * A valid path contains at least one `/` and has a file extension.
 * Rejects URLs (http://, https://) and known non-path patterns.
 */
function isFilePath(candidate: string): boolean {
  // Reject URLs
  if (/^https?:\/\//i.test(candidate)) return false;
  if (!candidate.includes('/')) return false;
  // Must have a file extension (dot followed by alphanumeric chars at the end)
  const extMatch = candidate.match(/\.([a-zA-Z0-9]+)$/);
  if (!extMatch) return false;
  // Ensure the extension is at least 1 character
  return extMatch[1].length >= 1;
}

// ── Grouping algorithm ────────────────────────────────────────────────

/**
 * Input item for grouping — must have an `id` and a list of `filePaths`.
 */
export interface GroupableItem {
  id: string;
  filePaths: string[];
}

/**
 * Greedy first-fit grouping algorithm.
 *
 * Assigns each item to the first group (1-indexed) that contains no item
 * sharing any file path with it. If no existing group works, starts a new
 * group (up to `maxGroups`, then continues creating singleton groups).
 *
 * Items with empty file paths (unknown) are each placed in their own
 * singleton "conflict-unknown" group, because we cannot assess their
 * conflict with other items. These groups are marked as "restricted" —
 * no other item may join a restricted group.
 *
 * @param items - Array of items with id and extracted file paths
 * @param maxGroups - Maximum number of parallel-safe groups to form (default 3)
 * @returns Map of item id → group number (1-indexed)
 */
export function groupItemsByFilePaths(
  items: GroupableItem[],
  maxGroups: number = 3,
): Map<string, number> {
  const itemGroup = new Map<string, number>();

  // Track the set of file paths assigned to each group
  // groupPaths[groupNumber] = Set of file paths
  const groupPaths = new Map<number, Set<string>>();

  // Track which groups are "restricted" (contain unknown-path items)
  // Restricted groups cannot accept any other items.
  const restrictedGroups = new Set<number>();

  // Track the current group counter
  let nextGroup = 1;

  for (const item of items) {
    const { id, filePaths } = item;

    // Items with unknown file paths → singleton restricted group
    if (filePaths.length === 0) {
      itemGroup.set(id, nextGroup);
      groupPaths.set(nextGroup, new Set());
      restrictedGroups.add(nextGroup);
      nextGroup++;
      continue;
    }

    // Try to find an existing group this item fits in
    let assigned = false;
    // Only check within established groups (up to maxGroups)
    const groupsToCheck = Math.min(maxGroups, nextGroup - 1);
    for (let g = 1; g <= groupsToCheck; g++) {
      const existingPaths = groupPaths.get(g);
      if (!existingPaths) continue;

      // Skip restricted groups (unknown-path singletons)
      if (restrictedGroups.has(g)) continue;

      // Check if any of this item's paths conflict with the group's paths
      const hasConflict = filePaths.some(fp => existingPaths.has(fp));
      if (!hasConflict) {
        // No conflict — assign to this group
        for (const fp of filePaths) {
          existingPaths.add(fp);
        }
        itemGroup.set(id, g);
        assigned = true;
        break;
      }
    }

    if (!assigned) {
      // Start a new group
      const newGroup = nextGroup;
      groupPaths.set(newGroup, new Set(filePaths));
      itemGroup.set(id, newGroup);
      nextGroup++;
    }
  }

  return itemGroup;
}
