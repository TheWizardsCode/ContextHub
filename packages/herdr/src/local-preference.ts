/**
 * local-preference.ts — herdr-side per-turn local-preference policy knob
 * (WL-0MVLJTV03000KIQZ, parent WL-0MVIKRFP0005JDL8 AC4, slice C4).
 *
 * The llama-proxy honours a per-request locality preference carried on the
 * `X-Local-Preference` header (`local-only` = work the operator marks
 * local-first: the proxy refuses immediately instead of silently waiting up
 * to 120 s before falling back; `remote-ok` = background work that may go
 * remote without queuing local capacity). Herdr conveys the policy to
 * launched pi sessions as the pane-launch environment variable
 * `HERDR_LOCAL_PREFERENCE`; the Worklog pi extension turns that variable
 * into the request header and records the response route headers in the
 * bounded route log.
 *
 * Policy defaults (C4-AC1):
 *   - downtime panes → `local-only` (fail fast to remote when the local
 *     slot is contended — the pane is unattended, so an honest refusal is
 *     better than a silent proxy-side wait);
 *   - background/scheduled work → `remote-ok` (never queue local capacity
 *     for unattended work).
 *
 * Both are configurable through the herdr setting `downtimeLocalPreference`
 * (and the `HERDR_LOCAL_PREFERENCE` env var the extension reads), so a
 * producer can flip either default per deployment.
 *
 * Fail-open is mandatory: an unset/empty/invalid setting resolves to the
 * downtime default and never invents a value.
 */

/** The proxy's per-turn locality preference alphabet (fixed wire contract). */
export type LocalPreference = 'local-only' | 'remote-ok';

/** The pane-launch environment variable read by the Worklog pi extension. */
export const LOCAL_PREFERENCE_ENV_VAR = 'HERDR_LOCAL_PREFERENCE';

/** Default for downtime-dispatched panes (C4-AC1). */
export const DOWNTIME_LOCAL_PREFERENCE: LocalPreference = 'local-only';

/** Default for background/scheduled work (C4-AC1). */
export const BACKGROUND_LOCAL_PREFERENCE: LocalPreference = 'remote-ok';

const VALID_PREFERENCES: readonly LocalPreference[] = ['local-only', 'remote-ok'];

/**
 * Clamp a raw `downtimeLocalPreference` setting (or env value) to the
 * preference alphabet. Anything absent/invalid resolves to the downtime
 * default `local-only` — never an invented value.
 */
export function clampDowntimeLocalPreference(value: unknown): LocalPreference {
  return (VALID_PREFERENCES as readonly unknown[]).includes(value)
    ? (value as LocalPreference)
    : DOWNTIME_LOCAL_PREFERENCE;
}
