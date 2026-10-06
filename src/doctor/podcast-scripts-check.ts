/**
 * Podcast episode `Key Files:` validation.
 *
 * The herdr `w` / `t` chords resolve an episode's `.podcast.md` script from
 * the first `.podcast.md` entry under the `Key Files:` heading of the
 * episode work item (see `PODCAST_WORKFLOW.md` and OSL-0MUTPC7SF0011Y54).
 * Nothing used to require that entry to exist, so a producer could reach a
 * script-bearing stage with no resolvable script and every chord would fail
 * silently.
 *
 * This check is deliberately **artifact-based**: it resolves the
 * `.podcast.md` paths against the filesystem rather than trusting the
 * item's stage/status to describe reality.
 *
 * Follows the pattern from `file-paths-check.ts` and `status-stage-check.ts`.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { WorkItem } from '../types.js';
import { extractFilePaths } from '../commands/helpers.js';

export type DoctorSeverity = 'info' | 'warning' | 'error';

export interface PodcastScriptsFinding {
  checkId: string;
  type: string;
  severity: DoctorSeverity;
  itemId: string;
  message: string;
  proposedFix: Record<string, unknown> | null;
  safe: boolean;
  context: Record<string, unknown>;
}

/** Default podcast directory relative to the worklog root. */
export const DEFAULT_PODCAST_DIR = '.llm-wiki/wiki/podcast';

/**
 * Stages at which a script is expected to exist. A `podcast` item at one of
 * these stages with no `.podcast.md` `Key Files:` entry is flagged. The
 * stage only scopes *whether absence is a problem*; resolvability of any
 * listed path is always checked against the filesystem.
 */
export const SCRIPT_BEARING_STAGES = ['plan_complete', 'in_review', 'done'];

const CHECK_ID_MISSING = 'podcast-scripts.missing';
const CHECK_ID_UNRESOLVED = 'podcast-scripts.unresolved';
const TYPE_MISSING = 'missing-podcast-script';
const TYPE_UNRESOLVED = 'unresolved-podcast-script';
const SEVERITY: DoctorSeverity = 'warning';

const KEY_FILES_HEADER_RE = /^#{0,3}\s*\*{0,2}key files:?\*{0,2}\s*$/i;
const HEADING_RE = /^#{1,6}\s/;
const BULLET_RE = /^([-*])\s+(.*)$/;

/**
 * Return the `.podcast.md` paths listed under the item's `Key Files:` heading.
 */
export function extractPodcastScriptPaths(description: string): string[] {
  return extractFilePaths(description).filter(p => p.toLowerCase().endsWith('.podcast.md'));
}

/** Normalise a `Key Files:` bullet to a bare path for duplicate detection. */
function normaliseForCompare(value: string): string {
  let text = value.trim();
  if (text.startsWith('`')) {
    const end = text.indexOf('`', 1);
    text = end !== -1 ? text.slice(1, end) : text.slice(1);
  }
  text = text.trim();
  const token = text.split(/\s+/)[0] || text;
  return token.replace(/^\.\//, '');
}

/**
 * Append *relpath* to the `Key Files:` section of *description*.
 *
 * Idempotent and append-only: existing entries are preserved in order and a
 * path already present is not added again. When no section exists, a
 * canonical `**Key Files:**` section is appended.
 */
export function appendKeyFileEntry(description: string, relpath: string): string {
  const lines = description.split('\n');
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (KEY_FILES_HEADER_RE.test(lines[i].trim())) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx === -1) {
    const base = description.replace(/\n+$/, '');
    return `${base}\n\n**Key Files:**\n- \`${relpath}\``;
  }

  const existing = new Set<string>();
  let insertAfter = headerIdx;
  let j = headerIdx + 1;
  while (j < lines.length) {
    const stripped = lines[j].trim();
    if (!stripped) {
      j++;
      continue;
    }
    if (HEADING_RE.test(stripped) || KEY_FILES_HEADER_RE.test(stripped)) {
      break;
    }
    const bullet = stripped.match(BULLET_RE);
    if (bullet) {
      existing.add(normaliseForCompare(bullet[2]));
      insertAfter = j;
      j++;
      continue;
    }
    break;
  }

  if (existing.has(normaliseForCompare(relpath))) {
    return description;
  }
  lines.splice(insertAfter + 1, 0, `- \`${relpath}\``);
  return lines.join('\n');
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Best-effort lookup of a `.podcast.md` script for *item* under the default
 * podcast directory. Matches on the slugified item title against the script
 * filename stem. Returns a worklog-root-relative POSIX path, or null.
 */
export function findPodcastScriptForItem(item: WorkItem, rootDir: string): string | null {
  const base = path.resolve(rootDir, DEFAULT_PODCAST_DIR);
  if (!fs.existsSync(base)) {
    return null;
  }
  const slug = slugify(item.title || '');
  if (!slug) {
    return null;
  }

  let match: string | null = null;
  const walk = (dir: string): void => {
    if (match) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        if (match) return;
        continue;
      }
      if (!entry.name.toLowerCase().endsWith('.podcast.md')) {
        continue;
      }
      const stem = entry.name.slice(0, -'.podcast.md'.length).toLowerCase();
      if (stem === slug || stem.includes(slug) || slug.includes(stem)) {
        match = path.relative(rootDir, full).split(path.sep).join('/');
        return;
      }
    }
  };
  walk(base);
  return match;
}

/**
 * Validate `podcast` items' `Key Files:` script entries.
 *
 * Findings:
 * - `unresolved-podcast-script`: a listed `.podcast.md` path does not exist
 *   under *rootDir* — flagged at any stage (artifact-based).
 * - `missing-podcast-script`: a `podcast` item at a script-bearing stage has
 *   no `.podcast.md` entry at all.
 *
 * Valid items (a resolvable script entry, or a non-script-bearing item with
 * no entry) produce no finding.
 *
 * @param items - All work items in the database.
 * @param rootDir - Worklog root the `Key Files:` paths are relative to
 *   (defaults to the current working directory).
 */
export function validatePodcastScripts(
  items: WorkItem[],
  rootDir: string = process.cwd(),
): PodcastScriptsFinding[] {
  const findings: PodcastScriptsFinding[] = [];

  for (const item of items) {
    if (item.issueType !== 'podcast' || item.status === 'deleted') {
      continue;
    }
    const description = item.description || '';
    const scriptPaths = extractPodcastScriptPaths(description);

    const unresolved = scriptPaths.filter(p => {
      try {
        return !fs.existsSync(path.resolve(rootDir, p));
      } catch {
        return true;
      }
    });

    if (unresolved.length > 0) {
      findings.push({
        checkId: CHECK_ID_UNRESOLVED,
        type: TYPE_UNRESOLVED,
        severity: SEVERITY,
        itemId: item.id,
        message:
          `Podcast Key Files: script path does not resolve to an existing ` +
          `.podcast.md under the worklog root: ${unresolved.join(', ')}. ` +
          `Fix: correct the path (write it worklog-root-relative, e.g. ` +
          `\`${DEFAULT_PODCAST_DIR}/<stem>/<stem>.podcast.md\`) or regenerate the script.`,
        proposedFix: null,
        safe: false,
        context: {
          itemTitle: item.title,
          stage: item.stage,
          unresolvedPaths: unresolved,
        },
      });
      continue;
    }

    if (scriptPaths.length === 0 && SCRIPT_BEARING_STAGES.includes(item.stage || '')) {
      const candidate = findPodcastScriptForItem(item, rootDir);
      findings.push({
        checkId: CHECK_ID_MISSING,
        type: TYPE_MISSING,
        severity: SEVERITY,
        itemId: item.id,
        message: candidate
          ? `Podcast item at '${item.stage}' has no .podcast.md entry in ` +
            `Key Files:. Fix: add \`${candidate}\` under **Key Files:**.`
          : `Podcast item at '${item.stage}' has no .podcast.md entry in ` +
            `Key Files:, and no matching script was found under ` +
            `${DEFAULT_PODCAST_DIR}. Fix: add the worklog-root-relative ` +
            `script path under **Key Files:**.`,
        proposedFix: candidate
          ? { description: appendKeyFileEntry(description, candidate) }
          : null,
        safe: Boolean(candidate),
        context: {
          itemTitle: item.title,
          stage: item.stage,
          candidatePath: candidate,
        },
      });
    }
  }

  return findings;
}
