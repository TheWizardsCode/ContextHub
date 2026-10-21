/**
 * packages/herdr/src/fetcher.ts — Worklog data fetching via wl CLI
 *
 * Provides typed access to the `wl` command-line interface for fetching
 * work items, filtering by stage, and retrieving item details.
 * All functions return plain data objects and do NOT depend on the
 * Herdr runtime — they can be tested in isolation.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { selectWorkItems } from './smart-selection.js';
import { regroupWorkItems } from './grouping.js';
import { STAGES } from './worklist.js';
import type { Stage } from './worklist.js';
import type { AgentState } from './agent-tracker.js';
import { isActiveBlocker } from './hydrator.js';
import { parseDepListBlockersOutput } from './downtime-worker.js';
import { isAuditFresh, type ParentAuditState } from '@worklog/shared/icons';

// ── Types ────────────────────────────────────────────────────────────

/**
 * Error response from the wl CLI.
 */
export interface WlError {
  success: false;
  initialized?: boolean;
  error?: string;
}

/**
 * Format a wl error into a user-facing message.
 */
export function formatWlError(err: WlError): string {
  if (err.initialized === false) {
    return 'Worklog not initialized. Run "worklog init" first.';
  }
  if (err.error) {
    return `Worklog error: ${err.error}`;
  }
  return 'Unknown worklog error';
}

/**
 * Injectable exec function for testing. Tests can replace this with
 * a mock to avoid calling the real wl CLI. See setExecFileAsync().
 */
let execFileAsync = promisify(execFile);

/**
 * Module-level --worklog-dir override used when the parent process
 * (e.g. herdr) has resolved the worklog root and wants all child wl CLI
 * invocations to target that specific directory without relying on CWD.
 */
let _worklogDir: string | undefined;

/**
 * Set the worklog directory path to pass as --worklog-dir to every wl CLI
 * invocation. The path should point to the .worklog/ subdirectory itself
 * (e.g. /path/to/project/.worklog).
 * Pass undefined to clear the override.
 */
export function setWorklogDir(dir: string | undefined): void {
  _worklogDir = dir;
  // Switching worklog dirs invalidates any in-flight fetch memo (F4): reads
  // racing against the old dir must never be shared with the new one.
  clearFetchMemo();
}

/**
 * Return the current --worklog-dir override (if any). Used by other modules
 * (e.g. auto-sync) so their `wl` invocations target the same worklog.
 */
export function getWorklogDir(): string | undefined {
  return _worklogDir;
}

/**
 * Build the argument vector for a wl CLI invocation, prepending the
 * `--worklog-dir` override when set (it is a global option that must appear
 * BEFORE the subcommand). Callers that invoke wl directly via
 * `getExecFileAsync()` (e.g. the downtime worker's `wl next` and
 * `wl comment add`) use this so their commands resolve against the same
 * worklog root as the worklist — without the override the argument vector is
 * returned unchanged (current behavior preserved).
 *
 * `dirOverride` (the `.worklog/` directory itself, e.g.
 * `/project/.worklog`) wins over the module-level override for THIS call
 * only — the module state is never mutated (see `buildWlArgsForRoot` for the
 * root-accepting convenience form).
 */
export function buildWlArgs(args: string[], dirOverride?: string): string[] {
  const dir = dirOverride ?? _worklogDir;
  if (dir !== undefined) {
    return ['--worklog-dir', dir, ...args];
  }
  return args;
}

/**
 * Build wl args targeting a SPECIFIC worklog root's database — stateless,
 * per-call `--worklog-dir <root>/.worklog` targeting that never mutates the
 * module-level override (WL-0MTQ14W7L003II5A). `root` is the project
 * directory that CONTAINS `.worklog/` (e.g. `/home/user/projects/AI_Hell`),
 * the convention every downtime/coordination caller passes as `cwd`.
 *
 * The downtime leader uses this for every per-entry wl invocation on a
 * coordination offer: the offer's item lives in ITS OWN instance's worklog
 * root, which may differ from the leader pane's resolved root — resolving
 * against the module override instead fired `wl show`/`update` at the wrong
 * database ("Work item not found" → 3 strikes → 60-minute pause).
 */
export function buildWlArgsForRoot(root: string, args: string[]): string[] {
  return ['--worklog-dir', join(root, '.worklog'), ...args];
}

/**
 * Reset the worklog directory override.
 */
export function resetWorklogDir(): void {
  _worklogDir = undefined;
  clearFetchMemo();
}

/**
 * Replace the execFileAsync implementation. Used by tests to inject
 * mock implementations without mocking the child_process module.
 */
export function setExecFileAsync(mock: typeof execFileAsync): void {
  execFileAsync = mock;
}

/**
 * Return the current execFileAsync implementation. Lets other modules
 * (e.g. visibility.ts) share the same injectable exec seam used by tests,
 * so mocks installed via setExecFileAsync() apply to those modules too.
 */
export function getExecFileAsync(): typeof execFileAsync {
  return execFileAsync;
}

/**
 * Reset execFileAsync to the real implementation.
 */
export function resetExecFileAsync(): void {
  execFileAsync = promisify(execFile);
}

// ── Types ─────────────────────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Extract the first complete JSON object from a string that may contain
 * leading/trailing non-JSON text (e.g., log output mixed with JSON).
 */
/**
 * Extract the first complete JSON object from a string that may contain
 * leading/trailing non-JSON text (e.g., log output mixed with JSON).
 * Exported for use by the downtime worker's review-queue gate.
 */
export function extractJson(raw: string): unknown {
  const start = raw.indexOf('{');
  if (start < 0) throw new Error('No JSON object in output');

  const trimmed = raw.trim();
  // Try full parse first
  const lastCloseBrace = trimmed.lastIndexOf('}');
  if (lastCloseBrace > trimmed.lastIndexOf('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through
    }
  }

  // Manual brace counting
  let depth = 0;
  let inString = false;
  for (let i = start; i < raw.length; i += 1) {
    const c = raw[i];
    if (c === '"') {
      let backslashes = 0;
      for (let j = i - 1; j >= start && raw[j] === '\\'; j -= 1) {
        backslashes += 1;
      }
      if (backslashes % 2 === 0) {
        inString = !inString;
      }
    }
    if (!inString) {
      if (c === '{') depth += 1;
      if (c === '}') depth -= 1;
      if (depth === 0) {
        return JSON.parse(raw.slice(start, i + 1));
      }
    }
  }
  throw new Error('Unterminated JSON object in output');
}

/**
 * Normalize a raw work item from the wl API into a consistent WorkItem.
 */
function normalizeItem(raw: any): WorkItem {
  return {
    id: String(raw?.id ?? ''),
    title: String(raw?.title ?? 'Untitled'),
    status: String(raw?.status ?? 'unknown'),
    priority: raw?.priority ? String(raw.priority) : undefined,
    stage: raw?.stage ? String(raw.stage) : undefined,
    parentId: raw?.parentId != null ? String(raw.parentId) : undefined,
    risk: raw?.risk ? String(raw.risk) : undefined,
    effort: raw?.effort ? String(raw.effort) : undefined,
    description: raw?.description ? String(raw.description) : undefined,
    tags: Array.isArray(raw?.tags) ? raw.tags.map(String) : undefined,
    issueType: raw?.issueType ? String(raw.issueType) : undefined,
    githubIssueNumber: raw?.githubIssueNumber ? String(raw.githubIssueNumber) : undefined,
    childCount: raw?.childCount !== undefined ? Number(raw.childCount) : undefined,
    createdAt: raw?.createdAt ? String(raw.createdAt) : undefined,
    updatedAt: raw?.updatedAt ? String(raw.updatedAt) : undefined,
    group: raw?.group !== undefined ? Number(raw.group) : undefined,
    groupLabel: raw?.groupLabel ? String(raw.groupLabel) : undefined,
    needsProducerReview: raw?.needsProducerReview !== undefined ? Boolean(raw.needsProducerReview) : undefined,
    deletedBy: raw?.deletedBy ? String(raw.deletedBy) : undefined,
    assignee: raw?.assignee ? String(raw.assignee) : undefined,
    auditResult: raw?.auditResult !== undefined ? raw.auditResult : null,
    auditedAt: raw?.auditedAt == null ? (raw?.auditedAt as null | undefined) : String(raw.auditedAt),
    fingerprint: raw?.fingerprint == null ? (raw?.fingerprint as null | undefined) : String(raw.fingerprint),
    currentFingerprint: raw?.currentFingerprint == null ? (raw?.currentFingerprint as null | undefined) : String(raw.currentFingerprint),
  };
}

/**
 * Extract work items from a wl CLI response, handling different response
 * shapes (direct array, { workItems: [...] }, { results: [...] }).
 */
/**
 * Extract work items from a wl CLI response, handling different response
 * shapes (direct array, { workItems: [...] }, { results: [...] }).
 * Exported for use by the downtime worker's review-queue gate.
 */
export function extractItems(payload: unknown): WorkItem[] {
  if (Array.isArray(payload)) {
    return payload.map(normalizeItem);
  }

  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;

    // Check `results` FIRST — when wl next is called with -n (count) the
    // response includes both an empty `workItems: []` AND a populated
    // `results` array. Order matters here.
    if (Array.isArray(obj.results) && obj.results.length > 0) {
      return (obj.results as any[])
        .map((entry: any) => {
          const item = entry?.workItem;
          if (!item) return null;
          if (entry.group !== undefined) item.group = entry.group;
          if (entry.groupLabel !== undefined) item.groupLabel = entry.groupLabel;
          return normalizeItem(item);
        })
        .filter(Boolean) as WorkItem[];
    }

    // Check `workItems` next — from wl list
    if (Array.isArray(obj.workItems) && obj.workItems.length > 0) {
      return (obj.workItems as any[]).map(normalizeItem);
    }

    // Single item under { workItem: {...} } — from wl next (no -n) or wl show
    if (obj && typeof obj === 'object' && obj.workItem && typeof obj.workItem === 'object') {
      return [normalizeItem(obj.workItem)];
    }

    // Direct single item: { id: "...", title: "..." }
    if (obj.id) {
      return [normalizeItem(obj)];
    }

    // Fallback: results might be empty but still present
    if (Array.isArray(obj.results)) {
      return [];
    }
    if (Array.isArray(obj.workItems)) {
      return [];
    }
  }

  return [];
}

// ── CLI execution ─────────────────────────────────────────────────────

/**
 * Default timeout (in milliseconds) for all wl CLI spawns in the refresh/
 * sync fetch path. 60_000 ms — matches the auto-sync safety timeout and the
 * Pi TUI extension convention (auto-sync.ts:227). A hung wl spawn (e.g.
 * waiting on a lock during a long `wl sync`) will reject after this period
 * instead of blocking the `refreshInFlight` guard forever (WL-0MSJNJXX2001NMHS).
 */
export const DEFAULT_WL_TIMEOUT_MS = 60_000;

const CLI_BINARIES = ['wl', 'worklog'];

// ── In-process fetch memoization (F4 — WL-0MSGAEPOJ002824S) ───────────

/**
 * Read commands whose results may be deduplicated in-process. Matches the
 * wl CLI read-cache command set (F2). Writes (update/create/sync/…) are
 * NEVER memoized — a deduped write would drop a mutation.
 */
const MEMOIZABLE_COMMANDS = new Set(['list', 'next', 'worklist', 'show', 'search', 'status']);

/** Cap on in-flight memo entries (bounded: entries are removed on settle, so
 * this caps only concurrent racing fetches, which is the dedupe window). */
const MEMO_MAX_ENTRIES = 64;

/**
 * In-flight promise memo: key → shared promise for an identical read that is
 * currently executing in this process. Racing identical fetches (overlapping
 * refresh ticks, duplicate pane queries) share the SAME promise, so `wl` is
 * spawned once instead of N times. Entries are deleted when the promise
 * settles — the memo never serves a settled result, so reads that begin
 * after a DB write always spawn fresh (never stale across writes).
 */
const inflightFetchMemo = new Map<string, Promise<string>>();

function fetchMemoKey(args: string[], includeJson: boolean, dirOverride?: string): string {
  // Include the effective worklog-dir override (per-call or module-level) so
  // a dir change never cross-contaminates racing reads across roots.
  return `${dirOverride ?? _worklogDir ?? ''}\u0000${includeJson ? '1' : '0'}\u0000${args.join('\u0000')}`;
}

/**
 * Drop all in-flight fetch memo entries (after a write or worklog-dir
 * change). Reads that started before the write keep their own result; reads
 * issued after the write will spawn fresh instead of sharing a pre-write
 * in-flight read.
 */
export function clearFetchMemo(): void {
  inflightFetchMemo.clear();
  lastWorklistBundle = null;
  inflightWorklistBundle = null;
}

/**
 * Test helper: current number of in-flight memo entries. Used to verify the
 * memo stays bounded under many concurrent distinct fetches.
 */
export function _fetchMemoSize(): number {
  return inflightFetchMemo.size;
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
interface InProcessDb {
  list(query?: {
    status?: string[];
    priority?: string;
    parentId?: string | null;
    rootOnly?: boolean;
    stage?: string;
  }): any[];
  getAllAuditResults(): {
    workItemId: string;
    readyToClose: boolean;
    auditedAt: string;
    fingerprint?: string | null;
  }[];
  getChildCounts(items?: any[]): Map<string, number>;
  close(): void;
}

type InProcessDbCtor = new (
  prefix: string,
  dbPath: string,
  jsonlPath: string,
  silent: boolean,
  autoSync: boolean,
) => InProcessDb;

let _dbCtorPromise: Promise<InProcessDbCtor | null> | null = null;

/**
 * Lazily resolve the `@worklog/shared` WorklogDatabase constructor. The
 * dynamic import keeps the native `better-sqlite3` dependency out of the
 * plugin's import graph until a refresh actually reads in-process. Any load
 * failure (native module unavailable, incompatible runtime) resolves `null`
 * and the caller falls back to spawning `wl` (fail-open).
 */
function loadInProcessDbCtor(): Promise<InProcessDbCtor | null> {
  if (_dbCtorPromise === null) {
    _dbCtorPromise = import('@worklog/shared')
      .then((mod) => ((mod as { WorklogDatabase?: InProcessDbCtor }).WorklogDatabase) ?? null)
      .catch(() => null);
  }
  return _dbCtorPromise;
}

/**
 * Run `fn` against a FRESH in-process WorklogDatabase for the current worklog
 * dir, or resolve `undefined` when no in-process read is possible (no dir
 * resolved, no SQLite file on disk, `@worklog/shared` unavailable, or the
 * read throws).
 *
 * The handle is opened per call and closed in `finally`, so a read always
 * reflects the latest committed state: the store's in-memory query cache can
 * never serve data across a refresh boundary. This is the "no stale cache
 * served or left behind" invariant for the default-view fast path
 * (WL-0MV5CBQ6L005SPAG). Callers MUST fall back to the `wl` spawn path on
 * `undefined`.
 */
async function withInProcessDb<T>(fn: (db: InProcessDb) => T): Promise<T | undefined> {
  const dir = _worklogDir;
  if (!dir) return undefined;
  const dbPath = join(dir, 'worklog.db');
  if (!existsSync(dbPath)) return undefined;

  const Ctor = await loadInProcessDbCtor();
  if (!Ctor) return undefined;

  let db: InProcessDb | null = null;
  try {
    db = new Ctor('WI', dbPath, join(dir, 'worklog-data.jsonl'), true, false);
    return fn(db);
  } catch {
    // Fail-open: any open/read failure degrades to the wl spawn path.
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore: closing a broken handle must not mask the result.
    }
  }
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

/**
 * Create an {@link InProcessRefreshScope} (WL-0MV6C6SLB005HX7B). The
 * connection is opened lazily on the scope's first read and closed by
 * {@link InProcessRefreshScope.close}; the lazy `@worklog/shared` import is
 * the same module-level `loadInProcessDbCtor` the per-call fast path uses,
 * so no new dependency or import-time cost is introduced.
 */
export function createInProcessRefreshScope(): InProcessRefreshScope {
  let db: InProcessDb | null = null;
  let ctorPromise: Promise<InProcessDbCtor | null> | undefined;
  let pendingReads = 0;
  let closeRequested = false;

  const release = (): void => {
    const handle = db;
    db = null;
    ctorPromise = undefined;
    pendingReads = 0;
    try {
      handle?.close();
    } catch {
      // ignore: closing a broken handle must not mask a read result.
    }
  };

  return {
    async read<T>(fn: (db: InProcessDb) => T): Promise<T | undefined> {
      const dir = _worklogDir;
      if (!dir) return undefined;
      const dbPath = join(dir, 'worklog.db');
      if (!existsSync(dbPath)) return undefined;
      if (ctorPromise === undefined) ctorPromise = loadInProcessDbCtor();

      // Hold a read slot BEFORE any await: a close() requested while this
      // read is pending defers the release until the read settles, so the
      // read always runs against an open handle (doRefresh's actionable-count
      // read is fire-and-forget and can outlive the synchronous close call).
      pendingReads += 1;
      try {
        const Ctor = await ctorPromise;
        if (!Ctor) return undefined;
        if (!db) {
          try {
            db = new Ctor('WI', dbPath, join(dir, 'worklog-data.jsonl'), true, false);
          } catch {
            // Fail-open: an open failure degrades to the wl spawn path.
            return undefined;
          }
        }
        try {
          return fn(db);
        } catch {
          // Fail-open: any read failure degrades to the wl spawn path.
          return undefined;
        }
      } finally {
        pendingReads -= 1;
        if (closeRequested && pendingReads === 0) release();
      }
    },
    close(): void {
      closeRequested = true;
      if (pendingReads === 0) release();
    },
  };
}

/**
 * Apply the audit enrichment `wl list --json` adds (auditResult, auditedAt and
 * the stored fingerprint) to in-process items. `currentFingerprint` is
 * deliberately NOT set: deriving it requires the canonical git-based
 * fingerprint computation that only the `wl` CLI performs, and the shared
 * `isAuditFresh` predicate fails safe to the time gate when it is absent.
 * Callers therefore only use this enrichment for items WITHOUT a stored
 * fingerprint (an audited item falls back to spawning `wl` so its exact
 * fingerprint freshness is preserved).
 */
function enrichInProcessItems(db: InProcessDb, items: any[]): WorkItem[] {
  const auditMap = new Map(db.getAllAuditResults().map((audit) => [audit.workItemId, audit]));
  return items.map((raw) => {
    const item = normalizeItem(raw);
    const audit = auditMap.get(item.id);
    if (!audit) return item;
    return {
      ...item,
      auditResult: audit.readyToClose,
      auditedAt: audit.auditedAt ?? null,
      fingerprint: audit.fingerprint ?? null,
    };
  });
}

/**
 * True when a `wl` spawn error came from the bounded execFile timeout (the
 * child was killed because it hung) rather than from the CLI rejecting the
 * invocation. A hung `wl` must not trigger the consolidated-read fail-open
 * path: retrying with the per-subset spawns would double the hang instead of
 * surfacing it (WL-0MSJNJXX2001NMHS).
 */
function isWlTimeoutError(error: unknown): boolean {
  const e = error as { killed?: boolean; signal?: string; code?: string; message?: string } | null;
  if (!e) return false;
  if (e.killed === true) return true;
  if (e.signal === 'SIGTERM' || e.signal === 'SIGKILL') return true;
  if (e.code === 'ETIMEDOUT') return true;
  return /timed? ?out/i.test(e.message ?? '');
}

async function runWlInner(
  args: string[],
  includeJson: boolean,
  timeoutMs?: number,
  dirOverride?: string,
): Promise<string> {
  let lastError: unknown;

  for (const binary of CLI_BINARIES) {
    try {
      let fullArgs: string[];
      if (includeJson) {
        fullArgs = [...args, '--json'];
      } else {
        fullArgs = args;
      }

      // Prepend --worklog-dir when set (per-call override first, then the
      // module override — global option before the subcommand).
      fullArgs = buildWlArgs(fullArgs, dirOverride);

      // Bounded timeout: use the caller's override if supplied, otherwise
      // apply DEFAULT_WL_TIMEOUT_MS so a hung wl process cannot block the
      // refreshInFlight guard forever (WL-0MSJNJXX2001NMHS).
      const timeout = timeoutMs ?? DEFAULT_WL_TIMEOUT_MS;

      const result = await execFileAsync(binary, fullArgs, {
        maxBuffer: 1024 * 1024 * 5,
        timeout,
      });
      return result.stdout;
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        lastError = error;
        continue;
      }
      const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
      const stdout = typeof error?.stdout === 'string' ? error.stdout.trim() : '';
      const message = stderr || stdout || error?.message || String(error);

      // Re-throw with a clean message, preserving the timeout classification
      // so callers can distinguish "hung wl" from "wl rejected the command".
      const wrapped = new Error(message) as Error & { wlTimeout?: boolean };
      if (isWlTimeoutError(error)) wrapped.wlTimeout = true;
      throw wrapped;
    }
  }

  throw new Error(`wl CLI not found: ${String(lastError)}`);
}

async function runWl(
  args: string[],
  includeJson = true,
  timeoutMs?: number,
  dirOverride?: string,
): Promise<string> {
  const command = args[0];

  // Writes must never be deduplicated or share pre-write read results: drop
  // any in-flight read memo so a read issued after this write spawns fresh.
  if (!MEMOIZABLE_COMMANDS.has(command)) {
    if (inflightFetchMemo.size > 0) inflightFetchMemo.clear();
    // A write also invalidates the review-queue snapshot derived from a
    // previously fetched worklist bundle (WL-0MVI0IT4S0070G78).
    lastWorklistBundle = null;
    inflightWorklistBundle = null;
    return runWlInner(args, includeJson, timeoutMs, dirOverride);
  }

  // Read: dedupe concurrent identical fetches within this process (F4).
  const key = fetchMemoKey(args, includeJson, dirOverride);
  const inFlight = inflightFetchMemo.get(key);
  if (inFlight) {
    return inFlight;
  }

  const promise = runWlInner(args, includeJson, timeoutMs, dirOverride).finally(() => {
    // Remove on settle: the memo only dedupes CONCURRENT fetches, so a
    // later identical read always spawns fresh (never stale across writes).
    if (inflightFetchMemo.get(key) === promise) {
      inflightFetchMemo.delete(key);
    }
  });

  // Bound: evict the oldest entry when over the cap (Map preserves insertion
  // order, so the first key is the oldest).
  if (inflightFetchMemo.size >= MEMO_MAX_ENTRIES) {
    const oldest = inflightFetchMemo.keys().next().value;
    if (oldest !== undefined) {
      inflightFetchMemo.delete(oldest);
    }
  }
  inflightFetchMemo.set(key, promise);
  return promise;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Check whether the wl CLI is available on PATH.
 * Uses DEFAULT_WL_TIMEOUT_MS so a hung --version probe cannot block startup.
 */
export async function checkWlAvailable(): Promise<boolean> {
  for (const binary of CLI_BINARIES) {
    try {
      await execFileAsync(binary, ['--version'], { maxBuffer: 1024, timeout: DEFAULT_WL_TIMEOUT_MS });
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * Merge work item arrays, deduplicating by item ID (first occurrence wins).
 */
function mergeUniqueById(...arrays: WorkItem[][]): WorkItem[] {
  const seen = new Set<string>();
  const merged: WorkItem[] = [];
  for (const item of arrays.flat()) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      merged.push(item);
    }
  }
  return merged;
}

// ── Consolidated worklist bundle (WL-0MVI0IT4S0070G78) ────────────────
//
// One `wl worklist --json` read replaces the five per-subset spawns a
// default-view refresh used to issue (four mandatory `wl list` queries + the
// `wl next` browse feed). See `docs/dev/herdr-event-driven-refresh.md`
// (§ "Cold-refresh cost") for the design rationale and the measured CPU
// before/after; the command's payload contract is documented in `CLI.md`.

/**
 * The five subsets returned by `wl worklist --json` (WL-0MVI0HX58009JJRF),
 * already normalized into {@link WorkItem}s.
 */
interface WorklistBundle {
  critical: WorkItem[];
  reviewQueue: WorkItem[];
  inProgressRoots: WorkItem[];
  blockedRoots: WorkItem[];
  browse: WorkItem[];
}

/**
 * How long a fetched bundle may satisfy {@link fetchReviewQueueState}. The
 * banner state is refreshed on every tick, so a short window is invisible to
 * the operator while guaranteeing the concurrent review-state read in a
 * refresh derives from the SAME read instead of spawning a second `wl`.
 * Cleared immediately on any write and on a worklog-dir change.
 */
const WORKLIST_BUNDLE_SNAPSHOT_TTL_MS = 10_000;

/** Most recent successful bundle read, used only for review-queue state. */
let lastWorklistBundle: { dirKey: string; at: number; bundle: WorklistBundle } | null = null;

/**
 * Bundle read currently in flight for the current worklog dir. The
 * review-queue state read starts concurrently with the item fetch, so it
 * awaits this instead of spawning a second `wl` for the same subset.
 */
let inflightWorklistBundle: { dirKey: string; promise: Promise<WorklistBundle> } | null = null;

/** Identity of the worklog dir a bundle was read from. */
function worklogDirKey(): string {
  return _worklogDir ?? '';
}

/**
 * Parse a `wl worklist --json` payload, failing loudly (so the caller can
 * fail open) when the shape is not the documented one: a missing or
 * non-array subset means the `wl` on PATH is older than the consolidated
 * command and the per-subset spawn path must take over.
 */
function parseWorklistBundle(payload: unknown): WorklistBundle {
  const subsets = (payload as { subsets?: Record<string, unknown> } | null)?.subsets;
  if (!subsets || typeof subsets !== 'object') {
    throw new Error('wl worklist payload has no "subsets" object');
  }
  const listSubset = (key: string): WorkItem[] => {
    const value = subsets[key];
    if (!Array.isArray(value)) {
      throw new Error(`wl worklist payload is missing the "${key}" subset`);
    }
    return extractItems(value);
  };
  const browseRaw = subsets.browse;
  if (!Array.isArray(browseRaw)) {
    throw new Error('wl worklist payload is missing the "browse" subset');
  }
  return {
    critical: listSubset('critical'),
    reviewQueue: listSubset('reviewQueue'),
    inProgressRoots: listSubset('inProgressRoots'),
    blockedRoots: listSubset('blockedRoots'),
    // Browse entries are `{ workItem, reason, group?, groupLabel? }` — the
    // same shape `wl next -n <count> --json` emits, so `extractItems` applies
    // the identical normalization/group propagation.
    browse: browseRaw.length > 0 ? extractItems({ results: browseRaw }) : [],
  };
}

/**
 * Fetch every subset the default view needs in ONE `wl worklist` read.
 *
 * `count` bounds only the browse feed (the mandatory subsets are unbounded by
 * it), mirroring `wl next -n <count> --include-in-progress --include-blocked`
 * plus the four mandatory `wl list` queries. The command is a pure read: it
 * never re-sorts, so this adds no write byproduct and the result is cacheable
 * by the CLI read cache (WL-0MVI0IS6Y0028KTO).
 */
async function fetchWorklistBundle(count?: number, timeoutMs?: number): Promise<WorklistBundle> {
  const args = ['worklist'];
  if (count !== undefined) {
    args.push('-n', String(count));
  }
  const dirKey = worklogDirKey();
  const promise = runWl(args, true, timeoutMs).then((output) => {
    const bundle = parseWorklistBundle(extractJson(output));
    lastWorklistBundle = { dirKey, at: Date.now(), bundle };
    return bundle;
  });
  inflightWorklistBundle = { dirKey, promise };
  try {
    return await promise;
  } finally {
    if (inflightWorklistBundle?.promise === promise) {
      inflightWorklistBundle = null;
    }
  }
}

/**
 * The bundle read currently in flight for this worklog dir, if any. The
 * review-queue state read awaits it so a refresh needs only ONE `wl` spawn.
 */
function pendingWorklistBundle(): Promise<WorklistBundle> | null {
  const inflight = inflightWorklistBundle;
  if (inflight === null) return null;
  if (inflight.dirKey !== worklogDirKey()) return null;
  return inflight.promise;
}

/**
 * Assemble the default worklist from a consolidated bundle, applying the same
 * merge/enrich/select/regroup pipeline as the per-subset path:
 *
 *  - mandatory subsets (critical, review queue, in-progress roots, blocked
 *    roots) are always included, whatever the browse window;
 *  - items shared with a mandatory subset take the richer `wl list`-style
 *    audit fields (`auditResult`, `auditedAt`, `fingerprint`,
 *    `currentFingerprint`) so the audit-bucket sort classifies them exactly as
 *    `wl list` does (WL-0MUWDW0N6003KF6G);
 *  - the count limits only the remaining "other" items, and the final set is
 *    regrouped so no duplicate section headings render (WL-0MSAK8YLB0025EGW).
 */
function assembleDefaultWorklist(bundle: WorklistBundle, count?: number): WorkItem[] {
  const items = bundle.browse;
  if (count === undefined) {
    // Count-less callers get the base feed unchanged (historical behaviour).
    return items;
  }

  const mandatory = mergeUniqueById(
    bundle.critical,
    bundle.reviewQueue,
    bundle.inProgressRoots,
    bundle.blockedRoots,
  );
  const mandatoryById = new Map(mandatory.map((item) => [item.id, item]));
  const enrichedItems = items.map((item) => {
    const rich = mandatoryById.get(item.id);
    if (!rich) return item;
    return {
      ...item,
      auditResult: rich.auditResult,
      auditedAt: rich.auditedAt,
      fingerprint: rich.fingerprint,
      currentFingerprint: rich.currentFingerprint,
    };
  });
  const merged = mergeUniqueById(enrichedItems, mandatory);
  return regroupWorkItems(selectWorkItems(merged, count));
}

/**
 * Derive the review-queue state from a bundle's `reviewQueue` subset: the
 * root-only in_review items with status `completed`, plus whether any of them
 * still lacks a current audit. Kept identical to the standalone-query
 * derivation so the banner is unchanged.
 */
function reviewQueueStateFromItems(items: WorkItem[]): ReviewQueueState {
  const completed = items.filter((item) => item.status === 'completed');
  const auditsOutstanding = completed.some((item) =>
    !isAuditFresh(item.auditedAt, item.updatedAt, item.fingerprint, item.currentFingerprint),
  );
  return { count: completed.length, auditsOutstanding };
}

/**
 * Review-queue state from a bundle read earlier in this refresh (same worklog
 * dir, within {@link WORKLIST_BUNDLE_SNAPSHOT_TTL_MS}), or `undefined` when
 * there is none — the caller then runs the standalone query.
 */
function snapshotReviewQueueState(): ReviewQueueState | undefined {
  const snapshot = lastWorklistBundle;
  if (snapshot === null) return undefined;
  if (snapshot.dirKey !== worklogDirKey()) return undefined;
  if (Date.now() - snapshot.at > WORKLIST_BUNDLE_SNAPSHOT_TTL_MS) return undefined;
  return reviewQueueStateFromItems(snapshot.bundle.reviewQueue);
}

/**
 * The exact `wl list` invocation backing the root-only in_review review
 * queue. Shared so {@link fetchMandatorySubsets} and
 * {@link fetchReviewQueueState} build an IDENTICAL argument vector — the
 * in-flight fetch memo then deduplicates the two concurrent calls into a
 * single `wl` spawn per refresh (WL-0MV5CBQ6L005SPAG). Changing one query
 * without the other silently reintroduces the duplicate spawn.
 *
 * The status filter spans BOTH `completed` (awaiting producer review) and
 * `in-progress` (being re-worked after review feedback, WL-0MV6JGVPH009YDXB)
 * — the mandatory review set must show both, matching the smart-selection
 * predicate in selectWorkItems.
 */
function reviewQueueArgs(): string[] {
  return ['list', '--status', 'completed,in-progress', '--stage', 'in_review', '--root-only'];
}

/**
 * Fetch the mandatory subsets that must ALWAYS be shown in the default
 * worklist: all critical items, all in_review items (the producer-review
 * queue — status completed awaiting review or in-progress being re-worked
 * after review feedback, WL-0MV6JGVPH009YDXB), all actively-worked
 * in-progress root items (WL-0MV6KV22S004NYIU) and all status=blocked root
 * items (WL-0MV71WBHB007D8ZE).
 *
 * These are fetched explicitly via `wl list` because `wl next -n N` hard-caps
 * at 32 items — even `-n 500` returns only 32, so a large superset cannot
 * capture all critical/in_review/in-progress/blocked items. Runs the four
 * queries in parallel to mitigate refresh latency.
 */
async function fetchMandatorySubsets(): Promise<WorkItem[]> {
  // Critical items: fetch ALL critical items across all statuses (open,
  // in-progress, blocked, completed) regardless of root/child status. This
  // ensures child critical items that block releases (e.g., untriaged
  // test-failures) are always visible in the worklist — they are not filtered
  // out by the rootOnly gate in selectWorkItems (WL-0MS964SIA0057ABR).
  //
  // We query all statuses because `wl list --priority critical` only returns
  // `open` and `completed` items by default, missing `in-progress` critical
  // items that the ship critical-items gate detects.
  //
  // Review items: root-only is appropriate because the in_review queue
  // is about producer review of parent items; child items are handled by
  // the parent's review lifecycle. The query spans status completed AND
  // in-progress (re-worked items stay in_review, WL-0MV6JGVPH009YDXB) so
  // re-worked reviews are never dropped from the mandatory set.
  //
  // Actively-worked items: root-only, status in-progress at ANY stage. These
  // can otherwise fall outside the `wl next` top-N window (the base feed is
  // capped at 32, and a low-priority in-progress item is outranked by
  // in-review (+600) and audit-not-ready (+3500) boosts), hiding the
  // producer's real-time "what am I working on" signal
  // (WL-0MV6KV22S004NYIU). The query is NOT merged into reviewQueueArgs()
  // because it is a distinct concern with a different stage scope — adding it
  // there would break the review-queue single-spawn dedup invariant.
  //
  // Blocked items: root-only, status=blocked at ANY stage (root-only keeps
  // them at the same top-level visibility as the other mandatory subsets).
  // `wl next` penalises blocked items by -10000, so a release-blocking
  // blocked in_review item ranks far below the browseItemCount window and is
  // never returned by the base feed — the explicit subset fetch guarantees it
  // is still shown (WL-0MV71WBHB007D8ZE). The query is NOT merged into
  // reviewQueueArgs() (the review queue is stage-scoped; blocked spans stages).
  const [criticalOutput, reviewOutput, activeOutput, blockedOutput] = await Promise.all([
    runWl(['list', '--priority', 'critical', '--status', 'open,in-progress,blocked,completed']),
    runWl(reviewQueueArgs()),
    runWl(['list', '--status', 'in-progress', '--root-only']),
    runWl(['list', '--status', 'blocked', '--root-only']),
  ]);
  const criticalItems = extractItems(extractJson(criticalOutput));
  const reviewItems = extractItems(extractJson(reviewOutput));
  const activeItems = extractItems(extractJson(activeOutput));
  const blockedItems = extractItems(extractJson(blockedOutput));
  return mergeUniqueById(criticalItems, reviewItems, activeItems, blockedItems);
}

/**
 * Fetch the next available work items (via `wl next`).
 *
 * Dependency-blocked items are SHOWN in the selection list: the query passes
 * `--include-blocked` so `wl next`'s default exclusions do not hide blocked
 * backlog work (WL-0MV6TFX0600145M2). Blocked items still rank low (the
 * shared scorer applies a heavy blocked penalty), so they surface at the
 * bottom of the list rather than displacing actionable work.
 *
 * When a count is given, smart selection is applied: all critical items, all
 * in_review review-queue items, all actively-worked in-progress items and all
 * status=blocked root items are always included (regardless of count,
 * WL-0MV6KV22S004NYIU / WL-0MV71WBHB007D8ZE) and the count limits only the
 * remaining "other" items. The mandatory subsets are merged from explicit
 * `wl list` queries (see fetchMandatorySubsets), so a blocked item that ranks
 * below the `-n` window is still shown.
 */
export async function fetchNextItems(count?: number): Promise<WorkItem[]> {
  // ── Consolidated read (WL-0MVI0IT4S0070G78) ───────────────────────
  // One `wl worklist` spawn returns the browse feed AND the four mandatory
  // subsets, replacing five spawns per refresh tick. Any failure (older `wl`
  // without the command, non-zero exit, malformed payload, missing subset)
  // falls through to the per-subset path below with unchanged behaviour.
  try {
    // A count-less call must mirror `wl next`'s default window (1 item).
    const bundle = await fetchWorklistBundle(count === undefined ? 1 : count);
    return assembleDefaultWorklist(bundle, count);
  } catch (error) {
    // A hung `wl` is not "unavailable": propagating the timeout keeps the
    // refresh latency bounded instead of paying the timeout again per subset.
    if ((error as { wlTimeout?: boolean } | null)?.wlTimeout === true) {
      throw error;
    }
    // Fail-open: fall back to today's per-subset spawn path.
  }

  const args = ['next'];
  if (count !== undefined) {
    args.push('-n', String(count));
  }
  args.push('--include-in-progress');
  // Show dependency-blocked items in the Herdr selection list. `wl next`
  // excludes them by default (shared filterCandidates, unless includeBlocked);
  // without this flag blocked backlog work silently disappears from the
  // worklist (WL-0MV6TFX0600145M2). The base feed includes them within its
  // `-n` window; the status=blocked mandatory subset (see
  // fetchMandatorySubsets) additionally guarantees a low-ranked blocked item
  // is never cut (WL-0MV71WBHB007D8ZE). The implement-tier candidate lookup
  // (getNextImplementCandidate) deliberately keeps the default exclusion.
  args.push('--include-blocked');

  // Run the base `wl next` selection and the mandatory subsets CONCURRENTLY:
  // they are independent reads, and overlapping them removes one full `wl`
  // startup from the critical path of a cold refresh (WL-0MV5CBQ6L005SPAG).
  // The mandatory subsets are only needed when a count window is applied;
  // the count-less path returns the base selection unchanged.
  const needMandatory = count !== undefined;
  const mandatoryPromise: Promise<WorkItem[]> = needMandatory
    ? fetchMandatorySubsets()
    : Promise.resolve([] as WorkItem[]);
  const [output, mandatory] = await Promise.all([runWl(args), mandatoryPromise]);
  const payload = extractJson(output);
  const items = extractItems(payload);
  if (count === undefined) {
    return items;
  }

  // Smart selection: merge the mandatory subsets with the regular wl next
  // results (deduplicated by ID), then always show the mandatory set and
  // limit only the "other" items to fill the remaining count slots.
  //
  // Audit-metadata merge (WL-0MUWDW0N6003KF6G): `wl next` does not emit the
  // audit content fingerprints (`fingerprint`/`currentFingerprint`) that
  // `wl list` does. Deduplication below keeps the FIRST occurrence, so without
  // this enrichment the default worklist would silently drop the fingerprint
  // metadata for any item also present in a mandatory `wl list` subset — the
  // in_review 6-bucket sort then degrades to the timestamp gate only, which
  // can rank a fingerprint-fresh (but time-stale) item into the wrong bucket
  // and reorder it ahead of a higher-priority item. Prefer the richer
  // `wl list` representation for audit fields so the default worklist and the
  // stage-filtered view (`fetchItemsByStage`) classify buckets identically.
  const mandatoryById = new Map(mandatory.map((item) => [item.id, item]));
  const enrichedItems = items.map((item) => {
    const rich = mandatoryById.get(item.id);
    if (!rich) return item;
    return {
      ...item,
      auditResult: rich.auditResult,
      auditedAt: rich.auditedAt,
      fingerprint: rich.fingerprint,
      currentFingerprint: rich.currentFingerprint,
    };
  });
  const merged = mergeUniqueById(enrichedItems, mandatory);
  const selected = selectWorkItems(merged, count);
  // Regroup the final selected set so every displayed item (mandatory wl
  // list items included) receives a correct group assignment and no
  // duplicate section headings render (WL-0MSAK8YLB0025EGW).
  return regroupWorkItems(selected);
}

/**
 * Status set used per stage by the stage-filtered worklist fetch.
 *
 * Most stages show only open items (`status=open`) — the "every open item
 * in the stage" rule from WL-0MSDT8X1V003206G. The in_review stage is the
 * exception (WL-0MSKCRX730052IIW): per the project workflow, advancing an
 * item to in_review sets its status to `completed` (or leaves it
 * `in-progress` while it is being re-worked after review feedback), so
 * restricting to `status=open` would hide the entire review queue. `open`
 * is included for robustness (no in_review item carries it today).
 * `blocked` is also included (WL-0MV70XY6D008013C): the release gate
 * queries `wl list --stage in_review` with NO status filter, so a
 * status=blocked item in the in_review stage blocks the release; the
 * review filter must show it or the selection list and the release gate
 * disagree about what is in the review queue.
 *
 * plan_complete and intake_complete are also exceptions (WL-0MUIB7D30009KG00):
 * after WL-0MTOHS5B4001Y9FX removed the in_progress stage, actively-worked
 * items retain their pipeline stage (`plan_complete`/`intake_complete`) and
 * only flip `status` to `in-progress`. Excluding `in-progress` from these
 * stages would make actively-worked items invisible in their corresponding
 * stage-filtered worklists.
 */
const STAGE_STATUS: Record<string, string> = {
  in_review: 'completed,in-progress,open,blocked',
  plan_complete: 'open,in-progress',
  intake_complete: 'open,in-progress',
};

/**
 * Fetch work items filtered by stage (via `wl list`).
 *
 * Guards against invalid/unknown stages: returns an empty list without
 * issuing a CLI call when the requested stage is not in the canonical
 * `STAGES` list (WL-0MUY1CRS7001UTQJ). This prevents misleading empty
 * worklists from being populated for removed stages such as `in_progress`
 * and `completed`.
 *
 * Status per valid stage:
 * - `in_review` (WL-0MSKCRX730052IIW): `completed`, `in-progress`, `open`,
 *   `blocked` — in_review items carry `completed`/`in-progress` status per
 *   the project workflow; `blocked` is included (WL-0MV70XY6D008013C) so the
 *   review filter matches the release gate's unfiltered `wl list --stage
 *   in_review`, which treats a status=blocked in_review item as
 *   release-blocking.
 * - `plan_complete` / `intake_complete` (WL-0MUIB7D30009KG00): `open`,
 *   `in-progress` — actively-worked items retain their pipeline stage and
 *   flip `status` to `in-progress` (WL-0MTOHS5B4001Y9FX removed the
 *   in_progress stage).
 * - `idea` / `done`: `open` only — items with status `blocked`, `in-progress`,
 *   or `completed` are excluded even when their stage matches.
 *
 * Root-only (WL-0MS964SIA0057ABR): stage-filtered top-level lists hide
 * child items; children remain reachable via expand (wl list --parent).
 * Results are regrouped priority-first (WL-0MSOPHLD1000EWNN): priority
 * bucket sections, then stage, then id — same ordering as the default
 * worklist. Within a single stage view the stage tie-break is a no-op, so
 * priority buckets + id tie-break apply.
 */
export async function fetchItemsByStage(stage: string): Promise<WorkItem[]> {
  if (!STAGES.includes(stage as Stage)) {
    return [];
  }
  const status = STAGE_STATUS[stage] ?? 'open';
  const output = await runWl(['list', '--status', status, '--stage', stage, '--root-only']);
  const payload = extractJson(output);
  return regroupWorkItems(extractItems(payload));
}

/**
 * Fetch work items filtered by priority (via `wl list`).
 *
 * Mirrors the stage-filter fetch semantics (WL-0MSDT8X1V003206G): every
 * OPEN root item with that priority — `wl list --status open --priority <p>
 * --root-only` — no `browseItemCount` cap, no `wl next` selection omission;
 * children stay hidden and remain reachable via expand exactly as in the
 * unfiltered view. Results follow the standard list order and are regrouped
 * priority-first (WL-0MSOPHLD1000EWNN) so the group sections stay
 * consistent with the default worklist.
 */
export async function fetchItemsByPriority(priority: string): Promise<WorkItem[]> {
  const output = await runWl(['list', '--status', 'open', '--priority', priority, '--root-only']);
  const payload = extractJson(output);
  return regroupWorkItems(extractItems(payload));
}

/**
 * Fetch details for a single work item by ID (via `wl show`).
 */
export async function fetchItemDetails(id: string): Promise<WorkItem | null> {
  try {
    const output = await runWl(['show', id]);
    const payload = extractJson(output);
    const items = extractItems(payload);
    return items.length > 0 ? items[0] : null;
  } catch {
    return null;
  }
}

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
 * Fetch the ACTIVE dependency blockers of a work item — the outbound
 * `depends-on` edges that still block it (WL-0MV8EZRDJ001TDA8).
 *
 * `wl dep list <id> --json` edges carry only id/title/status/priority, so
 * each edge that is not already terminal by status is enriched with its
 * target's `stage` via `wl show` (mirroring the hydrator's
 * `listOutboundDeps`) before the shared {@link isActiveBlocker} predicate
 * decides whether it still blocks: `completed`/`deleted` targets and
 * targets at stage `in_review`/`done` are NOT blockers. A failed stage
 * lookup leaves the edge's stage undefined and it is classified by status
 * alone.
 *
 * Fail-open (AC): a failed/unparseable `wl dep list` (or any unexpected
 * error) yields an empty array rather than throwing — the panel then
 * simply omits its `Blocked By` rows.
 */
export async function fetchBlockersForItem(id: string): Promise<BlockerRef[]> {
  try {
    const output = await runWl(['dep', 'list', id]);
    const edges = parseDepListBlockersOutput(output);
    if (edges === null) return [];

    const blockers: BlockerRef[] = [];
    for (const edge of edges) {
      const status = (edge.status ?? '').toLowerCase().trim();
      const stage =
        status === 'completed' || status === 'deleted'
          ? undefined
          : (await fetchItemDetails(edge.id))?.stage;
      if (!isActiveBlocker({ id: edge.id, status: edge.status, stage })) continue;
      // The edge's `status` is already on the `dep list` edge — pass it
      // through (no per-blocker lookup): the panel renders it as an icon +
      // text suffix on the `Blocked By` row (WL-0MVBMLY2Z0032CYR). A
      // status-less edge yields a ref without the field.
      const edgeStatus = edge.status;
      blockers.push({ id: edge.id, title: edge.title, ...(edgeStatus ? { status: edgeStatus } : {}) });
    }
    return blockers;
  } catch {
    // Fail-open: no blocker rows on any lookup failure.
    return [];
  }
}

/**
 * Fetch the total count of actionable work items.
 *
 * Pass a refresh scope (WL-0MV6C6SLB005HX7B) to read the count via the
 * refresh's ONE shared in-process connection; omit it to open a fresh
 * per-call connection (the pre-WL-0MV6C6SLB005HX7B behaviour).
 */
export async function fetchActionableCount(
  scope?: InProcessRefreshScope,
): Promise<number | undefined> {
  // Fast path: count in-process against the SQLite store. This removes a
  // whole `wl` process spawn from every refresh and is exact: the CLI's
  // actionable count is the number of non-deleted items in those statuses.
  const inProcess = scope
    ? await scope.read((db) => db.list({ status: ['open', 'in-progress', 'blocked'] }).length)
    : await withInProcessDb((db) =>
        db.list({ status: ['open', 'in-progress', 'blocked'] }).length,
      );
  if (inProcess !== undefined) {
    return inProcess;
  }
  try {
    const output = await runWl(['list', '--status', 'open,in-progress,blocked']);
    const payload = JSON.parse(output);
    if (payload && typeof payload === 'object' && typeof (payload as any).count === 'number') {
      return (payload as any).count;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run `wl sync` to synchronize local data with the remote.
 * Returns success status and optional error message.
 */
export async function runWlSync(): Promise<{ success: boolean; error?: string }> {
  try {
    const output = await runWl(['sync']);
    const payload = extractJson(output);
    const result = payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>)
      : {};
    return { success: result?.success !== false };
  } catch (err: any) {
    return { success: false, error: err.message ?? String(err) };
  }
}

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

/**
 * Fetch the review-queue state (root-only in_review items with status
 * `completed`) for the sprint-complete / queue-depth banner (parent
 * WL-0MTHSHN5V008R5L0; banner copy selection AH-0MUDYTQ55002NUSJ). Returns
 * the count and whether an outstanding audit remains, or undefined on
 * failure — callers treat undefined as "unknown" and leave state unchanged
 * (fail-closed, AC1).
 *
 * Uses `wl list --status completed,in-progress --stage in_review
 * --root-only --json` — the SAME query as the mandatory review subset (see
 * {@link reviewQueueArgs}), so the in-flight memo deduplicates the two into
 * ONE spawn — and then keeps only the `completed` items in-process. This
 * preserves the banner's historical "completed/in_review" semantics while
 * the mandatory worklist subset consumes the full (completed + in-progress)
 * set (WL-0MV6JGVPH009YDXB). In-progress/in_review items are excluded here
 * because they are being re-worked after review feedback: they are not
 * dispatchable to the audit tier (which selects completed/in_review only),
 * so counting them in "focus on audits" would be misleading.
 *
 * "Outstanding audit" reuses the shared `isAuditFresh` predicate: a missing `auditedAt`
 * or a stored audit that is not current counts as outstanding; a fresh
 * audit (passed or failed) does not. `wl list --json` exposes
 * `currentFingerprint` for items that carry a stored fingerprint, so the
 * predicate uses the primary content gate rather than the 60 s time gate
 * (WL-0MUN7QWFP0010EQC); items without a stored fingerprint still fall back
 * to the time gate. A CLI error or unparseable output resolves to
 * undefined (never throws).
 *
 * Root-only is intentional (WL-0MSTLFW14000KPEC): children are not counted as
 * independent review-queue entries — a completed/in_review child is covered by
 * its parent's audit (derived at read time for display, WL-0MUBVH8QG0020H9L)
 * and is never dispatched for audit independently.
 */
export async function fetchReviewQueueState(): Promise<ReviewQueueState | undefined> {
  // Derive from the consolidated bundle when one was already read (or is in
  // flight) in this refresh (WL-0MVI0IT4S0070G78): the bundle's `reviewQueue`
  // subset is the same query this function used to issue, so the banner needs
  // no second `wl` spawn on the default view.
  const pending = pendingWorklistBundle();
  if (pending !== null) {
    const bundle = await pending.catch(() => null);
    if (bundle) return reviewQueueStateFromItems(bundle.reviewQueue);
  }
  const fromBundle = snapshotReviewQueueState();
  if (fromBundle !== undefined) return fromBundle;

  try {
    // Identical args to {@link fetchMandatorySubsets}'s review query so the
    // in-flight memo deduplicates the two into ONE spawn when a refresh
    // schedules both concurrently (WL-0MV5CBQ6L005SPAG).
    const output = await runWl(reviewQueueArgs());
    const payload = extractJson(output);
    return reviewQueueStateFromItems(extractItems(payload));
  } catch {
    // Fail-closed: a query failure means we cannot determine queue state
    // — the conservative default is to leave the banner state unchanged (AC1).
    return undefined;
  }
}

/**
 * Count completed + in_review work items (root-only) for the sprint-complete
 * check (parent WL-0MTHSHN5V008R5L0). Returns the count, or undefined on
 * failure. Thin wrapper over {@link fetchReviewQueueState}, retained for
 * existing callers.
 */
export async function fetchCompletedItemCount(): Promise<number | undefined> {
  const state = await fetchReviewQueueState();
  return state?.count;
}

/**
 * Fetch child work items for a given parent ID (via `wl list --parent`).
 *
 * Child items are returned with the given hierarchy `depth` for display
 * (default 1 = direct children of a top-level item). Nested expansion
 * passes the parent's depth + 1 so grandchildren render at depth 2, etc.
 * (WL-0MSQ3FH1K000MMJW) — depth is derived from the fetch path, never
 * hardcoded.
 *
 * Results are regrouped priority-first (WL-0MSOPHLD1000EWNN): priority
 * bucket sections, then stage, then id — same ordering as the default
 * worklist.
 *
 * The returned children are NOT enriched with parent-audit state here; the
 * worklist render layer does that at read time (withParentAudit) when it
 * nests a child under its parent, so derived coverage
 * (WL-0MUBVH8QG0020H9L) never leaks into the fetch/model layer.
 */
export async function fetchChildrenForItem(parentId: string, depth = 1): Promise<WorkItem[]> {
  const output = await runWl(['list', '--parent', parentId]);
  const payload = extractJson(output);
  const items = extractItems(payload);
  return regroupWorkItems(items.map((item) => ({ ...item, depth })));
}

/**
 * Fetch the direct children of MULTIPLE expanded parents in ONE pass
 * (WL-0MV5CBQ6L005SPAG). The default worklist can have dozens of expanded
 * parents; spawning `wl list --parent <id>` once per parent made the
 * expanded-children cost the dominant share of a cold refresh. This reads
 * the children in-process from the SQLite store (one read for all parents)
 * and groups them per parent with the SAME ordering and fields as
 * {@link fetchChildrenForItem}.
 *
 * Fail-open / correctness:
 * - When no in-process read is possible (no resolved worklog dir, no SQLite
 *   file, `@worklog/shared` unavailable) it falls back to one
 *   `wl list --parent` spawn per parent, so behaviour is unchanged there.
 * - When any matched child carries a stored audit fingerprint the CLI's
 *   `currentFingerprint` enrichment is required for exact freshness, so the
 *   whole batch falls back to spawning `wl`. Audited children are rare
 *   because audit dispatch is root-only, so this is the uncommon path.
 *
 * `depthByParent` overrides the display depth per parent (default 1); the
 * worklist passes each expanded item's hierarchy depth + 1 so nested
 * expansion still renders at the correct depth (WL-0MSQ3FH1K000MMJW).
 *
 * Pass a refresh scope (WL-0MV6C6SLB005HX7B) to read via the refresh's ONE
 * shared in-process connection; omit it to open a fresh per-call connection
 * exactly as before.
 */
export async function fetchChildrenForItems(
  parentIds: string[],
  depthByParent?: Map<string, number>,
  scope?: InProcessRefreshScope,
): Promise<Map<string, WorkItem[]>> {
  const uniqueParents = [...new Set(parentIds)];
  const result = new Map<string, WorkItem[]>();
  for (const id of uniqueParents) result.set(id, []);
  if (uniqueParents.length === 0) return result;

  const wanted = new Set(uniqueParents);
  const readChildren = (db: InProcessDb): { byParent: Map<string, WorkItem[]>; needsCli: boolean } => {
    // childCounts is computed over ALL items (deleted included), matching the
    // CLI's `getChildCounts()` enrichment. Children themselves are non-deleted
    // only, matching `wl list --parent`'s default filtering.
    const allRaw = db.list({});
    const childCounts = db.getChildCounts(allRaw);
    const matched = allRaw.filter(
      (item) => item.parentId && wanted.has(String(item.parentId)) && item.status !== 'deleted',
    );
    const enriched = enrichInProcessItems(db, matched);
    // A stored fingerprint needs the CLI's currentFingerprint enrichment, so
    // the fast path must not serve the batch in that case.
    const needsCli = enriched.some((item) => Boolean(item.fingerprint));
    const byParent = new Map<string, WorkItem[]>();
    for (const item of enriched) {
      const parentId = item.parentId;
      if (!parentId || !wanted.has(parentId)) continue;
      const list = byParent.get(parentId) ?? [];
      list.push({ ...item, childCount: childCounts.get(item.id) ?? 0 });
      byParent.set(parentId, list);
    }
    return { byParent, needsCli };
  };
  // A refresh scope shares ONE in-process connection with the refresh's other
  // in-process readers (WL-0MV6C6SLB005HX7B); scope-less callers open a fresh
  // per-call connection exactly as before.
  const inProcess = scope ? await scope.read(readChildren) : await withInProcessDb(readChildren);

  if (inProcess && !inProcess.needsCli) {
    for (const id of uniqueParents) {
      const depth = depthByParent?.get(id) ?? 1;
      const children = (inProcess.byParent.get(id) ?? []).map((item) => ({ ...item, depth }));
      result.set(id, regroupWorkItems(children));
    }
    return result;
  }

  // Fallback: preserve the exact per-parent CLI semantics (including
  // currentFingerprint enrichment for audited children).
  const fetched = await Promise.all(
    uniqueParents.map(async (id) => {
      try {
        const children = await fetchChildrenForItem(id, depthByParent?.get(id) ?? 1);
        return [id, children] as const;
      } catch {
        // Fail-open: a failed child fetch leaves the previously rendered
        // children in place (the caller carries them over).
        return [id, [] as WorkItem[]] as const;
      }
    }),
  );
  for (const [id, children] of fetched) result.set(id, children);
  return result;
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

/**
 * Timeout for claim status updates so a hung `wl` CLI cannot delay the
 * agent pane from opening (AC2: failures must not block the pane).
 */
const CLAIM_TIMEOUT_MS = 3000;

/**
 * Claim a work item before dispatching an agent command. For every tier
 * except audit the claim sets its status to `in_progress` with the given
 * assignee, matching the claim pattern documented in AGENTS.md. For the
 * audit tier (`expected` = `completed`/`in_review`) the claim is
 * STATUS-NEUTRAL: it writes only the assignee, guarded by
 * `--if-status completed --if-stage in_review --if-assignee ""`, so an
 * audited item never enters the `in_progress`/`in_review` hybrid
 * (WL-0MV85WCJJ0087VMP). Targets the configured worklog database via
 * `--worklog-dir` when set.
 *
 * With `expected` (status/stage), the claim is a compare-and-swap (RCA
 * WL-0MSRBFFLN005W3VT design point 1): `--if-status`/`--if-stage` are
 * passed to `wl update`, so the transition only applies while the item is
 * still in the state the tier selected it in. The audit tier additionally
 * CASes on the empty assignee (`--if-assignee ""`), so assigning an item
 * makes the claim fail stale. Exactly one concurrent pane wins; a loser
 * gets `{success:false, stale:true}` and the caller aborts the dispatch. A
 * stale result is detected from the wl CLI's `"error": "stale"` JSON
 * payload on stderr.
 *
 * `worklogRoot` (optional, WL-0MTQ14W7L003II5A) targets the update at a
 * specific worklog root's database via per-call `--worklog-dir` — the
 * downtime leader's cross-root claims (coordination offers live in the
 * offering instance's root, not the leader's). Undefined → the module
 * override (or ambient cwd) decides, as before.
 *
 * Never throws — failures are returned so callers can log them without
 * blocking the agent pane from opening.
 */
export async function claimWorkItem(
  id: string,
  assignee: string,
  expected?: { status?: string; stage?: string },
  worklogRoot?: string,
  migrateStage?: string,
): Promise<ClaimResult> {
  try {
    // Status-neutral audit-tier claim (WL-0MV85WCJJ0087VMP): an audited
    // `completed`/`in_review` item must never enter the `in_progress`/
    // `in_review` hybrid the stranding autocracies were built on. The claim
    // therefore writes ONLY the assignee — no `--status`/`--stage` — guarded
    // by the tier's status/stage expectation AND the empty-assignee CAS. A
    // failed audit restores by clearing the assignee, so the item never
    // leaves the review queue. Every other tier keeps the status-flip claim.
    const isAuditTier = expected?.status === 'completed' && expected?.stage === 'in_review';
    const args = isAuditTier
      ? [
          'update',
          id,
          '--assignee',
          assignee,
          '--if-status',
          expected.status as string,
          '--if-stage',
          expected.stage as string,
          // `""` is a meaningful expected value: only an UNASSIGNED item may
          // be claimed, so a concurrent/human assignee makes the claim stale.
          '--if-assignee',
          '',
        ]
      : ['update', id, '--status', 'in_progress', '--assignee', assignee];
    if (!isAuditTier) {
      if (expected?.status) {
        args.push('--if-status', expected.status);
      }
      if (expected?.stage) {
        args.push('--if-stage', expected.stage);
      }
      // Retired-stage recovery (WL-0MTYL7DX9000MZOH): an item stuck on a stage
      // that is no longer valid (e.g. the removed `in_progress` stage) cannot
      // satisfy the tier's normalised stage CAS. In that case the caller passes
      // the tier's target stage as an atomic MIGRATION — the CAS guard still
      // matches the item's ACTUAL (retired) stage for race safety, while
      // `--stage` advances the stored value to a valid stage in the same write.
      // Without this, the claim is rejected by the status/stage validator and
      // counted as a hard wl-error strike.
      if (migrateStage !== undefined) {
        args.push('--stage', migrateStage);
      }
    }
    // Per-call --worklog-dir targeting (WL-0MTQ14W7L003II5A): the downtime
    // leader claims coordination offers in the OFFER's own worklog root,
    // which may differ from the module override (the leader pane's root).
    // Passing the root resolves the update against the item's own database;
    // absent/undefined keeps the historical module-override behavior.
    const dirOverride = worklogRoot !== undefined ? join(worklogRoot, '.worklog') : undefined;
    await runWl(args, true, CLAIM_TIMEOUT_MS, dirOverride);
    return { success: true };
  } catch (err: any) {
    const message = err.message ?? String(err);
    // Lost CAS race: the wl CLI exits non-zero with `{"success":false,
    // "error":"stale", ...}` on stderr (runWl surfaces stderr first).
    const stale =
      message.includes('"error":"stale"') ||
      message.includes('"error": "stale"') ||
      message.includes("'stale'") ||
      message.includes('Conditional update skipped');
    return { success: false, stale, error: message };
  }
}

/**
 * Roll back a pre-dispatch CAS claim that succeeded but never completed
 * dispatch (WL-0MT32F908002YFFA AC1/AC2): restore the item to its
 * pre-claim status + stage so a future idle period can re-select it. Used
 * when the dispatch marker cannot be written (`marker-write-failed`) or the
 * pane spawn fails (`spawn-failed`) — in both cases the CAS claimed the item
 * (`in_progress`) but no agent is working it, so leaving it claimed strands
 * it in a state no tier selects.
 *
 * The reverse transition is guarded by the SAME race-safe CAS shape as the
 * claim: `--if-status in_progress` (plus `--if-stage <original.stage>` when
 * known) ensures only THIS claim's state is reverted. A concurrent
 * human/agent that already moved the item makes the update stale → resolves
 * `false` (nothing to roll back) and never clobbers their change.
 *
 * `original.status` defaults to `open` (the plan/intake/implement/risk-effort
 * tiers); the audit tier passes `completed` so a failed audit dispatch
 * returns to the audit queue rather than the open backlog. When
 * `original.assignee` is a non-empty string (the audit tier,
 * WL-0MV85WCJJ0087VMP) the rollback is STATUS-NEUTRAL: it clears only the
 * claiming agent's assignee, guarded by `--if-assignee <agent>`, and never
 * rewrites status/stage. `worklogRoot` targets that root's database via
 * per-call `--worklog-dir` (the same cross-root convention as
 * `claimWorkItem`).
 *
 * Never throws — a failure resolves `false` so the caller can fall back to
 * the fail-closed abort outcome.
 */
export async function rollbackClaimWorkItem(
  id: string,
  original?: { status?: string; stage?: string; assignee?: string },
  worklogRoot?: string,
): Promise<boolean> {
  try {
    // The audit tier's claim is STATUS-NEUTRAL (WL-0MV85WCJJ0087VMP): it
    // writes only the assignee and never flips status/stage, so its rollback
    // must likewise not rewrite them — it clears only the claiming agent's
    // assignee, guarded by `--if-assignee <agent>` so a concurrent assignee
    // change makes the rollback stale (no clobber). Every OTHER tier keeps
    // the legacy status/stage restore but ALSO clears THIS claim's assignee
    // (guarded by `--if-assignee <agent>`) so a failed dispatch never leaves a
    // non-empty assignee behind. A non-empty assignee is a scheduling hold
    // (WL-0MV85WDOM007BKF8): residue would make the item permanently
    // undispatchable after a marker-write/spawn failure
    // (WL-0MV85WD400091OZ6). When the claiming agent is unknown the legacy
    // restore is applied as before (fail-safe: no stricter claim than the
    // original).
    const isAuditTier =
      original?.status === 'completed' && original?.stage === 'in_review';
    const claimedAgent = original?.assignee;
    const hasClaimedAgent = typeof claimedAgent === 'string' && claimedAgent.length > 0;
    let args: string[];
    if (isAuditTier && hasClaimedAgent) {
      // Status-neutral, assignee-guarded clear (Option A).
      args = ['update', id, '--assignee', '', '--if-assignee', claimedAgent as string];
    } else if (isAuditTier) {
      // No claimed agent known: best-effort restore of the review-queue state
      // (never the plan_complete coercion that stranded items).
      args = ['update', id, '--status', 'completed', '--stage', original?.stage ?? 'in_review'];
    } else {
      // Legacy status/stage restore + clear THIS claim's assignee (hold).
      args = ['update', id, '--status', original?.status ?? 'open', '--if-status', 'in_progress'];
      if (original?.stage) {
        args.push('--if-stage', original.stage);
        args.push('--stage', original.stage);
      }
      if (hasClaimedAgent) {
        args.push('--assignee', '');
        args.push('--if-assignee', claimedAgent as string);
      }
    }
    const dirOverride = worklogRoot !== undefined ? join(worklogRoot, '.worklog') : undefined;
    await runWl(args, true, CLAIM_TIMEOUT_MS, dirOverride);
    return true;
  } catch {
    // Fail-closed: a failed/stale rollback resolves false (the caller reports
    // the failure and leaves the item as-is — no worse than before recovery).
    return false;
  }
}

/**
 * Flag a work item as needing producer review (`needsProducerReview = true`)
 * via `wl reviewed <id> true` (WL-0MUKYEXMK0033MFK AC3). The downtime
 * dispatcher calls this once an item exhausts its per-item/per-kind attempt
 * budget so it surfaces for human triage instead of looping through idle
 * cycles. `worklogRoot` targets that root's database via per-call
 * `--worklog-dir` (the same cross-root convention as `claimWorkItem`).
 *
 * Idempotent: setting the flag true when it is already true is a no-op.
 * Never throws — a failure resolves `false` (fail-closed: the dispatcher
 * still skips the budget-exhausted item and retries the flag next cycle).
 */
export async function markNeedsProducerReviewWorkItem(
  id: string,
  worklogRoot?: string,
): Promise<boolean> {
  try {
    const dirOverride = worklogRoot !== undefined ? join(worklogRoot, '.worklog') : undefined;
    await runWl(['reviewed', id, 'true'], true, CLAIM_TIMEOUT_MS, dirOverride);
    return true;
  } catch {
    return false;
  }
}
