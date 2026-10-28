/**
 * local-preference.test.ts — herdr-side per-turn local-preference knob
 * (WL-0MVLJTV03000KIQZ, parent WL-0MVIKRFP0005JDL8 AC4, slice C4).
 *
 * The llama-proxy honours `X-Local-Preference: local-preferred | remote-ok`
 * per request. Herdr conveys the policy to launched pi sessions as the
 * pane-launch environment variable `HERDR_LOCAL_PREFERENCE`, which the
 * Worklog pi extension turns into the request header and records in the
 * route log.
 *
 * Policy defaults: downtime panes default to `remote-ok` (never queue
 * local capacity the operator may need — unattended work goes remote when
 * the local slot is contended) and background/scheduled work also defaults
 * to `remote-ok`. `local-preferred` is the explicit per-deployment opt-in.
 * `local-only` was removed in WL-0MVSI1RX2005O9NE and is NOT an alias —
 * it is rejected like any other invalid value and clamps to `remote-ok`.
 *
 * These specs were authored first (test-first).
 */

import { describe, it, expect } from 'vitest';

const MODULE_SPECIFIER = './local-preference.js';

type LocalPreference = 'local-preferred' | 'remote-ok';
type LocalPreferenceReason = 'operator-setting' | 'priority-low' | 'default';
type LocalPreferenceMode = 'operator-setting' | 'priority-rule';

interface ResolvedDispatchLocalPreference {
  preference: LocalPreference;
  reason: LocalPreferenceReason;
}

interface LocalPreferenceModule {
  LOCAL_PREFERENCE_ENV_VAR: string;
  DOWNTIME_LOCAL_PREFERENCE: LocalPreference;
  BACKGROUND_LOCAL_PREFERENCE: LocalPreference;
  clampDowntimeLocalPreference(value: unknown): LocalPreference;
  isLocalPreference(value: unknown): value is LocalPreference;
  resolveDispatchLocalPreference(priority: unknown, defaultPreference: LocalPreference): LocalPreference;
  resolveDispatchLocalPreferenceDecision(
    priority: unknown,
    localPreference: LocalPreference | undefined,
    mode: LocalPreferenceMode | undefined,
    defaultPreference?: LocalPreference,
  ): ResolvedDispatchLocalPreference | undefined;
}

async function loadModule(): Promise<LocalPreferenceModule> {
  return (await import(MODULE_SPECIFIER)) as unknown as LocalPreferenceModule;
}

describe('local-preference policy (C4-AC1)', () => {
  it('pins the pane-launch env var read by the Worklog pi extension', async () => {
    const m = await loadModule();
    expect(m.LOCAL_PREFERENCE_ENV_VAR).toBe('HERDR_LOCAL_PREFERENCE');
  });

  it('defaults downtime panes to remote-ok and background work to remote-ok', async () => {
    const m = await loadModule();
    expect(m.DOWNTIME_LOCAL_PREFERENCE).toBe('remote-ok');
    expect(m.BACKGROUND_LOCAL_PREFERENCE).toBe('remote-ok');
  });

  it('clamps valid values verbatim', async () => {
    const { clampDowntimeLocalPreference } = await loadModule();
    expect(clampDowntimeLocalPreference('local-preferred')).toBe('local-preferred');
    expect(clampDowntimeLocalPreference('remote-ok')).toBe('remote-ok');
  });

  it('clamps anything else to the downtime default (fail-open, no invented values)', async () => {
    const { clampDowntimeLocalPreference, DOWNTIME_LOCAL_PREFERENCE } = await loadModule();
    for (const bad of [undefined, null, '', 'auto', 'both', 'Local-Preferred', ' remote-ok', 42]) {
      expect(clampDowntimeLocalPreference(bad)).toBe(DOWNTIME_LOCAL_PREFERENCE);
    }
  });

  it('AC1: treats the retired local-only as invalid — clamped to remote-ok, never an alias', async () => {
    const { clampDowntimeLocalPreference, isLocalPreference, DOWNTIME_LOCAL_PREFERENCE } = await loadModule();
    expect(isLocalPreference('local-only')).toBe(false);
    // Deliberately NOT mapped onto local-preferred: the retired value resolves
    // to the fail-open default like any other out-of-alphabet input.
    expect(clampDowntimeLocalPreference('local-only')).toBe(DOWNTIME_LOCAL_PREFERENCE);
    expect(clampDowntimeLocalPreference('local-only')).toBe('remote-ok');
  });
});

describe('priority rule (WL-0MVNUIW77000VYAX AC1)', () => {
  it('maps a low-priority candidate to local-preferred (the only local value)', async () => {
    const { resolveDispatchLocalPreference } = await loadModule();
    expect(resolveDispatchLocalPreference('low', 'remote-ok')).toBe('local-preferred');
    // The rule never derives anything other than the first-class local value.
    expect(resolveDispatchLocalPreference('low', 'local-preferred')).toBe('local-preferred');
  });

  it('returns the deployment default verbatim for every non-low priority', async () => {
    const { resolveDispatchLocalPreference } = await loadModule();
    for (const priority of ['medium', 'high', 'critical']) {
      expect(resolveDispatchLocalPreference(priority, 'remote-ok')).toBe('remote-ok');
      expect(resolveDispatchLocalPreference(priority, 'local-preferred')).toBe('local-preferred');
    }
  });

  it('never invents a value for an absent/unknown priority (fail-open)', async () => {
    const { resolveDispatchLocalPreference } = await loadModule();
    for (const priority of [undefined, null, '', 'urgent', 'LOW', 42, {}]) {
      expect(resolveDispatchLocalPreference(priority, 'remote-ok')).toBe('remote-ok');
      expect(resolveDispatchLocalPreference(priority, 'local-preferred')).toBe('local-preferred');
    }
  });
});

describe('dispatch locality precedence (WL-0MVNUIW77000VYAX AC2/AC4/AC5)', () => {
  it('legacy callers (no mode) resolve nothing — fixed forwarding, no marker fields', async () => {
    const { resolveDispatchLocalPreferenceDecision } = await loadModule();
    expect(resolveDispatchLocalPreferenceDecision('low', 'remote-ok', undefined)).toBeUndefined();
    expect(resolveDispatchLocalPreferenceDecision('low', undefined, undefined)).toBeUndefined();
  });

  it('an explicit operator setting wins over the priority rule', async () => {
    const { resolveDispatchLocalPreferenceDecision } = await loadModule();
    expect(
      resolveDispatchLocalPreferenceDecision('low', 'remote-ok', 'operator-setting'),
    ).toEqual({ preference: 'remote-ok', reason: 'operator-setting' });
    expect(
      resolveDispatchLocalPreferenceDecision('high', 'local-preferred', 'operator-setting'),
    ).toEqual({ preference: 'local-preferred', reason: 'operator-setting' });
  });

  it('the priority rule fires only when the setting was not persisted', async () => {
    const { resolveDispatchLocalPreferenceDecision } = await loadModule();
    expect(
      resolveDispatchLocalPreferenceDecision('low', undefined, 'priority-rule'),
    ).toEqual({ preference: 'local-preferred', reason: 'priority-low' });
    expect(
      resolveDispatchLocalPreferenceDecision('medium', undefined, 'priority-rule'),
    ).toEqual({ preference: 'remote-ok', reason: 'default' });
    expect(
      resolveDispatchLocalPreferenceDecision('high', undefined, 'priority-rule'),
    ).toEqual({ preference: 'remote-ok', reason: 'default' });
    expect(
      resolveDispatchLocalPreferenceDecision('critical', undefined, 'priority-rule'),
    ).toEqual({ preference: 'remote-ok', reason: 'default' });
  });

  it('a rule-mode default of local-preferred is left in place (no priority-low reason)', async () => {
    const { resolveDispatchLocalPreferenceDecision } = await loadModule();
    expect(
      resolveDispatchLocalPreferenceDecision(undefined, undefined, 'priority-rule', 'local-preferred'),
    ).toEqual({ preference: 'local-preferred', reason: 'default' });
  });
});
