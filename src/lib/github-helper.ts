/**
 * Shared GitHub push/open helper.
 *
 * Centralizes the orchestration for:
 *  - resolving GitHub config
 *  - pushing a work item to GitHub via upsertIssuesFromWorkItems
 *  - opening the resulting issue URL in a browser or copying it to clipboard
 *
 * This module is UI-agnostic: callers (TUI, CLI, tests) supply callbacks for
 * clipboard writing (writeOsc52), progress indication, and persistence.
 *
 * Migrated from src/tui/github-action-helper.ts to eliminate duplication
 * between the TUI controller inline fallback and the helper module.
 * See work item WL-0MMMGB7VY1XNY073.
 */

import { openUrlInBrowser } from '../utils/open-url.js';
import { copyToClipboard, type SpawnLike } from '../clipboard.js';
import type { WorkItem, Comment } from '../types.js';
import type { GithubSyncResult } from '../github-sync.js';
import type * as fs from 'fs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result returned by every helper function so callers can surface feedback. */
export interface GithubHelperResult {
  /** Whether the overall operation succeeded. */
  success: boolean;
  /** The GitHub issue URL (if available). */
  url?: string;
  /** A human-readable message suitable for a toast / log line. */
  toastMessage: string;
  /** Items returned by upsertIssuesFromWorkItems (only for push). */
  updatedItems?: WorkItem[];
  /** Raw sync result from upsertIssuesFromWorkItems (only for push). */
  syncResult?: GithubSyncResult;
}

/** Resolved GitHub configuration (repo + optional label prefix). */
export interface GithubConfig {
  repo: string;
  labelPrefix?: string;
}

/** Dependencies injected by the caller so the helper remains UI-agnostic. */
export interface GithubHelperDeps {
  /** Resolve GitHub config; should throw when not configured. */
  resolveGithubConfig: (opts: Record<string, unknown>) => GithubConfig | null;
  /** Push / sync work items to GitHub. */
  upsertIssuesFromWorkItems: (
    items: WorkItem[],
    comments: Comment[],
    config: GithubConfig,
  ) => Promise<{ updatedItems: WorkItem[]; result: GithubSyncResult }>;
  /** Optional: override for openUrlInBrowser (useful for tests). */
  openUrl?: (url: string, fsImpl?: typeof fs) => Promise<boolean>;
  /** Optional: override for copyToClipboard (useful for tests). */
  copyToClipboard?: typeof copyToClipboard;
  /** Optional: fs implementation passed to openUrlInBrowser. */
  fsImpl?: typeof fs;
  /** Optional: spawn implementation passed to copyToClipboard. */
  spawnImpl?: SpawnLike;
  /** Optional: OSC 52 write callback for clipboard fallback. */
  writeOsc52?: (seq: string) => void;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Try to open `url` in the system browser.  If that fails, copy the URL to
 * the clipboard.  Returns a result describing what happened.
 */
async function openOrCopyUrl(
  url: string,
  deps: GithubHelperDeps,
  successToast: string,
): Promise<GithubHelperResult> {
  const openFn = deps.openUrl ?? openUrlInBrowser;
  const copyFn = deps.copyToClipboard ?? copyToClipboard;

  try {
    const opened = await openFn(url, deps.fsImpl);
    if (opened) {
      return { success: true, url, toastMessage: successToast };
    }

    // Browser open failed — fall back to clipboard.
    const clipResult = await copyFn(url, {
      spawn: deps.spawnImpl,
      writeOsc52: deps.writeOsc52,
    });

    if (clipResult.success) {
      return { success: true, url, toastMessage: `URL copied: ${url}` };
    }

    return { success: false, url, toastMessage: `Open failed: ${url}` };
  } catch (_) {
    // Both open and copy failed; return the raw URL so the caller can still
    // display it to the user.
    return { success: false, url, toastMessage: `GitHub: ${url}` };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open an existing GitHub issue for an item that already has a mapping.
 *
 * Attempts to launch the system browser; falls back to copying the URL.
 */
export async function openExistingIssue(
  item: WorkItem,
  config: GithubConfig,
  deps: GithubHelperDeps,
): Promise<GithubHelperResult> {
  const url = `https://github.com/${config.repo}/issues/${item.githubIssueNumber}`;
  return openOrCopyUrl(url, deps, 'Opening GitHub issue\u2026');
}

/**
 * Push a single work item to GitHub, then open/copy the resulting issue URL.
 *
 * Returns a structured result so the caller can persist updated items and
 * surface toast messages.
 */
export async function pushAndOpen(
  item: WorkItem,
  comments: Comment[],
  config: GithubConfig,
  deps: GithubHelperDeps,
): Promise<GithubHelperResult> {
  try {
    const { updatedItems, result } = await deps.upsertIssuesFromWorkItems(
      [item],
      comments,
      config,
    );

    // Find the synced entry for this item.
    const synced = result?.syncedItems?.find(
      (s: { id: string; issueNumber: number }) => s.id === item.id,
    );

    if (synced?.issueNumber) {
      const url = `https://github.com/${config.repo}/issues/${synced.issueNumber}`;
      const pushToast = `Pushed: ${config.repo}#${synced.issueNumber}`;

      // Try to open the newly created issue.
      const openResult = await openOrCopyUrl(url, deps, pushToast);
      return {
        ...openResult,
        updatedItems,
        syncResult: result,
        // Keep the push toast when we managed to open, so the caller sees
        // both the push confirmation and the open status.
        toastMessage: openResult.success ? pushToast : openResult.toastMessage,
      };
    }

    // The item may already have had a mapping before push ran.
    if (item.githubIssueNumber) {
      const url = `https://github.com/${config.repo}/issues/${item.githubIssueNumber}`;
      const openResult = await openOrCopyUrl(url, deps, 'Opening GitHub issue\u2026');
      return { ...openResult, updatedItems, syncResult: result };
    }

    // Check for errors from the sync.
    if (result?.errors?.length > 0) {
      return {
        success: false,
        toastMessage: `Push failed: ${result.errors[0]}`,
        updatedItems,
        syncResult: result,
      };
    }

    return {
      success: true,
      toastMessage: 'Push complete (no changes)',
      updatedItems,
      syncResult: result,
    };
  } catch (err: any) {
    return {
      success: false,
      toastMessage: `Push failed: ${err?.message || 'Unknown error'}`,
    };
  }
}

/**
 * Resolve GitHub configuration. Returns the config or a failure result.
 *
 * Convenience wrapper so callers don't need their own try/catch around
 * `resolveGithubConfig`.
 */
export function tryResolveConfig(
  deps: GithubHelperDeps,
): { config: GithubConfig } | { error: GithubHelperResult } {
  try {
    const config = deps.resolveGithubConfig({});
    if (!config) {
      return {
        error: {
          success: false,
          toastMessage: 'Set githubRepo in config or run: wl github --repo <owner/repo> push',
        },
      };
    }
    return { config };
  } catch (_) {
    return {
      error: {
        success: false,
        toastMessage: 'Set githubRepo in config or run: wl github --repo <owner/repo> push',
      },
    };
  }
}

/**
 * High-level entry point: resolve config, then either open an existing issue
 * or push and open a new one.
 *
 * This is the single function most callers should use.
 */
export async function githubPushOrOpen(
  item: WorkItem,
  deps: GithubHelperDeps & {
    /** Database for fetching comments and persisting updated items. */
    db?: {
      getCommentsForWorkItem: (id: string) => Comment[];
      upsertItems?: (items: WorkItem[]) => void;
    };
    /** Callback to refresh the list/view after persistence. */
    refreshFromDatabase?: (selectedIndex?: number) => void;
    /** Currently selected index (for refreshFromDatabase). */
    selectedIndex?: number;
  },
): Promise<GithubHelperResult> {
  // 1. Resolve config.
  const resolved = tryResolveConfig(deps);
  if ('error' in resolved) return resolved.error;
  const { config } = resolved;

  // 2. If the item already has a GitHub mapping, just open it.
  if (item.githubIssueNumber) {
    return openExistingIssue(item, config, deps);
  }

  // 3. Push to GitHub.
  const comments: Comment[] = deps.db
    ? deps.db.getCommentsForWorkItem(item.id)
    : [];

  const result = await pushAndOpen(item, comments, config, deps);

  // 4. Persist updated items if a DB was supplied.
  if (result.updatedItems && result.updatedItems.length > 0) {
    deps.db?.upsertItems?.(result.updatedItems);
  }

  // 5. Refresh the view.
  try {
    deps.refreshFromDatabase?.(deps.selectedIndex ?? 0);
  } catch (_) {
    // Non-critical; swallow errors from view refresh.
  }

  return result;
}
