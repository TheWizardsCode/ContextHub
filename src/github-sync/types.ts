/**
 * src/github-sync/types.ts — result, timing and progress type declarations of
 * the github-sync module.
 *
 * Concern: the data shapes the sync flow reports to its callers — the per-item
 * outcomes (`SyncedItem`, `SyncErrorItem`), the aggregate counters and timings
 * (`GithubSyncResult`, `GithubSyncTiming`), the progress events surfaced to the
 * TUI (`GithubProgress`) and a single label-derived field change produced by
 * import label resolution (`FieldChange`). Declarations only: no runtime code,
 * so this module is a leaf the flow modules can depend on instead of the
 * barrel.
 *
 * Moved verbatim from `src/github-sync.ts` (WL-0MW0JF5YE008LV1R, child 2 of 8
 * of the WL-0MVGKH9Z900178UF `src/github-sync.ts` decomposition). Move-only: no
 * member added, removed or re-typed; optionality and doc comments preserved.
 */

export interface SyncedItem {
  action: 'created' | 'updated' | 'closed';
  id: string;
  title: string;
  issueNumber: number;
}

export interface SyncErrorItem {
  id: string;
  title: string;
  error: string;
}

export interface GithubSyncResult {
  updated: number;
  created: number;
  closed: number;
  skipped: number;
  errors: string[];
  syncedItems: SyncedItem[];
  errorItems: SyncErrorItem[];
  commentsCreated?: number;
  commentsUpdated?: number;
}

export interface GithubSyncTiming {
  totalMs: number;
  upsertMs: number;
  commentListMs: number;
  commentUpsertMs: number;
  hierarchyCheckMs: number;
  hierarchyLinkMs: number;
  hierarchyVerifyMs: number;
}

export interface GithubProgress {
  phase: 'push' | 'import' | 'close-check' | 'hierarchy' | 'comments' | 'saving';
  current: number;
  total: number;
  // items per second (measured since the first event for this phase)
  rate?: number;
  // estimated milliseconds remaining (null when not measurable)
  etaMs?: number | null;
  // short human note (e.g., push batch details or throttler snapshot)
  note?: string;
  // last error message observed for diagnostics
  lastError?: string | null;
  // optional throttler snapshot
  throttler?: { active: number; queueLength: number; tokens?: number; rate?: number; burst?: number; concurrency?: number } | null;
}

/**
 * Represents a field that was changed during import label resolution.
 * Used for audit logging and JSON output.
 */
export interface FieldChange {
  workItemId: string;
  field: string;
  oldValue: string;
  newValue: string;
  source: 'github-label';
  timestamp: string;
}
