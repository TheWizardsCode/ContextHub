/**
 * packages/herdr/src/fetcher.worklist-bundle.ts — consolidated `wl worklist`
 * bundle read and its snapshot/in-flight cache.
 *
 * Single responsibility: the ONE `wl worklist --json` read that replaces the
 * per-subset spawns, its payload parser, and the two module-level caches it
 * owns — the TTL-bounded snapshot the review-queue banner derives from and the
 * in-flight read a concurrent banner read awaits. It holds the only
 * declarations of `WORKLIST_BUNDLE_SNAPSHOT_TTL_MS`, `lastWorklistBundle` and
 * `inflightWorklistBundle` (parent WL-0MVGKH47T007GKN1 AC3).
 *
 * Leaf module: it imports only concrete siblings (`./fetcher.args.js` for the
 * worklog dir, `./fetcher.cli.js` for the `wl` spawn and `./fetcher.json.js`
 * for payload extraction) plus `import type` from `./fetcher.types.js`; it
 * never imports the `./fetcher.js` barrel (parent AC4).
 *
 * Moved verbatim out of `fetcher.ts` (parent WL-0MVGKH47T007GKN1; extraction
 * WL-0MW08VW3L003U3HG). No behaviour change: the 10 s snapshot TTL, the bundle
 * payload contract, the single-spawn-per-refresh rule and the fail-open
 * fallthrough to the per-subset path are unchanged.
 */

import { getWorklogDir } from './fetcher.args.js';
import { runWl } from './fetcher.cli.js';
import { extractItems, extractJson } from './fetcher.json.js';
import type { WorkItem, WorklistBundle } from './fetcher.types.js';

// ── Consolidated worklist bundle (WL-0MVI0IT4S0070G78) ────────────────
//
// One `wl worklist --json` read replaces the five per-subset spawns a
// default-view refresh used to issue (four mandatory `wl list` queries + the
// `wl next` browse feed). See `docs/dev/herdr-event-driven-refresh.md`
// (§ "Cold-refresh cost") for the design rationale and the measured CPU
// before/after; the command's payload contract is documented in `CLI.md`.

/**
 * How long a fetched bundle may satisfy {@link recentWorklistBundle}. The
 * banner state is refreshed on every tick, so a short window is invisible to
 * the operator while guaranteeing the concurrent review-state read in a
 * refresh derives from the SAME read instead of spawning a second `wl`.
 * Cleared immediately on any write and on a worklog-dir change.
 */
export const WORKLIST_BUNDLE_SNAPSHOT_TTL_MS = 10_000;

/** Most recent successful bundle read, used only for review-queue state. */
let lastWorklistBundle: { dirKey: string; at: number; bundle: WorklistBundle } | null = null;

/**
 * Bundle read currently in flight for the current worklog dir. The
 * review-queue state read starts concurrently with the item fetch, so it
 * awaits this instead of spawning a second `wl` for the same subset.
 */
let inflightWorklistBundle: { dirKey: string; promise: Promise<WorklistBundle> } | null = null;

/**
 * Drop both worklist-bundle caches. Registered with the `wl` CLI leaf
 * (`./fetcher.cli.js`) as its memo-invalidation hook, so a write or a
 * worklog-dir change invalidates the review-queue snapshot derived from a
 * previously fetched bundle (WL-0MVI0IT4S0070G78) even though the leaf may not
 * import the barrel (parent AC4).
 */
export function clearWorklistBundleCaches(): void {
  lastWorklistBundle = null;
  inflightWorklistBundle = null;
}

/** Identity of the worklog dir a bundle was read from. */
function worklogDirKey(): string {
  return getWorklogDir() ?? '';
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
 *
 * `dirOverride` (a `.worklog` directory) targets a FOREIGN root's database —
 * the registered-root sweep's canonical head read (WL-0MVR8GDJ3008WY3Y AC3).
 * Absent ⇒ the module-configured root (byte-for-byte today's behaviour). A
 * foreign read is keyed by its own dir so it can never satisfy a snapshot /
 * in-flight lookup for the module root.
 */
export async function fetchWorklistBundle(
  count?: number,
  timeoutMs?: number,
  dirOverride?: string,
): Promise<WorklistBundle> {
  const args = ['worklist'];
  if (count !== undefined) {
    args.push('-n', String(count));
  }
  const dirKey = dirOverride ?? worklogDirKey();
  const promise = runWl(args, true, timeoutMs, dirOverride).then((output) => {
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
export function pendingWorklistBundle(): Promise<WorklistBundle> | null {
  const inflight = inflightWorklistBundle;
  if (inflight === null) return null;
  if (inflight.dirKey !== worklogDirKey()) return null;
  return inflight.promise;
}

/**
 * The bundle read earlier in this refresh (same worklog dir, within
 * {@link WORKLIST_BUNDLE_SNAPSHOT_TTL_MS}), or `undefined` when there is none —
 * the caller then runs the standalone query. Keeps the snapshot TTL contract
 * next to the state it guards.
 */
export function recentWorklistBundle(): WorklistBundle | undefined {
  const snapshot = lastWorklistBundle;
  if (snapshot === null) return undefined;
  if (snapshot.dirKey !== worklogDirKey()) return undefined;
  if (Date.now() - snapshot.at > WORKLIST_BUNDLE_SNAPSHOT_TTL_MS) return undefined;
  return snapshot.bundle;
}
