/**
 * `wl worklist` — the consolidated worklist read (WL-0MVI0HX58009JJRF, parent
 * WL-0MVGYLU0S004WZUS).
 *
 * A Herdr default-view refresh used to spawn five `wl` processes per pane per
 * tick: four mandatory `wl list` subsets (critical, review queue, in-progress
 * roots, blocked roots) plus the `wl next` browse feed. Node start-up dominates
 * the cost of each spawn, so the remaining lever is *fewer spawns*: this
 * command opens the database **once** and returns every subset the worklist
 * needs in a single JSON payload, built from the same query/selection code the
 * individual commands use (`db.list()` and the shared browse-feed selection in
 * `src/worklist-selection.ts` — no forked filters, no forked ordering).
 *
 * Guarantees:
 *   - **Pure read.** No `reSort`, no cache invalidation, no writes. The browse
 *     feed therefore cannot be re-sorted away from the caller's expectations
 *     and the payload is deterministically cacheable (cache wiring: WL-0MVI0IS6Y0028KTO).
 *   - **One DB open.** All five subsets are read through the single handle
 *     resolved by `utils.getDatabase()`.
 *   - **Every subset key is always present**, as an empty array when nothing
 *     matches, so consumers never need existence checks.
 *   - **Bounded.** The browse feed honours `-n/--number` (default 20); the four
 *     mandatory subsets are unbounded by that count (critical/blocked/review
 *     items are always shown, whatever the browse window).
 *
 * Payload contract (stable — the Herdr fetcher caches it verbatim and parses it
 * directly, WL-0MVI0IT4S0070G78):
 *
 * ```jsonc
 * {
 *   "success": true,
 *   "worklogDir": "/abs/path/.worklog",
 *   "requestedCount": 20,
 *   "subsets": {
 *     "critical": [ /* WorkItem[]: priority critical, any parent level *\/ ],
 *     "reviewQueue": [ /* WorkItem[]: completed|in-progress, stage in_review, roots *\/ ],
 *     "inProgressRoots": [ /* WorkItem[]: status in-progress, roots *\/ ],
 *     "blockedRoots": [ /* WorkItem[]: status blocked, roots *\/ ],
 *     "browse": [ /* { workItem, reason, group?, groupLabel? }[] *\/ ]
 *   }
 * }
 * ```
 */

import type { PluginContext } from '../plugin-types.js';
import type { WorkItem, WorkItemQuery } from '../types.js';
import { resolveWorklogDir } from '../worklog-paths.js';
import { createHierarchyOrderComparator } from './helpers.js';
import { selectBrowseFeed, type BrowseFeedEntry } from '../worklist-selection.js';

/** Default number of browse-feed items returned (`-n/--number`). */
export const WORKLIST_DEFAULT_BROWSE_COUNT = 20;

/**
 * The mandatory list subsets, exactly the filters the Herdr fetcher issues as
 * separate `wl list` spawns today (`packages/herdr/src/fetcher.ts`):
 *
 *   - critical          — `--priority critical --status open,in-progress,blocked,completed`
 *                         (all parent levels: a critical child is as urgent as a
 *                         critical root)
 *   - reviewQueue       — `--status completed,in-progress --stage in_review --root-only`
 *   - inProgressRoots   — `--status in-progress --root-only`
 *   - blockedRoots      — `--status blocked --root-only`
 *
 * Order matters only for documentation/help; every subset is always returned.
 */
export const WORKLIST_LIST_SUBSET_QUERIES: Readonly<Record<string, WorkItemQuery>> = Object.freeze({
  critical: { priority: 'critical', status: ['open', 'in-progress', 'blocked', 'completed'] },
  reviewQueue: { status: ['completed', 'in-progress'], stage: 'in_review', rootOnly: true },
  inProgressRoots: { status: ['in-progress'], rootOnly: true },
  blockedRoots: { status: ['blocked'], rootOnly: true },
});

/** Names of the four mandatory list subsets, in payload order. */
export const WORKLIST_LIST_SUBSET_NAMES: readonly string[] = Object.freeze(
  Object.keys(WORKLIST_LIST_SUBSET_QUERIES),
);

/** The consolidated payload emitted by `wl worklist --json`. */
export interface WorklistPayload {
  success: true;
  /** Resolved worklog directory (honours `--worklog-dir` / module override). */
  worklogDir: string;
  /** The browse-feed count that was requested. */
  requestedCount: number;
  subsets: {
    critical: WorkItem[];
    reviewQueue: WorkItem[];
    inProgressRoots: WorkItem[];
    blockedRoots: WorkItem[];
    browse: BrowseFeedEntry[];
  };
}

/** Parse `-n/--number` into a positive count (default {@link WORKLIST_DEFAULT_BROWSE_COUNT}). */
export function parseBrowseCount(value: unknown): number {
  const parsed = parseInt(String(value ?? WORKLIST_DEFAULT_BROWSE_COUNT), 10);
  if (Number.isNaN(parsed) || parsed < 1) return WORKLIST_DEFAULT_BROWSE_COUNT;
  return parsed;
}

export default function register(ctx: PluginContext): void {
  const { program, output, utils } = ctx;

  program
    .command('worklist')
    .description(
      'One consolidated read of every worklist subset — critical, review queue, ' +
        'in-progress roots, blocked roots and the browse feed — in a single JSON ' +
        'payload from one DB open. Pure read: never re-sorts, so the result is ' +
        'deterministic and cacheable.',
    )
    .option('-n, --number <n>', `Number of browse-feed items to return (default: ${WORKLIST_DEFAULT_BROWSE_COUNT})`, String(WORKLIST_DEFAULT_BROWSE_COUNT))
    .option('--prefix <prefix>', 'Override the default prefix')
    .action((options: any) => {
      utils.requireInitialized();
      const count = parseBrowseCount(options?.number);

      // ONE handle for every subset below: this is the whole point of the
      // command (one process, one DB open, one cache entry).
      const db = utils.getDatabase(options?.prefix);

      // One hierarchy-order comparator for all four subsets: the ordered list
      // is materialised once instead of once per subset.
      const hierarchyComparator = createHierarchyOrderComparator(db);
      const order = (items: WorkItem[]): WorkItem[] => items.slice().sort(hierarchyComparator);

      const critical = order(db.list(WORKLIST_LIST_SUBSET_QUERIES.critical));
      const reviewQueue = order(db.list(WORKLIST_LIST_SUBSET_QUERIES.reviewQueue));
      const inProgressRoots = order(db.list(WORKLIST_LIST_SUBSET_QUERIES.inProgressRoots));
      const blockedRoots = order(db.list(WORKLIST_LIST_SUBSET_QUERIES.blockedRoots));

      // The browse feed is the *same* selection `wl next -n <count>
      // --include-in-progress --include-blocked --no-re-sort` performs, minus
      // its auto re-sort write (WL-0MVI0HX58009JJRF AC: item-for-item parity).
      const browse = selectBrowseFeed(db, {
        count,
        includeBlocked: true,
        includeInProgress: true,
      });

      const payload: WorklistPayload = {
        success: true,
        worklogDir: resolveWorklogDir(),
        requestedCount: count,
        subsets: {
          critical,
          reviewQueue,
          inProgressRoots,
          blockedRoots,
          browse: browse.items,
        },
      };

      if (utils.isJsonMode()) {
        output.json(payload);
        return;
      }

      // Human summary: one line per subset, plus the browse feed's top item.
      console.log(`Worklist for ${payload.worklogDir}`);
      console.log(`  critical:          ${critical.length}`);
      console.log(`  review queue:      ${reviewQueue.length}`);
      console.log(`  in-progress roots: ${inProgressRoots.length}`);
      console.log(`  blocked roots:     ${blockedRoots.length}`);
      console.log(`  browse feed:       ${payload.subsets.browse.length} of ${count} requested`);
      if (browse.note) console.log(`  ${browse.note}`);
    });
}
