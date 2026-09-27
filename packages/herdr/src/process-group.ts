/**
 * packages/herdr/src/process-group.ts — Session-scoped child-process teardown
 *
 * Terminates a process group (SIGTERM → grace → SIGKILL) so that when a
 * session closes, its spawned children are not orphaned to PID 1 (parent AC5).
 */

import { kill } from 'node:process';

// ── Types ─────────────────────────────────────────────────────────────

/**
 * Result of a process-group teardown attempt.
 */
export interface TerminateResult {
  /** The process group was successfully terminated. */
  terminated?: boolean;
  /** The process was already gone. */
  alreadyGone?: boolean;
  /** Termination failed (e.g. permission denied). */
  failed?: boolean;
  /** Error message if the operation failed. */
  error?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Wait for a process to exit, polling periodically.
 * Returns true if the process exited within the timeout.
 */
function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (Date.now() - start >= timeoutMs) {
        resolve(false);
        return;
      }
      try {
        kill(pid, 0); // signal 0: does nothing but checks existence
        setTimeout(check, 100);
      } catch {
        resolve(true);
      }
    };
    check();
  });
}

// ── Teardown ──────────────────────────────────────────────────────────

/**
 * Terminate a session-scoped process group.
 *
 * 1. Send SIGTERM to the process group leader (negative PID).
 * 2. Wait up to `graceMs` for the process to exit.
 * 3. If still alive, send SIGKILL.
 *
 * Returns a structured result. Never throws — all errors are captured
 * in the result object.
 */
export function terminateProcessGroup(
  pid: number,
  opts?: { graceMs?: number },
): Promise<TerminateResult> {
  const graceMs = opts?.graceMs ?? 3_000;

  return new Promise((resolve) => {
    try {
      // Send SIGTERM to the process group (negative PID = process group).
      kill(-pid, 'SIGTERM');
    } catch (err) {
      // Process might already be gone.
      resolve({ alreadyGone: true });
      return;
    }

    waitForExit(pid, graceMs).then((exited) => {
      if (exited) {
        resolve({ terminated: true });
        return;
      }

      // Escalate to SIGKILL.
      try {
        kill(-pid, 'SIGKILL');
      } catch {
        // May have exited between the check and the kill.
        resolve({ terminated: true });
        return;
      }

      // Brief wait for SIGKILL to take effect.
      setTimeout(() => {
        try {
          kill(pid, 0);
          resolve({ failed: true, error: 'process survived SIGKILL' });
        } catch {
          resolve({ terminated: true });
        }
      }, 500);
    });
  });
}
