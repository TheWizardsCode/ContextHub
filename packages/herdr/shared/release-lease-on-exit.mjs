#!/usr/bin/env node
/**
 * release-lease-on-exit.mjs — release the Local Proxy model lease for a
 * pi session that has ended (WL-0MSGI7UIH008USVB).
 *
 * Invoked by packages/herdr/shared/run-pi-agent.sh when the pi session
 * running in a Herdr pane terminates (normal exit, or pane close via
 * `prefix+x` → TERM/HUP). It forwards the pane's pi session id to the
 * shared `releaseLease()` implementation in `@worklog/shared/lease-release`
 * — the SAME code path the Pi extension uses — so the two consumers never
 * drift.
 *
 * Best-effort / fire-and-forget by design:
 * - Exit code is always 0; failures (missing models.json, network errors,
 *   non-2xx responses, unresolvable shared module) are silently ignored
 *   and never surface in the Herdr UI.
 * - If the "Local Proxy" provider is not configured, no request is sent.
 *
 * Usage:
 *   node release-lease-on-exit.mjs <session-id>
 */

import { releaseLease } from '@worklog/shared/lease-release';
import { pathToFileURL } from 'node:url';

/**
 * Abort the release HTTP request after this long. The pane's shell waits
 * for this executor before tearing down, so a hung fetch (e.g. an
 * unreachable proxy) must never delay pane close (WL-0MSGI7UIH008USVB).
 */
const RELEASE_TIMEOUT_MS = 5000;

/**
 * Release the lease for the given pi session id (best-effort, never throws).
 *
 * @param {string|undefined} sessionId - Pi session id from the closed pane;
 *   empty/undefined means "nothing to release".
 */
export async function releaseLeaseOnExit(sessionId) {
  if (!sessionId) {
    return;
  }
  try {
    // releaseLease never throws, but belt-and-suspenders: this must never
    // propagate so the pane's shell wrapper is never blocked.
    await releaseLease(sessionId, { timeoutMs: RELEASE_TIMEOUT_MS });
  } catch {
    // ignored — best-effort only
  }
}

// Run only when executed directly (not when imported by tests).
const isEntryPoint =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isEntryPoint) {
  await releaseLeaseOnExit(process.argv[2]);
  process.exit(0);
}
