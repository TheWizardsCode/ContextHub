/**
 * src/sync/types.ts — shared type declarations of the sync module.
 *
 * Concern: the public data shapes exchanged by sync — the git target a sync
 * pushes to / pulls from, the merge options and result, the author-identity
 * gate inputs and outputs and the delta-replay result. These are the leaf
 * declarations every other sync concern depends on, so they live here to keep
 * `src/sync.ts` a thin barrel.
 *
 * Moved verbatim from `src/sync.ts` (WL-0MVP9PCOU004L8HN, child 2 of 6 of the
 * WL-0MVGKGMU400631VZ `src/sync.ts` decomposition). Move-only: no member
 * added, removed or re-typed; optionality and doc comments preserved.
 * `MergeOptions` lives here (not in `merge-utils.ts`) so the merge primitives
 * can import it without a barrel round-trip.
 */

import type { WorkItem, Comment, ConflictDetail, DependencyEdge, AuditResult } from '../types.js';
import type { ClaimHoldDecision } from '../claim-hold.js';
import type { SyncPhaseTimings } from '../sync-phase-timings.js';

export interface GitTarget {
  remote: string;
  branch: string; // may be a branch name or a full ref (e.g. refs/worklog/data)
}

/**
 * Result of a sync operation
 */
export interface SyncResult {
  itemsAdded: number;
  itemsUpdated: number;
  itemsUnchanged: number;
  commentsAdded: number;
  commentsUnchanged: number;
  conflicts: string[]; // Legacy text-based conflicts (for backward compatibility)
  conflictDetails: ConflictDetail[]; // Detailed conflict information
  /**
   * Held-claim downgrades the sync refused to write (SA-0MVE34D9B005TUYJ).
   * Empty unless a claim landed during the sync window or a stale remote row
   * tried to downgrade a held claim. Present for the sync log / `--json`.
   */
  claimHolds?: ClaimHoldDecision[];
  /**
   * Wall-clock milliseconds per sync phase (`pull`, `persist-items`,
   * `persist-comments`, `export`, `push` — {@link SyncPhaseTimings}).
   * Populated by `performSync` so the `--json` summary and the sync log can
   * attribute the wall-clock cost (WL-0MVK6SD5O001K901). Skipped phases
   * report 0 rather than disappearing.
   */
  phaseTimings?: SyncPhaseTimings;
}

export interface MergeOptions {
  defaultValueFields?: Array<keyof WorkItem>;
  sameTimestampStrategy?: 'lexicographic' | 'local' | 'remote';
  /** When true, allow remote defaults to overwrite local non-defaults (accept regressions). Default: false. */
  acceptRegressions?: boolean;
}

export interface IncomingCommit {
  hash: string;         // short commit hash (e.g. '5fc880a')
  authorEmail: string;  // may be '' when the commit has an empty author email
}

export type SyncAllowedAuthors = string[] | null | boolean;

export interface AuthorIdentityOptions {
  remoteTrackingRef: string;     // e.g. refs/worklog/remotes/origin/worklog/data
  expectedAuthorEmail?: string;  // repo `git config user.email`; undefined = not configured
  allowForeignAuthor?: boolean;  // `wl sync --allow-foreign-author` (legacy override)
  allowedAuthors?: SyncAllowedAuthors; // whitelist: []=strict, string[]=allow listed, null/true=allow all
}

export interface AuthorIdentityViolation {
  commit: string;
  authorEmail: string;
  reason: 'empty-email' | 'foreign-email';
}

export interface AuthorIdentityResult {
  allowed: boolean;
  violations: AuthorIdentityViolation[];
  message: string;   // refusal message naming the offending commit(s) + remote ref; '' when allowed
}

/**
 * Result of reconstructing a remote worklog stream from ref history.
 */
export interface DeltaReplayResult {
  items: WorkItem[];
  comments: Comment[];
  dependencyEdges: DependencyEdge[];
  auditResults: AuditResult[];
}
