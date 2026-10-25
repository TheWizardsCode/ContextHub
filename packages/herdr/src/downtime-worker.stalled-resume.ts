/**
 * packages/herdr/src/downtime-worker.stalled-resume.ts — prefer resuming a
 * stalled pane in place over opening a new one (WL-0MUYMBSA90092QV2).
 *
 * Single responsibility: consult the machine-wide stalled-work scan ONCE and
 * attempt to resume the first candidate, fail-safe at every boundary (an
 * unwired seam, a disabled scan, a thrown scan or every `{resumed:false}`
 * outcome all degrade to "no stalled resume", never a strike).
 *
 * Parent: WL-0MVF3F9A7000HKP7 (decompose the `downtime-worker.ts` god class).
 * Moved verbatim out of `downtime-worker.ts` by WL-0MVLII0NO007JJBA (extract
 * the downtime-worker dispatch pipeline) and re-exported from the barrel.
 * No behaviour change.
 *
 * The stalled scan/resume seams are typed through the pipeline dependency
 * slice (`downtime-worker.dispatch-contract.ts`), while `StalledScanOptions` /
 * `StalledPaneCandidate` are the same declared types the worker uses (moved to
 * `downtime-worker.types.ts` and re-exported by `stalled-work.ts`), so the
 * signature is unchanged for every caller.
 */

import type { DowntimeDispatchDeps } from './downtime-worker.dispatch-contract.js';
import type {
  StalledPaneCandidate,
  StalledScanOptions,
} from './downtime-worker.types.js';

/**
 * Neutral outcome reason when a stalled pane was resumed in place instead of
 * dispatching new work (WL-0MUYMBSA90092QV2 AC1/AC3): the cycle short-circuits
 * with `dispatched:false` and this reason. NEVER a strike, NEVER a cooldown —
 * the next idle tick re-evaluates from scratch.
 */
export const STALLED_RESUME_REASON = 'stalled-resume';

/**
 * Consult the stalled-work scan ONCE and, if it yields a candidate, attempt to
 * resume the first one in place (WL-0MUYMBSA90092QV2 AC1/AC4). Returns true
 * when a stalled pane was successfully resumed — the caller MUST then
 * short-circuit new-item dispatch for the cycle (preference ordering).
 *
 * FAIL-SAFE: unwired deps, a disabled scan, a thrown scan, an unreadable pane
 * list / unparseable output (the production scan resolves an empty list) and
 * every `{resumed:false}` outcome all return false, so the existing dispatch
 * path proceeds unchanged — never a crash, never a duplicate.
 */
export async function resumeStalledWorkIfAble(
  deps: DowntimeDispatchDeps,
  cwd: string,
  opts: StalledScanOptions,
): Promise<boolean> {
  // Unwired deps / disabled scan degrade to normal dispatch (AC2/AC3).
  if (opts.enabled !== true) return false;
  // Host-CPU gate (WL-0MVK0UO3Q002TXW6 AC3): while the host is saturated a
  // resume would WAKE an agent (adding load), so the stalled pane is left
  // untouched until CPU falls below the threshold — the next idle tick
  // resumes normally, unchanged.
  if (opts.cpuSaturated === true) return false;
  if (
    typeof deps.scanStalledPanes !== 'function' ||
    typeof deps.resumeStalledPane !== 'function'
  ) {
    return false;
  }
  let candidates: StalledPaneCandidate[];
  try {
    const scanned = await deps.scanStalledPanes(cwd, opts);
    if (!Array.isArray(scanned)) return false;
    candidates = scanned;
  } catch {
    return false; // fail-safe: never crash dispatch on a broken scan
  }
  for (const candidate of candidates) {
    try {
      const outcome = await deps.resumeStalledPane(candidate, opts);
      if (outcome.resumed) return true;
    } catch {
      // A thrown resume is neutral — try the next candidate, then fall through.
    }
  }
  return false;
}
