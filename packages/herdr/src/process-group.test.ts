/**
 * packages/herdr/src/process-group.test.ts — integration test for the
 * session-scoped child-process teardown helper (WL-0MUJW9DWO0070G9B /
 * WL-0MUJL1NAH0042GOS).
 *
 * Spawns a real long-running child in its own process group, terminates the
 * group, and asserts the child is gone (parent AC5).
 */
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';

import type { TerminateResult } from './process-group';
import { terminateProcessGroup } from './process-group';

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Spawn a real long-running process that sleeps indefinitely.
 * Returns the child process and a function to poll whether it is still alive.
 */
function spawnLongRunningChild(): {
  child: ReturnType<typeof spawn>;
  isAlive: () => Promise<boolean>;
} {
  // `sleep 999999` is a real long-running process we can signal.
  const child = spawn('sh', ['-c', 'sleep 999999'], {
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
  });
  // Unref so it doesn't keep the test runner alive.
  child.unref();

  return {
    child,
    isAlive: async () => {
      // Try to send signal 0 — if no error, the process is alive.
      try {
        process.kill(child.pid!, 0);
        return true;
      } catch {
        return false;
      }
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('terminateProcessGroup — teardown', () => {
  it('terminates a long-running child in its own process group (AC5)', async () => {
    const { child, isAlive } = spawnLongRunningChild();
    const pid = child.pid!;

    // Verify the child is alive before teardown.
    expect(await isAlive()).toBe(true);

    // Terminate the process group.
    const result: TerminateResult = await terminateProcessGroup(pid, { graceMs: 2_000 });

    // The child should no longer be alive.
    // Poll for exit with a timeout rather than a fixed sleep.
    let stillAlive = await isAlive();
    const deadline = Date.now() + 10_000; // 10 second timeout
    while (stillAlive && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      stillAlive = await isAlive();
    }

    expect(stillAlive).toBe(false);
    expect(result.terminated).toBe(true);
  }, 15_000); // 15s timeout for the whole test

  it('returns already-gone when the process is not found', async () => {
    // Use a PID that almost certainly doesn't exist.
    const result: TerminateResult = await terminateProcessGroup(99999999, { graceMs: 100 });
    expect(result.alreadyGone).toBe(true);
  });
});
