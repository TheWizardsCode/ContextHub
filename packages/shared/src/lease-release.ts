/**
 * Shared Local Proxy model-lease release helper (WL-0MSGI7UIH008USVB).
 *
 * Canonical implementation of the best-effort lease release used by both:
 *   - the Pi extension  (packages/tui/extensions/Worklog/lease-release.ts)
 *   - the Herdr plugin's pane-close release executor
 *     (packages/herdr/shared/release-lease-on-exit.mjs)
 *
 * Reads the Local Proxy provider configuration from `~/.pi/agent/models.json`
 * and sends a best-effort HTTP POST to `{baseUrl}/leases/release` with the
 * session identifier of the pi session whose model lease should be released.
 *
 * The call is fire-and-forget:
 * - It never throws and never blocks the caller.
 * - Failures (network errors, non-2xx responses, unreadable config) are
 *   silently logged at debug level only — no user-visible errors.
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
 * Set once on first successful read (or a negative `null` result), or
 * cleared to force re-read. Module-level cache reduces filesystem reads
 * during repeated calls within the same process lifecycle.
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
  // Return cached value if previously resolved (including negative results)
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
 * Options for {@link releaseLease}.
 */
export interface ReleaseLeaseOptions {
  /**
   * Abort the HTTP request after this many milliseconds. The Pi extension
   * path (fire-and-forget inside a running pi process) omits it; the Herdr
   * pane-close executor passes a modest value so a hung fetch (unreachable
   * proxy) never delays pane teardown.
   */
  timeoutMs?: number;
}

/**
 * Proactively release the model lease for a pi session.
 *
 * Reads the Local Proxy base URL from `~/.pi/agent/models.json` and sends
 * a best-effort `POST {baseUrl}/leases/release` with the session identifier.
 *
 * The call is fire-and-forget:
 * - Never throws; failures are logged at debug level only.
 * - If the Local Proxy is not configured, no request is sent.
 * - If the models.json file cannot be read, no request is sent.
 * - If `timeoutMs` is provided, the request aborts after that duration
 *   (logged at debug level, no throw).
 *
 * @param sessionId - The pi session identifier whose lease should be
 *   released (the value pi sends in its session-affinity headers — the
 *   same value the proxy keys the dispatch lease with). Passed as-is to
 *   the proxy.
 * @param options - Optional release options (e.g. a request timeout).
 */
export async function releaseLease(
  sessionId: string,
  options: ReleaseLeaseOptions = {},
): Promise<void> {
  // The proxy rejects empty/missing session ids with 400 (LP-0MRFOF7XO003T7CT);
  // skip the pointless request instead of firing a guaranteed-failing POST.
  if (!sessionId || !sessionId.trim()) {
    console.debug('[lease-release] Empty session id; skipping lease release');
    return;
  }

  const baseUrl = await readLocalProxyBaseUrl();

  if (!baseUrl) {
    return;
  }

  const url = `${baseUrl.replace(/\/+$/, '')}${LEASE_RELEASE_PATH}`;
  const body = JSON.stringify({ session_id: sessionId });

  const signal =
    options.timeoutMs !== undefined
      ? AbortSignal.timeout(options.timeoutMs)
      : undefined;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      ...(signal !== undefined ? { signal } : {}),
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
