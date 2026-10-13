/**
 * Delegation test for getMachineCoordinationDir() →
 * `@worklog/shared/model-cooldown` (WL-0MV563825002R9Y1, AC6).
 *
 * The herdr resolver must not maintain its own copy of the
 * coordination-dir logic: it delegates to the shared
 * `resolveMachineCoordinationDir()` so the TUI writer and the herdr reader
 * share a single source of truth. This mirrors the
 * `tests/unit/worklog-dir-delegation.test.ts` pattern for
 * `resolveWorklogDir()`.
 *
 * The shared module is mocked with a factory so the delegation wiring is
 * verified in isolation from the real resolution rules (which are covered by
 * `machine-coordination.test.ts` and `model-cooldown.test.ts`).
 *
 * Run: npx vitest run packages/herdr/src/machine-coordination-delegation.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveMachineCoordinationDir: vi.fn(),
}));

vi.mock('@worklog/shared/model-cooldown', () => ({
  resolveMachineCoordinationDir: mocks.resolveMachineCoordinationDir,
  DEFAULT_MACHINE_COORDINATION_DIR: '.herdr/downtime',
}));

import {
  getMachineCoordinationDir,
  DEFAULT_MACHINE_COORDINATION_DIR,
} from './machine-coordination.js';

describe('getMachineCoordinationDir delegates to the shared resolver', () => {
  beforeEach(() => {
    mocks.resolveMachineCoordinationDir.mockReset();
  });

  it('returns the shared resolver result', () => {
    mocks.resolveMachineCoordinationDir.mockReturnValue('/shared/downtime');
    expect(getMachineCoordinationDir()).toBe('/shared/downtime');
    expect(mocks.resolveMachineCoordinationDir).toHaveBeenCalledTimes(1);
    expect(mocks.resolveMachineCoordinationDir).toHaveBeenCalledWith();
  });

  it('propagates the shared resolver null (unresolvable) result unchanged', () => {
    mocks.resolveMachineCoordinationDir.mockReturnValue(null);
    expect(getMachineCoordinationDir()).toBeNull();
  });

  it('re-exports the shared DEFAULT_MACHINE_COORDINATION_DIR constant', () => {
    expect(DEFAULT_MACHINE_COORDINATION_DIR).toBe('.herdr/downtime');
  });
});
