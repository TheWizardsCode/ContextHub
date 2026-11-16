/**
 * packages/herdr/src/ship-guard.ts — Ship It pre-dialog guard (WL-0MUD6DDZC007ZSIW)
 *
 * Pure, injectable helpers that prevent the Ship It confirmation dialog from
 * opening when live agent panes are working on project work items.  On confirm
 * the caller writes the Code Freeze marker (see `code-freeze.ts` for the
 * marker contract).
 *
 * Key decisions:
 *   - A pane blocks ship mode when it carries a work-item ID that belongs to
 *     the current project's worklog AND its agent is live (present and status
 *     is not `done` / `exited`).
 *   - Pane work-item IDs are matched against the FULL set of work-item IDs in
 *     the project's worklog (not just in-progress ones) — a pane whose
 *     carried item is completed still blocks because the pane is still open
 *     (producer confirmed this is the intended semantics).
 *   - When `wl list` or `herdr pane list` is unavailable the guard fails
 *     safe: no dialog is opened (the caller must show the blocked notice).
 *   - All logic is pure and injectable — callers pass command-output strings;
 *     no direct file I/O or side effects.
 */

import {
  findBlockingPanes,
  parseHerdrPaneListOutput,
  type BlockingPane,
} from './pane-discovery.js';
// The blocking-pane record type is canonical in `pane-discovery.ts`; kept
// importable from here so ship-guard consumers/tests keep one import.
export type { BlockingPane } from './pane-discovery.js';

// ── Types ─────────────────────────────────────────────────────────────────

/** The result of a guard check. */
export interface ShipGuardResult {
  /** Whether the guard succeeded (both queries returned data). */
  ok: boolean;
  /** Human-readable reason when `ok` is false. */
  reason?: string;
  /** The set of panes that block ship mode (empty when clear). */
  blockingPanes: BlockingPane[];
}

// ── Pure helpers (injectable seams) ──────────────────────────────────────

/**
 * Parse the stdout of `wl list --json` into a `Set<string>` of all
 * work-item IDs in the current project's worklog.
 *
 * Accepts the `{ workItems: [...] }` shape emitted by `wl list --json`.
 * Entries without a usable `id` field are skipped.  Malformed JSON or
 * output without a `workItems` array yields `null` (the caller treats
 * this as a failed query → fail-safe).
 *
 * @param wlListOutput - Raw stdout from `wl list --json`.
 * @returns A set of work-item IDs, or `null` on parse failure.
 */
export function parseWorklogWorkItemIds(wlListOutput: string): Set<string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(wlListOutput);
  } catch {
    return null;
  }

  const items =
    parsed !== null &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { workItems?: unknown }).workItems)
      ? (parsed as { workItems: unknown[] }).workItems
      : null;

  if (items === null) return null;

  const ids = new Set<string>();
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null) continue;
    const o = raw as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id : undefined;
    if (typeof id === 'string' && id.length > 0) {
      ids.add(id);
    }
  }
  return ids;
}

/**
 * Collect the set of panes whose label carries a project work-item ID and
 * whose agent is live (agent present, status not `done` / `exited`).
 *
 * This is the core blocking-pane filter — delegated to
 * `pane-discovery.ts::findBlockingPanes` (WL-0MWHWH6XL0025YX2 AC1):
 *   1. Extract work-item IDs from the pane label via the canonical
 *      `extractWorkItemIdsFromText` scan (in `pane-label.ts`).
 *   2. Check whether each ID is in the `projectIds` set.
 *   3. Check whether the pane's agent is live (shared `isPaneAgentLive`).
 *
 * A pane blocks ship mode when:
 *   - Its label carries a project work-item ID, AND
 *   - Its agent is present AND its agentStatus is not `done` / `exited`.
 *
 * Panes with no agent, or a terminal agent status, do NOT block. An
 * unparseable pane list yields `[]` — the caller checks the `ok` flag of
 * `runShipGuard` and fails safe (no dialog is opened) when it cannot verify.
 *
 * @param projectIds   Set of work-item IDs from the current project's worklog.
 * @param paneListOutput Raw stdout from `herdr pane list`.
 * @returns Array of blocking panes (may be empty when no panes are blocking).
 */
export function listBlockingPanes(
  projectIds: ReadonlySet<string>,
  paneListOutput: string,
): BlockingPane[] {
  const records = parseHerdrPaneListOutput(paneListOutput);
  if (records === null) {
    // Query failure → the caller checks the ok flag and fails safe.
    return [];
  }
  return findBlockingPanes(records, projectIds);
}

/**
 * Format a human-readable notice listing the blocking panes.
 *
 * The notice includes:
 *   - A header explaining why ship mode is blocked.
 *   - Each blocking pane's work-item ID and label (where available).
 *   - An instruction to close the panes and retry.
 *
 * @param blockingPanes - Array of `BlockingPane` from `listBlockingPanes`.
 * @param queryFailed   - When true the guard could not verify (queries failed).
 * @param queryFailureReason - Optional machine reason from `runShipGuard`
 *   naming WHICH query failed ("worklog list unavailable" vs "pane list
 *   unavailable"). When supplied the notice names the failing query so the
 *   operator knows what to retry (WL-0MUEK7H39008VVUF).
 * @returns Formatted notice text.
 */
export function formatBlockedNotice(
  blockingPanes: BlockingPane[],
  queryFailed?: boolean,
  queryFailureReason?: string,
): string {
  const lines: string[] = [];

  if (queryFailed) {
    lines.push('⚠ Cannot verify pane state — cannot enter ship mode.');
    lines.push('');
    if (queryFailureReason && queryFailureReason.trim().length > 0) {
      // Name the failing query so the operator can tell whether the worklog
      // or the herdr pane list is unavailable (WL-0MUEK7H39008VVUF AC3).
      lines.push(`Reason: ${queryFailureReason}.`);
      lines.push('Please retry once the failing query is available.');
    } else {
      lines.push('Unable to check whether other panes are working on project items.');
      lines.push('Please retry when the herdr CLI or worklog is available.');
    }
    return lines.join('\n');
  }

  if (blockingPanes.length === 0) {
    return ''; // Should never happen when called with blocking panes.
  }

  lines.push('⚠ Ship mode is blocked — other panes are working on project items.');
  lines.push('');
  lines.push('Blocking panes:');
  for (const pane of blockingPanes) {
    const detail = pane.label
      ? `  • ${pane.workItemId} (${pane.label})`
      : `  • ${pane.workItemId}`;
    lines.push(detail);
  }
  lines.push('');
  lines.push(
    'Close the blocking panes and retry.  Ship mode cannot enter until ' +
    'all panes carrying project work-item IDs have been closed.',
  );
  return lines.join('\n');
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Run the full ship guard: collect project IDs, list blocking panes, and
 * return the result.
 *
 * This is a convenience wrapper that combines the pure helpers with the
 * command execution logic.  Callers that inject their own query results
 * can call the pure helpers directly.
 *
 * @param wlListOutput - Raw stdout from `wl list --json`.
 * @param paneListOutput - Raw stdout from `herdr pane list`.
 * @returns The guard result with blocking panes or a failure reason.
 */
export function runShipGuard(
  wlListOutput: string,
  paneListOutput: string,
): ShipGuardResult {
  const projectIds = parseWorklogWorkItemIds(wlListOutput);
  if (projectIds === null) {
    return {
      ok: false,
      reason: 'worklog list unavailable — cannot verify pane state',
      blockingPanes: [],
    };
  }

  const records = parseHerdrPaneListOutput(paneListOutput);
  if (records === null) {
    // Pane query failed — fail safe: treat all panes as blocking.
    return {
      ok: false,
      reason: 'pane list unavailable — cannot verify pane state',
      blockingPanes: [],
    };
  }

  return {
    ok: true,
    blockingPanes: findBlockingPanes(records, projectIds),
  };
}
