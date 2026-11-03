/**
 * src/github/markers.ts — worklog markers embedded in GitHub issue bodies.
 *
 * Concern: the `<!-- worklog:id=… -->` / `<!-- worklog:comment=… -->` marker
 * format and the pure string parsers that read worklog metadata back out of an
 * issue or comment body — the worklog and comment id markers, the
 * `Parent:`/`Children:`/`Pending children:`/`Sub-issues:` sections and the
 * `Children:` bullet lists.
 *
 * Pure string functions only: this module imports nothing from any other github
 * module (not even the barrel), so every sibling can depend on it freely
 * without introducing a cycle.
 *
 * Moved verbatim from `src/github.ts` (WL-0MVVLXXGC0026427, child 3 of 8 of the
 * WL-0MVGKGR2H006MNVG `src/github.ts` decomposition). Move-only: no
 * marker-format, regex or return-shape change.
 */

const WORKLOG_MARKER_PREFIX = '<!-- worklog:id=';
const WORKLOG_MARKER_SUFFIX = ' -->';
const WORKLOG_COMMENT_MARKER_PREFIX = '<!-- worklog:comment=';
const WORKLOG_COMMENT_MARKER_SUFFIX = ' -->';

export function buildWorklogMarker(workItemId: string): string {
  return `${WORKLOG_MARKER_PREFIX}${workItemId}${WORKLOG_MARKER_SUFFIX}`;
}

export function buildWorklogCommentMarker(commentId: string): string {
  return `${WORKLOG_COMMENT_MARKER_PREFIX}${commentId}${WORKLOG_COMMENT_MARKER_SUFFIX}`;
}

export function stripWorklogMarkers(body?: string | null): string {
  if (!body) {
    return '';
  }
  const lines = body.split('\n');
  const filtered = lines.filter(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith(WORKLOG_MARKER_PREFIX)) {
      return false;
    }
    if (trimmed.startsWith(WORKLOG_COMMENT_MARKER_PREFIX)) {
      return false;
    }
    return true;
  });
  return filtered.join('\n').trim();
}

export function extractWorklogId(body?: string | null): string | null {
  if (!body) return null;
  const start = body.indexOf(WORKLOG_MARKER_PREFIX);
  if (start === -1) return null;
  const end = body.indexOf(WORKLOG_MARKER_SUFFIX, start + WORKLOG_MARKER_PREFIX.length);
  if (end === -1) return null;
  const id = body.slice(start + WORKLOG_MARKER_PREFIX.length, end).trim();
  return id || null;
}

export function extractWorklogCommentId(body?: string | null): string | null {
  if (!body) return null;
  const start = body.indexOf(WORKLOG_COMMENT_MARKER_PREFIX);
  if (start === -1) return null;
  const end = body.indexOf(WORKLOG_COMMENT_MARKER_SUFFIX, start + WORKLOG_COMMENT_MARKER_PREFIX.length);
  if (end === -1) return null;
  const id = body.slice(start + WORKLOG_COMMENT_MARKER_PREFIX.length, end).trim();
  return id || null;
}

export function extractParentId(body?: string | null): string | null {
  if (!body) return null;
  const lines = body.split('\n');
  for (const line of lines) {
    if (!line.startsWith('Parent:')) {
      continue;
    }
    const match = line.match(/^Parent:\s*([^\s-]+(?:-[^\s-]+)*)/);
    if (match && match[1]) {
      return match[1];
    }
    return null;
  }
  return null;
}

export function extractParentIssueNumber(body?: string | null): number | null {
  if (!body) return null;
  const lines = body.split('\n');
  for (const line of lines) {
    if (!line.startsWith('Parent:')) {
      continue;
    }
    const match = line.match(/#(\d+)/);
    if (match && match[1]) {
      return Number(match[1]);
    }
    return null;
  }
  return null;
}

export function extractChildIds(body?: string | null): string[] {
  if (!body) return [];
  const lines = body.split('\n');
  const childIds: string[] = [];
  let inChildren = false;
  for (const line of lines) {
    if (line.trim() === '') {
      if (inChildren) {
        break;
      }
      continue;
    }
    if (line.startsWith('Children:') || line.startsWith('Pending children:')) {
      inChildren = true;
      continue;
    }
    if (!inChildren) {
      continue;
    }
    if (!line.startsWith('- ')) {
      break;
    }
    const match = line.match(/^-\s*([^\s-]+(?:-[^\s-]+)*)/);
    if (match && match[1]) {
      childIds.push(match[1]);
    }
  }
  return childIds;
}

export function extractChildIssueNumbers(body?: string | null): number[] {
  if (!body) return [];
  const lines = body.split('\n');
  const childIssueNumbers: number[] = [];
  let inChildren = false;
  for (const line of lines) {
    if (line.trim() === '') {
      if (inChildren) {
        break;
      }
      continue;
    }
    if (line.startsWith('Sub-issues:') || line.startsWith('Children:')) {
      inChildren = true;
      continue;
    }
    if (!inChildren) {
      continue;
    }
    const match = line.match(/#(\d+)/);
    if (!match || !match[1]) {
      if (!line.startsWith('-')) {
        break;
      }
      continue;
    }
    childIssueNumbers.push(Number(match[1]));
  }
  return childIssueNumbers;
}
