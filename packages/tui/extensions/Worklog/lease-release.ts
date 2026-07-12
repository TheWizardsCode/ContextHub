/**
 * Lease release module for the Worklog Pi extension.
 *
 * Proactively releases the previous session's model lease when a new Pi
 * session is created (via `/new`).  Reads the Local Proxy provider
 * configuration from `~/.pi/agent/models.json` and sends a best-effort
 * HTTP POST to `{baseUrl}/leases/release`.
 *
 * The call is fire-and-forget:
 * - It does not block or delay session startup.
 * - Failures (network errors, non-2xx responses) are silently logged at
 *   debug level only — no user-visible errors.
 * - If the "Local Proxy" provider is not configured, no request is sent.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ── Constants ────────────────────────────────────────────────────────────

/** Path to Pi's model/provider configuration file. */
const MODELS_JSON_PATH = join(homedir(), '.pi', 'agent', 'models.json');

/** The name of the Local Proxy provider in models.json. */
const LOCAL_PROVIDER_NAME = 'Local Proxy';

/** The lease release API endpoint path (appended to the provider's baseUrl). */
const LEASE_RELEASE_PATH = '/leases/release';

// ── Module-level cache ───────────────────────────────────────────────────

/**
 * Cached base URL for the Local Proxy provider.
 * Set once on first successful read, or cleared to force re-read.
 * Module-level cache reduces filesystem reads during repeated calls
 * within the same extension lifecycle.
 */
let _cachedBaseUrl: string | null | undefined = undefined;

/**
 * Reset the cached base URL (for testing).
 *
 * @internal Used by tests to ensure isolation between test cases.
 */
export function _resetLeaseReleaseState(): void {
  _cachedBaseUrl = undefined;
}

// ── Internal helpers ─────────────────────────────────────────────────────

/**
 * Read the Local Proxy base URL from Pi's models.json.
 *
 * Reads `~/.pi/agent/models.json`, parses the provider entries, and
 * extracts the `baseUrl` of the `"Local Proxy"` provider.
 *
 * Returns `null` if:
 * - The file does not exist or cannot be read.
 * - The file is not valid JSON.
 * - The `"Local Proxy"` provider is not found.
 * - The found provider has no `baseUrl` field.
 *
 * @returns The base URL string, or `null` if unavailable.
 */
async function readLocalProxyBaseUrl(): Promise<string | null> {
  // Return cached value if previously resolved
  if (_cachedBaseUrl !== undefined) {
    return _cachedBaseUrl;
  }

  try {
    const content = await readFile(MODELS_JSON_PATH, 'utf-8');
    const config = JSON.parse(content);

    const provider = config?.providers?.[LOCAL_PROVIDER_NAME];
    const baseUrl = provider?.baseUrl;

    if (!baseUrl || typeof baseUrl !== 'string') {
      console.debug(
        `[lease-release] Local Proxy provider "${LOCAL_PROVIDER_NAME}" has no baseUrl in ${MODELS_JSON_PATH}; skipping lease release`,
      );
      _cachedBaseUrl = null;
      return null;
    }

    _cachedBaseUrl = baseUrl;
    return baseUrl;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.debug(
      `[lease-release] Could not read proxy config from ${MODELS_JSON_PATH}: ${message}`,
    );
    _cachedBaseUrl = null;
    return null;
  }
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Proactively release the model lease for a previous session.
 *
 * Reads the Local Proxy base URL from `~/.pi/agent/models.json` and sends
 * a best-effort `POST {baseUrl}/leases/release` with the session identifier.
 *
 * The call is fire-and-forget:
 * - Failures are logged at debug level only (no user-visible errors).
 * - If the Local Proxy is not configured, no request is sent.
 * - If the models.json file cannot be read, no request is sent.
 *
 * @param previousSessionId - The session identifier from the previous
 *   session (value of `previousSessionFile` from the session_start event).
 *   Passed as-is to the proxy.
 */
export async function releaseLease(previousSessionId: string): Promise<void> {
  const baseUrl = await readLocalProxyBaseUrl();

  if (!baseUrl) {
    return;
  }

  const url = `${baseUrl.replace(/\/+$/, '')}${LEASE_RELEASE_PATH}`;
  const body = JSON.stringify({ session_id: previousSessionId });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (!response.ok) {
      console.debug(
        `[lease-release] Lease release request to ${url} returned status ${response.status}`,
      );
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.debug(
      `[lease-release] Lease release request to ${url} failed: ${message}`,
    );
  }
}

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
