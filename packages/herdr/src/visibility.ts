/**
 * packages/herdr/src/visibility.ts — Pane visibility detection
 *
 * Determines whether the current herdr pane is visible so the worklist TUI
 * can pause auto-refresh/auto-sync when its TAB is hidden.
 *
 * Visibility signal: herdr sets `HERDR_TAB_ID` (plus `HERDR_PANE_ID` /
 * `HERDR_WORKSPACE_ID` / `HERDR_BIN_PATH`) for panes it spawns; a hidden
 * (non-focused) tab reports `result.tab.focused === false` from
 * `herdr tab get <id>`. Tab focus is the visibility signal — a pane is
 * visible when its TAB is focused, regardless of which pane in the tab
 * holds keyboard focus (multi-pane split fix, WL-0MSJNJPRM009RM35). There
 * is NO pane-focus fallback (approved scope); a pane zoomed-over within a
 * focused tab is therefore treated as visible (documented limitation).
 *
 * Fail-open design: when visibility cannot be determined (no `HERDR_TAB_ID`,
 * CLI missing/erroring, unparseable output) the pane is treated as visible
 * so polling proceeds exactly as today. Standalone runs without herdr
 * context are unaffected.
 */

import { getExecFileAsync } from './fetcher.js';

// ── Constants ─────────────────────────────────────────────────────────

/** Default TTL for the PollGate memoizer (ms). Refresh + sync ticks in one
 * cycle share a single `herdr tab get` call. */
export const DEFAULT_POLL_GATE_TTL_MS = 2000;

// ── isPaneVisible ─────────────────────────────────────────────────────

/**
 * Check whether the current herdr pane's tab is visible (focused).
 *
 * Returns true (fail-open) when:
 *  - `HERDR_TAB_ID` is not set (standalone mode — polling as today)
 *  - The herdr CLI is missing, exits non-zero, or returns unparseable output
 *
 * Returns false only when `herdr tab get <id>` definitively reports
 * `result.tab.focused === false`.
 *
 * Uses the injectable exec seam (setExecFileAsync) from fetcher.ts — no
 * real process spawns in tests.
 */
export async function isPaneVisible(): Promise<boolean> {
  const tabId = process.env.HERDR_TAB_ID;
  if (!tabId) return true;

  const bin = process.env.HERDR_BIN_PATH ?? 'herdr';
  try {
    const execFileAsync = getExecFileAsync();
    const result = await execFileAsync(bin, ['tab', 'get', tabId], {
      maxBuffer: 1024 * 1024,
    });
    const payload = extractTabGetPayload(result.stdout);
    const focused = payload?.result?.tab?.focused;
    if (typeof focused === 'boolean') return focused;
    return true; // unparseable / unexpected shape → fail open
  } catch {
    return true; // CLI missing / non-zero exit → fail open
  }
}

/**
 * Extract the JSON object from herdr CLI output. The CLI may prefix the
 * envelope with log lines, so scan for the first `{` like fetcher.ts.
 */
function extractTabGetPayload(raw: string): { result?: { tab?: { focused?: unknown } } } | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(raw.slice(start)) as { result?: { tab?: { focused?: unknown } } };
  } catch {
    return null;
  }
}

// ── PollGate ──────────────────────────────────────────────────────────

/**
 * A small TTL memoizer around a visibility check.
 *
 * Multiple auto-refresh/auto-sync ticks in one cycle share a single
 * underlying check (e.g. one `herdr tab get` exec within the TTL).
 * Fails open: if the underlying check throws, `visible()` returns true
 * (polling continues) so transient herdr CLI errors never stall the TUI.
 */
export class PollGate {
  private cachedAt = 0;
  private cachedVisible = true;

  /**
   * @param check - Async visibility check (defaults to isPaneVisible).
   * @param ttlMs - Cache TTL in milliseconds.
   */
  constructor(
    private readonly check: () => Promise<boolean> = isPaneVisible,
    private readonly ttlMs: number = DEFAULT_POLL_GATE_TTL_MS,
  ) {}

  /**
   * Return whether the pane is currently visible, memoized within the TTL.
   * Never throws — fails open (returns true) on check errors.
   */
  async visible(): Promise<boolean> {
    const now = Date.now();
    if (now - this.cachedAt < this.ttlMs) {
      return this.cachedVisible;
    }
    try {
      this.cachedVisible = await this.check();
    } catch {
      this.cachedVisible = true; // fail open
    }
    this.cachedAt = Date.now();
    return this.cachedVisible;
  }
}
