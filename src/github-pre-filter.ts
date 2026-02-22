import { WorkItem, Comment } from './types.js';
import * as fs from 'fs';
import * as path from 'path';
import { resolveWorklogDir } from './worklog-paths.js';

export interface PreFilterResult {
  filteredItems: WorkItem[];
  filteredComments: Comment[];
  totalCandidates: number; // items considered (excluding deleted)
  skippedCount: number;
}

const TIMESTAMP_FILENAME = 'github-last-push';

// Prefer DB metadata when available. The WorklogDatabase exposes getMetadata/setMetadata
// so callers may pass the database instance as the first argument. If db is not
// provided or metadata access fails we fall back to the file-based implementation
// for backward compatibility.
const METADATA_KEY = 'githubLastPush';

export function readLastPushTimestamp(db?: { getMetadata?: (k: string) => string | null }): string | null {
  // Try DB metadata first when a database instance is provided
  try {
    if (db && typeof db.getMetadata === 'function') {
      const v = db.getMetadata(METADATA_KEY);
      if (v) return v;
    }
  } catch (_err) {
    // ignore DB metadata read errors and fall back to file
  }

  try {
    const dir = resolveWorklogDir();
    const p = path.join(dir, TIMESTAMP_FILENAME);
    if (!fs.existsSync(p)) return null;
    const content = fs.readFileSync(p, { encoding: 'utf8' }).trim();
    return content || null;
  } catch (_err) {
    return null;
  }
}

export function writeLastPushTimestamp(ts: string, db?: { setMetadata?: (k: string, v: string) => void }): void {
  // Try DB metadata when available, but also write the human-friendly file
  if (db && typeof db.setMetadata === 'function') {
    try {
      db.setMetadata(METADATA_KEY, ts);
    } catch (err) {
      // Best-effort: log and continue to file write
      console.error(`Failed to write last-push timestamp to DB metadata: ${(err as Error).message}`);
    }
  }

  const dir = resolveWorklogDir();
  try {
    // ensure directory exists
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const p = path.join(dir, TIMESTAMP_FILENAME);
    // include a trailing newline for easier human inspection
    fs.writeFileSync(p, `${ts}\n`, { encoding: 'utf8' });
  } catch (err) {
    // best-effort: do not throw, allow CLI to continue
    console.error(`Failed to write last-push timestamp: ${(err as Error).message}`);
  }
}

function isValidIso(iso?: string | null): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return !Number.isNaN(t);
}

export function filterItemsForPush(items: WorkItem[], comments: Comment[], lastPushTimestamp: string | null): PreFilterResult {
  // Exclude deleted items entirely from consideration
  const candidates = items.filter(i => i.status !== 'deleted');
  // If no timestamp recorded, return all candidates and all comments
  if (!isValidIso(lastPushTimestamp)) {
    return {
      filteredItems: candidates,
      filteredComments: comments.filter(c => candidates.find(i => i.id === c.workItemId)),
      totalCandidates: candidates.length,
      skippedCount: 0,
    };
  }

  const lastMs = new Date(lastPushTimestamp as string).getTime();
  const filtered = candidates.filter(item => {
    // Always include new items that have not yet been pushed
    if (item.githubIssueNumber == null) return true;
    const updatedMs = new Date(item.updatedAt).getTime();
    if (Number.isNaN(updatedMs)) return true; // treat unknown updatedAt as changed
    return updatedMs > lastMs;
  });

  const filteredIds = new Set(filtered.map(i => i.id));
  const filteredComments = comments.filter(c => filteredIds.has(c.workItemId));

  return {
    filteredItems: filtered,
    filteredComments,
    totalCandidates: candidates.length,
    skippedCount: Math.max(0, candidates.length - filtered.length),
  };
}
