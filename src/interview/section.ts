/**
 * src/interview/section.ts — locating and extracting the clarifying-questions
 * appendix from a work-item description.
 *
 * Responsibility: detect the appendix heading (in its known variants) and
 * return its body up to the next Markdown heading.
 *
 * Extracted verbatim from src/commands/interview.ts (WL-0MVXY36EA009TH9Q).
 */

/**
 * Matches the clarifying-questions appendix heading in its many variants:
 * `## Clarifying Questions & Answers`, `## Appendix: Clarifying questions`,
 * `# Appendix: Clarifying Questions`, etc.
 */
const SECTION_HEADER_RE =
  /^(#{1,6})\s+(?:Appendix:\s*)?Clarifying\s+Questions?(?:\s*(?:&|and)\s*Answers?)?\s*$/i;
const NEXT_SECTION_RE = /^#{1,6}\s+/;

/**
 * The clarifying-questions section of a work item description.
 */
export interface ClarifyingSection {
  header: string;
  content: string;
  start: number;
  end: number;
}

/**
 * Extract the clarifying-questions section from a work item description.
 * Returns `{ header, content, start, end }` where `content` is the body
 * after the header (up to the next Markdown heading), or `null` when no
 * recognised heading is present.
 */
export function extractClarifyingSection(
  description: string,
): ClarifyingSection | null {
  const lines = description.split('\n');
  let start = -1;

  for (let i = 0; i < lines.length; i++) {
    if (SECTION_HEADER_RE.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (NEXT_SECTION_RE.test(lines[i])) {
      end = i;
      break;
    }
  }

  const content = lines.slice(start + 1, end).join('\n');
  return { header: lines[start], content, start, end };
}
