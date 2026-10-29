/**
 * packages/herdr/src/worklist.constants.ts — worklist tuning constants, stage
 * and priority maps.
 *
 * Single responsibility: the worklist family's constants — the Ship It release
 * command (`SHIP_IT_COMMAND`), the canonical `wl` CLI stage vocabulary
 * (`STAGES`/`Stage`), the `/wl <stage>` and `/wl --priority` argument maps,
 * `STAGE_COLORS`, the ANSI escape helper and the mouse-input tuning constants
 * (`DOUBLE_CLICK_WINDOW_MS`, `DRAG_THRESHOLD_CELLS`). Moved verbatim out of
 * `worklist.ts` (parent WL-0MVGKGD2Y0038S6B; extraction WL-0MVND6DHH008R3LG).
 * No behaviour change.
 */

// ── Constants ─────────────────────────────────────────────────────────

/**
 * The dev→main release command dispatched by the Ship It shortcut (`S`,
 * WL-0MSGG5N5Z0074TLY). Global release — receives NO work item id. The
 * command must be typed as `ship` + Enter in the confirmation dialog
 * before it is dispatched via the standard command-routing path.
 */
export const SHIP_IT_COMMAND = '/skill:ship release';

// The canonical `wl` CLI stage vocabulary (WL-0MUY1CRBQ007L7AK). Mirrors the
// stages accepted by `wl update`/`wl next` validation (`done` is the
// post-release terminal stage). Do NOT reintroduce `in_progress`/`completed`:
// the CLI no longer accepts them as stages (`status=in-progress` is the
// "actively worked" signal).
export const STAGES = [
  'idea',
  'intake_complete',
  'plan_complete',
  'in_review',
  'done',
] as const;

export type Stage = (typeof STAGES)[number];

// ── /wl <stage> argument map (WL-0MSDT8X1V003206G) ────────────────────
// Maps every accepted /wl stage argument — shorthand aliases and canonical
// stage names — to the internal stage name used for filtering. Restricted to
// the CLI stage vocabulary (WL-0MUY1CRBQ007L7AK): unknown/removed values are
// absent, so `/wl <bogus>` (and `/wl progress`, `/wl completed`) fail soft.
export const STAGE_MAP: Record<string, string> = {
  intake: 'intake_complete',
  plan: 'plan_complete',
  review: 'in_review',
  // Canonical names mapped to themselves for validation
  idea: 'idea',
  intake_complete: 'intake_complete',
  plan_complete: 'plan_complete',
  in_review: 'in_review',
  done: 'done',
};

// ── /wl --priority <priority> map (WL-0MSKC8T46006999S) ────────────────
// Canonical priority names accepted by `/wl --priority <p>` and the
// `f p *` priority-filter chords. Invalid/unknown values fall back
// gracefully (no crash, no filter change), matching `/wl <bogus>`.
export const PRIORITY_MAP: Record<string, string> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
};

// Re-export stage colors from icons for backward compatibility
export const STAGE_COLORS: Record<string, number> = {
  idea: 247,
  intake_complete: 68,
  plan_complete: 172,
  in_review: 220,
  done: 33,
};

/**
 * ANSI escape code helpers.
 */
export const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  reverse: '\x1b[7m',
  underline: '\x1b[4m',
  yellow: '\x1b[33m',
  clear: '\x1b[2J',
  clearLine: '\x1b[2K',
  cursorHome: '\x1b[H',
  cursorUp: (n: number) => `\x1b[${n}A`,
  cursorDown: (n: number) => `\x1b[${n}B`,
  cursorCol: (n: number) => `\x1b[${n}G`,
  fg: (code: number) => `\x1b[38;5;${code}m`,
  bg: (code: number) => `\x1b[48;5;${code}m`,
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  scrollRegion: (top: number, bottom: number) => `\x1b[${top};${bottom}r`,
  // SGR mouse tracking (WL-0MSGHM5BQ0096BNJ AC1): enable/disable sequences
  // for button-event (1000), button-event-motion (1002) and SGR-encoded
  // (1006) reporting, emitted on raw-mode entry / cleanup respectively.
  mouseEnable: '\x1b[?1000h\x1b[?1002h\x1b[?1006h',
  mouseDisable: '\x1b[?1000l\x1b[?1002l\x1b[?1006l',
};

/** Double-click window in ms (WL-0MSGHM5BQ0096BNJ AC3); boundary
 * inclusive (<=). */
export const DOUBLE_CLICK_WINDOW_MS = 400;

/** Minimum pointer displacement (in terminal cells / rows) before a
 * held-button motion event is treated as a drag-to-scroll gesture rather
 * than click jitter.  SGR coordinates are 1-based cell positions so a
 * threshold of 1 row distinguishes deliberate scrolling from incidental
 * movement.  (WL-0MSI72S0Y0060BRK) */
export const DRAG_THRESHOLD_CELLS = 1;
