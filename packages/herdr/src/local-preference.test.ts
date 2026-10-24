/**
 * local-preference.test.ts — herdr-side per-turn local-preference knob
 * (WL-0MVLJTV03000KIQZ, parent WL-0MVIKRFP0005JDL8 AC4, slice C4).
 *
 * The llama-proxy honours `X-Local-Preference: local-only | remote-ok` per
 * request. Herdr conveys the policy to launched pi sessions as the
 * pane-launch environment variable `HERDR_LOCAL_PREFERENCE`, which the
 * Worklog pi extension turns into the request header and records in the
 * route log.
 *
 * Policy defaults (C4-AC1): downtime panes default to `local-only` (fail
 * fast to remote when the local slot is contended) and background/scheduled
 * work defaults to `remote-ok` (never queue local capacity for unattended
 * work). Both are configurable through the setting/env.
 *
 * These specs were authored first (test-first).
 */

import { describe, it, expect } from 'vitest';

const MODULE_SPECIFIER = './local-preference.js';

type LocalPreference = 'local-only' | 'remote-ok';

interface LocalPreferenceModule {
  LOCAL_PREFERENCE_ENV_VAR: string;
  DOWNTIME_LOCAL_PREFERENCE: LocalPreference;
  BACKGROUND_LOCAL_PREFERENCE: LocalPreference;
  clampDowntimeLocalPreference(value: unknown): LocalPreference;
}

async function loadModule(): Promise<LocalPreferenceModule> {
  return (await import(MODULE_SPECIFIER)) as unknown as LocalPreferenceModule;
}

describe('local-preference policy (C4-AC1)', () => {
  it('pins the pane-launch env var read by the Worklog pi extension', async () => {
    const m = await loadModule();
    expect(m.LOCAL_PREFERENCE_ENV_VAR).toBe('HERDR_LOCAL_PREFERENCE');
  });

  it('defaults downtime panes to local-only and background work to remote-ok', async () => {
    const m = await loadModule();
    expect(m.DOWNTIME_LOCAL_PREFERENCE).toBe('local-only');
    expect(m.BACKGROUND_LOCAL_PREFERENCE).toBe('remote-ok');
  });

  it('clamps valid values verbatim', async () => {
    const { clampDowntimeLocalPreference } = await loadModule();
    expect(clampDowntimeLocalPreference('local-only')).toBe('local-only');
    expect(clampDowntimeLocalPreference('remote-ok')).toBe('remote-ok');
  });

  it('clamps anything else to the downtime default (fail-open, no invented values)', async () => {
    const { clampDowntimeLocalPreference, DOWNTIME_LOCAL_PREFERENCE } = await loadModule();
    for (const bad of [undefined, null, '', 'auto', 'both', 'Local-Only', ' remote-ok', 42]) {
      expect(clampDowntimeLocalPreference(bad)).toBe(DOWNTIME_LOCAL_PREFERENCE);
    }
  });
});
