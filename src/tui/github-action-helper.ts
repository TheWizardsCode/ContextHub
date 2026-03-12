/**
 * TUI-specific wrapper around the shared GitHub push/open helper.
 *
 * This module wires TUI concerns (screen.program.write for OSC 52,
 * screen.render for progress indication, showToast for user feedback)
 * to the UI-agnostic helper at src/lib/github-helper.ts.
 *
 * Refactored from the previous inline implementation to eliminate
 * duplication with the controller.ts fallback code.
 * See work item WL-0MMMGB7VY1XNY073.
 */

import { copyToClipboard } from '../clipboard.js';
import { githubPushOrOpen } from '../lib/github-helper.js';

export default async function githubActionHelper(opts: {
  item: any;
  screen?: any;
  db?: any;
  showToast: (s: string) => void;
  fsImpl?: any;
  spawnImpl?: any;
  copyToClipboard?: typeof copyToClipboard;
  resolveGithubConfig: (o: any) => { repo: string; labelPrefix?: string } | null;
  upsertIssuesFromWorkItems: (items: any[], comments: any[], cfg: any) => Promise<any>;
  list?: any;
  refreshFromDatabase?: (idx?: number) => void;
}): Promise<void> {
  const {
    item,
    screen,
    db,
    showToast,
    fsImpl,
    spawnImpl,
    copyToClipboard: copyFn = copyToClipboard,
    resolveGithubConfig,
    upsertIssuesFromWorkItems,
    list,
    refreshFromDatabase,
  } = opts;

  // Show a progress toast before starting a push (not needed for open).
  if (!item.githubIssueNumber) {
    showToast('Pushing to GitHub\u2026');
    try { screen?.render?.(); } catch (_) {}
  }

  let result;
  try {
    result = await githubPushOrOpen(item, {
      resolveGithubConfig,
      upsertIssuesFromWorkItems,
      copyToClipboard: copyFn,
      fsImpl,
      spawnImpl,
      writeOsc52: (s: string) => {
        try {
          if (screen && screen.program && typeof screen.program.write === 'function') {
            screen.program.write(s);
          }
        } catch (_) {}
      },
      db,
      refreshFromDatabase,
      selectedIndex: list?.selected ?? 0,
    });
  } catch (err: any) {
    showToast(`GitHub action failed: ${err?.message || 'Unknown error'}`);
    return;
  }

  showToast(result.toastMessage);
}
