/**
 * Lease release module for the Worklog Pi extension.
 *
 * Proactively releases the previous session's model lease when a new Pi
 * session is created (via `/new`).  The release logic itself (reading the
 * Local Proxy provider configuration from `~/.pi/agent/models.json` and
 * sending a best-effort HTTP POST to `{baseUrl}/leases/release`) lives in
 * the shared module `@worklog/shared/lease-release` (WL-0MSGI7UIH008USVB)
 * so the Pi extension and the Herdr plugin's pane-close release executor
 * never drift.
 *
 * The call is fire-and-forget:
 * - It does not block or delay session startup.
 * - Failures (network errors, non-2xx responses) are silently logged at
 *   debug level only — no user-visible errors.
 * - If the "Local Proxy" provider is not configured, no request is sent.
 */

import { releaseLease, _resetLeaseReleaseState } from '@worklog/shared/lease-release';

// Re-export the shared implementation so existing consumers (and the unit
// tests in this directory) keep importing this module as the single entry
// point for the extension's lease-release behavior.
export { releaseLease, _resetLeaseReleaseState };

/**
 * Register the lease release session_start handler with a Pi extension instance.
 *
 * Sets up a listener for `session_start` that calls `releaseLease()` when:
 * - `event.reason === "new"` (session replaced via `/new`)
 * - `event.previousSessionFile` is present
 *
 * The call is fire-and-forget and does not block session startup.
 *
 * @param pi - The ExtensionAPI instance
 */
export function registerLeaseRelease(pi: {
  on: (event: string, handler: (event: any, ctx: any) => void | Promise<void>) => void;
}): void {
  // The handler is async so the event loop drains microtasks between turns.
  // From Pi's perspective this is still fire-and-forget because the event
  // system does not await the handler's returned promise.
  pi.on('session_start', async (event: any, _ctx: any) => {
    if (event.reason === 'new' && event.previousSessionFile) {
      // Fire-and-forget from Pi's perspective, but we await internally so
      // the microtask queue is drained properly (helpful for tests).
      // releaseLease already catches all errors internally.
      await releaseLease(event.previousSessionFile);
    }
  });
}
