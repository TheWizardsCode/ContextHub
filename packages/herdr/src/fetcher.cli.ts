/**
 * packages/herdr/src/fetcher.cli.ts — `wl` CLI execution: spawn, timeout,
 * retry and the in-flight read memo.
 *
 * Single responsibility: every `wl` process spawn the fetcher family issues —
 * the CLI binary probe order, the bounded per-call timeout (including the
 * queue-time budget inherited by a capped read), the read-command in-flight
 * memoisation that dedupes concurrent identical reads, and the write-path
 * invalidation of read caches. It holds the only `runWl` implementation and
 * the only declaration of the in-flight memo (`inflightFetchMemo`).
 *
 * Leaf module: it imports only `node:`-free concrete siblings
 * (`./fetcher.args.js` for the exec seam/argument builder/worklog dir and
 * `./fetcher.spawn-cap.js` for the bounded spawn slots) and never the
 * `./fetcher.js` barrel (parent AC4 of WL-0MVGKH47T007GKN1). The
 * worklist-bundle snapshot that also has to drop on a write lives in a module
 * layered ABOVE this leaf, so it registers its invalidation through
 * {@link setFetchMemoInvalidationHandler} instead of this leaf importing it.
 *
 * Moved verbatim out of `fetcher.ts` (parent WL-0MVGKH47T007GKN1; extraction
 * WL-0MW08VVC0007L28M). No behaviour change: the 60 s default timeout, the
 * memoizable-command set, the memo entry cap, the in-flight dedup key and the
 * timeout arithmetic are unchanged.
 */

import { buildWlArgs, getExecFileAsync, getWorklogDir } from './fetcher.args.js';
import { acquireWlSpawnSlot, releaseWlSpawnSlot } from './fetcher.spawn-cap.js';

// ── CLI execution ─────────────────────────────────────────────────────

/**
 * Default timeout (in milliseconds) for all wl CLI spawns in the refresh/
 * sync fetch path. 60_000 ms — matches the auto-sync safety timeout and the
 * Pi TUI extension convention (auto-sync.ts:227). A hung wl spawn (e.g.
 * waiting on a lock during a long `wl sync`) will reject after this period
 * instead of blocking the `refreshInFlight` guard forever (WL-0MSJNJXX2001NMHS).
 */
export const DEFAULT_WL_TIMEOUT_MS = 60_000;

/**
 * CLI binaries probed in order: the npm-installed `wl` shim first, then the
 * legacy `worklog` binary name. Shared with the barrel's `checkWlAvailable`
 * probe (`wl --version`), which keeps its own public-API responsibility there.
 */
export const CLI_BINARIES = ['wl', 'worklog'];

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
 * Read commands subject to the spawn-concurrency cap (F5). These are the
 * per-pane data-load reads the parent AC targets; writes (update/create/
 * comment/…/sync) are deliberately left uncapped (see the cap comment). `dep`
 * is explicitly included though not memoizable: the metadata-panel dep-probe
 * fallback fans out one `wl dep list <id>` / `wl show <id>` per edge and must
 * never spawn unbounded.
 */
const WL_SPAWN_CAPPED_COMMANDS: ReadonlySet<string> = new Set([...MEMOIZABLE_COMMANDS, 'dep']);

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
  return `${dirOverride ?? getWorklogDir() ?? ''}\u0000${includeJson ? '1' : '0'}\u0000${args.join('\u0000')}`;
}

/**
 * Drop all in-flight fetch memo entries (after a write or worklog-dir
 * change). Reads that started before the write keep their own result; reads
 * issued after the write will spawn fresh instead of sharing a pre-write
 * in-flight read.
 */
export function clearFetchMemo(): void {
  inflightFetchMemo.clear();
  fetchMemoInvalidation?.();
}

/**
 * Test helper: current number of in-flight memo entries. Used to verify the
 * memo stays bounded under many concurrent distinct fetches.
 */
export function _fetchMemoSize(): number {
  return inflightFetchMemo.size;
}

/**
 * Cache invalidation run whenever the in-flight fetch memo is dropped.
 *
 * The worklist-bundle snapshot lives in a module layered ABOVE this leaf and
 * must drop its entries whenever a write (or a worklog-dir change) invalidates
 * the memo. This leaf may not import the `./fetcher.js` barrel (parent AC4),
 * so the owning module registers its invalidation here instead.
 */
let fetchMemoInvalidation: (() => void) | undefined;

/**
 * Register the invalidation run whenever {@link clearFetchMemo} drops the memo.
 * Single owner: a second registration replaces the first.
 */
export function setFetchMemoInvalidationHandler(handler: () => void): void {
  fetchMemoInvalidation = handler;
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
  // F5 spawn cap: reads acquire a bounded-concurrency slot; a queued read
  // releases on a microtask when a slot frees, so it never blocks the TUI
  // event loop. Writes bypass the cap entirely (rare, user-driven).
  const capped = WL_SPAWN_CAPPED_COMMANDS.has(args[0]);
  let waitedMs = 0;
  if (capped) {
    waitedMs = await acquireWlSpawnSlot();
  }
  try {
    return await runWlInnerUncapped(
      args,
      includeJson,
      queuedTimeout(timeoutMs, waitedMs),
      dirOverride,
    );
  } finally {
    if (capped) releaseWlSpawnSlot();
  }
}

/**
 * A queued read inherits the bounded-timeout budget of the refresh that
 * issued it: time spent waiting for a spawn slot counts against
 * `DEFAULT_WL_TIMEOUT_MS`, so a hung child ahead of it cannot stack a fresh
 * 60 s per queued read. F8's cap of 1 serialises reads, and without this a
 * timed-out refresh with several fan-out reads could take N x 60 s to
 * surface its failure (the guard is bounded, but the operator sees no toast
 * for minutes). Returns the caller's override unchanged when the read did
 * not queue, preserving the documented per-call timeouts.
 */
function queuedTimeout(timeoutMs: number | undefined, waitedMs: number): number | undefined {
  // Sub-second queue hops are normal scheduler jitter (and must not perturb
  // the documented per-call timeout, which callers assert exactly); only a
  // read that genuinely queued behind a long/hung spawn inherits the budget.
  if (waitedMs < 1_000) return timeoutMs;
  const base = timeoutMs ?? DEFAULT_WL_TIMEOUT_MS;
  return Math.max(1, base - waitedMs);
}

async function runWlInnerUncapped(
  args: string[],
  includeJson: boolean,
  timeoutMs?: number,
  dirOverride?: string,
): Promise<string> {
  let lastError: unknown;
  const execFileAsync = getExecFileAsync();

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

/**
 * Run one `wl` invocation, returning its stdout.
 *
 * Module-private surface consumed by the barrel's public API (the barrel is the
 * only consumer-visible entry point), so it is exported from this leaf for
 * sibling import but never re-exported from `./fetcher.js`.
 */
export async function runWl(
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
    // previously fetched worklist bundle (WL-0MVI0IT4S0070G78); that snapshot
    // is owned by the barrel, which registers its invalidation here.
    fetchMemoInvalidation?.();
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
