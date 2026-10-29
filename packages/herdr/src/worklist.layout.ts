/**
 * packages/herdr/src/worklist.layout.ts — metadata panel height budget and
 * terminal-size discovery.
 *
 * Single responsibility: the vertical-space budget for the metadata panel
 * (`MIN_META_SHARE`/`MAX_META_SHARE`, `computeMetadataPanelHeight`) and
 * terminal-size discovery (`getTermSize`). `computeDynamicLayout` — which
 * consumes `DisplayRow` → `WorkItem` — deliberately stays in `worklist.ts`:
 * moving it here would make this module import `fetcher.ts`, which imports the
 * barrel back, adding this module to the split guard's recorded cycle
 * (WL-0MVND6DHH008R3LG). Moved verbatim out of `worklist.ts` (parent
 * WL-0MVGKGD2Y0038S6B). No behaviour change.
 */

import type { TermSize } from './worklist.types.js';

// ── Metadata panel sizing ───────────────────────────────────────────────
// The list renderer shows the selected item's metadata in a panel below the
// list. The list takes as much vertical space as its content needs (up to
// the full pane height) and the panel fills the remainder, keeping a small
// minimum — see computeDynamicLayout (WL-0MSQ44MDX008U69J).
// computeMetadataPanelHeight below is retained as a legacy fallback (used by
// metaScrollDown when no dynamic panel height is supplied) from the original
// fixed 20–40% reservation (WL-0MSAYNVBY006LM9X).

/** Minimum share of pane rows reserved for the metadata panel (small panes). */
export const MIN_META_SHARE = 0.2;
/** Maximum share of pane rows reserved for the metadata panel (tall panes). */
export const MAX_META_SHARE = 0.4;

/** Pane height (rows) at which the panel uses the minimum share. */
const META_SHARE_MIN_ROWS = 12;
/** Pane height (rows) at which the panel reaches the maximum share. */
const META_SHARE_MAX_ROWS = 40;

/**
 * Legacy fallback: compute a fixed metadata panel height from the pane rows.
 *
 * The share ramps linearly from MIN_META_SHARE at `META_SHARE_MIN_ROWS` to
 * MAX_META_SHARE at `META_SHARE_MAX_ROWS`. The result is clamped to a
 * minimum of 3 rows. Only used by metaScrollDown when no dynamic panel
 * height is provided; the renderer uses computeDynamicLayout instead.
 *
 * @param rows - Total pane height in rows.
 * @returns Number of panel rows (always < rows).
 */
export function computeMetadataPanelHeight(rows: number): number {
  let share = MIN_META_SHARE;
  if (rows > META_SHARE_MIN_ROWS) {
    const t = Math.min(1, (rows - META_SHARE_MIN_ROWS) / (META_SHARE_MAX_ROWS - META_SHARE_MIN_ROWS));
    share = MIN_META_SHARE + (MAX_META_SHARE - MIN_META_SHARE) * t;
  }
  return Math.max(3, Math.min(Math.round(rows * share), Math.floor(rows * MAX_META_SHARE)));
}

// ── Terminal helpers ─────────────────────────────────────────────────

/**
 * Get current terminal size. Falls back to defaults.
 */
export function getTermSize(): TermSize {
  try {
    // Prefer process.stdout.columns/rows (reflects actual terminal size dynamically)
    if (process.stdout.columns && process.stdout.rows) {
      return { rows: process.stdout.rows, cols: process.stdout.columns };
    }
    // Fallback to env vars
    const rows = parseInt(process.env.LINES || '', 10) || 24;
    const cols = parseInt(process.env.COLUMNS || '', 10) || 80;
    return { rows, cols };
  } catch {
    return { rows: 24, cols: 80 };
  }
}
