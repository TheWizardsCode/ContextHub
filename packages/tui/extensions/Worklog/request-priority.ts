/**
 * request-priority.ts — convey the pane-launch request priority to the LLM
 * proxy (WL-0MVF3Q2YC003RJPF, parent WL-0MVE1NZ4J000H5NH AC4).
 *
 * The proxy retired its global fast/cheap operating mode in favour of a
 * per-request `X-Priority` header (`low|medium|high`, absent → the proxy
 * applies its own `medium` default). Herdr resolves the dispatched work
 * item's priority and launches the pi session with the pane-launch
 * environment variable `HERDR_REQUEST_PRIORITY`; this module turns that
 * variable into the provider request header on every request.
 *
 * Fail-open is mandatory: an unset, empty or invalid value leaves the header
 * map untouched (the proxy's `medium` default applies) — never an assumed
 * `high`. A broken hook must never break a provider request.
 *
 * The value is read per request (not cached at registration) so a session
 * that is re-launched with a different priority is never stale.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** The proxy's request-priority alphabet (fixed wire contract). */
export type RequestPriority = 'low' | 'medium' | 'high';

/** The pane-launch environment variable herdr sets for a dispatched item. */
export const REQUEST_PRIORITY_ENV_VAR = 'HERDR_REQUEST_PRIORITY';

/** The provider request header consumed by the proxy. */
export const REQUEST_PRIORITY_HEADER = 'X-Priority';

const VALID_PRIORITIES: readonly RequestPriority[] = ['low', 'medium', 'high'];

/**
 * Validate a raw `HERDR_REQUEST_PRIORITY` value.
 *
 * @param env - Environment mapping to read (defaults to `process.env`).
 * @returns The accepted priority, or `undefined` when absent/empty/invalid.
 */
export function resolveRequestPriority(
  env: Record<string, string | undefined> = process.env,
): RequestPriority | undefined {
  const raw = env[REQUEST_PRIORITY_ENV_VAR];
  if (typeof raw !== 'string' || raw === '') return undefined;
  return (VALID_PRIORITIES as readonly string[]).includes(raw)
    ? (raw as RequestPriority)
    : undefined;
}

/** Minimal shape of the header map mutated by the `before_provider_headers` hook. */
type MutableHeaders = Record<string, string | null | undefined>;

/**
 * Register the `before_provider_headers` hook that injects `X-Priority`.
 *
 * The hook mutates the assembled header map in place (the pi extension
 * contract) and is a no-op when the environment variable is unset or
 * invalid.
 *
 * @param pi - The pi extension API.
 */
export function registerRequestPriority(pi: ExtensionAPI): void {
  pi.on('before_provider_headers', (event) => {
    const priority = resolveRequestPriority();
    if (priority === undefined) return;
    (event.headers as MutableHeaders)[REQUEST_PRIORITY_HEADER] = priority;
  });
}
