/**
 * src/sync/refs.ts — last-synced-ref and remote-ref bookkeeping for sync.
 *
 * Concern: naming and materialising the local refs a sync reads (including
 * the dedicated `refs/worklog/remotes/…` namespace for worklog refs),
 * fetching the remote worklog ref, and persisting the last-synced-ref state
 * file that bounds the author-identity gate's commit scan.
 *
 * Extracted verbatim from `src/sync.ts` (WL-0MVP9R3PU004EGYE, child 4 of 6 of
 * the WL-0MVGKGMU400631VZ `src/sync.ts` decomposition). The five public
 * helpers are re-exported from the barrel; `fetchRemote`, `refExists` and
 * `fetchTargetRef` are owned here as module-internal plumbing, exported so
 * later extraction children can import them directly — they are NOT added to
 * the `./sync.js` public surface.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execAsync, gitExecAsync, escapeShellArg } from './git-exec.js';
import type { GitTarget } from './types.js';

/**
 * Path of the last-synced-ref state file (mirrors the last-sync-time
 * pattern). Persists the remote tracking ref tip after each successful
 * non-dry-run sync so the next sync only inspects commits since that point.
 */
export function getLastSyncedRefPath(dataFilePath: string): string {
  return path.join(path.dirname(dataFilePath), 'last-synced-ref');
}

/**
 * Read the last-known sync point (remote tracking ref tip). Returns undefined
 * when the state file is absent, empty, or unreadable — the gate then scans
 * the whole remote ref history.
 */
export function readLastSyncedRef(dataFilePath: string): string | undefined {
  try {
    const raw = fs.readFileSync(getLastSyncedRefPath(dataFilePath), 'utf8').trim();
    return raw || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Persist the last-known sync point after a successful non-dry-run sync.
 */
export function writeLastSyncedRef(dataFilePath: string, refSha: string): void {
  try {
    fs.writeFileSync(getLastSyncedRefPath(dataFilePath), `${refSha}\n`, 'utf8');
  } catch {
    // Non-critical state file; a failed write only means the next sync scans
    // more history than necessary (the gate still runs).
  }
}

/**
 * Resolve the tip SHA of the remote tracking ref (used to persist
 * last-synced-ref). Returns undefined when the ref cannot be resolved.
 */
export async function getRemoteTrackingRefSha(remoteTrackingRef: string): Promise<string | undefined> {
  try {
    const { stdout } = await gitExecAsync(`git rev-parse ${escapeShellArg(remoteTrackingRef)}`);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function fetchRemote(remote: string): Promise<void> {
  await execAsync(`git fetch ${escapeShellArg(remote)}`);
}

export function getRemoteTrackingRef(remote: string, branchOrRef: string): string {
  // For a named branch like "worklog-data", track it as refs/remotes/origin/worklog-data.
  // For an explicit ref like "refs/worklog/data", DO NOT track it under refs/remotes/...
  // because that namespace is reserved for remote-tracking branches and can collide with
  // real branches like "worklog/data" and/or reject non-fast-forward updates.
  //
  // Instead, keep a local-only tracking ref under refs/worklog/remotes/<remote>/...
  if (branchOrRef.startsWith('refs/')) {
    const suffix = branchOrRef.slice('refs/'.length);
    return `refs/worklog/remotes/${remote}/${suffix}`;
  }

  return `refs/remotes/${remote}/${branchOrRef}`;
}

// Exposed for unit tests.
export const _testOnly_getRemoteTrackingRef = getRemoteTrackingRef;

async function refExists(ref: string): Promise<boolean> {
  try {
    await execAsync(`git show-ref --verify --quiet ${escapeShellArg(ref)}`);
    return true;
  } catch {
    return false;
  }
}

export async function fetchTargetRef(target: GitTarget): Promise<{ hasRemote: boolean; remoteTrackingRef: string }> {
  const remoteTrackingRef = getRemoteTrackingRef(target.remote, target.branch);

  if (target.branch.startsWith('refs/')) {
    // Default git fetch refspec does not include custom refs/*, so fetch it explicitly.
    // If it doesn't exist yet, treat as "no remote".
    try {
      await execAsync(
        // Force-update the local tracking ref so stale/colliding local refs don't block sync.
        `git fetch ${escapeShellArg(target.remote)} ${escapeShellArg(`+${target.branch}:${remoteTrackingRef}`)}`
      );
    } catch {
      // Avoid silently treating fetch failures as "ref missing"; that can lead to overwriting
      // an existing remote data ref from an orphan branch.
      let remoteExists = false;
      try {
        const { stdout } = await execAsync(
          `git ls-remote --exit-code ${escapeShellArg(target.remote)} ${escapeShellArg(target.branch)}`
        );
        remoteExists = !!stdout.trim();
      } catch {
        remoteExists = false;
      }

      if (remoteExists) {
        throw new Error(`Failed to fetch existing remote ref ${target.branch} from ${target.remote}`);
      }

      return { hasRemote: false, remoteTrackingRef };
    }

    const hasRemote = await refExists(remoteTrackingRef);
    if (!hasRemote) {
      // If the remote ref exists but we can't materialize a local tracking ref,
      // treat it as an error to avoid overwriting the remote from an orphan branch.
      let remoteExists = false;
      try {
        const { stdout } = await execAsync(
          `git ls-remote --exit-code ${escapeShellArg(target.remote)} ${escapeShellArg(target.branch)}`
        );
        remoteExists = !!stdout.trim();
      } catch {
        remoteExists = false;
      }

      if (remoteExists) {
        throw new Error(`Failed to create local tracking ref for ${target.branch} from ${target.remote}`);
      }
    }

    return { hasRemote, remoteTrackingRef };
  }

  // Standard branch fetch. This will populate refs/remotes/<remote>/<branch>.
  await execAsync(`git fetch ${escapeShellArg(target.remote)} ${escapeShellArg(target.branch)}`);
  return { hasRemote: await refExists(remoteTrackingRef), remoteTrackingRef };
}
