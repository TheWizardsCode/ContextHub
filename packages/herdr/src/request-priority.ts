/**
 * request-priority.ts — herdr-side request-priority contract
 * (WL-0MVF3Q3VL000UNCN, parent WL-0MVE1NZ4J000H5NH AC2/AC3).
 *
 * The LLM proxy retired its global fast/cheap operating mode in favour of a
 * per-request `X-Priority` header (`low|medium|high`, absent → the proxy's
 * own `medium` default). Herdr therefore maps the dispatched work item's
 * priority onto a *request* priority and conveys it to the launched process
 * as the pane-launch environment variable `HERDR_REQUEST_PRIORITY`, which the
 * globally installed Worklog pi extension turns into the header.
 *
 * The two tables are fixed by the parent ACs:
 *
 *   Interactive — `low` → `medium`, `medium`/`high`/`critical` → `high`,
 *                 no resolvable item (absent/unknown) → `high`.
 *   Downtime    — `low`/`medium`/`high` unchanged, `critical` → `high`,
 *                 unknown/absent → `medium`.
 *
 * Interactive dispatch is fail-open: a missing id, a lookup failure or a
 * timeout must never abort a dispatch — it falls back to the interactive
 * default (`high`).
 */

/** The proxy's request-priority alphabet (fixed wire contract). */
export type RequestPriority = 'low' | 'medium' | 'high';

/** The pane-launch environment variable read by the Worklog pi extension. */
export const REQUEST_PRIORITY_ENV_VAR = 'HERDR_REQUEST_PRIORITY';

/** Default budget for the interactive work-item priority lookup (ms). */
export const INTERACTIVE_PRIORITY_LOOKUP_TIMEOUT_MS = 2_000;

/** Interactive default when no work item can be resolved (producer Q3 = `high`). */
export const INTERACTIVE_DEFAULT_REQUEST_PRIORITY: RequestPriority = 'high';

/** Downtime default for an unknown/absent candidate priority. */
export const DOWNTIME_DEFAULT_REQUEST_PRIORITY: RequestPriority = 'medium';

/**
 * Map a work item's priority onto the interactive request priority.
 *
 * Interactive dispatches are operator-driven, so anything but `low` is
 * served as `high` (the item skips the contention queue). An absent or
 * unrecognised priority falls back to the interactive default `high`.
 *
 * @param workItemPriority - Raw work-item priority (`low|medium|high|critical`).
 * @returns The request priority to send to the proxy.
 */
export function mapInteractiveRequestPriority(
  workItemPriority?: string | null,
): RequestPriority {
  switch (workItemPriority) {
    case 'low':
      return 'medium';
    case 'medium':
    case 'high':
    case 'critical':
      return 'high';
    default:
      return INTERACTIVE_DEFAULT_REQUEST_PRIORITY;
  }
}

/**
 * Map a work item's priority onto the downtime (background) request priority.
 *
 * Unattended work is polite: `low`/`medium`/`high` pass through unchanged and
 * `critical` is raised to `high`. An absent or unrecognised priority falls
 * back to the proxy's default `medium`.
 *
 * @param priority - Raw work-item priority (`low|medium|high|critical`).
 * @returns The request priority to send to the proxy.
 */
export function mapDowntimeRequestPriority(
  priority?: string | null,
): RequestPriority {
  switch (priority) {
    case 'low':
      return 'low';
    case 'high':
    case 'critical':
      return 'high';
    case 'medium':
      return 'medium';
    default:
      return DOWNTIME_DEFAULT_REQUEST_PRIORITY;
  }
}

/**
 * Resolve the interactive request priority for a dispatch.
 *
 * Fail-open by contract: no work-item id, a lookup that returns nothing, a
 * lookup that throws, or a lookup that exceeds the timeout all resolve the
 * interactive default (`high`) — the dispatch never blocks on or aborts from
 * priority resolution. When there is no id the lookup is not called at all.
 *
 * @param workItemId - The dispatched work item's id (may be absent).
 * @param lookup - Resolves the work item's raw priority (e.g. `wl show`).
 * @param timeoutMs - Lookup budget in milliseconds.
 * @returns The mapped request priority.
 */
export async function resolveInteractiveRequestPriority(
  workItemId: string | undefined | null,
  lookup: (id: string) => string | null | undefined | Promise<string | null | undefined>,
  timeoutMs: number = INTERACTIVE_PRIORITY_LOOKUP_TIMEOUT_MS,
): Promise<RequestPriority> {
  if (!workItemId) return INTERACTIVE_DEFAULT_REQUEST_PRIORITY;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<'__timeout__'>((resolve) => {
      timer = setTimeout(() => resolve('__timeout__'), Math.max(0, timeoutMs));
    });
    const result = await Promise.race([Promise.resolve(lookup(workItemId)), timeout]);
    if (result === '__timeout__') return INTERACTIVE_DEFAULT_REQUEST_PRIORITY;
    return mapInteractiveRequestPriority(result);
  } catch {
    // Fail-open: a lookup failure never blocks or aborts the dispatch.
    return INTERACTIVE_DEFAULT_REQUEST_PRIORITY;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
