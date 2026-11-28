/**
 * Acceptance-criteria extraction from a work-item description.
 *
 * This is a faithful TypeScript port of the skills' reference implementation
 * `extract_acceptance_criteria` in `skill/shared/tree_coverage.py`. The
 * migration that back-fills the `acceptance_criteria` table (WL-0MWXJH4CC001V5G9)
 * and the skills that still read criteria from the description must agree on
 * exactly which lines are criteria, so the table and the prose cannot drift
 * while both representations exist during the transition.
 *
 * Marker rules (identical to the Python helper):
 *
 * - The section starts at any heading matching `#+ Acceptance Criteria`
 *   (case-insensitive) and ends at the next level-2 heading (`## …`) or the end
 *   of the description.
 * - Top-level markdown bullets (`- ` / `+ `) and ordered-list items (`1. ` /
 *   `1) `) start an AC; markers and numbers interleave in document order.
 * - A marker indented deeper than the first AC marker is nested detail under an
 *   AC item, not a criterion, and its text is never appended to the parent.
 * - A non-blank, unmarked, non-heading, non-table, non-fence line is a
 *   hard-wrapped continuation of the open AC and is joined to it.
 * - Fenced code blocks, markdown table rows, lone list markers and thematic
 *   breaks are ignored and close the open entry.
 * - `*` star bullets are **not** recognised as criteria markers.
 *
 * Work item: WL-0MWXJGRML004YI6O.
 */

const ORDERED_AC_RE = /^\d+[.)]\s+(.+)$/;
const CODE_FENCE_RE = /^(?:```|~~~)/;
const AC_BOUNDARY_RE = /^(?:[-+*]|\d+[.)])$|^(?:[-*_]\s*){3,}$/;
const AC_HEADER_RE = /^#+\s+Acceptance\s+Criteria/i;
const H2_HEADING_RE = /^##\s+/;
const ANY_HEADING_RE = /^#+\s/;

/**
 * Extract the ordered acceptance-criteria list from a work-item description.
 *
 * Returns an empty list when the description has no `## Acceptance Criteria`
 * section. Entries are returned in document order with their list markers
 * stripped and hard-wrapped continuations joined.
 */
export function extractAcceptanceCriteria(description: string): string[] {
  const lines = description.split('\n');
  const acs: string[] = [];
  let inAcSection = false;
  let inCodeFence = false;
  // Leading-whitespace depth of the first AC marker; any marker indented
  // deeper is nested detail under an AC item, not a top-level AC.
  let baseIndent: number | null = null;
  // Lines accumulated for the AC entry currently being built (its first line
  // plus any wrapped continuation lines).
  let pending: string[] = [];

  /** Close the pending AC entry, if any. */
  const flush = (): void => {
    if (pending.length === 0) return;
    acs.push(joinAcContinuations(pending));
    pending = [];
  };

  for (const line of lines) {
    const stripped = line.trim();
    // The AC section header starts (or restarts) the section.
    if (AC_HEADER_RE.test(stripped)) {
      flush();
      inAcSection = true;
      inCodeFence = false;
      continue;
    }
    if (!inAcSection) continue;
    // Fenced code blocks are not AC text (and end the open entry).
    if (CODE_FENCE_RE.test(stripped)) {
      flush();
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;
    // Exit the section at the next level-2 heading.
    if (H2_HEADING_RE.test(stripped)) break;
    if (!stripped) {
      // A blank line terminates the current AC entry.
      flush();
      continue;
    }
    if (stripped.startsWith('|')) {
      // Markdown table row: not AC text, and ends the open entry.
      flush();
      continue;
    }
    if (AC_BOUNDARY_RE.test(stripped)) {
      // A lone list marker or thematic break: ends the open entry and is
      // itself not AC text.
      flush();
      continue;
    }
    if (ANY_HEADING_RE.test(stripped)) {
      // A deeper heading inside the section ends the open entry.
      flush();
      continue;
    }
    const acText = stripAcListMarker(stripped);
    if (acText) {
      const indent = line.length - line.trimStart().length;
      if (baseIndent === null) baseIndent = indent;
      flush();
      if (indent > baseIndent) {
        // Deeper-indented marker: nested detail under an AC item. It is not
        // an AC and its text must not join the parent AC.
        continue;
      }
      pending.push(acText);
      continue;
    }
    // Unmarked continuation line: append it to the open AC entry.
    if (pending.length > 0) {
      pending.push(stripped);
    }
  }

  flush();
  return acs;
}

/**
 * Join an AC's first line with its wrapped continuation lines.
 *
 * Continuation lines are separated by a single space, except when the text
 * accumulated so far ends with a hyphen attached to the preceding word
 * (`high-` + `priority`), where the parts are rejoined without a space.
 * Multi-line entries have intra-entry whitespace collapsed to single spaces;
 * a single-line entry is returned unchanged so pre-existing behaviour is
 * preserved byte for byte.
 */
function joinAcContinuations(parts: string[]): string {
  if (parts.length === 1) return parts[0];
  let joined = parts[0];
  for (let i = 1; i < parts.length; i += 1) {
    const part = parts[i];
    if (
      joined.length > 1 &&
      joined.endsWith('-') &&
      !/\s/.test(joined[joined.length - 2])
    ) {
      joined += part;
    } else {
      joined += ' ' + part;
    }
  }
  return joined.replace(/\s+/g, ' ').trim();
}

/**
 * Strip a markdown bullet or ordered-list marker from an AC line.
 *
 * Returns the entry text with surrounding whitespace trimmed, or an empty
 * string when the line is not a bullet / ordered-list entry.
 */
function stripAcListMarker(stripped: string): string {
  if (stripped.startsWith('- ')) return stripped.slice(2).trim();
  if (stripped.startsWith('+ ')) return stripped.slice(2).trim();
  const match = ORDERED_AC_RE.exec(stripped);
  if (match) return match[1].trim();
  return '';
}
