/**
 * packages/herdr/src/index.claim.ts — work-item claim and interactive
 * request-priority resolution for the Herdr Worklog plugin.
 *
 * Claims the work item referenced by an agent command before the agent
 * pane is spawned (`claimItemForAgentCommand`) and resolves the request
 * priority for an interactive agent dispatch
 * (`resolveInteractiveDispatchPriority`). Extracted verbatim from
 * `packages/herdr/src/index.ts` (move-only, WL-0MVOA0ODW002W5C4, parent
 * WL-0MVGKGFFN009UCM6); the barrel re-exports the consumed symbols
 * (`claimItemForAgentCommand`, `resolveInteractiveDispatchPriority`) while
 * `AGENT_ASSIGNEE`, `DISPATCHER_ASSIGNEE` and `fetchCriticalBlockers` stay out
 * of the consumed public surface, value-imported by the barrel only for its
 * internal dispatch paths (createDowntimeDeps / main()).
 */

import { extractWorkItemId } from './index.pane-capture.js';
import { claimWorkItem, getExecFileAsync, buildWlArgs } from './fetcher.js';
import {
  INTERACTIVE_PRIORITY_LOOKUP_TIMEOUT_MS,
  resolveInteractiveRequestPriority,
  type RequestPriority,
} from './request-priority.js';
import {
  parseDepListBlockersOutput,
  parseShownWorkItem,
  withTransientRetry,
  DOWNTIME_WL_TIMEOUT_MS,
  type CriticalCandidate,
} from './downtime-worker.js';
import { AGENT_ASSIGNEE } from './assignee-identities.js';

/**
 * Claim identity for INTERACTIVE agent commands: the plugin claims the item
 * (sets status to in_progress) as `Map` before the agent pane is spawned.
 *
 * `Map` is the worklog PRODUCER-HOLD sentinel (see AGENTS.md claim pattern and
 * the SorraAgents-side `skill/shared/claim_release.py` predicate): a session
 * that ends while the item still carries `Map` leaves a DELIBERATE producer
 * hold in place — `wl next`, the dispatch gates and the stale-claim reaper all
 * respect it. Interactive agent claims therefore keep `Map` exactly as it was.
 *
 * Both identities are DEFINED ONCE in `./assignee-identities.ts` (a leaf
 * module) so `downtime-worker.selection.ts` can consume them without a runtime
 * cycle; this module re-exports them for its own dispatch paths and the
 * existing test surface (WL-0MW55V8PA000CD6P).
 */
export { AGENT_ASSIGNEE, DISPATCHER_ASSIGNEE } from './assignee-identities.js';

/**
 * Claim the work-item referenced by an agent command (set its status to
 * in_progress) before the agent pane is spawned.
 *
 * Non-blocking: never throws. Failures are logged to stderr and must not
 * prevent the agent pane from opening (AC2). Commands without a work-item
 * ID (e.g. `/intake` alone) are skipped silently.
 */
export async function claimItemForAgentCommand(command: string): Promise<void> {
  const itemId = extractWorkItemId(command);
  if (!itemId) {
    return;
  }
  const result = await claimWorkItem(itemId, AGENT_ASSIGNEE);
  if (!result.success) {
    process.stderr.write(
      `[worklog-plugin] Failed to set ${itemId} status to in_progress: ${result.error ?? 'unknown error'}\n`,
    );
  }
}

/**
 * Look up a work item's raw priority for interactive request-priority
 * resolution (WL-0MVE1NZ4J000H5NH AC2).
 *
 * Bounded and fail-open: any CLI error, timeout or parse failure resolves
 * `undefined`, which the interactive mapping turns into the default `high`.
 * Never throws.
 */
async function lookupWorkItemPriority(itemId: string): Promise<string | undefined> {
  try {
    const { stdout } = await getExecFileAsync()(
      'wl',
      buildWlArgs(['show', itemId, '--json']),
      { encoding: 'utf8', timeout: INTERACTIVE_PRIORITY_LOOKUP_TIMEOUT_MS },
    );
    return parseShownWorkItem(stdout)?.priority;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the request priority for an interactive agent dispatch
 * (WL-0MVE1NZ4J000H5NH AC2): map the dispatched work item's priority through
 * the interactive table. Fail-open — no item id, a lookup failure or a
 * timeout yields the interactive default (`high`).
 *
 * `lookup` is the priority-resolution seam (validation WL-0MVGC6JVP00812DS
 * AC1): it defaults to the production `wl show` lookup and may be injected
 * by tests to drive the resolution deterministically (absent id, lookup
 * failure, timeout). The `timeoutMs` budget is forwarded to the underlying
 * resolution when supplied.
 */
export async function resolveInteractiveDispatchPriority(
  itemId: string | undefined,
  lookup: (
    id: string,
  ) =>
    | string
    | null
    | undefined
    | Promise<string | null | undefined> = lookupWorkItemPriority,
  timeoutMs: number = INTERACTIVE_PRIORITY_LOOKUP_TIMEOUT_MS,
): Promise<RequestPriority> {
  return resolveInteractiveRequestPriority(itemId, lookup, timeoutMs);
}

/**
 * Resolve the dependency blockers of a work item via `wl dep list`
 * (F3, decision Q3). The outbound `depends-on` edges of the queried item
 * are its blockers; the dep-list edges carry only id/title/status/
 * priority, so each blocker is enriched via `wl show` to obtain the full
 * stage/risk/effort/sortIndex fields the frontier resolution needs
 * (stage→skill mapping + implement caps, Q2). THROWS on a wl or parse
 * failure — the caller's fail-closed catch converts it into a strike
 * (`{ok:false}`), so a dependency look-up failure never masquerades as an
 * empty frontier (AC5: no silent fall-through).
 */
async function fetchCriticalBlockers(cwd: string, itemId: string): Promise<CriticalCandidate[]> {
  const { stdout } = await withTransientRetry(() => getExecFileAsync()(
    'wl',
    buildWlArgs(['dep', 'list', itemId, '--json']),
    { encoding: 'utf8', timeout: DOWNTIME_WL_TIMEOUT_MS },
  ));
  const blockerRefs = parseDepListBlockersOutput(stdout);
  if (blockerRefs === null) throw new Error('wl dep list parse failure');
  const blockers: CriticalCandidate[] = [];
  for (const ref of blockerRefs) {
    const { stdout: showOut } = await withTransientRetry(() => getExecFileAsync()(
      'wl',
      buildWlArgs(['show', ref.id, '--json']),
      { encoding: 'utf8', timeout: DOWNTIME_WL_TIMEOUT_MS },
    ));
    const full = parseShownWorkItem(showOut);
    if (full === null) throw new Error(`wl show parse failure for ${ref.id}`);
    blockers.push(full);
  }
  return blockers;
}

// ── Barrel-internal exports ─────────────────────────────────────────
// Exported for the barrel's internal dispatch paths only (index.ts
// `createDowntimeDeps` / main()); never re-exported by the barrel — they
// stay out of the consumed public surface (same pattern as
// `notifyBackgroundFailure` in index.background.ts). The values themselves are
// defined once in `./assignee-identities.ts` and re-exported above.
export { fetchCriticalBlockers };
