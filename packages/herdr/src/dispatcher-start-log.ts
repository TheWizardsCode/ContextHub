/**
 * packages/herdr/src/dispatcher-start-log.ts — record the running source
 * identity once per dispatcher start (WL-0MWWMPDVM009LTQR).
 *
 * Companion to `source-identity.ts`: at dispatcher start this writes ONE
 * `kind: 'dispatcher-start'` record to `.worklog/downtime-coordination.log`
 * carrying the loaded commit and process start time, and emits ONE actionable
 * stderr warning when that runtime predates the checkout's `HEAD` (a pane
 * restart is needed to load current code).
 *
 * Fail-closed: a log-write failure is swallowed (freshness observability must
 * never crash the dispatcher) and the warning is best-effort. Identity is
 * optional — an unresolvable checkout still records the start (without source
 * fields) and never warns.
 */

import { appendCoordinationLogEntry } from './downtime-log.js';
import {
  formatStaleSourceWarning,
  sourceIdentityFields,
  type RuntimeSourceIdentity,
} from './source-identity.js';

/** Default warning sink: the plugin's stderr diagnostics stream. */
function defaultWarn(message: string): void {
  try {
    process.stderr.write(`${message}\n`);
  } catch {
    // fail-closed: a broken stderr must never crash the dispatcher
  }
}

/** Injectable seams for {@link logDispatcherStart} (tests). */
export interface DispatcherStartLogDeps {
  /** Coordination-log writer; defaults to `appendCoordinationLogEntry`. */
  append?: typeof appendCoordinationLogEntry;
  /** Warning sink; defaults to a prefixed stderr line. */
  warn?: (message: string) => void;
  /** Clock; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Record one dispatcher start and warn once when the running source is stale.
 *
 * Called exactly once per dispatcher start by the production wiring. Idempotence
 * is the caller's concern (it runs at `main()` startup, not per tick).
 */
export async function logDispatcherStart(
  instanceId: string,
  cwd: string,
  identity: RuntimeSourceIdentity | null,
  deps: DispatcherStartLogDeps = {},
): Promise<void> {
  const append = deps.append ?? appendCoordinationLogEntry;
  const now = deps.now ?? Date.now;
  const warn = deps.warn ?? defaultWarn;
  const warning = identity === null ? null : formatStaleSourceWarning(identity);
  try {
    await append(cwd, {
      kind: 'dispatcher-start',
      operation: 'start',
      instanceId,
      ...sourceIdentityFields(identity),
      at: new Date(now()).toISOString(),
    });
  } catch {
    // fail-closed: startup logging must never crash the dispatcher
  }
  if (warning !== null) warn(warning);
}
