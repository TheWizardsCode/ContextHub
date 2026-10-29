/**
 * lib/worklog-dir.ts — Cross-project worklog-dir resolution for the Worklog
 * Pi extension (WL-0MVGB23MM004X501).
 *
 * The extension footer resolves work item titles with `wl show <id> --json`.
 * When the ID lives in a *sibling project's* worklog — its `<PREFIX>-` is
 * declared in another project's `.worklog/config.yaml` as `prefix: <PREFIX>`
 * — a plain cwd-based lookup fails ("Work item not found") and the footer
 * silently drops the title. This module mirrors the skills layer's
 * prefix-to-sibling scan (`skill/shared/status_lifecycle.py`
 * `_find_worklog_dir_by_prefix`) so the extension can pass an explicit
 * `--worklog-dir` to the CLI.
 *
 * ## Resolution contract
 *
 * - `extractWorkItemPrefix` — pull the 2–3 letter prefix off a full work
 *   item ID (the existing `WORK_ITEM_ID_REGEX` in `activity-indicator.ts` is
 *   unchanged; this is a separate, closed-form pattern for the ID itself).
 * - `findWorklogDirsByPrefix(prefix, scanRoot?)` — memoised (AC6) scan of
 *   the `config.yaml` files under `<scanRoot>` project dirs returning the
 *   `.worklog` dirs that declare the prefix, in deterministic sorted order. Only *initialised*
 *   worklogs (with `worklog.db` or an `initialized` marker) are returned —
 *   a worktree copy that holds just a committed `config.yaml` is never
 *   selected as a target.
 * - `getSiblingScanRoot` / `deriveSiblingScanRoot` — the scan root is the
 *   parent of the repo that ships this extension (matching
 *   `status_lifecycle.SIBLING_SCAN_ROOT = REPO_ROOT.parent`), derived from
 *   the module's own realpath (symlink-safe, cwd-independent), with the
 *   `WORKLOG_SIBLING_SCAN_ROOT` environment override for tests/embeds.
 *
 * Ambiguous prefixes (e.g. `POD` declared by 12 `podcast-*` projects on this
 * machine) are handled by the *caller*: `lib/work-item-title.ts` probes each
 * candidate until `wl show` succeeds, so a worklog that does not own the ID
 * is never accepted (plan-review constraint). This module deliberately
 * returns only the candidate list — never a single "best" dir.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Env override for the sibling scan root (tests, unusual installs). */
export const SIBLING_SCAN_ROOT_ENV = 'WORKLOG_SIBLING_SCAN_ROOT';

/**
 * Full work item ID shape: 2–5 uppercase letters, dash, 15+ alphanumerics.
 * Mirrors `WORK_ITEM_ID_REGEX` in `activity-indicator.ts` (which stays the
 * single source of truth for *detecting* IDs in text) and the skills layer's
 * `_extract_work_item_prefix` bound `{2,5}`; this closed form anchors the
 * whole string so a prefix is only extracted from a real ID.
 */
const WORK_ITEM_ID_PATTERN = /^([A-Z]{2,5})-([A-Z0-9]{15,})$/;

/**
 * Extract the 2–3 letter uppercase prefix from a full work item ID.
 *
 * @param id - A work item ID such as `RISE-0MVCFSM9B0019M8L`.
 * @returns The prefix (`RISE`), or `null` when the input is not a full ID.
 */
export function extractWorkItemPrefix(id: string): string | null {
  const match = id.trim().match(WORK_ITEM_ID_PATTERN);
  return match ? match[1] : null;
}

/**
 * Read the `prefix:` value from a project's `.worklog/config.yaml`.
 *
 * Mirrors `_find_worklog_dir_by_prefix` in `skill/shared/status_lifecycle.py`:
 * a per-line scan for a `prefix:` key, tolerating surrounding quotes.
 *
 * @param configPath - Path to the config.yaml file.
 * @returns The declared prefix value, or `null` when absent/unreadable/malformed.
 */
export function readConfigPrefix(configPath: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(configPath, 'utf-8');
  } catch {
    return null;
  }
  for (const line of text.split('\n')) {
    const stripped = line.trim();
    if (!stripped.startsWith('prefix:')) continue;
    const value = stripped.slice('prefix:'.length).trim().replace(/^["']|["']$/g, '');
    return value || null;
  }
  return null;
}

/**
 * True when *worklogDir* is an initialised worklog (has `worklog.db` or an
 * `initialized` marker). A directory holding only a committed `config.yaml`
 * (a git worktree copy) is NOT usable — pointing `wl` at it fails with
 * "Worklog system is not initialized". Mirrors
 * `status_lifecycle._is_initialized_worklog`.
 */
export function isInitializedWorklog(worklogDir: string): boolean {
  try {
    if (!fs.statSync(worklogDir).isDirectory()) return false;
  } catch {
    return false;
  }
  return (
    fs.existsSync(path.join(worklogDir, 'initialized')) ||
    fs.existsSync(path.join(worklogDir, 'worklog.db'))
  );
}

/**
 * Derive the sibling scan root from this module's installed location.
 *
 * Walks up from the module realpath (symlink-safe) to the first ancestor
 * that is a real checkout root — `.git` as a *directory* (a worktree's
 * `.git` is a pointer *file*, so worktree copies are skipped) or a
 * `.worklog/config.yaml` — and returns that root's parent. The normal
 * layout is `…/projects/ContextHub` (this repo) → `…/projects`, matching
 * `status_lifecycle.SIBLING_SCAN_ROOT = REPO_ROOT.parent`.
 */
export function deriveSiblingScanRoot(): string | null {
  let dir: string;
  try {
    dir = path.dirname(realpathSync(fileURLToPath(import.meta.url)));
  } catch {
    return null;
  }
  for (;;) {
    const dotGit = path.join(dir, '.git');
    const worklogConfig = path.join(dir, '.worklog', 'config.yaml');
    if (fs.existsSync(dotGit)) {
      let isDir = false;
      try {
        isDir = fs.statSync(dotGit).isDirectory();
      } catch {
        // Concurrent removal — treat as not a checkout root this pass.
      }
      if (isDir) return path.dirname(dir);
      // Worktree `.git` file — keep walking to the main checkout.
    } else if (fs.existsSync(worklogConfig)) {
      return path.dirname(dir);
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Get the sibling scan root (`WORKLOG_SIBLING_SCAN_ROOT` override wins,
 * otherwise derived from the extension install location). Returns `null`
 * when the root cannot be derived — callers then fall back to cwd (today's
 * behaviour) rather than throwing.
 */
export function getSiblingScanRoot(): string | null {
  const override = process.env[SIBLING_SCAN_ROOT_ENV];
  if (override && override.trim()) {
    return path.resolve(override.trim());
  }
  return deriveSiblingScanRoot();
}

/** Memoised prefix → candidate `.worklog` dirs, keyed by scan root (AC6). */
const prefixDirCache = new Map<string, string[]>();

/**
 * Find every sibling project whose `.worklog/config.yaml` declares *prefix*.
 *
 * The result is memoised for the process lifetime (AC6: the per-tick footer
 * refresh must not re-scan the filesystem). Returns `[]` for an unknown
 * prefix, a missing/unreadable scan root, or malformed configs (those
 * projects are skipped). Results are deterministic (sorted project names).
 *
 * @param prefix - The extracted ID prefix (see `extractWorkItemPrefix`).
 * @param scanRoot - Scan root override; defaults to `getSiblingScanRoot()`.
 * @returns Absolute `.worklog` dir paths for the candidate projects.
 */
export function findWorklogDirsByPrefix(
  prefix: string,
  scanRoot: string | null = getSiblingScanRoot(),
): string[] {
  if (!scanRoot) return [];
  const cacheKey = `${scanRoot}\u0000${prefix}`;
  const cached = prefixDirCache.get(cacheKey);
  // Return a copy so a caller cannot corrupt the process-lifetime cache.
  if (cached) return [...cached];

  let result: string[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(scanRoot, { withFileTypes: true });
  } catch {
    result = [];
  }
  const projectNames = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const name of projectNames) {
    const worklogDir = path.join(scanRoot, name, '.worklog');
    if (!isInitializedWorklog(worklogDir)) continue;
    const declared = readConfigPrefix(path.join(worklogDir, 'config.yaml'));
    if (declared === prefix) {
      result.push(worklogDir);
    }
  }

  prefixDirCache.set(cacheKey, result);
  return [...result];
}

/**
 * Clear the memoised prefix→dirs mapping. Exported for tests and for a
 * process that deliberately relocates the scan root at runtime.
 */
export function resetWorklogDirCache(): void {
  prefixDirCache.clear();
}
