/**
 * Auto-downgrade of `critical` priority on terminal work-item transitions.
 *
 * `critical` is a signal for urgent *open* work — it drives `wl next`
 * ordering, TUI selection lists, and dashboards. Once an item is completed
 * (`status: completed`) or enters review (`stage: in_review`), leaving it at
 * `critical` makes finished work compete with genuinely urgent items
 * (WL-0MSJM4EIV001A0V9). This helper downgrades such an item to `high`.
 *
 * Kept in the CLI layer (not `@worklog/shared`) because worktrees resolve
 * `@worklog/shared` to the main checkout's built `dist`, so shared changes are
 * invisible to the worktree test suite; the CLI layer is fully testable here
 * (same rationale as `src/demotion-audit.ts`).
 */

import type { WorkItem } from './types.js';
import type { WorklogDatabase } from './database.js';

/** The priority a terminal `critical` item is downgraded to. */
export const TERMINAL_DOWNGRADE_PRIORITY = 'high' as const;

/**
 * Whether a work item is in a terminal lifecycle state.
 *
 * Terminal items are `completed` (status) or `in_review` (stage). Closing
 * writes `completed`/`done`, which the status check covers.
 *
 * @param item - a work item, or any subset exposing status/stage
 * @returns true when the item is terminal
 */
export function isTerminalState(item: Pick<WorkItem, 'status' | 'stage'>): boolean {
  return item.status === 'completed' || item.stage === 'in_review';
}

/**
 * Downgrade a `critical` work item to `high` when it is in a terminal state.
 *
 * Only `critical` is affected; `high`/`medium`/`low` are left untouched. The
 * caller decides when a *transition* to a terminal state occurred — this
 * helper only inspects the item's current state, so it is called from the
 * explicit terminal-transition sites (`wl update` and `wl close`) and never
 * from the shared `update()` cascade.
 *
 * @param db - the worklog database to read/write
 * @param itemId - id of the work item to check
 * @returns the updated item when a downgrade happened, or `null` when the
 *   item is absent, not `critical`, or not terminal
 */
export function downgradeCriticalIfTerminal(
  db: Pick<WorklogDatabase, 'get' | 'update'>,
  itemId: string,
): WorkItem | null {
  const item = db.get(itemId);
  if (!item) {
    return null;
  }
  if (item.priority !== 'critical') {
    return null;
  }
  if (!isTerminalState(item)) {
    return null;
  }
  return db.update(itemId, { priority: TERMINAL_DOWNGRADE_PRIORITY });
}
