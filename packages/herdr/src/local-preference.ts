/**
 * local-preference.ts — herdr-side per-turn local-preference policy knob
 * (WL-0MVLJTV03000KIQZ, parent WL-0MVIKRFP0005JDL8 AC4, slice C4).
 *
 * The llama-proxy honours a per-request locality preference carried on the
 * `X-Local-Preference` header (`local-preferred` = work the operator marks
 * local-first: the prompt stays on the local model while it fits and is
 * *deferred* — a retryable 429 with `Retry-After`, never a silent remote
 * fallback — when the local slot is contended; `remote-ok` = background work
 * that may go remote without queuing local capacity). Herdr conveys the policy
 * to launched pi sessions as the pane-launch environment variable
 * `HERDR_LOCAL_PREFERENCE`; the Worklog pi extension turns that variable into
 * the request header and records the response route headers in the bounded
 * route log.
 *
 * Policy defaults:
 *   - downtime panes → `remote-ok` (never queue local capacity the
 *     operator may need for interactive work — unattended backlog goes
 *     remote when the local slot is contended);
 *   - background/scheduled work → `remote-ok` (never queue local capacity
 *     for unattended work).
 *
 * `local-preferred` is the explicit per-deployment opt-in: an operator who
 * wants every dispatched prompt to stay local while it fits that capacity sets
 * `downtimeLocalPreference: 'local-preferred'` and every dispatch path keeps
 * it verbatim.
 *
 * `local-only` was **removed** (WL-0MVSI1RX2005O9NE) — it is not a deprecated
 * alias and is not normalised onto `local-preferred`. `isLocalPreference` is
 * the single strict validation gate, so a legacy `local-only` setting is
 * treated exactly like any other invalid value: it clamps to the fail-open
 * default `remote-ok` (and loses explicitness). Operators migrating an older
 * deployment rewrite the setting to `local-preferred`.
 *
 * Both valid values are configurable through the herdr setting
 * `downtimeLocalPreference` (and the `HERDR_LOCAL_PREFERENCE` env var the
 * extension reads), so a producer can flip either default per deployment.
 *
 * Priority rule (WL-0MVNUIW77000VYAX): cheap work should absorb contention on
 * the local slot instead of competing for remote capacity, so a `low`-priority
 * candidate is dispatched `local-preferred` while every other priority keeps
 * the deployment default. The rule LAYERS ON TOP of WL-0MVNUHWH500196K1's
 * `remote-ok` default and is applied at the dispatch boundary
 * (`dispatchClaimedTier`) through the single-dispatch resolution below.
 *
 * Precedence (highest first):
 *   1. an EXPLICIT operator setting (`downtimeLocalPreference` persisted as a
 *      valid `local-preferred`/`remote-ok`) wins for every dispatch — the
 *      priority rule is bypassed and the marker records `operator-setting`;
 *   2. the priority rule — `low` → `local-preferred`, everything else →
 *      `DOWNTIME_LOCAL_PREFERENCE` (`remote-ok`); the marker records
 *      `priority-low` / `default`;
 *   3. the deployment default — the same `remote-ok` constant, used when no
 *      priority is known (scheduled prompts have no work item).
 *
 * Fail-open is mandatory: an unset/empty/invalid setting resolves to the
 * downtime default (`remote-ok`) and never invents a value. Legacy callers
 * that pass a preference WITHOUT the dispatch mode opt-in keep forwarding it
 * verbatim (byte-identical launch, no marker fields).
 */

/** The proxy's per-turn locality preference alphabet (fixed wire contract). */
export type LocalPreference = 'local-preferred' | 'remote-ok';

/** The pane-launch environment variable read by the Worklog pi extension. */
export const LOCAL_PREFERENCE_ENV_VAR = 'HERDR_LOCAL_PREFERENCE';

/**
 * Default for downtime-dispatched panes (WL-0MVNUHWH500196K1). `remote-ok`
 * lets unattended downtime work go remote rather than stall on a contended
 * local slot; `local-preferred` is the explicit per-deployment opt-in.
 */
export const DOWNTIME_LOCAL_PREFERENCE: LocalPreference = 'remote-ok';

/** Default for background/scheduled work (C4-AC1). */
export const BACKGROUND_LOCAL_PREFERENCE: LocalPreference = 'remote-ok';

const VALID_PREFERENCES: readonly LocalPreference[] = ['local-preferred', 'remote-ok'];

/** True when `value` is one of the two valid wire/settings values. */
export function isLocalPreference(value: unknown): value is LocalPreference {
  return (VALID_PREFERENCES as readonly unknown[]).includes(value);
}

/**
 * Clamp a raw `downtimeLocalPreference` setting (or env value) to the
 * preference alphabet. Anything absent/invalid — including the retired
 * `local-only`, which is deliberately NOT mapped onto `local-preferred` —
 * resolves to the downtime default `remote-ok` (`DOWNTIME_LOCAL_PREFERENCE`),
 * never an invented value.
 */
export function clampDowntimeLocalPreference(value: unknown): LocalPreference {
  return isLocalPreference(value) ? value : DOWNTIME_LOCAL_PREFERENCE;
}

/**
 * Machine-readable reason a dispatch's locality preference resolved to its
 * value (WL-0MVNUIW77000VYAX AC5), recorded on the dispatch marker:
 *
 *  - `operator-setting` — the operator persisted `downtimeLocalPreference`, so
 *    that value was forwarded for every dispatch regardless of priority;
 *  - `priority-low` — no persisted setting and the candidate's priority is
 *    `low`, so the priority rule chose `local-preferred`;
 *  - `default` — no persisted setting and the priority rule left the
 *    deployment default (`remote-ok`) in place.
 */
export type LocalPreferenceReason = 'operator-setting' | 'priority-low' | 'default';

/**
 * How a dispatch boundary should derive a pane's locality preference
 * (WL-0MVNUIW77000VYAX AC4). Only the plugin's `config()` sets it — a caller
 * that omits the mode keeps the legacy behaviour (forward `localPreference`
 * verbatim, add no marker fields):
 *
 *  - `operator-setting` — the persisted setting wins; forward it verbatim and
 *    record `operator-setting`;
 *  - `priority-rule` — apply the priority rule against the supplied value (or
 *    the deployment default when none was supplied).
 */
export type LocalPreferenceMode = 'operator-setting' | 'priority-rule';

/** A resolved preference plus the machine-readable reason for it. */
export interface ResolvedDispatchLocalPreference {
  preference: LocalPreference;
  reason: LocalPreferenceReason;
}

/**
 * Pure priority rule (WL-0MVNUIW77000VYAX AC1): `low` → `local-preferred`,
 * every other input (`medium`, `high`, `critical`, `undefined`, `null`, `''`,
 * an unknown string) → `defaultPreference` verbatim. No IO, never throws.
 */
export function resolveDispatchLocalPreference(
  priority: unknown,
  defaultPreference: LocalPreference,
): LocalPreference {
  return priority === 'low' ? 'local-preferred' : defaultPreference;
}

/**
 * Resolve a dispatch's locality preference and WHY (WL-0MVNUIW77000VYAX
 * AC2/AC4/AC5) — the single decision point for every dispatch path.
 *
 * Returns `undefined` for a legacy caller (no `mode`): the caller forwards its
 * `localPreference` verbatim and writes no marker fields, keeping hand-built
 * configs byte-identical. Otherwise the precedence is explicit operator
 * setting > priority rule > deployment default.
 */
export function resolveDispatchLocalPreferenceDecision(
  priority: unknown,
  localPreference: LocalPreference | undefined,
  mode: LocalPreferenceMode | undefined,
  defaultPreference: LocalPreference = DOWNTIME_LOCAL_PREFERENCE,
): ResolvedDispatchLocalPreference | undefined {
  if (mode === undefined) return undefined;
  if (mode === 'operator-setting') {
    return {
      preference: localPreference ?? defaultPreference,
      reason: 'operator-setting',
    };
  }
  return {
    preference: resolveDispatchLocalPreference(
      priority,
      localPreference ?? defaultPreference,
    ),
    reason: priority === 'low' ? 'priority-low' : 'default',
  };
}
