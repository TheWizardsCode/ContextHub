/**
 * packages/herdr/src/fetcher.types.ts — pure data types for the fetcher family.
 *
 * Single responsibility: the fetcher family's type-only declarations — the
 * `WlError`/`WorkItem` data shapes, the in-process SQLite read types, the
 * worklist-bundle and critical-child substitution shapes, the dependency
 * metadata refs and the claim result. Leaf module: type-only and free of
 * repository imports (only the external `ParentAuditState` type is imported),
 * which is what keeps it — and every module importing it — out of the recorded
 * import cycles (parent AC4). Moved verbatim out of `fetcher.ts` (parent
 * WL-0MVGKH47T007GKN1; extraction WL-0MW08VTPK006U01L); `AgentState` moved
 * here from `agent-tracker.ts` because `WorkItem` carries it and this leaf must
 * import nothing (the agent tracker re-exports it unchanged). No behaviour
 * change.
 */

import type { ParentAuditState } from '@worklog/shared/icons';

// ── Types ─────────────────────────────────────────────────────────────

/**
 * Agent states mirrored from the herdr sidebar protocol
 * (packages/herdr/shared/herdr-agent-state-protocol.md): `idle`, `working`,
 * `blocked` plus the CLI-terminal `done` and the catch-all `unknown`.
 *
 * Re-exported verbatim by `agent-tracker.ts` (its original owner) so every
 * existing `import type { AgentState } from './agent-tracker.js'` keeps
 * working (WL-0MW08VTPK006U01L).
 */
export type AgentState = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

/**
 * Error response from the wl CLI.
 */
export interface WlError {
  success: false;
  initialized?: boolean;
  error?: string;
}

export interface WorkItem {
  id: string;
  title: string;
  status: string;
  priority?: string;
  stage?: string;
  /** Parent work item id; null/undefined for root items */
  parentId?: string | null;
  risk?: string;
  effort?: string;
  description?: string;
  tags?: string[];
  issueType?: string;
  childCount?: number;
  createdAt?: string;
  updatedAt?: string;
  /** GitHub issue number (e.g., '#123'). */
  githubIssueNumber?: string;
  group?: number;
  groupLabel?: string;
  needsProducerReview?: boolean;
  /**
   * Soft-delete attribution (`wl delete`): a non-empty value marks the item
   * as deleted and excludes it from the downtime dispatcher
   * (SA-0MUJBLZC60085DI9).
   */
  deletedBy?: string;
  /**
   * Current assignee (empty/absent = unassigned). A non-empty assignee is a
   * scheduling hold (WL-0MV85WCJJ0087VMP): the item is held by a
   * human/agent and is excluded from downtime dispatch at every tier.
   */
  assignee?: string;
  auditResult?: boolean | null;
  auditedAt?: string | null;
  /** Stored content fingerprint from the audit result (WL-0MUBVH5S0008NQ9K). */
  fingerprint?: string | null;
  /** Current content fingerprint for the item, when the caller can compute it. */
  currentFingerprint?: string | null;
  /**
   * The direct parent's audit state, populated by the worklist render layer
   * when nesting children so derived coverage can be computed at read time
   * (WL-0MUBVH8QG0020H9L). Never persisted.
   */
  parentAudit?: ParentAuditState | null;
  /** Child work items (populated on expand). */
  children?: WorkItem[];
  /** Depth in hierarchy (0 = top-level, 1 = child, etc.). Used by renderer. */
  depth?: number;
  /** Internal: whether the expand icon should show collapsed state. */
  _expanded?: boolean;
  /**
   * Current agent status for the worklist-spawned agent pane associated
   * with this item (merged by the agent tracker). `idle`/`working`/`blocked`
   * render an icon; `done`/`unknown`/absent render none (WL-0MSBQUJQX005RAT9).
   */
  agentState?: AgentState;
  /**
   * True when the row is a synthetic, log-derived "recent dispatch" row
   * rather than a live `wl` work item (WL-0MUL2IY8L009S3PQ). Synthetic rows
   * have no live priority/risk/effort state; the renderer shows `—` for those
   * fields and annotates the row with the dispatch metadata below. A stage
   * (and, for an audit outcome, a fresh audit verdict) IS carried so the row
   * renders the same stage/audit icons as the live views
   * (WL-0MUGLL9SS002E1D2).
   */
  isLogDerived?: boolean;
  /**
   * True only for a log-derived row whose work item is absent from `wl` (so
   * no live fields are available). Such rows render `—` for the absent
   * priority/risk/effort/audit fields (WL-0MUL2IY8L009S3PQ). A log-derived
   * row that was ENRICHED from the live item (`mergeDispatchRow`) leaves this
   * unset, so it renders exactly like any other live row
   * (WL-0MUGLL9SS002E1D2 audit fix).
   */
  isLogOnly?: boolean;
  /**
   * Dispatch kind carried by a log-derived row (plan/intake/audit/
   * risk-effort/implement). Unset on live items (WL-0MUL2IY8L009S3PQ).
   */
  dispatchKind?: string;
  /** Latest pane-close outcome carried by a log-derived row, when present. */
  dispatchOutcome?: string;
  /** ISO-8601 timestamp of the log-derived row's most recent log entry. */
  dispatchedAt?: string;
}

// ── In-process SQLite reads (WL-0MV5CBQ6L005SPAG) ─────────────────────

/**
 * Minimal structural type for the `@worklog/shared` WorklogDatabase surface
 * the default-view auxiliary fetchers use for in-process reads. Kept
 * structural so the heavy native `better-sqlite3` dependency is loaded
 * LAZILY (only when an in-process read is actually attempted) and a load
 * failure degrades to the `wl` spawn path instead of breaking the plugin at
 * import time.
 */
export interface InProcessDb {
  list(query?: {
    status?: string[];
    priority?: string;
    parentId?: string | null;
    rootOnly?: boolean;
    stage?: string;
  }): any[];
  /** Single item by ID (used to enrich dependency edges, matching `wl dep list`). */
  get(id: string): any | null;
  getAllAuditResults(): {
    workItemId: string;
    readyToClose: boolean;
    auditedAt: string;
    fingerprint?: string | null;
  }[];
  getChildCounts(items?: any[]): Map<string, number>;
  /** Outbound dependency edges (`fromId` depends on `toId`) — the `wl dep list` source. */
  listDependencyEdgesFrom(fromId: string): { fromId: string; toId: string }[];
  close(): void;
}

export type InProcessDbCtor = new (
  prefix: string,
  dbPath: string,
  jsonlPath: string,
  silent: boolean,
  autoSync: boolean,
  syncProvider?: () => Promise<void>,
  services?: unknown,
  options?: { readOnly?: boolean },
) => InProcessDb;

/**
 * Open-accounting for the in-process connection (F6 — WL-0MVJV2PX4005JH8D).
 *
 * The large-DB harness and the F6 tests assert that a default-view refresh
 * performs AT MOST ONE in-process SQLite open and that every helper read
 * shares that single connection (no per-helper open). The open step is timed
 * because it runs synchronously on the TUI event loop: the open (pragmas
 * only on an already-initialised store, F6) must stay small enough to never
 * threaten the parent's refresh/event-loop budgets.
 */
export interface InProcessOpenStats {
  /** Connections actually opened (successful constructions only). */
  opens: number;
  /** Total event-loop ms spent constructing those connections. */
  openMs: number;
}

/**
 * Refresh-scoped in-process SQLite read session (WL-0MV6C6SLB005HX7B).
 *
 * A default-view refresh opened a FRESH `WorklogDatabase` per
 * `withInProcessDb` call — twice per refresh (`fetchActionableCount` +
 * `fetchChildrenForItems`). The synchronous open + pragmas + DDL
 * (`initializeSchema`/`initializeFts`) ran on the UI event loop, so a
 * refresh landing mid-typing breached the ≤ 100 ms p95 input-lag budget.
 * A scope instead opens at most ONE connection per refresh and shares it
 * across every reader that consumes it, bounding the blocking cost
 * regardless of how many helpers the refresh fans out to.
 *
 * The no-stale-cache invariant (WL-0MV5CBQ6L005SPAG) is preserved: the
 * connection is created per scope and released by `close()` at the end of
 * the refresh — it is never reused across a refresh boundary, so the store's
 * in-memory query cache can never serve data across a refresh.
 *
 * Fail-open: every read resolves `undefined` when no in-process read is
 * possible (no worklog dir, no SQLite file, `@worklog/shared` unavailable,
 * or an open/read error) so the caller falls back to its `wl` spawn path.
 */
export interface InProcessRefreshScope {
  /**
   * Run an in-process read against the shared connection, opening it lazily
   * on first use. Multiple reads in one refresh share the SAME handle.
   * Resolves `undefined` (fail-open) when no in-process read is possible or
   * the read throws. A close requested while a read is pending is deferred
   * until that read settles, so a read never runs against a closed handle.
   */
  read<T>(fn: (db: InProcessDb) => T): Promise<T | undefined>;
  /**
   * Release the shared connection (idempotent). Call once when the refresh
   * finishes — typically in a `finally`. When a read is still pending
   * (fire-and-forget callers), the release is deferred until the last
   * pending read settles.
   */
  close(): void;
}

// ── Consolidated worklist bundle (WL-0MVI0IT4S0070G78) ────────────────

/**
 * The five subsets returned by `wl worklist --json` (WL-0MVI0HX58009JJRF),
 * already normalized into {@link WorkItem}s.
 */
export interface WorklistBundle {
  critical: WorkItem[];
  reviewQueue: WorkItem[];
  inProgressRoots: WorkItem[];
  blockedRoots: WorkItem[];
  browse: WorkItem[];
}

// ── Critical-child root-ancestor substitution (WL-0MVN4WESM007T4XI) ────

/** Result of the display-layer critical-child substitution. */
export interface RootSubstitution {
  /**
   * The mandatory set to merge: the input list minus critical children, plus
   * every resolved root ancestor (always shown, whatever `browseItemCount`).
   */
  mandatory: WorkItem[];
  /** The substituted roots, used to keep them past the browse window. */
  roots: WorkItem[];
}

// ── Dependency metadata (WL-0MV8EZRDJ001TDA8, WL-0MVBMLY2Z0032CYR) ────

/**
 * A dependency blocker of a work item, as shown in the metadata panel
 * (WL-0MV8EZRDJ001TDA8). Display-only: the id and title are all the
 * `Blocked By` rows need; when the `wl dep list` edge carries a `status`
 * it is passed through so the row can render the blocker's state
 * (icon + text, WL-0MVBMLY2Z0032CYR). The status is optional — an edge
 * without one still renders the ID + title alone.
 */
export interface BlockerRef {
  id: string;
  title: string;
  /** The blocker's status as reported by the `wl dep list` edge (absent when the edge has none). */
  status?: string;
}

/**
 * A dependency target as the in-process dep read yields it — the fields of
 * a `wl dep list --json` edge (id/status) plus the target `stage` the CLI
 * enrichment path pays a `wl show` for (F4 — WL-0MVJV2ORY002MNFF). A
 * missing target maps to status `deleted`, matching the CLI.
 */
export interface DependencyTargetRef {
  id: string;
  /** The target's status (`deleted` when the target no longer exists). */
  status?: string;
  /** The target's stage, when known (the CLI-enrichment `wl show` result). */
  stage?: string;
  /** The target's title (`(missing)` when the target no longer exists). */
  title?: string;
}

// ── Review-queue state (AH-0MUDYTQ55002NUSJ) ──────────────────────────

/**
 * Review-queue state for the footer banner (AH-0MUDYTQ55002NUSJ): the
 * root-only completed/in_review count plus whether at least one of those
 * items still has an OUTSTANDING audit (no stored audit, or a stored audit
 * that is not current per `isAuditFresh`).
 */
export interface ReviewQueueState {
  /** Number of root-level in_review items with status completed. */
  count: number;
  /** True when any of those items lacks a current (fresh) audit. */
  auditsOutstanding: boolean;
}

// ── Work-item claiming ────────────────────────────────────────────────

/**
 * Result of a work-item claim (status → in_progress) attempt.
 */
export interface ClaimResult {
  success: boolean;
  /**
   * True when the claim failed because the item no longer matched the
   * `--if-status`/`--if-stage` guard (another pane won the CAS race). The
   * wl CLI answered correctly — this is NOT a CLI error.
   */
  stale?: boolean;
  error?: string;
}
