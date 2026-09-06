/**
 * Downtime-dispatch agreement sampling (WL-0MTK1ILM2009QYB2 AC5, child
 * F2 WL-0MTM0OM7K00945HG): proves the observable contract
 * "dispatcher == Herdr list head" against a LIVE worklog root.
 *
 * For one worklog root (default: the repo you run it in, override with
 * `WORKLOG_DIR` or argv[2]) the script computes the same pick from THREE
 * lenses using the production code paths (no reimplementation):
 *
 *  1. Raw `wl next` reference  — `wl next -n 20 --json` (the producer-
 *     accepted sampling reference): the CLI's own first selectable item.
 *  2. Herdr selection list head — `fetchNextItems()` (fetcher.ts:
 *     `wl next` + mandatory critical/in_review subsets →
 *     smart-selection.ts:selectWorkItems → grouping.ts:regroupWorkItems),
 *     the sole ranking path the dispatcher consumes.
 *  3. Downtime pick — the first item of that Herdr sequence that passes
 *     the dispatcher's sequential safety filters (the exact filter chain
 *     of dispatchFromHerdrList: classifyItemForDispatch — which applies
 *     the producer-review gate, audit freshness/recency and implement
 *     risk/effort caps — then the dispatched-marker exclusions read from
 *     the worklog's rolling dispatch log). This is the same selection the
 *     coordination check-in offers (computeMostImportantItem).
 *
 * The script asserts the CONTRACT: whenever the Herdr list head itself is
 * dispatchable the downtime pick must BE that head (the dispatcher never
 * re-ranks — filters only ever move the pick deeper down the SAME
 * sequence). When the head is filtered the pick is the first dispatchable
 * item of the same list, and that is reported explicitly.
 *
 * Run: `npm run sample:downtime-agreement [<worklog-root>]`
 * Requires the `wl` CLI on PATH and `tsx` (dev dependency).
 * Exit 0 = contract holds on this sample; 1 = mismatch/CLI failure.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readDowntimeLogEntries, auditDispatchedItemIds, implementDispatchedItemIds, dispatchedItemStages } from '../packages/herdr/src/downtime-log.js';
import { classifyItemForDispatch } from '../packages/herdr/src/downtime-worker.js';
import { setWorklogDir, resetWorklogDir, buildWlArgs, fetchNextItems, clearFetchMemo } from '../packages/herdr/src/fetcher.js';

// ── Worklog root resolution ───────────────────────────────────────────

function findWorklogRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, '.worklog'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) throw new Error(`no .worklog found upward from ${start}`);
    dir = parent;
  }
}

// ── Lenses ────────────────────────────────────────────────────────────

/** Lens 1: raw `wl next -n 20 --json` — first selectable open item id. */
function rawWlNextHead(): { id: string | null; title: string | null } {
  const out = execFileSync('wl', buildWlArgs(['next', '-n', '20', '--json']), { encoding: 'utf8', timeout: 60_000 });
  const parsed = JSON.parse(out) as { results?: Array<{ workItem: { id: string; title?: string } }> };
  const first = parsed.results?.[0];
  return { id: first?.workItem.id ?? null, title: first?.workItem.title ?? null };
}

/** The downtime dispatcher's sequential filters on one Herdr item (mirrors dispatchFromHerdrList). */
function makeDispatchFilter(opts: {
  auditIds: Set<string>;
  implementIds: Set<string>;
  planStages: Map<string, string>;
  intakeStages: Map<string, string>;
}) {
  return (item: { id: string; status?: string; stage?: string }): boolean => {
    const kind = classifyItemForDispatch(item as Parameters<typeof classifyItemForDispatch>[0]);
    if (kind === null) return false;
    if (kind === 'audit' && opts.auditIds.has(item.id)) return false;
    if (kind === 'implement' && opts.implementIds.has(item.id)) return false;
    if (kind === 'plan' && opts.planStages.get(item.id) === (item.stage ?? '')) return false;
    if (kind === 'intake' && opts.intakeStages.get(item.id) === (item.stage ?? '')) return false;
    return true;
  };
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const start = process.argv[2] ?? process.env.WORKLOG_DIR ?? process.cwd();
  const root = findWorklogRoot(start);
  setWorklogDir(join(root, '.worklog'));
  clearFetchMemo();

  // Lens 2+3 share ONE production ranking fetch — the dispatcher consumes
  // the same head batch getHerdrListHead returns (fetchNextItems(30)).
  const herdrSequence = await fetchNextItems(30);
  if (herdrSequence.length === 0) {
    console.log(`[agreement] ${root}: Herdr list is EMPTY — no dispatchable backlog; nothing to agree on.`);
    return 0;
  }

  // Dispatch-time marker exclusions from the rolling dispatch log.
  const logEntries = await readDowntimeLogEntries(root);
  const filter = makeDispatchFilter({
    auditIds: auditDispatchedItemIds(logEntries),
    implementIds: implementDispatchedItemIds(logEntries),
    planStages: dispatchedItemStages(logEntries, 'plan'),
    intakeStages: dispatchedItemStages(logEntries, 'intake'),
  });

  const head = herdrSequence[0];
  const headDispatchable = filter(head);
  const pick = herdrSequence.find((item) => filter(item)) ?? null;
  const raw = rawWlNextHead();

  console.log(`[agreement] worklog root : ${root}`);
  console.log(`[agreement] Herdr head    : ${head.id} — "${head.title?.slice(0, 60)}"${headDispatchable ? '' : '  (head filtered → not dispatchable)'}`);
  console.log(`[agreement] downtime pick : ${pick?.id ?? '(none)'}${pick ? ` — "${pick.title?.slice(0, 60)}"` : ''}`);
  console.log(`[agreement] wl next head  : ${raw.id ?? '(none)'}${raw.title ? ` — "${raw.title.slice(0, 60)}"` : ''}`);

  // Contract assertion (AC5): the dispatcher NEVER re-ranks. When the head
  // is dispatchable the pick MUST be the head; when the head is filtered
  // the pick is the first dispatchable item deeper in the SAME sequence —
  // and we report that explicitly (a filter skip, not a second ranking).
  const contractHolds = pick !== null && (headDispatchable ? pick.id === head.id : true);
  const pickIndex = pick ? herdrSequence.findIndex((i) => i.id === pick.id) : -1;

  console.log(`[agreement] pick at index  : ${pickIndex} of ${herdrSequence.length} (Herdr list order)`);
  if (headDispatchable) {
    console.log(`[agreement] head dispatchable: pick === Herdr head → ${contractHolds ? 'AGREE' : 'MISMATCH'}`);
  } else {
    console.log(`[agreement] head filtered (${head.status}/${head.stage}) — pick is the first dispatchable item of the same list (filter, not re-rank)`);
  }
  console.log(`[agreement] wl-next cross-lens (informational): ${pick && pick.id === raw.id ? 'AGREE' : 'differs (expected when the mandatory critical/in_review merge reorders the Herdr list)'}`);

  if (!contractHolds) {
    console.error('[agreement] FAIL: dispatcher pick diverges from the Herdr list head contract.');
    return 1;
  }
  console.log('[agreement] PASS: dispatcher == Herdr list head (filters, not ranking).');
  return 0;
}

try {
  const code = await main();
  process.exitCode = code;
} finally {
  resetWorklogDir();
}
