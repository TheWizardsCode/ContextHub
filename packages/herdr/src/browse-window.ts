/**
 * packages/herdr/src/browse-window.ts — the canonical sprint-view window.
 *
 * The `browseItemCount` setting bounds the default worklist ("sprint view",
 * `f-s-s` → `/wl`): `fetchNextItems` renders the mandatory set (all `critical`
 * plus all completed/`in_review`) and enough "other" items to fill
 * `browseItemCount` slots.
 *
 * This leaf module owns the bounds, the default and the clamp so that both the
 * TUI (`settings.ts` / `worklist.ts`) and the downtime dispatcher
 * (`downtime-worker.ts`) resolve the SAME window. `settings.ts` imports
 * constants from `downtime-worker.ts`, so `downtime-worker.ts` cannot import
 * `settings.ts` without creating a top-level evaluation cycle (WL-0MUNS8X97007C9H9 AC1).
 */

/** Minimum allowed browseItemCount. */
export const MIN_BROWSE_ITEM_COUNT = 1;

/** Maximum allowed browseItemCount. */
export const MAX_BROWSE_ITEM_COUNT = 50;

/**
 * Default `browseItemCount` — the sprint-view window when the setting is
 * absent/invalid. Matches `defaultSettings.browseItemCount`.
 */
export const DEFAULT_BROWSE_ITEM_COUNT = 20;

/**
 * Clamp a browseItemCount value to the supported [1, 50] range.
 * Used at load time so persisted/parsed values cannot exceed the bounds.
 */
export function clampBrowseItemCount(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_BROWSE_ITEM_COUNT;
  return Math.min(Math.max(Math.round(value), MIN_BROWSE_ITEM_COUNT), MAX_BROWSE_ITEM_COUNT);
}

/**
 * Resolve the effective sprint-view dispatch window: the live per-root
 * `browseItemCount`, clamped exactly as the TUI worklist does. An
 * absent/invalid value falls back to `DEFAULT_BROWSE_ITEM_COUNT` (20), so the
 * dispatcher head always equals the rendered sprint view (WL-0MUNS8X97007C9H9 AC1).
 */
export function resolveSprintViewWindow(browseItemCount?: number): number {
  return clampBrowseItemCount(browseItemCount ?? DEFAULT_BROWSE_ITEM_COUNT);
}
