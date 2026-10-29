/**
 * packages/herdr/src/downtime-worker.launch-fence.ts — one-per-idle-window
 * launch fence.
 *
 * Single responsibility: close the same-instance stale-status launch window
 * (parent WL-0MVIKRFP0005JDL8, slice C3) — once THIS worker launches a
 * ticket-backed pane, refuse further launches until a fresh observation
 * shows the launched prefill registered (`local_prefills_in_flight` advanced
 * past the admission value) and headroom returned (`in_flight < cap`).
 *
 * Extracted from `downtime-worker.ts` by WL-0MVLII2080074S5L (extract the
 * downtime-worker orchestrator modules): the orchestrator context builds a
 * fence per worker, and split-family modules may not import the barrel at
 * runtime (split-guard gate), so the fence lives in its own module and the
 * barrel re-exports it. Moved verbatim — no behaviour change.
 */

import type {
  IdleWindowLaunchFence,
  IdleWindowLaunchObservation,
  IdleWindowLaunchVerdict,
} from './downtime-worker.types.js';

// ── Idle-window launch fence (parent WL-0MVIKRFP0005JDL8, slice C3) ──
//
// One-per-idle-window reservation race guard, client side. The proxy's
// atomic reservation (slice C2) already arbitrates CROSS-instance: two
// instances asking for a ticket in the same idle window get exactly one
// grant between them, and the loser defers with the refusal evidence. This
// fence closes the residual same-instance window in which a *granted*
// launch could be followed by ANOTHER granted launch before the proxy's
// own status catches up:
//
//   - a fresh launch takes seconds to boot pi and start its prefill, so
//     `local_prefills_in_flight` can still report the pre-launch headroom
//     on the next few polls;
//   - without a fence, a permissive proxy (grants N tickets for N slots —
//     the slice's recorded risky assumption) would grant a second ticket
//     against that stale headroom and herdr would launch a second pane in
//     the same idle window;
//   - the guard therefore treats an idle window as SPENT once this instance
//     launches a ticket-backed pane, and refuses further launches until a
//     fresh observation shows the launched prefill REGISTERED
//     (`local_prefills_in_flight` advanced past the admission value) and
//     headroom returned (`in_flight < cap`). The AC2 test drives exactly
//     this: launch → stale in_flight (fence holds, no spawn) → in_flight
//     advances (registered, fence clear) → headroom + a NEW ticket → the
//     second launch is admitted with its own ticket.
//
// Fail-open by construction: when the proxy does not serve the prefill
// counters (older proxy), or `cap` is 0/absent (unbounded), the fence can
// never be evaluated and stays inert — today's behaviour byte-for-byte. A
// launch it can never confirm (crash / remote fallback) is reported as
// registered after a bounded grace so a dead pane cannot wedge the
// dispatcher. It never admits a dispatch the per-slot / saturated / prefill
// gates would refuse (AC5) — it only ever adds refusals, never a grant.

/**
 * Bounded grace after a launch before the fence self-releases even without
 * observed registration. Covers a pane that was granted a ticket but died
 * before ever prefilling (crash / remote fallback) — the fence must never
 * wedge the worker on an admit it can never observe.
 */
export const DEFAULT_LAUNCH_CONFIRMATION_GRACE_MS = 5 * 60_000;


/** Create a per-worker {@link IdleWindowLaunchFence}. */
export function createIdleWindowLaunchFence(
  graceMs: number = DEFAULT_LAUNCH_CONFIRMATION_GRACE_MS,
): IdleWindowLaunchFence {
  // Admission snapshot: the last usable `local_prefills_in_flight` a launch
  // decision was based on. A launch is registered once a later poll reports a
  // STRICTLY greater count (the launched pane joined the proxy's counter),
  // which is what makes the next observation trustworthy.
  let baseline: number | undefined;
  let pending = 0;
  let pendingSince = 0;

  /** Drop the hold but keep the baseline — a launch admitted on this same
   *  poll must still be recordable (and therefore fenced). */
  const release = (): void => {
    pending = 0;
    pendingSince = 0;
  };
  /** The counters are no longer judgeable: the fence goes fully inert. */
  const reset = (): void => {
    release();
    baseline = undefined;
  };

  /** The fence is evaluable only when the proxy serves a serialised cap. */
  const usable = (inFlight: number | undefined, cap: number | undefined): boolean =>
    typeof inFlight === 'number' && typeof cap === 'number' && cap > 0;

  return {
    get pendingLaunches(): number {
      return pending;
    },
    recordLaunch(now: number): void {
      // Only a counter-serving observation can hold the fence; a launch
      // recorded on a pre-feature proxy is never fenced (fail-open).
      if (typeof baseline !== 'number') return;
      pending += 1;
      pendingSince = now;
    },
    observePoll({ idle, inFlight, cap }: IdleWindowLaunchObservation): void {
      if (!usable(inFlight, cap)) {
        // The proxy stopped serving counters (or the cap is unbounded) —
        // the fence can no longer be judged; fail open.
        reset();
        return;
      }
      if (pending > 0) {
        if (!idle) {
          // The window ended (busy poll): the launched pane registered or the
          // window gave way — nothing to hold any more.
          release();
        } else if (inFlight! > baseline!) {
          // The launched pane is now counted: this observation is
          // demonstrably POST-launch, so its headroom is trustworthy again.
          release();
        } else {
          // Still the pre-launch count — keep holding against the stale
          // snapshot (the baseline stays put).
          return;
        }
      }
      baseline = inFlight;
    },
    admit(now: number): IdleWindowLaunchVerdict {
      if (pending === 0) return { ok: true };
      // Dead-pane safety: without observed registration within the grace
      // window (crash / remote fallback), release the fence — never wedged.
      if (now - pendingSince >= graceMs) {
        release();
        return { ok: true };
      }
      return { ok: false, reason: 'idle-window-spent' };
    },
  };
}
