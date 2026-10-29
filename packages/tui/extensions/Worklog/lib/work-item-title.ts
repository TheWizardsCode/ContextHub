/**
 * lib/work-item-title.ts — Shared work item title resolver for the Worklog
 * Pi extension footer (WL-0MVGB23MM004X501).
 *
 * The footer has two title-resolution call sites (the activity-indicator
 * status line and the session-health line-3 initial-prompt preview). This
 * module is the *single* resolver both use (AC3) so they cannot drift.
 *
 * ## Why a resolver at all
 *
 * `wl show <id> --json` run with cwd only fails for IDs whose `<PREFIX>-`
 * belongs to a sibling project's worklog (e.g. `RISE-…` while the session
 * cwd is ContextHub) — the title silently vanished from the footer. This
 * resolver:
 *
 * 1. Finds the sibling worklogs declaring the ID's prefix
 *    (`lib/worklog-dir.ts`, memoised per process — AC6).
 * 2. Probes each candidate with an explicit `--worklog-dir` until `wl show`
 *    succeeds, so a worklog that does NOT own the ID (ambiguous prefixes
 *    like `POD` × 12) is never accepted — no wrong title, no "not found"
 *    (plan-review constraint / AC1).
 * 3. Falls back to a plain cwd lookup when no sibling matches (AC2).
 * 4. Uses a raised timeout (`TITLE_LOOKUP_TIMEOUT_MS`, AC4) so a large
 *    item resolves reliably on a loaded machine.
 * 5. Degrades silently to `null` on any failure (AC5) — matching the
 *    original graceful-fallback AC of WL-0MQLG8PK80041FM3.
 */

import { runWl } from '../../wl-integration.js';
import { extractWorkItemPrefix, findWorklogDirsByPrefix, resetWorklogDirCache } from './worklog-dir.js';

/**
 * Timeout budget (ms) for the title lookup. Raised from the original 2000 ms
 * (AC4): a cold `wl show` of an 18 KB item measured 2.36 s, so the old
 * ceiling could drop the title under load. 5000 ms gives that lookup
 * comfortable headroom while still degrading gracefully on a hung CLI.
 */
export const TITLE_LOOKUP_TIMEOUT_MS = 5000;

/** id → sibling worklog dir that owns it (memoised per process, AC6). */
const ownedDirCache = new Map<string, string>();

/**
 * Clear the resolver's internal caches (for tests and process relocation).
 */
export function resetTitleLookupCache(): void {
  ownedDirCache.clear();
  resetWorklogDirCache();
}

/**
 * Resolve a work item ID to its title via `wl show`, honouring sibling
 * worklogs. Returns the title string, or `null` on any failure — callers
 * keep showing the raw ID/text (AC5).
 *
 * @param id - Full work item ID, e.g. `RISE-0MVCFSM9B0019M8L`.
 */
export async function resolveWorkItemTitle(id: string): Promise<string | null> {
  const prefix = extractWorkItemPrefix(id);
  if (!prefix) return null;

  const candidates = findWorklogDirsByPrefix(prefix);

  if (candidates.length === 0) {
    // No sibling declares this prefix: fall back to cwd (today's behaviour).
    return lookupTitle(id, null);
  }

  const cachedDir = ownedDirCache.get(id);
  if (cachedDir) {
    return lookupTitle(id, cachedDir);
  }

  // Ambiguous prefix: probe candidates (sorted) until one owns the ID.
  // A candidate that does not own the ID makes `wl show` fail, so a success
  // is proof of ownership — cache that dir so later lookups skip the probes.
  // Failures are deliberately NOT cached: a transient timeout must be
  // retried on the next lookup rather than freezing the raw ID for the rest
  // of the process. (Only successes are worth memoising; AC6 covers the
  // prefix→dirs scan, which is memoised unconditionally.)
  for (const dir of candidates) {
    const title = await lookupTitle(id, dir);
    if (title !== null) {
      ownedDirCache.set(id, dir);
      return title;
    }
  }
  return null;
}

/**
 * Run a single `wl show` title lookup, against an explicit sibling worklog
 * dir when provided. Errors and non-title payloads both degrade to `null`.
 */
async function lookupTitle(id: string, worklogDir: string | null): Promise<string | null> {
  try {
    const args = worklogDir ? [id, '--worklog-dir', worklogDir] : [id];
    const result = await runWl('show', args, { timeout: TITLE_LOOKUP_TIMEOUT_MS });
    if (result && typeof result === 'object' && typeof result.title === 'string') {
      return result.title;
    }
    return null;
  } catch {
    return null;
  }
}
